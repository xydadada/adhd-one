import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NtExecutable } from 'pe-library';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
export const WIN11_RUNNER_SCHEMA_VERSION = 1;
export const WIN11_RUNNER_TOOL = 'adhd-one-win11-runner';
export const WIN11_RUNNER_MANIFEST_FILE = 'runner-manifest.json';
export const WIN11_RUNNER_NODE_FILE = 'node.exe';

// Keep this list explicit. A runner must not accidentally inherit a new script
// or a repository-local development file just because it was added to e2e/.
export const FIXED_E2E_SCRIPTS = Object.freeze([
  'scripts/e2e/packaged.mjs',
  'scripts/e2e/run-packaged-suite.mjs',
  'scripts/e2e/verify-win11-evidence.mjs',
  'scripts/e2e/win11-evidence-builder.mjs',
  'scripts/e2e/collect-win11-evidence.mjs',
  'scripts/e2e/windows-process-cpu.mjs',
  'scripts/e2e/installed.ps1',
  'scripts/verify-evidence.mjs',
  'scripts/e2e/win11-host-proof.mjs',
  'scripts/e2e/win11-matrix.ps1'
]);

export const RUNNER_DEPENDENCY_ROOTS = Object.freeze([
  'playwright',
  'playwright-core',
  '@electron/asar',
  '@deepseek-ai/dsh-llm-mock-server'
]);

export const WIN11_RUNNER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'WIN11_RUNNER_INVALID_ARGUMENT',
  OUTPUT_REJECTED: 'WIN11_RUNNER_OUTPUT_REJECTED',
  OUTPUT_NOT_DIRECTORY: 'WIN11_RUNNER_OUTPUT_NOT_DIRECTORY',
  OUTPUT_REPARSE: 'WIN11_RUNNER_OUTPUT_REPARSE_REJECTED',
  NODE_INVALID: 'WIN11_RUNNER_NODE_INVALID',
  NODE_INSIDE_OUTPUT: 'WIN11_RUNNER_NODE_INSIDE_OUTPUT',
  PACKAGE_LOCK_INVALID: 'WIN11_RUNNER_PACKAGE_LOCK_INVALID',
  PACKAGE_LOCK_READ_FAILED: 'WIN11_RUNNER_PACKAGE_LOCK_READ_FAILED',
  PACKAGE_MISSING: 'WIN11_RUNNER_PACKAGE_MISSING',
  PACKAGE_ENTRY_INVALID: 'WIN11_RUNNER_PACKAGE_ENTRY_INVALID',
  PACKAGE_SOURCE_MISSING: 'WIN11_RUNNER_PACKAGE_SOURCE_MISSING',
  SOURCE_MISSING: 'WIN11_RUNNER_SOURCE_MISSING',
  SOURCE_REPARSE: 'WIN11_RUNNER_SOURCE_REPARSE_REJECTED',
  SOURCE_UNSUPPORTED: 'WIN11_RUNNER_SOURCE_UNSUPPORTED',
  SOURCE_COPY_FAILED: 'WIN11_RUNNER_SOURCE_COPY_FAILED',
  MANIFEST_FAILED: 'WIN11_RUNNER_MANIFEST_FAILED',
  PUBLISH_FAILED: 'WIN11_RUNNER_PUBLISH_FAILED',
  PUBLISH_ROLLBACK_FAILED: 'WIN11_RUNNER_PUBLISH_ROLLBACK_FAILED',
  BACKUP_CLEANUP_FAILED: 'WIN11_RUNNER_BACKUP_CLEANUP_FAILED',
  CLI_USAGE: 'WIN11_RUNNER_CLI_USAGE'
});

const NODE_MODULES_LOCK_PREFIX = 'node_modules/';
const SHA256 = /^[a-f0-9]{64}$/u;

