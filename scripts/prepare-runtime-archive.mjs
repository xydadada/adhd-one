import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import koffi from 'koffi';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pruneRuntime } from './prune-runtime.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const source = path.join(root, 'runtime');
const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
const closure = path.join(vendor, 'runtime-closure');
const staging = path.join(vendor, `runtime-closure.${token}.next`);
const backup = path.join(vendor, `runtime-closure.${token}.previous`);
const archive = path.join(vendor, 'dsh-runtime.7z');
const archiveNext = path.join(vendor, `dsh-runtime.${token}.next`);
const stateFile = path.join(vendor, 'runtime-archive-state.json');
const stateNext = path.join(vendor, `runtime-archive-state.${token}.next`);
const lockDirectory = path.join(vendor, '.prepare-runtime-archive.lock');
const runtimeLock = path.join(source, 'package-lock.json');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const kernel = koffi.load('kernel32.dll');
const moveFileExW = kernel.func('int __stdcall MoveFileExW(str16, str16, uint32)');

async function sha256File(filename) {
  const hash = createHash('sha256');
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function hashInput(hash, filename) {
  hash.update(path.relative(root, filename).replaceAll('\\', '/'));
  hash.update('\0');
  hash.update(await fs.readFile(filename));
  hash.update('\0');
}

async function hashTree(hash, directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await hashTree(hash, filename);
    else if (entry.isFile()) await hashInput(hash, filename);
    else throw new Error('RUNTIME_ARCHIVE_INPUT_LINK_REFUSED');
  }
}

async function acquireBuildLock() {
  try { await fs.mkdir(lockDirectory); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await fs.stat(lockDirectory);
    if (Date.now() - info.mtimeMs <= 30 * 60_000) throw new Error('RUNTIME_ARCHIVE_PREPARE_LOCKED');
    await fs.rm(lockDirectory, { recursive: true, force: true });
    await fs.mkdir(lockDirectory);
  }
  await fs.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' });
}

function atomicReplace(sourcePath, destinationPath, code) {
  if (!moveFileExW(sourcePath, destinationPath, 0x1 | 0x8)) throw new Error(code);
}

await acquireBuildLock();
try {
  const fingerprint = createHash('sha256');
  for (const input of [
    runtimeLock,
    path.join(source, 'package.json'),
    path.join(root, 'package-lock.json'),
    path.join(vendor, 'node', 'node.exe'),
    path.join(vendor, 'node', 'LICENSE'),
    sevenZip,
    fileURLToPath(import.meta.url),
    path.join(root, 'scripts', 'prune-runtime.mjs'),
    path.join(root, 'scripts', 'prepare-dsh-runtime.mjs'),
    path.join(root, 'scripts', 'prepare-node-runtime.mjs')
  ]) await hashInput(fingerprint, input);
  await hashTree(fingerprint, path.join(source, 'bin'));
  const expectedFingerprint = fingerprint.digest('hex');

  const cachedState = await fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(() => undefined);
  const cachedFingerprint = await fs.readFile(path.join(closure, '.prepare-fingerprint'), 'utf8').catch(() => undefined);
  const archiveInfo = await fs.stat(archive).catch(() => undefined);
  const closureInfo = await fs.stat(path.join(closure, 'dsh-runtime', 'package-lock.json')).catch(() => undefined);
  if (cachedState?.schemaVersion === 1
    && cachedState.inputFingerprint === expectedFingerprint
    && /^[a-f0-9]{64}$/u.test(cachedState.archiveSha256)
    && cachedFingerprint?.trim() === expectedFingerprint
    && archiveInfo?.isFile() && archiveInfo.size > 0 && closureInfo?.isFile()
    && await sha256File(archive) === cachedState.archiveSha256) {
    console.log('Using cached pruned DSH runtime closure and verified archive.');
    process.exitCode = 0;
  } else {
    await Promise.all([
      fs.mkdir(path.join(staging, 'dsh-runtime'), { recursive: true }),
      fs.mkdir(path.join(staging, 'node-runtime'), { recursive: true })
    ]);
    await Promise.all([
      fs.cp(path.join(source, 'node_modules'), path.join(staging, 'dsh-runtime', 'node_modules'), { recursive: true }),
      fs.cp(path.join(source, 'bin'), path.join(staging, 'dsh-runtime', 'bin'), { recursive: true }),
      fs.copyFile(path.join(source, 'package.json'), path.join(staging, 'dsh-runtime', 'package.json')),
      fs.copyFile(runtimeLock, path.join(staging, 'dsh-runtime', 'package-lock.json')),
      fs.copyFile(path.join(vendor, 'node', 'node.exe'), path.join(staging, 'node-runtime', 'node.exe')),
      fs.copyFile(path.join(vendor, 'node', 'LICENSE'), path.join(staging, 'node-runtime', 'LICENSE'))
    ]);
    await pruneRuntime(path.join(staging, 'dsh-runtime'));
    await fs.writeFile(path.join(staging, '.prepare-fingerprint'), `${expectedFingerprint}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log('Compressing the pruned DSH runtime with multithreaded LZMA2.');
    await execFileAsync(sevenZip, ['a', '-t7z', '-mx=5', '-m0=LZMA2', '-mmt=on', archiveNext, '.\\*'], {
      cwd: staging, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    const archiveSha256 = await sha256File(archiveNext);
    await fs.writeFile(stateNext, `${JSON.stringify({ schemaVersion: 1, inputFingerprint: expectedFingerprint, archiveSha256 })}\n`, { encoding: 'utf8', flag: 'wx' });

    let backedUp = false;
    if (await fs.stat(closure).then(info => info.isDirectory()).catch(() => false)) {
      await fs.rename(closure, backup);
      backedUp = true;
    }
    try {
      await fs.rename(staging, closure);
      atomicReplace(archiveNext, archive, 'RUNTIME_ARCHIVE_ATOMIC_REPLACE_FAILED');
      atomicReplace(stateNext, stateFile, 'RUNTIME_ARCHIVE_STATE_REPLACE_FAILED');
    } catch (error) {
      await fs.rm(closure, { recursive: true, force: true }).catch(() => undefined);
      if (backedUp) await fs.rename(backup, closure).catch(() => undefined);
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true });
    console.log(`Prepared ${path.relative(root, closure)} and ${path.relative(root, archive)}.`);
  }
} finally {
  await Promise.all([
    fs.rm(staging, { recursive: true, force: true }),
    fs.rm(backup, { recursive: true, force: true }),
    fs.rm(archiveNext, { force: true }),
    fs.rm(stateNext, { force: true })
  ]).catch(() => undefined);
  await fs.rm(lockDirectory, { recursive: true, force: true });
}
