/** Energy VAD for 24 kHz mono PCM16. */
export class PcmTurnDetector {
  private speech = false;
  private silenceMs = 0;
  private durationMs = 0;
  constructor(private threshold: number, private silenceLimit: number) {}
  reset() { this.speech = false; this.silenceMs = 0; this.durationMs = 0; }
  push(pcm: Buffer): 'commit' | 'clear' | undefined {
    const samples = pcm.length / 2;
    let squares = 0;
    for (let i = 0; i < samples; i++) squares += (pcm.readInt16LE(i * 2) / 32768) ** 2;
    const duration = samples / 24;
    const loud = Math.sqrt(squares / Math.max(1, samples)) >= this.threshold;
    this.durationMs += duration;
    if (loud) { this.speech = true; this.silenceMs = 0; } else this.silenceMs += duration;
    if (this.speech && (this.silenceMs >= this.silenceLimit || this.durationMs >= 15000)) { this.reset(); return 'commit'; }
    if (!this.speech && this.durationMs >= 3000) { this.reset(); return 'clear'; }
    return undefined;
  }
}
