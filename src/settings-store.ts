/** Atomic settings replacement adapted from DeepSeek Harness (MIT), commit 47f943859b. */
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppSettings, AppSettingsV2, AppSettingsV3 } from './types.js';

export type SettingsStoreErrorCode = 'SETTINGS_CORRUPT' | 'SETTINGS_IO' | 'SETTINGS_LOCKED';

export class SettingsStoreError extends Error {
  readonly code: SettingsStoreErrorCode;

  constructor(code: SettingsStoreErrorCode) {
    super(code);
    this.name = 'SettingsStoreError';
    this.code = code;
  }
}

const settingsFields = {
  schemaVersion: z.literal(2),
  locale: z.enum(['zh-CN', 'en-US']),
  workspace: z.string().optional(),
  preferredPort: z.number().int().min(1024).max(65535),
  appChannel: z.enum(['stable', 'preview']),
  runtimeChannel: z.enum(['stable', 'preview']),
  closeToTrayExplained: z.boolean(),
  migration: z.object({ v1Imported: z.boolean(), legacyDshPrompted: z.boolean() })
} as const;

const settingsV2Schema = z.object(settingsFields);
const settingsV3Schema = z.object({
  ...settingsFields,
  schemaVersion: z.literal(3),
  portableDataPath: z.string().optional()
});

interface ParsedSettingsFile {
  value: AppSettingsV3;
  serialized: string;
  schemaVersion: 2 | 3;
  needsRewrite: boolean;
}

type ReadSettingsResult =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; file: ParsedSettingsFile };

interface WriterLockRecord {
  pid: number;
  createdAt: number;
  token: string;
}

interface WriterLock {
  release(): Promise<void>;
}

const STALE_LOCK_AGE_MS = 5 * 60 * 1000;
const MAX_QUARANTINE_ATTEMPTS = 8;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

type WorkspaceErrorCode = 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_NOT_DIRECTORY';

function workspaceError(code: WorkspaceErrorCode): Error {
  return new Error(code);
}

function isWorkspaceError(error: unknown): error is Error {
  return error instanceof Error
    && (error.message === 'WORKSPACE_NOT_FOUND' || error.message === 'WORKSPACE_NOT_DIRECTORY');
}

function ioError(): SettingsStoreError {
  return new SettingsStoreError('SETTINGS_IO');
}

function corruptError(): SettingsStoreError {
  return new SettingsStoreError('SETTINGS_CORRUPT');
}

function lockedError(): SettingsStoreError {
  return new SettingsStoreError('SETTINGS_LOCKED');
}

function asSettingsError(error: unknown): SettingsStoreError | Error {
  if (error instanceof SettingsStoreError || isWorkspaceError(error)) return error;
  return ioError();
}

function serializeSettings(value: AppSettingsV2 | AppSettingsV3): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateV2(value: AppSettingsV2): AppSettingsV3 {
  return {
    schemaVersion: 3,
    locale: value.locale,
    ...(value.workspace !== undefined ? { workspace: value.workspace } : {}),
    preferredPort: value.preferredPort,
    appChannel: value.appChannel,
    runtimeChannel: value.runtimeChannel,
    closeToTrayExplained: value.closeToTrayExplained,
    migration: { ...value.migration }
  };
}

function parseSettings(value: unknown): ParsedSettingsFile | undefined {
  const v3 = settingsV3Schema.safeParse(value);
  if (v3.success) {
    const current = v3.data as AppSettingsV3;
    return { value: current, serialized: serializeSettings(current), schemaVersion: 3, needsRewrite: false };
  }

  const v2 = settingsV2Schema.safeParse(value);
  if (!v2.success) return undefined;
  const legacy = v2.data as AppSettingsV2;
  return { value: migrateV2(legacy), serialized: serializeSettings(legacy), schemaVersion: 2, needsRewrite: false };
}

async function canonicalizeWorkspace(candidate: string): Promise<string> {
  try {
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) throw workspaceError('WORKSPACE_NOT_DIRECTORY');
    return canonical;
  } catch (error) {
    if (isWorkspaceError(error)) throw error;
    if (hasErrorCode(error, 'ENOENT')) throw workspaceError('WORKSPACE_NOT_FOUND');
    throw asSettingsError(error);
  }
}

