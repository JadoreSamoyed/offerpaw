import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { MAX_RESUME_BYTES, MAX_RESUME_CHARACTERS } from '../src/resume/types.js';

// Run the same regressions against dist after building to cover the production child entry.
const compiled = process.env.RESUME_TEST_COMPILED === '1';
const { createInterviewServer } = await import(compiled ? '../dist/server.js' : '../src/server.js');
const { extractInWorker } = await import(compiled ? '../dist/resume/isolate.js' : '../src/resume/isolate.js');

// Synthetic fixtures only: tests never read or persist user resumes.
function pdfFixture(text = 'Ada Engineer - TypeScript and distributed systems', pages = 1, encrypted = false, imageOnly = false, compressedBytes = 0): Buffer {
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const id of pageIds) {
    const content = compressedBytes ? deflateSync(Buffer.alloc(compressedBytes, 32)).toString('latin1')
      : imageOnly ? 'q 100 0 0 100 20 20 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID \xff\xff\xff EI Q' : `BT /F1 12 Tf 20 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')}${compressedBytes ? ' /Filter /FlateDecode' : ''} >>\nstream\n${content}\nendstream`);
  }
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data, 'latin1')); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data, 'latin1');
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]` : ''} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data, 'latin1');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries: Record<string, string | Buffer>, forgedSize?: number): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(forgedSize ?? bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(forgedSize ?? bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function docxEntries(text = '张三 软件工程师\n擅长 TypeScript 与分布式系统'): Record<string, string> {
  return {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map(line => `<w:p><w:r><w:t>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
  };
}

async function start(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const server = createInterviewServer(loadConfig({ NODE_ENV: 'test', PORT: '0', ...env }));
  const port = await server.listen();
  t.after(() => server.close());
  return { server, endpoint: `http://127.0.0.1:${port}/resume/extract` };
}