export class Win11RunnerError extends Error {
  constructor(code, detail) {
    const safeDetail = typeof detail === 'string'
      && detail.length > 0
      && !path.isAbsolute(detail)
      && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(detail)
      && !detail.includes('\\')
      ? detail
      : undefined;
    super(safeDetail ? `${code}: ${safeDetail}` : code);
    this.name = 'Win11RunnerError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Win11RunnerError(code, detail);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireAbsolutePath(value, code = WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) fail(code);
  return path.resolve(value);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  if (process.platform !== 'win32') return resolved;

  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map(segment => segment.replace(/[ .]+$/u, '').toLowerCase());
  return `${root.toLowerCase()}${segments.length > 0 ? `\\${segments.join('\\')}` : ''}`;
}

function isSameOrWithin(candidate, parent) {
  const childKey = comparablePath(candidate);
  const parentKey = comparablePath(parent);
  return childKey === parentKey || childKey.startsWith(`${parentKey}${path.sep}`);
}

function normalizeRelativePath(value, code = WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) fail(code);
  const segments = normalized.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) fail(code);
  return segments.join('/');
}

function packageNameFromLockPath(lockPath) {
  const marker = lockPath.lastIndexOf(NODE_MODULES_LOCK_PREFIX);
  if (marker < 0) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, lockPath);
  return lockPath.slice(marker + NODE_MODULES_LOCK_PREFIX.length);
}

function validatePackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\\') || name.includes('..')) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  }
  const segments = name.split('/');
  if (segments.length === 2 && segments[0].startsWith('@')) {
    if (!segments[0].slice(1) || !segments[1]) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
    return name;
  }
  if (segments.length !== 1 || name.startsWith('@') || name.includes('/')) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  }
  return name;
}

function normalizeLockPath(value) {
  const normalized = normalizeRelativePath(value, WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  if (!normalized.startsWith(NODE_MODULES_LOCK_PREFIX)) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  const packageName = packageNameFromLockPath(normalized);
  validatePackageName(packageName);
  return normalized;
}

function validateLockfile(lockfile) {
  if (!isRecord(lockfile) || ![2, 3].includes(lockfile.lockfileVersion) || !isRecord(lockfile.packages)) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  }
  return lockfile.packages;
}

function lockEntry(packages, lockPath) {
  if (!hasOwn(packages, lockPath) || !isRecord(packages[lockPath])) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, lockPath);
  }
  const entry = packages[lockPath];
  if (entry.link === true || typeof entry.version !== 'string' || entry.version.length === 0
    || /[\\/]/u.test(entry.version)) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, lockPath);
  }
  return entry;
}

function hasLockEntry(packages, lockPath) {
  return hasOwn(packages, lockPath) && isRecord(packages[lockPath]) && packages[lockPath].link !== true;
}

function dependencyMap(entry, field) {
  if (entry[field] === undefined) return {};
  if (!isRecord(entry[field])) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, field);
  for (const [name, specification] of Object.entries(entry[field])) {
    validatePackageName(name);
    if (typeof specification !== 'string' || specification.length === 0) {
      fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, name);
    }
  }
  return entry[field];
}

function dependencyRequests(entry) {
  const requests = new Map();
  for (const name of Object.keys(dependencyMap(entry, 'dependencies'))) requests.set(name, { optional: false });
  for (const name of Object.keys(dependencyMap(entry, 'optionalDependencies'))) requests.set(name, { optional: true });

  const peers = dependencyMap(entry, 'peerDependencies');
  let peerMetadata = {};
  if (entry.peerDependenciesMeta !== undefined) {
    if (!isRecord(entry.peerDependenciesMeta)) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, 'peerDependenciesMeta');
    peerMetadata = entry.peerDependenciesMeta;
  }
  for (const name of Object.keys(peers)) {
    const metadata = peerMetadata[name];
    if (metadata !== undefined && (!isRecord(metadata) || (metadata.optional !== undefined && typeof metadata.optional !== 'boolean'))) {
      fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, name);
    }
    requests.set(name, { optional: metadata?.optional === true });
  }

  return [...requests.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, request]) => ({ name, ...request }));
}

function packageSupportsWin32(entry) {
  if (entry.os === undefined) return true;
  const values = Array.isArray(entry.os) ? entry.os : typeof entry.os === 'string' ? [entry.os] : undefined;
  if (!values || values.some(value => typeof value !== 'string' || value.length === 0)) {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_ENTRY_INVALID, 'os');
  }
  const normalized = values.map(value => value.toLowerCase());
  const positive = normalized.filter(value => !value.startsWith('!'));
  if (positive.length > 0) return positive.includes('win32');
  return !normalized.includes('!win32');
}

function optionalPackageUnavailable(lockPath, entry, availablePackagePaths) {
  if (!packageSupportsWin32(entry)) return true;
  return availablePackagePaths !== undefined && !availablePackagePaths.has(lockPath);
}

