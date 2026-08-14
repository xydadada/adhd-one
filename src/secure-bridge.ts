import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { z } from 'zod';
import type { ProviderDoctor } from './provider-doctor.js';
import type { RuntimeController } from './runtime-controller.js';
import type { SettingsStore } from './settings-store.js';
import type { UpdateManager } from './update-manager.js';
import type { WindowManager } from './window-manager.js';
import { isTrustedControlUrl } from './security.js';

const BRIDGE_ERROR_CODES = new Set<string>([
  'APP_QUITTING',
  'UNTRUSTED_IPC_SENDER',
  'APP_SNAPSHOT_FAILED', 'WORKSPACE_PICK_FAILED', 'PATH_NOT_CONFIGURED', 'PATH_OPEN_FAILED',
  'WORKSPACE_NOT_FOUND', 'WORKSPACE_NOT_DIRECTORY', 'SETTINGS_IO', 'SETTINGS_CORRUPT', 'SETTINGS_LOCKED',
  'RUNTIME_RESTART_FAILED', 'UPDATE_CHECK_FAILED', 'UPDATE_NOT_AVAILABLE', 'UPDATE_CONFIRM_FAILED',
  'APP_INSTALL_FAILED', 'PORTABLE_UPDATE_DOWNLOAD_ONLY', 'DOCTOR_FAILED', 'DOCTOR_CONFIRMATION_REQUIRED',
  'DOCTOR_REPORT_MISSING', 'DOCTOR_COPY_FAILED',
  'MISSING_CREDENTIAL', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'TRANSPORT', 'TIMEOUT',
  'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'TOOL_ARGUMENT_INVALID', 'TOOL_ESCALATION_REQUIRED',
  'REASONING_UNSUPPORTED', 'DSH_PROTOCOL_INCOMPATIBLE'
]);

const CHANNEL_FALLBACK_CODES: Record<string, string> = {
  'app:snapshot': 'APP_SNAPSHOT_FAILED',
  'workspace:choose': 'WORKSPACE_PICK_FAILED',
  'path:open': 'PATH_OPEN_FAILED',
  'runtime:restart': 'RUNTIME_RESTART_FAILED',
  'update:check': 'UPDATE_CHECK_FAILED',
  'update:confirm': 'UPDATE_CONFIRM_FAILED',
  'doctor:run': 'DOCTOR_FAILED',
  'doctor:cancel': 'DOCTOR_FAILED',
  'doctor:copy': 'DOCTOR_COPY_FAILED'
};

class SecureBridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SecureBridgeError';
  }
}

export interface AppQuitState {
  beginQuit(): void;
  isQuitting(): boolean;
  generation(): number;
}

/** A synchronous, one-way gate shared by main and every IPC mutation. */
export function createAppQuitState(): AppQuitState {
  let quitting = false;
  let currentGeneration = 0;
  return {
    beginQuit(): void {
      if (quitting) return;
      quitting = true;
      currentGeneration += 1;
    },
    isQuitting: () => quitting,
    generation: () => currentGeneration
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]*$/u.test(error.message)) return error.message;
  return undefined;
}

function stableError(error: unknown, fallback: string): SecureBridgeError {
  const candidate = errorCode(error);
  return new SecureBridgeError(candidate && BRIDGE_ERROR_CODES.has(candidate) ? candidate : fallback);
}

function trusted(event: IpcMainInvokeEvent, windows: WindowManager): void {
  const control = windows.controlWindow();
  if (!control || control.isDestroyed() || event.sender.id !== control.webContents.id
    || event.senderFrame !== event.sender.mainFrame) throw new Error('UNTRUSTED_IPC_SENDER');
  if (!isTrustedControlUrl(event.senderFrame.url)) throw new Error('UNTRUSTED_IPC_SENDER');
}

