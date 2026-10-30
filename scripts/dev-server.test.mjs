import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { apiCommand, asrCommand, developmentConfig, DevelopmentServer, portListening, probeAsr, terminateTree } from './dev-server.mjs';

function workspace(t, env = '') {
  const root = mkdtempSync(join(tmpdir(), 'interview development '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'services/server'), { recursive: true });
  mkdirSync(join(root, 'services/asr-local'), { recursive: true });
  writeFileSync(join(root, 'services/server/.env'), env);
  writeFileSync(join(root, 'services/asr-local/model.json'), JSON.stringify({ name: 'synthetic-model' }));
  return root;
}

function configuration(t, env = {}) {
  return developmentConfig(workspace(t), { ASR_PROVIDER: 'local', npm_execpath: 'C:/Program Files/node/npm-cli.js', ...env }, 'win32');
}

function harness(config, overrides = {}) {
  const spawned = [];
  const stopped = [];
  const messages = [];
  let nextPid = 8000;
  const options = {
    platform: 'win32', exists: () => true,
    probe: async () => ({ ready: spawned.some(item => item.kind === 'asr' && !item.child.exited) }),
    listening: async () => false,
    log: message => messages.push(message),
    readinessTimeoutMs: 200, probeIntervalMs: 2, restartDelaysMs: [2, 3],
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.exited = false;
      child.exit = (code = 1) => { child.exited = true; child.emit('exit', code); };
      spawned.push({ command, args, options, child, kind: args.includes('--model-dir') ? 'asr' : 'api' });
      return child;
    },
    async terminate(child) { stopped.push(child.pid); child.exit(0); },
    ...overrides,
  };
  const server = new DevelopmentServer(config, options);
  return { server, spawned, stopped, messages };
}

async function eventually(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await sleep(2);
  assert.equal(predicate(), true);
}

test('server .env is loaded relative to the project and shell values win without mutating them', t => {
  const root = workspace(t, 'ASR_PROVIDER=local\nASR_LOCAL_URL=ws://localhost:9876/asr\nASR_LOCAL_TOKEN=file-test-token\nLOCAL_ASR_TOKEN=old-test-token\n');
  const input = { ASR_LOCAL_TOKEN: 'override-test-token' };
  const config = developmentConfig(root, input, 'win32');
  assert.deepEqual(input, { ASR_LOCAL_TOKEN: 'override-test-token' });
  assert.equal(config.asr.host, '127.0.0.1');
  assert.equal(config.asr.port, 9876);
  assert.equal(config.env.ASR_LOCAL_URL, 'ws://127.0.0.1:9876/asr');
  const command = asrCommand(config, () => true);
  assert.equal(command.env.LOCAL_ASR_TOKEN, input.ASR_LOCAL_TOKEN);
  assert.ok(command.command.includes('interview development '));
  assert.deepEqual(command.args.slice(-6), ['--host', '127.0.0.1', '--port', '9876', '--model-dir', config.asr.modelDir]);
});

test('non-local providers, remote endpoints and TLS proxies are externally managed', t => {
  const root = workspace(t);
  for (const env of [{}, { ASR_PROVIDER: 'qwen' },
    { ASR_PROVIDER: 'local', ASR_LOCAL_URL: 'ws://speech.example:8765' },
    { ASR_PROVIDER: 'local', ASR_LOCAL_URL: 'wss://localhost:9443' }]) {
    assert.equal(developmentConfig(root, env).asr, null);
  }
  const ipv6 = developmentConfig(root, { ASR_PROVIDER: 'local', ASR_LOCAL_URL: 'ws://[::1]:9876' });
  assert.equal(ipv6.asr.host, '::1');
  assert.equal(ipv6.asr.port, 9876);
});

test('Windows shell overrides are case-insensitive and produce no duplicate environment keys', t => {
  const root = workspace(t, 'ASR_PROVIDER=openai\nASR_LOCAL_TOKEN=file-value\nPath=file-path\n');
  const config = developmentConfig(root, { asr_provider: 'local', asr_local_token: 'shell-value', PATH: 'shell-path', npm_execpath: 'C:/Program Files/node/npm-cli.js' }, 'win32');
  assert.ok(config.asr);
  assert.equal(config.asr.token, 'shell-value');
  assert.equal(config.env.PATH, 'shell-path');
  assert.equal(Object.keys(config.env).filter(key => key.toUpperCase() === 'ASR_LOCAL_TOKEN').length, 1);
  assert.equal(apiCommand(config, process.execPath, () => true).args[0], 'C:/Program Files/node/npm-cli.js');
});

