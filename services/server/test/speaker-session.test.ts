import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createInterviewServer } from '../src/server.js';
import { clientEventSchema, type ServerEvent, type SpeakerMetadata, type VoiceProfile } from '../src/protocol.js';
import type { SessionDependencies } from '../src/session.js';
import type { TranscriptionCallbacks, TranscriberOptions } from '../src/transcription.js';

const profile = { role: '工程师', resume: '', jobDescription: '', language: 'zh', answerStyle: 'concise' };
const voiceProfile: VoiceProfile = { version: 1, model: 'campplus-zh-v1', embedding: Array.from({ length: 192 }, (_, i) => i === 0 ? 1 : 0), voicedMs: 5000 };
const interviewer: SpeakerMetadata = { speaker: 'interviewer', speakerSource: 'voice' };
const candidate: SpeakerMetadata = { speaker: 'candidate', speakerSource: 'voice' };
const unknown: SpeakerMetadata = { speaker: 'unknown', speakerSource: 'voice', speakerReason: 'uncertain' };
async function eventually(predicate: () => boolean) {
  const until = Date.now() + 3000;
  while (!predicate() && Date.now() < until) await delay(5);
  assert.ok(predicate(), 'Expected event did not arrive');
}
async function fixture(t: TestContext, extras: Record<string, unknown> = {}, supported = true, source?: SessionDependencies['answerSource']) {
  let callbacks!: TranscriptionCallbacks;
  let options!: TranscriberOptions;
  const operations: string[] = [];
  const questions: string[] = [];
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', ASR_PROVIDER: 'local', LLM_API_KEY: 'test', LLM_MODEL: 'test', ANSWER_PREFETCH_STABLE_MS: '80' }), {
    transcriber: (handler, settings) => {
      callbacks = handler; options = settings;
      return { speakerSupported: supported, connect: async () => {}, append: () => { operations.push('audio'); },
        clear: () => { operations.push('clear'); }, close() {},
        finishEnrollment: () => { operations.push('finish'); }, cancelEnrollment: () => { operations.push('cancel'); } };
    },
    answerSource: async function* (question, context, signal) {
      questions.push(question);
      if (source) yield* source(question, context, signal); else yield '可以直接朗读的回答。';
    },
  });
  const port = await server.listen(); t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: ServerEvent[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString()) as ServerEvent));
  await once(socket, 'open');
  const send = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
  send({ type: 'session.start', mode: 'live', profile, ...extras });
  await eventually(() => events.some(e => e.type === 'session.ready'));
  return { socket, events, send, callbacks, options, operations, questions };
}

test('voice enrollment schema requires live mode and a finite 192-dimensional profile', () => {
  const start = { type: 'session.start', mode: 'live', profile, voiceProfile, enrollSpeaker: true };
  assert.equal(clientEventSchema.safeParse(start).success, true);
  assert.equal(clientEventSchema.safeParse({ ...start, mode: 'demo' }).success, false);
  for (const embedding of [[], Array(191).fill(0), Array(193).fill(0), Array(192).fill(0), Array(192).fill(1e-12), Array(192).fill(1001), Array(192).fill(Infinity), Array(192).fill(NaN)]) {
    assert.equal(clientEventSchema.safeParse({ ...start, voiceProfile: { ...voiceProfile, embedding } }).success, false);
  }
});

test('default auto without a voice profile records unknown speech and explicitly asks for enrollment', async t => {
  const f = await fixture(t);
  f.callbacks.final('q', '请你简单讲一下 Transformer 的架构', interviewer);
  await eventually(() => f.events.some(e => e.type === 'transcript.final'));
  assert.equal(f.events.find(e => e.type === 'transcript.final')?.speaker, 'unknown');
  assert.equal(f.events.some(e => e.type === 'error' && e.code === 'VOICE_PROFILE_REQUIRED'), true);
  assert.deepEqual(f.events.find(e => e.type === 'speaker.state'), { type: 'speaker.state', mode: 'auto', enrolled: false, enrolling: false });
  assert.equal(f.questions.length, 0);
});

test('only interviewer questions answer; candidate repetition, counterquestions and unknown speech preserve the active answer', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  const f = await fixture(t, { voiceProfile }, true, async function* (_q, _p, signal) {
    signal.addEventListener('abort', () => { aborted = true; });
    yield '第一句答案。'; await gate; yield '第二句答案。';
  });
  const question = '你好请你简单讲一下 Transformer 的架构吧';
  f.callbacks.final('interviewer', question, interviewer);
  await eventually(() => f.events.some(e => e.type === 'answer.delta'));
  f.callbacks.partial('candidate', question, candidate);
  f.callbacks.final('candidate', question, candidate);
  f.callbacks.final('counterquestion', '为什么这里需要注意力机制？', candidate);
  f.callbacks.final('unknown', '请介绍一下你的项目经历', unknown);
  await eventually(() => f.events.filter(e => e.type === 'transcript.final').length === 4);
  assert.equal(f.questions.length, 1);
  assert.equal(aborted, false);
  assert.equal(f.events.filter(e => e.type === 'question.detected').length, 1);
  assert.equal(f.events.filter(e => e.type === 'answer.start').length, 1);
  release(); await eventually(() => f.events.some(e => e.type === 'answer.done'));
  assert.equal(f.events.filter(e => e.type === 'answer.delta').map(e => e.text).join(''), '第一句答案。第二句答案。');
  f.callbacks.final('continuation', '以及你在项目中负责的模块', interviewer);
  await delay(30);
  assert.equal(f.questions.length, 1, 'candidate/unknown speech must end the previous interviewer continuation');
});

