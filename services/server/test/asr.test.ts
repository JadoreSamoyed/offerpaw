import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, asrConfigured } from '../src/config.js';
import { createTranscriber, LocalTranscriber, QwenTranscriber, RealtimeTranscriber, type TranscriptionCallbacks } from '../src/transcription.js';
import { Pcm24To16 } from '../src/asr/resample.js';
import type { SpeakerMetadata, VoiceProfile } from '../src/protocol.js';

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'condition was not reached');
}
async function fake(t: TestContext) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { server, url: `ws://127.0.0.1:${typeof address === 'object' ? address.port : 0}` };
}
function capture() {
  const partials: string[] = [], finals: string[] = [];
  let errors = 0;
  const callbacks: TranscriptionCallbacks = { partial: (_id, text) => partials.push(text), final: (_id, text) => finals.push(text), error: () => { errors++; } };
  return { callbacks, partials, finals, errors: () => errors };
}

test('provider defaults preserve OpenAI and configure local/Qwen independently', () => {
  const callbacks = capture().callbacks;
  const defaults = loadConfig({});
  assert.equal(defaults.ASR_PROVIDER, 'openai');
  assert.equal(defaults.ASR_TURN_DETECTION, 'client_vad');
  assert.ok(createTranscriber(defaults, callbacks) instanceof RealtimeTranscriber);
  assert.equal(asrConfigured(defaults), false);
  const local = loadConfig({ ASR_PROVIDER: 'local' });
  assert.equal(local.ASR_LOCAL_URL, 'ws://127.0.0.1:8765');
  assert.ok(createTranscriber(local, callbacks) instanceof LocalTranscriber);
  assert.equal(asrConfigured(local), true);
  const qwen = loadConfig({ ASR_PROVIDER: 'qwen', ASR_API_KEY: 'fake' });
  assert.equal(qwen.ASR_MODEL, 'qwen3-asr-flash-realtime');
  assert.equal(qwen.ASR_TURN_DETECTION, 'server_vad');
  assert.ok(createTranscriber(qwen, callbacks) instanceof QwenTranscriber);
  assert.equal(asrConfigured(qwen), true);
  assert.equal(asrConfigured(loadConfig({ ASR_PROVIDER: 'qwen' })), false);
});

test('production permits only loopback plaintext local ASR and still requires TLS for remote providers', () => {
  const env = { NODE_ENV: 'production', APP_ACCESS_TOKEN: 'x'.repeat(24), ASR_PROVIDER: 'local' };
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) assert.doesNotThrow(() => loadConfig({ ...env, ASR_LOCAL_URL: `ws://${host}:8765` }));
  for (const url of ['ws://192.168.1.2:8765', 'ws://localhost.evil.test', 'http://127.0.0.1:8765', 'ws://user:secret@localhost:8765']) {
    assert.throws(() => loadConfig({ ...env, ASR_LOCAL_URL: url }));
  }
  assert.doesNotThrow(() => loadConfig({ ...env, ASR_LOCAL_URL: 'wss://speech.example.com' }));
  assert.throws(() => loadConfig({ ...env, ASR_WS_URL: 'ws://127.0.0.1:9999' }));
});

