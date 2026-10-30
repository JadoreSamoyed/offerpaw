import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { RealtimeTranscriber } from '../src/transcription.js';

test('Realtime adapter waits for configured session and reconciles transcription deltas by item id', async t => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(provider, 'listening');
  t.after(() => new Promise<void>(resolve => {
    for (const client of provider.clients) client.terminate();
    provider.close(() => resolve());
  }));
  const address = provider.address();
  assert.equal(typeof address, 'object');
  const port = typeof address === 'object' ? address.port : 0;
  const messages: Record<string, unknown>[] = [];
  let upstream: WebSocket | undefined;
  let auth = '';
  provider.on('connection', (ws, req) => {
    upstream = ws; auth = req.headers.authorization ?? '';
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      if (message.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated', session: { type: 'transcription' } }));
    });
  });
  const partials: string[] = [];
  const finals: string[] = [];
  let failures = 0;
  const transcriber = new RealtimeTranscriber(loadConfig({ ASR_WS_URL: `ws://127.0.0.1:${port}`, ASR_API_KEY: 'private', ASR_MODEL: 'test-asr' }), {
    partial: (_id, text) => { partials.push(text); }, final: (_id, text) => { finals.push(text); }, error: () => { failures++; },
  });
  t.after(() => transcriber.close());
  await transcriber.connect();
  assert.equal(auth, 'Bearer private');
  const update = messages[0] as { session: { type: string; audio: { input: { format: { rate: number }; turn_detection: unknown; transcription: { model: string } } } } };
  assert.equal(update.session.type, 'transcription');
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.equal(update.session.audio.input.transcription.model, 'test-asr');
  assert.equal(update.session.audio.input.turn_detection, null);
  transcriber.append(Buffer.alloc(4800));
  upstream?.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: '你会' }));
  upstream?.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: '怎么做？' }));
  upstream?.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '你会怎么做？' }));
  const deadline = Date.now() + 2000;
  while ((!finals.length || messages.length < 2) && Date.now() < deadline) await delay(5);
  assert.deepEqual(partials, ['你会', '你会怎么做？']);
  assert.deepEqual(finals, ['你会怎么做？']);
  assert.equal(messages[1]?.type, 'input_audio_buffer.append');
  transcriber.close();
  await delay(10);
  assert.equal(failures, 0);
});