function resolveDependencyLockPath(fromLockPath, dependencyName, packages) {
  let search = fromLockPath;
  for (;;) {
    const candidate = search === 'node_modules' || search.endsWith('/node_modules')
      ? `${search}/${dependencyName}`
      : `${search}/node_modules/${dependencyName}`;
    if (hasLockEntry(packages, candidate)) return candidate;
    if (search === 'node_modules') return undefined;
    search = path.posix.dirname(search);
    if (search === '.' || search === '') return undefined;
  }
}

function packageSourcePath(sourceNodeModules, lockPath) {
  return path.join(sourceNodeModules, ...lockPath.slice(NODE_MODULES_LOCK_PREFIX.length).split('/'));
}

function sourcePathForRelative(repositoryRoot, relativePath) {
  return path.join(repositoryRoot, ...relativePath.split('/'));
}

function collectPackageClosure({ repositoryRoot, sourceNodeModules, packageLock, dependencyRoots, availablePackagePaths }) {
  const packages = validateLockfile(packageLock);
  const roots = dependencyRoots.map(validatePackageName);
  const queue = roots.map(name => ({
    lockPath: normalizeLockPath(`${NODE_MODULES_LOCK_PREFIX}${name}`),
    requestedBy: 'root',
    optional: false
  }));
  const selected = new Map();

  while (queue.length > 0) {
    const request = queue.shift();
    if (selected.has(request.lockPath)) continue;
    const entry = lockEntry(packages, request.lockPath);
    if (request.optional && optionalPackageUnavailable(request.lockPath, entry, availablePackagePaths)) continue;
    const name = packageNameFromLockPath(request.lockPath);
    selected.set(request.lockPath, {
      lockPath: request.lockPath,
      name,
      version: entry.version,
      sourceDirectory: packageSourcePath(sourceNodeModules, request.lockPath),
      destinationDirectory: path.join('node_modules', ...request.lockPath.slice(NODE_MODULES_LOCK_PREFIX.length).split('/'))
    });

    for (const dependency of dependencyRequests(entry)) {
      const dependencyPath = resolveDependencyLockPath(request.lockPath, dependency.name, packages);
      if (!dependencyPath) {
        if (dependency.optional) continue;
        fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_MISSING, `${name} -> ${dependency.name}`);
      }
      const dependencyEntry = lockEntry(packages, dependencyPath);
      if (dependency.optional && optionalPackageUnavailable(dependencyPath, dependencyEntry, availablePackagePaths)) continue;
      queue.push({ lockPath: dependencyPath, requestedBy: request.lockPath, optional: dependency.optional });
    }
  }

  return [...selected.values()].sort((left, right) => {
    const depth = value => value.lockPath.split('/node_modules/').length;
    return depth(left) - depth(right) || left.lockPath.localeCompare(right.lockPath, 'en');
  });
}

function assertOutputLocation(repositoryRoot, outputDirectory) {
  const protectedDirectories = [
    repositoryRoot,
    path.join(repositoryRoot, 'node_modules'),
    path.join(repositoryRoot, 'vendor'),
    path.join(repositoryRoot, 'dist')
  ];
  if (protectedDirectories.some(directory => isSameOrWithin(outputDirectory, directory))) {
    fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_REJECTED);
  }
}

