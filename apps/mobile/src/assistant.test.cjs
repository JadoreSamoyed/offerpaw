const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const compile = (file) => ts.transpileModule(readFileSync(path.join(__dirname, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const hookCode = compile('useAssistant.ts');
const storageCode = compile('storage.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const profile = { role: '工程师', resume: '项目经历', jobDescription: '', language: 'zh', answerStyle: 'concise' };
const voiceProfile = { version: 1, model: 'campplus-zh-v1', embedding: Array.from({ length: 192 }, (_, i) => (i + 1) / 192), voicedMs: 8000 };

function storageHarness(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const exports = {};
  vm.runInNewContext(storageCode, {
    exports, URL, process: { env: { EXPO_PUBLIC_API_URL: options.apiUrl, EXPO_PUBLIC_DEMO_ONLY: options.demoOnly ? '1' : '' } },
    ...(options.location ? { window: { location: options.location } } : {}),
    require(name) {
      if (name === '@react-native-async-storage/async-storage') return { __esModule: true, default: {
        async getItem(key) { return values.get(key) ?? null; },
        async setItem(key, value) { values.set(key, value); },
        async removeItem(key) { values.delete(key); },
      } };
      if (name === 'expo-secure-store') return { async getItemAsync() { return ''; }, async setItemAsync() {} };
      if (name === 'react-native') return { Platform: { OS: options.platform || 'android' } };
      if (name === './types') return { defaultProfile: profile };
      throw new Error(name);
    },
  });
  return { values, exports };
}

async function hookHarness(initialVoice = null, serverUrl = 'http://localhost:8787', options = {}) {
  const storage = storageHarness(initialVoice ? { 'tingda.voice-profile.v1': JSON.stringify(initialVoice) } : {}, options);
  const calls = { saved: [], sockets: [], recorderStarts: 0, recorderStops: 0 };
  const slots = [];
  const effects = [];
  let cursor = 0;
  let audio;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; calls.sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    async event(value) { await this.onmessage({ data: JSON.stringify(value) }); }
  }
  const exports = {};
  vm.runInNewContext(hookCode, {
    exports, WebSocket: Socket, performance, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === 'react') return {
        useState(initial) {
          const index = cursor++;
          if (!slots[index]) slots[index] = { value: initial };
          return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
        },
        useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
        useEffect(fn) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(fn); } },
      };
      if (name === 'react-native') return { Platform: { OS: 'android' }, AppState: { addEventListener() { return { remove() {} }; } } };
      if (name === 'expo-keep-awake') return { async activateKeepAwakeAsync() {}, async deactivateKeepAwake() {} };
      if (name === './audio') return { createRecorder() { return {
        async start(onAudio) { calls.recorderStarts++; audio = onAudio; },
        async stop() { calls.recorderStops++; return { uri: 'file:///recording.wav', mimeType: 'audio/wav', durationMs: 10000 }; },
        async pause() {}, async resume() {},
      }; } };
      if (name === './storage') return storage.exports;
      throw new Error(name);
    },
  });
  let api;
  function render() {
    cursor = 0;
    api = exports.useAssistant(profile, { serverUrl, token: options.token || '' }, async (record) => calls.saved.push(plain(record)));
    for (const effect of effects.splice(0)) effect();
    return api;
  }
  async function settle() { await new Promise(setImmediate); return render(); }
  render();
  await settle();
  return {
    calls, storage, render, settle, get api() { return api; },
    async start(speaker = 'auto', mode = 'live') {
      api.selectSpeaker(speaker); render();
      await api.start(mode); render();
      const ws = calls.sockets.at(-1); ws.open();
      await ws.event({ type: 'session.ready', sessionId: 'session-1' }); render();
      return ws;
    },
    async event(event) { await calls.sockets.at(-1).event(event); return render(); },
    audio(count = 1) {
      for (let i = 0; i < count; i++) audio({ audio: Buffer.alloc(4800).toString('base64'), level: 0.3, seq: i });
      return render();
    },
  };
}

