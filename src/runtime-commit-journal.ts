import { randomBytes } from 'node:crypto';
import { readFile, rename as fsRename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { writeFileAtomic } from './settings-store.js';
import { assertNoWindowsReparseComponents } from './windows-platform.js';

export const runtimeCommitPhaseSchema = z.enum([
  'prepared',
  'backup-done',
  'published',
  'state-committed'
]);

export type RuntimeCommitPhase = z.infer<typeof runtimeCommitPhaseSchema>;
export type RuntimeCommitSlot = 'A' | 'B';

/** Runtime state is deliberately opaque to this independent transaction module. */
export type RuntimeCommitState = Record<string, unknown>;

const runtimeCommitStateSchema = z.record(z.string(), z.unknown());

function usesWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function pathApi(...values: string[]) {
  return values.some(usesWindowsPath) ? path.win32 : path.posix;
}

function hasWindowsAmbiguousComponent(value: string): boolean {
  const normalized = value.replaceAll('/', '\\');
  const root = path.win32.parse(normalized).root;
  return normalized.slice(root.length).split('\\').some(part => part.length > 0
    && part !== '.' && part !== '..' && /[. ]$/u.test(part));
}

/**
 * Windows path comparisons are case-insensitive and ignore trailing dots and
 * spaces in each component. Keep the returned path lexical: it may not exist.
 */
function canonicalPath(value: string): string {
  const api = pathApi(value);
  const resolved = api.resolve(value);
  const normalized = api.normalize(resolved);
  const parsed = api.parse(normalized);
  const components = normalized.slice(parsed.root.length).split(api.sep).filter(Boolean)
    .map(component => component.replace(/[. ]+$/u, '').toLowerCase())
    .filter(Boolean);
  return `${parsed.root.toLowerCase()}${components.join(api.sep)}`;
}

function isCanonicalPathInside(root: string, candidate: string): boolean {
  const api = pathApi(root, candidate);
  const resolvedRoot = canonicalPath(root);
  const resolvedCandidate = canonicalPath(candidate);
  const relative = api.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}

function isRestrictedRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || hasWindowsAmbiguousComponent(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  return normalized.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !part.includes(':'));
}

const restrictedRelativePathSchema = z.string().min(1).refine(isRestrictedRelativePath, {
  message: 'path must be a restricted relative path'
});

/** The on-disk contract. Keep this object strict: unknown keys are not journal data. */
export const runtimeCommitJournalSchema = z.object({
  schemaVersion: z.literal(1),
  txid: z.string().regex(/^[0-9a-f]{16}$/u),
  slot: z.enum(['A', 'B']),
  phase: runtimeCommitPhaseSchema,
  stagingRoot: restrictedRelativePathSchema,
  staging: restrictedRelativePathSchema,
  destination: restrictedRelativePathSchema,
  backup: restrictedRelativePathSchema,
  beforeState: runtimeCommitStateSchema.nullable(),
  afterState: runtimeCommitStateSchema,
  destinationWasPresent: z.boolean()
}).strict();

export type RuntimeCommitJournal = z.infer<typeof runtimeCommitJournalSchema>;

export interface CreateRuntimeCommitJournalInput {
  txid?: string;
  slot: RuntimeCommitSlot;
  stagingRoot: string;
  staging: string;
  destination: string;
  backup: string;
  beforeState: RuntimeCommitState | null;
  afterState: RuntimeCommitState;
  destinationWasPresent: boolean;
}

export function createRuntimeCommitTxid(): string {
  return randomBytes(8).toString('hex');
}

export function createRuntimeCommitJournal(input: CreateRuntimeCommitJournalInput): RuntimeCommitJournal {
  return runtimeCommitJournalSchema.parse({
    schemaVersion: 1,
    txid: input.txid ?? createRuntimeCommitTxid(),
    slot: input.slot,
    phase: 'prepared',
    stagingRoot: input.stagingRoot,
    staging: input.staging,
    destination: input.destination,
    backup: input.backup,
    beforeState: input.beforeState,
    afterState: input.afterState,
    destinationWasPresent: input.destinationWasPresent
  });
}

export function parseRuntimeCommitJournal(value: unknown): RuntimeCommitJournal {
  return runtimeCommitJournalSchema.parse(value);
}

export function serializeRuntimeCommitJournal(value: RuntimeCommitJournal): string {
  return `${JSON.stringify(parseRuntimeCommitJournal(value))}\n`;
}

