import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { diagnosticErrorCode, diagnosticSpeakerReason, type SessionDiagnostic } from '../src/diagnostics.js';
import { createInterviewServer } from '../src/server.js';
import type { SessionDependencies } from '../src/session.js';
import type { ServerEvent, SpeakerMetadata } from '../src/protocol.js';
import type { TranscriptionCallbacks } from '../src/transcription.js';

const token = 'private-access-token-not-for-logs';
const profile = { role: 'private-role', resume: 'private-resume', jobDescription: 'private-job', language: 'zh', answerStyle: 'concise' };
const voiceProfile = { version: 1, model: 'campplus-zh-v1', embedding: Array.from({ length: 192 }, (_, i) => i === 0 ? 0.123456789 : 0), voicedMs: 5000 };
const interviewer: SpeakerMetadata = { speaker: 'interviewer', speakerSource: 'voice' };
const answer = '我的回答内容属于私人信息。如何处理系统中的网络请求超时问题，是我考虑过的一个问题。';

async function eventually(predicate: () => boolean) {
  const until = Date.now() + 3000;
  while (!predicate() && Date.now() < until) await delay(5);
  assert.ok(predicate(), 'Expected event did not arrive');
}

async function fixture(t: TestContext, overrides: SessionDependencies = {}) {
  let callbacks!: TranscriptionCallbacks;
  const diagnostics: SessionDiagnostic[] = [];
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', ASR_PROVIDER: 'local',
    APP_ACCESS_TOKEN: token, LLM_API_KEY: 'private-provider-key', LLM_MODEL: 'test' }), {
    diagnosticSink: entry => diagnostics.push(entry),
    transcriber: handler => {
      callbacks = handler;
      return { speakerSupported: true, connect: async () => {}, append() {}, clear() {}, close() {} };
    },
    answerSource: async function* () { yield answer; },
    ...overrides,
  });
  const port = await server.listen(); t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: ServerEvent[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'session.start', mode: 'live', profile, voiceProfile, token }));
  await eventually(() => events.some(e => e.type === 'session.ready'));
  return { callbacks, diagnostics, events, socket };
}

test('four successive answers and each skipped transcript have content-free correlated diagnostics', async t => {
  const f = await fixture(t);
  const questions = ['请介绍一下你的项目经历', '你如何优化数据库查询', '你为什么选择星河', '你用过 Redis 吗'];
  for (const [index, question] of questions.entries()) {
    f.callbacks.final(`private-upstream-${index}`, question, interviewer);
    await eventually(() => f.events.filter(e => e.type === 'answer.done').length === index + 1);
  }
  f.callbacks.final('private-candidate-id', '为什么我选择这家公司', { speaker: 'candidate', speakerSource: 'voice', speakerReason: 'private-speaker-details' });
  f.callbacks.final('private-unknown-id', '请介绍一下你的工作经历', { speaker: 'unknown', speakerSource: 'voice', speakerReason: 'private-speaker-details' });
  f.callbacks.final('private-nonquestion-id', '接下来讨论项目经历', interviewer);
  f.callbacks.final('private-duplicate-id', questions[2]!, interviewer);
  f.callbacks.final('private-echo-id', '如何处理系统中的网络请求超时问题', interviewer);
  await eventually(() => f.events.filter(e => e.type === 'transcript.final').length === 9);
  assert.equal(f.events.filter(e => e.type === 'answer.done').length, 4);
  const decisions = f.diagnostics.filter(e => e.event === 'question_decision');
  assert.deepEqual(decisions.map(e => [e.finalNumber, e.speaker, e.reason]), [
    [1, 'interviewer', 'accepted'], [2, 'interviewer', 'accepted'], [3, 'interviewer', 'accepted'], [4, 'interviewer', 'accepted'],
    [5, 'candidate', 'not_interviewer'], [6, 'unknown', 'not_interviewer'], [7, 'interviewer', 'not_question'],
    [8, 'interviewer', 'duplicate'], [9, 'interviewer', 'answer_echo'],
  ]);
  assert.equal(decisions[4]?.speakerReason, 'other');
  assert.equal(decisions[5]?.speakerReason, 'other');
  const ready = f.events.find(e => e.type === 'session.ready');
  assert.ok(ready?.type === 'session.ready');
  assert.ok(f.diagnostics.every(e => e.sessionId === ready.sessionId));
  for (const event of ['answer_start', 'answer_timing', 'answer_done'] as const) {
    const logs = f.diagnostics.filter(e => e.event === event);
    assert.equal(logs.length, 4);
    assert.deepEqual(logs.map(e => e.questionId), f.events.filter(e => e.type === 'question.detected').map(e => e.id));
  }
  const close = once(f.socket, 'close');
  f.socket.close(1000, 'private-client-close-reason');
  await close;
  await eventually(() => f.diagnostics.some(e => e.event === 'socket_closed'));
  assert.equal(f.diagnostics.find(e => e.event === 'socket_closed')?.code, 1000);
  const serialized = JSON.stringify(f.diagnostics);
  for (const secret of [token, ...Object.values(profile), answer, ...questions, 'private-upstream', 'private-speaker-details',
    'private-client-close-reason', 'private-provider-key', 'embedding', 'campplus', '0.123456789', 'voicedMs']) {
    // Language/style are not individually secret; field-level absence below guards the profile.
    if (secret !== 'zh' && secret !== 'concise') assert.equal(serialized.includes(secret), false, `Unexpected private value: ${secret}`);
  }
  assert.doesNotMatch(serialized, /"(?:text|profile|resume|audio|token|speakerSimilarity|speakerVoicedMs)":/);
});

