import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'packages/app/src-tauri');
const bin = join(tauri, 'bin');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function targetTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') {
    if (process.arch !== 'x64') throw new Error('Windows ARM64 native assets are not available');
    return 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  throw new Error(`Unsupported development platform: ${process.platform}/${process.arch}`);
}

const triple = targetTriple();
const suffix = process.platform === 'win32' ? '.exe' : '';
const requiredSidecars = [
  join(bin, `mpv-${triple}${suffix}`),
  join(bin, `yt-dlp-${triple}${suffix}`),
];

if (requiredSidecars.some(path => !existsSync(path))) {
  console.log('[dev-setup] downloading the missing mpv/yt-dlp sidecars');
  run('bash', ['scripts/download-mpv-tauri.sh']);
}

const ffmpeg = join(bin, `ffmpeg-${triple}${suffix}`);
if (!existsSync(ffmpeg)) {
  console.log('[dev-setup] preparing the missing FFmpeg sidecar');
  run(process.execPath, ['packages/app/scripts/download-ffmpeg.js']);
}

if ((process.platform === 'darwin' && process.arch === 'arm64') ||
    (process.platform === 'win32' && process.arch === 'x64')) {
  run(process.execPath, ['scripts/setup-native-runtime.mjs']);
}
if (process.platform === 'darwin' && process.arch === 'arm64') {
  run(process.execPath, ['scripts/prepare-macos-bundle-runtime.mjs']);
}

console.log('[dev-setup] native development assets are ready');
