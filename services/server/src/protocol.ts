import { z } from 'zod';

export const profileSchema = z.object({
  role: z.string().trim().max(200), resume: z.string().max(20000), jobDescription: z.string().max(12000),
  language: z.enum(['zh', 'en']), answerStyle: z.enum(['concise', 'structured']),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
export const voiceProfileSchema = z.object({
  version: z.literal(1), model: z.literal('campplus-zh-v1'),
  embedding: z.array(z.number().finite().min(-1000).max(1000)).length(192)
    .refine(values => Math.hypot(...values) >= 1e-6, 'Voice embedding must have a nonzero norm'),
  voicedMs: z.number().finite().nonnegative().optional(),
}).strict();
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;
export type Speaker = 'interviewer' | 'candidate' | 'unknown';
export type SpeakerMode = 'auto' | 'interviewer' | 'candidate';
export interface SpeakerMetadata {
  speaker: Speaker;
  speakerSource: 'voice' | 'manual' | 'unavailable';
  speakerReason?: string;
}
export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), mode: z.enum(['demo', 'text', 'live']), profile: profileSchema, token: z.string().max(512).optional(),
    speakerMode: z.enum(['auto', 'interviewer', 'candidate']).optional(), voiceProfile: voiceProfileSchema.optional(), enrollSpeaker: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('audio.append'), audio: z.string().min(4).max(64000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ type: z.literal('session.pause') }).strict(),
  z.object({ type: z.literal('session.resume') }).strict(),
  z.object({ type: z.literal('session.stop') }).strict(),
  z.object({ type: z.literal('question.ask'), text: z.string().trim().min(2).max(3000), bypassCache: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('speaker.set'), speaker: z.enum(['auto', 'interviewer', 'candidate']) }).strict(),
  z.object({ type: z.literal('voice.enroll.finish') }).strict(),
]).superRefine((event, context) => {
  if (event.type === 'session.start' && event.enrollSpeaker && event.mode !== 'live') {
    context.addIssue({ code: 'custom', path: ['enrollSpeaker'], message: 'Voice enrollment requires live mode' });
  }
});
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent =
  | { type: 'session.ready'; sessionId: string; mode: 'demo' | 'text' | 'live' }
  | ({ type: 'transcript.partial' | 'transcript.final'; id: string; text: string } & SpeakerMetadata)
  | { type: 'question.detected'; id: string; text: string; speaker: 'interviewer' }
  | { type: 'speaker.state'; mode: SpeakerMode; enrolled: boolean; enrolling: boolean }
  | { type: 'voice.enrolled'; profile: VoiceProfile }
  | { type: 'answer.start'; questionId: string; source?: 'fresh' | 'prepared' | 'cache' }
  | { type: 'answer.timing'; questionId: string; source: 'fresh' | 'prepared' | 'cache'; requestToFirstTokenMs: number; questionCommitToFirstTokenMs: number }
  | { type: 'answer.delta'; questionId: string; text: string }
  | { type: 'answer.done'; questionId: string; latencyMs: number }
  | { type: 'status'; stage: 'listening' | 'transcribing' | 'thinking' | 'paused' | 'stopped'; message?: string }
  | { type: 'error'; code: string; message: string; recoverable: boolean }
  | { type: 'session.stopped' };