async function canonicalizeSettings(value: AppSettingsV3): Promise<AppSettingsV3> {
  if (value.workspace === undefined) return value;
  return { ...value, workspace: await canonicalizeWorkspace(value.workspace) };
}

function toV2(value: AppSettingsV3): AppSettingsV2 {
  return {
    schemaVersion: 2,
    locale: value.locale,
    ...(value.workspace !== undefined ? { workspace: value.workspace } : {}),
    preferredPort: value.preferredPort,
    appChannel: value.appChannel,
    runtimeChannel: value.runtimeChannel,
    closeToTrayExplained: value.closeToTrayExplained,
    migration: { ...value.migration }
  };
}

async function canonicalizeParsedSettings(file: ParsedSettingsFile): Promise<ParsedSettingsFile> {
  const value = await canonicalizeSettings(file.value);
  return {
    value,
    serialized: file.schemaVersion === 2 ? serializeSettings(toV2(value)) : serializeSettings(value),
    schemaVersion: file.schemaVersion,
    needsRewrite: file.schemaVersion === 2 || value.workspace !== file.value.workspace
  };
}

async function readSettingsFile(filename: string): Promise<ReadSettingsResult> {
  let serialized: string;
  try {
    serialized = await readFile(filename, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    throw ioError();
  }

  let parsed: ParsedSettingsFile | undefined;
  try { parsed = parseSettings(JSON.parse(serialized) as unknown); } catch { return { kind: 'corrupt' }; }
  if (!parsed) return { kind: 'corrupt' };
  return { kind: 'valid', file: await canonicalizeParsedSettings(parsed) };
}

function normalizeSettings(value: unknown): AppSettingsV3 {
  const v3 = settingsV3Schema.safeParse(value);
  if (v3.success) return v3.data as AppSettingsV3;

  const v2 = settingsV2Schema.safeParse(value);
  if (v2.success) return migrateV2(v2.data as AppSettingsV2);

  // Keep the existing Zod validation/error behavior for callers of save/update.
  return settingsV3Schema.parse(value) as AppSettingsV3;
}

export function defaultSettings(): AppSettingsV3 {
  return {
    schemaVersion: 3,
    locale: 'zh-CN',
    preferredPort: randomInt(20_000, 60_000),
    appChannel: 'stable',
    runtimeChannel: 'stable',
    closeToTrayExplained: false,
    migration: { v1Imported: false, legacyDshPrompted: false }
  };
}

export async function writeFileAtomic(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, filename);
  } catch (error) {
    try { await rm(temp, { force: true }); } catch { /* retain the original failure */ }
    throw error;
  }
}

function lockFilename(filename: string): string {
  return `${filename}.lock`;
}

function claimFilename(filename: string): string {
  return `${lockFilename(filename)}.claim`;
}

function claimRecordFilename(directory: string): string {
  return path.join(directory, 'owner.json');
}

function serializeLockRecord(record: WriterLockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function enqueueShared<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filename);
  const previous = sharedQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  sharedQueues.set(key, tail);
  void tail.then(() => {
    if (sharedQueues.get(key) === tail) sharedQueues.delete(key);
  });
  return result;
}

function parseLockRecord(value: unknown): WriterLockRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<WriterLockRecord>;
  const pid = candidate.pid;
  const createdAt = candidate.createdAt;
  const token = candidate.token;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined;
  if (typeof token !== 'string' || token.length === 0) return undefined;
  return { pid, createdAt, token };
}

type LockInspection =
  | { kind: 'missing' }
  | { kind: 'active'; record?: WriterLockRecord }
  | { kind: 'stale'; record?: WriterLockRecord };

interface LockClaim {
  release(): Promise<void>;
}

const sharedQueues = new Map<string, Promise<void>>();

function inspectRecord(record: WriterLockRecord): LockInspection {
  if (record.pid === process.pid) return { kind: 'active', record };

  const now = Date.now();
  if (record.createdAt > now || now - record.createdAt < STALE_LOCK_AGE_MS) return { kind: 'active', record };

  try {
    process.kill(record.pid, 0);
    return { kind: 'active', record };
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return { kind: 'stale', record };
    return { kind: 'active', record };
  }
}

