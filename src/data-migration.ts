import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertNoWindowsReparseComponents } from './windows-platform.js';

export type DataMigrationErrorCode =
  | 'LEGACY_DSH_CHECK_FAILED'
  | 'LEGACY_DSH_NOT_DIRECTORY'
  | 'LEGACY_DSH_UNSUPPORTED_ENTRY'
  | 'DESTINATION_EXISTS'
  | 'MIGRATION_SOURCE_DESTINATION_SAME'
  | 'MIGRATION_DESTINATION_INSIDE_SOURCE'
  | 'MIGRATION_VALIDATION_FAILED'
  | 'MIGRATION_CLEANUP_FAILED'
  | 'MIGRATION_FAILED'
  | 'PORTABLE_DATA_NOT_WRITABLE';

/** Stable, path-free errors for migration and portable-mode callers. */
export class DataMigrationError extends Error {
  readonly code: DataMigrationErrorCode;

  constructor(code: DataMigrationErrorCode) {
    super(code);
    this.name = 'DataMigrationError';
    this.code = code;
  }
}

export interface MigrationResult {
  files: number;
  directories: number;
  bytes: number;
}

interface TreeSummary {
  files: number;
  directories: number;
  bytes: number;
  digest: string;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isDestinationExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String((error as { code?: unknown }).code));
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function migrationError(error: unknown, fallback: DataMigrationErrorCode): DataMigrationError {
  return error instanceof DataMigrationError ? error : new DataMigrationError(fallback);
}

export function getLegacyDshPath(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.dsh');
}

/** Detects the legacy path without reading any configuration or file content. */
export async function detectLegacyDsh(source = getLegacyDshPath()): Promise<boolean> {
  try {
    await lstat(path.resolve(source));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw new DataMigrationError('LEGACY_DSH_CHECK_FAILED');
  }
}

export const legacyDshExists = detectLegacyDsh;
export const hasLegacyDsh = detectLegacyDsh;

async function requireSourceDirectory(source: string): Promise<string> {
  const sourcePath = path.resolve(source);
  try { assertNoWindowsReparseComponents(sourcePath); }
  catch { throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY'); }
  let info;
  try {
    info = await lstat(sourcePath);
  } catch (error) {
    if (isNotFound(error)) throw new DataMigrationError('LEGACY_DSH_NOT_DIRECTORY');
    throw new DataMigrationError('LEGACY_DSH_CHECK_FAILED');
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DataMigrationError('LEGACY_DSH_NOT_DIRECTORY');

  try {
    return await realpath(sourcePath);
  } catch {
    throw new DataMigrationError('LEGACY_DSH_CHECK_FAILED');
  }
}

async function resolvePotentialPath(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  const tail: string[] = [];
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isNotFound(error)) throw new DataMigrationError('MIGRATION_FAILED');
      const parent = path.dirname(existing);
      if (parent === existing) throw new DataMigrationError('MIGRATION_FAILED');
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  try {
    return path.join(await realpath(existing), ...tail);
  } catch {
    throw new DataMigrationError('MIGRATION_FAILED');
  }
}

async function resolveDestination(destination: string, sourceRoot: string): Promise<string> {
  const destinationPath = path.resolve(destination);
  try { assertNoWindowsReparseComponents(destinationPath); }
  catch { throw new DataMigrationError('MIGRATION_FAILED'); }
  if (isSameOrInside(destinationPath, sourceRoot)) {
    throw new DataMigrationError(destinationPath === sourceRoot ? 'MIGRATION_SOURCE_DESTINATION_SAME' : 'MIGRATION_DESTINATION_INSIDE_SOURCE');
  }
  const potential = await resolvePotentialPath(destinationPath);
  if (isSameOrInside(potential, sourceRoot)) {
    throw new DataMigrationError(potential === sourceRoot ? 'MIGRATION_SOURCE_DESTINATION_SAME' : 'MIGRATION_DESTINATION_INSIDE_SOURCE');
  }
  const parent = path.dirname(destinationPath);
  try {
    await mkdir(parent, { recursive: true });
    assertNoWindowsReparseComponents(destinationPath);
    const canonicalParent = await realpath(parent);
    const canonical = path.join(canonicalParent, path.basename(destinationPath));
    if (isSameOrInside(canonical, sourceRoot)) {
      throw new DataMigrationError(canonical === sourceRoot ? 'MIGRATION_SOURCE_DESTINATION_SAME' : 'MIGRATION_DESTINATION_INSIDE_SOURCE');
    }
    return canonical;
  } catch (error) {
    throw migrationError(error, 'MIGRATION_FAILED');
  }
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new DataMigrationError('DESTINATION_EXISTS');
  } catch (error) {
    if (error instanceof DataMigrationError) throw error;
    if (!isNotFound(error)) throw new DataMigrationError('MIGRATION_FAILED');
  }
}

