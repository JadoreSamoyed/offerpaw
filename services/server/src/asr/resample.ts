/** Stateful, anti-aliased 24 kHz -> 16 kHz PCM16 converter (1 ms FIR delay).
 * Fractional phase and history survive arbitrary frame boundaries.
 */
export class Pcm24To16 {
  private samples: number[] = [];
  private start = 0;
  private positionTwice = 0;
  private readonly kernels = [0, 0.5].map(phase => {
    const cutoff = 7200 / 24000;
    const values = Array.from({ length: 49 }, (_, i) => {
      const x = i + phase - 24;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / 48));
    });
    const sum = values.reduce((a, b) => a + b, 0);
    return values.map(value => value / sum);
  });
  reset() { this.samples = []; this.start = 0; this.positionTwice = 0; }
  push(pcm: Buffer): Buffer {
    if (pcm.length % 2) throw new Error('INVALID_PCM');
    for (let i = 0; i < pcm.length; i += 2) this.samples.push(pcm.readInt16LE(i));
    const end = this.start + this.samples.length;
    const output: number[] = [];
    while (Math.floor(this.positionTwice / 2) < end) {
      const index = Math.floor(this.positionTwice / 2);
      const kernel = this.kernels[this.positionTwice % 2]!;
      let value = 0;
      for (let k = 0; k < kernel.length; k++) value += (this.samples[index - k - this.start] ?? 0) * kernel[k]!;
      output.push(Math.max(-32768, Math.min(32767, Math.round(value))));
      this.positionTwice += 3;
    }
    const remove = Math.max(0, this.samples.length - 50);
    this.samples = this.samples.slice(remove); this.start += remove;
    const result = Buffer.allocUnsafe(output.length * 2);
    output.forEach((value, i) => result.writeInt16LE(value, i * 2));
    return result;
  }
}
