import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updaterMock, fetchMock, sigstoreVerifyMock } = vi.hoisted(() => ({
  updaterMock: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  },
  fetchMock: vi.fn(),
  sigstoreVerifyMock: vi.fn()
}));

vi.mock('electron-updater', () => ({ default: { autoUpdater: updaterMock } }));
vi.mock('sigstore', () => ({ verify: sigstoreVerifyMock }));

import { UpdateManager } from '../src/update-manager.js';
import { DSH_VERSION } from '../src/types.js';

const appVersion = '0.2.0';
const updateVersion = '0.3.0';
const issuer = 'https://token.actions.githubusercontent.com';
const identity = 'https://github.com/xydadada/adhd-one/.github/workflows/release.yml@refs/tags/v0.3.0';

let temporaryDirectories: string[] = [];

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeManager(root: string, portable = false): UpdateManager {
  return new UpdateManager({
    staging: path.join(root, 'staging'),
    runtimes: path.join(root, 'runtimes'),
    sevenZip: path.join(root, '7z.exe')
  }, appVersion, 'https://github.com/xydadada/adhd-one/releases/download/v0.3.0/runtime-manifest.json', portable);
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-app-update-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeAppAvailable(manager: UpdateManager): Promise<void> {
  updaterMock.checkForUpdates.mockResolvedValue({ updateInfo: {
    version: updateVersion,
    tag: `v${updateVersion}`,
    files: [{ url: `ADHD-One-Setup-${updateVersion}-x64.exe`, sha512: 'sha512' }]
  } });
  await expect(manager.check('app', 'stable')).resolves.toMatchObject({ phase: 'available', candidateVersion: updateVersion, canConfirm: true, canInstall: false, rollback: false });
}

function mockSuccessfulAttestation(assetName: string, contents: Buffer, predicateType = 'https://in-toto.io/attestation/release/v0.1'): void {
  const digest = createHash('sha256').update(contents).digest('hex');
  sigstoreVerifyMock.mockResolvedValue({
    identity: { extensions: { issuer }, subjectAlternativeName: identity }
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    attestations: [{
        bundle: {
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: Buffer.from(JSON.stringify({
              _type: 'https://in-toto.io/Statement/v1',
              predicateType,
              subject: [{ name: assetName, digest: { sha256: digest } }]
            })).toString('base64')
          }
        }
      }]
  }), { status: 200 }));
}

function runtimeManifest(version: string): Record<string, unknown> {
  const digest = '0'.repeat(64);
  return {
    schemaVersion: 1, channel: 'stable', generatedAt: '2026-08-14T00:00:00.000Z', minAppVersion: appVersion, platform: 'win32', arch: 'x64',
    runtime: { version, dshPackage: '@deepseek-ai/dsh', dshIntegrity: 'sha512-test', nodeVersion: '20.0.0', pnpmVersion: '9.0.0', protocolCompatibility: '1' },
    asset: { name: 'runtime.zip', url: `https://github.com/xydadada/adhd-one/releases/download/v${version}/runtime.zip`, size: 1, sha256: digest },
    source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness', npmPublishedAt: '2026-08-14T00:00:00.000Z' },
    attestation: { repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml', ref: `refs/tags/v${version}`, subjectDigest: `sha256:${digest}` }
  };
}

function mockRuntimeManifest(manifest: Record<string, unknown>): void {
  const body = JSON.stringify(manifest);
  fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } }));
}

beforeEach(() => {
  updaterMock.autoDownload = true;
  updaterMock.autoInstallOnAppQuit = true;
  updaterMock.allowPrerelease = true;
  updaterMock.checkForUpdates.mockReset();
  updaterMock.downloadUpdate.mockReset();
  updaterMock.quitAndInstall.mockReset();
  fetchMock.mockReset();
  sigstoreVerifyMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const directories = temporaryDirectories;
  temporaryDirectories = [];
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
});

