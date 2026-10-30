const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const MAX_BYTES = 5 * 1024 * 1024;
const settings = { serverUrl: ' https://interview.example/proxy/ ', token: ' test-token ' };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compile(name) {
  return ts.transpileModule(readFileSync(path.join(__dirname, name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const uploadCode = compile('resume-upload.ts');
const storageCode = compile('storage.ts');

function harness(options = {}) {
  const platform = options.platform || 'web';
  const bytes = options.bytes || new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]).buffer;
  const calls = { picker: [], reads: [], fetch: [], revoked: [], deleted: [], files: [] };
  const timers = new Map();
  const payload = Object.hasOwn(options, 'payload')
    ? options.payload
    : { text: '负责产品需求分析与项目交付。', format: 'pdf', truncated: false };
  const asset = {
    name: '个人简历 #应聘.PDF',
    uri: platform === 'web' ? 'blob:https://app.example/resume-1' : 'file:///app/cache/DocumentPicker/resume.pdf',
    size: bytes.byteLength,
    file: {
      size: options.webSize ?? bytes.byteLength,
      async arrayBuffer() {
        calls.reads.push({ platform: 'web' });
        return options.read ? options.read() : bytes;
      },
    },
    ...options.asset,
  };

  class NativeFile {
    constructor(uri) {
      calls.files.push(uri);
      this.uri = uri;
      this.size = options.nativeSize ?? bytes.byteLength;
      this.exists = options.nativeExists !== false;
    }
    async arrayBuffer() {
      calls.reads.push({ platform: 'native', uri: this.uri });
      return options.read ? options.read() : bytes;
    }
    delete() {
      calls.deleted.push(this.uri);
      if (options.deleteError) throw new Error('cache file is locked');
    }
  }
  class MockURL extends URL {
    static revokeObjectURL(uri) { calls.revoked.push(uri); }
  }

  const storage = {};
  vm.runInNewContext(storageCode, {
    exports: storage,
    URL: MockURL,
    process: { env: { EXPO_PUBLIC_DEMO_ONLY: options.demoOnly ? '1' : '' } },
    require(name) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === './types') return { defaultProfile: {} };
      if (name === '@react-native-async-storage/async-storage' || name === 'expo-secure-store') return {};
      throw new Error(`Unexpected storage dependency: ${name}`);
    },
  });

  const exports = {};
  vm.runInNewContext(uploadCode, {
    exports,
    URL: MockURL,
    AbortController,
    setTimeout(callback, delay) { const id = Symbol('timer'); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === 'expo-document-picker') return {
        getDocumentAsync(pickerOptions) {
          calls.picker.push(pickerOptions);
          return options.picker ? options.picker() : Promise.resolve({ canceled: false, assets: [asset] });
        },
      };
      if (name === 'expo-file-system') return { File: NativeFile, Paths: { cache: { uri: options.cacheUri || 'file:///app/cache/' } } };
      if (name === 'expo/fetch') return {
        async fetch(url, init) {
          calls.fetch.push({ url, init });
          if (options.fetch) return options.fetch(url, init);
          return { ok: options.ok !== false, async json() { if (options.jsonError) throw new Error('invalid JSON'); return payload; } };
        },
      };
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === './storage') return storage;
      throw new Error(`Unexpected upload dependency: ${name}`);
    },
  });
  return { ...exports, calls, asset, bytes, timers, timeout() {
    assert.equal(timers.size, 1, 'upload should have one active deadline');
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 45000);
    timer.callback();
  } };
}

function assertReleased(context) {
  assert.equal(context.timers.size, 0, 'the extraction deadline must be cleared');
  if (context.asset.uri.startsWith('blob:')) assert.deepEqual(context.calls.revoked, [context.asset.uri]);
}

test('demo resume extraction is pinned to loopback and never forwards a configured token', async () => {
  const context = harness({ demoOnly: true });
  await context.pickAndExtractResume(settings);
  assert.equal(context.calls.fetch[0].url, 'http://127.0.0.1:8787/resume/extract');
  assert.equal(Object.hasOwn(context.calls.fetch[0].init.headers, 'Authorization'), false);
  assertReleased(context);
});

