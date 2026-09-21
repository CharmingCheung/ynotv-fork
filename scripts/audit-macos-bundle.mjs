import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultApp = join(root, 'packages/app/src-tauri/target/release/bundle/macos/ynoTV.app');
const defaultArchive = join(root, 'packages/app/src-tauri/target/release/bundle/macos/ynoTV.app.tar.gz');
const dmgDirectory = join(root, 'packages/app/src-tauri/target/release/bundle/dmg');
let app = process.argv[2] ? resolve(process.argv[2]) : defaultApp;
let temporary;
let mountedVolume;

if (!existsSync(app) && existsSync(dmgDirectory) && !process.argv[2]) {
  const dmgs = readdirSync(dmgDirectory)
    .filter(name => name.endsWith('.dmg'))
    .map(name => join(dmgDirectory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (dmgs[0]) {
    mountedVolume = mkdtempSync(join(tmpdir(), 'ynotv-bundle-audit-mount-'));
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountedVolume, dmgs[0]], {
      input: 'Y\n',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    app = join(mountedVolume, 'ynoTV.app');
  }
}
if (!existsSync(app) && existsSync(defaultArchive) && !process.argv[2]) {
  temporary = mkdtempSync(join(tmpdir(), 'ynotv-bundle-audit-'));
  execFileSync('tar', ['-xzf', defaultArchive, '-C', temporary], { stdio: 'inherit' });
  app = join(temporary, 'ynoTV.app');
}
if (!existsSync(app)) {
  console.error(`[bundle-audit] app bundle not found: ${app}`);
  process.exit(2);
}

function filesBelow(path) {
  const result = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) result.push(...filesBelow(child));
    else result.push(child);
  }
  return result;
}

const forbiddenPrefixes = ['/opt/homebrew/', '/usr/local/', '/opt/local/', '/private/tmp/', '/var/folders/'];
const failures = [];
for (const file of filesBelow(app)) {
  let kind;
  try {
    kind = execFileSync('file', ['-b', file], { encoding: 'utf8' });
  } catch {
    continue;
  }
  if (!kind.includes('Mach-O')) continue;

  const linked = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes(' (compatibility version'))
    .map(line => line.trim().split(' (compatibility')[0]);
  const forbidden = linked.filter(path => forbiddenPrefixes.some(prefix => path.startsWith(prefix)) || path.startsWith(`${root}/`));
  if (forbidden.length) failures.push({ file, forbidden });
}

if (mountedVolume) execFileSync('hdiutil', ['detach', mountedVolume], { stdio: 'ignore' });
if (temporary) rmSync(temporary, { recursive: true, force: true });
if (mountedVolume) rmSync(mountedVolume, { recursive: true, force: true });

if (failures.length) {
  console.error('[bundle-audit] non-portable absolute dylib references found:');
  for (const { file, forbidden } of failures) {
    console.error(`  ${basename(file)}`);
    for (const dependency of forbidden) console.error(`    ${dependency}`);
  }
  process.exit(1);
}

console.log('[bundle-audit] PASS: no Homebrew, MacPorts, temporary, or workspace dylib paths found');
