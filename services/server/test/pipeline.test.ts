import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AnswerPipeline, normalizeAnswerQuestion } from '../src/answer-pipeline.js';
import type { AnswerSource } from '../src/answers.js';
import type { Profile, ServerEvent } from '../src/protocol.js';

const profile: Profile = { role: '工程师', resume: '', jobDescription: '', language: 'zh', answerStyle: 'concise' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(source: AnswerSource, extra: { cacheTtlMs?: number; maxCacheEntries?: number; timeoutMs?: number } = {}) {
  const events: ServerEvent[] = [];
  const remembered: string[] = [];
  const pipeline = new AnswerPipeline({ source, profile, emit: event => events.push(event),
    timeoutMs: 1000, onAnswer: answer => remembered.push(answer), ...extra });
  return { pipeline, events, remembered };
}
function starts(events: ServerEvent[]) { return events.filter(event => event.type === 'answer.start'); }
function deltas(events: ServerEvent[]) { return events.filter(event => event.type === 'answer.delta'); }
function timings(events: ServerEvent[]) { return events.filter(event => event.type === 'answer.timing'); }

test('normalization preserves technical symbols, case, negation and word boundaries', () => {
  assert.equal(normalizeAnswerQuestion('  如何\n 优化？ '), normalizeAnswerQuestion('如何 优化'));
  assert.notEqual(normalizeAnswerQuestion('C++'), normalizeAnswerQuestion('C#'));
  assert.notEqual(normalizeAnswerQuestion('a b'), normalizeAnswerQuestion('ab'));
  assert.notEqual(normalizeAnswerQuestion('Variable'), normalizeAnswerQuestion('variable'));
  assert.notEqual(normalizeAnswerQuestion('允许并发吗'), normalizeAnswerQuestion('不允许并发吗'));
});

test('fresh streams preserve order and report measured model and commit timing independently', async () => {
  const { pipeline, events, remembered } = fixture(async function* () {
    await delay(15); yield '结论'; yield '，依据';
  });
  await pipeline.commit('fresh', '如何优化？');
  assert.deepEqual(events.map(event => event.type), [
    'answer.start', 'status', 'answer.timing', 'answer.delta', 'answer.delta', 'answer.done', 'status',
  ]);
  assert.equal(starts(events)[0]?.source, 'fresh');
  assert.equal(timings(events)[0]?.source, 'fresh');
  assert.ok(timings(events)[0]!.requestToFirstTokenMs >= 10);
  assert.ok(timings(events)[0]!.questionCommitToFirstTokenMs >= 10);
  assert.equal(events.find(event => event.type === 'answer.done')?.latencyMs, timings(events)[0]?.requestToFirstTokenMs);
  assert.deepEqual(remembered, ['结论，依据']);
  pipeline.dispose();
});

test('a prepared answer stays private, then exact commit flushes buffered tokens and continues streaming', async () => {
  const buffered = deferred(); const finish = deferred();
  let requests = 0;
  const { pipeline, events } = fixture(async function* () {
    requests++; await delay(20); yield '先给结论'; buffered.resolve();
    await finish.promise; yield '，然后说明依据';
  });
  pipeline.prepare('utterance', '如何优化', 'same-context');
  await buffered.promise;
  assert.deepEqual(events, []);
  pipeline.prepare('utterance', '如何优化？', 'same-context');
  assert.equal(requests, 1);
  const committed = pipeline.commit('question', '如何优化？', { itemId: 'utterance', contextKey: 'same-context' });
  assert.equal(starts(events)[0]?.source, 'prepared');
  assert.deepEqual(deltas(events).map(event => event.text), ['先给结论']);
  assert.ok(timings(events)[0]!.requestToFirstTokenMs >= 15);
  assert.ok(timings(events)[0]!.questionCommitToFirstTokenMs < 200);
  finish.resolve(); await committed;
  assert.deepEqual(deltas(events).map(event => event.text), ['先给结论', '，然后说明依据']);
  assert.equal(events.filter(event => event.type === 'answer.done').length, 1);
  pipeline.dispose();
});

test('a fully prepared answer completes only after exact commit and is then cacheable', async () => {
  let requests = 0;
  const { pipeline, events, remembered } = fixture(async function* () { requests++; yield '完整回答'; });
  pipeline.prepare('item', '为什么？', 'context');
  await delay(0);
  assert.deepEqual(events, []); assert.deepEqual(remembered, []);
  await pipeline.commit('one', '为什么', { itemId: 'item', contextKey: 'context' });
  await pipeline.commit('two', '为什么？', { contextKey: 'context' });
  assert.equal(requests, 1);
  assert.deepEqual(starts(events).map(event => event.source), ['prepared', 'cache']);
  assert.deepEqual(remembered, ['完整回答', '完整回答']);
  pipeline.dispose();
});

test('ASR corrections cancel stale preparation, including providers that ignore cancellation', async () => {
  const oldBuffered = deferred(); const releaseOld = deferred();
  const signals: AbortSignal[] = [];
  const { pipeline, events } = fixture(async function* (question, _profile, signal) {
    signals.push(signal);
    if (question === '允许并发吗') {
      yield '过时的肯定回答'; oldBuffered.resolve(); await releaseOld.promise; yield '旧答案尾部';
    } else yield '修正后的否定回答';
  });
  pipeline.prepare('item', '允许并发吗'); await oldBuffered.promise;
  pipeline.invalidatePrepared('item');
  assert.equal(signals[0]?.aborted, true);
  pipeline.prepare('item', '不允许并发吗');
  await pipeline.commit('corrected', '不允许并发吗', { itemId: 'item' });
  releaseOld.resolve(); await delay(0);
  assert.deepEqual(deltas(events).map(event => event.text), ['修正后的否定回答']);
  assert.equal(events.filter(event => event.type === 'answer.done').length, 1);
  assert.equal(events.some(event => event.type === 'error'), false);
  pipeline.dispose();
});

test('different context or utterance identity cannot promote a prepared request', async () => {
  let requests = 0;
  const { pipeline, events } = fixture(async function* () { requests++; yield String(requests); });
  pipeline.prepare('first', '为什么？', 'context-A'); await delay(0);
  await pipeline.commit('context-change', '为什么？', { itemId: 'first', contextKey: 'context-B' });
  pipeline.prepare('second', '怎么做？', 'context-B'); await delay(0);
  await pipeline.commit('item-change', '怎么做？', { itemId: 'third', contextKey: 'context-B' });
  assert.equal(requests, 4);
  assert.deepEqual(starts(events).map(event => event.source), ['fresh', 'fresh']);
  assert.deepEqual(deltas(events).map(event => event.text), ['2', '4']);
  pipeline.dispose();
});

test('exact session cache returns under 200 ms in-process and retains original model TTFT', async () => {
  let requests = 0;
  const { pipeline, events } = fixture(async function* () { requests++; await delay(20); yield '已完成的真实来源回答'; });
  await pipeline.commit('original', '如何设计？', { contextKey: 'context' });
  const began = performance.now();
  await pipeline.commit('cached', '如何设计', { contextKey: 'context' });
  assert.ok(performance.now() - began < 200, 'This measures server process cache delivery, not end-to-end audio latency.');
  assert.equal(requests, 1);
  const [original, cached] = timings(events);
  assert.equal(cached?.source, 'cache');
  assert.equal(cached?.requestToFirstTokenMs, original?.requestToFirstTokenMs);
  assert.ok(cached!.questionCommitToFirstTokenMs < 200);
  await pipeline.commit('different-context', '如何设计？', { contextKey: 'other-context' });
  assert.equal(requests, 2);
  assert.equal(starts(events).at(-1)?.source, 'fresh');
  pipeline.dispose();
});

test('regeneration bypasses both cached and prepared answers', async () => {
  let requests = 0;
  const { pipeline, events } = fixture(async function* () { requests++; yield `answer-${requests}`; });
  await pipeline.commit('original', '问题A');
  await pipeline.commit('regenerated', '问题A', { bypassCache: true });
  pipeline.prepare('item', '问题B'); await delay(0);
  await pipeline.commit('fresh-B', '问题B', { itemId: 'item', bypassCache: true });
  assert.equal(requests, 4);
  assert.deepEqual(starts(events).map(event => event.source), ['fresh', 'fresh', 'fresh']);
  assert.deepEqual(deltas(events).map(event => event.text), ['answer-1', 'answer-2', 'answer-4']);
  pipeline.dispose();
});

test('incomplete and failed answers never enter cache or emit done', async () => {
  let requests = 0;
  const { pipeline, events, remembered } = fixture(async function* () {
    requests++; yield '不完整'; throw new Error('LLM_INCOMPLETE_STREAM');
  });
  await pipeline.commit('first', '问题'); await pipeline.commit('retry', '问题');
  assert.equal(requests, 2);
  assert.equal(events.some(event => event.type === 'answer.done'), false);
  assert.deepEqual(events.filter(event => event.type === 'error').map(event => event.code), ['ANSWER_INCOMPLETE', 'ANSWER_INCOMPLETE']);
  assert.deepEqual(remembered, []);
  pipeline.dispose();
});

test('a failed speculative request is silent and final commit starts a fresh request', async () => {
  let requests = 0;
  const { pipeline, events } = fixture(async function* () {
    if (++requests === 1) throw new Error('provider-private-details');
    yield '重试成功';
  });
  pipeline.prepare('item', '问题'); await delay(0);
  assert.deepEqual(events, []);
  await pipeline.commit('final', '问题', { itemId: 'item' });
  assert.equal(requests, 2); assert.equal(starts(events)[0]?.source, 'fresh');
  assert.deepEqual(deltas(events).map(event => event.text), ['重试成功']);
  pipeline.dispose();
});

test('deadline settles even when a provider never resolves its next token or honors abort', async () => {
  let capturedSignal: AbortSignal | undefined;
  const { pipeline, events } = fixture((_question, _profile, signal) => {
    capturedSignal = signal;
    return { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<string>>(() => {}) }; } };
  }, { timeoutMs: 15 });
  const began = performance.now();
  await pipeline.commit('timeout', '问题');
  assert.ok(performance.now() - began < 200);
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(events.find(event => event.type === 'error')?.code, 'ANSWER_TIMEOUT');
  assert.equal(events.some(event => event.type === 'answer.done'), false);
  pipeline.dispose();
});

