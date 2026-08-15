import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXED_E2E_SCRIPTS,
  RUNNER_DEPENDENCY_ROOTS,
  WIN11_RUNNER_ERROR_CODES,
  WIN11_RUNNER_MANIFEST_FILE,
  parseRunnerArgs,
  planWin11Runner,
  prepareWin11Runner,
  validateWin11RunnerNode
} from '../scripts/prepare-win11-runner.mjs';

type LockEntry = {
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type Fixture = {
  root: string;
  repositoryRoot: string;
  output: string;
  node: string;
  lockfile: { lockfileVersion: 3; packages: Record<string, LockEntry> };
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function packageEntry(version: string, overrides: Partial<LockEntry> = {}): LockEntry {
  return { version, ...overrides };
}

const fakeLockEntries: Record<string, LockEntry> = {
  'node_modules/playwright': packageEntry('1.0.0', {
    dependencies: { 'playwright-core': '1.0.0' },
    optionalDependencies: { fsevents: '1.0.0' }
  }),
  'node_modules/playwright-core': packageEntry('1.0.0'),
  'node_modules/@electron/asar': packageEntry('1.0.0', {
    dependencies: { commander: '1.0.0', glob: '1.0.0', minimatch: '1.0.0' }
  }),
  'node_modules/@electron/asar/node_modules/commander': packageEntry('1.0.0'),
  'node_modules/@electron/asar/node_modules/minimatch': packageEntry('1.0.0', {
    dependencies: { 'brace-expansion': '1.0.0' }
  }),
  'node_modules/@electron/asar/node_modules/minimatch/node_modules/brace-expansion': packageEntry('1.0.0', {
    dependencies: { 'balanced-match': '1.0.0' }
  }),
  'node_modules/@electron/asar/node_modules/minimatch/node_modules/brace-expansion/node_modules/balanced-match': packageEntry('1.0.0'),
  'node_modules/glob': packageEntry('1.0.0', {
    dependencies: { minimatch: '1.0.0' }
  }),
  'node_modules/minimatch': packageEntry('2.0.0'),
  'node_modules/@deepseek-ai/dsh-llm-mock-server': packageEntry('1.0.0', {
    peerDependencies: { 'mock-peer': '1.0.0', 'optional-peer': '1.0.0' },
    peerDependenciesMeta: { 'optional-peer': { optional: true } }
  }),
  'node_modules/mock-peer': packageEntry('1.0.0', {
    dependencies: { 'peer-leaf': '1.0.0' }
  }),
  'node_modules/peer-leaf': packageEntry('1.0.0'),
  'node_modules/unrelated': packageEntry('9.9.9')
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-win11-runner-test-'));
  temporaryRoots.push(root);
  const repositoryRoot = path.join(root, 'repo');
  const output = path.join(root, 'runner-output');
  const node = path.join(repositoryRoot, 'node.exe');
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(node, 'fake node executable\n', 'utf8');

  for (const relativePath of FIXED_E2E_SCRIPTS) {
    const filename = path.join(repositoryRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `fake script ${relativePath}\n`, 'utf8');
  }

  for (const [lockPath, entry] of Object.entries(fakeLockEntries)) {
    const packageDirectory = path.join(repositoryRoot, ...lockPath.split('/'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version
    }), 'utf8');
    await writeFile(path.join(packageDirectory, 'index.js'), `export const version = ${JSON.stringify(entry.version)};\n`, 'utf8');
  }

  return {
    root,
    repositoryRoot,
    output,
    node,
    lockfile: { lockfileVersion: 3, packages: structuredClone(fakeLockEntries) }
  };
}

function planInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    repositoryRoot: fixture.repositoryRoot,
    outputDirectory: fixture.output,
    nodeExecutable: fixture.node,
    nodeValidator: async () => undefined,
    packageLock: fixture.lockfile,
    ...overrides
  };
}

async function collectRelativeFiles(root: string, current = root, result: string[] = []): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) await collectRelativeFiles(root, filename, result);
    else result.push(path.relative(root, filename).replaceAll('\\', '/'));
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

