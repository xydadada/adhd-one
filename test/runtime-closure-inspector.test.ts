import { lstat as fsLstat, mkdir, mkdtemp, readFile, readdir as fsReaddir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_TOOLS_PACKAGE_NAME,
  preflightRuntimeClosure,
  RUNTIME_CLOSURE_ERROR_CODES,
  RUNTIME_CLOSURE_LIMITS,
  type RuntimeClosureDirent,
  type RuntimeClosureFilesystem,
  type RuntimeClosureStats
} from '../src/runtime-closure-inspector.js';

const roots: string[] = [];
const packageRelativePath = path.join('node_modules', '@deepseek-ai', 'dsh-tools');
const registrationIntegrityA = `sha512-${'A'.repeat(86)}==`;
const registrationIntegrityB = `sha512-${'B'.repeat(86)}==`;

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function lockPath(relativePackagePath: string): string {
  return relativePackagePath.replaceAll('\\', '/');
}

async function addPhysicalPackage(
  root: string,
  relativePackagePath = packageRelativePath,
  version = '1.2.3'
): Promise<string> {
  const directory = path.join(root, relativePackagePath);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: DSH_TOOLS_PACKAGE_NAME, version }) + '\n', 'utf8');
  return lockPath(relativePackagePath);
}

async function makeRuntimeRoot(options: {
  readonly version?: string;
  readonly lockIntegrity?: string;
  readonly writeLock?: boolean;
  readonly registerPackage?: boolean;
  readonly nestedDuplicate?: boolean;
  readonly repeatedDependencyReferences?: boolean;
  readonly manifestRegistrationIntegrity?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-closure-inspector-'));
  roots.push(root);

  const version = options.version ?? '1.2.3';
  const integrity = options.lockIntegrity ?? registrationIntegrityA;
  const primaryLockPath = await addPhysicalPackage(root, packageRelativePath, version);
  const packages: Record<string, unknown> = {};
  if (options.registerPackage !== false) packages[primaryLockPath] = { version, integrity };

  if (options.manifestRegistrationIntegrity !== undefined) {
    await writeFile(
      path.join(root, packageRelativePath, 'package.json'),
      JSON.stringify({ name: DSH_TOOLS_PACKAGE_NAME, version, integrity: options.manifestRegistrationIntegrity }) + '\n',
      'utf8'
    );
  }

  if (options.nestedDuplicate) {
    const nestedPath = path.join('node_modules', 'consumer', 'node_modules', '@deepseek-ai', 'dsh-tools');
    const nestedLockPath = await addPhysicalPackage(root, nestedPath, version);
    packages[nestedLockPath] = { version, integrity };
  }

  if (options.repeatedDependencyReferences) {
    packages[''] = {};
    packages['node_modules/consumer-a'] = {
      version: '1.0.0',
      dependencies: { [DSH_TOOLS_PACKAGE_NAME]: `^${version}` }
    };
    packages['node_modules/consumer-b'] = {
      version: '1.0.0',
      dependencies: { [DSH_TOOLS_PACKAGE_NAME]: `^${version}` }
    };
    packages[''].dependencies = {
      [DSH_TOOLS_PACKAGE_NAME]: version,
      'consumer-a': '1.0.0',
      'consumer-b': '1.0.0'
    };
  }

  if (options.writeLock !== false) {
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', lockfileVersion: 3, packages }) + '\n',
      'utf8'
    );
  }
  return root;
}

function expectError(error: unknown, code: string, count: number, version: string, slot: string): void {
  expect(error).toMatchObject({ code, count, version, slot });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`${code} count=${count} version=${version} slot=${slot}`);
}

