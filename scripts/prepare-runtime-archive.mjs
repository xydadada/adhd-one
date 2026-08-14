import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pruneRuntime } from './prune-runtime.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'runtime');
const staging = path.join(root, 'vendor', 'runtime-staging');
const archive = path.join(root, 'vendor', 'dsh-runtime.7z');
const tarball = path.join(root, 'vendor', 'dsh-runtime.tar');
const marker = path.join(root, 'runtime', 'package-lock.json');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const [archiveInfo, markerInfo, scriptInfo] = await Promise.all([fs.stat(archive).catch(() => undefined), fs.stat(marker), fs.stat(fileURLToPath(import.meta.url))]);
if (archiveInfo && archiveInfo.mtimeMs >= Math.max(markerInfo.mtimeMs, scriptInfo.mtimeMs)) {
  console.log('Using cached pruned DSH runtime archive.');
  process.exit(0);
}

await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
await Promise.all([
  fs.cp(path.join(source, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true }),
  fs.cp(path.join(source, 'bin'), path.join(staging, 'bin'), { recursive: true }),
  fs.copyFile(path.join(source, 'package.json'), path.join(staging, 'package.json')),
  fs.copyFile(marker, path.join(staging, 'package-lock.json'))
]);
await pruneRuntime(staging);
await Promise.all([fs.rm(archive, { force: true }), fs.rm(tarball, { force: true })]);
console.log('Creating sequential tar stream for the DSH runtime.');
await execFileAsync('tar.exe', ['-cf', tarball, '.'], { cwd: staging, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
console.log('Compressing the cached DSH runtime tar with multithreaded LZMA2.');
await execFileAsync(sevenZip, ['a', '-t7z', '-mx=5', '-m0=LZMA2', '-mmt=on', archive, path.basename(tarball)], { cwd: path.dirname(tarball), windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
await fs.rm(staging, { recursive: true, force: true });
await fs.rm(tarball, { force: true });
console.log(`Prepared ${path.relative(root, archive)}.`);
