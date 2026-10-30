const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function processor(rate) {
  let Constructor;
  const messages = [];
  const sandbox = {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (message) => messages.push(message) }; } },
    registerProcessor: (_name, definition) => { Constructor = definition; },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../../public/pcm-worklet.js'), 'utf8'), sandbox);
  return { instance: new Constructor(), messages };
}

function feed(instance, frames, value = 0.25) {
  let remaining = frames;
  while (remaining) {
    const count = Math.min(128, remaining);
    const output = new Float32Array(count).fill(1);
    instance.process([[new Float32Array(count).fill(value)]], [[output]]);
    assert.ok(output.every((sample) => sample === 0), 'speaker output must be silent');
    remaining -= count;
  }
}

function renderSignal(rate, samples, blockSizes = [128]) {
  const { instance, messages } = processor(rate);
  let offset = 0;
  let block = 0;
  while (offset < samples.length) {
    const end = Math.min(samples.length, offset + blockSizes[block++ % blockSizes.length]);
    instance.process([[samples.subarray(offset, end)]], []);
    offset = end;
  }
  instance.port.onmessage({ data: { type: 'stop', id: 0 } });
  const pcm = Buffer.concat(messages.filter(message => message.type === 'chunk').map(message => Buffer.from(message.bytes)));
  return { pcm, samples: Float64Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768) };
}

function tone(rate, frequency, seconds = 0.5) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / rate));
}

function rms(samples, skip = 2400) {
  let squared = 0;
  for (let i = skip; i < samples.length; i++) squared += samples[i] ** 2;
  return Math.sqrt(squared / (samples.length - skip));
}

for (const rate of [24000, 44100, 48000]) {
  test(`continuous ${rate} Hz input emits 24 kHz PCM without render-boundary drift`, () => {
    const { instance, messages } = processor(rate);
    feed(instance, rate * 7);
    instance.port.onmessage({ data: { type: 'stop', id: 0 } });
    const chunks = messages.filter((message) => message.type === 'chunk');
    const samples = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength / 2, 0);
    assert.ok(Math.abs(samples - 24000 * 7) <= 1, `expected 168000 samples, got ${samples}`);
    assert.ok(chunks.every((chunk) => chunk.bytes.byteLength <= 4800));
    assert.ok(chunks.every((chunk) => Math.abs(chunk.level - 0.25) < 1e-6));
    assert.equal(new DataView(chunks[0].bytes).getInt16(0, true), 8191);
    assert.equal(messages.at(-1).type, 'ack', 'flush must be delivered before stop acknowledgement');
  });
}

for (const rate of [44100, 48000]) {
  test(`${rate} Hz hardware downsampling suppresses 18 kHz noise before it aliases into speech`, () => {
    const output = renderSignal(rate, tone(rate, 18000)).samples;
    const gain = rms(output) / (0.5 / Math.sqrt(2));
    assert.ok(gain < 0.001, `18 kHz must be attenuated by at least 60 dB, got ${20 * Math.log10(gain)} dB`);
  });

  test(`${rate} Hz hardware downsampling preserves the speech passband`, () => {
    for (const [frequency, minimumGain] of [[1000, 0.99], [7000, 0.88]]) {
      const gain = rms(renderSignal(rate, tone(rate, frequency)).samples) / (0.5 / Math.sqrt(2));
      // Fractional 44.1 -> 24 kHz linear interpolation already has a small upper
      // passband roll-off; the anti-alias filter must not attenuate speech further.
      assert.ok(gain >= minimumGain && gain <= 1.01, `${frequency} Hz gain: ${gain}`);
    }
  });

  test(`${rate} Hz FIR history and resampling phase survive arbitrary render boundaries`, () => {
    const input = Float32Array.from({ length: Math.round(rate * 0.37) }, (_, i) =>
      0.3 * Math.sin(2 * Math.PI * 1379 * i / rate) + 0.1 * Math.sin(2 * Math.PI * 18000 * i / rate));
    assert.deepEqual(renderSignal(rate, input, [1, 17, 509, 64, 1000]).pcm, renderSignal(rate, input).pcm);
  });

  test(`${rate} Hz anti-alias filtering adds approximately 1 ms of group delay`, () => {
    const input = new Float32Array(Math.round(rate * 0.2));
    input[Math.round(rate * 0.1)] = 0.5;
    const output = renderSignal(rate, input).samples;
    let peak = 0;
    for (let i = 1; i < output.length; i++) if (Math.abs(output[i]) > Math.abs(output[peak])) peak = i;
    assert.ok(Math.abs(peak - 2400 - 24) <= 1, `impulse peak at ${peak}: expected 24 output samples / 1 ms delay`);
  });
}

