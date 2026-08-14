import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/settings-store.js';

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
describe('SettingsStore', () => {
  it('writes atomically and restores backup after corruption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-')); roots.push(root); const file = path.join(root, 'settings.json');
    const first = new SettingsStore(file); await first.load(); await first.update({ preferredPort: 34567 }); await first.update({ preferredPort: 34568 });
    await writeFile(file, '{broken', 'utf8'); const recovered = new SettingsStore(file); expect((await recovered.load()).preferredPort).toBe(34567); expect(JSON.parse(await readFile(file, 'utf8')).preferredPort).toBe(34567);
  });
});
