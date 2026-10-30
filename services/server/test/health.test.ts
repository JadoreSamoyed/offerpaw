import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createInterviewServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

async function healthServer(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', ...env }));
  const port = await server.listen();
  t.after(() => server.close());
  return `http://127.0.0.1:${port}/health`;
}

test('health reports text and voice configuration separately without exposing secrets', async t => {
  const llm = { LLM_API_KEY: 'private-llm-key', LLM_MODEL: 'test-llm' };
  const asr = { ASR_API_KEY: 'private-asr-key', ASR_MODEL: 'test-asr' };
  for (const [env, text, speech] of [[{}, false, false], [llm, true, false], [asr, false, true], [{ ...llm, ...asr }, true, true]] as const) {
    await t.test(`text=${text}, asr=${speech}`, async t => {
      const endpoint = await healthServer(t, { APP_ACCESS_TOKEN: 'private-access-token', ...env });
      const response = await fetch(endpoint);
      const body = await response.text();
      assert.deepEqual(JSON.parse(body).capabilities, { demo: true, text, live: text && speech, asrConfigured: speech, asrProvider: 'openai', pcmSampleRate: 24000 });
      for (const secret of [llm.LLM_API_KEY, asr.ASR_API_KEY, 'private-access-token']) assert.equal(body.includes(secret), false);
      assert.equal(body.includes('LLM_API_KEY'), false);
      assert.equal(body.includes('ASR_API_KEY'), false);
    });
  }
});

test('local web preview can read health across ports and preflight GET', async t => {
  const endpoint = await healthServer(t);
  for (const origin of ['http://localhost:8081', 'http://127.0.0.1:8081', 'http://[::1]:8081']) {
    const response = await fetch(endpoint, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Vary'), 'Origin');
    await response.arrayBuffer();
  }
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET');
});

test('unconfigured development CORS does not allow arbitrary or deceptive origins', async t => {
  const endpoint = await healthServer(t);
  for (const origin of ['https://untrusted.example', 'http://localhost.attacker.example:8081', 'null']) {
    const response = await fetch(endpoint, { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    await response.arrayBuffer();
  }
});

test('production health CORS only permits configured exact origins and no-origin probes still work', async t => {
  const endpoint = await healthServer(t, { NODE_ENV: 'production', APP_ACCESS_TOKEN: 'a'.repeat(32), ALLOWED_ORIGINS: 'https://app.example, https://other.example' });
  const allowed = await fetch(endpoint, { headers: { Origin: 'https://app.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  await allowed.arrayBuffer();
  const denied = await fetch(endpoint, { headers: { Origin: 'http://localhost:8081' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  await denied.arrayBuffer();
  const probe = await fetch(endpoint);
  assert.equal(probe.status, 200);
  assert.equal(probe.headers.get('Access-Control-Allow-Origin'), null);
  await probe.arrayBuffer();
  const noAllowlist = await healthServer(t, { NODE_ENV: 'production', APP_ACCESS_TOKEN: 'a'.repeat(32) });
  const blocked = await fetch(noAllowlist, { headers: { Origin: 'http://localhost:8081' } });
  assert.equal(blocked.status, 403);
  await blocked.arrayBuffer();
});

async function rejectedUpgrade(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.on('error', () => {}); // terminate below closes an incomplete handshake.
    socket.once('unexpected-response', (_request, response) => {
      response.resume(); socket.terminate(); resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => { socket.close(); reject(new Error('Disallowed Origin unexpectedly connected')); });
  });
}

test('WebSocket default origin policy rejects remote websites but accepts local preview and native clients', async t => {
  const health = await healthServer(t);
  const endpoint = health.replace('http:', 'ws:').replace('/health', '/session');
  assert.equal(await rejectedUpgrade(endpoint, 'https://untrusted.example'), 403);
  assert.equal(await rejectedUpgrade(endpoint, 'http://localhost.attacker.example:8081'), 403);
  for (const origin of ['http://localhost:8081', undefined]) {
    const socket = new WebSocket(endpoint, origin ? { origin } : {});
    await once(socket, 'open');
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close(); await once(socket, 'close');
  }
});

test('production WebSocket origin policy requires an exact explicit allowlist', async t => {
  const endpoint = (await healthServer(t, { NODE_ENV: 'production', APP_ACCESS_TOKEN: 'a'.repeat(32), ALLOWED_ORIGINS: 'https://app.example' })).replace('http:', 'ws:').replace('/health', '/session');
  assert.equal(await rejectedUpgrade(endpoint, 'http://localhost:8081'), 403);
  const socket = new WebSocket(endpoint, { origin: 'https://app.example' });
  await once(socket, 'open'); socket.close(); await once(socket, 'close');
  const noAllowlist = (await healthServer(t, { NODE_ENV: 'production', APP_ACCESS_TOKEN: 'a'.repeat(32) })).replace('http:', 'ws:').replace('/health', '/session');
  assert.equal(await rejectedUpgrade(noAllowlist, 'https://app.example'), 403);
});
