import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const electronMocks = vi.hoisted(() => {
  type Handler = (event: unknown, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const notifications: Array<Record<string, unknown>> = [];
  const handle = vi.fn((channel: string, callback: Handler) => {
    handlers.set(channel, callback);
  });
  class FakeNotification {
    static isSupported = vi.fn(() => true);
    constructor(options: Record<string, unknown>) { notifications.push(options); }
    show(): void {}
  }
  class FakeBrowserWindow {}
  class FakeTray {
    setToolTip(): void {}
    on(): void {}
    setContextMenu(): void {}
    destroy(): void {}
  }
  return {
    app: { getVersion: vi.fn(() => '0.2.0') },
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    handlers,
    ipcMain: { handle },
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    notifications,
    Notification: FakeNotification,
    shell: { openExternal: vi.fn(), openPath: vi.fn() },
    Tray: FakeTray
  };
});

vi.mock('electron', () => electronMocks);

import { WindowManager } from '../src/window-manager.js';
import { createAppQuitState, installSecureBridge } from '../src/secure-bridge.js';

type BridgeInput = Parameters<typeof installSecureBridge>[0];

function eventFor(): unknown {
  const mainFrame = { url: 'adhd-one://app/index.html' };
  return { sender: { id: 42, mainFrame }, senderFrame: mainFrame };
}

function createBridge() {
  const quitState = createAppQuitState();
  const settings = {
    get: vi.fn(() => ({ appChannel: 'stable', runtimeChannel: 'stable', workspace: 'C:\\Users\\Alice\\workspace' })),
    setWorkspace: vi.fn(async (value: string) => value)
  };
  const runtime = {
    restart: vi.fn(async () => undefined),
    snapshot: vi.fn(() => ({ state: 'ready', runtimeVersion: '0.1.0', url: 'http://127.0.0.1:43123' }))
  };
  const updates = {
    check: vi.fn(),
    confirm: vi.fn(async () => undefined),
    isPortable: vi.fn(() => false),
    quitAndInstall: vi.fn(),
    snapshot: vi.fn(() => ({ canConfirm: false }))
  };
  const doctor = { cancel: vi.fn(), report: vi.fn(), run: vi.fn(async () => ({})) };
  const windows = {
    controlWindow: vi.fn(() => ({ isDestroyed: () => false, webContents: { id: 42 } })),
    quit: vi.fn(async () => undefined)
  };
  const input = {
    doctor,
    paths: { data: 'C:\\Users\\Alice\\AppData\\private-data', dshHome: 'C:\\Users\\Alice\\dsh', logs: 'C:\\Users\\Alice\\private-logs' },
    quitState,
    runtime,
    settings,
    updates,
    windows
  } as unknown as BridgeInput;
  electronMocks.handlers.clear();
  installSecureBridge(input);
  const invoke = (channel: string, value?: unknown) => {
    const handler = electronMocks.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler(eventFor(), value);
  };
  return { doctor, invoke, quitState, runtime, settings, updates };
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected operation to reject');
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.handlers.clear();
  electronMocks.notifications.length = 0;
});

