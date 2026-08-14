import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseSevenZipSlt } from '../out/archive-inspection.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'runtime');
const archive = path.join(root, 'vendor', 'dsh-runtime.7z');
const bundledNode = path.join(root, 'vendor', 'node', 'node.exe');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const dshPackageName = '@deepseek-ai/dsh';
const requiredPackageNames = [
  '@deepseek-ai/cordis-plugin-group',
  dshPackageName,
  '@deepseek-ai/dsh-subprocess-local',
  'node-pty',
  'pnpm'
];

function fail(reason) {
  throw new Error(`RUNTIME_ARCHIVE_CLOSURE_MISMATCH: ${reason}`);
}

function normalizeVersionOutput(value) {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function lockPathFor(packageName) {
  return `node_modules/${packageName}`;
}

function packageNameForLockPath(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function readPackageJson(runtimePath, lockPath) {
  const filename = path.join(runtimePath, lockPath, 'package.json');
  try {
    return await readJson(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireFile(runtimePath, relativePath) {
  const filename = path.join(runtimePath, relativePath);
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size === 0) fail(`missing required file: ${relativePath}`);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`missing required file: ${relativePath}`);
    throw error;
  }
}

const runtimeManifest = await readJson(path.join(runtimeRoot, 'package.json'));
const runtimeLock = await readJson(path.join(runtimeRoot, 'package-lock.json'));
const lockPackages = runtimeLock.packages;
const lockRoot = lockPackages?.[''];
if (runtimeLock.lockfileVersion !== 3 || !lockPackages || !lockRoot || !runtimeManifest.dependencies) {
  fail('pinned runtime metadata is incomplete');
}
if (runtimeManifest.name !== lockRoot.name || runtimeManifest.version !== lockRoot.version) {
  fail('runtime package metadata does not match its lockfile root');
}

for (const [packageName, version] of Object.entries(runtimeManifest.dependencies)) {
  if (lockRoot.dependencies?.[packageName] !== version) fail(`root dependency mismatch: ${packageName}`);
}
for (const packageName of Object.keys(lockRoot.dependencies ?? {})) {
  if (runtimeManifest.dependencies[packageName] === undefined) fail(`lockfile has undeclared root dependency: ${packageName}`);
}

const dshLockPath = lockPathFor(dshPackageName);
const pnpmLockPath = lockPathFor('pnpm');
const dshLockEntry = lockPackages[dshLockPath];
const pnpmLockEntry = lockPackages[pnpmLockPath];
const expectedDshVersion = runtimeManifest.dependencies[dshPackageName];
const expectedPnpmVersion = runtimeManifest.dependencies.pnpm;
for (const [packageName, lockPath, expectedVersion, entry] of [
  [dshPackageName, dshLockPath, expectedDshVersion, dshLockEntry],
  ['pnpm', pnpmLockPath, expectedPnpmVersion, pnpmLockEntry]
]) {
  if (!entry || entry.version !== expectedVersion || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') {
    fail(`pinned package metadata is incomplete: ${packageName}`);
  }
}

const sourceClosure = new Map();
for (const [lockPath, entry] of Object.entries(lockPackages)) {
  if (!lockPath.startsWith('node_modules/')) continue;
  if (entry.link) continue;
  if (typeof entry.version !== 'string' || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') {
    fail(`lock integrity metadata is incomplete: ${lockPath}`);
  }
  const packageValue = await readPackageJson(runtimeRoot, lockPath);
  if (!packageValue) {
    if (entry.optional) continue;
    fail(`required locked package is absent from source runtime: ${lockPath}`);
  }
  if (packageValue.name !== packageNameForLockPath(lockPath) || packageValue.version !== entry.version) {
    fail(`source package does not match lockfile: ${lockPath}`);
  }
  sourceClosure.set(lockPath, { entry, packageValue });
}
for (const packageName of requiredPackageNames) {
  if (!sourceClosure.has(lockPathFor(packageName))) fail(`required package is absent from source runtime: ${packageName}`);
}

const expectedNodeVersion = normalizeVersionOutput((await execFileAsync(bundledNode, ['--version'], {
  windowsHide: true,
  timeout: 10_000
})).stdout);
if (!expectedNodeVersion) fail('pinned Node runtime did not report a version');

let staging;
try {
  const listing = await execFileAsync(sevenZip, ['l', '-slt', '-sccUTF-8', archive], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer'
  });
  parseSevenZipSlt(listing.stdout);
  staging = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-archive-'));
  await execFileAsync(sevenZip, ['x', '-y', '-sccUTF-8', `-o${staging}`, archive], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  });

  const archiveRuntimeRoot = path.join(staging, 'dsh-runtime');
  const archiveManifest = await readJson(path.join(archiveRuntimeRoot, 'package.json'));
  const archiveLock = await readJson(path.join(archiveRuntimeRoot, 'package-lock.json'));
  if (JSON.stringify(archiveManifest) !== JSON.stringify(runtimeManifest)) fail('archive runtime package metadata differs from source');
  if (JSON.stringify(archiveLock) !== JSON.stringify(runtimeLock)) fail('archive lockfile differs from source closure');

  for (const [lockPath, { entry: sourceEntry }] of sourceClosure) {
    const packageValue = await readPackageJson(archiveRuntimeRoot, lockPath);
    if (!packageValue) fail(`locked package is absent from archive: ${lockPath}`);
    if (packageValue.name !== packageNameForLockPath(lockPath) || packageValue.version !== sourceEntry.version) {
      fail(`archive package does not match lockfile: ${lockPath}`);
    }
    if (archiveLock.packages[lockPath].integrity !== sourceEntry.integrity) {
      fail(`archive package integrity differs from lockfile: ${lockPath}`);
    }
  }

  for (const relativePath of [
    'node-runtime/node.exe',
    'dsh-runtime/package.json',
    'dsh-runtime/package-lock.json',
    'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'dsh-runtime/node_modules/@deepseek-ai/dsh-subprocess-local/package.json',
    'dsh-runtime/node_modules/node-pty/package.json',
    'dsh-runtime/node_modules/pnpm/bin/pnpm.cjs'
  ]) await requireFile(staging, relativePath);

  const node = path.join(staging, 'node-runtime', 'node.exe');
  const entry = path.join(archiveRuntimeRoot, dshLockPath, 'lib', 'bin.js');
  const nodeVersion = normalizeVersionOutput((await execFileAsync(node, ['--version'], {
    windowsHide: true,
    timeout: 10_000
  })).stdout);
  const dshVersion = normalizeVersionOutput((await execFileAsync(node, [entry, '--version'], {
    windowsHide: true,
    timeout: 20_000,
    env: {
      ...process.env,
      DSH_HOME: path.join(staging, 'home'),
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1'
    }
  })).stdout);
  if (nodeVersion !== expectedNodeVersion) fail(`Node version mismatch: expected ${expectedNodeVersion}, got ${nodeVersion}`);
  if (dshVersion !== expectedDshVersion) fail(`DSH version mismatch: expected ${expectedDshVersion}, got ${dshVersion}`);
  console.log(`RUNTIME_ARCHIVE_OK node=${nodeVersion} dsh=${dshVersion}`);
} finally {
  if (staging) await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