test('missing Python or model assets gives explicit setup instructions without running installers', t => {
  const config = configuration(t);
  for (const missing of [config.asr.python, join(config.asr.modelDir, 'tokens.txt')]) {
    assert.throws(() => asrCommand(config, path => path !== missing), /npm run asr:setup/);
  }
  const command = apiCommand(config, 'C:/Program Files/node/node.exe', () => true);
  assert.equal(command.command, 'C:/Program Files/node/node.exe');
  assert.deepEqual(command.args, ['C:/Program Files/node/npm-cli.js', 'run', 'dev', '-w', 'services/server']);
});

test('launcher accepts complete bilingual Paraformer assets and rejects incomplete transducers', t => {
  const config = configuration(t);
  const files = new Set(['tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx'].map(name => join(config.asr.modelDir, name)));
  files.add(config.asr.python);
  const exists = path => files.has(path);
  assert.equal(asrCommand(config, exists).command, config.asr.python);
  files.add(join(config.asr.modelDir, 'joiner.int8.onnx'));
  assert.throws(() => asrCommand(config, exists), /npm run asr:setup/);
  files.add(join(config.asr.modelDir, 'decoder.onnx'));
  assert.equal(asrCommand(config, exists).command, config.asr.python);
});

test('launcher validates every required model in a pinned multi-model bundle', t => {
  const root = workspace(t);
  const files = ['text/tokens.txt', 'text/encoder.int8.onnx', 'text/decoder.int8.onnx',
    'endpoint/tokens.txt', 'endpoint/encoder.int8.onnx', 'endpoint/decoder.onnx', 'endpoint/joiner.int8.onnx'];
  writeFileSync(join(root, 'services/asr-local/model.json'), JSON.stringify({ name: 'bilingual-bundle', files }));
  const config = developmentConfig(root, { ASR_PROVIDER: 'local' }, 'win32');
  assert.equal(asrCommand(config, () => true).command, config.asr.python);
  for (const file of files) {
    assert.throws(() => asrCommand(config, path => path !== join(config.asr.modelDir, file)), /npm run asr:setup/);
  }
});

test('readiness probe uses the local protocol and reports auth rejection without sending audio', async t => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(() => new Promise(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(resolve); }));
  const messages = [];
  wss.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    ws.send(JSON.stringify(message.token === 'test-only-token'
      ? { type: 'session.ready', sampleRate: 24000, generation: 0 }
      : { type: 'error', code: 'unauthorized' }));
  }));
  const asr = { endpoint: `ws://127.0.0.1:${wss.address().port}`, host: '127.0.0.1', port: wss.address().port, token: 'test-only-token' };
  assert.equal(await portListening(asr), true);
  assert.equal((await probeAsr(asr)).ready, true);
  assert.equal((await probeAsr({ ...asr, token: 'wrong' })).reason, 'unauthorized');
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.type === 'session.start' && message.sampleRate === 24000));
});

test('silent listener is not accepted as ASR, and a cancelled readiness probe settles promptly', async t => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(() => new Promise(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(resolve); }));
  const asr = { endpoint: `ws://127.0.0.1:${wss.address().port}` };
  assert.equal((await probeAsr(asr, { timeoutMs: 25 })).reason, 'timeout');
  const abort = new AbortController();
  const pending = probeAsr(asr, { signal: abort.signal });
  abort.abort();
  assert.equal((await pending).reason, 'cancelled');
});

test('existing healthy ASR is reused without installation checks and is never killed', async t => {
  const h = harness(configuration(t), { probe: async () => ({ ready: true }), exists: path => path.endsWith('npm-cli.js') });
  await h.server.start();
  assert.deepEqual(h.spawned.map(item => item.kind), ['api']);
  assert.equal(h.spawned[0].options.windowsHide, true);
  assert.equal(h.spawned[0].options.shell, undefined);
  await h.server.stop();
  assert.deepEqual(h.stopped, [h.spawned[0].child.pid]);
  assert.equal(await h.server.closed, 0);
});