test('pause omits audio and flushes partial chunk; resume retains ordering', () => {
  const { instance, messages } = processor(48000);
  feed(instance, 1200, -1);
  instance.port.onmessage({ data: { type: 'pause', id: 1 } });
  feed(instance, 48000);
  instance.port.onmessage({ data: { type: 'resume', id: 2 } });
  feed(instance, 1200, 1);
  instance.port.onmessage({ data: { type: 'stop', id: 3 } });
  const chunks = messages.filter((message) => message.type === 'chunk');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].bytes.byteLength, 1200);
  assert.equal(chunks[1].bytes.byteLength, 1200);
  // Floating-point FIR normalization may differ by one quantization step.
  assert.ok(Math.abs(new DataView(chunks[0].bytes).getInt16(0, true) + 32768) <= 1);
  assert.ok(Math.abs(new DataView(chunks[1].bytes).getInt16(0, true) - 32767) <= 1);
  assert.ok(new Int16Array(chunks[1].bytes).every(sample => sample >= 32766), 'resume must discard previous negative-signal filter history');
  assert.equal(instance.process([], []), false);
});

test('stereo is averaged to mono instead of choosing an arbitrary channel', () => {
  const { instance, messages } = processor(24000);
  instance.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(-1)]], []);
  instance.port.onmessage({ data: { type: 'stop', id: 0 } });
  const chunk = messages.find((message) => message.type === 'chunk');
  assert.equal(chunk.level, 0);
  assert.ok(new Int16Array(chunk.bytes).every((sample) => sample === 0));
});

test('WAV export describes little-endian mono 24 kHz PCM16 and correct lengths', () => {
  const source = readFileSync(path.join(__dirname, 'storage.web.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, { exports });
  const header = exports.wavHeader(96000);
  const data = new DataView(header);
  assert.equal(Buffer.from(header).subarray(0, 4).toString(), 'RIFF');
  assert.equal(data.getUint32(4, true), 96036);
  assert.equal(data.getUint16(22, true), 1);
  assert.equal(data.getUint32(24, true), 24000);
  assert.equal(data.getUint32(28, true), 48000);
  assert.equal(data.getUint16(34, true), 16);
  assert.equal(data.getUint32(40, true), 96000);
  assert.throws(() => exports.wavHeader(0xffffffff), /WAV/);
});

function nativeWrapper(module) {
  const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'expo-modules-core') return { requireOptionalNativeModule: () => module };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      return {};
    },
  });
  return exports;
}

test('native pause/stop wait for final PCM events even when promise overtakes event delivery', async () => {
  const listeners = new Map();
  const emitLater = (seq) => setTimeout(() => listeners.get('onAudioChunk')?.({ audio: 'AA==', level: 0, seq }), 5);
  const module = {
    async start() {},
    async pause() { emitLater(0); return 0; },
    async resume() {},
    async stop() { emitLater(1); return { uri: 'file:///recording.wav', mimeType: 'audio/wav', durationMs: 200, lastSeq: 1 }; },
    addListener(event, callback) { listeners.set(event, callback); return { remove: () => listeners.delete(event) }; },
  };
  const { createRecorder } = nativeWrapper(module);
  const recorder = createRecorder();
  const delivered = [];
  await recorder.start((chunk) => delivered.push(chunk.seq));
  await recorder.pause();
  assert.deepEqual(delivered, [0]);
  await recorder.resume();
  const recording = await recorder.stop();
  assert.deepEqual(delivered, [0, 1]);
  assert.equal(recording.uri, 'file:///recording.wav');
  assert.equal(recording.lastSeq, undefined, 'native bookkeeping must not leak into public recording metadata');
  assert.equal(listeners.size, 0);
  assert.equal(await recorder.stop(), recording, 'stop is idempotent');
});