test('installed phones require an explicit backend while browser preview retains its host', async () => {
  for (const platform of ['android', 'ios']) {
    const blank = storageHarness({}, { platform }).exports;
    assert.equal(blank.defaultServerUrl(), '');
    assert.equal((await blank.loadWorkspace()).settings.serverUrl, '');
    const configured = storageHarness({}, { platform, apiUrl: ' https://interview.example/api/ ' }).exports;
    assert.equal(configured.defaultServerUrl(), 'https://interview.example/api/');
    assert.equal(configured.serverEndpoint(configured.defaultServerUrl(), '/session', true), 'wss://interview.example/api/session');
  }
  const browser = storageHarness({}, { platform: 'web', location: { protocol: 'http:', hostname: '192.168.1.20' } }).exports;
  assert.equal(browser.defaultServerUrl(), 'http://192.168.1.20:8787');
  const saved = storageHarness({ 'tingda.workspace.v1': JSON.stringify({ serverUrl: 'http://192.168.1.31:8787' }) }, { apiUrl: 'https://interview.example' }).exports;
  assert.equal((await saved.loadWorkspace()).settings.serverUrl, 'http://192.168.1.31:8787');
});

test('demo build cannot start live capture or send a configured token or voice profile', async () => {
  const h = await hookHarness(voiceProfile, 'https://old-install.example', { demoOnly: true, token: 'fixture-old-token' });
  const ws = await h.start('auto', 'live');
  assert.equal(ws.url, 'ws://127.0.0.1:8787/session');
  assert.equal(ws.sent[0].mode, 'demo');
  assert.equal(Object.hasOwn(ws.sent[0], 'token'), false);
  assert.equal(Object.hasOwn(ws.sent[0], 'voiceProfile'), false);
  assert.equal(Object.hasOwn(ws.sent[0], 'enrollSpeaker'), false);
  assert.equal(h.calls.recorderStarts, 0);
});

test('connection validation gives actionable input errors and supports LAN, HTTPS, and explicit USB loopback', () => {
  const { serverEndpoint } = storageHarness().exports;
  assert.throws(() => serverEndpoint('', '/health'), /连接设置.*局域网 IP/);
  assert.throws(() => serverEndpoint('192.168.1.20:8787', '/health'), /http.*https/);
  assert.throws(() => serverEndpoint('not an address', '/health'), /格式不正确/);
  assert.throws(() => serverEndpoint('https://user:password@interview.example', '/health'), /密码/);
  assert.equal(serverEndpoint(' http://192.168.1.20:8787/ ', '/resume/extract'), 'http://192.168.1.20:8787/resume/extract');
  assert.equal(serverEndpoint('https://interview.example/api/', '/session', true), 'wss://interview.example/api/session');
  assert.equal(serverEndpoint('http://localhost:8787', '/session', true), 'ws://localhost:8787/session');
});

test('missing backend address does not start a session or request microphone access', async () => {
  const h = await hookHarness(null, '');
  await h.api.start('live');
  h.render();
  assert.equal(h.calls.sockets.length, 0);
  assert.equal(h.calls.recorderStarts, 0);
  assert.equal(h.api.stage, 'idle');
  assert.equal(h.api.enrolling, false);
  assert.match(h.api.error, /连接设置/);
});

test('voice profile storage validates shape and remains separate from resume and workspace history', async () => {
  const { exports: storage, values } = storageHarness();
  await storage.saveVoiceProfile(voiceProfile);
  await storage.saveWorkspace(profile, { serverUrl: 'http://localhost', token: '' }, []);
  assert.deepEqual(plain(await storage.loadVoiceProfile()), voiceProfile);
  assert.equal(JSON.stringify(JSON.parse(values.get('tingda.workspace.v1'))).includes('embedding'), false);
  for (const invalid of [null, {}, { ...voiceProfile, model: 'other' }, { ...voiceProfile, embedding: [1] },
    { ...voiceProfile, embedding: Array(192).fill(Infinity) }, { ...voiceProfile, embedding: Array(192).fill(0) },
    { ...voiceProfile, embedding: Array(192).fill(1e-10) }, { ...voiceProfile, embedding: Array(192).fill(1001) },
    { ...voiceProfile, voicedMs: -1 }]) {
    assert.equal(storage.parseVoiceProfile(invalid), null);
  }
  values.set('tingda.voice-profile.v1', 'broken');
  assert.equal(await storage.loadVoiceProfile(), null);
  await storage.saveVoiceProfile(null);
  assert.equal(values.has('tingda.voice-profile.v1'), false);
});

