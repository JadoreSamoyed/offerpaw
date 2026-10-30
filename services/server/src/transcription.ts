import type { Config } from './config.js';
import { SocketTranscriber } from './asr/socket.js';
import { LocalTranscriber } from './asr/local.js';
import { QwenTranscriber } from './asr/qwen.js';
import { DashscopeTranscriber } from './asr/dashscope.js';
import { PcmTurnDetector } from './asr/vad.js';
import type { Transcriber, TranscriptionCallbacks, TranscriberOptions } from './asr/types.js';
export { PcmTurnDetector, LocalTranscriber, QwenTranscriber, DashscopeTranscriber };
export type { Transcriber, TranscriptionCallbacks, TranscriberOptions };

/** OpenAI Realtime GA transcription adapter. */
export class RealtimeTranscriber extends SocketTranscriber {
  private detector?: PcmTurnDetector;
  protected endpoint() { return this.config.ASR_WS_URL; }
  protected reset() { this.detector = new PcmTurnDetector(this.config.ASR_VAD_RMS_THRESHOLD, this.config.ASR_VAD_SILENCE_MS); }
  protected configure() {
    this.send({ type: 'session.update', session: {
      type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { ...this.config.transcriptionOptions, model: this.config.ASR_MODEL },
        turn_detection: this.config.ASR_TURN_DETECTION === 'server_vad'
          ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: this.config.ASR_VAD_SILENCE_MS } : null,
      } },
    } });
  }
  protected event(event: Record<string, unknown>) {
    if (event.type === 'session.updated') { this.markReady(); return; }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.item_id === 'string' && typeof event.delta === 'string') {
      this.transcript(event.item_id, `${this.partials.get(event.item_id) ?? ''}${event.delta}`, false);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') this.transcript(event.item_id, event.transcript, true);
  }
  protected audio(pcm: Buffer) {
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    if (this.config.ASR_TURN_DETECTION === 'client_vad') {
      const action = this.detector!.push(pcm);
      if (action) this.send({ type: `input_audio_buffer.${action}` });
    }
  }
}

export function createTranscriber(config: Config, callbacks: TranscriptionCallbacks, options: TranscriberOptions = {}): Transcriber {
  switch (config.ASR_PROVIDER) {
    case 'local': return new LocalTranscriber(config, callbacks, options);
    case 'qwen': return new QwenTranscriber(config, callbacks);
    case 'dashscope': return new DashscopeTranscriber(config, callbacks);
    default: return new RealtimeTranscriber(config, callbacks);
  }
}
