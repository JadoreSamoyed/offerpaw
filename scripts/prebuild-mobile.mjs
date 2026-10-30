import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Node 24.14 on Windows can silently skip directory copies into non-ASCII paths.
// A filter selects Node's JS/libuv path instead of the affected C++ fast path.
// Fixed upstream in 24.15: https://github.com/nodejs/node/issues/61878
export function installWindowsCopyWorkaround() {
  if (process.platform !== 'win32' || !/^24\.14\./.test(process.versions.node)) return false;
  const original = fs.cpSync;
  fs.cpSync = function copyWithUnicodeSupport(source, destination, options) {
    if (options === undefined || (options && typeof options === 'object' && options.filter === undefined)) {
      return original.call(this, source, destination, { ...options, filter: () => true });
    }
    return original.call(this, source, destination, options);
  };
  syncBuiltinESMExports();
  return true;
}

export function runPrebuild(args = process.argv.slice(2)) {
  const require = createRequire(import.meta.url);
  const appRoot = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
  const expoCli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin', 'cli');
  if (installWindowsCopyWorkaround()) {
    console.log('Using the Node 24.14 Windows directory-copy workaround for this prebuild process.');
  }
  process.chdir(appRoot);
  // Expo 58 cleans by default. Preserve complete native projects unless the
  // caller explicitly requests --clean; Expo still owns malformed-project handling.
  const cleanupArgs = args.includes('--clean') || args.includes('--no-clean') ? [] : ['--no-clean'];
  process.argv = [process.execPath, expoCli, 'prebuild', ...cleanupArgs, ...args];
  require(expoCli);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPrebuild();
}
