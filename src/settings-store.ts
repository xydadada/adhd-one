/** Atomic settings replacement adapted from DeepSeek Harness (MIT), commit 47f943859b. */
import { randomBytes, randomInt } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppSettings } from './types.js';

const schema = z.object({
  schemaVersion: z.literal(2),
  locale: z.enum(['zh-CN', 'en-US']),
  workspace: z.string().optional(),
  preferredPort: z.number().int().min(1024).max(65535),
  appChannel: z.enum(['stable', 'preview']),
  runtimeChannel: z.enum(['stable', 'preview']),
  closeToTrayExplained: z.boolean(),
  migration: z.object({ v1Imported: z.boolean(), legacyDshPrompted: z.boolean() })
});

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: 2,
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
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, filename);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readValid(filename: string): Promise<AppSettings | undefined> {
  try { return schema.parse(JSON.parse(await readFile(filename, 'utf8'))); } catch { return undefined; }
}

export class SettingsStore {
  private value: AppSettings = defaultSettings();
  constructor(private readonly filename: string, private readonly legacyFilename?: string) {}

  async load(): Promise<AppSettings> {
    const backup = `${this.filename}.bak`;
    const current = await readValid(this.filename);
    if (current) return (this.value = current);
    const recovered = await readValid(backup);
    if (recovered) {
      this.value = recovered;
      await this.save(recovered);
      return recovered;
    }
    const migrated = await this.readLegacy();
    this.value = migrated ?? defaultSettings();
    await this.save(this.value);
    return this.value;
  }

  get(): AppSettings { return structuredClone(this.value); }

  async save(next: AppSettings): Promise<void> {
    const valid = schema.parse(next);
    const existing = await readValid(this.filename);
    if (existing) await copyFile(this.filename, `${this.filename}.bak`);
    await writeFileAtomic(this.filename, `${JSON.stringify(valid, null, 2)}\n`);
    this.value = valid;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = schema.parse({ ...this.value, ...patch });
    await this.save(next);
    return this.get();
  }

  async setWorkspace(candidate: string): Promise<string> {
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
    await this.update({ workspace: canonical });
    return canonical;
  }

  private async readLegacy(): Promise<AppSettings | undefined> {
    if (!this.legacyFilename) return undefined;
    try {
      const raw = JSON.parse(await readFile(this.legacyFilename, 'utf8')) as { workspace?: unknown };
      if (typeof raw.workspace !== 'string') return undefined;
      const workspace = await realpath(raw.workspace);
      if (!(await stat(workspace)).isDirectory()) return undefined;
      return { ...defaultSettings(), workspace, migration: { v1Imported: true, legacyDshPrompted: false } };
    } catch { return undefined; }
  }
}