async function inspectByMtime(filename: string): Promise<LockInspection> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(filename);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    throw ioError();
  }

  const now = Date.now();
  if (metadata.mtimeMs > now || now - metadata.mtimeMs < STALE_LOCK_AGE_MS) return { kind: 'active' };
  return { kind: 'stale' };
}

async function inspectLock(filename: string): Promise<LockInspection> {
  let raw: string;
  try {
    raw = await readFile(filename, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    throw ioError();
  }

  let record: WriterLockRecord | undefined;
  try { record = parseLockRecord(JSON.parse(raw) as unknown); } catch { record = undefined; }
  return record ? inspectRecord(record) : inspectByMtime(filename);
}

async function inspectClaim(directory: string): Promise<LockInspection> {
  const recordFilename = claimRecordFilename(directory);
  let raw: string;
  try {
    raw = await readFile(recordFilename, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw ioError();
    try {
      await stat(directory);
    } catch (directoryError) {
      if (hasErrorCode(directoryError, 'ENOENT')) return { kind: 'missing' };
      throw ioError();
    }
    return inspectByMtime(directory);
  }

  let record: WriterLockRecord | undefined;
  try { record = parseLockRecord(JSON.parse(raw) as unknown); } catch { record = undefined; }
  return record ? inspectRecord(record) : inspectByMtime(recordFilename);
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'EPERM');
}

async function removeStaleClaim(directory: string, expected?: WriterLockRecord): Promise<void> {
  const current = await inspectClaim(directory);
  if (current.kind === 'missing') return;
  const tokenMatches = expected
    ? current.record?.token === expected.token
    : current.record === undefined;
  if (current.kind !== 'stale' || !tokenMatches) throw lockedError();

  try {
    await rm(claimRecordFilename(directory), { force: true });
    await rmdir(directory);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    if (isDirectoryNotEmpty(error)) throw lockedError();
    throw ioError();
  }
}

async function acquireWriterClaim(filename: string): Promise<LockClaim> {
  const directory = claimFilename(filename);
  await mkdir(path.dirname(directory), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: WriterLockRecord = {
      pid: process.pid,
      createdAt: Date.now(),
      token: randomBytes(16).toString('hex')
    };
    try {
      await mkdir(directory);
      try {
        await writeFileAtomic(claimRecordFilename(directory), serializeLockRecord(record));
      } catch (error) {
        try { await rm(claimRecordFilename(directory), { force: true }); } catch { /* best effort */ }
        try { await rmdir(directory); } catch { /* best effort */ }
        throw ioError();
      }

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          let failure: unknown;
          try {
            const current = await inspectClaim(directory);
            if (current.kind === 'missing') {
              // The claim was removed externally; there is nothing safe to unlink.
            } else if (current.kind === 'active' && current.record?.token === record.token) {
              try { await rm(claimRecordFilename(directory), { force: true }); } catch (error) { failure = error; }
              if (!failure) {
                try { await rmdir(directory); } catch (error) {
                  if (!hasErrorCode(error, 'ENOENT')) failure = isDirectoryNotEmpty(error) ? lockedError() : error;
                }
              }
            } else {
              failure = lockedError();
            }
          } catch (error) {
            failure = error;
          }
          if (failure) throw asSettingsError(failure);
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw asSettingsError(error);
      const inspection = await inspectClaim(directory);
      if (inspection.kind === 'missing') continue;
      if (inspection.kind !== 'stale') throw lockedError();
      await removeStaleClaim(directory, inspection.record);
    }
  }

  throw lockedError();
}

async function removeStaleLock(filename: string, expected?: WriterLockRecord): Promise<void> {
  const current = await inspectLock(filename);
  if (current.kind === 'missing') return;
  const tokenMatches = expected
    ? current.record?.token === expected.token
    : current.record === undefined;
  if (current.kind !== 'stale' || !tokenMatches) throw lockedError();
  try {
    await rm(filename);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw ioError();
  }
}

async function acquireWriterLock(filename: string): Promise<WriterLock> {
  const target = lockFilename(filename);
  const claim = await acquireWriterClaim(filename);
  let claimReleased = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record: WriterLockRecord = {
        pid: process.pid,
        createdAt: Date.now(),
        token: randomBytes(16).toString('hex')
      };
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(target, 'wx', 0o600);
        await handle.writeFile(serializeLockRecord(record));
        await handle.sync();

        let released = false;
        const writerLock: WriterLock = {
          async release(): Promise<void> {
            if (released) return;
            released = true;
            let failure: unknown;
            let ownsLock = false;
            try {
              const current = await inspectLock(target);
              if (current.kind === 'missing') {
                // The lock was removed externally; there is nothing safe to unlink.
              } else if (current.kind === 'active' && current.record?.token === record.token) {
                ownsLock = true;
              } else {
                failure = lockedError();
              }
            } catch (error) {
              failure = error;
            }

            try { await handle?.close(); } catch (error) { if (!failure) failure = error; }
            if (ownsLock) {
              try { await rm(target); } catch (error) {
                if (!hasErrorCode(error, 'ENOENT') && !failure) failure = error;
              }
            }
            if (failure) throw asSettingsError(failure);
          }
        };

        await claim.release();
        claimReleased = true;
        return writerLock;
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch { /* best-effort close before cleanup */ }
          try { await rm(target, { force: true }); } catch { /* preserve the original failure */ }
        }

        if (!hasErrorCode(error, 'EEXIST')) throw ioError();
        const inspection = await inspectLock(target);
        if (inspection.kind === 'missing') continue;
        if (inspection.kind !== 'stale') throw lockedError();
        await removeStaleLock(target, inspection.record);
      }
    }

    throw lockedError();
  } finally {
    if (!claimReleased) {
      try { await claim.release(); } catch { /* preserve the original failure */ }
    }
  }
}