test('Expo Go can import the recorder but receives an actionable error on capture', async () => {
  const { createRecorder } = nativeWrapper(null);
  const recorder = createRecorder();
  await assert.rejects(recorder.start(() => {}), /Expo Go/);
  assert.equal(await recorder.stop(), null);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockStream() {
  const track = { stopped: false, enabled: true, onended: null, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function browserWrapper() {
  const requests = [];
  const contexts = [];
  let connections = 0;
  let processors = 0;
  const source = readFileSync(path.join(__dirname, 'index.web.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, setTimeout, clearTimeout, AbortController, isSecureContext: true,
    crypto: { randomUUID: () => `recording-${contexts.length}` },
    navigator: { mediaDevices: { getUserMedia() { const request = deferred(); requests.push(request); return request.promise; } } },
    AudioContext: class {
      constructor() { this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; contexts.push(this); }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() { connections++; }, disconnect() {} }; }
    },
    AudioWorkletNode: class {
      constructor() {
        processors++;
        this.port = {
          close() {},
          postMessage: (message) => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ack', id: message.id } })),
        };
      }
      connect() {}
      disconnect() {}
    },
    require() { return { openAudioDatabase: async () => ({}), saveChunk: async () => {}, completeRecording: async () => {} }; },
  });
  return { ...exports, requests, contexts, get connections() { return connections; }, get processors() { return processors; } };
}

for (const [name, message] of [
  ['NotAllowedError', /麦克风访问未获允许.*浏览器.*系统隐私设置/],
  ['NotFoundError', /未找到可用麦克风.*连接麦克风.*系统输入设备/],
  ['NotReadableError', /无法读取麦克风.*占用麦克风.*设备连接/],
]) {
  test(`browser ${name} explains recovery and releases recording resources for retry`, async () => {
    const browser = browserWrapper();
    const recorder = browser.createRecorder();
    const rejected = assert.rejects(recorder.start(() => {}), message);
    await turn();
    browser.requests[0].reject(new DOMException('Browser-specific error', name));
    await rejected;
    assert.equal(browser.contexts[0].state, 'closed');
    assert.equal(browser.processors, 0);
    assert.equal(await recorder.stop(), null);

    const retry = recorder.start(() => {});
    await turn();
    const stream = mockStream();
    browser.requests[1].resolve(stream);
    await retry;
    assert.equal(browser.connections, 1);
    await recorder.stop();
    assert.equal(stream.track.stopped, true);
  });
}

test('unrecognized microphone failures keep the original error', async () => {
  const browser = browserWrapper();
  const recorder = browser.createRecorder();
  const error = new DOMException('Capture was interrupted', 'AbortError');
  const rejected = assert.rejects(recorder.start(() => {}), actual => actual === error);
  await turn();
  browser.requests[0].reject(error);
  await rejected;
  assert.equal(browser.contexts[0].state, 'closed');
});

test('browser stop settles while microphone permission is unanswered; late grant is disposed', async () => {
  const browser = browserWrapper();
  const recorder = browser.createRecorder();
  const start = recorder.start(() => {});
  const rejected = assert.rejects(start, /已取消/);
  await turn();
  assert.equal(browser.requests.length, 1);
  let timeout;
  const deadline = new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('stop blocked on permission')), 250); });
  try { assert.equal(await Promise.race([recorder.stop(), deadline]), null); }
  finally { clearTimeout(timeout); }
  await rejected;
  assert.equal(browser.contexts[0].state, 'closed');
  const lateStream = mockStream();
  browser.requests[0].resolve(lateStream);
  await turn();
  assert.equal(lateStream.track.stopped, true);
  assert.equal(browser.processors, 0);
  assert.equal(browser.connections, 0);
});

test('stop immediately after start prevents even opening a permission prompt', async () => {
  const browser = browserWrapper();
  const recorder = browser.createRecorder();
  const start = recorder.start(() => {});
  const rejected = assert.rejects(start, /已取消/);
  assert.equal(await recorder.stop(), null);
  await rejected;
  assert.equal(browser.requests.length, 0);
  assert.equal(browser.contexts.length, 0);
});

test('late grant from cancelled session never closes or connects a newer recording', async () => {
  const browser = browserWrapper();
  const oldRecorder = browser.createRecorder();
  const oldStart = oldRecorder.start(() => {});
  const oldRejected = assert.rejects(oldStart, /已取消/);
  await turn();
  await oldRecorder.stop();
  await oldRejected;
  const currentRecorder = browser.createRecorder();
  const currentStart = currentRecorder.start(() => {});
  await turn();
  const currentStream = mockStream();
  browser.requests[1].resolve(currentStream);
  await currentStart;
  assert.equal(browser.connections, 1);
  const lateStream = mockStream();
  browser.requests[0].resolve(lateStream);
  await turn();
  assert.equal(lateStream.track.stopped, true);
  assert.equal(currentStream.track.stopped, false);
  assert.equal(browser.connections, 1);
  await currentRecorder.stop();
  assert.equal(currentStream.track.stopped, true);
});

test('late permission denial after cancellation has no unhandled rejection', async () => {
  const browser = browserWrapper();
  const recorder = browser.createRecorder();
  const rejected = assert.rejects(recorder.start(() => {}), /已取消/);
  await turn();
  await recorder.stop();
  await rejected;
  browser.requests[0].reject(new DOMException('Permission denied', 'NotAllowedError'));
  await turn();
  assert.equal(browser.contexts[0].state, 'closed');
});
