import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function demoEnvironment(input = process.env, platform = process.platform) {
  const environment = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) environment[platform === 'win32' ? key.toUpperCase() : key] = value;
  }
  return {
    ...environment,
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '8787',
    APP_ACCESS_TOKEN: '',
    ALLOWED_ORIGINS: 'http://localhost:8081,http://127.0.0.1:8081',
    LLM_API_KEY: '', LLM_MODEL: '', LLM_BASE_URL: 'http://127.0.0.1:9',
    LLM_THINKING: 'default', LLM_TOKEN_PARAMETER: 'max_tokens',
    ASR_PROVIDER: 'openai', ASR_API_KEY: '', ASR_MODEL: '',
    ASR_WS_URL: 'ws://127.0.0.1:9', ASR_TURN_DETECTION: 'client_vad',
    ASR_TRANSCRIPTION_OPTIONS: '{}', ASR_LOCAL_TOKEN: '',
    EXPO_PUBLIC_API_URL: 'http://127.0.0.1:8787',
    EXPO_PUBLIC_DEMO_ONLY: '1',
  };
}

export function runDemo() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Start the demo with npm run demo.');
  const child = spawn(process.execPath, [npmCli, 'run', 'dev'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: demoEnvironment(), stdio: 'inherit', windowsHide: true,
  });
  child.on('error', () => { console.error('Unable to start the local demo.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDemo();