function normalizePlanInput(input) {
  if (!isRecord(input)) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  const repositoryRoot = requireAbsolutePath(input.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const outputValue = input.outputDirectory ?? input.output;
  const nodeValue = input.nodeExecutable ?? input.node;
  const outputDirectory = requireAbsolutePath(outputValue, WIN11_RUNNER_ERROR_CODES.OUTPUT_REJECTED);
  const nodeExecutable = requireAbsolutePath(nodeValue, WIN11_RUNNER_ERROR_CODES.NODE_INVALID);
  assertOutputLocation(repositoryRoot, outputDirectory);
  if (isSameOrWithin(nodeExecutable, outputDirectory)) fail(WIN11_RUNNER_ERROR_CODES.NODE_INSIDE_OUTPUT);

  const fixedScripts = input.fixedScripts ?? FIXED_E2E_SCRIPTS;
  if (!Array.isArray(fixedScripts) || fixedScripts.length === 0) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  const normalizedScripts = [...new Set(fixedScripts.map(relativePath => normalizeRelativePath(relativePath)))];
  if (normalizedScripts.length !== fixedScripts.length) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  const packageLock = input.packageLock ?? input.lockfile;
  if (!isRecord(packageLock)) fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  const sourceNodeModules = requireAbsolutePath(
    input.sourceNodeModules ?? path.join(repositoryRoot, 'node_modules'),
    WIN11_RUNNER_ERROR_CODES.PACKAGE_SOURCE_MISSING
  );
  const dependencyRoots = input.dependencyRoots ?? RUNNER_DEPENDENCY_ROOTS;
  if (!Array.isArray(dependencyRoots) || dependencyRoots.length === 0) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  let availablePackagePaths;
  if (input.availablePackagePaths !== undefined) {
    if (!Array.isArray(input.availablePackagePaths)) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
    availablePackagePaths = new Set(input.availablePackagePaths.map(normalizeLockPath));
  }

  return {
    repositoryRoot,
    outputDirectory,
    nodeExecutable,
    fixedScripts: normalizedScripts,
    packageLock,
    sourceNodeModules,
    dependencyRoots: [...new Set(dependencyRoots.map(validatePackageName))],
    availablePackagePaths
  };
}

/**
 * Pure runner-closure planner. It only validates and interprets the supplied
 * lock object; it does not read, copy, delete, or rename any filesystem path.
 */
export function planWin11Runner(input) {
  const normalized = normalizePlanInput(input);
  const packages = collectPackageClosure(normalized);
  return {
    repositoryRoot: normalized.repositoryRoot,
    outputDirectory: normalized.outputDirectory,
    nodeExecutable: normalized.nodeExecutable,
    sourceNodeModules: normalized.sourceNodeModules,
    node: { sourcePath: normalized.nodeExecutable, destinationPath: WIN11_RUNNER_NODE_FILE },
    scripts: normalized.fixedScripts.map(relativePath => ({
      sourcePath: sourcePathForRelative(normalized.repositoryRoot, relativePath),
      destinationPath: relativePath
    })),
    packages,
    dependencyRoots: normalized.dependencyRoots,
    manifestPath: path.join(normalized.outputDirectory, WIN11_RUNNER_MANIFEST_FILE)
  };
}

export const planWin11RunnerClosure = planWin11Runner;
export const createWin11RunnerPlan = planWin11Runner;

async function readPackageLock(repositoryRoot, filename) {
  const lockPath = filename
    ? requireAbsolutePath(filename, WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_READ_FAILED)
    : path.join(repositoryRoot, 'package-lock.json');
  let text;
  try {
    text = await fs.readFile(lockPath, 'utf8');
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_READ_FAILED);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_LOCK_INVALID);
  }
}

async function lstatMaybe(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function nearestExistingPath(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (await lstatMaybe(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function assertPhysicalOutputLocation(repositoryRoot, outputDirectory) {
  const outputInfo = await lstatMaybe(outputDirectory);
  if (outputInfo?.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_REPARSE);
  if (outputInfo && !outputInfo.isDirectory()) fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_NOT_DIRECTORY);

  const existing = await nearestExistingPath(outputDirectory);
  if (!existing) return;
  const [physicalRoot, physicalExisting] = await Promise.all([
    fs.realpath(repositoryRoot),
    fs.realpath(existing)
  ]);
  if (isSameOrWithin(physicalExisting, physicalRoot)) fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_REJECTED);
}

export async function validateWin11RunnerNode(filename) {
  try {
    const executable = NtExecutable.from(await fs.readFile(filename), { ignoreCert: true });
    if (executable.is32bit() || executable.newHeader.fileHeader.machine !== 0x8664) {
      fail(WIN11_RUNNER_ERROR_CODES.NODE_INVALID);
    }
  } catch (error) {
    if (error instanceof Win11RunnerError) throw error;
    fail(WIN11_RUNNER_ERROR_CODES.NODE_INVALID);
  }
}

async function availablePackagePaths(plan) {
  const available = [];
  for (const packageEntry of plan.packages) {
    const info = await lstatMaybe(packageEntry.sourceDirectory);
    if (info?.isDirectory() && !info.isSymbolicLink()) available.push(packageEntry.lockPath);
  }
  return available;
}

async function copyRegularFile(source, destination) {
  let info;
  try {
    info = await fs.lstat(source);
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.SOURCE_MISSING);
  }
  if (info.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_REPARSE);
  if (!info.isFile()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_UNSUPPORTED);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.SOURCE_COPY_FAILED);
  }
}

