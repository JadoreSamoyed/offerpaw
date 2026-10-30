import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { demoEnvironment } from './demo.mjs';
import { loadConfig } from '../services/server/src/config.ts';
import { createInterviewServer } from '../services/server/src/server.ts';

const server = createInterviewServer(loadConfig({ ...demoEnvironment({}), PORT: '0' }));
let socket;
try {
  const port = await server.listen();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await response.json();
  assert.equal(health.capabilities.demo, true);
  assert.equal(health.capabilities.text, false);
  assert.equal(health.capabilities.live, false);
  const result = await new Promise((resolve, reject) => {
    socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
    let answer = '';
    const timer = setTimeout(() => reject(new Error('Demo did not complete within 10 seconds.')), 10000);
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start', mode: 'demo',
      profile: { role: 'Demo developer', resume: '', jobDescription: '', language: 'en', answerStyle: 'concise' } })));
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.code || 'Demo error')); }
      if (event.type === 'answer.delta') answer += event.text;
      if (event.type === 'answer.done') { clearTimeout(timer); resolve(answer); }
    });
  });
  assert.ok(result.length > 30);
  console.log('PASS: local health and complete scripted WebSocket answer; live LLM and ASR disabled.');
} finally {
  socket?.terminate();
  await server.close();
}
