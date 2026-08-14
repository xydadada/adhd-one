import { lstat as defaultLstat, open as defaultOpen, readdir as defaultReaddir, readFile as defaultReadFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoWindowsReparseComponents } from './windows-platform.js';

export const DSH_TOOLS_PACKAGE_NAME = '@deepseek-ai/dsh-tools' as const;

/**
 * Bounds are deliberately above the current rc.6 runtime tree, but finite.
 * The integrity value checked below is npm registration metadata from the
 * lockfile; it is not a hash of the current physical package contents.
 */
export const RUNTIME_CLOSURE_LIMITS = {
  maxDirectories: 16_384,
  maxDepth: 256,
  maxEntries: 262_144,
  maxCandidates: 2,
  maxPackageJsonBytes: 256 * 1024,
  maxPackageLockBytes: 8 * 1024 * 1024
} as const;

export const RUNTIME_CLOSURE_ERROR_CODES = {
  inputInvalid: 'RUNTIME_CLOSURE_INPUT_INVALID',
  rootInvalid: 'RUNTIME_CLOSURE_ROOT_INVALID',
  scanFailed: 'RUNTIME_CLOSURE_SCAN_FAILED',
  scanLimitExceeded: 'RUNTIME_CLOSURE_SCAN_LIMIT_EXCEEDED',
  reparseRefused: 'RUNTIME_CLOSURE_REPARSE_REFUSED',
  pnpmUnsupported: 'RUNTIME_CLOSURE_PNPM_UNSUPPORTED',
  countInvalid: 'RUNTIME_CLOSURE_COUNT_INVALID',
  packageInvalid: 'RUNTIME_CLOSURE_PACKAGE_INVALID',
  lockMissing: 'RUNTIME_CLOSURE_LOCK_MISSING',
  lockInvalid: 'RUNTIME_CLOSURE_LOCK_INVALID',
  lockCountInvalid: 'RUNTIME_CLOSURE_LOCK_COUNT_INVALID',
  packageUnregistered: 'RUNTIME_CLOSURE_PACKAGE_UNREGISTERED',
  versionMismatch: 'RUNTIME_CLOSURE_VERSION_MISMATCH',
  integrityMissing: 'RUNTIME_CLOSURE_INTEGRITY_MISSING',
  integrityInvalid: 'RUNTIME_CLOSURE_INTEGRITY_INVALID',
  integrityMismatch: 'RUNTIME_CLOSURE_INTEGRITY_MISMATCH'
} as const;

export type RuntimeClosureErrorCode = typeof RUNTIME_CLOSURE_ERROR_CODES[keyof typeof RUNTIME_CLOSURE_ERROR_CODES];

export type RuntimeClosureSlot = string;

export interface RuntimeClosurePreflightInput {
  readonly activeRuntimeRoot: string;
  readonly slot: RuntimeClosureSlot;
  /** Startup uses the bounded registered-path check; staging/build gates use deep. */
  readonly scanMode?: 'registered' | 'deep';
  readonly filesystem?: RuntimeClosureFilesystem;
}

export interface RuntimeClosurePreflightResult {
  readonly ok: true;
  readonly count: 1;
  readonly version: string;
  /** npm registration metadata; this is not a physical-content hash. */
  readonly registrationIntegrity: string;
  readonly slot: string;
}

export interface RuntimeClosureErrorDetails {
  readonly count: number;
  readonly version: string;
  readonly slot: string;
}

/** A path-free, stable preflight error for callers that select an active slot. */
export class RuntimeClosurePreflightError extends Error {
  readonly code: RuntimeClosureErrorCode;
  readonly count: number;
  readonly version: string;
  readonly slot: string;

  constructor(code: RuntimeClosureErrorCode, details: RuntimeClosureErrorDetails) {
    const count = Number.isSafeInteger(details.count) && details.count >= 0 ? details.count : 0;
    const version = safeToken(details.version, 'unknown');
    const slot = safeToken(details.slot, 'unknown');
    super(`${code} count=${count} version=${version} slot=${slot}`);
    this.name = 'RuntimeClosurePreflightError';
    this.code = code;
    this.count = count;
    this.version = version;
    this.slot = slot;
  }
}

export interface RuntimeClosureDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  /** Optional test/platform hook for reparse points that are not symlinks. */
  isReparsePoint?(): boolean;
}

export interface RuntimeClosureStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  /** Optional test/platform hook for reparse points that are not symlinks. */
  isReparsePoint?(): boolean;
}

export interface RuntimeClosureFilesystem {
  readonly lstat: (filename: string) => Promise<RuntimeClosureStats>;
  readonly readdir: (directory: string) => Promise<readonly RuntimeClosureDirent[]>;
  readonly readFile: (filename: string, maxBytes?: number) => Promise<string>;
  /** Throw for a reparse component. The default uses the Windows fail-closed check. */
  readonly assertNoReparse?: (filename: string) => void | Promise<void>;
}