async function copyDirectory(source, destination) {
  let info;
  try {
    info = await fs.lstat(source);
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.PACKAGE_SOURCE_MISSING);
  }
  if (info.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_REPARSE);
  if (!info.isDirectory()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_UNSUPPORTED);

  try {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      const entryInfo = await fs.lstat(sourcePath);
      if (entryInfo.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_REPARSE);
      if (entry.name === 'node_modules') {
        if (!entryInfo.isDirectory()) fail(WIN11_RUNNER_ERROR_CODES.SOURCE_UNSUPPORTED);
        // Nested package directories are separate lockfile selections. Copying
        // this directory here would silently widen the requested closure.
        continue;
      }
      if (entryInfo.isDirectory()) await copyDirectory(sourcePath, destinationPath);
      else if (entryInfo.isFile()) await copyRegularFile(sourcePath, destinationPath);
      else fail(WIN11_RUNNER_ERROR_CODES.SOURCE_UNSUPPORTED);
    }
  } catch (error) {
    if (error instanceof Win11RunnerError) throw error;
    fail(WIN11_RUNNER_ERROR_CODES.SOURCE_COPY_FAILED);
  }
}

async function copyPlan(plan, staging) {
  await copyRegularFile(plan.node.sourcePath, path.join(staging, plan.node.destinationPath));
  for (const script of plan.scripts) {
    await copyRegularFile(script.sourcePath, path.join(staging, ...script.destinationPath.split('/')));
  }
  for (const packageEntry of plan.packages) {
    await copyDirectory(
      packageEntry.sourceDirectory,
      path.join(staging, ...packageEntry.destinationDirectory.split(path.sep))
    );
  }
}

async function collectFiles(root, current = root, result = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const filename = path.join(current, entry.name);
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
    if (info.isDirectory()) await collectFiles(root, filename, result);
    else if (info.isFile()) result.push(filename);
    else fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
  }
  return result;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  let size = 0;
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (!Number.isSafeInteger(size)) fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof Win11RunnerError) throw error;
    fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  return { size, sha256: hash.digest('hex') };
}

function relativeManifestPath(root, filename) {
  const relative = path.relative(root, filename).replaceAll('\\', '/');
  return normalizeRelativePath(relative, WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
}

async function writeManifest(plan, staging) {
  let files;
  try {
    files = await collectFiles(staging);
    const records = [];
    let totalBytes = 0;
    for (const filename of files) {
      const file = await hashFile(filename);
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes)) fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
      records.push({ path: relativeManifestPath(staging, filename), ...file });
    }
    records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    if (records.some(record => !SHA256.test(record.sha256))) fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);

    const manifest = {
      schemaVersion: WIN11_RUNNER_SCHEMA_VERSION,
      tool: WIN11_RUNNER_TOOL,
      manifestFile: WIN11_RUNNER_MANIFEST_FILE,
      nodeExecutable: WIN11_RUNNER_NODE_FILE,
      nodeArchitecture: 'x64',
      e2eScripts: plan.scripts.map(script => script.destinationPath),
      dependencyRoots: [...plan.dependencyRoots],
      packages: plan.packages.map(packageEntry => ({
        name: packageEntry.name,
        version: packageEntry.version,
        lockPath: packageEntry.lockPath
      })),
      files: records,
      totalBytes
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(staging, WIN11_RUNNER_MANIFEST_FILE), text, { encoding: 'utf8', flag: 'wx' });
    return manifest;
  } catch (error) {
    if (error instanceof Win11RunnerError) throw error;
    fail(WIN11_RUNNER_ERROR_CODES.MANIFEST_FAILED);
  }
}