test('web picker uploads ArrayBuffer to the configured path with encoded filename and bearer auth', async () => {
  const context = harness();
  const operation = context.pickAndExtractResume(settings);
  assert.equal(context.calls.picker.length, 1, 'picker must open synchronously within the user gesture');
  const result = await operation;
  assert.deepEqual(plain(context.calls.picker[0]), {
    type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
    copyToCacheDirectory: true, multiple: false, base64: false,
  });
  assert.equal(context.calls.fetch.length, 1);
  const { url, init } = context.calls.fetch[0];
  assert.equal(url, 'https://interview.example/proxy/resume/extract');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, context.bytes, 'send the original ArrayBuffer, not base64 or JSON');
  assert.ok(init.body instanceof ArrayBuffer);
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers['X-Resume-Name'], encodeURIComponent(context.asset.name));
  assert.equal(init.headers.Authorization, 'Bearer test-token');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(result.text, '负责产品需求分析与项目交付。');
  assert.equal(result.attachment.name, context.asset.name);
  assert.equal(result.attachment.size, context.bytes.byteLength);
  assert.equal(result.attachment.format, 'pdf');
  assert.match(result.attachment.importedAt, /^\d{4}-\d\d-\d\dT.+Z$/);
  assert.equal(result.truncated, false);
  assertReleased(context);
});

test('blank token omits authorization and exactly 20,000 extracted characters retain the truncation flag', async () => {
  const context = harness({ payload: { text: 'A'.repeat(20000), format: 'pdf', truncated: true } });
  const result = await context.pickAndExtractResume({ ...settings, token: '  ' });
  assert.equal(Object.hasOwn(context.calls.fetch[0].init.headers, 'Authorization'), false);
  assert.equal(result.text.length, 20000);
  assert.equal(result.truncated, true);
  assertReleased(context);
});

test('native upload reads Expo File bytes and removes its DocumentPicker cache copy', async () => {
  const context = harness({ platform: 'android', asset: { name: 'resume.docx', file: undefined }, payload: { text: 'Native resume', format: 'docx', truncated: false } });
  const result = await context.pickAndExtractResume(settings);
  assert.deepEqual(context.calls.reads, [{ platform: 'native', uri: context.asset.uri }]);
  assert.equal(context.calls.fetch[0].init.body, context.bytes);
  assert.equal(result.attachment.format, 'docx');
  assert.deepEqual(context.calls.deleted, [context.asset.uri]);
  assert.deepEqual(context.calls.revoked, []);
  assertReleased(context);
});

test('a pre-aborted request never opens the picker or sends data', async () => {
  const context = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await context.pickAndExtractResume(settings, controller.signal), null);
  assert.equal(context.calls.picker.length, 0);
  assert.equal(context.calls.fetch.length, 0);
  assert.equal(context.calls.reads.length, 0);
});

test('picker cancellation performs no read, request, or cleanup of a nonexistent selection', async () => {
  const context = harness({ picker: async () => ({ canceled: true, assets: null }) });
  assert.equal(await context.pickAndExtractResume(settings), null);
  assert.equal(context.calls.reads.length, 0);
  assert.equal(context.calls.fetch.length, 0);
  assert.deepEqual(context.calls.revoked, []);
  assert.equal(context.timers.size, 0);
});

test('cancellation while the picker is open releases a late selection without reading it', async () => {
  const selection = deferred();
  const context = harness({ picker: () => selection.promise });
  const controller = new AbortController();
  const operation = context.pickAndExtractResume(settings, controller.signal);
  controller.abort();
  selection.resolve({ canceled: false, assets: [context.asset] });
  assert.equal(await operation, null);
  assert.equal(context.calls.reads.length, 0);
  assert.equal(context.calls.fetch.length, 0);
  assertReleased(context);
});

for (const platform of ['web', 'ios']) {
  test(`cancellation during ${platform} file read discards late bytes before upload`, async () => {
    const reading = deferred();
    const context = harness({ platform, read: () => reading.promise });
    const controller = new AbortController();
    const operation = context.pickAndExtractResume(settings, controller.signal);
    await turn();
    assert.equal(context.calls.reads.length, 1);
    controller.abort();
    reading.resolve(context.bytes);
    assert.equal(await operation, null);
    assert.equal(context.calls.fetch.length, 0);
    if (platform !== 'web') assert.deepEqual(context.calls.deleted, [context.asset.uri]);
    assertReleased(context);
  });
}

