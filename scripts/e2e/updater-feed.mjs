import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(THIS_FILE), '..', '..');
const ELECTRON_CHILD_FLAG = '--updater-feed-e2e-child';
const OWNER = 'local-owner';
const REPOSITORY = 'local-repository';
const STABLE_TAG = 'v1.0.1';
const PREVIEW_TAG = 'v1.0.2-beta.2';
const WRONG_CHECKSUM_TAG = 'v1.0.3';
const STABLE_FILE = 'adhd-one-stable.exe';
const PREVIEW_FILE = 'adhd-one-preview.exe';
const WRONG_CHECKSUM_FILE = 'adhd-one-wrong-checksum.exe';
const NOOP_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {}
});

class HarnessFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'HarnessFailure';
    this.code = `UPDATER_FEED_E2E_${code}`;
  }
}

function fail(code) {
  throw new HarnessFailure(code);
}

function stableErrorCode(error) {
  if (typeof error?.code === 'string' && /^UPDATER_FEED_E2E_[A-Z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  if (error?.code === 'ERR_CHECKSUM_MISMATCH') {
    return 'UPDATER_FEED_E2E_UNEXPECTED_CHECKSUM_MISMATCH';
  }
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)) {
    return `UPDATER_FEED_E2E_${error.code}`;
  }
  return 'UPDATER_FEED_E2E_INTERNAL';
}

function writeOutcome(outcome) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`${outcome}\n`, error => error ? reject(error) : resolvePromise());
  });
}

function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

function yamlFor(version, fileName, checksum, size) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${checksum}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${checksum}`,
    'releaseDate: 2026-08-15T00:00:00.000Z',
    ''
  ].join('\n');
}

function atomEntry(port, tag, title) {
  const href = `http://127.0.0.1:${port}/${OWNER}/${REPOSITORY}/releases/tag/${tag}`;
  return `<entry><title>${title}</title><link href="${href}" /></entry>`;
}

function atomFeed(port) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed>',
    '<title>local updater feed</title>',
    atomEntry(port, PREVIEW_TAG, 'Preview release'),
    atomEntry(port, STABLE_TAG, 'Stable release'),
    atomEntry(port, WRONG_CHECKSUM_TAG, 'Wrong checksum test'),
    '</feed>'
  ].join('');
}

function sendResponse(response, statusCode, body, contentType) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    Connection: 'close'
  });
  response.end(payload);
}