test('occupied incompatible local port fails without spawning or killing any process', async t => {
  const h = harness(configuration(t), { listening: async () => true });
  await assert.rejects(h.server.start(), /端口已被占用/);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.stopped.length, 0);
  assert.equal(await h.server.closed, 1);
});

test('missing local installation stops before starting the API', async t => {
  const h = harness(configuration(t), { exists: () => false });
  await assert.rejects(h.server.start(), /npm run asr:setup/);
  assert.equal(h.spawned.length, 0);
  assert.equal(await h.server.closed, 1);
});

test('API waits for model readiness, then shutdown cleans up exactly the owned children', async t => {
  let ready = false;
  const h = harness(configuration(t), { probe: async () => ({ ready }) });
  const pending = h.server.start();
  await eventually(() => h.spawned.length === 1);
  assert.equal(h.spawned[0].kind, 'asr');
  ready = true;
  await pending;
  assert.deepEqual(h.spawned.map(item => item.kind), ['asr', 'api']);
  await Promise.all([h.server.stop(), h.server.stop()]);
  assert.deepEqual(h.stopped.sort(), h.spawned.map(item => item.child.pid).sort());
});

test('owned ASR restarts with a bounded retry budget, then closes the API after repeated crashes', async t => {
  const h = harness(configuration(t));
  await h.server.start();
  h.spawned[0].child.exit();
  await eventually(() => h.spawned.filter(item => item.kind === 'asr').length === 2 && !h.server.restarting);
  h.spawned[2].child.exit();
  await eventually(() => h.spawned.filter(item => item.kind === 'asr').length === 3 && !h.server.restarting);
  h.spawned[3].child.exit();
  assert.equal(await h.server.closed, 1);
  assert.equal(h.server.restartCount, 2);
  assert.deepEqual(h.stopped, [h.spawned[1].child.pid]);
});

test('shutdown during restart backoff cancels the next spawn', async t => {
  const h = harness(configuration(t), { restartDelaysMs: [100] });
  await h.server.start();
  h.spawned[0].child.exit();
  await eventually(() => h.server.restarting);
  await h.server.stop();
  await sleep(120);
  assert.equal(h.spawned.length, 2);
  assert.equal(await h.server.closed, 0);
});

test('API exit cleans up owned ASR and retains its exit code', async t => {
  const h = harness(configuration(t));
  await h.server.start();
  h.spawned[1].child.exit(7);
  assert.equal(await h.server.closed, 7);
  assert.deepEqual(h.stopped, [h.spawned[0].child.pid]);
});

test('abnormal API wrapper exit still cleans up its owned POSIX process group', async t => {
  const h = harness(configuration(t), { platform: 'linux' });
  await h.server.start();
  h.spawned[1].child.exit(1);
  assert.equal(await h.server.closed, 1);
  assert.deepEqual(h.stopped.sort(), h.spawned.map(item => item.child.pid).sort());
});

test('ASR startup timeout and cancellation clean up without starting the API', async t => {
  const h = harness(configuration(t), { readinessTimeoutMs: 15, probe: async () => ({ ready: false }) });
  await assert.rejects(h.server.start(), /未能就绪/);
  assert.deepEqual(h.spawned.map(item => item.kind), ['asr']);
  assert.deepEqual(h.stopped, [h.spawned[0].child.pid]);
  const cancelled = harness(configuration(t), { probe: async () => ({ ready: false }) });
  const starting = cancelled.server.start();
  const rejected = assert.rejects(starting);
  await eventually(() => cancelled.spawned.length === 1);
  await cancelled.server.stop();
  await rejected;
  assert.equal(await cancelled.server.closed, 0);
  assert.equal(cancelled.spawned.length, 1);
});

test('process-tree cleanup terminates a real owned helper and its descendant from a path with spaces', async t => {
  const root = workspace(t);
  const helper = join(root, 'owned helper.mjs');
  writeFileSync(helper, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
console.log(child.pid);
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [helper], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.exitCode === null && child.signalCode === null ? terminateTree(child) : undefined);
  const closed = once(child, 'exit');
  const [output] = await once(child.stdout, 'data');
  const descendantPid = Number(output.toString().trim());
  assert.ok(descendantPid > 0);
  await terminateTree(child);
  await closed;
  await eventually(() => {
    try { process.kill(descendantPid, 0); return false; } catch { return true; }
  });
});
