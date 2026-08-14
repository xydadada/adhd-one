import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeController } from '../src/runtime-controller.js';
import type { RuntimeSnapshotV2 } from '../src/types.js';
import type { ManagedProcess } from '../src/windows-platform.js';

type ControllerInternals = {
  crashTimes: number[];
  process: ManagedProcess | undefined;
  candidateSlot: 'A' | 'B' | undefined;
  candidateGeneration: number | undefined;
  setSnapshot(patch: Partial<Omit<RuntimeSnapshotV2, 'health'>>): void;
  handleUnexpectedExit(child: ManagedProcess, generation: number, code: number): void;
  armStableTimer(generation: number): void;
  rollbackCandidate: ReturnType<typeof vi.fn>;
  startAttempt: ReturnType<typeof vi.fn>;
};

class FakeProcess implements ManagedProcess {
  constructor(public readonly pid: number) {}
  wait(): Promise<number> { return new Promise(() => undefined); }
  write(_value: string): void {}
  readAvailable(): Buffer { return Buffer.alloc(0); }
  terminate(_exitCode?: number): void {}
  close(): void {}
}

function createController(workspace?: string): RuntimeController {
  const settings = {
    get: () => ({ workspace, preferredPort: 43123 }),
    update: vi.fn(async () => undefined)
  };
  return new RuntimeController(settings as never, {
    appPath: 'C:\\app',
    resourcesPath: 'C:\\resources',
    packaged: false,
    dshHome: 'C:\\data\\dsh',
    logs: 'C:\\data\\logs',
    runtimes: 'C:\\data\\runtimes'
  });
}

function internals(controller: RuntimeController): ControllerInternals {
  return controller as unknown as ControllerInternals;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('RuntimeSnapshotV2', () => {
  it('starts with the V2-only shape and maps every runtime state to frozen health semantics', () => {
    const controller = createController();
    const privateController = internals(controller);

    expect(controller.snapshot()).toMatchObject({
      state: 'idle',
      generation: 0,
      slot: 'bundled',
      health: 'unknown',
      restartAttempt: 0
    });
    expect(controller.snapshot()).not.toHaveProperty('runtimeSlot');

    for (const state of ['preparing', 'starting', 'stopping', 'updating'] as const) {
      privateController.setSnapshot({ state });
      expect(controller.snapshot().health).toBe('unknown');
    }
    privateController.setSnapshot({ state: 'ready' });
    expect(controller.snapshot().health).toBe('healthy');
    privateController.setSnapshot({ state: 'failed' });
    expect(controller.snapshot().health).toBe('unhealthy');
    privateController.setSnapshot({ state: 'idle' });
    expect(controller.snapshot().health).toBe('unknown');
  });

  it('counts only scheduled automatic restarts inside the ten-minute crash window', () => {
    vi.useFakeTimers({ now: 0 });
    const controller = createController('C:\\workspace');
    const privateController = internals(controller);

    const crash = (pid: number): void => {
      const child = new FakeProcess(pid);
      privateController.process = child;
      privateController.setSnapshot({ state: 'ready', generation: 1, pid, url: 'http://127.0.0.1:43123' });
      privateController.handleUnexpectedExit(child, 1, 1);
    };

    crash(101);
    expect(controller.snapshot()).toMatchObject({ state: 'failed', health: 'unhealthy', restartAttempt: 1 });
    crash(102);
    expect(controller.snapshot().restartAttempt).toBe(2);
    crash(103);
    expect(controller.snapshot().restartAttempt).toBe(3);

    vi.clearAllTimers();
    privateController.setSnapshot({ state: 'ready', generation: 2 });
    privateController.armStableTimer(2);
    vi.advanceTimersByTime(599_999);
    expect(controller.snapshot().restartAttempt).toBe(3);
    vi.advanceTimersByTime(1);
    expect(controller.snapshot()).toMatchObject({ state: 'ready', health: 'healthy', restartAttempt: 0 });
    expect(privateController.crashTimes).toEqual([]);
  });

  it('expires restartAttempt after ten minutes even while updating instead of ready', () => {
    vi.useFakeTimers({ now: 0 });
    const controller = createController('C:\\workspace');
    const privateController = internals(controller);
    const child = new FakeProcess(201);
    privateController.process = child;
    privateController.setSnapshot({ state: 'ready', generation: 1, pid: child.pid, url: 'http://127.0.0.1:43123' });
    privateController.handleUnexpectedExit(child, 1, 1);
    expect(controller.snapshot().restartAttempt).toBe(1);

    controller.setUpdating(true);
    vi.advanceTimersByTime(600_000);

    expect(controller.snapshot()).toMatchObject({ state: 'updating', restartAttempt: 0 });
  });

  it('rolls a candidate back after its third crash instead of restarting the bad slot again', async () => {
    vi.useFakeTimers({ now: 100 });
    const controller = createController('C:\\workspace');
    const privateController = internals(controller);
    privateController.crashTimes = [1, 2];
    privateController.candidateSlot = 'A';
    privateController.candidateGeneration = 7;
    privateController.rollbackCandidate = vi.fn(async () => true);
    privateController.startAttempt = vi.fn(async () => controller.snapshot());
    const child = new FakeProcess(301);
    privateController.process = child;
    privateController.setSnapshot({ state: 'ready', generation: 7, slot: 'A', pid: child.pid, url: 'http://127.0.0.1:43123' });

    privateController.handleUnexpectedExit(child, 7, 1);
    await vi.waitFor(() => expect(privateController.rollbackCandidate).toHaveBeenCalledWith('A', true));

    expect(privateController.startAttempt).toHaveBeenCalledWith(false, expect.any(Number));
    expect(controller.snapshot().restartAttempt).toBe(3);
  });

  it('does not increment restartAttempt for manual start, stop, or restart', async () => {
    const controller = createController();

    expect((await controller.start()).restartAttempt).toBe(0);
    expect((await controller.stop()).restartAttempt).toBe(0);
    expect((await controller.restart()).restartAttempt).toBe(0);
    expect(controller.snapshot().health).toBe('unhealthy');
  });

  it('clears a stale failure error when stopping without a live process', async () => {
    const controller = createController();
    const privateController = internals(controller);
    privateController.setSnapshot({ state: 'failed', error: { code: 'OLD_FAILURE', message: 'old' } });

    await controller.stop();

    expect(controller.snapshot()).toMatchObject({ state: 'idle', health: 'unknown' });
    expect(controller.snapshot()).not.toHaveProperty('error');
  });
});
