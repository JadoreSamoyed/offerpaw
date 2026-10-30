import WebSocket from 'ws';
import type { Config } from '../config.js';
import type { Transcriber, TranscriptionCallbacks } from './types.js';
import type { SpeakerMetadata } from '../protocol.js';

/** Shared transport limits and lifecycle. Raw provider errors never reach clients. */
export abstract class SocketTranscriber implements Transcriber {
  protected socket?: WebSocket;
  protected ready = false;
  protected stopped = true;
  protected epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { resolve(): void; reject(error: Error): void };
  private connecting?: Promise<void>;
  private buffering = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private overflowReported = false;
  protected readonly resetQueueLimit: number = 96000;
  protected readonly recoverResetOverflow: boolean = false;
  private resetVersion = 0;
  protected partials = new Map<string, string>();
  private partialSpeakers = new Map<string, string>();
  private finished = new Set<string>();
  constructor(protected config: Config, protected callbacks: TranscriptionCallbacks) {}
  protected abstract endpoint(): string;
  protected headers(): Record<string, string> { return { Authorization: `Bearer ${this.config.ASR_API_KEY}` }; }
  protected abstract configure(): void;
  protected abstract event(event: Record<string, unknown>): void;
  protected abstract audio(pcm: Buffer): void;
  protected reset(): void {}

  connect(): Promise<void> {
    if (this.ready && !this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.reset();
    const epoch = ++this.epoch;
    const promise = new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        const socket = new WebSocket(this.endpoint(), {
          headers: this.headers(), handshakeTimeout: this.config.ASR_CONNECT_TIMEOUT_MS,
          maxPayload: 262144, perMessageDeflate: false,
        });
        this.socket = socket;
        this.armTimeout();
        socket.on('open', () => {
          if (epoch !== this.epoch || this.stopped) return;
          try { this.configure(); } catch { this.fail(); }
        });
        socket.on('message', (raw, binary) => {
          if (epoch !== this.epoch || this.stopped) return;
          try {
            if (binary) throw new Error('INVALID_EVENT');
            const event: unknown = JSON.parse(raw.toString());
            if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('INVALID_EVENT');
            const message = event as Record<string, unknown>;
            if (message.type === 'error' || message.type === 'conversation.item.input_audio_transcription.failed') throw new Error('ASR_ERROR');
            this.event(message);
          } catch { this.fail(); }
        });
        socket.on('error', () => { if (epoch === this.epoch) this.fail(); });
        socket.on('close', () => { if (epoch === this.epoch) this.fail(); });
      } catch { this.fail(); }
    });
    this.connecting = promise;
    void promise.then(() => { if (this.connecting === promise) this.connecting = undefined; }, () => { if (this.connecting === promise) this.connecting = undefined; });
    return promise;
  }
  protected send(event: Record<string, unknown>) {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) throw new Error('ASR_NOT_READY');
    if (this.socket.bufferedAmount > 256000) throw new Error('ASR_BACKPRESSURE');
    const epoch = this.epoch;
    this.socket.send(JSON.stringify(event), error => { if (error && epoch === this.epoch) this.fail(); });
  }
  protected markReady() {
    this.ready = true; this.buffering = false; clearTimeout(this.timer);
    clearTimeout(this.drainTimer);
    this.draining = this.queue.length > 0;
    if (this.draining) this.drainQueue();
    const pending = this.pending; this.pending = undefined; pending?.resolve();
  }
  /** Yield between queued frames so a delayed reset cannot flood the socket. */
  private drainQueue() {
    if (this.stopped || !this.ready || !this.draining) return;
    if (!this.queue.length) { this.draining = false; this.overflowReported = false; return; }
    if ((this.socket?.bufferedAmount ?? 0) > 128000) {
      this.drainTimer = setTimeout(() => this.drainQueue(), 20); return;
    }
    const pcm = this.queue.shift()!; this.queuedBytes -= pcm.length;
    try { this.audio(pcm); } catch { this.fail(); return; }
    this.drainTimer = setTimeout(() => this.drainQueue(), 1);
  }
  protected awaitReady() { this.ready = false; this.buffering = true; this.armTimeout(); }
  private armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), this.config.ASR_CONNECT_TIMEOUT_MS);
  }
  protected transcript(id: unknown, text: unknown, final: boolean, speaker?: SpeakerMetadata) {
    if (!this.ready || typeof id !== 'string' || !id || id.length > 256 || typeof text !== 'string') return;
    if (text.length > 16000 || (!this.partials.has(id) && this.partials.size >= 16)) throw new Error('ASR_LIMIT');
    if (this.finished.has(id)) return;
    if (final) {
      this.partials.delete(id); this.partialSpeakers.delete(id); this.finished.add(id);
      if (this.finished.size > 128) this.finished.delete(this.finished.values().next().value!);
      this.callbacks.final(id, text.trim(), speaker);
    } else if (this.partials.get(id) !== text || this.partialSpeakers.get(id) !== JSON.stringify(speaker ?? null)) {
      this.partials.set(id, text); this.partialSpeakers.set(id, JSON.stringify(speaker ?? null)); this.callbacks.partial(id, text, speaker);
    }
  }
  append(pcm: Buffer) {
    if (!pcm.length || pcm.length % 2 || pcm.length > 48000) throw new Error('INVALID_PCM');
    if (this.stopped) throw new Error('ASR_NOT_READY');
    if (!this.ready || this.draining) {
      if (!this.buffering && !this.draining) throw new Error('ASR_NOT_READY');
      if (this.queuedBytes + pcm.length > this.resetQueueLimit) {
        if (!this.recoverResetOverflow) throw new Error('ASR_BACKPRESSURE');
        // Only recognition frames are discarded. The client records audio independently.
        while (this.queue.length && this.queuedBytes + pcm.length > this.resetQueueLimit) {
          this.queuedBytes -= this.queue.shift()!.length;
        }
        if (!this.overflowReported) { this.overflowReported = true; this.callbacks.audioGap?.(); }
      }
      this.queue.push(Buffer.from(pcm)); this.queuedBytes += pcm.length; return;
    }
    this.audio(pcm);
  }
  /** A fresh connection isolates unannounced/in-flight item IDs after a reset. */
  clear() {
    if (this.stopped) return;
    const version = ++this.resetVersion;
    this.disconnect(); this.buffering = true;
    // A reset is internal; failure must reach callbacks rather than an absent caller.
    void this.connect().catch(() => { if (this.stopped && version === this.resetVersion) this.callbacks.error(); });
  }
  protected clearState() {
    clearTimeout(this.drainTimer); this.draining = false; this.overflowReported = false;
    this.partials.clear(); this.partialSpeakers.clear(); this.finished.clear(); this.queue = []; this.queuedBytes = 0; this.reset();
  }
  protected fail() {
    if (this.stopped) return;
    const report = !this.pending;
    this.disconnect(new Error('ASR_UNAVAILABLE'));
    if (report) this.callbacks.error();
  }
  private disconnect(reason = new Error('ASR_CLOSED')) {
    this.stopped = true; this.ready = false; this.buffering = false; ++this.epoch;
    clearTimeout(this.timer);
    this.pending?.reject(reason); this.pending = undefined; this.connecting = undefined;
    this.clearState();
    const socket = this.socket; this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  close() { ++this.resetVersion; this.disconnect(); }
}