test('first live start enrolls in the same recording stream and finishes only once after 10 seconds', async () => {
  const h = await hookHarness();
  const ws = await h.start();
  assert.equal(ws.sent[0].enrollSpeaker, true);
  assert.equal(ws.sent[0].speakerMode, 'auto');
  h.audio(99);
  assert.equal(ws.sent.filter((e) => e.type === 'voice.enroll.finish').length, 0);
  h.audio(20);
  assert.equal(ws.sent.filter((e) => e.type === 'voice.enroll.finish').length, 1);
  assert.equal(h.api.enrollmentPending, true);
  assert.equal(h.calls.recorderStarts, 1);
  assert.equal(h.api.ask('请介绍你自己'), false);
  await h.event({ type: 'voice.enrolled', profile: voiceProfile });
  await h.event({ type: 'speaker.state', mode: 'auto', enrolled: true, enrolling: false });
  assert.equal(h.api.enrolling, false);
  assert.equal(h.api.voiceProfileReady, true);
  assert.equal(h.calls.recorderStarts, 1);
  assert.equal(h.calls.sockets.length, 1);
  assert.deepEqual(plain(await h.storage.exports.loadVoiceProfile()), voiceProfile);
});

test('failed voice enrollment waits for explicit retry and then records a new 10 second attempt', async () => {
  const h = await hookHarness();
  const ws = await h.start();
  h.audio(100);
  await h.event({ type: 'error', code: 'VOICE_ENROLL_TOO_SHORT', message: '请重新朗读', recoverable: true });
  h.audio(120);
  assert.equal(ws.sent.filter((e) => e.type === 'voice.enroll.finish').length, 1);
  assert.equal(h.api.enrollmentFailed, true);
  h.api.retryEnrollment(); h.render();
  h.audio(99);
  assert.equal(ws.sent.filter((e) => e.type === 'voice.enroll.finish').length, 1);
  h.audio();
  assert.equal(ws.sent.filter((e) => e.type === 'voice.enroll.finish').length, 2);
});

test('pause is disabled during enrollment so ASR cannot clear samples while the UI counter advances', async () => {
  const h = await hookHarness();
  const ws = await h.start();
  h.audio(50);
  await h.api.togglePause(); h.render();
  assert.equal(ws.sent.some((event) => event.type === 'session.pause'), false);
  assert.equal(h.api.enrollmentMs, 5000);
  h.audio(50);
  assert.equal(ws.sent.filter((event) => event.type === 'voice.enroll.finish').length, 1);
});

test('invalid audio enrollment failure exposes a retry without restarting the recording', async () => {
  const h = await hookHarness();
  const ws = await h.start();
  h.audio(100);
  await h.event({ type: 'error', code: 'VOICE_ENROLL_INVALID_AUDIO', message: '请重新朗读', recoverable: true });
  assert.equal(h.api.enrollmentPending, false);
  assert.equal(h.api.enrollmentFailed, true);
  assert.equal(h.api.active, true);
  h.api.retryEnrollment(); h.render();
  h.audio(100);
  assert.equal(ws.sent.filter((event) => event.type === 'voice.enroll.finish').length, 2);
  assert.equal(h.calls.recorderStarts, 1);
  assert.equal(h.calls.recorderStops, 0);
});

test('selecting the current automatic mode does not clear enrollment audio or its progress', async () => {
  const h = await hookHarness();
  const ws = await h.start();
  h.audio(50);
  h.api.selectSpeaker('auto'); h.render();
  assert.equal(ws.sent.some((event) => event.type === 'speaker.set'), false);
  assert.equal(h.api.enrollmentMs, 5000);
  h.audio(50);
  assert.equal(ws.sent.filter((event) => event.type === 'voice.enroll.finish').length, 1);
});

test('rapid role changes preserve the final user choice while repeated pending selections are ignored', async () => {
  const h = await hookHarness(voiceProfile);
  const ws = await h.start('interviewer');
  h.api.selectSpeaker('candidate'); h.render();
  h.api.selectSpeaker('candidate'); h.render();
  h.api.selectSpeaker('interviewer'); h.render();
  assert.deepEqual(ws.sent.filter((event) => event.type === 'speaker.set').map((event) => event.speaker), ['candidate', 'interviewer']);
  await h.event({ type: 'speaker.state', mode: 'candidate', enrolled: true, enrolling: false });
  await h.event({ type: 'speaker.state', mode: 'interviewer', enrolled: true, enrolling: false });
  h.api.selectSpeaker('interviewer'); h.render();
  assert.equal(ws.sent.filter((event) => event.type === 'speaker.set').length, 2);
});