/** Atomic journal persistence for callers that have a journal filename. */
export async function writeRuntimeCommitJournal(filename: string, value: RuntimeCommitJournal): Promise<void> {
  if (typeof filename !== 'string' || filename.length === 0 || filename.includes('\0')
    || hasWindowsAmbiguousComponent(filename)) throw pathError('journalFile');
  assertNoWindowsReparseComponents(filename);
  await writeFileAtomic(filename, serializeRuntimeCommitJournal(value));
}

const phaseOrder: Record<RuntimeCommitPhase, number> = {
  prepared: 0,
  'backup-done': 1,
  published: 2,
  'state-committed': 3
};

export function advanceRuntimeCommitJournal(
  value: RuntimeCommitJournal,
  phase: RuntimeCommitPhase
): RuntimeCommitJournal {
  const current = parseRuntimeCommitJournal(value);
  if (phaseOrder[phase] < phaseOrder[current.phase]
    || phaseOrder[phase] > phaseOrder[current.phase] + 1) {
    throw new Error('RUNTIME_COMMIT_PHASE_ORDER_INVALID');
  }
  return runtimeCommitJournalSchema.parse({ ...current, phase });
}

export interface RuntimeCommitResolvedPaths {
  runtimeRoot: string;
  stagingRoot: string;
  staging: string;
  destination: string;
  backup: string;
}

function pathsEqual(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function pathsOverlap(left: string, right: string): boolean {
  return isCanonicalPathInside(left, right) || isCanonicalPathInside(right, left);
}

function pathError(field: string): Error {
  return new Error(`RUNTIME_COMMIT_PATH_INVALID:${field}`);
}

function resolveRestrictedPath(root: string, value: string, field: string): string {
  if (!isRestrictedRelativePath(value)) throw pathError(field);
  const api = pathApi(root);
  const candidate = api.resolve(root, ...value.replaceAll('\\', '/').split('/'));
  if (!isCanonicalPathInside(root, candidate) || pathsEqual(root, candidate)) throw pathError(field);
  return candidate;
}

function protectedRuntimeDirectories(root: string): string[] {
  const api = pathApi(root);
  return [
    api.resolve(root, 'bundled'),
    api.resolve(root, 'slot-A'),
    api.resolve(root, 'slot-B')
  ];
}

function assertTransactionPathSafe(candidate: string, root: string, field: string): void {
  if (pathsEqual(root, candidate) || protectedRuntimeDirectories(root).some(protectedPath => pathsOverlap(protectedPath, candidate))) {
    throw pathError(field);
  }
}

/** Resolve and validate every journal path before any injected operation runs. */
export function resolveRuntimeCommitPaths(
  runtimeRoot: string,
  value: RuntimeCommitJournal
): RuntimeCommitResolvedPaths {
  const journal = parseRuntimeCommitJournal(value);
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) throw pathError('runtimeRoot');
  if (runtimeRoot.includes('\0') || hasWindowsAmbiguousComponent(runtimeRoot)) throw pathError('runtimeRoot');
  const api = pathApi(runtimeRoot);
  const root = api.resolve(runtimeRoot);
  const stagingRoot = resolveRestrictedPath(root, journal.stagingRoot, 'stagingRoot');
  const destination = resolveRestrictedPath(root, journal.destination, 'destination');
  const backup = resolveRestrictedPath(root, journal.backup, 'backup');

  const expectedDestination = api.resolve(root, `slot-${journal.slot}`);
  if (journal.destination !== `slot-${journal.slot}` || !pathsEqual(destination, expectedDestination)) {
    throw pathError('destination');
  }

  assertTransactionPathSafe(stagingRoot, root, 'stagingRoot');
  assertTransactionPathSafe(backup, root, 'backup');

  let staging = resolveRestrictedPath(root, journal.staging, 'staging');
  assertTransactionPathSafe(staging, root, 'staging');
  if (!isCanonicalPathInside(stagingRoot, staging) || pathsEqual(stagingRoot, staging)) {
    const nestedStaging = resolveRestrictedPath(stagingRoot, journal.staging, 'staging');
    if (!isCanonicalPathInside(stagingRoot, nestedStaging) || pathsEqual(stagingRoot, nestedStaging)) throw pathError('staging');
    staging = nestedStaging;
  }

  assertTransactionPathSafe(staging, root, 'staging');
  if (pathsOverlap(stagingRoot, destination) || pathsOverlap(destination, staging)
    || pathsOverlap(stagingRoot, backup) || pathsOverlap(staging, backup)) {
    throw pathError('overlap');
  }

  return { runtimeRoot: root, stagingRoot, staging, destination, backup };
}

