import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createInterviewServer } from '../src/server.js';
import type { ServerEvent } from '../src/protocol.js';
import type { TestContext } from 'node:test';
import type { TranscriptionCallbacks } from '../src/transcription.js';
import type { SessionDependencies } from '../src/session.js';

const profile = { role: '工程师', resume: '', jobDescription: '', language: 'zh', answerStyle: 'concise' };
const start = { type: 'session.start', mode: 'demo', profile, token: 'test-secret' };
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.equal(predicate(), true, 'Expected state did not arrive');
}
async function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}, dependencies: SessionDependencies = {}) {
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', APP_ACCESS_TOKEN: 'test-secret', ...env }), { demoDelayMs: 10, ...dependencies });
  const port = await server.listen();
  t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: ServerEvent[] = [];
  socket.on('message', data => events.push(JSON.parse(data.toString()) as ServerEvent));
  await once(socket, 'open');
  async function waitFor(predicate: (event: ServerEvent) => boolean): Promise<ServerEvent> {
    const timeout = Date.now() + 4000;
    while (Date.now() < timeout) {
      const found = events.find(predicate);
      if (found) return found;
      await delay(5);
    }
    assert.fail(`Missing expected event; received ${JSON.stringify(events)}`);
  }
  return { server, socket, events, waitFor, port };
}

test('demo WS lifecycle streams tagged answer, pauses, resumes and stops cleanly', async t => {
  const f = await fixture(t);
  f.socket.send(JSON.stringify(start));
  const ready = await f.waitFor(e => e.type === 'session.ready');
  assert.equal(ready.type === 'session.ready' && ready.mode, 'demo');
  await f.waitFor(e => e.type === 'answer.done');
  const answer = f.events.filter(e => e.type === 'answer.delta').map(e => e.text).join('');
  assert.match(answer, /演示回答/);
  assert.equal(f.events.some(e => e.type === 'status' && e.message?.includes('内置问题与答案')), true);
  f.socket.send(JSON.stringify({ type: 'session.pause' }));
  await f.waitFor(e => e.type === 'status' && e.stage === 'paused');
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '请介绍你的经历' }));
  await f.waitFor(e => e.type === 'error' && e.code === 'SESSION_PAUSED');
  f.socket.send(JSON.stringify({ type: 'session.resume' }));
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '请介绍你的经历' }));
  await f.waitFor(e => e.type === 'question.detected' && e.text === '请介绍你的经历');
  f.socket.send(JSON.stringify({ type: 'session.stop' }));
  await f.waitFor(e => e.type === 'session.stopped');
});

test('unauthenticated clients cannot start or send questions', async t => {
  const f = await fixture(t);
  f.socket.send(JSON.stringify({ ...start, token: 'wrong' }));
  await f.waitFor(e => e.type === 'error' && e.code === 'UNAUTHORIZED');
  assert.equal(f.events.some(e => e.type === 'session.ready'), false);
});

test('a second session.start is rejected rather than allocating a second upstream session', async t => {
  const f = await fixture(t);
  f.socket.send(JSON.stringify(start));
  await f.waitFor(e => e.type === 'session.ready');
  f.socket.send(JSON.stringify(start));
  await f.waitFor(e => e.type === 'error' && e.code === 'ALREADY_STARTED');
  assert.equal(f.events.filter(e => e.type === 'session.ready').length, 1);
});

test('demo mode explicitly rejects microphone audio', async t => {
  const f = await fixture(t);
  f.socket.send(JSON.stringify(start));
  await f.waitFor(e => e.type === 'session.ready');
  f.socket.send(JSON.stringify({ type: 'audio.append', seq: 0, audio: 'AAAA' }));
  await f.waitFor(e => e.type === 'error' && e.code === 'DEMO_AUDIO_REJECTED');
});

test('invalid manual question stays recoverable and does not end the session', async t => {
  const f = await fixture(t);
  f.socket.send(JSON.stringify(start));
  await f.waitFor(e => e.type === 'session.ready');
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '?' }));
  const error = await f.waitFor(e => e.type === 'error' && e.code === 'INVALID_QUESTION');
  assert.equal(error.type === 'error' && error.recoverable, true);
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '请介绍你的项目' }));
  await f.waitFor(e => e.type === 'question.detected' && e.text === '请介绍你的项目');
});