describe('runtime closure inspector', () => {
  it('accepts one physical dsh-tools package and preserves the fixture', async () => {
    const root = await makeRuntimeRoot();
    const packageBefore = await readFile(path.join(root, packageRelativePath, 'package.json'), 'utf8');
    const lockBefore = await readFile(path.join(root, 'package-lock.json'), 'utf8');

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A' })).resolves.toEqual({
      ok: true,
      count: 1,
      version: '1.2.3',
      registrationIntegrity: registrationIntegrityA,
      slot: 'A'
    });
    await expect(readFile(path.join(root, packageRelativePath, 'package.json'), 'utf8')).resolves.toBe(packageBefore);
    await expect(readFile(path.join(root, 'package-lock.json'), 'utf8')).resolves.toBe(lockBefore);
  });

  it('counts physical package manifests rather than repeated dependency text', async () => {
    const root = await makeRuntimeRoot({ repeatedDependencyReferences: true });

    await expect(preflightRuntimeClosure(root, 'bundled')).resolves.toMatchObject({
      ok: true,
      count: 1,
      version: '1.2.3',
      registrationIntegrity: registrationIntegrityA,
      slot: 'bundled'
    });
  });

  it('supports a bounded registered-path startup check without recursively enumerating node_modules', async () => {
    const root = await makeRuntimeRoot();
    const filesystem: RuntimeClosureFilesystem = {
      lstat: filename => import('node:fs/promises').then(module => module.lstat(filename)),
      readFile: filename => readFile(filename, 'utf8'),
      readdir: async () => { throw new Error('REGISTERED_MODE_MUST_NOT_ENUMERATE'); },
      assertNoReparse: () => undefined
    };

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'bundled', scanMode: 'registered', filesystem }))
      .resolves.toMatchObject({ ok: true, count: 1, version: '1.2.3', registrationIntegrity: registrationIntegrityA, slot: 'bundled' });
  });

  it('keeps registered mode bounded while leaving physical-closure discovery to deep', async () => {
    const root = await makeRuntimeRoot({ nestedDuplicate: true });
    const lockFile = path.join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { packages: Record<string, unknown> };
    delete lock.packages[lockPath(path.join('node_modules', 'consumer', 'node_modules', '@deepseek-ai', 'dsh-tools'))];
    await writeFile(lockFile, JSON.stringify(lock), 'utf8');

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A', scanMode: 'registered' }))
      .resolves.toMatchObject({ ok: true, registrationIntegrity: registrationIntegrityA });
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A', scanMode: 'deep' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.countInvalid, 2, 'unknown', 'A');
      return true;
    });
  });

  it('rejects a nested physical duplicate with a stable count error', async () => {
    const root = await makeRuntimeRoot({ nestedDuplicate: true });

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'B' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.countInvalid, 2, 'unknown', 'B');
      expect((error as Error).message).not.toContain(root);
      return true;
    });
  });

  it('reports a missing package-lock without exposing the active root', async () => {
    const root = await makeRuntimeRoot({ writeLock: false });

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.lockMissing, 1, '1.2.3', 'A');
      expect((error as Error).message).not.toContain(root);
      return true;
    });
  });

  it('reports a physical package that is absent from the root lock registration', async () => {
    const root = await makeRuntimeRoot({ registerPackage: false });

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.packageUnregistered, 1, '1.2.3', 'A');
      expect((error as Error).message).not.toContain(root);
      return true;
    });
  });

  it('checks version and registered integrity metadata', async () => {
    const versionMismatchRoot = await makeRuntimeRoot({ version: '2.0.0' });
    const lockFile = path.join(versionMismatchRoot, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { packages: Record<string, { version: string; integrity: string }> };
    lock.packages[lockPath(packageRelativePath)] = { version: '1.0.0', integrity: registrationIntegrityA };
    await writeFile(lockFile, JSON.stringify(lock), 'utf8');

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: versionMismatchRoot, slot: 'A' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.versionMismatch, 1, '2.0.0', 'A');
      return true;
    });

    const integrityMismatchRoot = await makeRuntimeRoot({ manifestRegistrationIntegrity: registrationIntegrityB });
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: integrityMismatchRoot, slot: 'B' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.integrityMismatch, 1, '1.2.3', 'B');
      return true;
    });
  });

  it('requires the exact target manifest name and valid SRI registration metadata', async () => {
    for (const manifestName of [undefined, 'other-package']) {
      const root = await makeRuntimeRoot();
      const filename = path.join(root, packageRelativePath, 'package.json');
      const manifest = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
      if (manifestName === undefined) delete manifest.name;
      else manifest.name = manifestName;
      await writeFile(filename, JSON.stringify(manifest), 'utf8');

      await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A', scanMode: 'deep' })).rejects.toSatisfy(error => {
        expectError(error, RUNTIME_CLOSURE_ERROR_CODES.packageInvalid, 1, 'unknown', 'A');
        return true;
      });
    }

    const invalidLockIntegrityRoot = await makeRuntimeRoot({ lockIntegrity: 'sha512-not-sri' });
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: invalidLockIntegrityRoot, slot: 'A', scanMode: 'registered' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.integrityInvalid, 1, '1.2.3', 'A');
      return true;
    });

    const invalidManifestIntegrityRoot = await makeRuntimeRoot({ manifestRegistrationIntegrity: 'sha512-not-sri' });
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: invalidManifestIntegrityRoot, slot: 'B', scanMode: 'registered' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.integrityInvalid, 1, '1.2.3', 'B');
      return true;
    });
  });

  it('rejects non-v3 package locks and pnpm virtual-store layouts', async () => {
    const nonV3Root = await makeRuntimeRoot();
    const nonV3LockFile = path.join(nonV3Root, 'package-lock.json');
    const nonV3Lock = JSON.parse(await readFile(nonV3LockFile, 'utf8')) as Record<string, unknown>;
    nonV3Lock.lockfileVersion = 2;
    await writeFile(nonV3LockFile, JSON.stringify(nonV3Lock), 'utf8');
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: nonV3Root, slot: 'A', scanMode: 'registered' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.lockInvalid, 0, 'unknown', 'A');
      return true;
    });

    const pnpmRoot = await makeRuntimeRoot();
    await mkdir(path.join(pnpmRoot, 'node_modules', '.pnpm'), { recursive: true });
    for (const scanMode of ['registered', 'deep'] as const) {
      await expect(preflightRuntimeClosure({ activeRuntimeRoot: pnpmRoot, slot: 'B', scanMode })).rejects.toSatisfy(error => {
        expectError(error, RUNTIME_CLOSURE_ERROR_CODES.pnpmUnsupported, 0, 'unknown', 'B');
        return true;
      });
    }
  });

  it('bounds lock and package manifest reads by bytes', async () => {
    const oversizedLockRoot = await makeRuntimeRoot();
    const lockFile = path.join(oversizedLockRoot, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
    lock.padding = 'x'.repeat(RUNTIME_CLOSURE_LIMITS.maxPackageLockBytes);
    await writeFile(lockFile, JSON.stringify(lock), 'utf8');
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: oversizedLockRoot, slot: 'A', scanMode: 'registered' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, 0, 'unknown', 'A');
      return true;
    });

    const oversizedManifestRoot = await makeRuntimeRoot();
    const manifestFile = path.join(oversizedManifestRoot, packageRelativePath, 'package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.padding = 'x'.repeat(RUNTIME_CLOSURE_LIMITS.maxPackageJsonBytes);
    await writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: oversizedManifestRoot, slot: 'B', scanMode: 'deep' })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, 1, 'unknown', 'B');
      return true;
    });
  });

  it('bounds deep directory depth and entry enumeration', async () => {
    const entryRoot = path.resolve('virtual-entry-limit-root');
    const fileEntry: RuntimeClosureDirent = {
      name: 'file',
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false
    };
    const directoryStats: RuntimeClosureStats = {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false
    };
    const oversizedEntries = Object.freeze({
      length: RUNTIME_CLOSURE_LIMITS.maxEntries + 1
    }) as unknown as readonly RuntimeClosureDirent[];
    const entryFilesystem: RuntimeClosureFilesystem = {
      lstat: async filename => {
        if (filename === entryRoot) return directoryStats;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readdir: async () => oversizedEntries,
      readFile: async () => '',
      assertNoReparse: () => undefined
    };
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: entryRoot, slot: 'A', scanMode: 'deep', filesystem: entryFilesystem })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, 0, 'unknown', 'A');
      return true;
    });

    const directoryRoot = path.resolve('virtual-directory-limit-root');
    const pnpmStore = path.join(directoryRoot, 'node_modules', '.pnpm');
    const directoryEntry: RuntimeClosureDirent = {
      name: 'next',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false
    };
    const directoryFilesystem: RuntimeClosureFilesystem = {
      lstat: async filename => {
        if (filename === pnpmStore) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return directoryStats;
      },
      readdir: async () => [directoryEntry],
      readFile: async () => '',
      assertNoReparse: () => undefined
    };
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: directoryRoot, slot: 'B', scanMode: 'deep', filesystem: directoryFilesystem })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.scanLimitExceeded, 0, 'unknown', 'B');
      return true;
    });
  });

  it('fails closed when the reparse attribute check itself throws', async () => {
    const root = await makeRuntimeRoot();
    const nodeModules = path.join(root, 'node_modules');
    const filesystem: RuntimeClosureFilesystem = {
      lstat: filename => fsLstat(filename),
      readdir: async directory => await fsReaddir(directory, { withFileTypes: true }) as RuntimeClosureDirent[],
      readFile: filename => readFile(filename, 'utf8'),
      assertNoReparse: filename => {
        if (filename === nodeModules) throw new Error('ATTRIBUTE_CHECK_FAILED');
      }
    };

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A', scanMode: 'deep', filesystem })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.reparseRefused, 0, 'unknown', 'A');
      expect((error as Error).message).not.toContain(root);
      return true;
    });
  });

  it('keeps different active roots isolated', async () => {
    const first = await makeRuntimeRoot({ version: '1.0.0', lockIntegrity: registrationIntegrityA });
    const second = await makeRuntimeRoot({ version: '2.0.0', lockIntegrity: registrationIntegrityB });

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: first, slot: 'A' })).resolves.toMatchObject({ version: '1.0.0', registrationIntegrity: registrationIntegrityA });
    await expect(preflightRuntimeClosure({ activeRuntimeRoot: second, slot: 'B' })).resolves.toMatchObject({ version: '2.0.0', registrationIntegrity: registrationIntegrityB });
  });

  it('fails closed on a simulated reparse point without entering it', async () => {
    const root = path.resolve('virtual-runtime-root');
    const nodeModules = path.join(root, 'node_modules');
    const reparseScope = path.join(nodeModules, '@deepseek-ai');
    const lock = path.join(root, 'package-lock.json');
    const visited: string[] = [];
    const entry = (name: string, kind: 'directory' | 'file' | 'reparse'): RuntimeClosureDirent => ({
      name,
      isDirectory: () => kind !== 'file',
      isFile: () => kind === 'file',
      isSymbolicLink: () => false,
      isReparsePoint: () => kind === 'reparse'
    });
    const stats = (kind: 'directory' | 'file' | 'reparse'): RuntimeClosureStats => ({
      isDirectory: () => kind !== 'file',
      isFile: () => kind === 'file',
      isSymbolicLink: () => false,
      isReparsePoint: () => kind === 'reparse'
    });
    const filesystem: RuntimeClosureFilesystem = {
      lstat: async filename => {
        visited.push(`lstat:${filename}`);
        if (filename === root) return stats('directory');
        if (filename === nodeModules) return stats('directory');
        if (filename === reparseScope) return stats('reparse');
        if (filename === lock) return stats('file');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readdir: async directory => {
        visited.push(`readdir:${directory}`);
        if (directory === root) return [entry('node_modules', 'directory'), entry('package-lock.json', 'file')];
        if (directory === nodeModules) return [entry('@deepseek-ai', 'reparse')];
        throw new Error('FOLLOWED_REPARSE');
      },
      readFile: async filename => {
        if (filename === lock) return JSON.stringify({ packages: {} });
        throw new Error('FOLLOWED_REPARSE');
      }
    };

    await expect(preflightRuntimeClosure({ activeRuntimeRoot: root, slot: 'A', filesystem })).rejects.toSatisfy(error => {
      expectError(error, RUNTIME_CLOSURE_ERROR_CODES.reparseRefused, 0, 'unknown', 'A');
      return true;
    });
    expect(visited).not.toContain(`readdir:${reparseScope}`);
  });
});
