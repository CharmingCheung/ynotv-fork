import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = 'v0.1.0';
const asset = `ynotv-native-macos-arm64-${version}.tar.gz`;
const releaseBase = `https://github.com/CharmingCheung/ynotv-native/releases/download/${version}`;
const destination = join(root, 'packages/app/src-tauri/native-dash-libmpv');
const downloadCache = join(root, '.cache/ynotv-native', version);
const library = join(destination, 'libmpv.2.dylib');

function compatible(path) {
  if (!existsSync(path) || !existsSync(join(dirname(path), 'libmpv.dylib'))) return false;
  const bytes = readFileSync(path);
  if (!bytes.includes(Buffer.from('RDPKT006')) || !bytes.includes(Buffer.from('YNOIMSC1'))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(path), 'manifest.json'), 'utf8'));
    return manifest.version === version && manifest.platform === 'macos-arm64';
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function syncTauriFrameworks() {
  const frameworks = join(root, 'packages/app/src-tauri/target/Frameworks');
  mkdirSync(frameworks, { recursive: true });
  for (const name of ['libmpv.2.dylib', 'libplacebo.360.dylib']) {
    const source = join(destination, name);
    const target = join(frameworks, name);
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue;
    rmSync(target, { force: true });
    copyFileSync(source, target);
  }
}

function installFromDirectory(sourceDirectory) {
  const source = resolve(sourceDirectory);
  if (source === resolve(destination)) {
    console.error('[native-runtime] local source and installation destination must differ');
    process.exit(1);
  }
  if (!compatible(join(source, 'libmpv.2.dylib'))) {
    console.error(`[native-runtime] incompatible local runtime: ${source}`);
    process.exit(1);
  }
  const staging = `${destination}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
  syncTauriFrameworks();
  console.log(`[native-runtime] installed local runtime from ${source}`);
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log(`[native-runtime] no Native DASH runtime is published for ${process.platform}/${process.arch}`);
  process.exit(0);
}
const fromIndex = process.argv.indexOf('--from');
if (fromIndex >= 0) {
  const source = process.argv[fromIndex + 1];
  if (!source) {
    console.error('[native-runtime] --from requires a runtime directory');
    process.exit(2);
  }
  installFromDirectory(source);
  process.exit(0);
}
if (compatible(library) && !process.argv.includes('--force')) {
  syncTauriFrameworks();
  console.log(`[native-runtime] ${version} is ready`);
  process.exit(0);
}

mkdirSync(downloadCache, { recursive: true });
const archive = join(downloadCache, asset);
const checksumFile = `${archive}.sha256`;
console.log(`[native-runtime] downloading ${version}`);
run('curl', ['-fL', '--retry', '3', '-o', archive, `${releaseBase}/${asset}`]);
run('curl', ['-fL', '--retry', '3', '-o', checksumFile, `${releaseBase}/${asset}.sha256`]);

const expected = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (!expected || expected !== actual) {
  console.error(`[native-runtime] checksum mismatch: expected=${expected || '(missing)'} actual=${actual}`);
  process.exit(1);
}

const staging = `${destination}.new`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
run('tar', ['-xzf', archive, '-C', staging]);
if (!compatible(join(staging, 'libmpv.2.dylib'))) {
  console.error('[native-runtime] downloaded artifact does not provide RDPKT006/YNOIMSC1');
  process.exit(1);
}
rmSync(destination, { recursive: true, force: true });
renameSync(staging, destination);
syncTauriFrameworks();
console.log(`[native-runtime] installed ${version} in ${destination}`);
