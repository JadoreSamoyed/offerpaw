import { Worker } from 'node:worker_threads';
import { extractResume } from './extract.js';
import { safeResumeError, type ResumeFormat } from './types.js';

process.once('message', (input: { bytes: Buffer; fileName: string; format: ResumeFormat }) => {
  // V8's heap limit excludes PDF decompression buffers. A separate, dependency-free
  // watchdog also checks total child RSS while the parser's event loop is busy.
  // This is a sampled limit; deployment/container memory caps remain the hard limit.
  const memoryWatchdog = new Worker(`
    setInterval(() => {
      if (process.memoryUsage.rss() > 256 * 1024 * 1024) process.kill(process.pid, 'SIGKILL');
    }, 25);
  `, { eval: true, execArgv: [] });
  memoryWatchdog.on('error', () => process.exit(1));
  memoryWatchdog.unref();
  void extractResume(Buffer.from(input.bytes), input.fileName, input.format)
    .then(result => process.send?.({ result }))
    .catch(error => process.send?.({ error: safeResumeError(error).code }))
    .finally(() => { void memoryWatchdog.terminate(); process.disconnect(); });
});
