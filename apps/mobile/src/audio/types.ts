/** Raw little-endian PCM16, mono, 24 kHz; normally 100 ms per chunk. */
export type AudioChunk = { audio: string; level: number; seq: number };
export type Recording = { uri: string; mimeType: string; durationMs: number };
export type Recorder = {
  start(onChunk: (chunk: AudioChunk) => void, onError?: (message: string) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<Recording | null>;
};
