import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  type Handler = (event: unknown, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const handle = vi.fn((channel: string, callback: Handler) => {
    handlers.set(channel, callback);
  });

  return {
    app: { getVersion: vi.fn(() => '0.2.0') },
    clipboard: { writeText: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    handlers,
    ipcMain: { handle },
    shell: { openExternal: vi.fn(), openPath: vi.fn() }
  };
});

vi.mock('electron', () => electronMocks);

import { installSecureBridge } from '../src/secure-bridge.js';

type BridgeInput = Parameters<typeof installSecureBridge>[0];

function eventFor(options: { senderId?: number; url?: string; separateFrame?: boolean } = {}): unknown {
  const mainFrame = { url: options.url ?? 'adhd-one://app/index.html' };
  const sender = { id: options.senderId ?? 42, mainFrame };
  return { sender, senderFrame: options.separateFrame ? { ...mainFrame } : mainFrame };
}

function createBridge(options: {
  portable?: boolean;
  appPhase?: string;
  appCandidateVersion?: string;
} = {}) {
  const calls: string[] = [];
  let appPhase = options.appPhase ?? 'available';
  const runtime = {
    start: vi.fn(async () => { calls.push('runtime.start'); }),
    stop: vi.fn(async () => { calls.push('runtime.stop'); }),
    restart: vi.fn(async () => { calls.push('runtime.restart'); }),
    snapshot: vi.fn()
  };
  const updates = {
    isPortable: vi.fn(() => options.portable ?? false),
    snapshot: vi.fn((target: string) => target === 'app'
      ? {
        target: 'app', channel: 'stable', phase: appPhase, currentVersion: '0.2.0',
        ...(options.appCandidateVersion === undefined ? { candidateVersion: '1.2.3' } : { candidateVersion: options.appCandidateVersion }),
        canConfirm: appPhase === 'available', canInstall: appPhase === 'verified', rollback: false
      }
      : { target: 'runtime', channel: 'stable', phase: 'available', currentVersion: '0.1.0', candidateVersion: '2.0.0', canConfirm: true, canInstall: false, rollback: false }),
    check: vi.fn(),
    confirm: vi.fn(async (target: string) => { calls.push('confirm'); if (target === 'app') appPhase = 'verified'; }),
    quitAndInstall: vi.fn(() => { calls.push('quitAndInstall'); })
  };
  const windows = {
    controlWindow: vi.fn(() => ({ isDestroyed: () => false, webContents: { id: 42 } })),
    quit: vi.fn(async () => { calls.push('windows.quit'); })
  };
  const input = {
    runtime,
    settings: { get: vi.fn(() => ({ appChannel: 'stable', runtimeChannel: 'stable', workspace: undefined })) },
    updates,
    doctor: { run: vi.fn(), cancel: vi.fn(), report: vi.fn() },
    windows,
    paths: { data: 'data', logs: 'logs', dshHome: 'dsh-home' }
  } as unknown as BridgeInput;

  electronMocks.handlers.clear();
  installSecureBridge(input);

  const invoke = (target: unknown, event: unknown = eventFor()) => {
    const handler = electronMocks.handlers.get('update:confirm');
    if (!handler) throw new Error('update:confirm handler was not registered');
    return handler(event, target);
  };

  return { calls, runtime, updates, windows, invoke };
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.handlers.clear();
});

describe('SecureBridge update IPC', () => {
  it('opens only the exact release tag for an available portable app update', async () => {
    const { invoke, updates, runtime, windows } = createBridge({ portable: true, appCandidateVersion: '1.2.3' });

    await invoke('app');

    expect(electronMocks.shell.openExternal).toHaveBeenCalledOnce();
    expect(electronMocks.shell.openExternal).toHaveBeenCalledWith('https://github.com/xydadada/adhd-one/releases/tag/v1.2.3');
    expect(updates.confirm).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
    expect(windows.quit).not.toHaveBeenCalled();
  });

  it('rejects a portable app update when no app update is available', async () => {
    const { invoke, updates, runtime } = createBridge({ portable: true, appPhase: 'idle', appCandidateVersion: undefined });

    await expect(invoke('app')).rejects.toThrow('UPDATE_NOT_AVAILABLE');

    expect(electronMocks.shell.openExternal).not.toHaveBeenCalled();
    expect(updates.confirm).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('requires separate download verification and installation confirmations', async () => {
    const { invoke, calls, updates, runtime } = createBridge();

    await invoke('app');

    expect(calls).toEqual(['confirm']);
    expect(updates.confirm).toHaveBeenCalledWith('app');
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(updates.quitAndInstall).not.toHaveBeenCalled();

    await invoke('app');

    expect(calls).toEqual(['confirm', 'runtime.stop', 'quitAndInstall']);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(updates.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('does not stop the runtime when app update confirmation fails', async () => {
    const { invoke, calls, updates, runtime } = createBridge();
    updates.confirm.mockImplementation(async () => {
      calls.push('confirm');
      throw new Error('updater detail');
    });

    await expect(invoke('app')).rejects.toThrow('UPDATE_CONFIRM_FAILED');

    expect(calls).toEqual(['confirm']);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
  });

  it('restarts the runtime after quitAndInstall fails and exposes only APP_INSTALL_FAILED', async () => {
    const { invoke, calls, updates, runtime } = createBridge({ appPhase: 'verified' });
    updates.quitAndInstall.mockImplementation(() => {
      calls.push('quitAndInstall');
      throw new Error('private updater detail');
    });

    let rejection: unknown;
    try {
      await invoke('app');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('APP_INSTALL_FAILED');
    expect(calls).toEqual(['runtime.stop', 'quitAndInstall', 'runtime.start']);
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it('does not invoke the installer when stopping the runtime fails', async () => {
    const { invoke, updates, runtime } = createBridge({ appPhase: 'verified' });
    runtime.stop.mockRejectedValueOnce(new Error('private stop detail'));

    await expect(invoke('app')).rejects.toThrow('APP_INSTALL_FAILED');

    expect(updates.quitAndInstall).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('runs runtime update actions in confirm-restart order', async () => {
    const { invoke, calls, updates, runtime } = createBridge();

    await invoke('runtime');

    expect(calls).toEqual(['confirm', 'runtime.restart']);
    expect(updates.confirm).toHaveBeenCalledWith('runtime');
    expect(runtime.restart).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before running update logic', async () => {
    const { invoke, updates, runtime } = createBridge({ portable: true });

    await expect(invoke('app', eventFor({ senderId: 99 }))).rejects.toThrow('UNTRUSTED_IPC_SENDER');

    expect(updates.snapshot).not.toHaveBeenCalled();
    expect(electronMocks.shell.openExternal).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('rejects an invalid update target', async () => {
    const { invoke, updates, runtime } = createBridge();

    await expect(invoke('not-a-target')).rejects.toThrow();

    expect(updates.confirm).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.restart).not.toHaveBeenCalled();
  });
});
