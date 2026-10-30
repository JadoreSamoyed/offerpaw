import { SocketTranscriber } from './socket.js';
import type { Config } from '../config.js';
import { voiceProfileSchema, type SpeakerMetadata } from '../protocol.js';
import type { TranscriberOptions, TranscriptionCallbacks } from './types.js';

/** The sidecar acknowledges startup only after its speech model is loaded. */
export class LocalTranscriber extends SocketTranscriber {
  protected readonly resetQueueLimit = 6 * 24000 * 2;
  protected readonly recoverResetOverflow = true;
  private generation = 0;
  private sequence = 0;
  speakerSupported = false;
  constructor(config: Config, callbacks: TranscriptionCallbacks, private options: TranscriberOptions = {}) { super(config, callbacks); }
  protected endpoint() { return this.config.ASR_LOCAL_URL; }
  protected headers() { return {}; }
  protected configure() {
    if (this.options.voiceProfile) voiceProfileSchema.parse(this.options.voiceProfile);
    this.send({ type: 'session.start', sampleRate: 24000, generation: this.generation,
      ...(this.options.voiceProfile ? { voiceProfile: this.options.voiceProfile } : {}),
      ...(this.options.enrollSpeaker ? { enrollSpeaker: true } : {}),
      ...(this.config.ASR_LOCAL_TOKEN ? { token: this.config.ASR_LOCAL_TOKEN } : {}) });
  }
  protected event(event: Record<string, unknown>) {
    if (event.generation !== undefined && event.generation !== this.generation) return;
    if (event.type === 'session.ready') {
      if (this.generation > 0 && event.generation !== this.generation) return;
      this.speakerSupported = event.speakerSupported === true;
      if (this.options.requireSpeaker || this.options.voiceProfile || this.options.enrollSpeaker) {
        this.callbacks.speakerCapability?.(this.speakerSupported);
      }
      this.markReady(); return;
    }
    if (this.generation > 0 && event.generation !== this.generation) return;
    if (event.type === 'speaker.enrolled') {
      const parsed = voiceProfileSchema.safeParse(event.profile);
      if (!this.speakerSupported || !parsed.success) { this.callbacks.enrollmentFailed?.('invalid_audio'); return; }
      this.options = { ...this.options, voiceProfile: parsed.data, enrollSpeaker: false };
      this.callbacks.enrolled?.(parsed.data); return;
    }
    if (event.type === 'speaker.enrollment.failed') {
      const code = event.code === 'too_short' || event.code === 'inconsistent' ? event.code : 'invalid_audio';
      this.callbacks.enrollmentFailed?.(code); return;
    }
    const speaker: SpeakerMetadata = {
      speaker: this.speakerSupported && (event.speaker === 'interviewer' || event.speaker === 'candidate') ? event.speaker : 'unknown',
      speakerSource: this.speakerSupported && event.speakerSource === 'voice' ? 'voice' : 'unavailable',
      ...(typeof event.speakerReason === 'string' && event.speakerReason.length <= 80 ? { speakerReason: event.speakerReason } : {}),
    };
    if (event.type === 'transcript.partial') this.transcript(event.id, event.text, false, speaker);
    if (event.type === 'transcript.final') this.transcript(event.id, event.text, true, speaker);
  }
  protected audio(pcm: Buffer) {
    // The sidecar accepts <= 500 ms even when the frontend batches one second.
    for (let start = 0; start < pcm.length; start += 24000) {
      this.send({ type: 'audio.append', seq: this.sequence++, audio: pcm.subarray(start, start + 24000).toString('base64'), generation: this.generation });
    }
  }
  clear() {
    if (this.stopped) return;
    this.clearState(); ++this.generation; this.sequence = 0; this.awaitReady();
    try { this.send({ type: 'session.clear', generation: this.generation }); } catch { this.fail(); }
  }
  finishEnrollment() {
    if (!this.speakerSupported) { this.callbacks.enrollmentFailed?.('invalid_audio'); return; }
    this.send({ type: 'speaker.enroll.finish', generation: this.generation });
  }
  cancelEnrollment() {
    this.options = { ...this.options, enrollSpeaker: false };
    if (this.speakerSupported) this.send({ type: 'speaker.enroll.cancel', generation: this.generation });
  }
}