export interface RuntimeCommitFsOperations {
  exists(filename: string): Promise<boolean>;
  rename(source: string, destination: string): Promise<void>;
  remove(filename: string): Promise<void>;
  readState(filename: string): Promise<RuntimeCommitState | null>;
  writeState(filename: string, state: RuntimeCommitState): Promise<void>;
  /** Check every existing component for symlink, junction, or reparse state. */
  assertNoReparseComponents?(filename: string): void | Promise<void>;
  /** Persist the next journal phase atomically. */
  checkpoint?(journal: RuntimeCommitJournal): Promise<void>;
  /** Alias for checkpoint for callers that name the operation after its data. */
  writeJournal?(journal: RuntimeCommitJournal): Promise<void>;
}

export interface RecoverRuntimeCommitRequest {
  runtimeRoot: string;
  stateFile: string;
  journal: RuntimeCommitJournal;
  /** Optional path for the default atomic checkpoint writer. */
  journalFile?: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const defaultRuntimeCommitFsOperations: Omit<RuntimeCommitFsOperations, 'checkpoint' | 'writeJournal'> = {
  exists: async filename => {
    try {
      await stat(filename);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
  rename: async (source, destination) => { await fsRename(source, destination); },
  remove: async filename => { await rm(filename, { recursive: true, force: true }); },
  assertNoReparseComponents: assertNoWindowsReparseComponents,
  readState: async filename => {
    try {
      const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
      return runtimeCommitStateSchema.parse(parsed);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error('RUNTIME_COMMIT_STATE_INVALID', { cause: error });
    }
  },
  writeState: async (filename, state) => {
    const parsed = runtimeCommitStateSchema.parse(state);
    await writeFileAtomic(filename, `${JSON.stringify(parsed)}\n`);
  }
};

function controlPath(root: string, value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || hasWindowsAmbiguousComponent(value)) {
    throw pathError(field);
  }
  const api = pathApi(root, value);
  const candidate = api.isAbsolute(value)
    ? api.resolve(value)
    : resolveRestrictedPath(root, value, field);
  if (!isCanonicalPathInside(root, candidate) || pathsEqual(root, candidate)) throw pathError(field);
  return candidate;
}

function assertControlPathSafe(
  candidate: string,
  root: string,
  paths: RuntimeCommitResolvedPaths,
  field: string
): void {
  if (pathsEqual(candidate, root)) throw pathError(field);
  if (protectedRuntimeDirectories(root).some(protectedPath => pathsOverlap(protectedPath, candidate))) {
    throw pathError(field);
  }
  for (const transactionPath of [paths.stagingRoot, paths.staging, paths.destination, paths.backup]) {
    if (pathsOverlap(transactionPath, candidate)) throw pathError(field);
  }
}

function stateEquals(left: RuntimeCommitState | null, right: RuntimeCommitState | null): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function ambiguous(detail: string, cause?: unknown): Error {
  const message = `RUNTIME_COMMIT_AMBIGUOUS:${detail}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

async function assertNoReparseComponents(
  operations: RuntimeCommitFsOperations,
  filename: string
): Promise<void> {
  await (operations.assertNoReparseComponents ?? assertNoWindowsReparseComponents)(filename);
}

async function safeExists(operations: RuntimeCommitFsOperations, filename: string): Promise<boolean> {
  await assertNoReparseComponents(operations, filename);
  return operations.exists(filename);
}

async function safeReadState(
  operations: RuntimeCommitFsOperations,
  filename: string
): Promise<RuntimeCommitState | null> {
  await assertNoReparseComponents(operations, filename);
  return operations.readState(filename);
}

async function safeWriteState(
  operations: RuntimeCommitFsOperations,
  filename: string,
  state: RuntimeCommitState
): Promise<void> {
  await assertNoReparseComponents(operations, filename);
  await operations.writeState(filename, state);
}

async function safeRename(
  operations: RuntimeCommitFsOperations,
  source: string,
  destination: string
): Promise<void> {
  const retryDelays = [0, 50, 100, 200, 400, 800, 1_000] as const;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]! > 0) await delay(retryDelays[attempt]);
    // A Windows scanner can release one handle while another filesystem entry
    // changes. Revalidate the complete path immediately before every retry.
    await assertNoReparseComponents(operations, source);
    await assertNoReparseComponents(operations, destination);
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt === retryDelays.length - 1) throw error;
    }
  }
}

async function safeRemove(operations: RuntimeCommitFsOperations, filename: string): Promise<void> {
  await assertNoReparseComponents(operations, filename);
  await operations.remove(filename);
}

function assertCleanupTargetSafe(filename: string, root: string, protectedPaths: readonly string[]): void {
  assertTransactionPathSafe(filename, root, 'cleanup');
  if (protectedPaths.some(protectedPath => pathsOverlap(protectedPath, filename))) {
    throw new Error('RUNTIME_COMMIT_PROTECTED_PATH');
  }
}

async function checkpoint(
  journalFile: string | undefined,
  operations: RuntimeCommitFsOperations,
  journal: RuntimeCommitJournal
): Promise<void> {
  if (journalFile !== undefined) await assertNoReparseComponents(operations, journalFile);
  if (operations.checkpoint) {
    await operations.checkpoint(journal);
    return;
  }
  if (operations.writeJournal) {
    await operations.writeJournal(journal);
    return;
  }
  if (journalFile !== undefined) {
    await writeRuntimeCommitJournal(journalFile, journal);
    return;
  }
  throw new Error('RUNTIME_COMMIT_CHECKPOINT_UNAVAILABLE');
}

async function recoverBackup(
  journal: RuntimeCommitJournal,
  paths: RuntimeCommitResolvedPaths,
  operations: RuntimeCommitFsOperations
): Promise<void> {
  const [destinationPresent, backupPresent, stagingPresent] = await Promise.all([
    safeExists(operations, paths.destination),
    safeExists(operations, paths.backup),
    safeExists(operations, paths.staging)
  ]);
  if (!stagingPresent) throw ambiguous('staging-missing-before-publish');
  if (destinationPresent && backupPresent) throw ambiguous('destination-and-backup-both-present');

  if (journal.destinationWasPresent) {
    if (destinationPresent && !backupPresent) {
      await safeRename(operations, paths.destination, paths.backup);
    } else if (!destinationPresent && backupPresent) {
      // The rename completed but its journal checkpoint did not.
    } else {
      throw ambiguous('destination-presence-does-not-match-journal');
    }
    if (await safeExists(operations, paths.destination) || !await safeExists(operations, paths.backup)) {
      throw ambiguous('backup-rename-not-observed');
    }
  } else if (destinationPresent || backupPresent) {
    throw ambiguous('unexpected-destination-or-backup');
  }
}

async function recoverPublish(
  journal: RuntimeCommitJournal,
  paths: RuntimeCommitResolvedPaths,
  operations: RuntimeCommitFsOperations
): Promise<void> {
  const [destinationPresent, backupPresent, stagingPresent] = await Promise.all([
    safeExists(operations, paths.destination),
    safeExists(operations, paths.backup),
    safeExists(operations, paths.staging)
  ]);
  if (backupPresent !== journal.destinationWasPresent) throw ambiguous('backup-presence-does-not-match-journal');
  if (destinationPresent && stagingPresent) throw ambiguous('staging-and-destination-both-present');
  if (!destinationPresent && !stagingPresent) throw ambiguous('staging-and-destination-both-missing');

  if (stagingPresent) {
    await safeRename(operations, paths.staging, paths.destination);
  }
  if (!await safeExists(operations, paths.destination) || await safeExists(operations, paths.staging)) {
    throw ambiguous('publish-rename-not-observed');
  }
}

async function recoverState(
  journal: RuntimeCommitJournal,
  paths: RuntimeCommitResolvedPaths,
  stateFile: string,
  operations: RuntimeCommitFsOperations
): Promise<void> {
  const [destinationPresent, backupPresent, stagingPresent] = await Promise.all([
    safeExists(operations, paths.destination),
    safeExists(operations, paths.backup),
    safeExists(operations, paths.staging)
  ]);
  if (!destinationPresent) throw ambiguous('published-destination-missing');
  if (stagingPresent) throw ambiguous('staging-present-after-publish');
  if (backupPresent !== journal.destinationWasPresent) throw ambiguous('backup-presence-does-not-match-journal');

  const currentState = await safeReadState(operations, stateFile);
  if (stateEquals(currentState, journal.afterState)) return;
  if (!stateEquals(currentState, journal.beforeState)) throw ambiguous('state-does-not-match-before-or-after');
  await safeWriteState(operations, stateFile, journal.afterState);
  if (!stateEquals(await safeReadState(operations, stateFile), journal.afterState)) {
    throw ambiguous('state-write-not-observed');
  }
}

async function cleanupCommitted(
  request: RecoverRuntimeCommitRequest,
  paths: RuntimeCommitResolvedPaths,
  stateFile: string,
  journalFile: string | undefined,
  operations: RuntimeCommitFsOperations
): Promise<void> {
  const protectedPaths = journalFile === undefined ? [stateFile] : [stateFile, journalFile];
  if (!await safeExists(operations, paths.destination)) throw ambiguous('committed-destination-missing');
  if (!await safeExists(operations, stateFile)) throw ambiguous('committed-state-missing');

  let committedState: RuntimeCommitState | null;
  try {
    committedState = await safeReadState(operations, stateFile);
  } catch (error) {
    throw ambiguous('committed-state-invalid', error);
  }
  if (!stateEquals(committedState, request.journal.afterState)) {
    throw ambiguous('committed-state-does-not-match-after');
  }

  if (!request.journal.destinationWasPresent && await safeExists(operations, paths.backup)) {
    throw ambiguous('unexpected-backup-after-commit');
  }

  if (await safeExists(operations, paths.backup)) {
    assertCleanupTargetSafe(paths.backup, paths.runtimeRoot, protectedPaths);
    await safeRemove(operations, paths.backup);
  }
  if (await safeExists(operations, paths.stagingRoot)) {
    assertCleanupTargetSafe(paths.stagingRoot, paths.runtimeRoot, protectedPaths);
    await safeRemove(operations, paths.stagingRoot);
  }
  if (journalFile !== undefined && await safeExists(operations, journalFile)) {
    assertCleanupTargetSafe(journalFile, paths.runtimeRoot, [stateFile]);
    await safeRemove(operations, journalFile);
  }
}

/**
 * Finish a committed runtime transaction without rolling back to an older state.
 * Every forward step is checkpointed after its filesystem mutation. If a
 * checkpoint was lost, the next invocation recognizes the one safe completed
 * shape; every other shape fails closed before a destructive operation.
 */
export async function recoverRuntimeCommit(
  request: RecoverRuntimeCommitRequest,
  injectedOperations: RuntimeCommitFsOperations = defaultRuntimeCommitFsOperations
): Promise<RuntimeCommitJournal> {
  const journal = parseRuntimeCommitJournal(request.journal);
  const paths = resolveRuntimeCommitPaths(request.runtimeRoot, journal);
  const stateFile = controlPath(paths.runtimeRoot, request.stateFile, 'stateFile');
  assertControlPathSafe(stateFile, paths.runtimeRoot, paths, 'stateFile');
  const journalFile = request.journalFile === undefined
    ? undefined
    : controlPath(paths.runtimeRoot, request.journalFile, 'journalFile');
  if (journalFile !== undefined) assertControlPathSafe(journalFile, paths.runtimeRoot, paths, 'journalFile');
  if (journalFile !== undefined && pathsOverlap(stateFile, journalFile)) throw pathError('journalFile');

  const criticalPaths = [
    paths.runtimeRoot,
    ...protectedRuntimeDirectories(paths.runtimeRoot),
    paths.stagingRoot,
    paths.staging,
    paths.destination,
    paths.backup,
    stateFile,
    ...(journalFile === undefined ? [] : [journalFile])
  ];
  for (const criticalPath of criticalPaths) await assertNoReparseComponents(injectedOperations, criticalPath);

  let current = journal;
  if (current.phase === 'prepared') {
    await recoverBackup(current, paths, injectedOperations);
    current = advanceRuntimeCommitJournal(current, 'backup-done');
    await checkpoint(journalFile, injectedOperations, current);
  }
  if (current.phase === 'backup-done') {
    await recoverPublish(current, paths, injectedOperations);
    current = advanceRuntimeCommitJournal(current, 'published');
    await checkpoint(journalFile, injectedOperations, current);
  }
  if (current.phase === 'published') {
    await recoverState(current, paths, stateFile, injectedOperations);
    current = advanceRuntimeCommitJournal(current, 'state-committed');
    await checkpoint(journalFile, injectedOperations, current);
  }
  if (current.phase === 'state-committed') {
    await cleanupCommitted(request, paths, stateFile, journalFile, injectedOperations);
  }
  return current;
}
