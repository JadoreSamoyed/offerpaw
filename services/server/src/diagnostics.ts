import type { Speaker, SpeakerMode } from './protocol.js';
import type { QuestionDecision } from './questions.js';

const errorCodes = [
  'AUTH_TIMEOUT', 'SESSION_EXPIRED', 'INVALID_MESSAGE', 'RATE_LIMIT', 'INVALID_QUESTION', 'SESSION_FAILED',
  'NOT_AUTHENTICATED', 'NOT_READY', 'SPEAKER_LIVE_ONLY', 'VOICE_ENROLL_NOT_ACTIVE', 'SPEAKER_UNAVAILABLE',
  'SESSION_PAUSED', 'VOICE_ENROLL_ACTIVE', 'QUESTION_RATE_LIMIT', 'DEMO_AUDIO_REJECTED', 'TEXT_AUDIO_REJECTED',
  'AUDIO_SEQUENCE', 'INVALID_AUDIO', 'AUDIO_BACKPRESSURE', 'ALREADY_STARTED', 'UNAUTHORIZED',
  'PROVIDER_NOT_CONFIGURED', 'ASR_DISCONNECTED', 'VOICE_ENROLL_TOO_SHORT', 'VOICE_ENROLL_INCONSISTENT',
  'VOICE_ENROLL_INVALID_AUDIO', 'ASR_AUDIO_GAP', 'ASR_UNAVAILABLE', 'VOICE_PROFILE_REQUIRED',
  'ANSWER_TIMEOUT', 'ANSWER_INCOMPLETE', 'ANSWER_FAILED',
] as const;
type ErrorCode = typeof errorCodes[number];

export function diagnosticErrorCode(code: string): ErrorCode | 'OTHER' {
  return (errorCodes as readonly string[]).includes(code) ? code as ErrorCode : 'OTHER';
}

const speakerReasons = ['ambiguous', 'insufficient_audio', 'not_enrolled', 'mixed_speakers',
  'candidate_match', 'different_speaker', 'profile_required', 'speaker_unavailable'] as const;
type SpeakerReason = typeof speakerReasons[number] | 'other';
export function diagnosticSpeakerReason(reason?: string): SpeakerReason | undefined {
  if (reason === undefined) return undefined;
  return (speakerReasons as readonly string[]).includes(reason) ? reason as SpeakerReason : 'other';
}

type AnswerSource = 'fresh' | 'prepared' | 'cache';
export type SessionDiagnosticEvent =
  | { event: 'session_ready'; mode: 'demo' | 'text' | 'live'; speakerMode: SpeakerMode }
  | { event: 'question_decision'; finalNumber: number; speaker: Speaker; speakerReason?: SpeakerReason; reason: QuestionDecision['reason'] | 'not_interviewer' }
  | { event: 'answer_start'; questionId: string; source: AnswerSource }
  | { event: 'answer_timing'; questionId: string; source: AnswerSource; requestToFirstTokenMs: number; questionCommitToFirstTokenMs: number }
  | { event: 'answer_done'; questionId: string; latencyMs: number }
  | { event: 'session_error'; code: ErrorCode | 'OTHER'; recoverable: boolean; questionId?: string }
  | { event: 'socket_closed'; code: number }
  | { event: 'socket_error' };
export type SessionDiagnostic = SessionDiagnosticEvent & { scope: 'interview_session'; sessionId: string; at: string };
export type DiagnosticSink = (entry: SessionDiagnostic) => void;

// Callers construct these records field by field; never pass protocol payloads or provider errors.
export function writeSessionDiagnostic(sessionId: string, event: SessionDiagnosticEvent, sink: DiagnosticSink): void {
  try { sink({ scope: 'interview_session', sessionId, at: new Date().toISOString(), ...event }); }
  catch { /* Observability must not interrupt recording or answer delivery. */ }
}

export const consoleDiagnosticSink: DiagnosticSink = entry => { console.info(JSON.stringify(entry)); };
