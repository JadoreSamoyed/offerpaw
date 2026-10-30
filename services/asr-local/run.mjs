import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(serviceDir, '../..');
const python = process.env.LOCAL_ASR_PYTHON || join(root, '.cache', 'asr', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('Local ASR Python environment is missing. Run scripts/setup-local-asr.ps1 (Windows) or sh scripts/setup-local-asr.sh first.');
  process.exitCode = 1;
} else {
  const child = spawn(python, ['-X', 'utf8', join(serviceDir, 'server.py'), ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(`Unable to start local ASR: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
