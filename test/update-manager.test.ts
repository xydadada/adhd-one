import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  updaterMock,
  fetchMock,
  execFileMock,
  execFileAsyncMock,
  parseSevenZipSltMock,
  scanExtractedTreeNoReparseMock,
  preflightRuntimeClosureMock,
  ntExecutableFromMock,
  runRuntimeStagingSmokeMock
} = vi.hoisted(() => {
  const execFileAsyncMock = vi.fn();
  const execFileMock = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  });
  return {
    updaterMock: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn()
    },
    fetchMock: vi.fn(),
    execFileMock,
    execFileAsyncMock,
    parseSevenZipSltMock: vi.fn(),
    scanExtractedTreeNoReparseMock: vi.fn(),
    preflightRuntimeClosureMock: vi.fn(),
    ntExecutableFromMock: vi.fn(),
    runRuntimeStagingSmokeMock: vi.fn()
  };
});

vi.mock('electron-updater', () => ({ default: { autoUpdater: updaterMock } }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('../src/archive-inspection.js', () => ({
  parseSevenZipSlt: parseSevenZipSltMock,
  scanExtractedTreeNoReparse: scanExtractedTreeNoReparseMock
}));
vi.mock('../src/runtime-closure-inspector.js', () => ({ preflightRuntimeClosure: preflightRuntimeClosureMock }));
vi.mock('pe-library', () => ({ NtExecutable: { from: ntExecutableFromMock } }));
vi.mock('../src/runtime-staging-smoke.js', () => ({ runRuntimeStagingSmoke: runRuntimeStagingSmokeMock }));

import { UpdateManager, isRuntimeUpgrade, parseRuntimeManifest, runtimeValidationEnvironment, selectRuntimeInstallSlots } from '../src/update-manager.js';
import {
  createRuntimeCommitJournal,
  writeRuntimeCommitJournal
} from '../src/runtime-commit-journal.js';

const manifest = { schemaVersion: 1, channel: 'stable', generatedAt: '2026-08-14T00:00:00.000Z', minAppVersion: '0.2.0', platform: 'win32', arch: 'x64', runtime: { version: '0.1.0', dshPackage: '@deepseek-ai/dsh', dshIntegrity: 'sha512-x', nodeVersion: '24.18.0', pnpmVersion: '11.21.0', protocolCompatibility: '^1' }, asset: { name: 'runtime.7z', url: 'https://github.com/xydadada/adhd-one/releases/download/v0.2.0/runtime.7z', size: 10, sha256: 'a'.repeat(64) }, source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness', npmPublishedAt: '2026-08-14' }, attestation: { repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml', ref: 'refs/tags/v0.2.0', subjectDigest: `sha256:${'a'.repeat(64)}` } } as const;

const temporaryDirectories: string[] = [];

async function fileExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-update-manager-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(directory => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50
  })));
});
describe('runtime manifest', () => {
  it('accepts a pinned stable GitHub asset', () => expect(parseRuntimeManifest(manifest, 'stable').runtime.version).toBe('0.1.0'));
  it('rejects channel and digest confusion', () => { expect(() => parseRuntimeManifest({ ...manifest, channel: 'preview' }, 'stable')).toThrow(); expect(() => parseRuntimeManifest({ ...manifest, attestation: { ...manifest.attestation, subjectDigest: 'sha256:bad' } }, 'stable')).toThrow(); });
  it('rejects untrusted asset hosts', () => expect(() => parseRuntimeManifest({ ...manifest, asset: { ...manifest.asset, url: 'https://evil.test/runtime.7z' } }, 'stable')).toThrow());
  it('enforces minimum app version and exact release identity', () => {
    expect(() => parseRuntimeManifest(manifest, 'stable', '0.1.9')).toThrow('APP_VERSION_TOO_OLD');
    expect(() => parseRuntimeManifest({ ...manifest, attestation: { ...manifest.attestation, workflow: 'release.yml' } }, 'stable')).toThrow('ATTESTATION_IDENTITY_INVALID');
    expect(() => parseRuntimeManifest({ ...manifest, attestation: { ...manifest.attestation, ref: 'refs/tags/v0.2.1' } }, 'stable')).toThrow('RUNTIME_RELEASE_IDENTITY_MISMATCH');
  });
  it('rejects prereleases on stable without substring guesses', () => {
    expect(() => parseRuntimeManifest({ ...manifest, runtime: { ...manifest.runtime, version: '0.2.0-rc.1' } }, 'stable')).toThrow('PRERELEASE_ON_STABLE');
  });
  it('rejects invalid or incompatible DSH RPC protocol ranges', () => {
    expect(() => parseRuntimeManifest({ ...manifest, runtime: { ...manifest.runtime, protocolCompatibility: 'not-a-range' } }, 'stable')).toThrow('DSH_PROTOCOL_INCOMPATIBLE');
    expect(() => parseRuntimeManifest({ ...manifest, runtime: { ...manifest.runtime, protocolCompatibility: '^2' } }, 'stable')).toThrow('DSH_PROTOCOL_INCOMPATIBLE');
    expect(parseRuntimeManifest({ ...manifest, runtime: { ...manifest.runtime, protocolCompatibility: '^1' } }, 'stable').runtime.protocolCompatibility).toBe('^1');
  });
  it('permits only upgrades and preserves the last healthy rollback slot', () => {
    expect(isRuntimeUpgrade('0.2.0', '0.1.0')).toBe(true);
    expect(isRuntimeUpgrade('0.1.0', '0.1.0')).toBe(false);
    expect(isRuntimeUpgrade('0.0.9', '0.1.0')).toBe(false);
    expect(selectRuntimeInstallSlots({ active: 'A', healthy: true })).toEqual({ slot: 'B', previous: 'A' });
    expect(selectRuntimeInstallSlots({ active: 'A', previous: 'B', healthy: false })).toEqual({ slot: 'A', previous: 'B' });
    expect(selectRuntimeInstallSlots({ active: 'A', previous: 'B', healthy: true, candidate: true })).toEqual({ slot: 'A', previous: 'B' });
    expect(selectRuntimeInstallSlots({ active: 'bundled', previous: 'B', healthy: true })).toEqual({ slot: 'A', previous: 'bundled' });
  });
});

