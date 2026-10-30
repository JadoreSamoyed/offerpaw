import type { Recording } from "./audio";

export type ResumeAttachment = {
  name: string;
  size: number;
  format: "pdf" | "docx" | "txt";
  importedAt: string;
};

export type Profile = {
  role: string;
  resume: string;
  resumeAttachment?: ResumeAttachment;
  jobDescription: string;
  language: "zh" | "en";
  answerStyle: "concise" | "structured";
};
export type Settings = { serverUrl: string; token: string };
export type Question = {
  id: string;
  text: string;
  answer: string;
  done: boolean;
  interrupted?: boolean;
  latencyMs?: number;
  answerSource?: "fresh" | "prepared" | "cache";
  commitLatencyMs?: number;
  clientFirstDeltaMs?: number;
};
export type Speaker = "interviewer" | "candidate" | "unknown";
export type SpeakerMode = "auto" | "interviewer" | "candidate";
export type VoiceProfile = {
  version: 1;
  model: "campplus-zh-v1";
  embedding: number[];
  voicedMs?: number;
};
export type Transcript = {
  id: string;
  text: string;
  final: boolean;
  speaker: Speaker;
  speakerSource?: "voice" | "manual" | "unavailable";
  speakerReason?: string;
};
export type SessionMode = "demo" | "text" | "live";
export type SessionRecord = {
  id: string;
  date: string;
  durationMs: number;
  role: string;
  mode: SessionMode;
  questions: Question[];
  transcripts?: Transcript[];
  recording: Recording | null;
};
export type Stage =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "paused"
  | "stopping"
  | "stopped";
export const defaultProfile: Profile = {
  role: "",
  resume: "",
  jobDescription: "",
  language: "zh",
  answerStyle: "concise",
};