export function installSecureBridge(input: {
  runtime: RuntimeController; settings: SettingsStore; updates: UpdateManager; doctor: ProviderDoctor; windows: WindowManager;
  paths: { data: string; logs: string; dshHome: string };
  quitState?: AppQuitState;
}): void {
  const quitState = input.quitState ?? createAppQuitState();
  type AssertActive = () => void;
  const handle = (
    channel: string,
    callback: (event: IpcMainInvokeEvent, value: unknown, assertActive: AssertActive) => unknown,
    options: { allowDuringQuit?: boolean } = {}
  ) => ipcMain.handle(channel, async (event, value) => {
    try {
      trusted(event, input.windows);
      const assertActive: AssertActive = options.allowDuringQuit
        ? () => undefined
        : (() => {
          const generation = quitState.generation();
          return () => {
            if (quitState.isQuitting() || quitState.generation() !== generation) throw new SecureBridgeError('APP_QUITTING');
          };
        })();
      assertActive();
      return await callback(event, value, assertActive);
    } catch (error) {
      throw stableError(error, CHANNEL_FALLBACK_CODES[channel] ?? 'IPC_OPERATION_FAILED');
    }
  });
  handle('app:snapshot', () => ({ appVersion: app.getVersion(), runtime: input.runtime.snapshot(), workspace: input.settings.get().workspace }), { allowDuringQuit: true });
  handle('app:quit', () => {
    quitState.beginQuit();
    setImmediate(() => void input.windows.quit());
    return { accepted: true };
  }, { allowDuringQuit: true });
  handle('workspace:choose', async (_event, _value, assertActive) => {
    const owner = input.windows.controlWindow();
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], title: '选择 DeepSeek Harness 工作区' };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return {};
    assertActive();
    return { path: await input.settings.setWorkspace(result.filePaths[0]) };
  });
  handle('path:open', async (_event, value) => {
    const kind = z.enum(['workspace', 'data', 'logs']).parse(value);
    const target = kind === 'workspace' ? input.settings.get().workspace : input.paths[kind];
    if (!target) throw new Error('PATH_NOT_CONFIGURED'); const error = await shell.openPath(target); if (error) throw new Error('PATH_OPEN_FAILED');
  });
  handle('runtime:restart', async (_event, _value, assertActive) => {
    assertActive();
    try {
      const snapshot = await input.runtime.restart();
      assertActive();
      return snapshot;
    } catch (error) {
      assertActive();
      throw error;
    }
  });
  handle('update:check', async (_event, value, assertActive) => {
    const target = z.enum(['app', 'runtime']).parse(value); const settings = input.settings.get();
    assertActive();
    try {
      const snapshot = await input.updates.check(target, target === 'app' ? settings.appChannel : settings.runtimeChannel);
      assertActive();
      return snapshot;
    } catch (error) {
      assertActive();
      throw error;
    }
  });
  handle('update:confirm', async (_event, value, assertActive) => {
    const target = z.enum(['app', 'runtime']).parse(value);
    if (target === 'app' && input.updates.isPortable()) {
      const snapshot = input.updates.snapshot('app');
      if (!snapshot.canConfirm || !snapshot.candidateVersion) throw new Error('UPDATE_NOT_AVAILABLE');
      assertActive();
      await shell.openExternal(`https://github.com/xydadada/adhd-one/releases/tag/v${encodeURIComponent(snapshot.candidateVersion)}`);
      return;
    }
    try { assertActive(); await input.updates.confirm(target); }
    catch { assertActive(); throw new Error('UPDATE_CONFIRM_FAILED'); }
    assertActive();
    if (target === 'app') {
      assertActive();
      await input.runtime.stop();
      assertActive();
      try {
        assertActive();
        input.updates.quitAndInstall();
      }
      catch {
        assertActive();
        await input.runtime.start().catch(() => undefined);
        assertActive();
        throw new Error('APP_INSTALL_FAILED');
      }
    } else {
      assertActive();
      try {
        await input.runtime.restart();
        assertActive();
      } catch (error) {
        assertActive();
        throw error;
      }
    }
  });
  handle('doctor:run', async (_event, value, assertActive) => {
    const mode = z.enum(['quick', 'deep']).parse(value);
    if (mode === 'deep') {
      assertActive();
      const owner = input.windows.controlWindow();
      const options = { type: 'warning' as const, title: '确认 Provider 深度检查', message: '这会使用当前默认模型执行一次真实工具调用，可能产生小额费用。', buttons: ['继续', '取消'], defaultId: 1, cancelId: 1 };
      const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      assertActive();
      if (answer.response !== 0) throw new Error('DOCTOR_CONFIRMATION_REQUIRED');
    }
    assertActive();
    try {
      const report = await input.doctor.run(mode);
      assertActive();
      return report;
    } catch (error) {
      assertActive();
      throw error;
    }
  });
  handle('doctor:cancel', (_event, _value, assertActive) => { assertActive(); return input.doctor.cancel(); });
  handle('doctor:copy', (_event, _value, assertActive) => {
    const report = input.doctor.report();
    if (!report) throw new Error('DOCTOR_REPORT_MISSING');
    assertActive();
    clipboard.writeText(JSON.stringify(report, null, 2));
  });
}