test('local handshake, frame splitting, generation reset and reconnect isolate old transcripts', async t => {
  const { server, url } = await fake(t);
  const messages: Record<string, unknown>[] = [];
  const peers: WebSocket[] = [];
  server.on('connection', ws => {
    peers.push(ws);
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); messages.push(event);
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.ready', generation: event.generation }));
    });
  });
  const result = capture();
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url, ASR_LOCAL_TOKEN: 'local-test-token' }), result.callbacks);
  t.after(() => transcriber.close());
  await transcriber.connect();
  assert.equal(messages[0]?.type, 'session.start');
  assert.equal(messages[0]?.sampleRate, 24000);
  assert.equal(messages[0]?.token, 'local-test-token');
  transcriber.append(Buffer.alloc(48000));
  await eventually(() => messages.length === 3);
  assert.equal(Buffer.from(messages[1]?.audio as string, 'base64').length, 24000);
  assert.equal(messages[1]?.seq, 0); assert.equal(messages[2]?.seq, 1);
  peers[0]!.send(JSON.stringify({ type: 'transcript.partial', id: 'same', text: '旧问题', generation: 0 }));
  await eventually(() => result.partials.length === 1);
  transcriber.clear(); transcriber.append(Buffer.alloc(480));
  await eventually(() => messages.some(event => event.type === 'session.clear'));
  assert.equal(messages.length, 4, 'new audio waits for reset acknowledgement');
  peers[0]!.send(JSON.stringify({ type: 'transcript.final', id: 'same', text: '旧问题', generation: 0 }));
  peers[0]!.send(JSON.stringify({ type: 'session.ready', generation: 1 }));
  peers[0]!.send(JSON.stringify({ type: 'transcript.partial', id: 'same', text: '新问题', generation: 1 }));
  peers[0]!.send(JSON.stringify({ type: 'transcript.final', id: 'same', text: '新问题？', generation: 1 }));
  peers[0]!.send(JSON.stringify({ type: 'transcript.final', id: 'same', text: '新问题？', generation: 1 }));
  await eventually(() => result.finals.length === 1 && messages.length === 5);
  assert.deepEqual(result.finals, ['新问题？']);
  assert.equal(messages[4]?.seq, 0);
  transcriber.close();
  await transcriber.connect();
  assert.equal(peers.length, 2);
  transcriber.close();
  assert.equal(result.errors(), 0);
});

test('local voice metadata revisions, enrollment events and generations survive transport without being conflated', async t => {
  const { server, url } = await fake(t);
  const messages: Record<string, unknown>[] = [];
  let peer!: WebSocket;
  server.on('connection', ws => {
    peer = ws;
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); messages.push(event);
      if (event.type === 'session.start' || event.type === 'session.clear') {
        ws.send(JSON.stringify({ type: 'session.ready', generation: event.generation, speakerSupported: true }));
      }
    });
  });
  const profile: VoiceProfile = { version: 1, model: 'campplus-zh-v1', embedding: Array.from({ length: 192 }, (_, i) => i === 0 ? 1 : 0), voicedMs: 5000 };
  const partials: Array<SpeakerMetadata | undefined> = [];
  const finals: Array<SpeakerMetadata | undefined> = [];
  const enrolled: VoiceProfile[] = [];
  const failures: string[] = [];
  const capabilities: boolean[] = [];
  let connectionErrors = 0;
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url }), {
    partial: (_id, _text, metadata) => partials.push(metadata), final: (_id, _text, metadata) => finals.push(metadata),
    error: () => { connectionErrors++; }, speakerCapability: value => capabilities.push(value),
    enrolled: value => enrolled.push(value), enrollmentFailed: code => failures.push(code),
  }, { voiceProfile: profile, enrollSpeaker: true, requireSpeaker: true });
  t.after(() => transcriber.close());
  await transcriber.connect();
  assert.deepEqual(messages[0]?.voiceProfile, profile);
  assert.equal(messages[0]?.enrollSpeaker, true);
  assert.equal(transcriber.speakerSupported, true);
  assert.deepEqual(capabilities, [true]);
  const event = (message: Record<string, unknown>) => peer.send(JSON.stringify({ generation: 0, ...message }));
  event({ type: 'transcript.partial', id: 'same', text: '请讲一下你的项目', speaker: 'unknown', speakerSource: 'voice' });
  event({ type: 'transcript.partial', id: 'same', text: '请讲一下你的项目', speaker: 'interviewer', speakerSource: 'voice' });
  event({ type: 'transcript.partial', id: 'same', text: '请讲一下你的项目', speaker: 'interviewer', speakerSource: 'voice' });
  event({ type: 'transcript.final', id: 'same', text: '请讲一下你的项目', speaker: 'candidate', speakerSource: 'voice' });
  await eventually(() => finals.length === 1);
  assert.deepEqual(partials.map(value => value?.speaker), ['unknown', 'interviewer']);
  assert.equal(finals[0]?.speaker, 'candidate');
  transcriber.finishEnrollment!();
  await eventually(() => messages.some(value => value.type === 'speaker.enroll.finish'));
  event({ type: 'speaker.enrollment.failed', code: 'too_short' });
  await eventually(() => failures.length === 1);
  assert.deepEqual(failures, ['too_short']); assert.equal(connectionErrors, 0);
  event({ type: 'speaker.enrolled', profile: { ...profile, embedding: [1] } });
  await eventually(() => failures.length === 2);
  assert.equal(enrolled.length, 0);
  event({ type: 'speaker.enrolled', profile });
  await eventually(() => enrolled.length === 1);
  transcriber.cancelEnrollment!(); transcriber.clear();
  await eventually(() => messages.some(value => value.type === 'session.clear'));
  event({ type: 'speaker.enrolled', profile });
  event({ type: 'speaker.enrollment.failed', code: 'too_short' });
  event({ type: 'transcript.final', id: 'stale', text: '旧问题', speaker: 'interviewer', speakerSource: 'voice' });
  event({ type: 'transcript.final', generation: 1, id: 'fresh', text: '新问题', speaker: 'interviewer', speakerSource: 'voice' });
  await eventually(() => finals.length === 2);
  assert.equal(enrolled.length, 1); assert.equal(failures.length, 2);
  assert.equal(finals[1]?.speaker, 'interviewer');
  assert.equal(messages.find(value => value.type === 'speaker.enroll.cancel')?.generation, 0);
  assert.equal(connectionErrors, 0);
});

