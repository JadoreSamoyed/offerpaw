import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isResumeErrorCode, ResumeError, type ExtractedResume, type ResumeFormat } from './types.js';

const require = createRequire(import.meta.url);
export function extractInWorker(bytes: Buffer, fileName: string, format: ResumeFormat, signal: AbortSignal, timeoutMs = 20000): Promise<ExtractedResume> {
  if (signal.aborted) return Promise.reject(new ResumeError('cancelled'));
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts');
    const url = new URL(source ? './worker.ts' : './worker.js', import.meta.url);
    // Native PDF dependencies can crash on Windows worker-thread teardown. A child process
    // isolates those failures as well as CPU work; compiled production code needs no tsx.
    const worker = fork(url, [], { serialization: 'advanced', windowsHide: true,
      execArgv: ['--max-old-space-size=128', '--max-semi-space-size=16', ...(source ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [])],
      // Parser output may contain document fragments. Discard it, including native diagnostics.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    let finished = false;
    const finish = (error?: ResumeError, result?: ExtractedResume) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      const complete = () => { if (error) reject(error); else resolve(result!); };
      if (worker.exitCode !== null || worker.signalCode !== null) complete();
      else { worker.once('exit', complete); worker.kill('SIGKILL'); }
    };
    const cancel = () => finish(new ResumeError('cancelled'));
    const timer = setTimeout(() => finish(new ResumeError('timeout')), timeoutMs);
    timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('message', (message: { result?: ExtractedResume; error?: unknown }) => {
      if (message.result) finish(undefined, message.result);
      else finish(new ResumeError(isResumeErrorCode(message.error) ? message.error : 'invalid_file'));
    });
    worker.once('error', () => finish(new ResumeError('document_too_complex')));
    worker.once('exit', (code, signal) => { if (!finished) finish(new ResumeError(code || signal ? 'document_too_complex' : 'invalid_file')); });
    if (signal.aborted) cancel();
    else worker.send({ bytes, fileName, format }, error => { if (error) finish(new ResumeError('invalid_file')); });
  });
}