async function startFeedServer(assets) {
  const state = {
    port: 0,
    requests: [],
    nonLoopbackConnection: false,
    handlerFailure: false,
    wrongChecksumMode: false,
    previewChannelMissed: false,
    previewFallbackServed: false,
    wrongChecksumServed: false
  };
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET') {
        sendResponse(response, 405, '', 'text/plain; charset=utf-8');
        return;
      }
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      state.requests.push(pathname);

      const base = `/${OWNER}/${REPOSITORY}/releases`;
      if (pathname === `${base}.atom`) {
        sendResponse(response, 200, atomFeed(state.port), 'application/atom+xml; charset=utf-8');
        return;
      }
      if (pathname === `/api/v3/repos/${OWNER}/${REPOSITORY}/releases/latest`) {
        const tag = state.wrongChecksumMode ? WRONG_CHECKSUM_TAG : STABLE_TAG;
        sendResponse(response, 200, JSON.stringify({ tag_name: tag }), 'application/json; charset=utf-8');
        return;
      }

      const stableMetadata = `${base}/download/${STABLE_TAG}/latest.yml`;
      const previewChannelMetadata = `${base}/download/${PREVIEW_TAG}/beta.yml`;
      const previewFallbackMetadata = `${base}/download/${PREVIEW_TAG}/latest.yml`;
      const wrongMetadata = `${base}/download/${WRONG_CHECKSUM_TAG}/latest.yml`;
      const stableArtifact = `${base}/download/${STABLE_TAG}/${STABLE_FILE}`;
      const previewArtifact = `${base}/download/${PREVIEW_TAG}/${PREVIEW_FILE}`;
      const wrongArtifact = `${base}/download/${WRONG_CHECKSUM_TAG}/${WRONG_CHECKSUM_FILE}`;

      if (pathname === stableMetadata && !state.wrongChecksumMode) {
        sendResponse(response, 200, yamlFor('1.0.1', STABLE_FILE, assets.stable.checksum, assets.stable.buffer.length), 'text/yaml; charset=utf-8');
        return;
      }
      if (pathname === previewChannelMetadata) {
        state.previewChannelMissed = true;
        sendResponse(response, 404, '', 'text/plain; charset=utf-8');
        return;
      }
      if (pathname === previewFallbackMetadata && !state.wrongChecksumMode) {
        state.previewFallbackServed = true;
        sendResponse(response, 200, yamlFor('1.0.2-beta.2', PREVIEW_FILE, assets.preview.checksum, assets.preview.buffer.length), 'text/yaml; charset=utf-8');
        return;
      }
      if (pathname === wrongMetadata && state.wrongChecksumMode) {
        state.wrongChecksumServed = true;
        sendResponse(response, 200, yamlFor('1.0.3', WRONG_CHECKSUM_FILE, assets.wrong.checksum, assets.wrong.buffer.length), 'text/yaml; charset=utf-8');
        return;
      }
      if (pathname === stableArtifact && !state.wrongChecksumMode) {
        sendResponse(response, 200, assets.stable.buffer, 'application/octet-stream');
        return;
      }
      if (pathname === previewArtifact && !state.wrongChecksumMode) {
        sendResponse(response, 200, assets.preview.buffer, 'application/octet-stream');
        return;
      }
      if (pathname === wrongArtifact && state.wrongChecksumMode) {
        sendResponse(response, 200, assets.wrong.buffer, 'application/octet-stream');
        return;
      }
      sendResponse(response, 404, '', 'text/plain; charset=utf-8');
    } catch {
      state.handlerFailure = true;
      if (!response.headersSent) sendResponse(response, 500, '', 'text/plain; charset=utf-8');
      else response.destroy();
    }
  });
  server.on('connection', socket => {
    if (socket.remoteAddress !== '127.0.0.1' && socket.remoteAddress !== '::ffff:127.0.0.1') {
      state.nonLoopbackConnection = true;
      socket.destroy();
    }
  });

  await new Promise((resolvePromise, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1' || address.port <= 0) {
    server.close();
    fail('LOOPBACK_BIND_FAILED');
  }
  state.port = address.port;

  return {
    port: state.port,
    state,
    close: async () => {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise(resolvePromise => server.close(() => resolvePromise()));
    }
  };
}

class HarnessAppAdapter {
  constructor(version, root, configPath) {
    this.version = version;
    this.root = root;
    this.configPath = configPath;
    this.quitHandlers = [];
  }

  get name() {
    return 'updater-feed-e2e';
  }

  get isPackaged() {
    return true;
  }

  get appUpdateConfigPath() {
    return this.configPath;
  }

  get userDataPath() {
    return join(this.root, 'user-data');
  }

  get baseCachePath() {
    return join(this.root, 'cache');
  }

  async whenReady() {}

  relaunch() {
    fail('INSTALL_ATTEMPTED');
  }

  quit() {
    fail('INSTALL_ATTEMPTED');
  }

  onQuit(handler) {
    this.quitHandlers.push(handler);
  }
}

function isChecksumMismatch(error) {
  return error?.code === 'ERR_CHECKSUM_MISMATCH'
    && typeof error?.message === 'string'
    && /checksum mismatch/iu.test(error.message);
}

async function makeUpdater(feed, scenarioRoot, version, allowPrerelease, channel) {
  const configPath = join(scenarioRoot, 'app-update.yml');
  await mkdir(join(scenarioRoot, 'user-data'), { recursive: true });
  await mkdir(join(scenarioRoot, 'cache'), { recursive: true });
  await writeFile(configPath, 'updaterCacheDirName: updater-feed-e2e-cache\n', 'utf8');

  const { NsisUpdater } = require('electron-updater');
  const { ElectronHttpExecutor } = require('../../node_modules/electron-updater/out/electronHttpExecutor.js');
  const app = new HarnessAppAdapter(version, scenarioRoot, configPath);
  const updater = new NsisUpdater(null, app);
  updater.httpExecutor = new ElectronHttpExecutor(() => {});
  updater.logger = NOOP_LOGGER;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  updater.disableDifferentialDownload = true;
  updater.allowPrerelease = allowPrerelease;
  updater.updateConfigPath = configPath;
  if (channel !== null) updater.channel = channel;
  updater.setFeedURL({
    provider: 'github',
    owner: OWNER,
    repo: REPOSITORY,
    host: `127.0.0.1:${feed.port}`,
    protocol: 'http',
    vPrefixedTagName: true
  });
  updater.quitAndInstall = () => fail('INSTALL_ATTEMPTED');
  updater.install = () => fail('INSTALL_ATTEMPTED');
  return updater;
}