test('a newer commit discards old late tokens, done events and errors', async () => {
  const firstBuffered = deferred(); const releaseOld = deferred();
  const { pipeline, events } = fixture(async function* (question) {
    if (question === '旧问题') {
      yield '旧开头'; firstBuffered.resolve(); await releaseOld.promise; yield '过期尾部';
      throw new Error('late-provider-error');
    }
    yield '当前回答';
  });
  const old = pipeline.commit('old', '旧问题'); await firstBuffered.promise;
  await pipeline.commit('new', '新问题');
  releaseOld.resolve(); await old; await delay(0);
  assert.deepEqual(deltas(events).map(event => [event.questionId, event.text]), [['old', '旧开头'], ['new', '当前回答']]);
  assert.deepEqual(events.filter(event => event.type === 'answer.done').map(event => event.questionId), ['new']);
  assert.equal(events.some(event => event.type === 'error'), false);
  pipeline.dispose();
});

test('cancel clears preparation and active work; dispose also prevents future work', async () => {
  const reached = deferred(); const release = deferred();
  let requests = 0;
  const { pipeline, events } = fixture(async function* () {
    requests++; yield '首段'; reached.resolve(); await release.promise; yield '尾段';
  });
  pipeline.prepare('item', '问题'); await reached.promise;
  pipeline.cancel(); release.resolve(); await delay(0);
  assert.deepEqual(events, []);
  await pipeline.commit('fresh', '问题', { itemId: 'item' });
  assert.equal(starts(events)[0]?.source, 'fresh'); assert.equal(requests, 2);
  pipeline.dispose();
  const count = events.length;
  pipeline.prepare('ignored', '另一问题'); await pipeline.commit('ignored', '另一问题');
  assert.equal(requests, 2); assert.equal(events.length, count);
});