interface PackageCandidate {
  readonly filename: string;
  readonly lockPath: string;
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly integrity?: unknown;
  readonly _integrity?: unknown;
}

interface LockEntry {
  readonly version?: unknown;
  readonly integrity?: unknown;
}

interface PreflightState {
  count: number;
  version: string;
  slot: string;
}

class RuntimeClosureReadLimitError extends Error {
  constructor() {
    super('RUNTIME_CLOSURE_FILE_TOO_LARGE');
    this.name = 'RuntimeClosureReadLimitError';
  }
}

async function readFileAtMost(filename: string, maxBytes: number): Promise<string> {
  const handle = await defaultOpen(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new RuntimeClosureReadLimitError();
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

const defaultFilesystem: RuntimeClosureFilesystem = {
  lstat: filename => defaultLstat(filename),
  readdir: async directory => await defaultReaddir(directory, { withFileTypes: true }) as RuntimeClosureDirent[],
  readFile: (filename, maxBytes) => maxBytes === undefined
    ? defaultReadFile(filename, 'utf8')
    : readFileAtMost(filename, maxBytes),
  assertNoReparse: filename => assertNoWindowsReparseComponents(filename)
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(value)) return fallback;
  return value;
}

function stateFor(slot: unknown, count = 0, version = 'unknown'): PreflightState {
  return { count, version, slot: safeToken(slot, 'unknown') };
}

function fail(code: RuntimeClosureErrorCode, state: PreflightState): never {
  throw new RuntimeClosurePreflightError(code, state);
}

async function readLimitedFile(
  filename: string,
  maxBytes: number,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState,
  invalidCode: RuntimeClosureErrorCode
): Promise<string> {
  let value: string;
  try {
    value = await filesystem.readFile(filename, maxBytes);
  } catch (error) {
    if (error instanceof RuntimeClosureReadLimitError) fail(RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, state);
    fail(invalidCode, state);
  }
  if (typeof value !== 'string') fail(invalidCode, state);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, state);
  return value;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isNotTraversable(value: RuntimeClosureDirent | RuntimeClosureStats): boolean {
  return value.isSymbolicLink() || value.isReparsePoint?.() === true;
}

async function assertNoReparsePath(
  filename: string,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState
): Promise<void> {
  if (!filesystem.assertNoReparse) return;
  try {
    await filesystem.assertNoReparse(filename);
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.reparseRefused, state);
  }
}

function assertNotTraversable(value: RuntimeClosureDirent | RuntimeClosureStats, state: PreflightState): void {
  if (isNotTraversable(value)) fail(RUNTIME_CLOSURE_ERROR_CODES.reparseRefused, state);
}

function validEntryName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\');
}

function isValidSri(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  return value.trim().split(/\s+/u).every(token => /^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/u.test(token));
}

function targetLockPath(relative: string): string | undefined {
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts[0] !== 'node_modules' || parts.some(part => part === '' || part === '.' || part === '..' || part === '.pnpm')) return undefined;
  for (let index = 0; index + 2 < parts.length; index += 1) {
    if (parts[index] === 'node_modules' && parts[index + 1] === '@deepseek-ai'
      && parts[index + 2] === 'dsh-tools' && index + 3 === parts.length) return normalized;
  }
  return undefined;
}

async function rejectPnpmStoreLayout(
  root: string,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState
): Promise<void> {
  const pnpmStore = path.join(root, 'node_modules', '.pnpm');
  await assertNoReparsePath(pnpmStore, filesystem, state);
  let info: RuntimeClosureStats;
  try {
    info = await filesystem.lstat(pnpmStore);
  } catch (error) {
    if (isNotFound(error)) return;
    fail(RUNTIME_CLOSURE_ERROR_CODES.scanFailed, state);
  }
  assertNotTraversable(info, state);
  fail(RUNTIME_CLOSURE_ERROR_CODES.pnpmUnsupported, state);
}

function targetPackageLockPath(relativePackageJson: string): string | undefined {
  const normalized = relativePackageJson.replaceAll('\\', '/');
  if (!normalized.endsWith('/package.json')) return undefined;
  return targetLockPath(normalized.slice(0, -'/package.json'.length));
}

