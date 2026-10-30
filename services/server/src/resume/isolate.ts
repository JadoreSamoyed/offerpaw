import { fork } from 'node:child_process';
import { isResumeErrorCode, PARSER_PHASES, ResumeError, type ExtractedResume, type ResumeFormat } from './types.js';

export function extractInWorker(bytes: Buffer, fileName: string, format: ResumeFormat, signal: AbortSignal, timeoutMs = 20000): Promise<ExtractedResume> {
  if (signal.aborted) return Promise.reject(new ResumeError('cancelled'));
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts');
    const url = new URL(source ? './worker-source.mjs' : './worker.js', import.meta.url);
    // Native PDF dependencies can crash on Windows worker-thread teardown. A child process
    // isolates those failures as well as CPU work; compiled production code needs no tsx.
    const worker = fork(url, [], { serialization: 'advanced', windowsHide: true,
      execArgv: ['--max-old-space-size=128', '--max-semi-space-size=16'],
      // Parser output may contain document fragments. Discard it, including native diagnostics.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'],
      env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    let diagnosticBuffer = '';
    let memory: { phase: string; rss: number; peak: number; limit: number; exceeded: boolean } | undefined;
    worker.stdio[4]?.on('data', (chunk: Buffer) => {
      diagnosticBuffer += chunk.toString('utf8');
      if (diagnosticBuffer.length > 4096) { diagnosticBuffer = ''; return; }
      let end;
      while ((end = diagnosticBuffer.indexOf('\n')) !== -1) {
        const line = diagnosticBuffer.slice(0, end); diagnosticBuffer = diagnosticBuffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (!Number.isInteger(value.stage) || !PARSER_PHASES[value.stage as number] || typeof value.exceeded !== 'boolean') continue;
          if (![value.rss, value.peak, value.limit].every(n => Number.isSafeInteger(n) && n >= 0)) continue;
          memory = { phase: PARSER_PHASES[value.stage as number]!, rss: value.rss, peak: value.peak, limit: value.limit, exceeded: value.exceeded };
        } catch { /* Ignore malformed diagnostics; never forward raw child bytes. */ }
      }
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
    let sent = false;
    worker.on('message', (message: { ready?: boolean; result?: ExtractedResume; error?: unknown }) => {
      if (finished) return;
      if (message.ready && !sent) {
        // The source bootstrap removes its temporary loader before accepting input.
        sent = true;
        worker.send({ bytes, fileName, format }, error => { if (error) finish(new ResumeError('invalid_file')); });
        return;
      }
      if (message.result) finish(undefined, message.result);
      else finish(new ResumeError(isResumeErrorCode(message.error) ? message.error : 'invalid_file'));
    });
    worker.once('error', () => finish(new ResumeError('document_too_complex')));
    // 'close' follows stdio drainage, so the watchdog's final sample is available.
    worker.once('close', (code, signal) => {
      if (finished) return;
      const error = new ResumeError(code || signal ? 'document_too_complex' : 'invalid_file');
      // Keep diagnostic metadata for direct callers/tests without exposing parser
      // stderr, filenames or document text. The HTTP route returns only code/message.
      error.cause = { stage: 'resume_parser_exit', exitCode: code, signal, memory };
      finish(error);
    });
    if (signal.aborted) cancel();
  });
}