test('pause cancellation settles active work and a late provider rejection stays silent', async () => {
  const reached = deferred(); const release = deferred();
  const { pipeline, events } = fixture(async function* () {
    yield 'first'; reached.resolve(); await release.promise;
    throw new Error('late private provider failure');
  });
  const active = pipeline.commit('paused', '问题'); await reached.promise;
  pipeline.cancel();
  await active;
  const count = events.length;
  release.resolve(); await delay(0);
  assert.equal(events.length, count);
  assert.equal(events.some(event => event.type === 'answer.done' || event.type === 'error'), false);
  pipeline.dispose();
});

test('cache TTL expires and LRU capacity bounds session storage', async () => {
  let requests = 0;
  const { pipeline, events } = fixture(async function* () { requests++; yield 'answer'; }, { maxCacheEntries: 2 });
  await pipeline.commit('A', '问题A'); await pipeline.commit('B', '问题B');
  await pipeline.commit('A-hit', '问题A'); await pipeline.commit('C', '问题C');
  await pipeline.commit('B-evicted', '问题B');
  assert.equal(requests, 4);
  assert.deepEqual(starts(events).map(event => event.source), ['fresh', 'fresh', 'cache', 'fresh', 'fresh']);
  pipeline.dispose();
  const short = fixture(async function* () { requests++; yield 'answer'; }, { cacheTtlMs: 15 });
  await short.pipeline.commit('one', '问题'); await delay(20); await short.pipeline.commit('expired', '问题');
  assert.deepEqual(starts(short.events).map(event => event.source), ['fresh', 'fresh']);
  short.pipeline.dispose();
});