test('cancellation during upload aborts the network request and returns null', async () => {
  const context = harness({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const controller = new AbortController();
  const operation = context.pickAndExtractResume(settings, controller.signal);
  await turn();
  assert.equal(context.calls.fetch.length, 1);
  controller.abort();
  assert.equal(await operation, null);
  assert.equal(context.calls.fetch[0].init.signal.aborted, true);
  assertReleased(context);
});

test('cancellation during response decoding cannot publish late extracted text', async () => {
  const decoding = deferred();
  const context = harness({ fetch: async () => ({ ok: true, json: () => decoding.promise }) });
  const controller = new AbortController();
  const operation = context.pickAndExtractResume(settings, controller.signal);
  await turn();
  controller.abort();
  decoding.resolve({ text: 'late resume', format: 'pdf', truncated: false });
  assert.equal(await operation, null);
  assertReleased(context);
});

for (const [label, options] of [
  ['picker metadata', { asset: { size: MAX_BYTES + 1 } }],
  ['browser File size', { asset: { size: undefined }, webSize: MAX_BYTES + 1 }],
  ['native File size', { platform: 'android', asset: { size: undefined }, nativeSize: MAX_BYTES + 1 }],
]) {
  test(`oversized ${label} is rejected before reading any file bytes`, async () => {
    const context = harness(options);
    await assert.rejects(context.pickAndExtractResume(settings), /5 MB/);
    assert.equal(context.calls.reads.length, 0);
    assert.equal(context.calls.fetch.length, 0);
    assertReleased(context);
  });
}

for (const size of [0, -1, NaN, Infinity]) {
  test(`invalid file size ${String(size)} is rejected before reading`, async () => {
    const context = harness({ asset: { size } });
    await assert.rejects(context.pickAndExtractResume(settings), /文件为空或无法读取/);
    assert.equal(context.calls.reads.length, 0);
    assert.equal(context.calls.fetch.length, 0);
    assertReleased(context);
  });
}

test('actual bytes exceeding the limit are rejected even when declared sizes are small', async () => {
  const context = harness({ read: async () => new ArrayBuffer(MAX_BYTES + 1) });
  await assert.rejects(context.pickAndExtractResume(settings), /5 MB/);
  assert.equal(context.calls.reads.length, 1);
  assert.equal(context.calls.fetch.length, 0);
  assertReleased(context);
});

test('unsupported attachments and a missing browser File are rejected before network access', async (t) => {
  for (const [name, options, message] of [
    ['legacy DOC', { asset: { name: 'resume.doc' } }, /仅支持/],
    ['image', { asset: { name: 'resume.png' } }, /仅支持/],
    ['missing File', { asset: { file: undefined } }, /浏览器未能读取文件/],
  ]) await t.test(name, async () => {
    const context = harness(options);
    await assert.rejects(context.pickAndExtractResume(settings), message);
    assert.equal(context.calls.reads.length, 0);
    assert.equal(context.calls.fetch.length, 0);
    assertReleased(context);
  });
});

test('invalid extraction responses never become usable resume text', async (t) => {
  const valid = { text: 'Resume text', format: 'pdf', truncated: false };
  for (const [name, payload] of [
    ['null', null], ['missing text', {}], ['non-text', { ...valid, text: 42 }],
    ['blank text', { ...valid, text: ' \n\t ' }], ['too much text', { ...valid, text: 'A'.repeat(20001) }],
    ['wrong format', { ...valid, format: 'docx' }], ['missing truncated flag', { text: 'Resume', format: 'pdf' }],
    ['nonboolean truncated flag', { ...valid, truncated: 'false' }],
  ]) await t.test(name, async () => {
    const context = harness({ payload });
    await assert.rejects(context.pickAndExtractResume(settings), /服务返回的简历文字无效/);
    assertReleased(context);
  });
  await t.test('malformed JSON', async () => {
    const context = harness({ jsonError: true });
    await assert.rejects(context.pickAndExtractResume(settings), /服务返回的简历文字无效/);
    assertReleased(context);
  });
});

test('server errors expose short actionable messages and use a fallback for invalid error payloads', async (t) => {
  for (const [name, options, message] of [
    ['actionable response', { ok: false, payload: { error: { message: '扫描件无法提取文字' } } }, /扫描件无法提取文字/],
    ['oversized error', { ok: false, payload: { error: { message: 'x'.repeat(251) } } }, /简历提取失败/],
    ['missing message', { ok: false, payload: {} }, /简历提取失败/],
    ['non-JSON response', { ok: false, jsonError: true }, /简历提取失败/],
    ['network error', { fetch: async () => { throw new Error('connection refused'); } }, /无法连接简历提取服务/],
  ]) await t.test(name, async () => {
    const context = harness(options);
    await assert.rejects(context.pickAndExtractResume(settings), message);
    assertReleased(context);
  });
});

test('network deadline aborts extraction and reports timeout instead of a generic network failure', async () => {
  const context = harness({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const operation = context.pickAndExtractResume(settings);
  await turn();
  context.timeout();
  await assert.rejects(operation, /简历提取超时/);
  assert.equal(context.calls.fetch[0].init.signal.aborted, true);
  assertReleased(context);
});

test('a read finishing after the deadline never sends the document', async () => {
  const reading = deferred();
  const context = harness({ read: () => reading.promise });
  const operation = context.pickAndExtractResume(settings);
  await turn();
  context.timeout();
  reading.resolve(context.bytes);
  await assert.rejects(operation, /超时/);
  assert.equal(context.calls.fetch.length, 0);
  assertReleased(context);
});

test('native cleanup deletes only files contained in the picker cache directory', async (t) => {
  for (const uri of [
    'file:///app/documents/resume.pdf',
    'file:///app/cache/resume.pdf',
    'file:///app/cache/DocumentPickerOther/resume.pdf',
    'file:///app/cache/DocumentPicker/../original.pdf',
    'file:///app/cache/DocumentPicker/%2e%2e/original.pdf',
    'file:///app/cache/DocumentPicker/%2F..%2Fdocuments/resume.pdf',
    'file:///app/cache/DocumentPicker/%5C..%5Cdocuments/resume.pdf',
    'file:///app/cache/DocumentPicker/resume.pdf?original=true',
    'file:///app/cache/DocumentPicker/resume.pdf#original',
    'file:///app/cache/DocumentPicker/resume%00.pdf',
    'content://documents/provider/resume.pdf',
    'https://files.example/DocumentPicker/resume.pdf',
  ]) await t.test(uri, async () => {
    const context = harness({ platform: 'ios', asset: { uri } });
    await context.pickAndExtractResume(settings);
    assert.deepEqual(context.calls.deleted, [], 'the original or an ambiguous URI must never be deleted');
    assertReleased(context);
  });
});

test('native failure cleans the picker cache and cleanup failure does not discard successful text', async (t) => {
  await t.test('failed extraction', async () => {
    const context = harness({ platform: 'android', ok: false, payload: {} });
    await assert.rejects(context.pickAndExtractResume(settings), /简历提取失败/);
    assert.deepEqual(context.calls.deleted, [context.asset.uri]);
    assertReleased(context);
  });
  await t.test('cache deletion error', async () => {
    const context = harness({ platform: 'ios', deleteError: true, cacheUri: 'file:///app/cache' });
    const result = await context.pickAndExtractResume(settings);
    assert.ok(result.text);
    assert.deepEqual(context.calls.deleted, [context.asset.uri]);
    assertReleased(context);
  });
  await t.test('already missing cache copy', async () => {
    const context = harness({ platform: 'ios', nativeExists: false });
    assert.ok((await context.pickAndExtractResume(settings)).text);
    assert.deepEqual(context.calls.deleted, []);
    assertReleased(context);
  });
});

test('web cleanup never revokes non-blob document locations', async () => {
  const context = harness({ asset: { name: 'resume.txt', uri: 'https://files.example/original.txt' }, payload: { text: 'Plain text resume', format: 'txt', truncated: false } });
  const result = await context.pickAndExtractResume(settings);
  assert.equal(result.attachment.format, 'txt');
  assert.deepEqual(context.calls.revoked, []);
  assert.deepEqual(context.calls.deleted, []);
  assertReleased(context);
});
