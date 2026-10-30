const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function compile(file) {
  return ts.transpileModule(readFileSync(path.join(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const types = {};
vm.runInNewContext(compile('types.ts'), { exports: types });
const storageCode = compile('storage.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));

for (const platform of ['web', 'android', 'ios']) {
  test(`${platform}: demo does not read, overwrite or clear a previous real installation`, async () => {
    const previous = {
      'tingda.workspace.v1': JSON.stringify({ serverUrl: 'https://old-install.example',
        profile: { role: 'fixture-old-role', resume: 'fixture-old-resume', jobDescription: 'fixture-old-job' },
        history: [{ id: 'fixture-old-session' }] }),
      'tingda.voice-profile.v1': JSON.stringify({ version: 1, model: 'campplus-zh-v1', embedding: Array(192).fill(1) }),
      'tingda.token': 'fixture-old-token',
    };
    const data = new Map(Object.entries(previous));
    const calls = [];
    const get = (key) => { calls.push(['read', key]); return data.get(key) ?? null; };
    const set = (key, value) => { calls.push(['write', key]); data.set(key, value); };
    const remove = (key) => { calls.push(['delete', key]); data.delete(key); };
    const exports = {};
    vm.runInNewContext(storageCode, {
      exports, URL, process: { env: { EXPO_PUBLIC_DEMO_ONLY: '1', EXPO_PUBLIC_API_URL: 'https://env-install.example' } },
      sessionStorage: { getItem: get, setItem: set, removeItem: remove },
      window: { location: { protocol: 'https:', hostname: 'browser-install.example' } },
      require(name) {
        if (name === '@react-native-async-storage/async-storage') return { __esModule: true, default: { getItem: get, setItem: set, removeItem: remove } };
        if (name === 'expo-secure-store') return { getItemAsync: get, setItemAsync: set, deleteItemAsync: remove };
        if (name === 'react-native') return { Platform: { OS: platform } };
        if (name === './types') return types;
        throw new Error(name);
      },
    });
    const workspace = await exports.loadWorkspace();
    assert.deepEqual(plain(workspace.profile), plain(types.defaultProfile));
    assert.equal(workspace.profile.role, '');
    assert.equal(workspace.profile.resume, '');
    assert.equal(workspace.profile.jobDescription, '');
    assert.deepEqual(plain(workspace.history), []);
    assert.deepEqual(plain(workspace.settings), { serverUrl: 'http://127.0.0.1:8787', token: '' });
    assert.equal(await exports.loadVoiceProfile(), null);
    const editedSettings = { serverUrl: 'https://edited-install.example', token: 'fixture-new-token' };
    assert.deepEqual(plain(exports.effectiveSettings(editedSettings)), plain(workspace.settings));
    assert.equal(exports.serverEndpoint(editedSettings.serverUrl, '/health'), 'http://127.0.0.1:8787/health');
    assert.equal(exports.serverEndpoint(editedSettings.serverUrl, '/session', true), 'ws://127.0.0.1:8787/session');
    await exports.saveWorkspace({ ...workspace.profile, resume: 'fixture-demo-text' }, editedSettings, [{ id: 'fixture-demo-session' }]);
    await exports.saveWorkspace(workspace.profile, workspace.settings, []);
    await exports.saveVoiceProfile(JSON.parse(previous['tingda.voice-profile.v1']));
    await exports.saveVoiceProfile(null);
    assert.deepEqual(calls, [], 'demo storage must be entirely memory-only');
    assert.deepEqual(Object.fromEntries(data), previous);
    assert.deepEqual(plain((await exports.loadWorkspace()).history), []);
  });
}
