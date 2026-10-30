import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { SocketTranscriber } from './socket.js';
import { Pcm24To16 } from './resample.js';

/** Qwen-Audio-ASR-Streaming uses DashScope's task protocol, not Qwen Realtime.
 * https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events
 * https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events
 */
export class DashscopeTranscriber extends SocketTranscriber {
  private resampler = new Pcm24To16();
  private taskId = '';

  protected endpoint() { return this.config.ASR_WS_URL; }
  protected reset() {
    this.resampler.reset();
    this.taskId = randomUUID();
  }
  protected configure() {
    this.send({
      header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model: this.config.ASR_MODEL,
        parameters: {
          ...this.config.transcriptionOptions,
          format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'],
          // 3.1 documents selectable VAD models; do not reuse Realtime's silence_duration_ms.
          vad_model: this.config.ASR_DASHSCOPE_VAD_MODEL, heartbeat: true,
        },
        input: {},
      },
    });
  }
  protected event(event: Record<string, unknown>) {
    const header = object(event.header);
    if (typeof header.event !== 'string' || typeof header.task_id !== 'string') throw new Error('INVALID_EVENT');
    // Also filter task IDs on the new socket: sentence IDs restart for each task.
    if (header.task_id !== this.taskId) return;
    if (header.event === 'task-started') { if (!this.ready) this.markReady(); return; }
    if (header.event === 'task-failed' || header.event === 'task-finished') { this.fail(); return; }
    if (header.event !== 'result-generated' || !this.ready) return;
    const sentence = object(object(object(event.payload).output).sentence);
    if (sentence.heartbeat === true) return;
    if (!Number.isSafeInteger(sentence.sentence_id) || (sentence.sentence_id as number) < 0
      || typeof sentence.text !== 'string' || typeof sentence.sentence_end !== 'boolean') throw new Error('INVALID_TRANSCRIPT');
    this.transcript(`${this.taskId}:${sentence.sentence_id}`, sentence.text, sentence.sentence_end);
  }
  protected audio(pcm: Buffer) {
    const converted = this.resampler.push(pcm);
    if (!converted.length) return;
    const socket = this.socket;
    if (this.stopped || !this.ready || socket?.readyState !== WebSocket.OPEN) throw new Error('ASR_NOT_READY');
    if (socket.bufferedAmount > 256000) throw new Error('ASR_BACKPRESSURE');
    const epoch = this.epoch;
    socket.send(converted, { binary: true }, error => { if (error && epoch === this.epoch) this.fail(); });
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EVENT');
  return value as Record<string, unknown>;
}
