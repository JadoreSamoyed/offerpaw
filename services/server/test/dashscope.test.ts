import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { asrConfigured, loadConfig } from '../src/config.js';
import { DashscopeTranscriber } from '../src/asr/dashscope.js';
import { createTranscriber } from '../src/transcription.js';
import { Pcm24To16 } from '../src/asr/resample.js';
import type { TranscriptionCallbacks } from '../src/asr/types.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'condition was not reached');
}
async function fixture(t: TestContext, options: NodeJS.ProcessEnv = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const peers: WebSocket[] = [], commands: Record<string, any>[] = [], audio: Buffer[] = [];
  let authorization = '', endpoint = '';
  server.on('connection', (ws, req) => {
    peers.push(ws); authorization = req.headers.authorization ?? ''; endpoint = req.url ?? '';
    ws.on('message', (raw, binary) => {
      if (binary) audio.push(Buffer.from(raw as Buffer));
      else commands.push(JSON.parse(raw.toString()));
    });
  });
  const partials: { id: string; text: string }[] = [], finals: { id: string; text: string }[] = [];
  let errors = 0;
  const callbacks: TranscriptionCallbacks = {
    partial: (id, text) => partials.push({ id, text }), final: (id, text) => finals.push({ id, text }), error: () => { errors++; },
  };
  const transcriber = createTranscriber(loadConfig({
    ASR_PROVIDER: 'dashscope', ASR_WS_URL: `ws://127.0.0.1:${typeof address === 'object' ? address.port : 0}`,
    ASR_API_KEY: 'fake-dashscope-key', ...options,
  }), callbacks);
  assert.ok(transcriber instanceof DashscopeTranscriber);
  t.after(async () => {
    transcriber.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const send = (event: string, payload: Record<string, unknown> = {}, taskId = commands.at(-1)?.header.task_id) => {
    peers.at(-1)!.send(JSON.stringify({ header: { event, task_id: taskId }, payload }));
  };
  const start = async () => {
    const count = commands.length;
    const promise = transcriber.connect();
    await eventually(() => commands.length > count);
    send('task-started'); await promise;
    return commands.at(-1)!.header.task_id as string;
  };
  return { transcriber, peers, commands, audio, partials, finals, send, start, errors: () => errors, authorization: () => authorization, endpoint: () => endpoint };
}
const sentence = (text: string, final = false, id = 1) => ({ output: { sentence: { text, sentence_end: final, sentence_id: id } } });

test('DashScope configuration selects the new task endpoint without changing existing providers', () => {
  const config = loadConfig({ ASR_PROVIDER: 'dashscope', ASR_API_KEY: 'fake' });
  assert.equal(config.ASR_MODEL, 'qwen-audio-3.1-asr-flash-streaming');
  assert.equal(config.ASR_WS_URL, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  assert.equal(config.ASR_TURN_DETECTION, 'server_vad');
  assert.equal(config.ASR_DASHSCOPE_VAD_MODEL, 'near_meeting_16k');
  assert.equal(asrConfigured(config), true);
  assert.equal(asrConfigured(loadConfig({ ASR_PROVIDER: 'dashscope' })), false);
  assert.throws(() => loadConfig({ ASR_PROVIDER: 'dashscope', ASR_TURN_DETECTION: 'client_vad' }), /server_vad/);
  assert.throws(() => loadConfig({ ASR_PROVIDER: 'dashscope', ASR_DASHSCOPE_VAD_MODEL: 'unknown' }), /ASR_DASHSCOPE_VAD_MODEL/);
  assert.equal(loadConfig({}).ASR_PROVIDER, 'openai');
  assert.equal(loadConfig({ ASR_PROVIDER: 'qwen' }).ASR_MODEL, 'qwen3-asr-flash-realtime');
  assert.equal(asrConfigured(loadConfig({ ASR_PROVIDER: 'local' })), true);
});

test('DashScope waits for matching task-started then sends resampled binary PCM with bilingual hints', async t => {
  const f = await fixture(t, { ASR_TRANSCRIPTION_OPTIONS: JSON.stringify({ vocabulary: { Transformer: 5 }, format: 'wav', sample_rate: 24000 }) });
  const connecting = f.transcriber.connect();
  await eventually(() => f.commands.length === 1);
  const command = f.commands[0]!;
  assert.equal(f.authorization(), 'Bearer fake-dashscope-key');
  assert.equal(f.endpoint(), '/', 'model belongs in run-task, not a Realtime query parameter');
  assert.deepEqual(command.header, { action: 'run-task', task_id: command.header.task_id, streaming: 'duplex' });
  assert.match(command.header.task_id, /^[a-f0-9-]{36}$/);
  assert.equal(command.payload.model, 'qwen-audio-3.1-asr-flash-streaming');
  assert.equal(command.payload.task_group, 'audio');
  assert.equal(command.payload.task, 'asr');
  assert.equal(command.payload.function, 'recognition');
  assert.deepEqual(command.payload.input, {});
  assert.deepEqual(command.payload.parameters, {
    vocabulary: { Transformer: 5 }, format: 'pcm', sample_rate: 16000,
    language_hints: ['zh', 'en'], vad_model: 'near_meeting_16k', heartbeat: true,
  });
  assert.throws(() => f.transcriber.append(Buffer.alloc(4800)), /ASR_NOT_READY/);
  f.send('task-started', {}, 'stale-task');
  await delay(10);
  assert.throws(() => f.transcriber.append(Buffer.alloc(4800)), /ASR_NOT_READY/);
  f.send('task-started'); await connecting;
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 10)), i * 2);
  f.transcriber.append(pcm);
  await eventually(() => f.audio.length === 1);
  assert.equal(f.audio[0]!.length, 3200);
  assert.deepEqual(f.audio[0], new Pcm24To16().push(pcm));
  assert.equal(f.commands.length, 1, 'audio must not be a base64 JSON event');
});