async function moveToQuarantine(filename: string): Promise<void> {
  const directory = path.dirname(filename);
  const basename = path.basename(filename);

  for (let attempt = 0; attempt < MAX_QUARANTINE_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, `${basename}.quarantine-${randomBytes(12).toString('hex')}`);
    let reservation: Awaited<ReturnType<typeof open>> | undefined;
    try {
      reservation = await open(candidate, 'wx', 0o600);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) continue;
      throw ioError();
    }

    try {
      await reservation.close();
      await rm(candidate);
    } catch (error) {
      try { await reservation.close(); } catch { /* best-effort close */ }
      try { await rm(candidate, { force: true }); } catch { /* best-effort reservation cleanup */ }
      throw ioError();
    }

    try {
      await rename(filename, candidate);
      return;
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) continue;
      throw ioError();
    }
  }

  throw ioError();
}

export class SettingsStore {
  private value: AppSettingsV3 = defaultSettings();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filename: string, private readonly legacyFilename?: string) {}

  async load(): Promise<AppSettingsV3> {
    return this.enqueue(() => this.loadInternal());
  }

  get(): AppSettings { return structuredClone(this.value); }

  async save(next: AppSettingsV2 | AppSettingsV3): Promise<void> {
    const valid = normalizeSettings(next);
    await this.enqueue(async () => { await this.persist(valid); });
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettingsV3> {
    return this.enqueue(() => this.persistPatch(patch));
  }

  async setWorkspace(candidate: string): Promise<string> {
    return this.enqueue(async () => {
      const canonical = await canonicalizeWorkspace(candidate);
      await this.persistPatch({ workspace: canonical }, true);
      return canonical;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadInternal(): Promise<AppSettingsV3> {
    let loaded: AppSettingsV3 | undefined;
    try {
      loaded = await enqueueShared(this.filename, () => this.loadToDisk());
    } catch (error) {
      throw asSettingsError(error);
    }

    if (!loaded) throw ioError();
    this.value = structuredClone(loaded);
    return this.get();
  }

  private async persist(next: AppSettingsV3): Promise<void> {
    let committed: AppSettingsV3 | undefined;
    try {
      committed = await canonicalizeSettings(next);
      await enqueueShared(this.filename, () => this.persistToDisk(committed!));
    } catch (error) {
      throw asSettingsError(error);
    }

    if (!committed) throw ioError();
    this.value = structuredClone(committed);
  }

  private async loadToDisk(): Promise<AppSettingsV3> {
    return this.withWriterLock(async () => {
      const current = await readSettingsFile(this.filename);
      if (current.kind === 'valid') {
        if (current.file.schemaVersion === 2 || current.file.needsRewrite) {
          await this.writeNextLocked(current.file.value, current);
        }
        return current.file.value;
      }

      const backup = await readSettingsFile(`${this.filename}.bak`);
      if (backup.kind === 'valid') {
        if (current.kind === 'corrupt') await moveToQuarantine(this.filename);
        await writeFileAtomic(this.filename, serializeSettings(backup.file.value));
        return backup.file.value;
      }

      if (current.kind === 'corrupt' || backup.kind === 'corrupt') throw corruptError();

      const migrated = await this.readLegacy();
      const next = migrated ?? defaultSettings();
      await this.writeNextLocked(next, current);
      return next;
    });
  }

  private async persistToDisk(next: AppSettingsV3): Promise<void> {
    await this.withWriterLock(async () => {
      const existing = await readSettingsFile(this.filename);
      await this.writeNextLocked(next, existing);
    });
  }

  private async persistPatch(patch: Partial<AppSettings>, workspaceAlreadyCanonical = false): Promise<AppSettingsV3> {
    let committed: AppSettingsV3 | undefined;
    try {
      committed = await enqueueShared(this.filename, () => this.withWriterLock(async () => {
        const existing = await readSettingsFile(this.filename);
        if (existing.kind === 'corrupt') throw corruptError();

        let base: AppSettingsV3;
        if (existing.kind === 'valid') {
          base = existing.file.value;
        } else {
          const backup = await readSettingsFile(`${this.filename}.bak`);
          if (backup.kind === 'corrupt') throw corruptError();
          base = backup.kind === 'valid' ? backup.file.value : this.value;
        }

        const normalized = normalizeSettings({ ...base, ...patch });
        const next = workspaceAlreadyCanonical ? normalized : await canonicalizeSettings(normalized);
        await this.writeNextLocked(next, existing);
        return next;
      }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') throw error;
      throw asSettingsError(error);
    }

    if (!committed) throw ioError();
    this.value = structuredClone(committed);
    return this.get();
  }

  private async writeNextLocked(next: AppSettingsV3, existing: ReadSettingsResult): Promise<void> {
    if (existing.kind === 'corrupt') throw corruptError();

    if (existing.kind === 'missing') {
      const backup = await readSettingsFile(`${this.filename}.bak`);
      if (backup.kind === 'corrupt') throw corruptError();
      if (backup.kind === 'valid') {
        // Keep a valid backup until the new current file is safely installed.
      }
    } else {
      await writeFileAtomic(`${this.filename}.bak`, existing.file.serialized);
    }
    await writeFileAtomic(this.filename, serializeSettings(next));
  }

  private async readLegacy(): Promise<AppSettingsV3 | undefined> {
    if (!this.legacyFilename) return undefined;
    let serialized: string;
    try {
      serialized = await readFile(this.legacyFilename, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw ioError();
    }

    let raw: unknown;
    try { raw = JSON.parse(serialized) as unknown; } catch { throw corruptError(); }
    if (typeof raw !== 'object' || raw === null || typeof (raw as { workspace?: unknown }).workspace !== 'string') {
      throw corruptError();
    }

    let workspace: string;
    try {
      workspace = await realpath((raw as { workspace: string }).workspace);
      if (!(await stat(workspace)).isDirectory()) throw corruptError();
    } catch (error) {
      if (error instanceof SettingsStoreError) throw error;
      if (hasErrorCode(error, 'ENOENT')) throw corruptError();
      throw ioError();
    }
    return { ...defaultSettings(), workspace, migration: { v1Imported: true, legacyDshPrompted: false } };
  }

  private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await acquireWriterLock(this.filename);
    let operationFailed = false;
    try {
      return await operation();
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await lock.release();
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  }
}
