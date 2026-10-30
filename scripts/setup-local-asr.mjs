import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const command = windows ? 'powershell.exe' : 'sh';
const args = windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/setup-local-asr.ps1')]
  : [resolve(root, 'scripts/setup-local-asr.sh')];
const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Unable to launch local ASR runtime. See docs/asr-local.md.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