async function runFeedScenario(feed, root, scenario) {
  const updater = await makeUpdater(
    feed,
    join(root, scenario.name),
    scenario.currentVersion,
    scenario.allowPrerelease,
    scenario.channel
  );
  const result = await updater.checkForUpdates();
  if (result === null || result.isUpdateAvailable !== true || result.downloadPromise !== null) {
    fail(`${scenario.name.toUpperCase()}_UPDATE_NOT_FOUND`);
  }
  const updateInfo = result.updateInfo;
  const provider = updater.updateInfoAndProvider?.provider;
  if (provider?.constructor?.name !== 'GitHubProvider') fail('NOT_GITHUB_PROVIDER');
  if (updateInfo?.version !== scenario.expectedVersion || updateInfo?.tag !== scenario.expectedTag) {
    fail(`${scenario.name.toUpperCase()}_METADATA_MISMATCH`);
  }
  const downloadedFiles = await updater.downloadUpdate();
  if (!Array.isArray(downloadedFiles) || downloadedFiles.length !== 1) {
    fail(`${scenario.name.toUpperCase()}_DOWNLOAD_RESULT_INVALID`);
  }
  const downloadedBuffer = await readFile(downloadedFiles[0]);
  if (!downloadedBuffer.equals(scenario.installerBuffer)) {
    fail(`${scenario.name.toUpperCase()}_DOWNLOAD_BYTES_INVALID`);
  }
}

async function runChecksumMismatchScenario(feed, root) {
  const updater = await makeUpdater(feed, join(root, 'checksum-mismatch'), '1.0.0', false, null);
  const result = await updater.checkForUpdates();
  if (result === null || result.isUpdateAvailable !== true) fail('CHECKSUM_FEED_NOT_FOUND');
  try {
    await updater.downloadUpdate();
  } catch (error) {
    if (!isChecksumMismatch(error)) fail('CHECKSUM_MISMATCH_NOT_REPORTED');
    return;
  }
  fail('CHECKSUM_MISMATCH_NOT_REPORTED');
}

async function runHarness(electronApp) {
  if (process.platform !== 'win32') fail('WINDOWS_ONLY');
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  process.env.NO_PROXY = '127.0.0.1,localhost';

  const { session } = require('electron');
  await session.fromPartition('electron-updater', { cache: false }).setProxy({ mode: 'direct' });

  const stableInstallerBuffer = Buffer.from('stable in-memory installer buffer\n', 'utf8');
  const previewInstallerBuffer = Buffer.from('preview in-memory installer buffer\n', 'utf8');
  const wrongInstallerBuffer = Buffer.from('wrong-checksum in-memory installer buffer\n', 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'adhd-one-updater-feed-'));
  let feed;
  try {
    feed = await startFeedServer({
      stable: { buffer: stableInstallerBuffer, checksum: sha512Base64(stableInstallerBuffer) },
      preview: { buffer: previewInstallerBuffer, checksum: sha512Base64(previewInstallerBuffer) },
      wrong: { buffer: wrongInstallerBuffer, checksum: sha512Base64(Buffer.from('not the wrong installer', 'utf8')) }
    });
    await runFeedScenario(feed, root, {
      name: 'stable',
      currentVersion: '1.0.0',
      allowPrerelease: false,
      channel: null,
      expectedVersion: '1.0.1',
      expectedTag: STABLE_TAG,
      installerBuffer: stableInstallerBuffer
    });
    await runFeedScenario(feed, root, {
      name: 'preview',
      currentVersion: '1.0.0-beta.1',
      allowPrerelease: true,
      channel: 'beta',
      expectedVersion: '1.0.2-beta.2',
      expectedTag: PREVIEW_TAG,
      installerBuffer: previewInstallerBuffer
    });
    feed.state.wrongChecksumMode = true;
    await runChecksumMismatchScenario(feed, root);

    if (feed.state.nonLoopbackConnection || feed.state.handlerFailure) fail('LOCAL_SERVER_CONTRACT_FAILED');
    if (!feed.state.requests.includes(`/${OWNER}/${REPOSITORY}/releases.atom`)) fail('ATOM_FEED_NOT_REQUESTED');
    if (!feed.state.requests.includes(`/api/v3/repos/${OWNER}/${REPOSITORY}/releases/latest`)) fail('LATEST_RELEASE_NOT_REQUESTED');
    if (!feed.state.requests.includes(`/${OWNER}/${REPOSITORY}/releases/download/${STABLE_TAG}/latest.yml`)) fail('STABLE_LATEST_YML_NOT_REQUESTED');
    if (!feed.state.requests.includes(`/${OWNER}/${REPOSITORY}/releases/download/${STABLE_TAG}/${STABLE_FILE}`)) fail('STABLE_ARTIFACT_NOT_REQUESTED');
    if (!feed.state.requests.includes(`/${OWNER}/${REPOSITORY}/releases/download/${PREVIEW_TAG}/${PREVIEW_FILE}`)) fail('PREVIEW_ARTIFACT_NOT_REQUESTED');
    if (!feed.state.requests.includes(`/${OWNER}/${REPOSITORY}/releases/download/${WRONG_CHECKSUM_TAG}/${WRONG_CHECKSUM_FILE}`)) fail('WRONG_CHECKSUM_ARTIFACT_NOT_REQUESTED');
    if (!feed.state.previewChannelMissed || !feed.state.previewFallbackServed) fail('PREVIEW_FALLBACK_NOT_USED');
    if (!feed.state.wrongChecksumServed) fail('WRONG_CHECKSUM_FEED_NOT_REQUESTED');
  } finally {
    if (feed) await feed.close();
    await rm(root, { recursive: true, force: true });
  }
  void electronApp;
}

