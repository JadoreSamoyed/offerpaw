import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenMatches } from '../auth.js';
import { resumeFileName } from './extract.js';
import { extractInWorker } from './isolate.js';
import { MAX_RESUME_BYTES, ResumeError, safeResumeError } from './types.js';

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: ResumeError) => {
      clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error) { req.pause(); chunks.length = 0; reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESUME_BYTES) finish(new ResumeError('too_large'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new ResumeError('cancelled'));
    const onAbort = () => finish(new ResumeError('cancelled'));
    const timer = setTimeout(() => finish(new ResumeError('timeout')), 15000);
    timer.unref();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function createResumeHandler(accessToken: string, originAllowed: (origin: string) => boolean) {
  const active = new Set<AbortController>();
  return {
    close: () => { for (const controller of active) controller.abort(); },
    handle: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      let controller: AbortController | undefined;
      const abort = () => { if (!res.writableEnded) controller?.abort(); };
      try {
        res.setHeader('Vary', 'Origin');
        if (req.headers.origin) {
          if (!originAllowed(req.headers.origin)) throw new ResumeError('origin_denied');
          res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        }
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'POST');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Resume-Name');
          res.setHeader('Access-Control-Max-Age', '600');
          res.writeHead(204); res.end(); return;
        }
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); throw new ResumeError('method_not_allowed'); }
        const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (!tokenMatches(accessToken, bearer)) throw new ResumeError('unauthorized');
        if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream'
          || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw new ResumeError('invalid_body');
        const { fileName, format } = resumeFileName(req.headers['x-resume-name']);
        if (Number(req.headers['content-length']) > MAX_RESUME_BYTES) throw new ResumeError('too_large');
        if (active.size >= 2) { res.setHeader('Retry-After', '2'); throw new ResumeError('busy'); }
        controller = new AbortController(); active.add(controller);
        req.once('aborted', abort); res.once('close', abort);
        const bytes = await readBody(req, controller.signal);
        const result = await extractInWorker(bytes, fileName, format, controller.signal);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        const safe = safeResumeError(error);
        if (!req.complete) res.setHeader('Connection', 'close');
        res.writeHead(safe.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
      } finally {
        req.off('aborted', abort); res.off('close', abort);
        if (controller) active.delete(controller);
      }
    },
  };
}