test('profile snapshots and source identity remain isolated between pipeline instances', async () => {
  const mutableProfile = { ...profile };
  const seenRoles: string[] = [];
  const events: ServerEvent[] = [];
  const pipeline = new AnswerPipeline({ source: async function* (_question, candidate) { seenRoles.push(candidate.role); yield candidate.role; },
    profile: mutableProfile, emit: event => events.push(event), timeoutMs: 1000 });
  mutableProfile.role = 'changed';
  await pipeline.commit('one', '问题'); await pipeline.commit('two', '问题');
  const other = fixture(async function* () { yield 'different source'; });
  await other.pipeline.commit('other', '问题');
  assert.deepEqual(seenRoles, ['工程师']);
  assert.equal(starts(other.events)[0]?.source, 'fresh');
  assert.deepEqual(deltas(other.events).map(event => event.text), ['different source']);
  pipeline.dispose(); other.pipeline.dispose();
});

test('oversized responses and whitespace-only responses are bounded failures without cache entries', async () => {
  for (const answer of ['x'.repeat(32001), '   ']) {
    let requests = 0;
    const { pipeline, events } = fixture(async function* () { requests++; yield answer; });
    await pipeline.commit('first', '问题'); await pipeline.commit('retry', '问题');
    assert.equal(requests, 2);
    assert.equal(events.some(event => event.type === 'answer.done'), false);
    assert.equal(events.filter(event => event.type === 'error' && event.code === 'ANSWER_FAILED').length, 2);
    if (answer.length > 32000) assert.equal(deltas(events).length, 0);
    pipeline.dispose();
  }
});
