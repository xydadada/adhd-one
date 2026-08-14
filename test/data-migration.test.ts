import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortableDataWritable, copyLegacyDsh, DataMigrationError, detectLegacyDsh } from '../src/data-migration.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-migration-'));
  roots.push(root);
  return root;
}

async function stagingNames(root: string): Promise<string[]> {
  return (await readdir(root)).filter(name => name.startsWith('.adhd-one-dsh-staging-'));
}

describe('legacy DSH data migration', () => {
  it('detects an existing legacy .dsh path without reading its contents', async () => {
    const root = await makeRoot();
    const legacy = path.join(root, '.dsh');
    await mkdir(legacy);

    await expect(detectLegacyDsh(legacy)).resolves.toBe(true);
    await expect(detectLegacyDsh(path.join(root, 'missing'))).resolves.toBe(false);
  });

  it('copies data through same-volume staging and leaves the source unchanged', async () => {
    const root = await makeRoot();
    const source = path.join(root, '.dsh');
    const destination = path.join(root, 'portable-data', 'dsh-home');
    await mkdir(path.join(source, 'sessions'), { recursive: true });
    await writeFile(path.join(source, 'config.json'), '{"token":"redacted-in-fixture"}\n', 'utf8');
    await writeFile(path.join(source, 'sessions', 'one.json'), '{"id":1}\n', 'utf8');

    await expect(copyLegacyDsh(source, destination)).resolves.toMatchObject({ files: 2, directories: 1 });
    await expect(readFile(path.join(destination, 'config.json'), 'utf8')).resolves.toContain('redacted-in-fixture');
    await expect(readFile(path.join(source, 'config.json'), 'utf8')).resolves.toContain('redacted-in-fixture');
    await expect(stagingNames(path.join(root, 'portable-data'))).resolves.toEqual([]);
  });

  it('rejects an existing destination and preserves both destination and source', async () => {
    const root = await makeRoot();
    const source = path.join(root, '.dsh');
    const destination = path.join(root, 'dsh-home');
    await mkdir(source);
    await writeFile(path.join(source, 'source.json'), 'source\n', 'utf8');
    await mkdir(destination);
    await writeFile(path.join(destination, 'keep.json'), 'keep\n', 'utf8');

    await expect(copyLegacyDsh(source, destination)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(readFile(path.join(destination, 'keep.json'), 'utf8')).resolves.toBe('keep\n');
    await expect(readFile(path.join(source, 'source.json'), 'utf8')).resolves.toBe('source\n');
    await expect(stagingNames(root)).resolves.toEqual([]);
  });

  it('rejects a destination inside the source before creating any parent', async () => {
    const root = await makeRoot();
    const source = path.join(root, '.dsh');
    const destination = path.join(source, 'new-parent', 'dsh-home');
    await mkdir(source);
    await writeFile(path.join(source, 'source.json'), 'source\n', 'utf8');

    await expect(copyLegacyDsh(source, destination)).rejects.toMatchObject({ code: 'MIGRATION_DESTINATION_INSIDE_SOURCE' });
    await expect(readdir(path.join(source, 'new-parent'))).rejects.toBeDefined();
    await expect(readFile(path.join(source, 'source.json'), 'utf8')).resolves.toBe('source\n');
  });

  it('cleans staging and keeps the source when an unsupported entry fails migration', async () => {
    const root = await makeRoot();
    const source = path.join(root, '.dsh');
    const destination = path.join(root, 'dsh-home');
    const outside = path.join(root, 'outside');
    await mkdir(source);
    await mkdir(outside);
    await writeFile(path.join(source, '00-source.json'), 'source\n', 'utf8');

    try {
      await symlink(outside, path.join(source, '99-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Junction creation is blocked on some Windows CI identities. The normal
      // destination-exists test still covers the non-destructive failure path.
      return;
    }

    await expect(copyLegacyDsh(source, destination)).rejects.toMatchObject({ code: 'LEGACY_DSH_UNSUPPORTED_ENTRY' });
    await expect(readFile(path.join(source, '00-source.json'), 'utf8')).resolves.toBe('source\n');
    await expect(stagingNames(root)).resolves.toEqual([]);
    await expect(readdir(destination)).rejects.toBeDefined();
  });

  it('requires an existing writable portable directory and removes its probe', async () => {
    const root = await makeRoot();

    await expect(assertPortableDataWritable(root)).resolves.toBeUndefined();
    await expect(readdir(root)).resolves.toEqual([]);
    await expect(assertPortableDataWritable(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'PORTABLE_DATA_NOT_WRITABLE' });
  });

  it('exposes stable path-free migration errors', async () => {
    const error = new DataMigrationError('DESTINATION_EXISTS');
    expect(error.message).toBe('DESTINATION_EXISTS');
    expect(error.message).not.toContain('token');
  });
});