test('unidentified partials cannot prefetch and candidate partials cancel only private preparation', async t => {
  const f = await fixture(t, { voiceProfile });
  const question = '你会如何排查一个高并发接口的响应延迟问题';
  f.callbacks.partial('q', question, unknown);
  await delay(120); assert.equal(f.questions.length, 0);
  f.callbacks.partial('q', question, interviewer);
  await eventually(() => f.questions.length === 1);
  f.callbacks.partial('q', question, candidate);
  f.callbacks.final('q', question, candidate);
  await delay(30);
  assert.equal(f.events.some(e => e.type === 'answer.start'), false);
});

test('manual speaker changes clear upstream generations and preserve an already committed answer', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  const f = await fixture(t, { speakerMode: 'interviewer' }, false, async function* (_q, _p, signal) {
    signal.addEventListener('abort', () => { aborted = true; }); yield '固定答案'; await gate; yield '完成';
  });
  f.callbacks.final('q', '请讲一下 Redis 的用途');
  await eventually(() => f.events.some(e => e.type === 'answer.delta'));
  f.send({ type: 'speaker.set', speaker: 'candidate' });
  await eventually(() => f.operations.includes('clear'));
  f.callbacks.final('c', '请讲一下 Redis 的用途', interviewer);
  await eventually(() => f.events.some(e => e.type === 'transcript.final' && e.id === 'c'));
  assert.equal(f.events.find(e => e.type === 'transcript.final' && e.id === 'c')?.speaker, 'candidate');
  assert.equal(f.questions.length, 1); assert.equal(aborted, false);
  release(); await eventually(() => f.events.some(e => e.type === 'answer.done'));
  f.send({ type: 'speaker.set', speaker: 'auto' });
  await eventually(() => f.events.some(e => e.type === 'error' && e.code === 'SPEAKER_UNAVAILABLE'));
  f.callbacks.final('u', '请介绍一下 MySQL 的索引', interviewer);
  await delay(30); assert.equal(f.questions.length, 1);
});

test('a reset audio gap is visible and recoverable without stopping microphone intake or the current answer', async t => {
  const f = await fixture(t, { speakerMode: 'interviewer' });
  f.callbacks.final('q', '请介绍一下你的项目');
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  f.callbacks.audioGap!();
  await eventually(() => f.events.some(e => e.type === 'error' && e.code === 'ASR_AUDIO_GAP'));
  const error = f.events.find(e => e.type === 'error' && e.code === 'ASR_AUDIO_GAP');
  assert.ok(error?.type === 'error' && error.recoverable);
  assert.match(error.message, /录音仍在继续/);
  f.send({ type: 'audio.append', seq: 0, audio: Buffer.alloc(4800).toString('base64') });
  await eventually(() => f.operations.includes('audio'));
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  assert.equal(f.events.filter(e => e.type === 'answer.start').length, 1);
  assert.equal(f.events.some(e => e.type === 'session.stopped'), false);
});

test('enrollment suppresses ASR, remains recoverable on failure, then enables voice roles', async t => {
  const f = await fixture(t, { enrollSpeaker: true });
  assert.equal(f.options.enrollSpeaker, true);
  f.callbacks.final('enroll', '请简单讲一下你的项目', interviewer);
  f.send({ type: 'audio.append', seq: 0, audio: Buffer.alloc(4800).toString('base64') });
  f.send({ type: 'voice.enroll.finish' });
  await eventually(() => f.operations.includes('finish'));
  assert.equal(f.operations.includes('audio'), true);
  assert.equal(f.events.some(e => e.type === 'transcript.final'), false);
  f.callbacks.enrollmentFailed!('too_short');
  await eventually(() => f.events.some(e => e.type === 'error' && e.code === 'VOICE_ENROLL_TOO_SHORT'));
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  f.send({ type: 'voice.enroll.finish' }); await eventually(() => f.operations.filter(v => v === 'finish').length === 2);
  f.callbacks.enrolled!(voiceProfile);
  await eventually(() => f.events.some(e => e.type === 'voice.enrolled'));
  assert.deepEqual(f.events.filter(e => e.type === 'speaker.state').at(-1), { type: 'speaker.state', mode: 'auto', enrolled: true, enrolling: false });
  f.callbacks.final('q', '请简单讲一下你的项目', interviewer);
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  assert.equal(f.questions.length, 1);
});

