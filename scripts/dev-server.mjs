import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'dotenv';
import WebSocket from 'ws';

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Match dotenv's environment precedence without printing or mutating credentials. */
export function developmentConfig(root = rootDirectory, environment = process.env, platform = process.platform) {
  const envFile = join(root, 'services/server/.env');
  const env = {};
  for (const source of [existsSync(envFile) ? parse(readFileSync(envFile)) : {}, environment]) {
    for (const [key, value] of Object.entries(source)) {
      // Windows treats environment names case-insensitively, including in spawned children.
      if (value !== undefined) env[platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  if (env.ASR_PROVIDER !== 'local') return { root, env, asr: null };
  let endpoint;
  try { endpoint = new URL(env.ASR_LOCAL_URL || 'ws://127.0.0.1:8765'); }
  catch { throw new Error('ASR_LOCAL_URL 无效，请使用 ws://127.0.0.1:8765。'); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('ASR_LOCAL_URL 必须是无账号密码或片段的 WebSocket 地址。');
  }
  const host = endpoint.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  // The Python service is plain WebSocket; remote services and TLS proxies have their own lifecycle.
  if (!loopback || endpoint.protocol === 'wss:') return { root, env, asr: null };
  if (host === 'localhost') endpoint.hostname = '127.0.0.1';
  env.ASR_LOCAL_URL = endpoint.href;
  const model = JSON.parse(readFileSync(join(root, 'services/asr-local/model.json'), 'utf8'));
  return {
    root, env,
    asr: {
      endpoint: endpoint.href,
      host: endpoint.hostname.replace(/^\[|\]$/g, ''),
      port: Number(endpoint.port || 80),
      token: env.ASR_LOCAL_TOKEN || '',
      python: resolve(root, env.LOCAL_ASR_PYTHON || join('.cache/asr/venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')),
      modelDir: resolve(root, env.LOCAL_ASR_MODEL_DIR || join('.cache/asr', model.name)),
      modelFiles: env.LOCAL_ASR_MODEL_DIR ? undefined : model.files,
    },
  };
}

export function asrCommand(config, exists = existsSync) {
  const { root, env, asr } = config;
  const has = file => exists(join(asr.modelDir, file));
  const hybridFiles = ['text/tokens.txt', 'text/encoder.int8.onnx', 'text/decoder.int8.onnx',
    'endpoint/tokens.txt', 'endpoint/encoder.int8.onnx', 'endpoint/decoder.onnx', 'endpoint/joiner.int8.onnx'];
  const complete = asr.modelFiles?.length ? asr.modelFiles.every(has) : !has('encoder.int8.onnx') && has('text/encoder.int8.onnx')
    ? hybridFiles.every(has) : has('tokens.txt') && has('encoder.int8.onnx') &&
      ((has('decoder.onnx') && has('joiner.int8.onnx')) || (!has('joiner.int8.onnx') && has('decoder.int8.onnx')));
  if (!exists(asr.python) || !complete) {
    throw new Error('本地语音识别环境或模型尚未安装完整。请先运行 npm run asr:setup，完成后再运行 npm run server（或 npm run dev）。启动器不会自动下载。');
  }
  return {
    command: asr.python,
    args: ['-X', 'utf8', join(root, 'services/asr-local/server.py'), '--host', asr.host, '--port', String(asr.port), '--model-dir', asr.modelDir],
    env: { ...env, LOCAL_ASR_TOKEN: asr.token },
  };
}

export function apiCommand(config, executable = process.execPath, exists = existsSync) {
  const npmCli = [config.env.npm_execpath || config.env.NPM_EXECPATH, join(dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => path && exists(path));
  if (!npmCli) throw new Error('无法找到 npm CLI，请通过 npm run server 或 npm run dev 启动。');
  return { command: executable, args: [npmCli, 'run', 'dev', '-w', 'services/server'], env: config.env };
}

/** No audio or model-provider request: readiness requires the sidecar protocol acknowledgement. */
export function probeAsr(asr, { timeoutMs = 1500, signal } = {}) {
  return new Promise(resolveProbe => {
    let socket;
    let timer;
    let settled = false;
    const finish = (ready, reason = 'unavailable') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Keep the error listener attached: terminating an opening WebSocket can emit an error.
      socket?.terminate();
      resolveProbe({ ready, reason });
    };
    const cancel = () => finish(false, 'cancelled');
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      socket = new WebSocket(asr.endpoint, { handshakeTimeout: timeoutMs, maxPayload: 65536, perMessageDeflate: false });
      timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start', sampleRate: 24000, generation: 0,
        ...(asr.token ? { token: asr.token } : {}) })));
      socket.on('message', raw => {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === 'session.ready' && event.sampleRate === 24000 && event.generation === 0) finish(true, 'ready');
          else if (event.type === 'error') finish(false, event.code === 'unauthorized' ? 'unauthorized' : event.code === 'capacity' ? 'busy' : 'invalid');
        } catch { finish(false, 'invalid'); }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
    } catch { finish(false, 'invalid'); }
  });
}

