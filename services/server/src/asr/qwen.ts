import { randomUUID } from 'node:crypto';
import { SocketTranscriber } from './socket.js';
import { Pcm24To16 } from './resample.js';
import { PcmTurnDetector } from './vad.js';

/** Official Qwen-ASR-Realtime protocol:
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events
 */
export class QwenTranscriber extends SocketTranscriber {
  private resampler = new Pcm24To16();
  private detector?: PcmTurnDetector;
  protected endpoint() {
    const url = new URL(this.config.ASR_WS_URL);
    url.searchParams.set('model', this.config.ASR_MODEL); return url.toString();
  }
  private eventSend(type: string, properties: Record<string, unknown> = {}) { this.send({ event_id: randomUUID(), type, ...properties }); }
  protected configure() {
    this.eventSend('session.update', { session: {
      input_audio_format: 'pcm', sample_rate: 16000,
      input_audio_transcription: { language: 'zh', ...this.config.transcriptionOptions },
      turn_detection: this.config.ASR_TURN_DETECTION === 'server_vad'
        ? { type: 'server_vad', threshold: 0.0, silence_duration_ms: this.config.ASR_VAD_SILENCE_MS } : null,
    } });
  }
  protected reset() {
    this.resampler.reset();
    this.detector = new PcmTurnDetector(this.config.ASR_VAD_RMS_THRESHOLD, this.config.ASR_VAD_SILENCE_MS);
  }
  protected event(event: Record<string, unknown>) {
    if (event.type === 'session.updated') { this.markReady(); return; }
    if (event.type === 'session.finished') { this.fail(); return; }
    if (event.type === 'conversation.item.input_audio_transcription.text') {
      if (typeof event.text !== 'string' || (event.stash !== undefined && typeof event.stash !== 'string')) throw new Error('INVALID_TRANSCRIPT');
      // Both fields are full snapshots. The temporary stash may be revised.
      this.transcript(event.item_id, event.text + (event.stash ?? ''), false);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') this.transcript(event.item_id, event.transcript, true);
  }
  protected audio(pcm: Buffer) {
    const converted = this.resampler.push(pcm);
    if (converted.length) this.eventSend('input_audio_buffer.append', { audio: converted.toString('base64') });
    if (this.config.ASR_TURN_DETECTION === 'client_vad') {
      const action = this.detector!.push(pcm);
      if (action === 'commit') this.eventSend('input_audio_buffer.commit');
      // Qwen documents no buffer.clear event; isolate all-silent manual buffers by reconnecting.
      if (action === 'clear') this.clear();
    }
  }
}
