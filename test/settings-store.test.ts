import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/settings-store.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50
}))));

async function jsonFile(filename: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
}

function transientEntries(entries: string[]): string[] {
  return entries.filter(name => name.endsWith('.tmp') || name.endsWith('.lock') || name.endsWith('.claim'));
}

describe('SettingsStore', () => {
  it('writes atomically and restores backup after corruption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const first = new SettingsStore(file);
    await first.load();
    await first.update({ preferredPort: 34567 });
    await first.update({ preferredPort: 34568 });
    await writeFile(file, '{broken', 'utf8');

    const recovered = new SettingsStore(file);
    expect((await recovered.load()).preferredPort).toBe(34567);
    expect((await jsonFile(file)).preferredPort).toBe(34567);
    expect((await jsonFile(`${file}.bak`)).preferredPort).toBe(34567);
    const entries = await readdir(root);
    const quarantined = entries.filter(name => name.startsWith('settings.json.quarantine-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(root, quarantined[0]!), 'utf8')).toBe('{broken');
    expect(transientEntries(entries)).toEqual([]);
  });

  it('double-reads V2 and V3 settings and writes a migrated V3 main file once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const v2 = {
      schemaVersion: 2,
      locale: 'en-US',
      workspace: root,
      preferredPort: 45678,
      appChannel: 'preview',
      runtimeChannel: 'stable',
      closeToTrayExplained: true,
      migration: { v1Imported: true, legacyDshPrompted: true }
    } as const;
    await writeFile(file, `${JSON.stringify(v2)}\n`, 'utf8');

    const store = new SettingsStore(file);
    await expect(store.load()).resolves.toMatchObject({
      schemaVersion: 3,
      locale: 'en-US',
      workspace: root,
      preferredPort: 45678,
      appChannel: 'preview',
      runtimeChannel: 'stable',
      closeToTrayExplained: true,
      migration: v2.migration
    });
    await expect(store.get().portableDataPath).toBeUndefined();
    const migratedFile = await jsonFile(file);
    expect(migratedFile.schemaVersion).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(migratedFile, 'portableDataPath')).toBe(false);
    await expect(jsonFile(`${file}.bak`)).resolves.toMatchObject({ schemaVersion: 2, preferredPort: 45678 });
    await expect(readdir(root)).resolves.not.toContain('settings.json.tmp');
  });

  it('recovers a V2 backup into V3 without replacing the valid backup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-recovery-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const backup = `${file}.bak`;
    await writeFile(file, '{broken', 'utf8');
    await writeFile(backup, JSON.stringify({
      schemaVersion: 2,
      locale: 'zh-CN',
      preferredPort: 23456,
      appChannel: 'stable',
      runtimeChannel: 'preview',
      closeToTrayExplained: false,
      migration: { v1Imported: false, legacyDshPrompted: false }
    }), 'utf8');

    const store = new SettingsStore(file);
    await expect(store.load()).resolves.toMatchObject({ schemaVersion: 3, preferredPort: 23456, runtimeChannel: 'preview' });
    await expect(jsonFile(file)).resolves.toMatchObject({ schemaVersion: 3, preferredPort: 23456 });
    await expect(jsonFile(backup)).resolves.toMatchObject({ schemaVersion: 2, preferredPort: 23456 });
  });

  it('round-trips the optional portable data path in V3', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-portable-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const portableDataPath = path.join(root, 'portable-data');
    const store = new SettingsStore(file);
    await store.load();
    await store.update({ portableDataPath });

    const reloaded = new SettingsStore(file);
    await expect(reloaded.load()).resolves.toMatchObject({ schemaVersion: 3, portableDataPath });
  });

  it('serializes concurrent updates without losing fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-concurrent-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const store = new SettingsStore(file);
    await store.load();

    await Promise.all([
      store.update({ preferredPort: 31234 }),
      store.update({ locale: 'en-US' })
    ]);

    expect(store.get()).toMatchObject({ preferredPort: 31234, locale: 'en-US' });
    const reloaded = new SettingsStore(file);
    await expect(reloaded.load()).resolves.toMatchObject({ preferredPort: 31234, locale: 'en-US' });
  });

  it('merges concurrent updates from independent SettingsStore instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-cross-instance-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const first = new SettingsStore(file);
    await first.load();
    const second = new SettingsStore(file);
    await second.load();

    await Promise.all([
      first.update({ preferredPort: 32123 }),
      second.update({ locale: 'en-US' })
    ]);

    const reloaded = new SettingsStore(file);
    await expect(reloaded.load()).resolves.toMatchObject({ preferredPort: 32123, locale: 'en-US' });
  });

  it('serializes setWorkspace with another update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-workspace-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const store = new SettingsStore(file);
    await store.load();

    await Promise.all([store.setWorkspace(workspace), store.update({ locale: 'en-US' })]);

    expect(store.get()).toMatchObject({ workspace, locale: 'en-US' });
  });

  it('reports both corrupt settings files without writing defaults or exposing a path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-corrupt-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const backup = `${file}.bak`;
    await writeFile(file, '{current broken', 'utf8');
    await writeFile(backup, JSON.stringify({ schemaVersion: 99, locale: 'en-US' }), 'utf8');

    const store = new SettingsStore(file);
    const failure = await store.load().catch(error => error as { code?: string; message?: string });
    expect(failure).toMatchObject({ code: 'SETTINGS_CORRUPT', message: 'SETTINGS_CORRUPT' });
    expect(failure.message).not.toContain(file);
    expect(await readFile(file, 'utf8')).toBe('{current broken');
    expect(await readFile(backup, 'utf8')).toBe(JSON.stringify({ schemaVersion: 99, locale: 'en-US' }));
    expect(transientEntries(await readdir(root))).toEqual([]);
  });

  it('reports permission failures as typed IO without creating defaults', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-eacces-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    await chmod(root, 0o000);
    try {
      const store = new SettingsStore(file);
      const failure = await store.load().catch(error => error as { code?: string; message?: string });
      expect(failure).toMatchObject({ code: 'SETTINGS_IO', message: 'SETTINGS_IO' });
      expect(failure.message).not.toContain(file);
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('does not advance the in-memory value when a write fails, and cleans its lock/temp files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-write-failure-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const store = new SettingsStore(file);
    await store.load();
    const before = store.get();
    await mkdir(`${file}.bak`);

    const failure = await store.update({ preferredPort: before.preferredPort + 1 }).catch(error => error as { code?: string });
    expect(failure).toMatchObject({ code: 'SETTINGS_IO' });
    expect(store.get()).toEqual(before);
    expect(transientEntries(await readdir(root))).toEqual([]);
  });

  it('does not remove an active lock, even when its timestamp is old', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-active-lock-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: 0, token: 'active' }), 'utf8');

    const store = new SettingsStore(file);
    await expect(store.load()).rejects.toMatchObject({ code: 'SETTINGS_LOCKED' });
    await expect(readFile(lock, 'utf8')).resolves.toContain('active');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a fresh malformed lock active but reclaims an old malformed lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-malformed-lock-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const lock = `${file}.lock`;
    await writeFile(lock, '{truncated', 'utf8');

    await expect(new SettingsStore(file).load()).rejects.toMatchObject({ code: 'SETTINGS_LOCKED' });
    await utimes(lock, new Date(0), new Date(0));
    await expect(new SettingsStore(file).load()).resolves.toMatchObject({ schemaVersion: 3 });
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up a demonstrably stale lock before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-stale-lock-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({ pid: 2147483647, createdAt: 0, token: 'stale' }), 'utf8');

    const store = new SettingsStore(file);
    await expect(store.load()).resolves.toMatchObject({ schemaVersion: 3 });
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes competing stale-lock reclaimers without deleting the new lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-settings-lock-race-'));
    roots.push(root);
    const file = path.join(root, 'settings.json');
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({ pid: 2147483647, createdAt: 0, token: 'stale-race' }), 'utf8');

    const first = new SettingsStore(file);
    const second = new SettingsStore(file);
    await Promise.all([first.load(), second.load()]);

    await expect(new SettingsStore(file).load()).resolves.toMatchObject({ schemaVersion: 3 });
    expect(transientEntries(await readdir(root))).toEqual([]);
  });
});
