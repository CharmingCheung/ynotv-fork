import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'packages/app/src-tauri');
const nativeRuntime = join(tauri, 'native-dash-libmpv');
const output = join(tauri, 'macos-bundle-runtime');
const frameworks = join(output, 'Frameworks');
const stagedBin = join(output, 'bin');
const triple = 'aarch64-apple-darwin';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log(`[macos-runtime] skipped on ${process.platform}/${process.arch}`);
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`[macos-runtime] ${command} exited with status ${result.status ?? 1}`);
  }
  return result.stdout ?? '';
}

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`[macos-runtime] required file is missing: ${path}`);
  return path;
}

function dylibId(path) {
  const lines = run('otool', ['-D', path]).trim().split('\n');
  return lines.length > 1 ? lines[1].trim() : null;
}

function dependencies(path) {
  return run('otool', ['-L', path])
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(' (compatibility version')[0])
    .filter(Boolean);
}

function rpaths(path) {
  const lines = run('otool', ['-l', path]).split('\n');
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

function isSystemDependency(path) {
  return path.startsWith('/System/Library/') || path.startsWith('/usr/lib/');
}

function isBuildMachinePath(path) {
  return path.startsWith('/') && !isSystemDependency(path);
}

function expandSpecialPath(path, loader, executable) {
  if (path === '@loader_path') return dirname(loader);
  if (path.startsWith('@loader_path/')) return join(dirname(loader), path.slice('@loader_path/'.length));
  if (path === '@executable_path') return dirname(executable);
  if (path.startsWith('@executable_path/')) return join(dirname(executable), path.slice('@executable_path/'.length));
  return path;
}

function resolveDependency(dependency, loader, executable) {
  if (dependency.startsWith('/')) return existsSync(dependency) ? realpathSync(dependency) : null;
  if (dependency.startsWith('@loader_path') || dependency.startsWith('@executable_path')) {
    const candidate = expandSpecialPath(dependency, loader, executable);
    return existsSync(candidate) ? realpathSync(candidate) : null;
  }
  if (dependency.startsWith('@rpath/')) {
    const suffix = dependency.slice('@rpath/'.length);
    for (const entry of rpaths(loader)) {
      const directory = expandSpecialPath(entry, loader, executable);
      const candidate = join(directory, suffix);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    for (const directory of [dirname(loader), '/opt/homebrew/lib', '/usr/local/lib']) {
      const candidate = join(directory, suffix);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  return null;
}

rmSync(output, { recursive: true, force: true });
mkdirSync(frameworks, { recursive: true });
mkdirSync(stagedBin, { recursive: true });

const mainLibraries = [
  requireFile(join(nativeRuntime, 'libmpv.2.dylib')),
  requireFile(join(nativeRuntime, 'libplacebo.360.dylib')),
];
const producerSource = requireFile(join(nativeRuntime, 'cenc_component_producer'));
const ffmpegSource = requireFile(join(tauri, 'bin', `ffmpeg-${triple}`));
const producerTarget = join(output, 'cenc_component_producer');
const ffmpegTarget = join(stagedBin, `ffmpeg-${triple}`);
const copiedSidecars = [];

for (const name of [`mpv-${triple}`, `yt-dlp-${triple}`]) {
  const source = requireFile(join(tauri, 'bin', name));
  const target = join(stagedBin, name);
  copyFileSync(source, target);
  copiedSidecars.push(target);
}
const mpvLibTarget = join(output, 'mpv-lib');
cpSync(join(tauri, 'bin', 'mpv-lib'), mpvLibTarget, { recursive: true });
copyFileSync(producerSource, producerTarget);
copyFileSync(ffmpegSource, ffmpegTarget);
chmodSync(producerTarget, 0o755);
chmodSync(ffmpegTarget, 0o755);

const queue = [];
const stagedLibraries = new Map();
const libraryRewrites = new Map();

function enqueueLibrary(source, targetName = basename(source), requestedBy = source) {
  const canonical = realpathSync(source);
  const existing = stagedLibraries.get(targetName);
  if (existing) {
    if (!readFileSync(existing.source).equals(readFileSync(canonical))) {
      throw new Error(`[macos-runtime] dylib name collision for ${targetName}: ${existing.source} and ${canonical}`);
    }
    return;
  }
  const target = join(frameworks, targetName);
  copyFileSync(canonical, target);
  stagedLibraries.set(targetName, { source: canonical, target, requestedBy });
  queue.push(targetName);
}

for (const library of mainLibraries) enqueueLibrary(library);

function collectDependencies(source, executable, rewrites) {
  const id = dylibId(source);
  for (const dependency of dependencies(source)) {
    if (dependency === id || isSystemDependency(dependency)) continue;
    const resolved = resolveDependency(dependency, source, executable);
    if (!resolved) {
      throw new Error(`[macos-runtime] cannot resolve ${dependency} required by ${source}`);
    }
    const targetName = basename(dependency);
    enqueueLibrary(resolved, targetName, source);
    rewrites.set(dependency, targetName);
  }
}

for (let index = 0; index < queue.length; index += 1) {
  const name = queue[index];
  const entry = stagedLibraries.get(name);
  const rewrites = new Map();
  collectDependencies(entry.source, entry.source, rewrites);
  libraryRewrites.set(name, rewrites);
}

const producerRewrites = new Map();
collectDependencies(producerSource, producerSource, producerRewrites);
const ffmpegRewrites = new Map();
collectDependencies(ffmpegSource, ffmpegSource, ffmpegRewrites);

// The executable roots may add more libraries, whose own dependency closure
// must be traversed after the initial library queue has already completed.
for (let index = 0; index < queue.length; index += 1) {
  const name = queue[index];
  if (libraryRewrites.has(name)) continue;
  const entry = stagedLibraries.get(name);
  const rewrites = new Map();
  collectDependencies(entry.source, entry.source, rewrites);
  libraryRewrites.set(name, rewrites);
}

for (const [name, rewrites] of libraryRewrites) {
  const target = stagedLibraries.get(name).target;
  const args = [];
  for (const [oldPath, dependencyName] of rewrites) {
    args.push('-change', oldPath, `@loader_path/${dependencyName}`);
  }
  for (const oldPath of new Set(rpaths(stagedLibraries.get(name).source).filter(isBuildMachinePath))) {
    args.push('-delete_rpath', oldPath);
  }
  args.push('-id', `@rpath/${name}`);
  run('install_name_tool', [...args, target]);
  run('codesign', ['--force', '--sign', '-', target]);
}

function rewriteExecutable(source, target, rewrites) {
  const args = [];
  for (const [oldPath, dependencyName] of rewrites) {
    args.push('-change', oldPath, `@loader_path/../Frameworks/${dependencyName}`);
  }
  for (const oldPath of new Set(rpaths(source).filter(isBuildMachinePath))) {
    args.push('-delete_rpath', oldPath);
  }
  if (args.length) run('install_name_tool', [...args, target]);
  run('codesign', ['--force', '--sign', '-', target]);
}

rewriteExecutable(producerSource, producerTarget, producerRewrites);
rewriteExecutable(ffmpegSource, ffmpegTarget, ffmpegRewrites);

function filesBelow(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const child = join(directory, name);
    if (statSync(child).isDirectory()) result.push(...filesBelow(child));
    else result.push(child);
  }
  return result;
}

function removeBuildRpaths(target) {
  if (!run('file', ['-b', target]).includes('Mach-O')) return;
  const args = [];
  for (const oldPath of new Set(rpaths(target).filter(isBuildMachinePath))) {
    args.push('-delete_rpath', oldPath);
  }
  if (args.length) run('install_name_tool', [...args, target]);
  run('codesign', ['--force', '--sign', '-', target]);
}

for (const target of [...copiedSidecars, ...filesBelow(mpvLibTarget)]) removeBuildRpaths(target);

const manifest = {
  schema: 1,
  platform: 'macos-arm64',
  requiresHomebrew: false,
  frameworks: [...stagedLibraries.keys()].sort(),
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[macos-runtime] staged ${manifest.frameworks.length} dylibs; end users do not need Homebrew`);
