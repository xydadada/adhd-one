import { app, dialog, protocol, session } from 'electron';
import { mkdtemp, readFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeController } from './runtime-controller.js';
import { SettingsStore } from './settings-store.js';
import { UpdateManager } from './update-manager.js';
import { ProviderDoctor } from './provider-doctor.js';
import { WindowManager } from './window-manager.js';
import { installSecureBridge } from './secure-bridge.js';
import { isExactOrigin } from './security.js';
import { copyLegacyDsh, detectLegacyDsh, getLegacyDshPath } from './data-migration.js';
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

async function main(): Promise<void> {
  if (portableDataError) {
    const result = await dialog.showMessageBox({ type: 'error', title: 'Portable 数据目录不可写', message: 'ADHD One 无法在当前目录创建 portable-data。', detail: '请将 ZIP 解压到可写目录后重试。应用不会静默改用 AppData。', buttons: ['退出'] });
    void result; app.exit(1); return;
  }
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
  await settings.load();
  if (!smokeTest && !settings.get().migration.legacyDshPrompted && !existsSync(paths.dshHome) && await detectLegacyDsh()) {
    const answer = await dialog.showMessageBox({ type: 'question', title: '导入现有 DeepSeek Harness 数据', message: '检测到原来的 .dsh 数据。是否复制导入到 ADHD One？', detail: '源目录不会被修改或删除。复制会先在同一磁盘暂存并校验，再原子切换。', buttons: ['复制导入', '暂不导入'], defaultId: 0, cancelId: 1 });
    await settings.update({ migration: { ...settings.get().migration, legacyDshPrompted: true } });
    if (answer.response === 0) {
      try { await copyLegacyDsh(getLegacyDshPath(), paths.dshHome); }
      catch { await dialog.showMessageBox({ type: 'error', title: '导入失败', message: '旧 DSH 数据未导入。', detail: '源目录保持不变；可查看日志后重试。' }); }
    }
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
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', event => event.preventDefault());
  windows.create();
  installSecureBridge({ runtime, settings, updates, doctor, windows, paths });
  updates.on('changed', value => windows.controlWindow()?.webContents.send('update:changed', value));

  const harnessSession = session.fromPartition('persist:adhd-one-harness');
  harnessSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => permission === 'notifications' && isExactOrigin(requestingOrigin, runtime.snapshot().url));
  harnessSession.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(permission === 'notifications' && isExactOrigin(details.requestingUrl, runtime.snapshot().url)));
  harnessSession.on('will-download', event => event.preventDefault());
  app.on('second-instance', () => windows.showControl());
  let quitReady = false;
  let quitInFlight: Promise<void> | undefined;
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    windows.prepareToQuit();
    quitInFlight ??= Promise.race([
      runtime.stop().then(() => 0),
      new Promise<number>(resolve => setTimeout(() => resolve(1), 5_000))
    ])
      .catch(() => 1)
      .then(exitCode => {
        if (exitCode !== 0) {
          console.error('RUNTIME_SHUTDOWN_FAILED');
          runtime.forceShutdown();
        }
        windows.destroyForQuit();
        quitReady = true;
        app.exit(exitCode);
      });
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
  app.whenReady().then(main).catch(() => { cleanupSmokeData(); console.error('Application startup failed'); app.exit(1); });
}