describe('runtime validation environment', () => {
  it('does not inherit provider credentials, proxy settings, or Node injection hooks', () => {
    const previous = {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NODE_OPTIONS: process.env.NODE_OPTIONS
    };
    process.env.DEEPSEEK_API_KEY = 'secret';
    process.env.HTTPS_PROXY = 'https://proxy.invalid';
    process.env.NODE_OPTIONS = '--require C:\\secret\\hook.js';
    try {
      const environment = runtimeValidationEnvironment('C:\\runtime\\node.exe', 'C:\\validation-home');
      expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
      expect(environment.HTTPS_PROXY).toBeUndefined();
      expect(environment.NODE_OPTIONS).toBeUndefined();
      expect(environment.DSH_HOME).toBe('C:\\validation-home');
      expect(environment.PATH).toContain('C:\\runtime');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe('runtime journal wiring', () => {
  it('recovers an existing journal before reading runtime status', async () => {
    const root = await makeTemporaryDirectory();
    const runtimes = path.join(root, 'runtimes');
    const stagingRoot = path.join(runtimes, '.staging-recovery');
    const staging = path.join(stagingRoot, 'slot-B');
    const stateFile = path.join(runtimes, 'runtime-state.json');
    const journalFile = path.join(runtimes, '.runtime-commit-journal.json');
    await mkdir(path.join(runtimes, 'slot-A'), { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(runtimes, 'slot-A', 'old.txt'), 'old');
    await writeFile(path.join(staging, 'new.txt'), 'new');
    const beforeState = { schemaVersion: 1, active: 'A', previous: 'bundled', version: '0.1.0', healthy: true };
    const afterState = { schemaVersion: 1, active: 'B', previous: 'A', version: '0.1.1', healthy: false };
    await writeFile(stateFile, `${JSON.stringify(beforeState)}\n`);
    const journal = createRuntimeCommitJournal({
      txid: '0123456789abcdef',
      slot: 'B',
      stagingRoot: '.staging-recovery',
      staging: '.staging-recovery/slot-B',
      destination: 'slot-B',
      backup: '.rollback-recovery',
      beforeState,
      afterState,
      destinationWasPresent: false
    });
    await writeRuntimeCommitJournal(journalFile, journal);

    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async () => {
      expect(await fileExists(journalFile)).toBe(false);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(afterState);
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-length': String(JSON.stringify(manifest).length) } });
    });
    const manager = new UpdateManager({
      staging: path.join(root, 'staging'), runtimes, sevenZip: path.join(root, '7z.exe')
    }, '0.2.0', manifest.asset.url);

    await expect(manager.check('runtime', 'stable')).resolves.toMatchObject({
      phase: 'available', currentVersion: '0.1.0-rc.6', candidateVersion: '0.1.0', rollback: true
    });
    expect(await fileExists(path.join(runtimes, 'slot-B', 'new.txt'))).toBe(true);
    expect(await fileExists(stagingRoot)).toBe(false);
    expect(await fileExists(path.join(runtimes, '.rollback-recovery'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers before a new install and commits through a durable journal', async () => {
    const root = await makeTemporaryDirectory();
    const runtimes = path.join(root, 'runtimes');
    const stagingRoot = path.join(runtimes, '.staging-recovery');
    const staging = path.join(stagingRoot, 'slot-B');
    const stateFile = path.join(runtimes, 'runtime-state.json');
    const journalFile = path.join(runtimes, '.runtime-commit-journal.json');
    const archive = path.join(root, 'runtime.7z');
    await mkdir(path.join(runtimes, 'slot-A'), { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(runtimes, 'slot-A', 'old.txt'), 'old');
    await writeFile(path.join(staging, 'old-staged.txt'), 'old-staged');
    const beforeState = { schemaVersion: 1, active: 'A', previous: 'bundled', version: '0.1.0', healthy: true };
    const afterState = { schemaVersion: 1, active: 'B', previous: 'A', version: '0.1.1', healthy: false };
    await writeFile(stateFile, `${JSON.stringify(beforeState)}\n`);
    const archiveContent = 'archive123';
    await writeFile(archive, archiveContent);
    const verifiedManifest = {
      ...manifest,
      asset: {
        ...manifest.asset,
        size: Buffer.byteLength(archiveContent),
        sha256: createHash('sha256').update(archiveContent).digest('hex')
      }
    } as const;
    await writeRuntimeCommitJournal(journalFile, createRuntimeCommitJournal({
      txid: '0123456789abcdef',
      slot: 'B',
      stagingRoot: '.staging-recovery',
      staging: '.staging-recovery/slot-B',
      destination: 'slot-B',
      backup: '.rollback-recovery',
      beforeState,
      afterState,
      destinationWasPresent: false
    }));

    parseSevenZipSltMock.mockReturnValue({ entries: [] });
    ntExecutableFromMock.mockReturnValue({ is32bit: () => false, newHeader: { fileHeader: { machine: 0x8664 } } });
    runRuntimeStagingSmokeMock.mockResolvedValue(undefined);
    execFileAsyncMock.mockImplementation(async (_executable: string, args: readonly string[]) => {
      if (args[0] === 'l') {
        expect(await fileExists(journalFile)).toBe(false);
        expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ active: 'B', healthy: false });
        return { stdout: Buffer.from('listing'), stderr: Buffer.alloc(0) };
      }
      if (args[0] === 'x') {
        const output = args.find(value => value.startsWith('-o'))?.slice(2);
        if (!output) throw new Error('TEST_EXTRACTION_ROOT_MISSING');
        await mkdir(path.join(output, 'node-runtime'), { recursive: true });
        await mkdir(path.join(output, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
        await mkdir(path.join(output, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
        await writeFile(path.join(output, 'node-runtime', 'node.exe'), 'node');
        await writeFile(path.join(output, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: manifest.runtime.version }));
        await writeFile(path.join(output, 'dsh-runtime', 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': manifest.runtime.version, pnpm: manifest.runtime.pnpmVersion } }));
        await writeFile(path.join(output, 'dsh-runtime', 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@deepseek-ai/dsh': { integrity: manifest.runtime.dshIntegrity } } }));
        return { stdout: '', stderr: '' };
      }
      if (args[0] === '--version') return { stdout: `${manifest.runtime.nodeVersion}\n`, stderr: '' };
      if (args[1] === '--version') return { stdout: `${manifest.runtime.version}\n`, stderr: '' };
      throw new Error('TEST_EXECUTION_UNEXPECTED');
    });
    const manager = new UpdateManager({
      staging: path.join(root, 'staging'), runtimes, sevenZip: path.join(root, '7z.exe'),
      appPath: path.join(root, 'app'), resourcesPath: path.join(root, 'resources'), packaged: false
    }, '0.2.0', manifest.asset.url);

    type UpdateManagerInternals = { installVerifiedRuntime(archive: string, manifest: typeof verifiedManifest): Promise<void> };
    await (manager as unknown as UpdateManagerInternals).installVerifiedRuntime(archive, verifiedManifest);

    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
      schemaVersion: 1, active: 'B', previous: 'A', version: manifest.runtime.version, healthy: false,
      candidate: true, installedAt: expect.any(String)
    });
    expect(await fileExists(journalFile)).toBe(false);
    expect((await readdir(runtimes)).sort()).toEqual(['runtime-state.json', 'slot-A', 'slot-B']);
    expect(await readFile(path.join(runtimes, 'slot-A', 'old.txt'), 'utf8')).toBe('old');
    expect(await fileExists(path.join(runtimes, 'slot-B', 'node-runtime', 'node.exe'))).toBe(true);
    expect(runRuntimeStagingSmokeMock).toHaveBeenCalledOnce();
    expect(scanExtractedTreeNoReparseMock).toHaveBeenCalledOnce();
    expect(preflightRuntimeClosureMock).toHaveBeenCalledWith(expect.objectContaining({ slot: 'B', scanMode: 'deep' }));
    expect(execFileAsyncMock).toHaveBeenCalled();
  });
});
