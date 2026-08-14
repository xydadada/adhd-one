import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const lockfile = path.join(runtime, 'package-lock.json');
const dshEntry = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const archive = path.join(root, 'vendor', 'dsh-runtime.7z');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

try {
  await fs.access(dshEntry);
} catch {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this script through npm.');
  const command = await fs.stat(lockfile).then(() => 'ci').catch(() => 'install');
  console.log(`Installing the isolated DSH runtime with npm ${command}.`);
  await execFileAsync(process.execPath, [npmCli, command, '--prefix', runtime], { cwd: root, windowsHide: true });
}

const [archiveStat, lockStat] = await Promise.all([
  fs.stat(archive).catch(() => null),
  fs.stat(lockfile)
]);
if (archiveStat && archiveStat.mtimeMs >= lockStat.mtimeMs) {
  console.log('Using cached DSH runtime archive.');
  process.exit(0);
}

await fs.mkdir(path.dirname(archive), { recursive: true });
await fs.rm(archive, { force: true });
console.log('Compressing the isolated DSH runtime.');
await execFileAsync(sevenZip, ['a', '-t7z', '-mx=5', archive, 'node_modules', 'package.json', 'package-lock.json'], {
  cwd: runtime,
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024
});
console.log(`Prepared ${path.relative(root, archive)}.`);