test('missing local speaker capability is explicit and cannot create automatic interviewer metadata', async t => {
  const { server, url } = await fake(t);
  let peer!: WebSocket;
  server.on('connection', ws => {
    peer = ws;
    ws.on('message', raw => {
      if (JSON.parse(raw.toString()).type === 'session.start') ws.send(JSON.stringify({ type: 'session.ready', generation: 0 }));
    });
  });
  const capabilities: boolean[] = [];
  const finals: Array<SpeakerMetadata | undefined> = [];
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url }), {
    partial() {}, final: (_id, _text, speaker) => finals.push(speaker), error: () => assert.fail('unsupported capability should leave manual transcription usable'),
    speakerCapability: supported => capabilities.push(supported),
  }, { requireSpeaker: true });
  t.after(() => transcriber.close());
  await transcriber.connect();
  assert.deepEqual(capabilities, [false]);
  peer.send(JSON.stringify({ type: 'transcript.final', generation: 0, id: 'q', text: '请介绍项目', speaker: 'interviewer', speakerSource: 'voice' }));
  await eventually(() => finals.length === 1);
  assert.deepEqual(finals[0], { speaker: 'unknown', speakerSource: 'unavailable' });
});

test('Qwen uses documented 16k protocol and replaces text/stash snapshots without duplication', async t => {
  const { server, url } = await fake(t);
  const messages: Record<string, any>[] = [], peers: WebSocket[] = [];
  let path = '', authorization = '';
  server.on('connection', (ws, req) => {
    peers.push(ws); path = req.url ?? ''; authorization = req.headers.authorization ?? '';
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); messages.push(event);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    });
  });
  const result = capture();
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'qwen', ASR_WS_URL: url, ASR_API_KEY: 'fake' }), result.callbacks);
  t.after(() => transcriber.close());
  await transcriber.connect();
  assert.equal(authorization, 'Bearer fake');
  assert.match(path, /model=qwen3-asr-flash-realtime/);
  assert.equal(messages[0]?.session.sample_rate, 16000);
  assert.equal(messages[0]?.session.input_audio_format, 'pcm');
  assert.equal(messages[0]?.session.input_audio_transcription.language, 'zh');
  assert.equal(messages[0]?.session.turn_detection.type, 'server_vad');
  assert.equal(typeof messages[0]?.event_id, 'string');
  transcriber.append(Buffer.alloc(4800));
  await eventually(() => messages.length === 2);
  assert.equal(Buffer.from(messages[1]?.audio, 'base64').length, 3200);
  const send = (text: string, stash: string) => peers[0]!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', item_id: 'q', text, stash }));
  send('', '怎么有话'); send('怎么', '优化系统'); send('怎么优化', '延迟？');
  peers[0]!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q', transcript: '怎么优化延迟？' }));
  await eventually(() => result.finals.length === 1);
  assert.deepEqual(result.partials, ['怎么有话', '怎么优化系统', '怎么优化延迟？']);
  assert.deepEqual(result.finals, ['怎么优化延迟？']);
  transcriber.clear(); transcriber.append(Buffer.alloc(4800));
  peers[0]!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: '必须丢弃' }));
  await eventually(() => peers.length === 2 && messages.length === 4);
  assert.equal(messages[2]?.type, 'session.update');
  assert.equal(messages[3]?.type, 'input_audio_buffer.append');
  assert.equal(messages.some(event => event.type === 'input_audio_buffer.clear'), false);
  assert.deepEqual(result.finals, ['怎么优化延迟？']);
  transcriber.clear(); transcriber.close(); await delay(10);
  assert.equal(result.errors(), 0);
});

