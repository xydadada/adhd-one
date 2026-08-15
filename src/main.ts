import { app, dialog, protocol, session } from 'electron';
import { mkdtemp, readFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeController } from './runtime-controller.js';
import { createQuitCoordinator } from './quit-coordinator.js';
import { SettingsStore, SettingsStoreError } from './settings-store.js';
import { UpdateManager } from './update-manager.js';
import { ProviderDoctor } from './provider-doctor.js';
import { WindowManager } from './window-manager.js';
import { createAppQuitState, installSecureBridge } from './secure-bridge.js';
import { isExactOrigin } from './security.js';
import { assertPortableDataWritable, copyLegacyDsh, detectLegacyDsh, getLegacyDshPath, runLegacyDshImportFlow } from './data-migration.js';
import { assertNoWindowsReparseComponents } from './windows-platform.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'adhd-one', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
app.enableSandbox(); app.setName('ADHD One');
const portable = app.isPackaged && existsSync(path.join(process.resourcesPath, 'portable.marker'));
const systemAppData = process.env.APPDATA?.trim();
const localAppData = process.env.LOCALAPPDATA?.trim();
let portableDataError: Error | undefined;
if (portable) {
  const portableData = path.join(path.dirname(process.execPath), 'portable-data');
  try {
    assertNoWindowsReparseComponents(portableData);
    mkdirSync(portableData, { recursive: true });
    assertNoWindowsReparseComponents(portableData);
    const portableInfo = lstatSync(portableData);
    if (portableInfo.isSymbolicLink() || !portableInfo.isDirectory()) throw new Error('PORTABLE_DATA_NOT_WRITABLE');
    const probe = path.join(portableData, `.write-test-${process.pid}`);
    const descriptor = openSync(probe, 'wx', 0o600);
    try { writeFileSync(descriptor, 'ok'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    unlinkSync(probe); app.setPath('userData', portableData);
  } catch (error) { portableDataError = error instanceof Error ? error : new Error(String(error)); }
} else {
  const userDataRoot = systemAppData ?? localAppData;
  if (userDataRoot) app.setPath('userData', path.join(userDataRoot, 'ADHD One'));
}

const smokeTest = process.argv.includes('--smoke-test');
let smokeDataRoot: string | undefined;
let smokeDataError = false;
if (smokeTest && !portableDataError) {
  try {
    const requestedRoot = process.env.ADHD_SMOKE_DATA_ROOT;
    const tempRoot = path.resolve(os.tmpdir());
    const candidate = requestedRoot ? path.resolve(requestedRoot) : undefined;
    const relative = candidate ? path.relative(tempRoot, candidate) : undefined;
    smokeDataRoot = candidate && relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      && path.basename(candidate).startsWith('adhd-one-smoke-')
      ? candidate
      : mkdtempSync(path.join(tempRoot, 'adhd-one-smoke-'));
    mkdirSync(smokeDataRoot, { recursive: true });
    app.setPath('userData', smokeDataRoot);
  } catch { smokeDataError = true; }
}

function cleanupSmokeData(): void {
  const root = smokeDataRoot;
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      smokeDataRoot = undefined;
    } catch { /* Chromium may still hold cache files at will-quit; the quit event retries. */ }
  }
}

