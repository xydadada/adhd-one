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
const bin = path.join(runtime, 'bin');

try {
  await fs.access(dshEntry);
} catch {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this script through npm.');
  await fs.access(lockfile).catch(error => { throw new Error('Runtime lockfile is required.', { cause: error }); });
  console.log('Installing the isolated DSH runtime with npm ci.');
  await execFileAsync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--prefix', runtime], { cwd: root, windowsHide: true });
}

await fs.mkdir(bin, { recursive: true });
await Promise.all([
  fs.writeFile(path.join(bin, 'node.cmd'), '@"%ADHD_NODE_EXE%" %*\r\n', 'utf8'),
  fs.writeFile(path.join(bin, 'pnpm.cmd'), '@"%ADHD_NODE_EXE%" "%~dp0..\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n', 'utf8')
]);
console.log('Prepared pre-expanded isolated DSH runtime.');
