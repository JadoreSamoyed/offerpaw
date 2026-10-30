import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { extractResume } from './extract.js';
import { PARSER_PHASES, safeResumeError, type ResumeFormat } from './types.js';

export function startResumeWorker(): void {
  process.once('message', (input: { bytes: Buffer; fileName: string; format: ResumeFormat }) => {
    // V8's heap limit excludes PDF decompression buffers. A separate, dependency-free
    // watchdog also checks total child RSS while the parser's event loop is busy.
    // This is a sampled limit; deployment/container memory caps remain the hard limit.
    const phase = new Int32Array(new SharedArrayBuffer(4));
    const memoryWatchdog = new Worker(`
      const { writeSync } = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const phase = new Int32Array(workerData.phase);
      const limit = 256 * 1024 * 1024;
      let peak = 0, previous = -1;
      setInterval(() => {
        const rss = process.memoryUsage.rss();
        peak = Math.max(peak, rss);
        const stage = Atomics.load(phase, 0);
        if (stage !== previous || rss > limit) {
          // A dedicated inherited pipe remains writable while the parser event loop
          // is blocked. No parser output or document fields enter this channel.
          try { writeSync(4, JSON.stringify({ stage, rss, peak, limit, exceeded: rss > limit }) + '\\n'); } catch {}
          previous = stage;
        }
        if (rss > limit) process.kill(process.pid, 'SIGKILL');
      }, 25);
    `, { eval: true, execArgv: [], workerData: { phase: phase.buffer } });
    memoryWatchdog.on('error', () => process.exit(1));
    memoryWatchdog.unref();
    void extractResume(Buffer.from(input.bytes), input.fileName, input.format, value => Atomics.store(phase, 0, PARSER_PHASES.indexOf(value)))
      .then(result => process.send?.({ result }))
      .catch(error => process.send?.({ error: safeResumeError(error).code }))
      .finally(() => { void memoryWatchdog.terminate(); process.disconnect(); });
  });
  process.send?.({ ready: true });
}

// The source bootstrap calls this only after removing its temporary TS loader.
// Compiled production workers start directly and do not depend on tsx.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startResumeWorker();