test('DashScope replaces partial snapshots, ignores heartbeats and emits each sentence final once', async t => {
  const f = await fixture(t);
  const taskId = await f.start();
  f.send('result-generated', { output: { sentence: { heartbeat: true, sentence_id: 0 } } });
  f.send('result-generated', sentence('什么是穿梭'));
  f.send('result-generated', sentence('什么是 Transformer'));
  f.send('result-generated', sentence('什么是 Transformer'));
  f.send('result-generated', sentence('什么是 Transformer？', true));
  f.send('result-generated', sentence('重复的最终结果', true));
  f.send('result-generated', sentence('迟到的中间结果'));
  f.send('result-generated', sentence('Redis 如何持久化？', true, 2));
  await eventually(() => f.finals.length === 2);
  assert.deepEqual(f.partials.map(item => item.text), ['什么是穿梭', '什么是 Transformer']);
  assert.deepEqual(f.finals, [
    { id: `${taskId}:1`, text: '什么是 Transformer？' }, { id: `${taskId}:2`, text: 'Redis 如何持久化？' },
  ]);
  assert.equal(f.errors(), 0);
});

test('DashScope clear creates a new task, queues fresh audio and ignores old generation events', async t => {
  const f = await fixture(t);
  const oldId = await f.start();
  f.send('result-generated', sentence('旧问题', true));
  await eventually(() => f.finals.length === 1);
  f.transcriber.clear(); f.transcriber.append(Buffer.alloc(4800));
  await eventually(() => f.commands.length === 2);
  const freshId = f.commands[1]!.header.task_id;
  assert.notEqual(freshId, oldId);
  f.send('task-started', {}, oldId);
  f.send('task-failed', {}, oldId);
  f.send('result-generated', sentence('必须丢弃', true), oldId);
  await delay(15);
  assert.equal(f.audio.length, 0);
  assert.equal(f.errors(), 0);
  f.send('task-started', {}, freshId);
  await eventually(() => f.audio.length === 1);
  f.send('result-generated', sentence('新问题', true), freshId);
  await eventually(() => f.finals.length === 2);
  assert.deepEqual(f.finals.map(item => item.text), ['旧问题', '新问题']);
  assert.notEqual(f.finals[0]!.id, f.finals[1]!.id);
  f.transcriber.clear(); f.transcriber.close(); await delay(10);
  assert.equal(f.errors(), 0, 'intentional close must not report a provider error');
});

test('DashScope startup failures reject with sanitized errors and allow reconnect', async t => {
  const f = await fixture(t);
  const connecting = f.transcriber.connect();
  const rejected = assert.rejects(connecting, /^Error: ASR_UNAVAILABLE$/);
  await eventually(() => f.commands.length === 1);
  f.send('task-failed', { message: 'private-provider-debug-data' });
  await rejected;
  assert.equal(f.errors(), 0);
  await f.start();
  f.send('task-failed', { message: 'private-provider-debug-data' });
  await eventually(() => f.errors() === 1);
});

test('DashScope treats unexpected task completion and malformed transcripts as unavailable', async t => {
  const f = await fixture(t);
  await f.start();
  f.send('task-finished');
  await eventually(() => f.errors() === 1);
  await f.start();
  f.send('result-generated', { output: { sentence: { sentence_id: 1, text: { unsafe: true }, sentence_end: true } } });
  await eventually(() => f.errors() === 2);
  assert.deepEqual(f.finals, []);
});

test('DashScope startup acknowledgement is bounded by the configured timeout', async t => {
  const f = await fixture(t, { ASR_CONNECT_TIMEOUT_MS: '1000' });
  await assert.rejects(f.transcriber.connect(), /^Error: ASR_UNAVAILABLE$/);
  assert.equal(f.errors(), 0);
});
