import test from 'node:test';
import assert from 'node:assert/strict';
import { demoEnvironment } from './demo.mjs';
import { developmentConfig } from './dev-server.mjs';

test('demo removes live provider credentials and forces a loopback-only backend', () => {
  const input = { LLM_API_KEY: 'fixture-key', LLM_MODEL: 'fixture-model', ASR_API_KEY: 'fixture-asr',
    ASR_MODEL: 'fixture-asr-model', ASR_PROVIDER: 'local', HOST: '0.0.0.0', APP_ACCESS_TOKEN: 'fixture-token' };
  const environment = demoEnvironment(input, 'linux');
  for (const key of ['LLM_API_KEY', 'LLM_MODEL', 'ASR_API_KEY', 'ASR_MODEL', 'APP_ACCESS_TOKEN']) assert.equal(environment[key], '');
  assert.equal(environment.HOST, '127.0.0.1');
  assert.equal(environment.EXPO_PUBLIC_DEMO_ONLY, '1');
  assert.equal(environment.ASR_PROVIDER, 'openai');
  assert.equal(developmentConfig(process.cwd(), environment, 'linux').asr, null);
  assert.equal(input.LLM_API_KEY, 'fixture-key');
});

test('Windows mixed-case inherited keys cannot restore live credentials', () => {
  const environment = demoEnvironment({ llm_api_key: 'fixture-secret', asr_provider: 'local', Path: 'fixture-path' }, 'win32');
  assert.equal(environment.LLM_API_KEY, '');
  assert.equal(environment.ASR_PROVIDER, 'openai');
  assert.equal(environment.PATH, 'fixture-path');
  assert.equal('llm_api_key' in environment, false);
});
