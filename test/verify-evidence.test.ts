import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyEvidenceDirectory } from '../scripts/verify-evidence.mjs';

const roots: string[] = [];
const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/verify-evidence.mjs');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type JsonObject = Record<string, unknown>;

async function readJsonObject(file: string): Promise<JsonObject> {
  return JSON.parse(await readFile(file, 'utf8')) as JsonObject;
}

async function writeJsonObject(file: string, value: JsonObject): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function symlinkUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['EACCES', 'ENOTSUP', 'EPERM'].includes(String(error.code));
}

function workspace(requested: boolean): JsonObject {
  return {
    requested,
    verified: requested,
    rpcClientSource: requested ? 'packaged-asar' : 'not-run',
    permissionMode: requested ? 'workspace-write' : 'not-run',
    approval: 'not-requested',
    providerSequence: requested ? 'matched' : 'not-run',
    approvalRequested: false,
    sessionCreated: requested,
    sessionArchived: requested,
    historyVerified: requested,
    providerAuthVerified: requested,
    powerShellCall: requested,
    toolResult: requested,
    sentinelFile: requested,
    secondProviderTurn: requested,
    finalNonce: requested
  };
}

function cycle(scenario: string, number: number, portableMode = false): JsonObject {
  const forceKill = scenario === 'force-kill';
  const write = scenario === 'workspace-write';
  return {
    cycle: number,
    scenario,
    passed: true,
    launchVerified: true,
    launchMs: 1,
    controlWindowMs: 1,
    runtimeReadyMs: 1,
    exitMs: 1,
    pid: 1000 + number,
    cdpPort: 43123,
    portableMode,
    controlWindowVerified: true,
    runtimeReadyVerified: true,
    hostDescribeVerified: true,
    runtimePid: 2000 + number,
    isolationVerified: true,
    cdpClosed: true,
    runtimePidExited: true,
    processTreeExited: true,
    quitAccepted: !forceKill,
    gracefulExitVerified: !forceKill,
    exitVerified: true,
    processTreeCount: 2,
    remainingPids: [],
    exitCode: forceKill ? null : 0,
    exitSignal: null,
    forceKillRequested: forceKill,
    forceKillVerified: forceKill,
    forcedTermination: forceKill,
    cleanup: 'removed',
    cleanupRootExisted: true,
    cleanupRootAbsent: true,
    cleanupVerified: true,
    finalScopedProcessAuditPassed: true,
    finalScopedProcessAuditCount: 0,
    finalScopedProcessAuditPids: [],
    finalScopedProcessAuditKinds: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    workspaceWriteVerified: write,
    workspaceWrite: workspace(write)
  };
}

function evidence(scenario: string, cycles = 1, portableMode = false): JsonObject {
  const items = Array.from({ length: cycles }, (_, index) => cycle(scenario, index + 1, portableMode));
  const forceKill = scenario === 'force-kill';
  const write = scenario === 'workspace-write';
  return {
    schemaVersion: 1,
    tool: 'adhd-one-packaged-e2e',
    generatedAt: '2026-08-15T00:00:00.000Z',
    executable: 'ADHD One.exe',
    scenario,
    portableMode,
    launchVerified: true,
    forceKillRequested: forceKill,
    forceKillVerified: forceKill,
    quitAccepted: !forceKill,
    gracefulExitVerified: !forceKill,
    exitVerified: true,
    cleanupVerified: true,
    finalScopedProcessAuditPassed: true,
    workspaceWriteRequested: write,
    workspaceWriteVerified: write,
    cyclesRequested: cycles,
    cyclesCompleted: cycles,
    passed: true,
    cycles: items
  };
}

function summary(): JsonObject {
  return {
    schemaVersion: 1,
    tool: 'adhd-one-installed-e2e',
    passed: true,
    installStarted: true,
    installCompleted: true,
    shortcutsCreated: true,
    suitePassed: true,
    uninstallAttempted: true,
    uninstallSucceeded: true,
    uninstallExitCode: 0,
    uninstallRecordCount: 1,
    matchingUninstallRecordCount: 1,
    installLocationRecordMatched: false,
    uninstallCommandRecordMatched: true,
    installDirectoryRemoved: true,
    processClean: true,
    registryClean: true,
    shortcutsClean: true,
    errorCode: null,
    cleanupErrorCodes: []
  };
}

async function makeDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verify-evidence-'));
  roots.push(root);
  const files: Record<string, JsonObject> = {
    'launch-1.json': evidence('launch'),
    'force-kill-1.json': evidence('force-kill'),
    'workspace-write-1.json': evidence('workspace-write'),
    'launch-10.json': evidence('launch', 10),
    'installed-summary.json': summary()
  };
  await Promise.all(Object.entries(files).map(([name, value]) =>
    writeFile(path.join(root, name), `${JSON.stringify(value)}\n`, 'utf8')));
  return root;
}

