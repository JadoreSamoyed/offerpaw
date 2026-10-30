import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_DOCX_EXPANDED_BYTES, MAX_PDF_PAGES, MAX_RESUME_BYTES, MAX_RESUME_CHARACTERS, ResumeError, type ExtractedResume, type ResumeFormat, type ParserPhase } from './types.js';

const require = createRequire(import.meta.url);

export function resumeFileName(encoded: string | string[] | undefined): { fileName: string; format: ResumeFormat } {
  if (typeof encoded !== 'string' || encoded.length > 2000) throw new ResumeError('invalid_name');
  let fileName: string;
  try { fileName = decodeURIComponent(encoded).trim(); } catch { throw new ResumeError('invalid_name'); }
  if (!fileName || fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(fileName)) throw new ResumeError('invalid_name');
  const format = fileName.split('.').at(-1)?.toLowerCase();
  if (!['pdf', 'docx', 'txt'].includes(format ?? '')) throw new ResumeError('unsupported_type');
  return { fileName, format: format as ResumeFormat };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function readText(bytes: Buffer): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new ResumeError('invalid_encoding'); }
  // A renamed binary file must not be accepted as a text resume.
  if (/[\x00-\x08\x0e-\x1f]/.test(text) || text.startsWith('%PDF-') || text.startsWith('PK\x03\x04')) throw new ResumeError('invalid_file');
  return text;
}

async function checkDocxArchive(bytes: Buffer): Promise<void> {
  const { fromBuffer } = await import('yauzl');
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new ResumeError('invalid_file')); return; }
      let finished = false, expanded = 0, advertised = 0, entries = 0;
      const names = new Set<string>();
      const fail = (code: 'invalid_file' | 'document_too_complex' | 'encrypted_file') => {
        if (finished) return;
        finished = true; zip.close(); reject(new ResumeError(code));
      };
      zip.on('error', () => fail('invalid_file'));
      zip.on('entry', entry => {
        if (finished) return;
        entries++;
        advertised += entry.uncompressedSize;
        if (entries > 512 || advertised > MAX_DOCX_EXPANDED_BYTES) { fail('document_too_complex'); return; }
        if (entry.generalPurposeBitFlag & 1) { fail('encrypted_file'); return; }
        if (names.has(entry.fileName) || ![0, 8].includes(entry.compressionMethod)) { fail('invalid_file'); return; }
        names.add(entry.fileName);
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (finished) { stream?.destroy(); return; }
          if (streamError || !stream) { fail('invalid_file'); return; }
          stream.on('error', () => fail('invalid_file'));
          stream.on('data', (chunk: Buffer) => {
            expanded += chunk.length;
            if (expanded > MAX_DOCX_EXPANDED_BYTES) { stream.destroy(); fail('document_too_complex'); }
          });
          stream.on('end', () => { if (!finished) zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        if (finished) return;
        if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) { fail('invalid_file'); return; }
        finished = true; zip.close(); resolve();
      });
      if (zip.entryCount > 512) fail('document_too_complex');
      else zip.readEntry();
    });
  });
}

async function readPdf(bytes: Buffer, phase: (value: ParserPhase) => void): Promise<string> {
  // The bundled CJS entry avoids re-transforming PDF.js's large ESM source in tsx development.
  phase('pdf_dependency');
  const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
  const pdfjsRoot = dirname(createRequire(require.resolve('pdf-parse')).resolve('pdfjs-dist/package.json'));
  // Use the matching dependency's minified worker with a short file URL. A data
  // URL embeds the entire module in tsx's source-map metadata and can exceed the
  // child RSS limit while getInfo initializes PDF.js. The installed dependency
  // path is fixed here; documents cannot choose worker code or URLs.
  phase('pdf_worker_source');
  const workerSource = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.min.mjs')).href;
  phase('pdf_worker_config');
  PDFParse.setWorker(workerSource);
  phase('pdf_constructor');
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false,
    useWorkerFetch: false, useWasm: false, disableAutoFetch: true, disableStream: true,
    disableFontFace: true, maxImageSize: 0, enableXfa: false,
    cMapUrl: join(pdfjsRoot, 'cmaps').replaceAll('\\', '/') + '/',
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts').replaceAll('\\', '/') + '/' });
  try {
    phase('pdf_get_info');
    const info = await parser.getInfo();
    if (info.total > MAX_PDF_PAGES) throw new ResumeError('too_many_pages');
    // Parse one page at a time and stop once enough text is available.
    let text = '';
    for (let page = 1; page <= info.total; page++) {
      phase('pdf_get_text');
      const result = await parser.getText({ partial: [page], pageJoiner: '', parseHyperlinks: false });
      text += `${result.pages.map(value => value.text).join('\n')}\n`;
      if (normalizeText(text).length > MAX_RESUME_CHARACTERS) break;
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new ResumeError('encrypted_file');
    throw error;
  } finally { phase('pdf_destroy'); await parser.destroy(); }
}

// Called only in the worker: no parser executes on the voice server's event loop.
export async function extractResume(bytes: Buffer, fileName: string, format: ResumeFormat, phase: (value: ParserPhase) => void = () => {}): Promise<ExtractedResume> {
  if (bytes.length > MAX_RESUME_BYTES) throw new ResumeError('too_large');
  if (!bytes.length) throw new ResumeError('empty_file');
  let raw: string;
  if (format === 'txt') { phase('txt_decode'); raw = readText(bytes); }
  else if (format === 'pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new ResumeError('invalid_file');
    raw = await readPdf(bytes, phase);
  } else {
    if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new ResumeError('encrypted_file');
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new ResumeError('invalid_file');
    phase('docx_archive');
    await checkDocxArchive(bytes);
    phase('docx_dependency');
    const mammoth = await import('mammoth');
    // Buffer-only raw text extraction leaves external file access disabled and never renders HTML/images.
    phase('docx_text');
    raw = (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  const normalized = normalizeText(raw);
  if (!normalized) throw new ResumeError('no_text');
  let text = normalized.slice(0, MAX_RESUME_CHARACTERS);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { fileName, text, format, characters: text.length, truncated: normalized.length > text.length };
}