test('recoverable ASR_AUDIO_GAP keeps the microphone and pinned answer active', async () => {
  const h = await hookHarness(voiceProfile);
  const ws = await h.start();
  await h.event({ type: 'question.detected', id: 'q1', text: '面试官问题', speaker: 'interviewer' });
  await h.event({ type: 'answer.delta', questionId: 'q1', text: '正在照读的答案' });
  await h.event({ type: 'error', code: 'ASR_AUDIO_GAP', message: '部分转写已跳过，录音仍在继续。', recoverable: true });
  h.audio();
  assert.equal(h.api.active, true);
  assert.equal(h.api.questions[0].answer, '正在照读的答案');
  assert.equal(h.calls.recorderStops, 0);
  assert.equal(ws.sent.at(-1).type, 'audio.append');
});

test('manual start skips enrollment; speaker controls wait for authoritative server state', async () => {
  const h = await hookHarness();
  const ws = await h.start('interviewer');
  assert.equal(ws.sent[0].enrollSpeaker, false);
  assert.equal(h.api.enrolling, false);
  h.api.selectSpeaker('candidate'); h.render();
  assert.equal(h.api.speakerMode, 'interviewer');
  assert.deepEqual(ws.sent.at(-1), { type: 'speaker.set', speaker: 'candidate' });
  await h.event({ type: 'speaker.state', mode: 'candidate', enrolled: false, enrolling: false });
  assert.equal(h.api.speakerMode, 'candidate');
  h.api.selectSpeaker('auto'); h.render();
  assert.match(h.api.error, /录入本人声音/);
  assert.equal(ws.sent.at(-1).speaker, 'candidate');
});

test('candidate and unknown speech preserves the pinned interviewer answer and is saved with speaker labels', async () => {
  const h = await hookHarness(voiceProfile);
  const ws = await h.start();
  assert.equal(ws.sent[0].enrollSpeaker, false);
  assert.deepEqual(ws.sent[0].voiceProfile, voiceProfile);
  assert.equal('voiceProfile' in ws.sent[0].profile, false);
  await h.event({ type: 'question.detected', id: 'q1', text: '介绍项目', speaker: 'interviewer' });
  await h.event({ type: 'answer.delta', questionId: 'q1', text: '我负责整个项目。' });
  await h.event({ type: 'answer.done', questionId: 'q1', latencyMs: 200 });
  for (const speaker of ['candidate', 'unknown']) {
    await h.event({ type: 'transcript.final', id: speaker, text: '我是这样解决问题的', speaker, speakerSource: speaker === 'candidate' ? 'voice' : 'unavailable' });
    await h.event({ type: 'question.detected', id: `bad-${speaker}`, text: '我的回答里含有问题', speaker });
  }
  await h.event({ type: 'question.detected', id: 'q1', text: '重复的问题', speaker: 'interviewer' });
  await h.event({ type: 'answer.start', questionId: 'bad-candidate', source: 'fresh' });
  assert.equal(h.api.stage, 'listening');
  assert.equal(h.api.questions.length, 1);
  assert.equal(h.api.questions[0].answer, '我负责整个项目。');
  assert.equal(h.api.transcripts.length, 2);
  await h.api.stop();
  assert.deepEqual(h.calls.saved[0].transcripts.map((t) => t.speaker), ['candidate', 'unknown']);
  assert.equal(h.calls.saved[0].questions[0].answer, '我负责整个项目。');
});

test('only a new confirmed interviewer question advances the pinned card; errors preserve existing answer text', async () => {
  const h = await hookHarness(voiceProfile);
  await h.start();
  await h.event({ type: 'question.detected', id: 'q1', text: '第一题', speaker: 'interviewer' });
  await h.event({ type: 'answer.delta', questionId: 'q1', text: '已有回答' });
  await h.event({ type: 'error', code: 'ANSWER_INCOMPLETE', message: '暂时失败', recoverable: true });
  assert.equal(h.api.questions[0].answer, '已有回答');
  await h.event({ type: 'question.detected', id: 'q2', text: '下一题', speaker: 'interviewer' });
  assert.equal(h.api.questions.at(-1).id, 'q2');
  assert.equal(h.api.questions[0].answer, '已有回答');
});

test('late transcript final retains chronological order while adding confirmed speaker metadata', async () => {
  const h = await hookHarness(voiceProfile);
  await h.start();
  await h.event({ type: 'transcript.partial', id: 'a', text: '请说', speaker: 'unknown' });
  await h.event({ type: 'transcript.partial', id: 'b', text: '我来回答', speaker: 'candidate' });
  await h.event({ type: 'transcript.final', id: 'a', text: '请说一下项目', speaker: 'interviewer', speakerSource: 'voice' });
  assert.deepEqual(plain(h.api.transcripts.map((t) => [t.id, t.speaker, t.final])), [
    ['a', 'interviewer', true], ['b', 'candidate', false],
  ]);
});
