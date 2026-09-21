import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

if (!((process.platform === 'darwin' && process.arch === 'arm64') ||
      (process.platform === 'win32' && process.arch === 'x64'))) {
  console.error(`[native-dash] no Native DASH runtime is available for ${process.platform}/${process.arch}.`);
  process.exit(1);
}

const libraryName = process.platform === 'darwin' ? 'libmpv.2.dylib' : 'libmpv-2.dll';
const patched = join(process.cwd(), 'packages/app/src-tauri/native-dash-libmpv');
const patchedLibrary = join(patched, libraryName);
if (!existsSync(patchedLibrary)) {
  const result = spawnSync(process.execPath, ['scripts/setup-native-runtime.mjs'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const library = existsSync(patchedLibrary) ? readFileSync(patchedLibrary) : Buffer.alloc(0);

if (!library.includes(Buffer.from('RDPKT006')) || !library.includes(Buffer.from('YNOIMSC1'))) {
  console.error('[native-dash] downloaded runtime is incompatible; run pnpm setup:native-runtime -- --force');
  process.exit(1);
}

const producer = process.platform === 'win32'
  ? join(patched, 'cenc_component_producer.exe')
  : join(patched, 'cenc_component_producer');
if (!existsSync(producer)) {
  console.error('[native-dash] Native DASH packet producer is missing from the runtime');
  process.exit(1);
}

console.log(`[native-dash] using patched libmpv: ${patched}`);
if (process.argv.includes('--print-libmpv')) {
  process.exit(0);
}
const child = spawn(process.execPath, ['scripts/dev.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
  },
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
