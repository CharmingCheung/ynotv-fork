import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = join(root, '..', 'ynotv-native');
const windows = process.platform === 'win32';
const command = windows ? 'powershell.exe' : 'bash';
const args = windows
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(nativeRoot, 'scripts', 'dev-windows.ps1'), root]
  : [join(nativeRoot, 'scripts', 'dev-macos.sh'), root];

const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
