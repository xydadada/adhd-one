import { BrowserWindow, Menu, Notification, Tray, app, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { RuntimeController } from './runtime-controller.js';
import type { RuntimeSnapshot } from './types.js';
import { allowedExternalUrl, isExactOrigin } from './security.js';

export class WindowManager {
  private control?: BrowserWindow;
  private harness?: BrowserWindow;
  private tray?: Tray;
  private quitting = false;
  constructor(private readonly runtime: RuntimeController, private readonly appPath: string, private readonly openControlPath: string) {}

  create(): void {
    this.control = new BrowserWindow({
      width: 920, height: 720, minWidth: 760, minHeight: 560, show: false, title: 'ADHD One',
      icon: path.join(this.appPath, 'assets', 'icon.png'),
      webPreferences: { preload: path.join(this.appPath, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    this.guard(this.control, () => 'adhd-one://app');
    void this.control.loadURL(this.openControlPath);
    this.control.once('ready-to-show', () => this.control?.show());
    this.control.on('close', event => { if (!this.quitting) { event.preventDefault(); this.control?.hide(); } });

    this.harness = new BrowserWindow({
      width: 1440, height: 940, minWidth: 900, minHeight: 640, show: false, title: 'ADHD One — Harness',
      icon: path.join(this.appPath, 'assets', 'icon.png'),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:adhd-one-harness' }
    });
    this.guard(this.harness, () => this.runtime.snapshot().url);
    this.harness.on('close', event => { if (!this.quitting) { event.preventDefault(); this.harness?.hide(); } });
    this.runtime.on('changed', snapshot => this.onRuntime(snapshot as RuntimeSnapshot));
    this.runtime.on('ready', () => this.notify('DeepSeek Harness 已就绪', '本地 Harness 已安全启动。'));
    this.runtime.on('crashed', () => this.notify('DeepSeek Harness 异常退出', 'ADHD One 正在按安全策略尝试恢复。'));
    this.createTray(); this.onRuntime(this.runtime.snapshot());
  }

  controlWindow(): BrowserWindow | undefined { return this.control; }
  showControl(): void { this.control?.show(); this.control?.focus(); }
  async quit(): Promise<void> { this.quitting = true; await this.runtime.stop(); this.tray?.destroy(); app.quit(); }
  notify(title: string, body: string): void { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); }

  private onRuntime(snapshot: RuntimeSnapshot): void {
    this.control?.webContents.send('runtime:changed', snapshot);
    if (snapshot.state === 'ready' && snapshot.url && this.harness) {
      const current = this.harness.webContents.getURL();
      if (!isExactOrigin(current, snapshot.url)) void this.harness.loadURL(snapshot.url);
      this.harness.show(); this.control?.hide();
    } else if (snapshot.state === 'failed') this.showControl();
    this.rebuildTray(snapshot);
  }
  private createTray(): void { this.tray = new Tray(path.join(this.appPath, 'assets', 'icon.ico')); this.tray.setToolTip('ADHD One'); this.tray.on('double-click', () => this.showControl()); }
  private rebuildTray(snapshot: RuntimeSnapshot): void {
    if (!this.tray) return;
    const menu: MenuItemConstructorOptions[] = [
      { label: this.harness?.isVisible() ? '隐藏主窗口' : '显示主窗口', click: () => this.harness?.isVisible() ? this.harness.hide() : snapshot.state === 'ready' ? this.harness?.show() : this.showControl() },
      { label: `Harness：${snapshot.state} · ${snapshot.runtimeVersion}`, enabled: false },
      { label: `ADHD One：${app.getVersion()}`, enabled: false }, { type: 'separator' },
      { label: '重启 Harness', enabled: snapshot.state === 'ready' || snapshot.state === 'failed', click: () => void this.runtime.restart() },
      { label: 'Provider Doctor', click: () => { this.showControl(); this.control?.webContents.send('control:navigate', 'doctor'); } },
      { label: '检查更新', click: () => { this.showControl(); this.control?.webContents.send('control:navigate', 'updates'); } },
      { type: 'separator' }, { label: '完整退出', click: () => void this.quit() }
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(menu));
  }
  private guard(window: BrowserWindow, trustedOrigin: () => string | undefined): void {
    window.webContents.setWindowOpenHandler(({ url }) => { if (allowedExternalUrl(url)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, target) => {
      const origin = trustedOrigin();
      if (origin === 'adhd-one://app' ? target.startsWith('adhd-one://app/') : origin && isExactOrigin(target, origin)) return;
      event.preventDefault(); if (allowedExternalUrl(target)) void shell.openExternal(target);
    });
  }
}
