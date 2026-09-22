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

const failures = [];
const contents = join(app, 'Contents');
const frameworks = join(contents, 'Frameworks');
function rpaths(file) {
  const lines = execFileSync('otool', ['-l', file], { encoding: 'utf8' }).split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 6); cursor += 1) {
      const match = lines[cursor].trim().match(/^path (.+) \(offset \d+\)$/);
      if (match) {
        result.push(match[1]);
        break;
      }
    }
  }
  return result;
}
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
  const forbidden = linked.filter(path => path.startsWith('/') &&
    !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'));
  const missing = linked.filter(dependency => {
    if (dependency.startsWith('@loader_path/')) {
      return !existsSync(join(dirname(file), dependency.slice('@loader_path/'.length)));
    }
    if (dependency.startsWith('@executable_path/')) {
      return !existsSync(join(contents, 'MacOS', dependency.slice('@executable_path/'.length)));
    }
    if (dependency.startsWith('@rpath/')) {
      const name = dependency.slice('@rpath/'.length);
      return !existsSync(join(frameworks, name)) && !existsSync(join(dirname(file), name));
    }
    return false;
  });
  const forbiddenRpaths = rpaths(file).filter(path => path.startsWith('/') &&
    !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'));
  if (forbidden.length || missing.length || forbiddenRpaths.length) {
    failures.push({ file, forbidden, missing, forbiddenRpaths });
  }
}

if (mountedVolume) execFileSync('hdiutil', ['detach', mountedVolume], { stdio: 'ignore' });
if (temporary) rmSync(temporary, { recursive: true, force: true });
if (mountedVolume) rmSync(mountedVolume, { recursive: true, force: true });

if (failures.length) {
  console.error('[bundle-audit] non-portable or missing dylib references found:');
  for (const { file, forbidden, missing, forbiddenRpaths } of failures) {
    console.error(`  ${basename(file)}`);
    for (const dependency of forbidden) console.error(`    ${dependency}`);
    for (const dependency of missing) console.error(`    MISSING: ${dependency}`);
    for (const path of forbiddenRpaths) console.error(`    RPATH: ${path}`);
  }
  process.exit(1);
}

console.log('[bundle-audit] PASS: no missing, Homebrew, MacPorts, temporary, or workspace dylib references found');