export function portListening(asr, { timeoutMs = 750, signal } = {}) {
  return new Promise(resolveProbe => {
    if (signal?.aborted) { resolveProbe(false); return; }
    const socket = connect({ host: asr.host, port: asr.port });
    const finish = value => { signal?.removeEventListener('abort', cancel); socket.destroy(); resolveProbe(value); };
    const cancel = () => finish(false);
    signal?.addEventListener('abort', cancel, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** Only children created by this launcher are passed here; reused services are never owned. */
export async function terminateTree(child, platform = process.platform) {
  if (!child.pid) return;
  if (platform === 'win32') {
    await new Promise(resolveStop => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolveStop(); });
      killer.once('exit', resolveStop);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    // npm may exit before its watch subprocess. Check the whole owned process group.
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      try { process.kill(-child.pid, 0); } catch { return; }
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}

export class DevelopmentServer {
  constructor(config, options = {}) {
    this.config = config;
    this.options = {
      spawn, probe: probeAsr, listening: portListening, terminate: terminateTree,
      exists: existsSync, log: message => console.log(`[dev] ${message}`),
      readinessTimeoutMs: 60000, probeIntervalMs: 250, restartDelaysMs: [500, 1500, 4000],
      platform: process.platform, ...options,
    };
    this.children = new Set();
    this.abort = new AbortController();
    this.stopping = false;
    this.restartCount = 0;
    this.closed = new Promise(resolveClosed => { this.resolveClosed = resolveClosed; });
  }

  launch(spec) {
    if (this.stopping) throw new Error('启动已取消。');
    const child = this.options.spawn(spec.command, spec.args, { cwd: this.config.root, env: spec.env,
      stdio: 'inherit', windowsHide: true, detached: this.options.platform !== 'win32' });
    const entry = { child, exited: false };
    this.children.add(entry);
    entry.closed = new Promise(resolveClosed => {
      const finish = code => {
        if (entry.exited) return;
        entry.exited = true;
        this.children.delete(entry);
        resolveClosed(code);
      };
      child.once('error', () => finish(1));
      child.once('exit', code => finish(code ?? 1));
    });
    return entry;
  }

  async waitReady(entry) {
    const deadline = Date.now() + this.options.readinessTimeoutMs;
    while (!this.stopping && !entry.exited && Date.now() < deadline) {
      const result = await this.options.probe(this.config.asr, { signal: this.abort.signal, timeoutMs: 1000 });
      if (result.ready && !entry.exited && !this.stopping) return;
      if (result.reason === 'unauthorized') throw new Error('本地语音服务口令不匹配，请核对 ASR_LOCAL_TOKEN。');
      await Promise.race([entry.closed, sleep(this.options.probeIntervalMs, undefined, { signal: this.abort.signal })]);
    }
    throw new Error(this.stopping ? '启动已取消。' : '本地语音服务未能就绪，请检查上方运行日志；确认已完成 npm run asr:setup。');
  }

  async startOwnedAsr() {
    const entry = this.launch(asrCommand(this.config, this.options.exists));
    this.asr = entry;
    try { await this.waitReady(entry); }
    catch (error) {
      if (!entry.exited) await this.options.terminate(entry.child, this.options.platform);
      throw error;
    }
    entry.closed.then(() => {
      if (!this.stopping && this.asr === entry) void this.restartAsr();
    });
  }

  async restartAsr() {
    if (this.restarting || this.stopping) return;
    this.restarting = true;
    while (!this.stopping && this.restartCount < this.options.restartDelaysMs.length) {
      const delayMs = this.options.restartDelaysMs[this.restartCount++];
      this.options.log(`本地语音服务已退出，将在 ${delayMs} ms 后重启（${this.restartCount}/${this.options.restartDelaysMs.length}）。`);
      try {
        await sleep(delayMs, undefined, { signal: this.abort.signal });
        await this.startOwnedAsr();
        if (this.asr.exited) throw new Error('语音服务在就绪后退出。');
        this.restarting = false;
        this.options.log('本地语音服务已恢复，可重新开始面试。');
        return;
      } catch { /* Retry only the owned sidecar; never touch an externally managed service. */ }
    }
    this.restarting = false;
    if (!this.stopping) {
      this.options.log('本地语音服务连续退出，已停止开发服务。请检查日志后重新启动。');
      await this.stop(1);
    }
  }

  async start() {
    try {
      if (this.config.asr) {
        const result = await this.options.probe(this.config.asr, { signal: this.abort.signal });
        if (result.ready) this.options.log('已复用正在运行的本地语音识别服务。');
        else if (await this.options.listening(this.config.asr, { signal: this.abort.signal })) {
          throw new Error(result.reason === 'unauthorized'
            ? '本地语音端口已有服务，但 ASR_LOCAL_TOKEN 不匹配。请核对口令；现有进程保持运行。'
            : '本地语音端口已被占用，但服务未就绪或繁忙。请检查现有语音服务；启动器不会结束该进程。');
        } else {
          this.options.log('正在启动本地语音识别，等待模型就绪…');
          await this.startOwnedAsr();
          this.options.log('本地语音识别已就绪。');
        }
      }
      this.api = this.launch(apiCommand(this.config, process.execPath, this.options.exists));
      this.api.closed.then(code => { if (!this.stopping) void this.stop(code); });
    } catch (error) {
      await this.stop(1);
      throw error;
    }
  }

  stop(code = 0) {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.stopCode = code;
    this.abort.abort();
    this.stopTask = (async () => {
      const owned = [...this.children];
      // A crashed npm wrapper may leave its POSIX process group alive after its own exit.
      if (this.options.platform !== 'win32' && this.api?.exited) owned.push(this.api);
      await Promise.allSettled(owned.map(entry => this.options.terminate(entry.child, this.options.platform)));
      this.resolveClosed(code);
    })();
    return this.stopTask;
  }
}

async function main() {
  let server;
  try {
    server = new DevelopmentServer(developmentConfig());
    const interrupt = () => { void server.stop(0); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      await server.start();
      process.exitCode = await server.closed;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } catch (error) {
    if (server?.stopCode !== 0) console.error(`[dev] ${error instanceof Error ? error.message : '开发服务启动失败。'}`);
    process.exitCode = server?.stopCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