test('rapid pause/resume waits for only the latest clear acknowledgement', async t => {
  const { server, url } = await fake(t);
  const messages: Record<string, unknown>[] = [];
  let peer: WebSocket | undefined;
  server.on('connection', ws => {
    peer = ws;
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); messages.push(event);
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.ready', generation: 0 }));
    });
  });
  const result = capture();
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url }), result.callbacks);
  t.after(() => transcriber.close());
  await transcriber.connect();
  transcriber.clear(); transcriber.append(Buffer.from([1, 0]));
  transcriber.clear(); transcriber.append(Buffer.from([2, 0]));
  await eventually(() => messages.length === 3);
  peer!.send(JSON.stringify({ type: 'session.ready', generation: 1 }));
  peer!.send(JSON.stringify({ type: 'transcript.final', id: 'stale', text: '旧问题', generation: 1 }));
  await delay(20);
  assert.equal(messages.length, 3, 'old acknowledgement cannot flush queued audio');
  peer!.send(JSON.stringify({ type: 'session.ready', generation: 2 }));
  peer!.send(JSON.stringify({ type: 'transcript.final', id: 'fresh', text: '新问题', generation: 2 }));
  await eventually(() => messages.length === 4 && result.finals.length === 1);
  assert.equal(messages[3]?.generation, 2);
  assert.equal(messages[3]?.seq, 0);
  assert.deepEqual(Buffer.from(messages[3]?.audio as string, 'base64'), Buffer.from([2, 0]));
  assert.deepEqual(result.finals, ['新问题']);
  assert.equal(result.errors(), 0);
});

test('24k to 16k conversion preserves chunk boundaries and rejects aliasing', () => {
  const tone = (frequency: number) => {
    const pcm = Buffer.alloc(48000);
    for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / 24000)), i * 2);
    return pcm;
  };
  const source = tone(1000), whole = new Pcm24To16().push(source), streaming = new Pcm24To16();
  const chunks: Buffer[] = [];
  for (let i = 0; i < source.length; i += 74) chunks.push(streaming.push(source.subarray(i, i + 74)));
  assert.deepEqual(Buffer.concat(chunks), whole);
  assert.equal(whole.length, 32000);
  const rms = (pcm: Buffer) => {
    let sum = 0;
    for (let i = 200; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    return Math.sqrt(sum / ((pcm.length - 200) / 2));
  };
  assert.ok(rms(whole) > 6500);
  assert.ok(rms(new Pcm24To16().push(tone(10000))) < 100, '10 kHz must not alias into 16 kHz audio');
  streaming.reset(); assert.deepEqual(streaming.push(source), whole);
});

test('provider failures are sanitized, pending close settles, and a new connection can recover', async t => {
  const { server, url } = await fake(t);
  const peers: WebSocket[] = [];
  server.on('connection', ws => peers.push(ws));
  const result = capture();
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url, ASR_CONNECT_TIMEOUT_MS: '1000' }), result.callbacks);
  t.after(() => transcriber.close());
  const pending = transcriber.connect();
  const rejected = assert.rejects(pending, /^Error: ASR_UNAVAILABLE$/);
  await eventually(() => peers.length === 1);
  peers[0]!.send(JSON.stringify({ type: 'error', message: 'secret-provider-details' }));
  await rejected;
  assert.equal(result.errors(), 0);
  const connecting = transcriber.connect();
  const cancelled = assert.rejects(connecting, /^Error: ASR_CLOSED$/);
  transcriber.close(); await cancelled;
  const previousPeer = peers.at(-1);
  const recovery = transcriber.connect();
  await eventually(() => peers.at(-1) !== previousPeer && peers.at(-1)?.readyState === 1);
  peers.at(-1)!.send(JSON.stringify({ type: 'session.ready' }));
  await recovery;
  peers.at(-1)!.send('[]');
  await eventually(() => result.errors() === 1);
  transcriber.close(); assert.equal(result.errors(), 1);
});