describe('app updater P0 gates', () => {
  it('starts with canonical V2 snapshots and all permissions disabled', async () => {
    const root = await makeTemporaryDirectory();
    const manager = makeManager(root);

    expect(manager.snapshot('app')).toEqual({
      target: 'app', channel: 'stable', phase: 'idle', currentVersion: appVersion,
      canConfirm: false, canInstall: false, rollback: false
    });
    expect(manager.snapshot('runtime')).toEqual({
      target: 'runtime', channel: 'stable', phase: 'idle', currentVersion: DSH_VERSION,
      canConfirm: false, canInstall: false, rollback: false
    });
  });

  it('refreshes runtime currentVersion and keeps a pending rollback on an idle check', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'runtimes'), { recursive: true });
    await writeFile(path.join(root, 'runtimes', 'runtime-state.json'), JSON.stringify({ schemaVersion: 1, active: 'A', previous: 'bundled', version: '0.2.0', healthy: false }));
    mockRuntimeManifest(runtimeManifest('0.0.9'));
    const manager = makeManager(root);

    await expect(manager.check('runtime', 'stable')).resolves.toMatchObject({
      phase: 'idle', currentVersion: DSH_VERSION, canConfirm: false, canInstall: false, rollback: true
    });
  });

  it('refreshes a healthy runtime version and clears rollback', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'runtimes'), { recursive: true });
    await writeFile(path.join(root, 'runtimes', 'runtime-state.json'), JSON.stringify({ schemaVersion: 1, active: 'A', previous: 'bundled', version: '0.2.0', healthy: true }));
    mockRuntimeManifest(runtimeManifest(updateVersion));
    const manager = makeManager(root);

    await expect(manager.check('runtime', 'stable')).resolves.toMatchObject({
      phase: 'available', currentVersion: '0.2.0', candidateVersion: updateVersion, canConfirm: true, canInstall: false, rollback: false
    });
  });

  it('clears a stale verified state after a candidate becomes stable', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'runtimes'), { recursive: true });
    await writeFile(path.join(root, 'runtimes', 'runtime-state.json'), JSON.stringify({
      schemaVersion: 1, active: 'A', previous: 'bundled', version: '0.2.0', healthy: true, candidate: false
    }));
    const manager = makeManager(root);
    (manager as unknown as { set(target: string, patch: Record<string, unknown>): void }).set('runtime', {
      phase: 'verified', candidateVersion: '0.2.0', rollback: true
    });

    await expect(manager.refreshRuntimeStatus()).resolves.toMatchObject({
      phase: 'idle', currentVersion: '0.2.0', rollback: false, canConfirm: false, canInstall: false
    });
    expect(manager.snapshot('runtime')).not.toHaveProperty('candidateVersion');
  });

  it('constructs with automatic download and install-on-quit disabled', async () => {
    const root = await makeTemporaryDirectory();

    makeManager(root);

    expect(updaterMock.autoDownload).toBe(false);
    expect(updaterMock.autoInstallOnAppQuit).toBe(false);
  });

  it.each([
    ['stable', false],
    ['preview', true]
  ] as const)('maps the %s channel to electron-updater prerelease policy', async (channel, prerelease) => {
    const root = await makeTemporaryDirectory();
    const manager = makeManager(root);
    updaterMock.checkForUpdates.mockResolvedValue(null);

    await manager.check('app', channel);

    expect(updaterMock.allowPrerelease).toBe(prerelease);
  });

  it('never downloads an app update from a portable build', async () => {
    const root = await makeTemporaryDirectory();
    const manager = makeManager(root, true);
    await makeAppAvailable(manager);

    await expect(manager.confirm('app')).rejects.toThrow('PORTABLE_UPDATE_DOWNLOAD_ONLY');
    expect(updaterMock.downloadUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the wrong tag', { tag: 'v9.9.9', files: [{ url: `ADHD-One-Setup-${updateVersion}-x64.exe`, sha512: 'sha512' }] }],
    ['an unexpected asset', { tag: `v${updateVersion}`, files: [{ url: `ADHD-One-Setup-${updateVersion}-arm64.exe`, sha512: 'sha512' }] }],
    ['more than one asset', { tag: `v${updateVersion}`, files: [
      { url: `ADHD-One-Setup-${updateVersion}-x64.exe`, sha512: 'sha512' },
      { url: 'unexpected.exe', sha512: 'sha512' }
    ] }]
  ])('fails closed before download when update metadata contains %s', async (_label, metadata) => {
    const root = await makeTemporaryDirectory();
    const manager = makeManager(root);
    updaterMock.checkForUpdates.mockResolvedValue({ updateInfo: { version: updateVersion, ...metadata } });

    await expect(manager.check('app', 'stable')).resolves.toMatchObject({ phase: 'failed', canConfirm: false, canInstall: false, rollback: false });
    await expect(manager.confirm('app')).rejects.toThrow('UPDATE_NOT_AVAILABLE');
    expect(updaterMock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('rejects quitAndInstall until the installer update is verified', async () => {
    const root = await makeTemporaryDirectory();
    const manager = makeManager(root);

    expect(() => manager.quitAndInstall()).toThrow('APP_UPDATE_NOT_VERIFIED');
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('fails before hashing or attesting an update with the wrong asset name', async () => {
    const root = await makeTemporaryDirectory();
    const filename = path.join(root, 'ADHD-One-Setup-0.3.0-arm64.exe');
    await writeFile(filename, 'not-the-x64-installer');
    const manager = makeManager(root);
    await makeAppAvailable(manager);
    updaterMock.downloadUpdate.mockResolvedValue([filename]);

    await expect(manager.confirm('app')).rejects.toThrow('UPDATE_ASSET_NAME_MISMATCH');
    expect(manager.snapshot('app')).toMatchObject({ phase: 'failed', canConfirm: false, canInstall: false, rollback: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sigstoreVerifyMock).not.toHaveBeenCalled();
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('calls quitAndInstall(false, true) only after successful attestation verification', async () => {
    const root = await makeTemporaryDirectory();
    const contents = Buffer.from('verified-installer');
    const filename = path.join(root, `ADHD-One-Setup-${updateVersion}-x64.exe`);
    await writeFile(filename, contents);
    const manager = makeManager(root);
    await makeAppAvailable(manager);
    updaterMock.downloadUpdate.mockResolvedValue([filename]);
    mockSuccessfulAttestation(path.basename(filename), contents);

    await manager.confirm('app');

    expect(manager.snapshot('app')).toMatchObject({ phase: 'verified', candidateVersion: updateVersion, canConfirm: false, canInstall: true, rollback: false });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/attestations/sha256:'),
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/vnd.github+json' }) })
    );
    expect(sigstoreVerifyMock).toHaveBeenCalledTimes(1);
    expect(() => manager.quitAndInstall()).not.toThrow();
    expect(updaterMock.quitAndInstall).toHaveBeenCalledOnce();
    expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('blocks a concurrent recheck and does not carry verification into the next candidate', async () => {
    const root = await makeTemporaryDirectory();
    const contents = Buffer.from('older-installer');
    const filename = path.join(root, `ADHD-One-Setup-${updateVersion}-x64.exe`);
    await writeFile(filename, contents);
    const manager = makeManager(root);
    await makeAppAvailable(manager);
    mockSuccessfulAttestation(path.basename(filename), contents);
    const download = deferredPromise<string[]>();
    updaterMock.downloadUpdate.mockReturnValue(download.promise);

    const olderConfirmation = manager.confirm('app');
    expect(updaterMock.downloadUpdate).toHaveBeenCalledOnce();
    expect(manager.snapshot('app')).toMatchObject({ phase: 'downloading', candidateVersion: updateVersion, canInstall: false });

    const newerVersion = '0.4.0';
    updaterMock.checkForUpdates.mockResolvedValue({ updateInfo: {
      version: newerVersion,
      tag: `v${newerVersion}`,
      files: [{ url: `ADHD-One-Setup-${newerVersion}-x64.exe`, sha512: 'sha512' }]
    } });
    await expect(manager.check('app', 'stable')).rejects.toThrow('UPDATE_CONFIRM_IN_PROGRESS');
    expect(manager.snapshot('app')).toMatchObject({ phase: 'downloading', candidateVersion: updateVersion, canInstall: false });
    expect(() => manager.quitAndInstall()).toThrow('APP_UPDATE_NOT_VERIFIED');

    download.resolve([filename]);
    await expect(olderConfirmation).resolves.toBeUndefined();
    expect(manager.snapshot('app')).toMatchObject({ phase: 'verified', candidateVersion: updateVersion, canInstall: true });

    await expect(manager.check('app', 'stable')).resolves.toMatchObject({
      phase: 'available', candidateVersion: newerVersion, canConfirm: true, canInstall: false
    });
    expect(manager.snapshot('app')).not.toHaveProperty('error');
    expect(() => manager.quitAndInstall()).toThrow('APP_UPDATE_NOT_VERIFIED');
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('fails closed before Sigstore verification when the attestation response is oversized', async () => {
    const root = await makeTemporaryDirectory();
    const contents = Buffer.from('verified-installer');
    const filename = path.join(root, `ADHD-One-Setup-${updateVersion}-x64.exe`);
    await writeFile(filename, contents);
    const manager = makeManager(root);
    await makeAppAvailable(manager);
    updaterMock.downloadUpdate.mockResolvedValue([filename]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }), { status: 200 }));

    await expect(manager.confirm('app')).rejects.toThrow('MANIFEST_TOO_LARGE');
    expect(manager.snapshot('app')).toMatchObject({ phase: 'failed', canInstall: false });
    expect(sigstoreVerifyMock).not.toHaveBeenCalled();
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('fails closed when a valid signature carries the wrong attestation predicate', async () => {
    const root = await makeTemporaryDirectory();
    const contents = Buffer.from('verified-installer');
    const filename = path.join(root, `ADHD-One-Setup-${updateVersion}-x64.exe`);
    await writeFile(filename, contents);
    const manager = makeManager(root);
    await makeAppAvailable(manager);
    updaterMock.downloadUpdate.mockResolvedValue([filename]);
    mockSuccessfulAttestation(path.basename(filename), contents, 'https://slsa.dev/provenance/v1');

    await expect(manager.confirm('app')).rejects.toThrow('ATTESTATION_NOT_FOUND');
    expect(manager.snapshot('app')).toMatchObject({ phase: 'failed', canInstall: false });
    expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
  });
});
