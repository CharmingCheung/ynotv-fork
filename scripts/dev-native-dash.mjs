import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const libraryName = process.platform === 'darwin' ? 'libmpv.2.dylib' : 'libmpv-2.dll';
const candidates = [];

if (process.env.YNOTV_NATIVE_DASH_LIBMPV_DIR) {
  candidates.push(process.env.YNOTV_NATIVE_DASH_LIBMPV_DIR);
}
candidates.push(join(process.cwd(), 'packages/app/src-tauri/native-dash-libmpv'));

if (process.platform === 'darwin' && existsSync('/private/tmp')) {
  for (const name of readdirSync('/private/tmp')) {
    if (name.startsWith('ynotv-mpv-adapter.')) {
      candidates.push(join('/private/tmp', name, 'mpv/build-ui'));
    }
  }
}

const patched = candidates
  .filter((directory) => existsSync(join(directory, libraryName)))
  // C7 sends the metadata-bearing live-v4 header.  Accepting the older C6
  // marker here makes mpv reject RDPKT004 at demux open and immediately close
  // the loopback packet bridge, which looks like a network playback failure.
  .filter((directory) => readFileSync(join(directory, libraryName)).includes(Buffer.from('RDPKT004')))
  .sort((left, right) => statSync(join(right, libraryName)).mtimeMs - statSync(join(left, libraryName)).mtimeMs)[0];

if (!patched) {
  console.error('[native-dash] C7 (RDPKT004) UI libmpv was not found. Rebuild the mpv adapter build-ui target first.');
  process.exit(1);
}

console.log(`[native-dash] using patched libmpv: ${patched}`);
if (process.argv.includes('--print-libmpv')) {
  process.exit(0);
}
const child = spawn('pnpm', ['--filter', '@ynotv/app', 'tauri', 'dev'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    YNOTV_NATIVE_DASH_LIBMPV_DIR: patched,
  },
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
