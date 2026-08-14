import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { z } from 'zod';
import type { ProviderDoctor } from './provider-doctor.js';
import type { RuntimeController } from './runtime-controller.js';
import type { SettingsStore } from './settings-store.js';
import type { UpdateManager } from './update-manager.js';
import type { WindowManager } from './window-manager.js';

function trusted(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame?.url.startsWith('adhd-one://app/')) throw new Error('UNTRUSTED_IPC_SENDER');
}

export function installSecureBridge(input: {
  runtime: RuntimeController; settings: SettingsStore; updates: UpdateManager; doctor: ProviderDoctor; windows: WindowManager;
  paths: { data: string; logs: string; dshHome: string };
}): void {
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, value: unknown) => unknown) => ipcMain.handle(channel, async (event, value) => { trusted(event); return callback(event, value); });
  handle('app:snapshot', () => ({ appVersion: app.getVersion(), runtime: input.runtime.snapshot(), workspace: input.settings.get().workspace, paths: input.paths }));
  handle('workspace:choose', async () => {
    const owner = input.windows.controlWindow();
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], title: '选择 DeepSeek Harness 工作区' };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return {};
    return { path: await input.settings.setWorkspace(result.filePaths[0]) };
  });
  handle('path:open', async (_event, value) => {
    const kind = z.enum(['workspace', 'data', 'logs']).parse(value);
    const target = kind === 'workspace' ? input.settings.get().workspace : input.paths[kind];
    if (!target) throw new Error('PATH_NOT_CONFIGURED'); const error = await shell.openPath(target); if (error) throw new Error(error);
  });
  handle('runtime:restart', () => input.runtime.restart());
  handle('update:check', (_event, value) => { const target = z.enum(['app', 'runtime']).parse(value); const settings = input.settings.get(); return input.updates.check(target, target === 'app' ? settings.appChannel : settings.runtimeChannel); });
  handle('update:confirm', (_event, value) => input.updates.confirm(z.enum(['app', 'runtime']).parse(value)));
  handle('doctor:run', (_event, value) => input.doctor.run(z.enum(['quick', 'deep']).parse(value)));
  handle('doctor:cancel', () => input.doctor.cancel());
  handle('doctor:copy', () => { const report = input.doctor.report(); if (!report) throw new Error('DOCTOR_REPORT_MISSING'); clipboard.writeText(JSON.stringify(report, null, 2)); });
}
