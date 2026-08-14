import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HARD_EXIT_DELAY_MS,
  QuitCoordinator,
  RUNTIME_STOP_TIMEOUT_MS,
  type QuitCoordinatorDependencies
} from '../src/quit-coordinator.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createFixture(overrides: Partial<QuitCoordinatorDependencies> = {}) {
  const calls: string[] = [];
  const runtime = {
    stop: vi.fn(async () => undefined),
    forceShutdown: vi.fn(() => { calls.push('forceShutdown'); })
  };
  const windows = {
    prepareToQuit: vi.fn(() => { calls.push('prepareToQuit'); }),
    destroyForQuit: vi.fn(() => { calls.push('destroyForQuit'); })
  };
  const appExit = vi.fn((exitCode: number) => { calls.push(`appExit:${exitCode}`); });
  const hardExit = vi.fn((exitCode: number) => { calls.push(`hardExit:${exitCode}`); });
  const dependencies: QuitCoordinatorDependencies = {
    runtime,
    windows,
    appExit,
    hardExit,
    ...overrides
  };
  return {
    calls,
    runtime: dependencies.runtime,
    windows: dependencies.windows,
    appExit: dependencies.appExit,
    hardExit: dependencies.hardExit,
    coordinator: new QuitCoordinator(dependencies)
  };
}

describe('QuitCoordinator', () => {
  it('waits for a successful runtime stop, destroys windows, and exits once', async () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    await fixture.coordinator.quit();

    expect(fixture.calls).toEqual(['prepareToQuit', 'destroyForQuit', 'appExit:0']);
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
    expect(fixture.runtime.forceShutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HARD_EXIT_DELAY_MS - 1);
    expect(fixture.hardExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.hardExit).toHaveBeenCalledWith(0);
  });

  it('forces shutdown after the bounded five-second stop deadline', async () => {
    vi.useFakeTimers();
    const fixture = createFixture({ runtime: {
      stop: vi.fn(() => new Promise<void>(() => undefined)),
      forceShutdown: vi.fn(() => { fixture.calls.push('forceShutdown'); })
    } });

    const quit = fixture.coordinator.quit();
    await vi.advanceTimersByTimeAsync(RUNTIME_STOP_TIMEOUT_MS - 1);
    expect(fixture.runtime.forceShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quit;

    expect(fixture.runtime.forceShutdown).toHaveBeenCalledOnce();
    expect(fixture.calls).toEqual(['prepareToQuit', 'forceShutdown', 'destroyForQuit', 'appExit:1']);
  });

  it('treats a rejected runtime stop as a failure and preserves an explicit exit code', async () => {
    const fixture = createFixture({ runtime: {
      stop: vi.fn(async () => { throw new Error('stop failed'); }),
      forceShutdown: vi.fn(() => { fixture.calls.push('forceShutdown'); })
    } });

    await fixture.coordinator.requestQuit(23);

    expect(fixture.runtime.forceShutdown).toHaveBeenCalledOnce();
    expect(fixture.appExit).toHaveBeenCalledWith(23);
  });

  it('returns the same request, cancels the hard-exit fallback, and never exits twice', async () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    const first = fixture.coordinator.requestQuit(7);
    const second = fixture.coordinator.requestQuit(9);
    expect(second).toBe(first);
    await first;

    fixture.coordinator.cancelFallback();
    await vi.advanceTimersByTimeAsync(HARD_EXIT_DELAY_MS + 1);

    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
    expect(fixture.appExit).toHaveBeenCalledOnce();
    expect(fixture.appExit).toHaveBeenCalledWith(7);
    expect(fixture.hardExit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips the fallback when Electron reports that it already exited', async () => {
    vi.useFakeTimers();
    let electronExited = false;
    const fixture = createFixture({ isElectronExited: () => electronExited });

    await fixture.coordinator.quit();
    electronExited = true;
    await vi.advanceTimersByTimeAsync(HARD_EXIT_DELAY_MS + 1);

    expect(fixture.hardExit).not.toHaveBeenCalled();
  });

  it('does not let the hard-exit fallback keep Electron alive', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const schedule = vi.fn(() => timer);
    const fixture = createFixture({ setTimeout: schedule });

    await fixture.coordinator.quit();

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('keeps the fallback armed because Electron quit does not prove process exit', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('quitCoordinator.markElectronExited()');
    expect(source).toContain('keep the bounded hard-exit fallback armed');
  });
});