async function copyTree(sourceRoot: string, currentSource: string, currentDestination: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentSource, { withFileTypes: true });
  } catch {
    throw new DataMigrationError('MIGRATION_FAILED');
  }

  for (const entry of entries) {
    const sourceEntry = path.join(currentSource, entry.name);
    const destinationEntry = path.join(currentDestination, entry.name);
    try { assertNoWindowsReparseComponents(sourceEntry); }
    catch { throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY'); }
    let info;
    try {
      info = await lstat(sourceEntry);
    } catch {
      throw new DataMigrationError('MIGRATION_FAILED');
    }

    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY');
    }

    // Check the resolved source path before copying so a replaced link cannot
    // make the recursive copy leave the legacy tree.
    let resolvedEntry;
    try {
      resolvedEntry = await realpath(sourceEntry);
    } catch {
      throw new DataMigrationError('MIGRATION_FAILED');
    }
    if (!isSameOrInside(resolvedEntry, sourceRoot)) throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY');

    if (info.isDirectory()) {
      try {
        await mkdir(destinationEntry);
      } catch {
        throw new DataMigrationError('MIGRATION_FAILED');
      }
      await copyTree(sourceRoot, resolvedEntry, destinationEntry);
    } else {
      try {
        await copyFile(resolvedEntry, destinationEntry);
      } catch {
        throw new DataMigrationError('MIGRATION_FAILED');
      }
    }
  }
}

async function summarizeTree(root: string): Promise<TreeSummary> {
  const summary: TreeSummary = { files: 0, directories: 0, bytes: 0, digest: '' };
  const treeHash = createHash('sha256');

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new DataMigrationError('MIGRATION_FAILED');
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      try { assertNoWindowsReparseComponents(filename); }
      catch { throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY'); }
      let info;
      try {
        info = await lstat(filename);
      } catch {
        throw new DataMigrationError('MIGRATION_FAILED');
      }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new DataMigrationError('LEGACY_DSH_UNSUPPORTED_ENTRY');
      }
      if (info.isDirectory()) {
        summary.directories += 1;
        treeHash.update(`d\0${path.relative(root, filename)}\0`);
        await visit(filename);
      } else {
        summary.files += 1;
        summary.bytes += info.size;
        const fileHash = createHash('sha256');
        try {
          for await (const chunk of createReadStream(filename)) fileHash.update(chunk as Buffer);
        } catch {
          throw new DataMigrationError('MIGRATION_FAILED');
        }
        treeHash.update(`f\0${path.relative(root, filename)}\0${info.size}\0${fileHash.digest('hex')}\0`);
      }
    }
  }

  await visit(root);
  summary.digest = treeHash.digest('hex');
  return summary;
}

function sameSummary(left: TreeSummary, right: TreeSummary): boolean {
  return left.files === right.files && left.directories === right.directories && left.bytes === right.bytes && left.digest === right.digest;
}

/**
 * Copies legacy DSH data through same-volume staging and atomically publishes it.
 * The source is never removed or modified. Symlinks and special files are refused.
 */
export async function copyLegacyDsh(source: string, destination: string): Promise<MigrationResult> {
  const sourceRoot = await requireSourceDirectory(source);
  const destinationPath = await resolveDestination(destination, sourceRoot);
  await assertDestinationAbsent(destinationPath);

  const before = await summarizeTree(sourceRoot);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(path.join(path.dirname(destinationPath), '.adhd-one-dsh-staging-'));
    await copyTree(sourceRoot, sourceRoot, staging);

    const sourceAfter = await summarizeTree(sourceRoot);
    const staged = await summarizeTree(staging);
    if (!sameSummary(before, sourceAfter) || !sameSummary(before, staged)) {
      throw new DataMigrationError('MIGRATION_VALIDATION_FAILED');
    }

    await assertDestinationAbsent(destinationPath);
    try {
      await rename(staging, destinationPath);
    } catch (error) {
      if (isDestinationExists(error)) throw new DataMigrationError('DESTINATION_EXISTS');
      throw new DataMigrationError('MIGRATION_FAILED');
    }
    staging = undefined;
    return before;
  } catch (error) {
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true });
      } catch {
        throw new DataMigrationError('MIGRATION_CLEANUP_FAILED');
      }
    }
    throw migrationError(error, 'MIGRATION_FAILED');
  }
}

export type LegacyDshImportOutcome = 'imported' | 'declined' | 'deferred';

/** Keeps prompt bookkeeping separate from the staged copy so a failed import remains retryable. */
export async function runLegacyDshImportFlow(options: {
  accepted: boolean;
  copy(): Promise<void>;
  markPrompted(): Promise<void>;
  retryAfterFailure(): Promise<boolean>;
}): Promise<LegacyDshImportOutcome> {
  if (!options.accepted) {
    await options.markPrompted();
    return 'declined';
  }

  for (;;) {
    try {
      await options.copy();
      break;
    } catch {
      if (!await options.retryAfterFailure()) return 'deferred';
    }
  }
  await options.markPrompted();
  return 'imported';
}

/**
 * Verifies portable data can be written, flushed, and removed in-place.
 * It intentionally does not create the directory or fall back to another path.
 */
export async function assertPortableDataWritable(directory: string): Promise<void> {
  const directoryPath = path.resolve(directory);
  try {
    const info = await lstat(directoryPath);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new DataMigrationError('PORTABLE_DATA_NOT_WRITABLE');
  } catch (error) {
    throw migrationError(error, 'PORTABLE_DATA_NOT_WRITABLE');
  }

  const probe = path.join(directoryPath, `.adhd-one-write-${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  let failed = false;
  try {
    handle = await open(probe, 'wx', 0o600);
    await handle.writeFile('adhd-one-write-probe\n', 'utf8');
    await handle.sync();
  } catch {
    failed = true;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
    try {
      await rm(probe, { force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new DataMigrationError('PORTABLE_DATA_NOT_WRITABLE');
}