async function enumeratePhysicalPackages(
  root: string,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState
): Promise<PackageCandidate[]> {
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const candidates: PackageCandidate[] = [];
  let directoryCount = 0;
  let entryCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = current.directory;
    directoryCount += 1;
    if (directoryCount > RUNTIME_CLOSURE_LIMITS.maxDirectories) {
      fail(RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, state);
    }

    let entries: readonly RuntimeClosureDirent[];
    try {
      entries = await filesystem.readdir(directory);
    } catch {
      fail(RUNTIME_CLOSURE_ERROR_CODES.scanFailed, state);
    }
    if (entries.length > RUNTIME_CLOSURE_LIMITS.maxEntries - entryCount) {
      fail(RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, state);
    }
    entryCount += entries.length;

    for (const entry of entries) {
      assertNotTraversable(entry, state);
      if (!validEntryName(entry.name)) continue;

      const filename = path.join(directory, entry.name);
      if (entry.name === '.pnpm' && path.basename(directory) === 'node_modules') {
        fail(RUNTIME_CLOSURE_ERROR_CODES.pnpmUnsupported, state);
      }
      await assertNoReparsePath(filename, filesystem, state);

      let info: RuntimeClosureStats;
      try {
        info = await filesystem.lstat(filename);
      } catch {
        fail(RUNTIME_CLOSURE_ERROR_CODES.scanFailed, state);
      }
      assertNotTraversable(info, state);

      if (info.isDirectory()) {
        if (current.depth + 1 > RUNTIME_CLOSURE_LIMITS.maxDepth
          || pending.length >= RUNTIME_CLOSURE_LIMITS.maxDirectories) {
          fail(RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, state);
        }
        pending.push({ directory: filename, depth: current.depth + 1 });
        continue;
      }
      if (!info.isFile() || entry.name !== 'package.json') continue;

      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const lockPath = targetPackageLockPath(relative);
      if (lockPath) {
        if (candidates.length + 1 >= RUNTIME_CLOSURE_LIMITS.maxCandidates) {
          state.count = candidates.length + 1;
          fail(RUNTIME_CLOSURE_ERROR_CODES.countInvalid, state);
        }
        candidates.push({ filename, lockPath });
      }
    }
  }

  candidates.sort((left, right) => left.lockPath.localeCompare(right.lockPath));
  return candidates;
}

async function readPackageManifest(
  candidate: PackageCandidate,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState
): Promise<PackageManifest> {
  await assertNoReparsePath(candidate.filename, filesystem, state);
  let info: RuntimeClosureStats;
  try {
    info = await filesystem.lstat(candidate.filename);
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.packageInvalid, state);
  }
  assertNotTraversable(info, state);
  if (!info.isFile()) fail(RUNTIME_CLOSURE_ERROR_CODES.packageInvalid, state);

  let value: unknown;
  const raw = await readLimitedFile(
    candidate.filename,
    RUNTIME_CLOSURE_LIMITS.maxPackageJsonBytes,
    filesystem,
    state,
    RUNTIME_CLOSURE_ERROR_CODES.packageInvalid
  );
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.packageInvalid, state);
  }
  if (!isRecord(value) || value.name !== DSH_TOOLS_PACKAGE_NAME
    || typeof value.version !== 'string' || value.version.length === 0) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.packageInvalid, state);
  }
  state.version = value.version;
  return value as PackageManifest;
}

async function readRuntimeLock(
  root: string,
  filesystem: RuntimeClosureFilesystem,
  state: PreflightState
): Promise<Record<string, unknown>> {
  const filename = path.join(root, 'package-lock.json');
  await assertNoReparsePath(filename, filesystem, state);

  let info: RuntimeClosureStats;
  try {
    info = await filesystem.lstat(filename);
  } catch (error) {
    fail(isNotFound(error) ? RUNTIME_CLOSURE_ERROR_CODES.lockMissing : RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, state);
  }
  assertNotTraversable(info, state);
  if (!info.isFile()) fail(RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, state);

  let value: unknown;
  const raw = await readLimitedFile(
    filename,
    RUNTIME_CLOSURE_LIMITS.maxPackageLockBytes,
    filesystem,
    state,
    RUNTIME_CLOSURE_ERROR_CODES.lockInvalid
  );
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, state);
  }
  if (!isRecord(value) || value.lockfileVersion !== 3 || !isRecord(value.packages)) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, state);
  }
  return value.packages as Record<string, unknown>;
}

function targetLockEntries(packages: Record<string, unknown>, state: PreflightState): Array<[string, LockEntry]> {
  const entries: Array<[string, LockEntry]> = [];
  for (const [lockPath, value] of Object.entries(packages)) {
    if (!targetLockPath(lockPath)) continue;
    if (!isRecord(value)) fail(RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, state);
    entries.push([lockPath, value as LockEntry]);
  }
  return entries;
}

