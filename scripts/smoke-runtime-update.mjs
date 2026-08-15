import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(root, 'vendor', 'dsh-runtime.7z');
const node = path.join(root, 'vendor', 'node', 'node.exe');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const runtimePackage = JSON.parse(await readFile(path.join(root, 'runtime', 'package.json'), 'utf8'));
const runtimeLock = JSON.parse(await readFile(path.join(root, 'runtime', 'package-lock.json'), 'utf8'));
const dshLock = runtimeLock.packages?.['node_modules/@deepseek-ai/dsh'];
if (!dshLock?.version || !dshLock.integrity || !runtimePackage.dependencies?.pnpm) throw new Error('RUNTIME_UPDATE_SMOKE_METADATA_MISSING');

const hash = createHash('sha256');
hash.update(await readFile(archive));
const archiveInfo = await stat(archive);
const { stdout: nodeVersionOutput } = await execFileAsync(node, ['--version'], { windowsHide: true });
const nodeVersion = String(nodeVersionOutput).trim().replace(/^v/u, '');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-runtime-update-'));

try {
  const { UpdateManager } = await import('../out/update-manager.js');
  const manager = new UpdateManager({
    staging: path.join(temporary, 'downloads'),
    runtimes: path.join(temporary, 'runtimes'),
    sevenZip,
    appPath: root,
    resourcesPath: root,
    packaged: false
  }, '0.2.0', 'https://api.github.com/repos/xydadada/adhd-one/releases', false, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => { throw new Error('RUNTIME_UPDATE_SMOKE_APP_INSTALL_FORBIDDEN'); }
  });
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    generatedAt: new Date().toISOString(),
    minAppVersion: '0.2.0',
    platform: 'win32',
    arch: 'x64',
    runtime: {
      version: dshLock.version,
      dshPackage: '@deepseek-ai/dsh',
      dshIntegrity: dshLock.integrity,
      nodeVersion,
      pnpmVersion: runtimePackage.dependencies.pnpm,
      protocolCompatibility: '^1'
    },
    asset: {
      name: 'dsh-runtime.7z',
      url: 'https://github.com/xydadada/adhd-one/releases/download/v0.2.0/dsh-runtime.7z',
      size: archiveInfo.size,
      sha256: hash.digest('hex')
    },
    source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness', npmPublishedAt: new Date().toISOString() },
    attestation: {
      repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml',
      ref: 'refs/tags/v0.2.0', subjectDigest: 'unused-by-direct-install-smoke'
    }
  };
  await manager.installVerifiedRuntime(archive, manifest);
  const state = JSON.parse(await readFile(path.join(temporary, 'runtimes', 'runtime-state.json'), 'utf8'));
  if (state.active !== 'A' || state.previous !== 'bundled' || state.version !== dshLock.version
    || state.healthy !== false || state.candidate !== true) throw new Error('RUNTIME_UPDATE_SMOKE_STATE_INVALID');
  console.log(`RUNTIME_UPDATE_SMOKE_OK slot=${state.active} version=${state.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// electron-updater's transitive Electron adapter may retain a process handle
// when this integration smoke runs under plain Node. All child processes and
// the isolated temp tree are already closed above, so finish deterministically.
process.exit(0);