describe('downloaded Windows E2E evidence verifier', () => {
  it('accepts the packaged suite and installed cleanup summary, and the CLI passes', async () => {
    const root = await makeDirectory();
    await expect(verifyEvidenceDirectory(root)).resolves.toEqual({ ok: true, errors: [] });
    const result = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('PASS');
    expect(result.stderr).toBe('');
  });

  it('rejects an allowlist violation without echoing its sensitive value', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    value.rawOutput = 'Bearer super-secret-token';
    await writeJsonObject(file, value);
    const result = await verifyEvidenceDirectory(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['launch-1.json:PACKAGED_EVIDENCE_INVALID']);
    const cli = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(`${cli.stdout}\n${cli.stderr}`).not.toContain('super-secret-token');
  });

  it('requires strict cycle counts, normal exit booleans, force-kill, and workspace-write evidence', async () => {
    const root = await makeDirectory();
    const normalPath = path.join(root, 'launch-1.json');
    const normal = await readJsonObject(normalPath);
    normal.cyclesCompleted = 0;
    await writeJsonObject(normalPath, normal);
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);

    const forcePath = path.join(root, 'force-kill-1.json');
    const force = await readJsonObject(forcePath);
    (force.cycles as JsonObject[])[0].forceKillVerified = false;
    await writeJsonObject(forcePath, force);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('force-kill-1.json:PACKAGED_EVIDENCE_INVALID');

    const workspacePath = path.join(root, 'workspace-write-1.json');
    const workspaceEvidence = await readJsonObject(workspacePath);
    const workspaceCycle = (workspaceEvidence.cycles as JsonObject[])[0];
    (workspaceCycle.workspaceWrite as JsonObject).toolResult = false;
    await writeJsonObject(workspacePath, workspaceEvidence);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('workspace-write-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('fails when installed cleanup leaves registry or shortcut residue', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'installed-summary.json');
    const value = await readJsonObject(file);
    value.registryClean = false;
    value.cleanupErrorCodes = ['INSTALLED_E2E_REGISTRY_REMAINED'];
    await writeJsonObject(file, value);
    const result = await verifyEvidenceDirectory(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['installed-summary.json:INSTALLED_SUMMARY_INVALID']);
  });

  it('rejects evidence when installed-summary.json is missing', async () => {
    const root = await makeDirectory();
    await rm(path.join(root, 'installed-summary.json'));
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it('rejects extra files and directories in the evidence directory', async () => {
    const root = await makeDirectory();
    await writeFile(path.join(root, 'unexpected.txt'), 'unexpected', 'utf8');
    await mkdir(path.join(root, 'unexpected-directory'));
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it('rejects a symlinked evidence file when symlinks are available', async context => {
    const root = await makeDirectory();
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'verify-evidence-target-'));
    roots.push(targetRoot);
    const source = path.join(root, 'launch-1.json');
    const target = path.join(targetRoot, 'launch-1.json');
    await writeFile(target, await readFile(source, 'utf8'), 'utf8');
    await rm(source);
    try {
      await symlink(target, source, 'file');
    } catch (error) {
      if (symlinkUnavailable(error)) context.skip('file symlinks are unavailable on this platform');
      throw error;
    }
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it('rejects a generatedAt timestamp without milliseconds', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    value.generatedAt = '2026-08-15T00:00:00Z';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('rejects a drive-qualified executable path', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    value.executable = 'C:\\Users\\Alice\\ADHD One.exe';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('rejects a sensitive executable name', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    value.executable = 'secret-token.exe';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('rejects installed evidence marked portable at the top level', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    value.portableMode = true;
    (value.cycles as JsonObject[])[0].portableMode = true;
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it('rejects installed evidence with a portable cycle', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    (value.cycles as JsonObject[])[0].portableMode = true;
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it.each(['pid', 'runtimePid', 'cdpPort', 'processTreeCount'])('rejects a zero %s', async field => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    (value.cycles as JsonObject[])[0][field] = 0;
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('rejects an audit count that does not match the audit PID array', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    (value.cycles as JsonObject[])[0].finalScopedProcessAuditCount = 1;
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);
  });

  it('rejects a non-boolean summary matched field', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'installed-summary.json');
    const value = await readJsonObject(file);
    value.installLocationRecordMatched = true;
    value.uninstallCommandRecordMatched = 'true';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('installed-summary.json:INSTALLED_SUMMARY_INVALID');
  });

  it('rejects an unknown cycle errorCode', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    (value.cycles as JsonObject[])[0].errorCode = 'UNKNOWN_ERROR_CODE';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('rejects an E-prefixed non-production cycle errorCode', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'launch-1.json');
    const value = await readJsonObject(file);
    (value.cycles as JsonObject[])[0].errorCode = 'EVIL_SECRET';
    await writeJsonObject(file, value);
    const result = await verifyEvidenceDirectory(root);
    expect(result.errors).toContain('launch-1.json:PACKAGED_EVIDENCE_INVALID');
    expect(JSON.stringify(result)).not.toContain('EVIL_SECRET');
  });

  it('requires a null errorCode in a passed installed summary', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'installed-summary.json');
    const value = await readJsonObject(file);
    value.errorCode = 'E2E_CYCLE_FAILED';
    await writeJsonObject(file, value);
    expect((await verifyEvidenceDirectory(root)).errors).toContain('installed-summary.json:INSTALLED_SUMMARY_INVALID');
  });
});
