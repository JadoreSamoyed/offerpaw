/* Runs on the audio render thread. No microphone audio is routed to output. */
class InterviewLowPass {
  constructor(rate) {
    // A 10 kHz low-pass leaves a transition band below the 24 kHz output's
    // Nyquist limit. The symmetric FIR has approximately 1 ms of group delay.
    const half = Math.round(rate / 1000);
    const cutoff = 10000 / rate;
    this.kernel = Float64Array.from({ length: 2 * half + 1 }, (_, i) => {
      const x = i - half;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (2 * half)));
    });
    const sum = this.kernel.reduce((total, value) => total + value, 0);
    for (let i = 0; i < this.kernel.length; i++) this.kernel[i] /= sum;
    this.history = new Float64Array(this.kernel.length);
    this.reset();
  }

  reset() { this.position = 0; this.initialized = false; }

  push(sample) {
    // Extend the first sample at a new capture boundary, avoiding a DC startup
    // transient. History persists across render blocks, but never across pauses.
    if (!this.initialized) { this.history.fill(sample); this.initialized = true; }
    this.history[this.position] = sample;
    let index = this.position;
    let value = 0;
    for (let i = 0; i < this.kernel.length; i++) {
      value += this.history[index] * this.kernel[i];
      if (--index < 0) index = this.history.length - 1;
    }
    if (++this.position === this.history.length) this.position = 0;
    return value;
  }
}

class InterviewPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.inputIndex = 0;
    this.nextOutput = 0;
    this.previous = 0;
    this.lowPass = sampleRate > 24000 ? new InterviewLowPass(sampleRate) : null;
    this.chunk = new ArrayBuffer(4800);
    this.view = new DataView(this.chunk);
    this.count = 0;
    this.squares = 0;
    this.paused = false;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pause' || data.type === 'stop') {
        this.flush();
        this.paused = true;
        this.stopped = data.type === 'stop';
      } else if (data.type === 'resume') {
        this.paused = false;
        this.inputIndex = 0;
        this.nextOutput = 0;
        this.previous = 0;
        this.lowPass?.reset();
      }
      this.port.postMessage({ type: 'ack', id: data.id });
    };
  }

  flush() {
    if (!this.count) return;
    const bytes = this.count === 2400 ? this.chunk : this.chunk.slice(0, this.count * 2);
    this.port.postMessage({ type: 'chunk', bytes, level: Math.sqrt(this.squares / this.count) }, [bytes]);
    this.chunk = new ArrayBuffer(4800);
    this.view = new DataView(this.chunk);
    this.count = 0;
    this.squares = 0;
  }

  process(inputs, outputs) {
    // Explicit silence, even if an implementation provides reused output buffers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const channels = inputs[0];
    if (this.paused || !channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let current = 0;
      for (const channel of channels) current += channel[index] / channels.length;
      // Filter before decimation: interpolation alone folds high-frequency noise
      // into the speech band when the browser supplies 44.1/48 kHz hardware audio.
      if (this.lowPass) current = this.lowPass.push(current);
      // Preserve fractional phase across 128-frame blocks. AudioContext normally
      // supplies 24 kHz; this also handles browsers using a hardware sample rate.
      while (this.nextOutput <= this.inputIndex) {
        const fraction = this.inputIndex === 0 ? 1 : this.nextOutput - (this.inputIndex - 1);
        const value = Math.max(-1, Math.min(1, this.previous + (current - this.previous) * fraction));
        this.view.setInt16(this.count * 2, value < 0 ? value * 32768 : value * 32767, true);
        this.count++;
        this.squares += value * value;
        if (this.count === 2400) this.flush();
        this.nextOutput += this.ratio;
      }
      this.previous = current;
      this.inputIndex++;
    }
    return true;
  }
}

registerProcessor('interview-pcm', InterviewPCMProcessor);