function upload(endpoint: string, fileName: string, bytes: Buffer, headers: Record<string, string> = {}) {
  return fetch(endpoint, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/octet-stream', 'X-Resume-Name': encodeURIComponent(fileName), ...headers } });
}

test('extracts real PDF, DOCX, UTF-8 and BOM UTF-16 fixtures through the HTTP endpoint', async t => {
  const { endpoint } = await start(t);
  const utf16be = Buffer.from('李四 数据工程师', 'utf16le'); utf16be.swap16();
  const cases = [
    ['简历.PDF', pdfFixture(), 'pdf', 'Ada Engineer'],
    ['简历.docx', zipFixture(docxEntries()), 'docx', '张三 软件工程师'],
    ['简历.txt', Buffer.from('\ufeff张三\r\n开发工程师'), 'txt', '张三\n开发工程师'],
    ['UTF16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('王五 后端开发', 'utf16le')]), 'txt', '王五 后端开发'],
    ['UTF16BE.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]), 'txt', '李四 数据工程师'],
  ] as const;
  for (const [name, bytes, format, expected] of cases) {
    const response = await upload(endpoint, name, bytes);
    const result = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.fileName, name); assert.equal(result.format, format);
    assert.ok(result.text.includes(expected)); assert.equal(result.characters, result.text.length); assert.equal(result.truncated, false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
});

test('the first PDF in a fresh parser cache stays within the child memory limits', async t => {
  const temporaryRoot = tmpdir();
  const cache = mkdtempSync(join(temporaryRoot, 'offerpaw-cold-parser-'));
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  t.after(() => {
    for (const key of ['TEMP', 'TMP'] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    const location = relative(temporaryRoot, cache);
    assert.ok(location && !location.startsWith('..') && !isAbsolute(location));
    rmSync(cache, { recursive: true, force: true });
  });
  // The child deliberately inherits only TEMP/TMP, not loader-specific environment
  // variables. A new temp directory exercises tsx's first-load path on all OSes.
  process.env.TEMP = cache;
  process.env.TMP = cache;
  const result = await extractInWorker(pdfFixture('Cold cache engineer'), 'cold.pdf', 'pdf', new AbortController().signal);
  assert.ok(result.text.includes('Cold cache engineer'));
});

test('text truncation is explicit and preserves complete Unicode characters', async t => {
  const { endpoint } = await start(t);
  const response = await upload(endpoint, 'long.txt', Buffer.from(`${'甲'.repeat(MAX_RESUME_CHARACTERS - 1)}😀末尾`));
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.text.length, MAX_RESUME_CHARACTERS - 1);
  assert.equal(result.truncated, true); assert.equal(result.characters, result.text.length); assert.ok(!result.text.includes('末尾'));
});

test('rejects unsupported, renamed, broken, encrypted, empty and image-only files with safe actionable errors', async t => {
  const { endpoint } = await start(t);
  const cases = [
    ['old.doc', Buffer.from('PRIVATE RESUME'), 415, 'unsupported_type'],
    ['photo.png', Buffer.from('PRIVATE RESUME'), 415, 'unsupported_type'],
    ['renamed.pdf', Buffer.from('PRIVATE RESUME'), 422, 'invalid_file'],
    ['broken.pdf', Buffer.from('%PDF-1.4\nPRIVATE RESUME'), 422, 'invalid_file'],
    ['renamed.docx', Buffer.from('PRIVATE RESUME'), 422, 'invalid_file'],
    ['zip.docx', zipFixture({ 'private.txt': 'PRIVATE RESUME' }), 422, 'invalid_file'],
    ['binary.txt', Buffer.from([0, 1, 2]), 422, 'invalid_file'],
    ['encoding.txt', Buffer.from([0xff, 0xaa]), 422, 'invalid_encoding'],
    ['empty.txt', Buffer.alloc(0), 422, 'empty_file'],
    ['blank.txt', Buffer.from(' \n\t '), 422, 'no_text'],
    ['empty.docx', zipFixture(docxEntries('')), 422, 'no_text'],
    ['scan.pdf', pdfFixture('', 1, false, true), 422, 'no_text'],
    ['locked.pdf', pdfFixture('PRIVATE RESUME', 1, true), 422, 'encrypted_file'],
    ['too-many.pdf', pdfFixture('Ada Engineer', 31), 422, 'too_many_pages'],
  ] as const;
  for (const [fileName, bytes, status, code] of cases) {
    const response = await upload(endpoint, fileName, bytes);
    const body = await response.text(); const result = JSON.parse(body);
    assert.equal(response.status, status, `${fileName}: ${body}`); assert.equal(result.error.code, code, `${fileName}: ${body}`);
    assert.ok(result.error.message.length > 10); assert.equal(body.includes('PRIVATE RESUME'), false);
    assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message']);
  }
});

test('DOCX limits reject expansion bombs, forged sizes and excessive archive entries', async t => {
  const { endpoint } = await start(t);
  for (const bytes of [
    zipFixture({ ...docxEntries(), 'word/media/bomb.bin': Buffer.alloc(21 * 1024 * 1024) }),
    zipFixture({ ...docxEntries(), 'word/media/bomb.bin': Buffer.alloc(21 * 1024 * 1024) }, 1),
    zipFixture({ ...docxEntries(), ...Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`f${i}`, ''])) }),
  ]) {
    const response = await upload(endpoint, 'bomb.docx', bytes);
    assert.equal(response.status, 422); assert.ok(['document_too_complex', 'invalid_file'].includes((await response.json()).error.code));
  }
});

test('authentication is checked before reading any request body and errors never expose tokens', async t => {
  const secret = 'do-not-expose-this-token';
  const { endpoint } = await start(t, { APP_ACCESS_TOKEN: secret });
  for (const authorization of ['', 'Bearer wrong-token', secret, 'Basic wrong-token']) {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(endpoint, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/octet-stream', 'X-Resume-Name': 'resume.txt', 'Content-Length': MAX_RESUME_BYTES + 1 } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode!, body }); });
      });
      req.on('error', reject); req.flushHeaders();
    });
    assert.equal(response.status, 401); assert.equal(JSON.parse(response.body).error.code, 'unauthorized');
    assert.equal(response.body.includes(secret), false); assert.equal(response.body.includes('wrong-token'), false);
  }
  const success = await upload(endpoint, 'resume.txt', Buffer.from('Ada Engineer'), { Authorization: `Bearer ${secret}` });
  assert.equal(success.status, 200); await success.arrayBuffer();
});

test('enforces the byte limit for declared and chunked uploads and keeps the service responsive', async t => {
  const { endpoint } = await start(t);
  const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Resume-Name': 'large.txt', 'Content-Length': MAX_RESUME_BYTES + 1 } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode!, body }); });
    });
    req.on('error', reject); req.flushHeaders();
  });
  assert.equal(oversized.status, 413); assert.equal(JSON.parse(oversized.body).error.code, 'too_large');
  const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Resume-Name': 'large.txt' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.write(Buffer.alloc(MAX_RESUME_BYTES, 65)); req.end(Buffer.from('x'));
  });
  assert.equal(chunked.status, 413); assert.equal(JSON.parse(chunked.body).error.code, 'too_large');
  const health = await fetch(endpoint.replace('/resume/extract', '/health')); assert.equal(health.status, 200); await health.arrayBuffer();
});

