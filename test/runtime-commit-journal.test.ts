import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceRuntimeCommitJournal,
  createRuntimeCommitJournal,
  parseRuntimeCommitJournal,
  recoverRuntimeCommit,
  resolveRuntimeCommitPaths,
  runtimeCommitJournalSchema,
  serializeRuntimeCommitJournal,
  writeRuntimeCommitJournal,
  type RuntimeCommitFsOperations,
  type RuntimeCommitJournal,
  type RuntimeCommitState
} from '../src/runtime-commit-journal.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function state(value: string): RuntimeCommitState {
  return { schemaVersion: 1, active: value, healthy: true };
}

function makeJournal(overrides: Partial<RuntimeCommitJournal> = {}): RuntimeCommitJournal {
  return createRuntimeCommitJournal({
    txid: '0123456789abcdef',
    slot: 'B',
    stagingRoot: 'staging-tx',
    staging: 'staging-tx/slot-B',
    destination: 'slot-B',
    backup: 'backup-tx',
    beforeState: state('A'),
    afterState: state('B'),
    destinationWasPresent: true,
    ...overrides
  });
}

type FakeFilesystem = {
  root: string;
  state: RuntimeCommitState | null;
  entries: Set<string>;
  journal: RuntimeCommitJournal;
  checkpoints: RuntimeCommitJournal[];
  removals: string[];
  renames: Array<{ source: string; destination: string }>;
  reparseChecks: string[];
  operations: RuntimeCommitFsOperations;
};

async function fakeFilesystem(journal = makeJournal()): Promise<FakeFilesystem> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-commit-journal-'));
  roots.push(root);
  const paths = resolveRuntimeCommitPaths(root, journal);
  const entries = new Set<string>([paths.stagingRoot, paths.staging, paths.destination, path.join(root, 'slot-A')]);
  const fake: FakeFilesystem = {
    root,
    state: state('A'),
    entries,
    journal,
    checkpoints: [],
    removals: [],
    renames: [],
    reparseChecks: [],
    operations: undefined as never
  };
  const has = (filename: string): boolean => {
    if (entries.has(filename)) return true;
    for (const entry of entries) if (entry.startsWith(`${filename}${path.sep}`)) return true;
    return false;
  };
  const operations: RuntimeCommitFsOperations = {
    exists: async filename => has(filename),
    rename: async (source, destination) => {
      fake.renames.push({ source, destination });
      if (!has(source)) throw new Error(`MISSING:${source}`);
      if (has(destination)) throw new Error(`EXISTS:${destination}`);
      const moved = [...entries].filter(entry => entry === source || entry.startsWith(`${source}${path.sep}`));
      for (const entry of moved) entries.delete(entry);
      for (const entry of moved) entries.add(destination + entry.slice(source.length));
    },
    remove: async filename => {
      fake.removals.push(filename);
      for (const entry of [...entries]) {
        if (entry === filename || entry.startsWith(`${filename}${path.sep}`)) entries.delete(entry);
      }
    },
    readState: async () => fake.state === null ? null : structuredClone(fake.state),
    writeState: async (filename, nextState) => {
      fake.state = structuredClone(nextState);
      entries.add(filename);
    },
    assertNoReparseComponents: async filename => {
      fake.reparseChecks.push(filename);
    },
    checkpoint: async nextJournal => {
      fake.checkpoints.push(nextJournal);
      fake.journal = nextJournal;
    }
  };
  fake.operations = operations;
  return fake;
}

function request(fake: FakeFilesystem, journal = fake.journal) {
  return {
    runtimeRoot: fake.root,
    stateFile: 'runtime-state.json',
    journal,
    journalFile: '.runtime-commit-journal.json'
  };
}

