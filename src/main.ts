import { app, net, protocol, session } from 'electron';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeController } from './runtime-controller.js';
import { SettingsStore } from './settings-store.js';
import { UpdateManager } from './update-manager.js';
import { ProviderDoctor } from './provider-doctor.js';
import { WindowManager } from './window-manager.js';
import { installSecureBridge } from './secure-bridge.js';
import { isExactOrigin } from './security.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'adhd-one', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
app.enableSandbox(); app.setName('ADHD One');
app.setPath('userData', path.join(app.getPath('appData'), 'ADHD One'));

if (!app.requestSingleInstanceLock()) app.quit();

async function main(): Promise<void> {
  const appPath = app.getAppPath();
  const data = app.getPath('userData');
  const local = path.join(process.env.LOCALAPPDATA ?? path.dirname(data), 'ADHD One');
  const paths = { data, logs: path.join(local, 'logs'), dshHome: path.join(data, 'dsh-home') };
  const settings = new SettingsStore(path.join(data, 'settings.json'), path.join(app.getPath('appData'), 'Awesome DeepSeek Harness Desktop', 'settings.json'));
  await settings.load();
  if (process.argv.includes('--smoke-test') && !settings.get().workspace) await settings.setWorkspace(await mkdtemp(path.join(os.tmpdir(), 'adhd-one-smoke-')));

  protocol.handle('adhd-one', async request => {
    const url = new URL(request.url); const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z0-9._/-]+$/iu.test(relative) || relative.includes('..')) return new Response('Not found', { status: 404 });
    const filename = path.join(appPath, 'src', 'renderer', relative);
    const mime = relative.endsWith('.css') ? 'text/css; charset=utf-8' : relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    try { return new Response(await readFile(filename), { headers: { 'content-type': mime, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });

  const runtime = new RuntimeController(settings, { appPath, resourcesPath: process.resourcesPath, packaged: app.isPackaged, dshHome: paths.dshHome, logs: paths.logs });
  const updates = new UpdateManager({ staging: path.join(local, 'staging'), runtimes: path.join(local, 'runtimes'), sevenZip: path.join(process.resourcesPath, 'tools', '7za.exe') }, app.getVersion(), 'https://github.com/xydadada/adhd-one/releases/latest/download/runtime-manifest.json');
  let windows: WindowManager;
  const doctor = new ProviderDoctor(runtime, path.join(local, 'cache'), app.getVersion(), progress => windows?.controlWindow()?.webContents.send('doctor:progress', progress));
  windows = new WindowManager(runtime, appPath, 'adhd-one://app/index.html');
  windows.create();
  installSecureBridge({ runtime, settings, updates, doctor, windows, paths });
  updates.on('changed', value => windows.controlWindow()?.webContents.send('update:changed', value));

  const harnessSession = session.fromPartition('persist:adhd-one-harness');
  harnessSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => permission === 'notifications' && isExactOrigin(requestingOrigin, runtime.snapshot().url));
  harnessSession.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(permission === 'notifications' && isExactOrigin(details.requestingUrl, runtime.snapshot().url)));
  harnessSession.on('will-download', event => event.preventDefault());
  app.on('second-instance', () => windows.showControl());
  app.on('before-quit', () => { void runtime.stop(); });

  if (settings.get().workspace) {
    const snapshot = await runtime.start();
    if (process.argv.includes('--smoke-test')) { console.log(snapshot.state === 'ready' ? `SMOKE_OK ${snapshot.url}` : `SMOKE_FAILED ${snapshot.error?.message}`); await windows.quit(); }
  }
}

app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