test('resume preflight and POST use the same origin policy as health, including native no-Origin clients', async t => {
  const token = 'a'.repeat(32);
  const { endpoint } = await start(t, { NODE_ENV: 'production', APP_ACCESS_TOKEN: token, ALLOWED_ORIGINS: 'https://app.example' });
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-resume-name' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type, X-Resume-Name');
  for (const origin of ['https://attacker.example', 'null', 'http://localhost:8081']) {
    const response = await upload(endpoint, 'resume.txt', Buffer.from('Ada Engineer'), { Origin: origin, Authorization: `Bearer ${token}` });
    assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null); await response.arrayBuffer();
  }
  for (const origin of ['https://app.example', undefined]) {
    const response = await upload(endpoint, 'resume.txt', Buffer.from('Ada Engineer'), { ...(origin ? { Origin: origin } : {}), Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin ?? null); await response.arrayBuffer();
  }
  const local = await start(t);
  const response = await upload(local.endpoint, 'resume.txt', Buffer.from('Ada'), { Origin: 'http://localhost:8081' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8081'); await response.arrayBuffer();
});

test('validates upload headers and sanitizes filenames', async t => {
  const { endpoint } = await start(t);
  for (const name of ['%broken', '../private.txt', 'folder%5Cprivate.txt', '%00resume.txt', '']) {
    const response = await fetch(endpoint, { method: 'POST', body: 'test', headers: { 'Content-Type': 'application/octet-stream', 'X-Resume-Name': name } });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'invalid_name');
  }
  const wrongType = await fetch(endpoint, { method: 'POST', body: 'test', headers: { 'Content-Type': 'text/plain', 'X-Resume-Name': 'resume.txt' } });
  assert.equal(wrongType.status, 415); await wrongType.arrayBuffer();
  const method = await fetch(endpoint); assert.equal(method.status, 405); assert.equal(method.headers.get('Allow'), 'POST, OPTIONS'); await method.arrayBuffer();
});

test('only two uploads can parse at once and disconnected uploads free their slots', async t => {
  const { server, endpoint } = await start(t);
  const pending = [];
  for (let i = 0; i < 2; i++) {
    const seen = once(server.http, 'request');
    const req = request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Resume-Name': 'resume.txt', 'Content-Length': 1000 } });
    req.on('error', () => {}); req.write('partial'); pending.push(req); await seen;
  }
  const busy = await upload(endpoint, 'resume.txt', Buffer.from('Ada'));
  assert.equal(busy.status, 503); assert.equal(busy.headers.get('Retry-After'), '2'); assert.equal((await busy.json()).error.code, 'busy');
  const closed = pending.map(req => new Promise<void>(resolve => req.once('close', resolve)));
  for (const req of pending) req.destroy();
  await Promise.all(closed);
  // Wait for server-side aborted events, without depending on a wall-clock delay.
  await new Promise<void>(resolve => setImmediate(resolve));
  const health = await fetch(endpoint.replace('/resume/extract', '/health')); assert.equal(health.status, 200); await health.arrayBuffer();
  const retry = await upload(endpoint, 'resume.txt', Buffer.from('Ada')); assert.equal(retry.status, 200); await retry.arrayBuffer();
});

test('worker deadlines and cancellation terminate parsing and allow subsequent work', async () => {
  await assert.rejects(extractInWorker(pdfFixture(), 'resume.pdf', 'pdf', new AbortController().signal, 1), { code: 'timeout' });
  const controller = new AbortController();
  const promise = extractInWorker(pdfFixture(), 'resume.pdf', 'pdf', controller.signal); controller.abort();
  await assert.rejects(promise, { code: 'cancelled' });
  const result = await extractInWorker(Buffer.from('Healthy'), 'resume.txt', 'txt', new AbortController().signal);
  assert.equal(result.text, 'Healthy');
});

test('compressed PDF expansion is stopped by the child memory watchdog without blocking health', async t => {
  const { endpoint } = await start(t);
  const bomb = pdfFixture('', 1, false, false, 128 * 1024 * 1024);
  assert.ok(bomb.length < 200000);
  const pending = upload(endpoint, 'compressed.pdf', bomb);
  const health = await fetch(endpoint.replace('/resume/extract', '/health'));
  assert.equal(health.status, 200); await health.arrayBuffer();
  const response = await pending;
  const result = await response.json();
  assert.equal(response.status, 422); assert.equal(result.error.code, 'document_too_complex');
  assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message']);
  const normal = await upload(endpoint, 'normal.pdf', pdfFixture());
  assert.equal(normal.status, 200); assert.ok((await normal.json()).text.includes('Ada Engineer'));
});

test('DOCX external references are neither fetched nor rendered as HTML', async t => {
  let requests = 0;
  const external = createServer((_req, res) => { requests++; res.end('PRIVATE-EXTERNAL-DATA'); });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  t.after(() => new Promise<void>(resolve => external.close(() => resolve())));
  const address = external.address(); assert.ok(address && typeof address === 'object');
  const entries = docxEntries('Engineer <script>alert(1)</script>');
  entries['word/document.xml'] = entries['word/document.xml']!.replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
    .replace('<w:sectPr/>', '<w:p><w:hyperlink r:id="link1"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p><w:sectPr/>');
  entries['word/_rels/document.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://127.0.0.1:${address.port}/private" TargetMode="External"/></Relationships>`;
  const { endpoint } = await start(t);
  const response = await upload(endpoint, 'external.docx', zipFixture(entries));
  assert.equal(response.status, 200);
  const result = await response.json(); assert.ok(result.text.includes('Engineer <script>alert(1)</script>')); assert.ok(result.text.includes('Portfolio'));
  assert.equal(result.text.includes('<a '), false); assert.equal(result.text.includes('PRIVATE-EXTERNAL-DATA'), false); assert.equal(requests, 0);
});
