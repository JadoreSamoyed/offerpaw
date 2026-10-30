import type { SpeakerMetadata, VoiceProfile } from '../protocol.js';

export interface TranscriberOptions {
  voiceProfile?: VoiceProfile;
  enrollSpeaker?: boolean;
  requireSpeaker?: boolean;
}
export interface Transcriber {
  connect(): Promise<void>;
  append(pcm: Buffer): void;
  clear(): void;
  close(): void;
  readonly speakerSupported?: boolean;
  finishEnrollment?(): void;
  cancelEnrollment?(): void;
}

export interface TranscriptionCallbacks {
  partial(id: string, text: string, speaker?: SpeakerMetadata): void;
  final(id: string, text: string, speaker?: SpeakerMetadata): void;
  error(): void;
  speakerCapability?(supported: boolean): void;
  enrolled?(profile: VoiceProfile): void;
  enrollmentFailed?(code: 'too_short' | 'inconsistent' | 'invalid_audio'): void;
  audioGap?(): void;
}
