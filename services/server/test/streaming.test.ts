import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SseParser } from '../src/sse.js';
import { AnswerCoordinator, liveAnswerSource } from '../src/answers.js';
import { loadConfig } from '../src/config.js';
import type { Profile, ServerEvent } from '../src/protocol.js';

const profile: Profile = { role: '工程师', resume: '', jobDescription: '', language: 'zh', answerStyle: 'concise' };

test('SSE handles chunk boundaries, CRLF, comments, multi-line data and a final frame', () => {
  const wire = ': heartbeat\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (let split = 1; split < wire.length; split++) {
    const parser = new SseParser();
    assert.deepEqual([...parser.push(wire.slice(0, split)), ...parser.push(wire.slice(split), true)], ['{"a":\n1}', '[DONE]']);
  }
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: final', true), ['final']);
  assert.throws(() => new SseParser().push(`data: ${'a'.repeat(140000)}`));
});

test('compatible provider parser preserves split UTF-8 Chinese tokens and sends server-side credentials', async () => {
  const wire = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\n\n');
  let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    request = init;
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const config = loadConfig({ LLM_API_KEY: 'server-only-secret', LLM_MODEL: 'test-model' });
  const source = liveAnswerSource(config, () => [], fetcher);
  const tokens: string[] = [];
  for await (const delta of source('请介绍你自己', profile, new AbortController().signal)) tokens.push(delta);
  assert.equal(tokens.join(''), '你好');
  assert.equal((request?.headers as Record<string, string>).Authorization, 'Bearer server-only-secret');
  assert.equal(JSON.parse(String(request?.body)).model, 'test-model');
  assert.deepEqual(Object.keys(JSON.parse(String(request?.body))).sort(), ['max_tokens', 'messages', 'model', 'stream']);
});

test('thinking is sent only for an explicit provider option and token parameter stays configurable', async () => {
  for (const thinking of ['enabled', 'disabled'] as const) {
    let payload: Record<string, unknown> | undefined;
    const source = liveAnswerSource(loadConfig({ LLM_THINKING: thinking, LLM_TOKEN_PARAMETER: 'max_completion_tokens', LLM_MAX_TOKENS: '700' }), () => [], async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
    });
    for await (const _ of source('question', profile, new AbortController().signal)) { /* consume */ }
    assert.deepEqual(payload?.thinking, { type: thinking });
    assert.equal(payload?.max_completion_tokens, 700);
    assert.equal(payload?.max_tokens, undefined);
  }
  assert.throws(() => loadConfig({ LLM_THINKING: 'invalid' }), /LLM_THINKING/);
});

test('provider reasoning deltas are never forwarded as the spoken interview answer', async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: 'private analysis', reasoning: 'private steps' } }] },
    { choices: [{ delta: { content: '我会先定位最慢的环节。', reasoning_content: 'more private analysis' } }] },
    { choices: [{ delta: { content: '再用相同负载验证优化结果。' }, finish_reason: 'stop' }] },
  ];
  const source = liveAnswerSource(loadConfig({ LLM_THINKING: 'disabled' }), () => [], async () =>
    new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')));
  const chunks: string[] = [];
  for await (const chunk of source('如何优化响应延迟？', profile, new AbortController().signal)) chunks.push(chunk);
  assert.deepEqual(chunks, ['我会先定位最慢的环节。', '再用相同负载验证优化结果。']);
});

test('truncated LLM stream fails rather than reporting an incomplete answer as complete', async () => {
  const source = liveAnswerSource(loadConfig(), () => [], async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  await assert.rejects(async () => { for await (const _ of source('why?', profile, new AbortController().signal)) { /* consume */ } }, /INCOMPLETE_STREAM/);
});

test('token-limited LLM answers emit a recoverable incomplete error even with a DONE marker', async () => {
  for (const tail of ['', 'data: [DONE]\n\n']) {
    const source = liveAnswerSource(loadConfig(), () => [], async () => new Response(`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n${tail}`));
    const events: ServerEvent[] = [];
    const remembered: string[] = [];
    const runner = new AnswerCoordinator(event => events.push(event), 2000, answer => remembered.push(answer));
    await runner.run('limited', 'question', profile, source);
    assert.equal(events.some(e => e.type === 'answer.delta' && e.text === 'partial'), true);
    assert.equal(events.some(e => e.type === 'error' && e.code === 'ANSWER_INCOMPLETE' && e.recoverable), true);
    assert.equal(events.some(e => e.type === 'answer.done'), false);
    assert.deepEqual(remembered, []);
  }
});

test('superseded generations cannot append stale tokens or done events', async () => {
  const events: ServerEvent[] = [];
  const runner = new AnswerCoordinator(event => events.push(event), 2000);
  const old = runner.run('old', 'first', profile, async function* () {
    yield 'first';
    await delay(40); // Simulate a provider that has not reacted to abort yet.
    yield 'stale';
  });
  await delay(5);
  await runner.run('new', 'second', profile, async function* () { yield 'current'; });
  await old;
  assert.deepEqual(events.filter(e => e.type === 'answer.delta').map(e => [e.questionId, e.text]), [['old', 'first'], ['new', 'current']]);
  assert.deepEqual(events.filter(e => e.type === 'answer.done').map(e => e.questionId), ['new']);
  assert.equal(events.filter(e => e.type === 'error').length, 0);
});

test('timeout aborts provider and emits a sanitized error', async () => {
  const events: ServerEvent[] = [];
  const runner = new AnswerCoordinator(event => events.push(event), 15);
  await runner.run('timeout', 'test', profile, async function* (_question, _profile, signal) {
    await delay(500, undefined, { signal }); yield 'never';
  });
  assert.equal(events.find(e => e.type === 'error')?.code, 'ANSWER_TIMEOUT');
  assert.equal(events.some(e => e.type === 'answer.done'), false);
});