describe('runtime commit journal data contract', () => {
  it('creates a prepared schema-v1 journal with a 16-hex txid and serializes it', () => {
    const journal = makeJournal();
    expect(journal).toMatchObject({ schemaVersion: 1, txid: '0123456789abcdef', slot: 'B', phase: 'prepared' });
    expect(parseRuntimeCommitJournal(JSON.parse(serializeRuntimeCommitJournal(journal)))).toEqual(journal);
    expect(() => runtimeCommitJournalSchema.parse({ ...journal, extra: true })).toThrow();
    expect(() => runtimeCommitJournalSchema.parse({ ...journal, txid: 'short' })).toThrow();
    expect(() => advanceRuntimeCommitJournal(journal, 'published')).toThrow('RUNTIME_COMMIT_PHASE_ORDER_INVALID');
  });

  it('rejects absolute and traversal paths for every restricted journal path', () => {
    for (const field of ['stagingRoot', 'staging', 'destination', 'backup'] as const) {
      expect(() => createRuntimeCommitJournal({
        txid: '0123456789abcdef',
        slot: 'B',
        stagingRoot: 'staging-tx',
        staging: 'staging-tx/slot-B',
        destination: 'slot-B',
        backup: 'backup-tx',
        beforeState: state('A'),
        afterState: state('B'),
        destinationWasPresent: true,
        [field]: `..${path.sep}outside`
      })).toThrow();
    }
    expect(() => resolveRuntimeCommitPaths('C:\\runtime', makeJournal({ destination: 'slot-A' }))).toThrow('RUNTIME_COMMIT_PATH_INVALID');
    expect(() => resolveRuntimeCommitPaths('C:\\runtime', makeJournal({ backup: 'slot-A' }))).toThrow('RUNTIME_COMMIT_PATH_INVALID');
  });

  it('rejects case and trailing-dot aliases of bundled and both slots for every transaction path', () => {
    for (const [field, value] of [
      ['stagingRoot', 'BUNDLED'],
      ['stagingRoot', 'slot-a.'],
      ['staging', 'sLoT-A'],
      ['staging', 'slot-b.'],
      ['backup', 'BuNdLeD'],
      ['backup', 'SLOT-B.']
    ] as const) {
      expect(() => resolveRuntimeCommitPaths('C:\\runtime', makeJournal({ [field]: value }))).toThrow();
    }
    expect(() => resolveRuntimeCommitPaths('C:\\runtime', makeJournal({ destination: 'SLOT-B' }))).toThrow('RUNTIME_COMMIT_PATH_INVALID:destination');
  });

  it('rejects canonical aliases between state, journal, transaction paths, and protected slots', async () => {
    const fake = await fakeFilesystem();
    for (const [field, value] of [
      ['stateFile', 'SLOT-A'],
      ['stateFile', 'slot-a.'],
      ['journalFile', 'sLoT-B'],
      ['journalFile', 'slot-b.']
    ] as const) {
      await expect(recoverRuntimeCommit({ ...request(fake), [field]: value }, fake.operations)).rejects.toThrow();
    }

    await expect(recoverRuntimeCommit({
      ...request(fake),
      stateFile: 'runtime-state.json',
      journalFile: 'RUNTIME-STATE.JSON'
    }, fake.operations)).rejects.toThrow('RUNTIME_COMMIT_PATH_INVALID:journalFile');

    const stateAliasJournal = await fakeFilesystem(makeJournal({ backup: 'runtime-state.json' }));
    await expect(recoverRuntimeCommit(request(stateAliasJournal), stateAliasJournal.operations)).rejects.toThrow();
  });
});

