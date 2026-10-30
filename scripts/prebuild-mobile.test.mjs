import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installWindowsCopyWorkaround } from './prebuild-mobile.mjs';

installWindowsCopyWorkaround();

// Use individual libuv operations for cleanup too: this test also runs on the
// affected Node version. Never delete anything outside this fresh fixture root.
function removeFixture(root, target = root) {
  const relative = path.relative(root, target);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) removeFixture(root, child);
    else fs.unlinkSync(child);
  }
  fs.rmdirSync(target);
}

test('prebuild copy preserves nested Android files in a Chinese workspace path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tingda-prebuild-test-'));
  t.after(() => removeFixture(root));
  const source = path.join(root, 'template', 'android');
  const destination = path.join(root, '面试辅助工具', 'android');
  fs.mkdirSync(path.join(source, 'app', 'src', 'main'), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(path.join(source, 'build.gradle'), 'android build');
  fs.writeFileSync(path.join(source, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest />');
  fs.cpSync(source, destination, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(destination, 'build.gradle'), 'utf8'), 'android build');
  assert.equal(fs.readFileSync(path.join(destination, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'), '<manifest />');

  // Do not replace an explicit caller filter. Expo copies templates only when
  // the platform directory does not exist; it reuses existing native projects.
  const filtered = path.join(root, '过滤后的工程');
  fs.cpSync(source, filtered, { recursive: true, filter: (file) => !file.endsWith('.xml') });
  assert.equal(fs.readFileSync(path.join(filtered, 'build.gradle'), 'utf8'), 'android build');
  assert.equal(fs.existsSync(path.join(filtered, 'app', 'src', 'main', 'AndroidManifest.xml')), false);
});
