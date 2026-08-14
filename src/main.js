import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DSH_VERSION, getDshArgs, getDshEntry, getFreePort, getNodeRuntime, waitForServer } from './runtime.js';

const APP_NAME = 'Awesome DeepSeek Harness Desktop';
const PROJECT_URL = 'https://github.com/xydadada/awesome-deepseek-harness-desktop';
const OFFICIAL_URL = 'https://github.com/deepseek-ai/deepseek-harness';

let mainWindow;
let dshProcess;
let dshUrl;
let isQuitting = false;
let startupLog = [];
const isSmokeTest = process.argv.includes('--smoke-test');
const smokeResultArg = process.argv.find((argument) => argument.startsWith('--smoke-result='));
const smokeResultPath = smokeResultArg?.slice('--smoke-result='.length);

function writeSmokeResult(result) {
  if (!smokeResultPath) return;
  fs.writeFileSync(smokeResultPath, `${result}\n`, 'utf8');
}

async function finishSmoke(result, exitCode) {
  if (exitCode === 0) console.log(result);
  else console.error(result);
  writeSmokeResult(result);
  isQuitting = true;
  await stopDsh();
  app.exit(exitCode);
}

app.setName(APP_NAME);

function appendLog(message) {
  const line = String(message).trimEnd();
  if (!line) return;
  startupLog.push(line);
  startupLog = startupLog.slice(-150);
  mainWindow?.webContents.send('runtime:status', { message: line, log: startupLog.join('\n') });
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function currentWorkspace() {
  const configured = readSettings().workspace;
  return configured && fs.existsSync(configured) ? configured : app.getPath('documents');
}

async function stopDsh() {
  const child = dshProcess;
  dshProcess = undefined;
  dshUrl = undefined;
  if (!child || child.killed) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    child.kill('SIGTERM');
  }
}

async function runProcess(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => appendLog(chunk));
    child.stderr.on('data', (chunk) => appendLog(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with code ${code}`)));
  });
}

async function ensureDshRuntime() {
  const runtimes = path.join(app.getPath('userData'), 'runtimes');
  const target = path.join(runtimes, `dsh-${DSH_VERSION}`);
  const marker = path.join(target, '.ready');
  const entry = getDshEntry(target);
  if (fs.existsSync(marker) && fs.existsSync(entry)) return target;

  const archive = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-runtime.7z')
    : path.join(app.getAppPath(), 'vendor', 'dsh-runtime.7z');
  const sevenZip = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', '7za.exe')
    : path.join(app.getAppPath(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(archive) || !fs.existsSync(sevenZip)) throw new Error('The bundled DSH runtime archive is incomplete.');

  const staging = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(runtimes, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  appendLog(`Preparing DeepSeek Harness ${DSH_VERSION} for first use…`);
  try {
    await runProcess(sevenZip, ['x', archive, `-o${staging}`, '-y', '-bsp1'], runtimes);
    if (!fs.existsSync(getDshEntry(staging))) throw new Error('The extracted DSH runtime is incomplete.');
    fs.writeFileSync(path.join(staging, '.ready'), `${DSH_VERSION}\n`, 'utf8');
    fs.renameSync(staging, target);
    return target;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function startDsh() {
  await stopDsh();
  startupLog = [];

  const port = await getFreePort();
  const runtimeRoot = await ensureDshRuntime();
  const entry = getDshEntry(runtimeRoot);

  if (!fs.existsSync(entry)) {
    throw new Error(`Bundled dsh entry was not found: ${entry}`);
  }
  const nodeRuntime = getNodeRuntime({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged
  });
  if (!fs.existsSync(nodeRuntime)) {
    throw new Error(`Bundled Node.js runtime was not found: ${nodeRuntime}`);
  }

  const workspace = currentWorkspace();
  appendLog(`Starting DeepSeek Harness ${DSH_VERSION}`);
  appendLog(`Workspace: ${workspace}`);

  const child = spawn(nodeRuntime, [entry, ...getDshArgs(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_DESKTOP: '1',
      NO_COLOR: '1'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  dshProcess = child;

  child.stdout.on('data', (chunk) => appendLog(chunk));
  child.stderr.on('data', (chunk) => appendLog(chunk));
  child.once('error', (error) => appendLog(`Runtime error: ${error.message}`));
  child.once('exit', (code, signal) => {
    if (dshProcess !== child) return;
    dshProcess = undefined;
    dshUrl = undefined;
    appendLog(`DeepSeek Harness stopped (${signal ?? code ?? 'unknown'}).`);
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) showStartup('stopped');
  });

  dshUrl = `http://127.0.0.1:${port}`;
  await waitForServer(dshUrl, app.isPackaged ? 180_000 : 90_000);
  return dshUrl;
}

function installNavigationGuards(window) {
  const isLocalHarnessUrl = (candidate) => {
    if (!dshUrl) return false;
    try {
      return new URL(candidate).origin === new URL(dshUrl).origin;
    } catch {
      return false;
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalHarnessUrl(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || isLocalHarnessUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#070a12',
    title: APP_NAME,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(mainWindow);
  mainWindow.once('ready-to-show', () => { if (!isSmokeTest) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

async function showStartup(reason = 'starting') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(app.getAppPath(), 'src', 'startup.html'), { query: { reason } });
  mainWindow.webContents.send('runtime:status', {
    message: reason === 'starting' ? 'Preparing the local runtime…' : 'The runtime is not running.',
    log: startupLog.join('\n')
  });
}

async function boot() {
  await showStartup('starting');
  try {
    const url = await startDsh();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(url);
      if (isSmokeTest) {
        await finishSmoke(`SMOKE_OK ${url} ${mainWindow.webContents.getTitle()}`, 0);
      }
    }
  } catch (error) {
    appendLog(error.stack ?? error.message);
    if (isSmokeTest) {
      await finishSmoke(`SMOKE_FAILED ${error.stack ?? error.message}\n\nRuntime log:\n${startupLog.join('\n')}`, 1);
      return;
    }
    await showStartup('failed');
  }
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the workspace used by DeepSeek Harness',
    defaultPath: currentWorkspace(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return;
  writeSettings({ ...readSettings(), workspace: result.filePaths[0] });
  await boot();
}

function buildMenu() {
  const template = [
    {
      label: 'Harness',
      submenu: [
        { label: 'Restart Harness', accelerator: 'CmdOrCtrl+Shift+R', click: () => void boot() },
        { label: 'Choose Workspace…', click: () => void chooseWorkspace() },
        { label: 'Open DSH Data Folder', click: () => void shell.openPath(path.join(app.getPath('home'), '.dsh')) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'ADHD on GitHub', click: () => void shell.openExternal(PROJECT_URL) },
        { label: 'Official DeepSeek Harness', click: () => void shell.openExternal(OFFICIAL_URL) },
        { type: 'separator' },
        {
          label: 'About',
          click: () => void dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `About ${APP_NAME}`,
            message: `${APP_NAME} ${app.getVersion()}`,
            detail: `Unofficial Electron desktop shell\nBundled DeepSeek Harness: ${DSH_VERSION}\n\nNot affiliated with or endorsed by DeepSeek.`
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('runtime:retry', () => boot());
ipcMain.handle('runtime:choose-workspace', () => chooseWorkspace());
ipcMain.handle('runtime:details', () => ({ log: startupLog.join('\n'), workspace: currentWorkspace() }));

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    buildMenu();
    void boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      void boot();
    }
  });
}

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void stopDsh().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