describe('recoverRuntimeCommit', () => {
  it('retries transient Windows rename sharing violations and revalidates paths', async () => {
    const fake = await fakeFilesystem();
    const originalRename = fake.operations.rename;
    let attempts = 0;
    fake.operations.rename = async (source, destination) => {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error('scanner still holds the directory'), { code: 'EPERM' });
      await originalRename(source, destination);
    };

    await recoverRuntimeCommit(request(fake), fake.operations);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(fake.reparseChecks.length).toBeGreaterThan(10);
    expect(fake.state).toEqual(state('B'));
  });

  it('does not retry a non-transient rename failure', async () => {
    const fake = await fakeFilesystem();
    let attempts = 0;
    fake.operations.rename = async () => {
      attempts += 1;
      throw Object.assign(new Error('invalid rename'), { code: 'EINVAL' });
    };

    await expect(recoverRuntimeCommit(request(fake), fake.operations)).rejects.toThrow('invalid rename');
    expect(attempts).toBe(1);
  });

  it('recovers from every durable phase and cleans only transaction paths', async () => {
    const fake = await fakeFilesystem();
    fake.entries.add(path.join(fake.root, '.runtime-commit-journal.json'));
    await recoverRuntimeCommit(request(fake), fake.operations);
    expect(fake.journal.phase).toBe('state-committed');
    expect(fake.state).toEqual(state('B'));
    expect(fake.entries.has(path.join(fake.root, 'slot-B'))).toBe(true);
    expect(fake.entries.has(path.join(fake.root, 'slot-A'))).toBe(true);
    expect(fake.entries.has(path.join(fake.root, 'staging-tx'))).toBe(false);
    expect(fake.entries.has(path.join(fake.root, 'backup-tx'))).toBe(false);
    expect(fake.entries.has(path.join(fake.root, '.runtime-commit-journal.json'))).toBe(false);
    expect(fake.removals.some(filename => filename.endsWith(`${path.sep}slot-A`))).toBe(false);

    expect(advanceRuntimeCommitJournal(makeJournal(), 'backup-done').phase).toBe('backup-done');
    const published = advanceRuntimeCommitJournal(makeJournal(), 'backup-done');
    expect(advanceRuntimeCommitJournal(published, 'published').phase).toBe('published');
    const stateCommitted = advanceRuntimeCommitJournal(published, 'published');
    expect(advanceRuntimeCommitJournal(stateCommitted, 'state-committed').phase).toBe('state-committed');
  });

  it('checks every rename/remove target for injected reparse components before mutating', async () => {
    const publishJournal = advanceRuntimeCommitJournal(makeJournal(), 'backup-done');
    const publishFake = await fakeFilesystem(publishJournal);
    const publishPaths = resolveRuntimeCommitPaths(publishFake.root, publishJournal);
    publishFake.entries.delete(publishPaths.destination);
    publishFake.entries.add(publishPaths.backup);
    publishFake.operations.assertNoReparseComponents = async filename => {
      publishFake.reparseChecks.push(filename);
      if (filename === publishPaths.staging) throw new Error('WINDOWS_REPARSE_COMPONENT_REFUSED:symlink');
    };
    await expect(recoverRuntimeCommit(request(publishFake), publishFake.operations)).rejects.toThrow('WINDOWS_REPARSE_COMPONENT_REFUSED');
    expect(publishFake.renames).toEqual([]);
    expect(publishFake.removals).toEqual([]);
    expect(publishFake.reparseChecks).toContain(publishPaths.staging);

    const committedJournal = advanceRuntimeCommitJournal(
      advanceRuntimeCommitJournal(makeJournal(), 'backup-done'),
      'published'
    );
    const cleanupJournal = advanceRuntimeCommitJournal(committedJournal, 'state-committed');
    const cleanupFake = await fakeFilesystem(cleanupJournal);
    const cleanupPaths = resolveRuntimeCommitPaths(cleanupFake.root, cleanupJournal);
    cleanupFake.entries.add(path.join(cleanupFake.root, 'runtime-state.json'));
    cleanupFake.entries.add(cleanupPaths.backup);
    cleanupFake.state = structuredClone(cleanupJournal.afterState);
    cleanupFake.operations.assertNoReparseComponents = async filename => {
      cleanupFake.reparseChecks.push(filename);
      if (filename === cleanupPaths.backup) throw new Error('WINDOWS_REPARSE_COMPONENT_REFUSED:junction');
    };
    await expect(recoverRuntimeCommit(request(cleanupFake, cleanupJournal), cleanupFake.operations))
      .rejects.toThrow('WINDOWS_REPARSE_COMPONENT_REFUSED');
    expect(cleanupFake.removals).toEqual([]);
    expect(cleanupFake.reparseChecks).toContain(cleanupPaths.backup);
  });

  it('continues after a crash at each phase checkpoint', async () => {
    const fake = await fakeFilesystem();
    let failPhase: RuntimeCommitJournal['phase'] | undefined = 'backup-done';
    const originalCheckpoint = fake.operations.checkpoint!;
    fake.operations.checkpoint = async nextJournal => {
      if (nextJournal.phase === failPhase) {
        failPhase = undefined;
        throw new Error(`CRASH_AFTER_${nextJournal.phase}`);
      }
      await originalCheckpoint(nextJournal);
    };

    await expect(recoverRuntimeCommit(request(fake), fake.operations)).rejects.toThrow('CRASH_AFTER_backup-done');
    expect(fake.entries.has(path.join(fake.root, 'slot-B'))).toBe(false);
    expect(fake.entries.has(path.join(fake.root, 'backup-tx'))).toBe(true);
    await recoverRuntimeCommit(request(fake, makeJournal()), fake.operations);

    failPhase = 'published';
    // Recreate a prepared journal/filesystem for the next boundary.
    const second = await fakeFilesystem();
    const secondCheckpoint = second.operations.checkpoint!;
    second.operations.checkpoint = async nextJournal => {
      if (nextJournal.phase === failPhase) {
        failPhase = undefined;
        throw new Error(`CRASH_AFTER_${nextJournal.phase}`);
      }
      await secondCheckpoint(nextJournal);
    };
    await expect(recoverRuntimeCommit(request(second), second.operations)).rejects.toThrow('CRASH_AFTER_published');
    await recoverRuntimeCommit(request(second, second.journal), second.operations);
    expect(second.journal.phase).toBe('state-committed');

    failPhase = 'state-committed';
    const third = await fakeFilesystem();
    const thirdCheckpoint = third.operations.checkpoint!;
    third.operations.checkpoint = async nextJournal => {
      if (nextJournal.phase === failPhase) {
        failPhase = undefined;
        throw new Error(`CRASH_AFTER_${nextJournal.phase}`);
      }
      await thirdCheckpoint(nextJournal);
    };
    await expect(recoverRuntimeCommit(request(third), third.operations)).rejects.toThrow('CRASH_AFTER_state-committed');
    await recoverRuntimeCommit(request(third, third.journal), third.operations);
    expect(third.entries.has(path.join(third.root, 'staging-tx'))).toBe(false);
    expect(third.entries.has(path.join(third.root, 'backup-tx'))).toBe(false);
  });

  it('handles an initially absent destination without inventing or deleting a backup', async () => {
    const journal = makeJournal({ destinationWasPresent: false, beforeState: null });
    const fake = await fakeFilesystem(journal);
    fake.entries.delete(path.join(fake.root, 'slot-B'));
    fake.entries.delete(path.join(fake.root, 'slot-A'));
    fake.state = null;
    await recoverRuntimeCommit(request(fake), fake.operations);
    expect(fake.journal.phase).toBe('state-committed');
    expect(fake.state).toEqual(state('B'));
    expect(fake.entries.has(path.join(fake.root, 'backup-tx'))).toBe(false);
  });

  it('fails closed for both-present and both-missing sides without removing either A/B slot', async () => {
    const bothPresent = await fakeFilesystem();
    bothPresent.entries.add(path.join(bothPresent.root, 'backup-tx'));
    await expect(recoverRuntimeCommit(request(bothPresent), bothPresent.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
    expect(bothPresent.removals).toEqual([]);
    expect(bothPresent.entries.has(path.join(bothPresent.root, 'slot-A'))).toBe(true);

    const bothMissing = await fakeFilesystem();
    bothMissing.entries.delete(path.join(bothMissing.root, 'slot-B'));
    bothMissing.entries.delete(path.join(bothMissing.root, 'staging-tx', 'slot-B'));
    await expect(recoverRuntimeCommit(request(bothMissing), bothMissing.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
    expect(bothMissing.removals).toEqual([]);
    expect(bothMissing.entries.has(path.join(bothMissing.root, 'slot-A'))).toBe(true);
  });

  it('fails closed when publish has both or neither side', async () => {
    const bothPresent = await fakeFilesystem(advanceRuntimeCommitJournal(makeJournal(), 'backup-done'));
    bothPresent.entries.add(path.join(bothPresent.root, 'backup-tx'));
    await expect(recoverRuntimeCommit(request(bothPresent), bothPresent.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
    expect(bothPresent.removals).toEqual([]);

    const neither = await fakeFilesystem(advanceRuntimeCommitJournal(makeJournal(), 'backup-done'));
    neither.entries.delete(path.join(neither.root, 'staging-tx', 'slot-B'));
    neither.entries.delete(path.join(neither.root, 'slot-B'));
    neither.entries.add(path.join(neither.root, 'backup-tx'));
    await expect(recoverRuntimeCommit(request(neither), neither.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
    expect(neither.removals).toEqual([]);
  });

  it('does not overwrite an unrelated state or remove a slot on state ambiguity', async () => {
    const fake = await fakeFilesystem(advanceRuntimeCommitJournal(
      advanceRuntimeCommitJournal(makeJournal(), 'backup-done'),
      'published'
    ));
    fake.entries.delete(path.join(fake.root, 'staging-tx', 'slot-B'));
    fake.entries.add(path.join(fake.root, 'backup-tx'));
    fake.state = state('unrelated');
    await expect(recoverRuntimeCommit(request(fake), fake.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
    expect(fake.state).toEqual(state('unrelated'));
    expect(fake.removals).toEqual([]);
    expect(fake.entries.has(path.join(fake.root, 'slot-A'))).toBe(true);
  });

  it('fails closed before committed cleanup for old, malformed, or missing state', async () => {
    const committedJournal = advanceRuntimeCommitJournal(
      advanceRuntimeCommitJournal(makeJournal(), 'backup-done'),
      'published'
    );
    const journal = advanceRuntimeCommitJournal(committedJournal, 'state-committed');

    for (const kind of ['old', 'missing', 'malformed'] as const) {
      const fake = await fakeFilesystem(journal);
      const paths = resolveRuntimeCommitPaths(fake.root, journal);
      fake.entries.add(path.join(fake.root, 'runtime-state.json'));
      fake.entries.add(paths.backup);
      if (kind === 'old') fake.state = structuredClone(journal.beforeState);
      if (kind === 'missing') fake.state = null;
      if (kind === 'malformed') {
        fake.operations.readState = async () => { throw new Error('RUNTIME_COMMIT_STATE_INVALID'); };
      }

      await expect(recoverRuntimeCommit(request(fake, journal), fake.operations)).rejects.toThrow('RUNTIME_COMMIT_AMBIGUOUS');
      expect(fake.removals).toEqual([]);
      expect(fake.entries.has(paths.backup)).toBe(true);
      expect(fake.entries.has(paths.stagingRoot)).toBe(true);
    }
  });

  it('retries cleanup after an interruption without touching either slot', async () => {
    const fake = await fakeFilesystem();
    const originalRemove = fake.operations.remove;
    let failCleanup = true;
    fake.operations.remove = async filename => {
      if (failCleanup && filename === path.join(fake.root, 'staging-tx')) throw new Error('CRASH_DURING_CLEANUP');
      await originalRemove(filename);
    };
    await expect(recoverRuntimeCommit(request(fake), fake.operations)).rejects.toThrow('CRASH_DURING_CLEANUP');
    expect(fake.journal.phase).toBe('state-committed');
    expect(fake.entries.has(path.join(fake.root, 'backup-tx'))).toBe(false);
    failCleanup = false;
    await recoverRuntimeCommit(request(fake, fake.journal), fake.operations);
    expect(fake.entries.has(path.join(fake.root, 'staging-tx'))).toBe(false);
    expect(fake.entries.has(path.join(fake.root, 'slot-A'))).toBe(true);
    expect(fake.removals.some(filename => filename.endsWith(`${path.sep}slot-A`))).toBe(false);
  });

  it('writes journals atomically through the existing helper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-commit-journal-write-'));
    roots.push(root);
    const filename = path.join(root, 'journal.json');
    const journal = makeJournal();
    await writeRuntimeCommitJournal(filename, journal);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(journal);
  });
});
