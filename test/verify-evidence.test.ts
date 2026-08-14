import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    const value = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')) as JsonObject;
    value.rawOutput = 'Bearer super-secret-token';
    await writeFile(file, JSON.stringify(value), 'utf8');
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
    const normal = JSON.parse(await (await import('node:fs/promises')).readFile(normalPath, 'utf8')) as JsonObject;
    normal.cyclesCompleted = 0;
    await writeFile(normalPath, JSON.stringify(normal), 'utf8');
    expect((await verifyEvidenceDirectory(root)).ok).toBe(false);

    const forcePath = path.join(root, 'force-kill-1.json');
    const force = JSON.parse(await (await import('node:fs/promises')).readFile(forcePath, 'utf8')) as JsonObject;
    (force.cycles as JsonObject[])[0].forceKillVerified = false;
    await writeFile(forcePath, JSON.stringify(force), 'utf8');
    expect((await verifyEvidenceDirectory(root)).errors).toContain('force-kill-1.json:PACKAGED_EVIDENCE_INVALID');

    const workspacePath = path.join(root, 'workspace-write-1.json');
    const workspaceEvidence = JSON.parse(await (await import('node:fs/promises')).readFile(workspacePath, 'utf8')) as JsonObject;
    const workspaceCycle = (workspaceEvidence.cycles as JsonObject[])[0];
    (workspaceCycle.workspaceWrite as JsonObject).toolResult = false;
    await writeFile(workspacePath, JSON.stringify(workspaceEvidence), 'utf8');
    expect((await verifyEvidenceDirectory(root)).errors).toContain('workspace-write-1.json:PACKAGED_EVIDENCE_INVALID');
  });

  it('fails when installed cleanup leaves registry or shortcut residue', async () => {
    const root = await makeDirectory();
    const file = path.join(root, 'installed-summary.json');
    const value = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')) as JsonObject;
    value.registryClean = false;
    value.cleanupErrorCodes = ['INSTALLED_E2E_REGISTRY_REMAINED'];
    await writeFile(file, JSON.stringify(value), 'utf8');
    const result = await verifyEvidenceDirectory(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['installed-summary.json:INSTALLED_SUMMARY_INVALID']);
  });
});