test('startup timeout and reset queue limits are bounded', async t => {
  const { server, url } = await fake(t);
  const peers: WebSocket[] = [];
  server.on('connection', ws => peers.push(ws));
  const result = capture();
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url, ASR_CONNECT_TIMEOUT_MS: '1000' }), result.callbacks);
  t.after(() => transcriber.close());
  await assert.rejects(transcriber.connect(), /^Error: ASR_UNAVAILABLE$/);
  const pending = transcriber.connect();
  await eventually(() => peers.length === 2);
  peers[1]!.send(JSON.stringify({ type: 'session.ready', generation: 0 })); await pending;
  transcriber.clear();
  transcriber.append(Buffer.alloc(48000)); transcriber.append(Buffer.alloc(48000));
  assert.doesNotThrow(() => transcriber.append(Buffer.alloc(2)), 'a reset longer than two seconds remains usable');
  assert.throws(() => transcriber.append(Buffer.alloc(3)), /INVALID_PCM/);
});

test('delayed local reset retains six seconds, reports overflow, and drains the latest audio without ending recognition', async t => {
  const { server, url } = await fake(t);
  const messages: Record<string, unknown>[] = [];
  let peer!: WebSocket;
  server.on('connection', ws => {
    peer = ws;
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString()); messages.push(event);
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.ready', generation: 0 }));
    });
  });
  let errors = 0, gaps = 0;
  const finals: string[] = [];
  const transcriber = createTranscriber(loadConfig({ ASR_PROVIDER: 'local', ASR_LOCAL_URL: url }), {
    partial() {}, final: (_id, text) => finals.push(text), error: () => { errors++; }, audioGap: () => { gaps++; },
  });
  t.after(() => transcriber.close());
  await transcriber.connect(); transcriber.clear();
  // Model a delayed acknowledgement while the microphone continues producing 100 ms frames.
  for (let i = 0; i < 100; i++) {
    const frame = Buffer.alloc(4800); frame.writeInt16LE(i);
    assert.doesNotThrow(() => transcriber.append(frame));
    if (i === 29) assert.equal(gaps, 0, 'three seconds of delay must be retained without a gap');
  }
  await eventually(() => messages.some(value => value.type === 'session.clear'));
  assert.equal(gaps, 1, 'only one visible gap warning per recovery window');
  assert.equal(messages.filter(value => value.type === 'audio.append').length, 0);
  peer.send(JSON.stringify({ type: 'session.ready', generation: 0 }));
  await delay(10);
  assert.equal(messages.filter(value => value.type === 'audio.append').length, 0, 'an old acknowledgement cannot drain new audio');
  peer.send(JSON.stringify({ type: 'session.ready', generation: 1 }));
  await eventually(() => messages.filter(value => value.type === 'audio.append').length === 60);
  const audio = messages.filter(value => value.type === 'audio.append');
  assert.deepEqual(audio.map(value => Buffer.from(value.audio as string, 'base64').readInt16LE()), Array.from({ length: 60 }, (_, i) => i + 40));
  assert.deepEqual(audio.map(value => value.seq), Array.from({ length: 60 }, (_, i) => i));
  assert.ok(audio.every(value => value.generation === 1));
  transcriber.append(Buffer.alloc(4800));
  await eventually(() => messages.filter(value => value.type === 'audio.append').length === 61);
  peer.send(JSON.stringify({ type: 'transcript.final', id: 'fresh', text: '恢复后记录', generation: 1 }));
  await eventually(() => finals.length === 1);
  assert.equal(errors, 0); assert.equal(gaps, 1);
});