async function runElectronChild() {
  let electronApp;
  let exitCode = 1;
  try {
    electronApp = require('electron').app;
    await electronApp.whenReady();
    await runHarness(electronApp);
    exitCode = 0;
    await writeOutcome('UPDATER_FEED_E2E_OK');
  } catch (error) {
    await writeOutcome(stableErrorCode(error));
  } finally {
    process.exitCode = exitCode;
    if (electronApp) electronApp.exit(exitCode);
  }
}

async function runNodeLauncher() {
  if (process.platform !== 'win32') {
    await writeOutcome('UPDATER_FEED_E2E_WINDOWS_ONLY');
    process.exitCode = 1;
    return;
  }
  const electronExecutable = join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const childEnvironment = { ...process.env };
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'ELECTRON_RUN_AS_NODE'
  ]) delete childEnvironment[name];
  childEnvironment.NO_PROXY = '127.0.0.1,localhost';

  let child;
  let stdout = '';
  let settled = false;
  let timer;
  const result = await new Promise(resolvePromise => {
    try {
      child = spawn(electronExecutable, [THIS_FILE, ELECTRON_CHILD_FLAG], {
        cwd: PROJECT_ROOT,
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (stdout.length < 4096) stdout += chunk;
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      child.once('error', () => finish({ code: null }));
      child.once('close', (code, signal) => finish({ code, signal }));
      timer = setTimeout(() => {
        child.kill();
        finish({ code: null, timeout: true });
      }, 120000);
    } catch {
      resolvePromise({ code: null });
    }
  });
  const childOutcome = stdout.split(/\r?\n/u).map(line => line.trim()).find(line => /^UPDATER_FEED_E2E_[A-Z0-9_]+$/u.test(line));
  if (result.code === 0 && childOutcome === 'UPDATER_FEED_E2E_OK') {
    await writeOutcome('UPDATER_FEED_E2E_OK');
    return;
  }
  await writeOutcome(childOutcome || 'UPDATER_FEED_E2E_ELECTRON_CHILD_FAILED');
  process.exitCode = 1;
}

const isEntryPoint = process.argv.some(argument => {
  try {
    return resolve(argument) === resolve(THIS_FILE);
  } catch {
    return false;
  }
}) || process.argv.includes(ELECTRON_CHILD_FLAG);

if (isEntryPoint) {
  if (process.versions.electron) {
    void runElectronChild().catch(async () => {
      await writeOutcome('UPDATER_FEED_E2E_INTERNAL');
      process.exitCode = 1;
    });
  } else {
    void runNodeLauncher().catch(async () => {
      await writeOutcome('UPDATER_FEED_E2E_INTERNAL');
      process.exitCode = 1;
    });
  }
}
