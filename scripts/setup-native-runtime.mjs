import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = 'v0.2.0';
const destination = join(root, 'packages/app/src-tauri/native-dash-libmpv');
const releaseBase = `https://github.com/CharmingCheung/ynotv-native/releases/download/${version}`;

const platform = (() => {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      id: 'macos-arm64', archive: `ynotv-native-macos-arm64-${version}.tar.gz`,
      library: 'libmpv.2.dylib', required: ['libmpv.dylib', 'libplacebo.360.dylib', 'cenc_component_producer'],
    };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      id: 'windows-x64', archive: `ynotv-native-windows-x64-${version}.zip`,
      library: 'libmpv-2.dll', required: ['mpv.lib', 'cenc_component_producer.exe'],
    };
  }
  return null;
})();

function compatible(directory, enforceVersion = true) {
  if (!platform) return false;
  const library = join(directory, platform.library);
  if (!existsSync(library) || platform.required.some(name => !existsSync(join(directory, name)))) return false;
  const bytes = readFileSync(library);
  if (!bytes.includes(Buffer.from('RDPKT006')) || !bytes.includes(Buffer.from('YNOIMSC1'))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    return (!enforceVersion || typeof manifest.version === 'string') && manifest.platform === platform.id;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function syncRuntime() {
  if (process.platform === 'darwin') {
    const frameworks = join(root, 'packages/app/src-tauri/target/Frameworks');
    mkdirSync(frameworks, { recursive: true });
    for (const name of ['libmpv.2.dylib', 'libplacebo.360.dylib']) {
      const source = join(destination, name);
      const target = join(frameworks, name);
      if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue;
      rmSync(target, { force: true });
      copyFileSync(source, target);
    }
    return;
  }

  // Keep the legacy directory populated too: Cargo checks it when invoked
  // outside the pnpm launcher, while normal development links the cache above.
  const libmpv = join(root, 'packages/app/src-tauri/libmpv');
  mkdirSync(libmpv, { recursive: true });
  for (const name of readdirSync(destination)) {
    if (extname(name).toLowerCase() === '.dll' || name === 'mpv.lib') {
      copyFileSync(join(destination, name), join(libmpv, name));
    }
  }
}

function installFromDirectory(sourceDirectory) {
  const source = resolve(sourceDirectory);
  if (source === resolve(destination)) {
    console.error('[native-runtime] local source and installation destination must differ');
    process.exit(1);
  }
  if (!compatible(source, false)) {
    console.error(`[native-runtime] incompatible local runtime for ${platform.id}: ${source}`);
    process.exit(1);
  }
  const staging = `${destination}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
  syncRuntime();
  console.log(`[native-runtime] installed local ${platform.id} runtime from ${source}`);
}

if (!platform) {
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

if (compatible(destination) && !process.argv.includes('--force')) {
  syncRuntime();
  console.log(`[native-runtime] ${version} (${platform.id}) is ready`);
  process.exit(0);
}

const downloadCache = join(root, '.cache/ynotv-native', version);
mkdirSync(downloadCache, { recursive: true });
const archive = join(downloadCache, platform.archive);
const checksumFile = `${archive}.sha256`;
console.log(`[native-runtime] downloading ${version} (${platform.id})`);
run('curl', ['-fL', '--retry', '3', '-o', archive, `${releaseBase}/${platform.archive}`]);
run('curl', ['-fL', '--retry', '3', '-o', checksumFile, `${releaseBase}/${platform.archive}.sha256`]);

const expected = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (!expected || expected !== actual) {
  console.error(`[native-runtime] checksum mismatch: expected=${expected || '(missing)'} actual=${actual}`);
  process.exit(1);
}

const staging = `${destination}.new`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
run('tar', ['-xf', archive, '-C', staging]);
if (!compatible(staging)) {
  console.error(`[native-runtime] downloaded ${platform.id} artifact does not provide RDPKT006/YNOIMSC1`);
  process.exit(1);
}
rmSync(destination, { recursive: true, force: true });
renameSync(staging, destination);
syncRuntime();
console.log(`[native-runtime] installed ${version} (${platform.id}) in ${destination}`);