describe('privacy-safe IPC bridge', () => {
  it('freezes mutations after quit begins while allowing a snapshot', async () => {
    const { invoke, quitState, runtime } = createBridge();

    quitState.beginQuit();

    await expect(invoke('runtime:restart')).rejects.toMatchObject({ code: 'APP_QUITTING', message: 'APP_QUITTING' });
    expect(runtime.restart).not.toHaveBeenCalled();
    await expect(invoke('app:snapshot')).resolves.toMatchObject({ runtime: { state: 'ready' } });
    expect(runtime.snapshot).toHaveBeenCalledOnce();
  });

  it('keeps createAppQuitState one-way and increments its generation only once', () => {
    const quitState = createAppQuitState();

    expect(quitState.isQuitting()).toBe(false);
    expect(quitState.generation()).toBe(0);
    quitState.beginQuit();
    quitState.beginQuit();
    expect(quitState.isQuitting()).toBe(true);
    expect(quitState.generation()).toBe(1);
  });

  it('does not return internal data paths in the app snapshot IPC response', async () => {
    const { invoke } = createBridge();

    const snapshot = await invoke('app:snapshot');

    expect(snapshot).toMatchObject({ workspace: 'C:\\Users\\Alice\\workspace' });
    expect(snapshot).not.toHaveProperty('paths');
    expect(JSON.stringify(snapshot)).not.toContain('private-data');
    expect(JSON.stringify(snapshot)).not.toContain('private-logs');
    expect(JSON.stringify(snapshot)).not.toContain('\\\\Alice\\\\dsh');
  });

  it('maps native workspace picker errors to a stable code without the path or token', async () => {
    createBridge();
    electronMocks.dialog.showOpenDialog.mockRejectedValueOnce(new Error('ENOENT C:\\Users\\Alice\\private\\picker.json token=picker-secret'));

    const error = await captureError(() => electronMocks.handlers.get('workspace:choose')!(eventFor(), undefined));

    expect(error).toMatchObject({ code: 'WORKSPACE_PICK_FAILED', message: 'WORKSPACE_PICK_FAILED' });
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
    expect(JSON.stringify(error)).not.toContain('picker-secret');
  });

  it('maps workspace persistence errors without exposing the selected path', async () => {
    const { settings, invoke } = createBridge();
    electronMocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\Users\\Alice\\private\\selected'] });
    settings.setWorkspace.mockRejectedValueOnce(new Error('EACCES C:\\Users\\Alice\\private\\settings.json token=settings-secret'));

    const error = await captureError(() => invoke('workspace:choose') as Promise<unknown>);

    expect(error).toMatchObject({ code: 'WORKSPACE_PICK_FAILED', message: 'WORKSPACE_PICK_FAILED' });
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
    expect(JSON.stringify(error)).not.toContain('settings-secret');
  });

  it('maps native path-open failures to PATH_OPEN_FAILED', async () => {
    const { invoke } = createBridge();
    electronMocks.shell.openPath.mockResolvedValueOnce('Failed to open C:\\Users\\Alice\\private\\token.txt token=open-secret');

    const error = await captureError(() => invoke('path:open', 'data') as Promise<unknown>);

    expect(error).toMatchObject({ code: 'PATH_OPEN_FAILED', message: 'PATH_OPEN_FAILED' });
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
    expect(JSON.stringify(error)).not.toContain('open-secret');
  });

  it('preserves Provider Doctor stable codes while suppressing its raw failure text', async () => {
    const { doctor, invoke } = createBridge();
    doctor.run.mockRejectedValueOnce(Object.assign(
      new Error('Authorization: Bearer doctor-secret C:\\Users\\Alice\\private\\doctor.json'),
      { code: 'AUTH' }
    ));

    const error = await captureError(() => invoke('doctor:run', 'quick') as Promise<unknown>);

    expect(error).toMatchObject({ code: 'AUTH', message: 'AUTH' });
    expect(JSON.stringify(error)).not.toContain('doctor-secret');
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
  });

  it.each(['AUTH', 'QUOTA', 'RATE_LIMIT', 'MODEL_UNAVAILABLE'] as const)('preserves Provider Doctor code %s through IPC', async code => {
    const { doctor, invoke } = createBridge();
    doctor.run.mockRejectedValueOnce(Object.assign(
      new Error(`provider raw text Authorization: Bearer ${code.toLowerCase()}-secret C:\\Users\\Alice\\private\\doctor.json`),
      { code }
    ));

    const error = await captureError(() => invoke('doctor:run', 'quick') as Promise<unknown>);

    expect(error).toMatchObject({ code, message: code });
    expect(JSON.stringify(error)).not.toContain('-secret');
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
  });

  it('maps an unknown Provider Doctor code to a stable IPC fallback', async () => {
    const { doctor, invoke } = createBridge();
    doctor.run.mockRejectedValueOnce(Object.assign(
      new Error('remote unknown Authorization: Bearer unknown-secret C:\\Users\\Alice\\private\\unknown.json'),
      { code: 'REMOTE_FAILURE' }
    ));

    const error = await captureError(() => invoke('doctor:run', 'quick') as Promise<unknown>);

    expect(error).toMatchObject({ code: 'DOCTOR_FAILED', message: 'DOCTOR_FAILED' });
    expect(JSON.stringify(error)).not.toContain('unknown-secret');
    expect(JSON.stringify(error)).not.toContain('C:\\Users\\Alice');
  });
});

describe('privacy-safe tray notifications and renderer errors', () => {
  it('does not put a raw shell error into a tray notification', async () => {
    const manager = new WindowManager({} as never, 'C:\\app', 'adhd-one://app/index.html', {} as never, {} as never, { data: 'data', logs: 'logs' }, true);
    electronMocks.shell.openPath.mockRejectedValueOnce(new Error('EACCES C:\\Users\\Alice\\private\\token.txt token=notify-secret'));

    await (manager as unknown as { openPath(target: string): Promise<void> }).openPath('C:\\Users\\Alice\\private\\token.txt');

    expect(electronMocks.notifications).toEqual([{ title: '无法打开目录', body: '打开目录失败。', silent: false }]);
    expect(JSON.stringify(electronMocks.notifications)).not.toContain('notify-secret');
    expect(JSON.stringify(electronMocks.notifications)).not.toContain('C:\\Users\\Alice');
  });

  it('uses fixed renderer error text and has no raw error fallback', () => {
    const source = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

    expect(source).toContain('操作失败，请稍后重试。');
    expect(source).toContain("APP_QUITTING: '应用正在退出，请稍后重试。'");
    expect(source).not.toContain('error?.message||String(error)');
    expect(source).not.toContain('target.textContent=`操作失败：${error');
  });
});