export async function preflightRuntimeClosure(
  input: RuntimeClosurePreflightInput
): Promise<RuntimeClosurePreflightResult>;
export async function preflightRuntimeClosure(
  activeRuntimeRoot: string,
  slot: RuntimeClosureSlot
): Promise<RuntimeClosurePreflightResult>;
export async function preflightRuntimeClosure(
  inputOrRoot: RuntimeClosurePreflightInput | string,
  positionalSlot = 'unknown'
): Promise<RuntimeClosurePreflightResult> {
  const input = typeof inputOrRoot === 'string'
    ? { activeRuntimeRoot: inputOrRoot, slot: positionalSlot }
    : inputOrRoot;
  const slot = safeToken(input?.slot, 'unknown');
  const state = stateFor(slot);

  if (!isRecord(input) || typeof input.activeRuntimeRoot !== 'string' || input.activeRuntimeRoot.length === 0) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.inputInvalid, state);
  }
  const scanMode = input.scanMode ?? 'deep';
  if (scanMode !== 'registered' && scanMode !== 'deep') fail(RUNTIME_CLOSURE_ERROR_CODES.inputInvalid, state);

  const filesystem = input.filesystem ?? defaultFilesystem;
  let root: string;
  try {
    root = path.resolve(input.activeRuntimeRoot);
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.rootInvalid, state);
  }

  await assertNoReparsePath(root, filesystem, state);
  let rootInfo: RuntimeClosureStats;
  try {
    rootInfo = await filesystem.lstat(root);
  } catch {
    fail(RUNTIME_CLOSURE_ERROR_CODES.rootInvalid, state);
  }
  assertNotTraversable(rootInfo, state);
  if (!rootInfo.isDirectory()) fail(RUNTIME_CLOSURE_ERROR_CODES.rootInvalid, state);
  await rejectPnpmStoreLayout(root, filesystem, state);

  let packages: Record<string, unknown>;
  let lockEntries: Array<[string, LockEntry]>;
  let candidates: PackageCandidate[];
  if (scanMode === 'registered') {
    packages = await readRuntimeLock(root, filesystem, state);
    lockEntries = targetLockEntries(packages, state);
    if (lockEntries.length !== 1) fail(RUNTIME_CLOSURE_ERROR_CODES.lockCountInvalid, state);
    candidates = [{ filename: path.join(root, lockEntries[0]![0], 'package.json'), lockPath: lockEntries[0]![0] }];
  } else {
    candidates = await enumeratePhysicalPackages(root, filesystem, state);
    state.count = candidates.length;
    if (candidates.length !== 1) fail(RUNTIME_CLOSURE_ERROR_CODES.countInvalid, state);
    packages = {};
    lockEntries = [];
  }
  state.count = candidates.length;
  if (candidates.length !== 1) fail(RUNTIME_CLOSURE_ERROR_CODES.countInvalid, state);

  const candidate = candidates[0]!;
  const manifest = await readPackageManifest(candidate, filesystem, state);
  const version = manifest.version as string;
  if (scanMode !== 'registered') {
    packages = await readRuntimeLock(root, filesystem, state);
    lockEntries = targetLockEntries(packages, state);
    const lockValue = packages[candidate.lockPath];
    if (!isRecord(lockValue)) fail(RUNTIME_CLOSURE_ERROR_CODES.packageUnregistered, state);
    if (lockEntries.length !== 1) fail(RUNTIME_CLOSURE_ERROR_CODES.lockCountInvalid, state);
  }
  const lockValue = packages[candidate.lockPath];
  if (!isRecord(lockValue)) fail(RUNTIME_CLOSURE_ERROR_CODES.packageUnregistered, state);

  const entry = lockValue as LockEntry;
  if (entry.version !== version) fail(RUNTIME_CLOSURE_ERROR_CODES.versionMismatch, state);
  if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.integrityMissing, state);
  }
  if (!isValidSri(entry.integrity)) fail(RUNTIME_CLOSURE_ERROR_CODES.integrityInvalid, state);

  const manifestIntegrityValues = [manifest.integrity, manifest._integrity].filter(value => value !== undefined);
  if (manifestIntegrityValues.length > 1 && manifestIntegrityValues[0] !== manifestIntegrityValues[1]) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.integrityMismatch, state);
  }
  const registrationIntegrity = manifestIntegrityValues[0];
  if (registrationIntegrity !== undefined && !isValidSri(registrationIntegrity)) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.integrityInvalid, state);
  }
  if (registrationIntegrity !== undefined && registrationIntegrity !== entry.integrity) {
    fail(RUNTIME_CLOSURE_ERROR_CODES.integrityMismatch, state);
  }

  return { ok: true, count: 1, version, registrationIntegrity: entry.integrity, slot };
}

/** Descriptive alias for callers that use the inspector terminology. */
export const inspectRuntimeClosure = preflightRuntimeClosure;

/** Explicit alias for the active-root call site in RuntimeController. */
export const preflightActiveRuntimeClosure = preflightRuntimeClosure;