test('switching enrollment to manual cancels enrollment before clearing and ignores a late enrolled profile', async t => {
  const f = await fixture(t, { enrollSpeaker: true });
  f.send({ type: 'speaker.set', speaker: 'interviewer' });
  await eventually(() => f.operations.includes('clear'));
  assert.deepEqual(f.operations, ['cancel', 'clear']);
  f.callbacks.enrolled!(voiceProfile);
  f.callbacks.final('q', '请简单讲一下你的项目');
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  assert.equal(f.events.some(e => e.type === 'voice.enrolled'), false);
  assert.deepEqual(f.events.filter(e => e.type === 'speaker.state').at(-1), { type: 'speaker.state', mode: 'interviewer', enrolled: false, enrolling: false });
});

test('selecting the current speaker mode is idempotent during enrollment and manual speech', async t => {
  const f = await fixture(t, { enrollSpeaker: true });
  f.send({ type: 'audio.append', seq: 0, audio: Buffer.alloc(4800).toString('base64') });
  await eventually(() => f.operations.includes('audio'));
  const initialStates = f.events.filter(e => e.type === 'speaker.state').length;
  f.send({ type: 'speaker.set', speaker: 'auto' });
  await eventually(() => f.events.filter(e => e.type === 'speaker.state').length > initialStates);
  assert.deepEqual(f.operations, ['audio'], 'reselecting auto must preserve the enrollment audio');
  assert.deepEqual(f.events.filter(e => e.type === 'speaker.state').at(-1), { type: 'speaker.state', mode: 'auto', enrolled: false, enrolling: true });
  f.send({ type: 'voice.enroll.finish' });
  await eventually(() => f.operations.includes('finish'));
  f.send({ type: 'speaker.set', speaker: 'interviewer' });
  await eventually(() => f.operations.includes('clear'));
  assert.deepEqual(f.operations, ['audio', 'finish', 'cancel', 'clear']);
  const before = f.events.filter(e => e.type === 'speaker.state').length;
  f.send({ type: 'speaker.set', speaker: 'interviewer' });
  await eventually(() => f.events.filter(e => e.type === 'speaker.state').length > before);
  assert.deepEqual(f.operations, ['audio', 'finish', 'cancel', 'clear'], 'reselecting a manual role must not reset ASR');
});

test('an unsupported provider cannot claim automatic roles; an explicit manual question remains usable', async t => {
  const f = await fixture(t, { voiceProfile }, false);
  f.callbacks.final('q', '请简单讲一下你的项目', interviewer);
  await eventually(() => f.events.some(e => e.type === 'transcript.final'));
  assert.equal(f.questions.length, 0);
  assert.equal(f.events.find(e => e.type === 'transcript.final')?.speaker, 'unknown');
  assert.equal(f.events.some(e => e.type === 'error' && e.code === 'SPEAKER_UNAVAILABLE'), true);
  f.send({ type: 'question.ask', text: '请简单讲一下你的项目' });
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  assert.equal(f.events.find(e => e.type === 'question.detected')?.speaker, 'interviewer');
});

test('LLM context labels speaker roles and never receives the voice profile or embedding', async t => {
  let requestBody = '';
  const upstream = createServer((request, response) => {
    request.on('data', chunk => { requestBody += String(chunk); });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"可以直接朗读的回答。"},"finish_reason":"stop"}]}\n\n');
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  let callbacks!: TranscriptionCallbacks;
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', ASR_PROVIDER: 'local', LLM_API_KEY: 'test', LLM_MODEL: 'test', LLM_BASE_URL: `http://127.0.0.1:${address.port}` }), {
    transcriber: handler => {
      callbacks = handler;
      return { speakerSupported: true, connect: async () => {}, append() {}, clear() {}, close() {} };
    },
  });
  const port = await server.listen(); t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: ServerEvent[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'session.start', mode: 'live', profile, voiceProfile }));
  await eventually(() => events.some(e => e.type === 'session.ready'));
  callbacks.final('c', '我负责缓存模块', candidate);
  callbacks.final('u', '还有一个支付模块', unknown);
  callbacks.final('i', '接下来讨论项目经历', interviewer);
  callbacks.final('q', '请简单讲一下项目的架构', interviewer);
  await eventually(() => events.some(e => e.type === 'answer.done'));
  const body = JSON.parse(requestBody);
  const context = JSON.parse(body.messages[1].content);
  assert.deepEqual(context.recentTranscript, ['候选人：我负责缓存模块', '未确认：还有一个支付模块', '面试官：接下来讨论项目经历']);
  assert.deepEqual(context.candidate, profile);
  assert.equal(context.interviewerQuestion, '请简单讲一下项目的架构');
  assert.doesNotMatch(requestBody, /embedding|voiceProfile|campplus|voicedMs/);
});
