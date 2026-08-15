import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeController } from '../src/runtime-controller.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('RuntimeController closure startup gate', () => {
  it('fails closed before spawning when the selected runtime is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-startup-'));
    roots.push(root);
    const settings = {
      get: () => ({ workspace: root, preferredPort: 43123 }),
      update: async () => undefined
    };
    const controller = new RuntimeController(settings as never, {
      appPath: root,
      resourcesPath: root,
      packaged: false,
      dshHome: path.join(root, 'dsh-home'),
      logs: path.join(root, 'logs'),
      runtimes: path.join(root, 'runtimes')
    });

    const snapshot = await controller.start();

    expect(snapshot).toMatchObject({
      state: 'failed',
      error: {
        code: 'RUNTIME_CLOSURE_ROOT_INVALID',
        message: 'Runtime package verification failed.'
      }
    });
    expect(snapshot.pid).toBeUndefined();
  });

  it('fails closed before runtime selection when a pending commit journal is invalid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-recovery-'));
    roots.push(root);
    const runtimes = path.join(root, 'runtimes');
    await mkdir(runtimes, { recursive: true });
    await writeFile(path.join(runtimes, '.runtime-commit-journal.json'), '{"schemaVersion":999}\n', 'utf8');
    const settings = {
      get: () => ({ workspace: root, preferredPort: 43123 }),
      update: async () => undefined
    };
    const controller = new RuntimeController(settings as never, {
      appPath: root,
      resourcesPath: root,
      packaged: false,
      dshHome: path.join(root, 'dsh-home'),
      logs: path.join(root, 'logs'),
      runtimes
    });

    const snapshot = await controller.start();

    expect(snapshot).toMatchObject({
      state: 'failed',
      error: {
        code: 'RUNTIME_COMMIT_RECOVERY_FAILED',
        message: 'Runtime update recovery failed.'
      }
    });
    expect(snapshot.pid).toBeUndefined();
  });

  it('rolls back a candidate that fails package verification before trying bundled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-candidate-'));
    roots.push(root);
    const settings = {
      get: () => ({ workspace: root, preferredPort: 43123 }),
      update: async () => undefined
    };
    const controller = new RuntimeController(settings as never, {
      appPath: root,
      resourcesPath: root,
      packaged: false,
      dshHome: path.join(root, 'dsh-home'),
      logs: path.join(root, 'logs'),
      runtimes: path.join(root, 'runtimes')
    });
    const internal = controller as unknown as {
      selectRuntime: ReturnType<typeof vi.fn>;
      rollbackCandidate: ReturnType<typeof vi.fn>;
    };
    internal.selectRuntime = vi.fn()
      .mockResolvedValueOnce({ root: path.join(root, 'missing-A'), node: 'node.exe', slot: 'A', version: 'test', candidate: true })
      .mockResolvedValueOnce({ root: path.join(root, 'missing-bundled'), node: 'node.exe', slot: 'bundled', version: 'test', candidate: false });
    internal.rollbackCandidate = vi.fn(async () => true);

    const snapshot = await controller.start();

    expect(internal.rollbackCandidate).toHaveBeenCalledWith('A', true);
    expect(internal.selectRuntime).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({ state: 'failed', slot: 'bundled', error: { code: 'RUNTIME_CLOSURE_ROOT_INVALID' } });
  });

  it('persists rollback when the active candidate slot is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-missing-slot-'));
    roots.push(root);
    const runtimes = path.join(root, 'runtimes');
    await mkdir(runtimes, { recursive: true });
    await writeFile(path.join(runtimes, 'runtime-state.json'), JSON.stringify({
      schemaVersion: 1, active: 'A', previous: 'bundled', version: '9.9.9', healthy: false, candidate: true
    }));
    const controller = new RuntimeController({
      get: () => ({ workspace: root, preferredPort: 43123 }), update: async () => undefined
    } as never, {
      appPath: root, resourcesPath: root, packaged: false,
      dshHome: path.join(root, 'dsh-home'), logs: path.join(root, 'logs'), runtimes
    });

    const selection = await (controller as unknown as { selectRuntime(): Promise<{ slot: string }> }).selectRuntime();
    const state = JSON.parse(await readFile(path.join(runtimes, 'runtime-state.json'), 'utf8')) as Record<string, unknown>;

    expect(selection.slot).toBe('bundled');
    expect(state).toMatchObject({ active: 'bundled', previous: 'A', healthy: true, candidate: false, rolledBackFrom: 'A' });
  });

  it.each(['A', 'B'] as const)('selects a valid matching candidate in slot %s without rollback', async slot => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-runtime-valid-slot-'));
    roots.push(root);
    const runtimes = path.join(root, 'runtimes');
    const slotRoot = path.join(runtimes, `slot-${slot}`);
    const packageDirectory = path.join(slotRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '1.2.3'
    }));
    await writeFile(path.join(runtimes, 'runtime-state.json'), JSON.stringify({
      schemaVersion: 1, active: slot, previous: 'bundled', version: '1.2.3', healthy: false, candidate: true
    }));
    const controller = new RuntimeController({
      get: () => ({ workspace: root, preferredPort: 43123 }), update: async () => undefined
    } as never, {
      appPath: root, resourcesPath: root, packaged: false,
      dshHome: path.join(root, 'dsh-home'), logs: path.join(root, 'logs'), runtimes
    });
    const internal = controller as unknown as {
      selectRuntime(): Promise<{ root: string; node: string; slot: string; version: string; candidate: boolean }>;
      rollbackCandidate: ReturnType<typeof vi.fn>;
    };
    internal.rollbackCandidate = vi.fn(async () => true);

    await expect(internal.selectRuntime()).resolves.toEqual({
      root: path.join(slotRoot, 'dsh-runtime'),
      node: path.join(slotRoot, 'node-runtime', 'node.exe'),
      slot,
      version: '1.2.3',
      candidate: true
    });
    expect(internal.rollbackCandidate).not.toHaveBeenCalled();
  });
});