async function publishStaging(staging, outputDirectory, token) {
  const existing = await lstatMaybe(outputDirectory);
  if (existing?.isSymbolicLink()) fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_REPARSE);
  if (existing && !existing.isDirectory()) fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_NOT_DIRECTORY);

  let backup;
  let movedExisting = false;
  if (existing) {
    backup = path.join(path.dirname(outputDirectory), `.adhd-one-win11-runner-${token}.backup`);
    try {
      await fs.rename(outputDirectory, backup);
      movedExisting = true;
    } catch {
      fail(WIN11_RUNNER_ERROR_CODES.PUBLISH_FAILED);
    }
  }

  try {
    await fs.rename(staging, outputDirectory);
  } catch (error) {
    if (movedExisting) {
      try {
        await fs.rename(backup, outputDirectory);
      } catch {
        throw new Win11RunnerError(WIN11_RUNNER_ERROR_CODES.PUBLISH_ROLLBACK_FAILED);
      }
    }
    if (error instanceof Win11RunnerError) throw error;
    fail(WIN11_RUNNER_ERROR_CODES.PUBLISH_FAILED);
  }

  if (movedExisting) {
    try {
      await fs.rm(backup, { recursive: true, force: true });
    } catch {
      throw new Win11RunnerError(WIN11_RUNNER_ERROR_CODES.BACKUP_CLEANUP_FAILED);
    }
  }
}

/**
 * Materialize a planned runner in a sibling staging directory and publish it
 * with a same-volume rename. `packageLock` may be injected for offline tests;
 * otherwise the repository package-lock.json is read.
 */
export async function prepareWin11Runner(options = {}) {
  if (!isRecord(options)) fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  const repositoryRoot = requireAbsolutePath(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const packageLock = options.packageLock ?? options.lockfile ?? await readPackageLock(repositoryRoot, options.packageLockPath);
  const preliminaryPlan = planWin11Runner({ ...options, repositoryRoot, packageLock });
  const plan = planWin11Runner({
    ...options,
    repositoryRoot,
    packageLock,
    availablePackagePaths: await availablePackagePaths(preliminaryPlan)
  });
  const nodeValidator = options.nodeValidator ?? validateWin11RunnerNode;
  if (typeof nodeValidator !== 'function') fail(WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT);
  await nodeValidator(plan.node.sourcePath);

  await assertPhysicalOutputLocation(plan.repositoryRoot, plan.outputDirectory);
  try {
    await fs.mkdir(path.dirname(plan.outputDirectory), { recursive: true });
  } catch {
    fail(WIN11_RUNNER_ERROR_CODES.OUTPUT_REJECTED);
  }

  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const staging = await fs.mkdtemp(path.join(path.dirname(plan.outputDirectory), `.adhd-one-win11-runner-${token}-`));
  let published = false;
  try {
    await copyPlan(plan, staging);
    const manifest = await writeManifest(plan, staging);
    await publishStaging(staging, plan.outputDirectory, token);
    published = true;
    return {
      outputDirectory: plan.outputDirectory,
      manifestPath: path.join(plan.outputDirectory, WIN11_RUNNER_MANIFEST_FILE),
      manifest
    };
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const prepareRunner = prepareWin11Runner;

export function runnerUsage() {
  return [
    'Usage:',
    '  node scripts/prepare-win11-runner.mjs --output <absolute-directory> --node <existing-node.exe>',
    '',
    'Stages the fixed Windows 11 E2E runner and its lockfile-resolved runtime closure.'
  ].join('\n');
}

export function parseRunnerArgs(argv, cwd = process.cwd()) {
  void cwd;
  if (!Array.isArray(argv)) fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
  const values = { output: undefined, node: undefined };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (typeof token !== 'string') fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    let value = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (name !== '--output' && name !== '--node') fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
    if (seen.has(name)) fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
    seen.add(name);
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--') || !path.isAbsolute(value)) {
      fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
    }
    values[name.slice(2)] = path.normalize(value);
  }
  if (!values.output || !values.node) fail(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
  return { help: false, output: values.output, node: values.node };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseRunnerArgs(argv);
  if (parsed.help) {
    console.log(runnerUsage());
    return 0;
  }
  const result = await prepareWin11Runner({ output: parsed.output, node: parsed.node });
  console.log(`WIN11_RUNNER_READY files=${result.manifest.files.length} bytes=${result.manifest.totalBytes}`);
  return 0;
}

function cliErrorCode(error) {
  const code = error instanceof Win11RunnerError ? error.code : undefined;
  return code && Object.values(WIN11_RUNNER_ERROR_CODES).includes(code)
    ? code
    : WIN11_RUNNER_ERROR_CODES.INVALID_ARGUMENT;
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedScript === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(cliErrorCode(error));
    process.exitCode = 1;
  }
}