if (smokeTest) {
  app.on('will-quit', cleanupSmokeData);
  app.on('quit', cleanupSmokeData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let emergencyQuit: ((exitCode: number) => Promise<void>) | undefined;

async function recoverPortableDataLocation(): Promise<boolean> {
  while (portableDataError) {
    const answer = await dialog.showMessageBox({
      type: 'error',
      title: 'Portable 数据目录不可写',
      message: 'ADHD One 无法在当前目录创建 portable-data。',
      detail: '请选择一个可写目录作为本次运行的数据目录，或退出后将 ZIP 解压到可写位置。应用不会静默改用 AppData。',
      buttons: ['选择数据目录', '退出'], defaultId: 0, cancelId: 1
    });
    if (answer.response !== 0) return false;
    const selection = await dialog.showOpenDialog({ title: '选择 ADHD One Portable 数据目录', properties: ['openDirectory', 'createDirectory'] });
    const selected = selection.canceled ? undefined : selection.filePaths[0];
    if (!selected) return false;
    try {
      const resolved = path.resolve(selected);
      assertNoWindowsReparseComponents(resolved);
      await assertPortableDataWritable(resolved);
      assertNoWindowsReparseComponents(resolved);
      app.setPath('userData', resolved);
      portableDataError = undefined;
      return true;
    } catch {
      const retry = await dialog.showMessageBox({
        type: 'error', title: '所选目录不可用', message: '无法安全地使用所选目录。',
        detail: '请选择一个已存在、可写且不经过符号链接或重解析点的目录。',
        buttons: ['重新选择', '退出'], defaultId: 0, cancelId: 1
      });
      if (retry.response !== 0) return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  if (portableDataError && !await recoverPortableDataLocation()) { app.exit(1); return; }
  if (smokeDataError) {
    cleanupSmokeData();
    const result = await dialog.showMessageBox({ type: 'error', title: 'ADHD One 无法启动', message: '无法创建 smoke-test 临时数据目录。', detail: '请检查系统临时目录后重试。', buttons: ['退出'] });
    void result; app.exit(1); return;
  }
  const appPath = app.getAppPath();
  let data: string;
  try { data = app.getPath('userData'); }
  catch {
    cleanupSmokeData();
    const result = await dialog.showMessageBox({ type: 'error', title: 'ADHD One 无法启动', message: '无法确定应用数据目录。', detail: '请设置 APPDATA 或 LOCALAPPDATA 后重试。', buttons: ['退出'] });
    void result; app.exit(1); return;
  }
  const local = smokeTest ? path.join(data, 'local') : portable ? path.join(data, 'local') : path.join(localAppData ?? path.dirname(data), 'ADHD One');
  const paths = { data, logs: path.join(local, 'logs'), dshHome: path.join(data, 'dsh-home') };
  const settingsFile = path.join(data, 'settings.json');
  const settings = smokeTest
    ? new SettingsStore(settingsFile)
    : new SettingsStore(settingsFile, path.join(systemAppData ?? path.dirname(data), 'Awesome DeepSeek Harness Desktop', 'settings.json'));
  try {
    await settings.load();
  } catch (error) {
    if (!(error instanceof SettingsStoreError) || error.code !== 'SETTINGS_CORRUPT') throw error;
    const answer = await dialog.showMessageBox({
      type: 'error', title: 'ADHD One 设置损坏', message: 'settings.json 与备份都无法读取。',
      detail: '可以保留两份损坏文件到隔离副本，并用默认设置继续；工作区和 Provider 数据不会被删除。',
      buttons: ['隔离并重置设置', '退出'], defaultId: 0, cancelId: 1
    });
    if (answer.response !== 0) { app.exit(1); return; }
    try { await settings.recoverCorrupt(); }
    catch {
      await dialog.showMessageBox({ type: 'error', title: '设置恢复失败', message: '无法安全隔离并重建设置。', detail: '原文件未被主动删除，请检查数据目录权限后重试。', buttons: ['退出'] });
      app.exit(1); return;
    }
  }
  const settingsLoadIssue = settings.takeLoadIssue();
  if (settingsLoadIssue) {
    await dialog.showMessageBox({
      type: 'warning', title: '需要重新选择工作区',
      message: settingsLoadIssue === 'WORKSPACE_NOT_FOUND' ? '之前的工作区已移动或不存在。' : '之前的工作区路径不再是文件夹。',
      detail: '其他设置已保留。继续后请在 ADHD One 控制窗口中重新选择工作区。', buttons: ['继续']
    });
  }
  if (portable && settings.get().portableDataPath !== data) await settings.update({ portableDataPath: data });
  if (!smokeTest && !settings.get().migration.legacyDshPrompted && !existsSync(paths.dshHome) && await detectLegacyDsh()) {
    const answer = await dialog.showMessageBox({ type: 'question', title: '导入现有 DeepSeek Harness 数据', message: '检测到原来的 .dsh 数据。是否复制导入到 ADHD One？', detail: '源目录不会被修改或删除。复制会先在同一磁盘暂存并校验，再原子切换。', buttons: ['复制导入', '暂不导入'], defaultId: 0, cancelId: 1 });
    await runLegacyDshImportFlow({
      accepted: answer.response === 0,
      copy: async () => { await copyLegacyDsh(getLegacyDshPath(), paths.dshHome); },
      markPrompted: async () => { await settings.update({ migration: { ...settings.get().migration, legacyDshPrompted: true } }); },
      retryAfterFailure: async () => {
        const retry = await dialog.showMessageBox({
          type: 'error', title: '导入失败', message: '旧 DSH 数据未导入。',
          detail: '源目录保持不变。可以立即重试，或稍后重新启动 ADHD One 再导入。',
          buttons: ['重试', '稍后'], defaultId: 0, cancelId: 1
        });
        return retry.response === 0;
      }
    });
  }
  if (smokeTest) await settings.setWorkspace(await mkdtemp(path.join(data, 'workspace-')));

  protocol.handle('adhd-one', async request => {
    const url = new URL(request.url);
    if (url.protocol !== 'adhd-one:' || url.hostname !== 'app' || url.port || url.username || url.password) return new Response('Not found', { status: 404 });
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z0-9._/-]+$/iu.test(relative) || relative.includes('..')) return new Response('Not found', { status: 404 });
    const filename = path.join(appPath, 'src', 'renderer', relative);
    const mime = relative.endsWith('.css') ? 'text/css; charset=utf-8' : relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    try { return new Response(await readFile(filename), { headers: { 'content-type': mime, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });

  const runtimes = path.join(local, 'runtimes');
  const runtime = new RuntimeController(settings, { appPath, resourcesPath: process.resourcesPath, packaged: app.isPackaged, dshHome: paths.dshHome, logs: paths.logs, runtimes });
  const updates = new UpdateManager({
    staging: path.join(local, 'staging'), runtimes: path.join(local, 'runtimes'),
    sevenZip: path.join(process.resourcesPath, 'tools', '7za.exe'),
    appPath, resourcesPath: process.resourcesPath, packaged: app.isPackaged
  }, app.getVersion(), 'https://api.github.com/repos/xydadada/adhd-one/releases', portable);
  let windows: WindowManager;
  const doctor = new ProviderDoctor(runtime, path.join(local, 'cache'), app.getVersion(), progress => windows?.controlWindow()?.webContents.send('doctor:progress', progress));
  windows = new WindowManager(runtime, appPath, 'adhd-one://app/index.html', settings, updates, { data, logs: paths.logs }, smokeTest);
  const quitState = createAppQuitState();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', event => event.preventDefault());
  windows.create();
  installSecureBridge({ runtime, settings, updates, doctor, windows, paths, quitState });
  updates.on('changed', value => windows.controlWindow()?.webContents.send('update:changed', value));

  const harnessSession = session.fromPartition('persist:adhd-one-harness');
  harnessSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => webContents === windows.harnessWindow()?.webContents
    && permission === 'notifications' && isExactOrigin(requestingOrigin, runtime.snapshot().url));
  harnessSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(webContents === windows.harnessWindow()?.webContents
    && permission === 'notifications' && isExactOrigin(details.requestingUrl, runtime.snapshot().url)));
  harnessSession.setDevicePermissionHandler(() => false);
  harnessSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  harnessSession.on('will-download', event => event.preventDefault());
  app.on('second-instance', () => windows.showControl());
  let quitReady = false;
  const quitCoordinator = createQuitCoordinator({
    runtime,
    windows,
    appExit: exitCode => {
      quitReady = true;
      app.exit(exitCode);
    },
    hardExit: exitCode => process.exit(exitCode)
  });
  emergencyQuit = exitCode => {
    quitState.beginQuit();
    return quitCoordinator.requestQuit(exitCode);
  };
  // app.exit() may emit "quit" before the OS process is gone; keep the bounded hard-exit fallback armed.
  app.on('before-quit', event => {
    quitState.beginQuit();
    if (quitReady) return;
    event.preventDefault();
    void quitCoordinator.requestQuit();
  });

  if (settings.get().workspace) {
    const snapshot = await runtime.start();
    if (smokeTest) {
      console.log(snapshot.state === 'ready' ? `SMOKE_OK ${snapshot.url}` : `SMOKE_FAILED ${snapshot.error?.code ?? 'RUNTIME_FAILED'}`);
      await windows.quit();
    }
  }
}

if (!hasSingleInstanceLock) {
  cleanupSmokeData();
  app.quit();
} else {
  app.whenReady().then(main).catch(() => {
    console.error('Application startup failed');
    if (emergencyQuit) void emergencyQuit(1);
    else { cleanupSmokeData(); app.exit(1); }
  });
}
