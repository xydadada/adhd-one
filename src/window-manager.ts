import { BrowserWindow, Menu, Notification, Tray, app, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { RuntimeController } from './runtime-controller.js';
import type { SettingsStore } from './settings-store.js';
import type { UpdateManager } from './update-manager.js';
import type { RuntimeSnapshotV2, UpdateSnapshotV2 } from './types.js';
import { allowedExternalUrl, isExactOrigin, isTrustedControlUrl } from './security.js';

export class WindowManager {
  private control?: BrowserWindow;
  private harness?: BrowserWindow;
  private harnessGeneration?: number;
  private tray?: Tray;
  private quitting = false;
  constructor(
    private readonly runtime: RuntimeController,
    private readonly appPath: string,
    private readonly openControlPath: string,
    private readonly settings: SettingsStore,
    private readonly updates: UpdateManager,
    private readonly paths: { data: string; logs: string },
    private readonly smokeTest = false
  ) {}

  create(): void {
    this.control = new BrowserWindow({
      width: 920, height: 720, minWidth: 760, minHeight: 560, show: false, title: 'ADHD One',
      icon: path.join(this.appPath, 'assets', 'icon.png'),
      webPreferences: { preload: path.join(this.appPath, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    this.guard(this.control, () => 'adhd-one://app');
    void this.control.loadURL(this.openControlPath);
    this.control.once('ready-to-show', () => this.control?.show());
    this.control.on('close', event => {
      if (this.quitting) return;
      event.preventDefault(); this.control?.hide();
      if (!this.settings.get().closeToTrayExplained) {
        void this.settings.update({ closeToTrayExplained: true });
        void dialog.showMessageBox({ type: 'info', title: 'ADHD One 仍在运行', message: '窗口已缩到系统托盘。', detail: 'DeepSeek Harness 会继续在后台运行；请选择托盘菜单中的“完整退出”来停止服务。' });
      }
    });

    this.runtime.on('changed', snapshot => this.onRuntime(snapshot as RuntimeSnapshotV2));
    this.runtime.on('ready', () => { this.notify('DeepSeek Harness 已就绪', '本地 Harness 已安全启动。'); void this.updates.refreshRuntimeStatus(); });
    this.runtime.on('crashed', () => this.notify('DeepSeek Harness 异常退出', 'ADHD One 正在按安全策略尝试恢复。'));
    this.runtime.on('rolled-back', () => { this.notify('DSH Runtime 已回滚', '候选 Runtime 启动失败，已恢复上一可用版本。'); void this.updates.refreshRuntimeStatus(); });
    this.runtime.on('stable', () => void this.updates.refreshRuntimeStatus());
    this.updates.on('changed', value => this.onUpdate(value as UpdateSnapshotV2));
    this.createTray(); this.onRuntime(this.runtime.snapshot());
  }

  controlWindow(): BrowserWindow | undefined { return this.control; }
  showControl(): void { this.control?.show(); this.control?.focus(); }
  async quit(): Promise<void> { this.prepareToQuit(); app.quit(); }
  prepareToQuit(): void { this.quitting = true; this.tray?.destroy(); delete this.tray; }
  destroyForQuit(): void {
    this.prepareToQuit();
    if (this.harness && !this.harness.isDestroyed()) this.harness.destroy();
    if (this.control && !this.control.isDestroyed()) this.control.destroy();
    delete this.harness;
    delete this.harnessGeneration;
    delete this.control;
  }
  notify(title: string, body: string): void { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); }

  private onRuntime(snapshot: RuntimeSnapshotV2): void {
    this.control?.webContents.send('runtime:changed', snapshot);
    if (snapshot.state === 'ready' && snapshot.url && !this.smokeTest) {
      this.showHarness(snapshot);
    } else if (snapshot.state === 'failed') { this.harness?.hide(); this.showControl(); }
    this.rebuildTray(snapshot);
  }
  private onUpdate(update: UpdateSnapshotV2): void {
    this.control?.webContents.send('update:changed', update);
    if (update.phase === 'available') this.notify(update.target === 'app' ? 'ADHD One 有新版本' : 'DSH Runtime 有新版本', update.candidateVersion ?? '可在更新页确认下载。');
  }
  private ensureHarnessWindow(): BrowserWindow {
    if (this.harness && !this.harness.isDestroyed()) return this.harness;
    const harness = new BrowserWindow({
      width: 1440, height: 940, minWidth: 900, minHeight: 640, show: false, title: 'ADHD One — Harness',
      icon: path.join(this.appPath, 'assets', 'icon.png'),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:adhd-one-harness' }
    });
    this.harness = harness;
    this.guard(harness, () => this.runtime.snapshot().url);
    harness.on('closed', () => {
      if (this.harness !== harness) return;
      delete this.harness;
      delete this.harnessGeneration;
    });
    harness.on('close', event => { if (!this.quitting) { event.preventDefault(); harness.hide(); } });
    return harness;
  }
  private showHarness(snapshot: RuntimeSnapshotV2): void {
    if (snapshot.state !== 'ready' || !snapshot.url) { this.showControl(); return; }
    const harness = this.ensureHarnessWindow();
    const current = harness.webContents.getURL();
    if (!isExactOrigin(current, snapshot.url) || this.harnessGeneration !== snapshot.generation) {
      this.harnessGeneration = snapshot.generation;
      void harness.loadURL(snapshot.url);
    }
    harness.show();
    this.control?.hide();
  }
  private createTray(): void { this.tray = new Tray(path.join(this.appPath, 'assets', 'icon.ico')); this.tray.setToolTip('ADHD One'); this.tray.on('double-click', () => this.showControl()); }
  private rebuildTray(snapshot: RuntimeSnapshotV2): void {
    if (!this.tray) return;
    const menu: MenuItemConstructorOptions[] = [
      { label: this.harness?.isVisible() ? '隐藏主窗口' : '显示主窗口', click: () => this.harness?.isVisible() ? this.harness.hide() : this.showHarness(snapshot) },
      { label: `Harness：${snapshot.state} · ${snapshot.runtimeVersion}`, enabled: false },
      { label: `ADHD One：${app.getVersion()}`, enabled: false }, { type: 'separator' },
      { label: '重启 Harness', enabled: snapshot.state === 'ready' || snapshot.state === 'failed', click: () => void this.runtime.restart() },
      { label: '打开工作区', enabled: Boolean(this.settings.get().workspace), click: () => void this.openPath(this.settings.get().workspace) },
      { label: '打开数据目录', click: () => void this.openPath(this.paths.data) },
      { label: '打开日志目录', click: () => void this.openPath(this.paths.logs) },
      { label: 'Provider Doctor', click: () => { this.showControl(); this.control?.webContents.send('control:navigate', 'doctor'); } },
      { label: '检查应用更新', click: () => void this.checkUpdate('app') },
      { label: '检查 DSH 更新', click: () => void this.checkUpdate('runtime') },
      { type: 'separator' }, { label: '完整退出', click: () => void this.quit() }
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(menu));
  }
  private async openPath(target?: string): Promise<void> {
    if (!target) {
      this.notify('无法打开目录', '目录尚未配置。');
      return;
    }
    try {
      const error = await shell.openPath(target);
      if (error) this.notify('无法打开目录', '打开目录失败。');
    } catch {
      this.notify('无法打开目录', '打开目录失败。');
    }
  }
  private async checkUpdate(target: 'app' | 'runtime'): Promise<void> {
    this.showControl(); this.control?.webContents.send('control:navigate', 'updates');
    const settings = this.settings.get();
    try { await this.updates.check(target, target === 'app' ? settings.appChannel : settings.runtimeChannel); }
    catch { this.notify('检查更新失败', target === 'app' ? '无法检查 ADHD One 更新。' : '无法检查 DSH Runtime 更新。'); }
  }
  private guard(window: BrowserWindow, trustedOrigin: () => string | undefined): void {
    window.webContents.setWindowOpenHandler(({ url }) => { if (allowedExternalUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
    const guardNavigation = (event: Electron.Event, target: string): void => {
      const origin = trustedOrigin();
      if (origin === 'adhd-one://app' ? isTrustedControlUrl(target) : origin && isExactOrigin(target, origin)) return;
      event.preventDefault(); if (allowedExternalUrl(target)) void shell.openExternal(target);
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);
  }
}
