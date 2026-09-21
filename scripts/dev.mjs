import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? 1}`));
    });
  });
}

await run(process.execPath, ['scripts/prepare-dev.mjs']);

const env = { ...process.env, YNOTV_DEV_CENTER_WINDOW: '1' };
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const nativeRuntime = join(root, 'packages/app/src-tauri/native-dash-libmpv');
  const nativeLibmpv = join(nativeRuntime, 'libmpv.2.dylib');
  if (!existsSync(nativeLibmpv)) throw new Error('Native runtime setup completed without libmpv.2.dylib');
  env.YNOTV_NATIVE_DASH_LIBMPV_DIR = nativeRuntime;
  env.YNOTV_NATIVE_DASH_PACKET_PRODUCER = join(
    root, 'experiments/clearkey-cenc-packet-transform/cenc_component_producer',
  );
  env.DYLD_LIBRARY_PATH = `${nativeRuntime}${delimiter}${env.DYLD_LIBRARY_PATH ?? ''}`;
  console.log(`[native-runtime] using ${nativeRuntime}`);
}
if (process.platform === 'win32') {
  const libmpv = join(root, 'packages/app/src-tauri/libmpv');
  env.PATH = `${libmpv}${delimiter}${env.PATH ?? ''}`;
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
await run(pnpm, ['--filter', '@ynotv/app', 'tauri', 'dev'], env);