test('live mode fails clearly without provider credentials and health never leaks secrets', async t => {
  const f = await fixture(t, { LLM_API_KEY: 'do-not-expose' });
  const response = await fetch(`http://127.0.0.1:${f.port}/health`);
  const body = await response.text();
  assert.equal(JSON.parse(body).capabilities.live, false);
  assert.equal(body.includes('do-not-expose'), false);
  assert.equal(body.includes('test-secret'), false);
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await f.waitFor(e => e.type === 'error' && e.code === 'PROVIDER_NOT_CONFIGURED');
});

test('unavailable local ASR explains how to recover and never reports a ready recording session', async t => {
  let closed = false;
  const f = await fixture(t, { ASR_PROVIDER: 'local', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' }, {
    transcriber: () => ({
      connect: async () => { throw new Error('connection failed: private upstream details'); },
      append() {}, clear() {}, close() { closed = true; },
    }),
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  const error = await f.waitFor(e => e.type === 'error' && e.code === 'ASR_UNAVAILABLE');
  assert.ok(error.type === 'error');
  assert.match(error.message, /本地语音识别服务未启动或连接失败/);
  assert.equal(error.recoverable, false);
  assert.equal(error.message.includes('private'), false);
  assert.equal(f.events.some(e => e.type === 'session.ready'), false);
  assert.equal(closed, true);
});

test('text mode routes manual questions to the configured LLM without connecting ASR', async t => {
  let upstreamRequests = 0;
  let requestBody = '';
  const upstream = createServer((request, response) => {
    upstreamRequests++;
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer local-test-key');
    request.on('data', chunk => { requestBody += String(chunk); });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"针对当前问题的回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  let transcriberCreated = false;
  const f = await fixture(t, {
    LLM_BASE_URL: `http://127.0.0.1:${address.port}`, LLM_API_KEY: 'local-test-key', LLM_MODEL: 'deepseek-flash', LLM_THINKING: 'disabled',
  }, { transcriber: () => { transcriberCreated = true; throw new Error('Text mode must not allocate ASR'); } });
  f.socket.send(JSON.stringify({ ...start, mode: 'text' }));
  const ready = await f.waitFor(e => e.type === 'session.ready');
  assert.equal(ready.type === 'session.ready' && ready.mode, 'text');
  await delay(30);
  assert.equal(upstreamRequests, 0, 'Text mode should wait for a manual question');
  assert.equal(f.events.some(e => e.type === 'transcript.final'), false);
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '你会怎么优化数据库性能？' }));
  await f.waitFor(e => e.type === 'answer.done');
  assert.equal(upstreamRequests, 1);
  assert.equal(transcriberCreated, false);
  assert.equal(f.events.filter(e => e.type === 'answer.delta').map(e => e.text).join(''), '针对当前问题的回答');
  const payload = JSON.parse(requestBody);
  assert.equal(payload.model, 'deepseek-flash');
  assert.deepEqual(payload.thinking, { type: 'disabled' });
  assert.equal(JSON.parse(payload.messages[1].content).interviewerQuestion, '你会怎么优化数据库性能？');
});

test('text mode requires both an LLM key and a model', async t => {
  for (const env of [{}, { LLM_API_KEY: 'test-key' }, { LLM_MODEL: 'test-model' }]) {
    await t.test(JSON.stringify(Object.keys(env)), async t => {
      const f = await fixture(t, env);
      f.socket.send(JSON.stringify({ ...start, mode: 'text' }));
      const error = await f.waitFor(e => e.type === 'error' && e.code === 'PROVIDER_NOT_CONFIGURED');
      assert.equal(error.type === 'error' && error.recoverable, false);
      assert.equal(f.events.some(e => e.type === 'session.ready'), false);
    });
  }
});

test('text mode rejects audio without allocating ASR and remains available for manual questions', async t => {
  let transcriberCreated = false;
  const f = await fixture(t, { LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' }, {
    transcriber: () => { transcriberCreated = true; throw new Error('Text mode must not allocate ASR'); },
    answerSource: async function* () { yield '手动问题回答'; },
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'text' }));
  await f.waitFor(e => e.type === 'session.ready');
  f.socket.send(JSON.stringify({ type: 'audio.append', seq: 0, audio: Buffer.alloc(4800).toString('base64') }));
  const error = await f.waitFor(e => e.type === 'error' && e.code === 'TEXT_AUDIO_REJECTED');
  assert.equal(error.type === 'error' && error.recoverable, true);
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  assert.equal(transcriberCreated, false);
  f.socket.send(JSON.stringify({ type: 'question.ask', text: '请介绍你的经历' }));
  await f.waitFor(e => e.type === 'answer.done');
});