test('speaker diagnostics retain only known reasons while preserving the speaker gate', async t => {
  const f = await fixture(t);
  const reasons = ['ambiguous', 'insufficient_audio', 'not_enrolled', 'mixed_speakers',
    'candidate_match', 'different_speaker', 'profile_required', 'speaker_unavailable'] as const;
  for (const [index, speakerReason] of reasons.entries()) {
    f.callbacks.final(`private-reason-id-${index}`, '你为什么选择星河', {
      speaker: speakerReason === 'different_speaker' ? 'interviewer' : speakerReason === 'candidate_match' ? 'candidate' : 'unknown',
      speakerSource: 'voice', speakerReason,
    });
  }
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  const decisions = f.diagnostics.filter(e => e.event === 'question_decision');
  assert.deepEqual(decisions.map(e => e.speakerReason), reasons);
  assert.equal(f.events.filter(e => e.type === 'answer.start').length, 1);
  assert.equal(diagnosticSpeakerReason(undefined), undefined);
  assert.equal(diagnosticSpeakerReason('candidate_match private-secret'), 'other');
  assert.equal(diagnosticSpeakerReason('private-secret'), 'other');
});

test('answer errors log only their safe code and generated question id, then the next question still succeeds', async t => {
  let calls = 0;
  const f = await fixture(t, { answerSource: async function* () {
    if (++calls === 1) throw new Error('private-provider-response-containing-a-key');
    yield answer;
  } });
  f.callbacks.final('private-failure-id', '请介绍一下你的项目经历', interviewer);
  await eventually(() => f.events.some(e => e.type === 'error' && e.code === 'ANSWER_FAILED'));
  const failure = f.diagnostics.find(e => e.event === 'session_error');
  assert.ok(failure?.event === 'session_error');
  assert.equal(failure.code, 'ANSWER_FAILED');
  assert.equal(failure.recoverable, true);
  assert.equal(failure.questionId, f.events.find(e => e.type === 'question.detected')?.id);
  assert.equal(JSON.stringify(f.diagnostics).includes('private-provider-response'), false);
  assert.equal(diagnosticErrorCode('private-unrecognized-code'), 'OTHER');
  f.callbacks.final('private-recovery-id', '你为什么选择星河', interviewer);
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
});

test('a failing diagnostic sink cannot interrupt recording, answer delivery or shutdown', async t => {
  let calls = 0;
  const f = await fixture(t, { diagnosticSink: () => { calls++; throw new Error('log destination failed'); } });
  f.callbacks.final('private-id', '你为什么选择星河', interviewer);
  await eventually(() => f.events.some(e => e.type === 'answer.done'));
  assert.ok(calls >= 5);
  const close = once(f.socket, 'close');
  f.socket.send(JSON.stringify({ type: 'session.stop' }));
  await close;
  assert.ok(f.events.some(e => e.type === 'session.stopped'));
});
