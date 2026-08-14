/** Coordinates the bounded shutdown path without depending on Electron globals. */

export const RUNTIME_STOP_TIMEOUT_MS = 5_000;
export const HARD_EXIT_DELAY_MS = 250;

const MAX_HARD_EXIT_DELAY_MS = 5_000;

type QuitTimer = ReturnType<typeof setTimeout>;

export interface QuitRuntime {
  stop(): PromiseLike<unknown> | unknown;
  forceShutdown(): void;
}

export interface QuitWindows {
  prepareToQuit?(): void;
  destroyForQuit(): void;
}

export interface QuitCoordinatorDependencies {
  runtime: QuitRuntime;
  windows: QuitWindows;
  appExit: (exitCode: number) => void;
  hardExit: (exitCode: number) => void;
  isElectronExited?: () => boolean;
  setTimeout?: (callback: () => void, delay: number) => QuitTimer;
  clearTimeout?: (timer: QuitTimer) => void;
  stopTimeoutMs?: number;
  hardExitDelayMs?: number;
}

function boundedDelay(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

export class QuitCoordinator {
  private readonly schedule: (callback: () => void, delay: number) => QuitTimer;
  private readonly cancelTimer: (timer: QuitTimer) => void;
  private readonly stopTimeoutMs: number;
  private readonly hardExitDelayMs: number;
  private quitPromise: Promise<void> | undefined;
  private fallbackTimer: QuitTimer | undefined;
  private electronExited = false;
  private hardExitCalled = false;

  constructor(private readonly dependencies: QuitCoordinatorDependencies) {
    this.schedule = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimer = dependencies.clearTimeout ?? (timer => clearTimeout(timer));
    this.stopTimeoutMs = boundedDelay(dependencies.stopTimeoutMs, RUNTIME_STOP_TIMEOUT_MS, RUNTIME_STOP_TIMEOUT_MS);
    this.hardExitDelayMs = boundedDelay(dependencies.hardExitDelayMs, HARD_EXIT_DELAY_MS, MAX_HARD_EXIT_DELAY_MS);
  }

  /** Starts shutdown once and returns the same promise for every later request. */
  requestQuit(exitCode?: number): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    this.quitPromise = this.coordinate(exitCode);
    return this.quitPromise;
  }

  quit(exitCode?: number): Promise<void> {
    return this.requestQuit(exitCode);
  }

  /** Call from Electron's quit event (or equivalent) to suppress hardExit. */
  cancelFallback(): void {
    this.electronExited = true;
    if (this.fallbackTimer === undefined) return;
    this.cancelTimer(this.fallbackTimer);
    this.fallbackTimer = undefined;
  }

  cancelHardExit(): void {
    this.cancelFallback();
  }

  markElectronExited(): void {
    this.cancelFallback();
  }

  private async coordinate(requestedExitCode: number | undefined): Promise<void> {
    try { this.dependencies.windows.prepareToQuit?.(); } catch { /* continue shutdown */ }

    let stopped = false;
    try { stopped = await this.stopWithinDeadline(); } catch { /* treat coordinator failures as stop failures */ }

    const exitCode = requestedExitCode ?? (stopped ? 0 : 1);
    if (!stopped) {
      try { this.dependencies.runtime.forceShutdown(); } catch { /* continue shutdown */ }
    }
    try { this.dependencies.windows.destroyForQuit(); } catch { /* continue shutdown */ }
    try { this.dependencies.appExit(exitCode); } catch { /* hardExit remains available */ }
    this.scheduleHardExit(exitCode);
  }

  private async stopWithinDeadline(): Promise<boolean> {
    let stopPromise: Promise<boolean>;
    try {
      stopPromise = Promise.resolve(this.dependencies.runtime.stop()).then(() => true, () => false);
    } catch {
      return false;
    }

    let timeout: QuitTimer | undefined;
    const deadline = new Promise<boolean>(resolve => {
      timeout = this.schedule(() => resolve(false), this.stopTimeoutMs);
    });
    try {
      return await Promise.race([stopPromise, deadline]);
    } finally {
      if (timeout !== undefined) this.cancelTimer(timeout);
    }
  }

  private scheduleHardExit(exitCode: number): void {
    if (this.electronExited || this.dependencies.isElectronExited?.()) return;
    this.fallbackTimer = this.schedule(() => {
      this.fallbackTimer = undefined;
      if (this.electronExited || this.dependencies.isElectronExited?.() || this.hardExitCalled) return;
      this.hardExitCalled = true;
      try { this.dependencies.hardExit(exitCode); } catch { /* last-resort attempt is complete */ }
    }, this.hardExitDelayMs);
  }
}

export function createQuitCoordinator(dependencies: QuitCoordinatorDependencies): QuitCoordinator {
  return new QuitCoordinator(dependencies);
}

export default QuitCoordinator;