async function fileDigest(filename: string): Promise<{ size: number; sha256: string }> {
  const content = await readFile(filename);
  return { size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
}

describe('Win11 runner closure planner', () => {
  it('resolves only the requested lockfile closure, including nested packages and required peers', async () => {
    const fixture = await createFixture();
    const plan = planWin11Runner(planInput(fixture));
    const lockPaths = plan.packages.map(packageEntry => packageEntry.lockPath);

    expect(lockPaths).toEqual(expect.arrayContaining([
      ...RUNNER_DEPENDENCY_ROOTS.map(name => `node_modules/${name}`),
      'node_modules/@electron/asar/node_modules/commander',
      'node_modules/@electron/asar/node_modules/minimatch',
      'node_modules/@electron/asar/node_modules/minimatch/node_modules/brace-expansion',
      'node_modules/@electron/asar/node_modules/minimatch/node_modules/brace-expansion/node_modules/balanced-match',
      'node_modules/mock-peer',
      'node_modules/peer-leaf'
    ]));
    expect(lockPaths).not.toContain('node_modules/unrelated');
    expect(lockPaths).not.toContain('node_modules/optional-peer');
    expect(plan.packages.every(packageEntry => path.isAbsolute(packageEntry.sourceDirectory))).toBe(true);
  });

  it('keeps every fixed E2E entry explicit, including the host proof and matrix inputs', () => {
    expect(FIXED_E2E_SCRIPTS).toEqual(expect.arrayContaining([
      'scripts/e2e/packaged.mjs',
      'scripts/e2e/run-packaged-suite.mjs',
      'scripts/e2e/verify-win11-evidence.mjs',
      'scripts/e2e/win11-evidence-builder.mjs',
      'scripts/e2e/windows-process-cpu.mjs',
      'scripts/e2e/installed.ps1',
      'scripts/verify-evidence.mjs',
      'scripts/e2e/win11-host-proof.mjs',
      'scripts/e2e/win11-matrix.ps1'
    ]));
  });

  it('is pure with respect to the filesystem and rejects protected output locations', async () => {
    const fixture = await createFixture();
    const plan = planWin11Runner({
      ...planInput(fixture),
      nodeExecutable: path.join(fixture.root, 'missing-node.exe'),
      sourceNodeModules: path.join(fixture.root, 'missing-node-modules')
    });
    expect(plan.node.sourcePath).toContain('missing-node.exe');

    for (const outputDirectory of [
      fixture.repositoryRoot,
      path.join(fixture.repositoryRoot, 'node_modules'),
      path.join(fixture.repositoryRoot, 'vendor'),
      path.join(fixture.repositoryRoot, 'dist'),
      path.join(fixture.repositoryRoot, 'dist', 'nested')
    ]) {
      expect(() => planWin11Runner(planInput(fixture, { outputDirectory })))
        .toThrow(WIN11_RUNNER_ERROR_CODES.OUTPUT_REJECTED);
    }
  });
});

describe('Win11 runner preparation', () => {
  it('rejects a non-PE Node executable when the production validator is used', async () => {
    const fixture = await createFixture();
    await expect(validateWin11RunnerNode(fixture.node)).rejects.toThrow(WIN11_RUNNER_ERROR_CODES.NODE_INVALID);
    await expect(prepareWin11Runner(planInput(fixture, { nodeValidator: undefined })))
      .rejects.toThrow(WIN11_RUNNER_ERROR_CODES.NODE_INVALID);
  });

  it('stages the fake node and fixed scripts, writes path-free hashes, and publishes the closure', async () => {
    const fixture = await createFixture();
    const result = await prepareWin11Runner(planInput(fixture));
    const manifestText = await readFile(path.join(fixture.output, WIN11_RUNNER_MANIFEST_FILE), 'utf8');
    const manifest = JSON.parse(manifestText) as {
      files: Array<{ path: string; size: number; sha256: string }>;
      totalBytes: number;
      packages: Array<{ lockPath: string }>;
      nodeArchitecture: string;
    };

    expect(result.manifest).toEqual(manifest);
    expect(manifest.nodeArchitecture).toBe('x64');
    expect(JSON.stringify(manifest)).not.toContain(fixture.repositoryRoot);
    expect(JSON.stringify(manifest)).not.toContain(fixture.output);
    expect(manifest.files.some(file => file.path === 'node.exe')).toBe(true);
    expect(manifest.files.some(file => file.path === WIN11_RUNNER_MANIFEST_FILE)).toBe(false);

    const actualFiles = await collectRelativeFiles(fixture.output);
    const actualContentFiles = actualFiles.filter(filename => filename !== WIN11_RUNNER_MANIFEST_FILE);
    expect(manifest.files.map(file => file.path)).toEqual(actualContentFiles);

    let totalBytes = 0;
    for (const file of manifest.files) {
      const digest = await fileDigest(path.join(fixture.output, ...file.path.split('/')));
      expect(digest).toEqual({ size: file.size, sha256: file.sha256 });
      totalBytes += file.size;
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(manifest.totalBytes).toBe(totalBytes);
    expect((await readFile(path.join(fixture.output, 'node.exe'), 'utf8'))).toBe('fake node executable\n');
    await expect(stat(path.join(fixture.output, 'node_modules', 'unrelated')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(fixture.root).then(entries => entries.filter(entry => entry.startsWith('.adhd-one-win11-runner-'))))
      .resolves.toHaveLength(0);
  });

  it('replaces an existing output only after the new staging tree is ready', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output, { recursive: true });
    await writeFile(path.join(fixture.output, 'old.txt'), 'old output', 'utf8');

    await prepareWin11Runner(planInput(fixture));

    await expect(stat(path.join(fixture.output, WIN11_RUNNER_MANIFEST_FILE))).resolves.toBeTruthy();
    await expect(stat(path.join(fixture.output, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an existing output and removes staging when a source fails', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output, { recursive: true });
    await writeFile(path.join(fixture.output, 'keep.txt'), 'keep', 'utf8');
    await rm(path.join(fixture.repositoryRoot, 'node_modules', 'playwright'), { recursive: true, force: true });

    await expect(prepareWin11Runner(planInput(fixture))).rejects.toThrow(
      WIN11_RUNNER_ERROR_CODES.PACKAGE_SOURCE_MISSING
    );
    await expect(readFile(path.join(fixture.output, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(readdir(fixture.root).then(entries => entries.filter(entry => entry.startsWith('.adhd-one-win11-runner-'))))
      .resolves.toHaveLength(0);
  });
});

describe('Win11 runner CLI', () => {
  it('parses --output/--node and exposes --help without touching the repository', () => {
    const absoluteOutput = path.resolve(os.tmpdir(), 'outside', 'runner');
    const absoluteNode = path.resolve(os.tmpdir(), 'outside', 'tools', 'node.exe');
    const parsed = parseRunnerArgs(['--output', absoluteOutput, `--node=${absoluteNode}`]);
    expect(parsed).toEqual({
      help: false,
      output: path.normalize(absoluteOutput),
      node: path.normalize(absoluteNode)
    });
    expect(() => parseRunnerArgs(['--output', 'runner', '--node', absoluteNode]))
      .toThrow(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
    expect(() => parseRunnerArgs(['--output', absoluteOutput, '--node', 'node.exe']))
      .toThrow(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);

    const script = path.resolve('scripts', 'prepare-win11-runner.mjs');
    const cli = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe('');
    expect(cli.stdout).toContain('--output');
    expect(cli.stdout).toContain('--node');

    const invalidCli = spawnSync(process.execPath, [
      script,
      '--output',
      'relative-output',
      '--node',
      'C:\\outside\\node.exe'
    ], { encoding: 'utf8' });
    expect(invalidCli.status).toBe(1);
    expect(invalidCli.stderr.trim()).toBe(WIN11_RUNNER_ERROR_CODES.CLI_USAGE);
  });
});
