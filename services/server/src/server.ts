import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { asrConfigured, liveConfigured, textConfigured, type Config } from './config.js';
import { InterviewSession, type SessionDependencies } from './session.js';
import { createResumeHandler } from './resume/route.js';

export function createInterviewServer(config: Config, dependencies: SessionDependencies = {}) {
  const allowedOrigins = config.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  const browserOriginAllowed = (origin: string) => {
    if (allowedOrigins.length) return allowedOrigins.includes(origin);
    if (config.NODE_ENV === 'production') return false;
    try {
      const url = new URL(origin);
      return url.origin === origin && ['http:', 'https:'].includes(url.protocol)
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { return false; }
  };
  const resume = createResumeHandler(config.APP_ACCESS_TOKEN, browserOriginAllowed);
  const http = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/resume/extract') { void resume.handle(req, res); return; }
    if (req.url === '/health' && (req.method === 'GET' || req.method === 'OPTIONS')) {
      res.setHeader('Vary', 'Origin');
      if (req.headers.origin) {
        if (!browserOriginAllowed(req.headers.origin)) { res.writeHead(403); res.end(); return; }
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0', capabilities: { demo: true, text: textConfigured(config), live: liveConfigured(config), asrConfigured: asrConfigured(config), asrProvider: config.ASR_PROVIDER, pcmSampleRate: 24000 } }));
    } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 131072, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/session') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (wss.clients.size >= config.MAX_SESSIONS) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (req.headers.origin && !browserOriginAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  const alive = new WeakMap<object, boolean>();
  wss.on('connection', ws => {
    alive.set(ws, true); ws.on('pong', () => alive.set(ws, true));
    new InterviewSession(ws, config, dependencies);
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false); ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  return {
    http, wss,
    listen: () => new Promise<number>((resolve, reject) => {
      http.once('error', reject);
      http.listen(config.PORT, config.HOST, () => {
        http.removeListener('error', reject);
        const address = http.address(); resolve(typeof address === 'object' && address ? address.port : config.PORT);
      });
    }),
    close: () => new Promise<void>(resolve => {
      resume.close();
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => http.close(() => resolve()));
    }),
  };
}