test('LLM-only configuration still cannot start a live voice session', async t => {
  const f = await fixture(t, { LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' });
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await f.waitFor(e => e.type === 'error' && e.code === 'PROVIDER_NOT_CONFIGURED');
  assert.equal(f.events.some(e => e.type === 'session.ready'), false);
});

test('live session routes PCM to ASR, detects final questions, and tears down on stop', async t => {
  let callbacks: TranscriptionCallbacks | undefined;
  const frames: Buffer[] = [];
  let closed = false;
  let clears = 0;
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', LLM_API_KEY: 'test', LLM_MODEL: 'test', ASR_API_KEY: 'test', ASR_MODEL: 'test' }), {
    transcriber: handler => {
      callbacks = handler;
      return { connect: async () => {}, append: pcm => { frames.push(pcm); }, clear: () => { clears++; }, close: () => { closed = true; } };
    },
    answerSource: async function* () { yield '真实链路模拟回答'; },
  });
  const port = await server.listen(); t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: ServerEvent[] = [];
  socket.on('message', data => events.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await eventually(() => events.some(e => e.type === 'session.ready'));
  socket.send(JSON.stringify({ type: 'audio.append', seq: 1, audio: Buffer.alloc(4800).toString('base64') }));
  await eventually(() => frames.length === 1); assert.equal(frames[0]?.length, 4800);
  callbacks?.partial('utterance-1', '你会怎么');
  callbacks?.final('utterance-1', '你会怎么优化数据库性能？');
  await eventually(() => events.some(e => e.type === 'answer.done'));
  assert.equal(events.some(e => e.type === 'question.detected' && e.text === '你会怎么优化数据库性能？'), true);
  assert.equal(events.some(e => e.type === 'answer.done'), true);
  socket.send(JSON.stringify({ type: 'session.pause' }));
  await eventually(() => events.some(e => e.type === 'status' && e.stage === 'paused'));
  socket.send(JSON.stringify({ type: 'audio.append', seq: 2, audio: Buffer.alloc(4800).toString('base64') }));
  callbacks?.final('utterance-2', '请解释你会怎么设计系统？');
  await delay(30);
  assert.equal(frames.length, 1);
  assert.equal(events.some(e => e.type === 'transcript.final' && e.id === 'utterance-2'), false);
  assert.equal(clears, 1);
  socket.send(JSON.stringify({ type: 'session.stop' }));
  await once(socket, 'close');
  assert.equal(closed, true);
});

test('stable ASR partial prepares privately and the exact final promotes it with the same context', async t => {
  let callbacks: TranscriptionCallbacks | undefined;
  let requests = 0;
  const question = '你会如何排查一个接口突然变慢的问题';
  const f = await fixture(t, { LLM_API_KEY: 'test', LLM_MODEL: 'test', ASR_PROVIDER: 'local', ANSWER_PREFETCH_STABLE_MS: '80' }, {
    transcriber: handler => { callbacks = handler; return { connect: async () => {}, append() {}, clear() {}, close() {} }; },
    answerSource: async function* () { requests++; await delay(20); yield '先通过监控定位瓶颈，再分层排查。'; },
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await f.waitFor(e => e.type === 'session.ready');
  callbacks!.final('background', '背景是一个高并发支付系统');
  callbacks!.partial('question', question);
  await eventually(() => requests === 1);
  await delay(40);
  assert.equal(f.events.some(e => e.type === 'answer.delta'), false, 'Speculation must remain private');
  callbacks!.partial('question', `${question}？`);
  callbacks!.final('question', `${question}？`);
  await f.waitFor(e => e.type === 'answer.done');
  assert.equal(requests, 1, 'Committing the question must not change its pre-utterance context');
  const timing = f.events.find(e => e.type === 'answer.timing');
  assert.ok(timing?.type === 'answer.timing');
  assert.equal(timing.source, 'prepared');
  assert.ok(timing.questionCommitToFirstTokenMs < 200);
});

test('explicit continuation after a short ASR segment generates an answer to the complete question', async t => {
  let callbacks: TranscriptionCallbacks | undefined;
  const asked: string[] = [];
  const f = await fixture(t, { LLM_API_KEY: 'test', LLM_MODEL: 'test', ASR_PROVIDER: 'local' }, {
    transcriber: handler => { callbacks = handler; return { connect: async () => {}, append() {}, clear() {}, close() {} }; },
    answerSource: async function* (question) { asked.push(question); yield `回答：${question}`; },
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await f.waitFor(e => e.type === 'session.ready');
  callbacks!.final('intro', '请介绍一下你最近做的项目');
  await f.waitFor(e => e.type === 'answer.done');
  callbacks!.final('continuation', '以及你在项目中解决的技术难题');
  await eventually(() => f.events.filter(e => e.type === 'answer.done').length === 2);
  assert.equal(asked[1], '请介绍一下你最近做的项目，以及你在项目中解决的技术难题');
  callbacks!.final('candidate', '我的项目是一个订单系统');
  callbacks!.final('candidate2', '还有支付模块');
  await delay(30);
  assert.equal(asked.length, 2, 'An intervening candidate statement ends the continuation window');
});

test('ASR negation correction cancels prepared text and never displays the old answer', async t => {
  let callbacks: TranscriptionCallbacks | undefined;
  let requests = 0;
  let firstSignal: AbortSignal | undefined;
  const f = await fixture(t, { LLM_API_KEY: 'test', LLM_MODEL: 'test', ASR_PROVIDER: 'local', ANSWER_PREFETCH_STABLE_MS: '80' }, {
    transcriber: handler => { callbacks = handler; return { connect: async () => {}, append() {}, clear() {}, close() {} }; },
    answerSource: async function* (question, _profile, signal) {
      requests++; firstSignal ??= signal;
      await delay(10);
      yield question.includes('不能') ? '不能使用缓存时先定位数据库与网络瓶颈。' : '使用缓存的旧答案';
    },
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'live', speakerMode: 'interviewer' }));
  await f.waitFor(e => e.type === 'session.ready');
  callbacks!.partial('question', '你会怎么使用缓存优化接口响应时间');
  await eventually(() => requests === 1);
  callbacks!.partial('question', '如果不能使用缓存你会怎么优化接口响应时间');
  assert.equal(firstSignal?.aborted, true);
  callbacks!.final('question', '如果不能使用缓存你会怎么优化接口响应时间');
  await f.waitFor(e => e.type === 'answer.done');
  assert.equal(requests, 2);
  const answer = f.events.filter(e => e.type === 'answer.delta').map(e => e.text).join('');
  assert.match(answer, /不能使用缓存/);
  assert.doesNotMatch(answer, /旧答案/);
  assert.equal(f.events.find(e => e.type === 'answer.timing')?.type, 'answer.timing');
});

test('same manual question uses session cache while regenerate explicitly makes a fresh request', async t => {
  let requests = 0;
  const f = await fixture(t, { LLM_API_KEY: 'test', LLM_MODEL: 'test' }, {
    answerSource: async function* () { requests++; yield '先用监控定位瓶颈，再验证优化收益。'; },
  });
  f.socket.send(JSON.stringify({ ...start, mode: 'text' }));
  await f.waitFor(e => e.type === 'session.ready');
  for (const [index, bypassCache] of [false, false, true].entries()) {
    if (index) await delay(520);
    f.socket.send(JSON.stringify({ type: 'question.ask', text: '你会如何优化响应延迟？', bypassCache }));
    await eventually(() => f.events.filter(e => e.type === 'answer.done').length === index + 1);
  }
  assert.equal(requests, 2);
  assert.deepEqual(f.events.filter(e => e.type === 'answer.start').map(e => e.source), ['fresh', 'cache', 'fresh']);
});
