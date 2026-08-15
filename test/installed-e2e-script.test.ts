import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyEvidenceDirectory,
  verifyPortableEvidenceFiles
} from '../scripts/verify-evidence.mjs';

const installedScriptPath = path.resolve('scripts', 'e2e', 'installed.ps1');
const verifierScriptPath = path.resolve('scripts', 'verify-evidence.mjs');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function shortWindowsPath(value: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (value.includes(' ')) return undefined;
  const result = spawnSync(
    'cmd.exe',
    ['/d', '/c', `for %I in (${value}) do @echo %~sI`],
    { encoding: 'utf8' },
  );
  const candidate = String(result.stdout ?? '').trim().split(/\r?\n/u).at(-1)?.trim();
  if (result.status !== 0 || !candidate || candidate.toLowerCase() === value.toLowerCase()) return undefined;
  return candidate;
}

function portableWorkspace() {
  return {
    requested: false,
    verified: false,
    rpcClientSource: 'not-run',
    permissionMode: 'not-run',
    approval: 'not-requested',
    providerSequence: 'not-run',
    approvalRequested: false,
    sessionCreated: false,
    sessionArchived: false,
    historyVerified: false,
    providerAuthVerified: false,
    powerShellCall: false,
    toolResult: false,
    sentinelFile: false,
    secondProviderTurn: false,
    finalNonce: false
  };
}

function portableEvidence() {
  return {
    schemaVersion: 1,
    tool: 'adhd-one-packaged-e2e',
    generatedAt: '2026-08-15T00:00:00.000Z',
    executable: 'ADHD One.exe',
    scenario: 'launch',
    portableMode: true,
    launchVerified: true,
    forceKillRequested: false,
    forceKillVerified: false,
    quitAccepted: true,
    gracefulExitVerified: true,
    exitVerified: true,
    cleanupVerified: true,
    finalScopedProcessAuditPassed: true,
    workspaceWriteRequested: false,
    workspaceWriteVerified: false,
    runtimeRollbackRequested: false,
    runtimeRollbackVerified: false,
    cyclesRequested: 1,
    cyclesCompleted: 1,
    passed: true,
    cycles: [{
      cycle: 1,
      scenario: 'launch',
      passed: true,
      launchVerified: true,
      launchMs: 1,
      controlWindowMs: 1,
      runtimeReadyMs: 1,
      exitMs: 1,
      pid: 1000,
      cdpPort: 43123,
      portableMode: true,
      controlWindowVerified: true,
      runtimeReadyVerified: true,
      hostDescribeVerified: true,
      runtimePid: 2000,
      isolationVerified: true,
      cdpClosed: true,
      runtimePidExited: true,
      processTreeExited: true,
      quitAccepted: true,
      gracefulExitVerified: true,
      exitVerified: true,
      processTreeCount: 2,
      remainingPids: [],
      exitCode: 0,
      exitSignal: null,
      forceKillRequested: false,
      forceKillVerified: false,
      forcedTermination: false,
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
      workspaceWriteVerified: false,
      workspaceWrite: portableWorkspace(),
      runtimeRollbackVerified: false,
      runtimeRollback: {
        requested: false,
        verified: false,
        candidateSeeded: false,
        bundledActive: false,
        previousCandidateRecorded: false,
        healthy: false,
        candidateCleared: false,
        rollbackMarkerRecorded: false,
        candidateSlotRetained: false,
        readyVerified: false,
        postExitVerified: false
      }
    }]
  };
}

async function writePortableEvidence(filename: string, value = portableEvidence()): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('installed E2E script contracts', () => {
  it('allows NSIS install roots containing spaces and preserves the unquoted final /D argument', async () => {
    const script = await readFile(installedScriptPath, 'utf8');
    expect(script).not.toContain("$installRoot -match '\\s'");
    expect(script).toContain('$tempRoot = [IO.Path]::GetFullPath(');
    expect(script).toContain('[IO.Directory]::CreateDirectory($runRoot)');
    expect(script).toContain('[IO.Directory]::CreateDirectory($evidence)');
    expect(script).toContain("-ArgumentList @('/S', '/currentuser', \"/D=$installRoot\")");
  });

  it('uses a bounded outer packaged-suite watchdog and preserves stable timeout codes', async () => {
    const script = await readFile(installedScriptPath, 'utf8');
    expect(script).toContain('Start-Process -FilePath $NodePath -ArgumentList $suiteArguments -PassThru -WindowStyle Hidden');
    expect(script).toContain('& taskkill.exe /PID $suite.Id /T /F');
    expect(script).toContain("$suiteTimeoutMs = if ($Suite -eq 'qualification') { 600000 } else { 1800000 }");
    expect(script).toContain('$suite.WaitForExit($suiteTimeoutMs)');
    expect(script).toContain('try { $suite.WaitForExit(15000) | Out-Null } catch {}');
    expect(script).toContain("throw 'INSTALLED_E2E_PACKAGED_SUITE_TIMEOUT'");
  });

  it('keeps uninstall timeout stable when process-tree termination or its wait throws', async () => {
    const script = await readFile(installedScriptPath, 'utf8');
    const timeoutStart = script.indexOf('if (-not $uninstall.WaitForExit(60000))');
    const timeoutEnd = script.indexOf('} else {', timeoutStart);
    expect(timeoutStart).toBeGreaterThanOrEqual(0);
    expect(timeoutEnd).toBeGreaterThan(timeoutStart);
    const timeoutBlock = script.slice(timeoutStart, timeoutEnd);
    expect(timeoutBlock).toContain('try { $uninstall.Kill($true) } catch {}');
    expect(timeoutBlock).toContain('try { $uninstall.WaitForExit(15000) | Out-Null } catch {}');
    expect(timeoutBlock).toContain("$cleanupFailures.Add('INSTALLED_E2E_UNINSTALL_TIMEOUT')");
  });

  it('bounds process audits and allowlists the packaged-suite timeout code', async () => {
    const installedScript = await readFile(installedScriptPath, 'utf8');
    const verifierScript = await readFile(verifierScriptPath, 'utf8');
    expect(installedScript).toMatch(/Get-CimInstance Win32_Process\s+-OperationTimeoutSec 15\s+-ErrorAction Stop/u);
    const allowlistStart = verifierScript.indexOf('const PRODUCTION_ERROR_CODES = new Set([');
    const allowlistEnd = verifierScript.indexOf('\n]);', allowlistStart);
    expect(allowlistStart).toBeGreaterThanOrEqual(0);
    expect(allowlistEnd).toBeGreaterThan(allowlistStart);
    expect(verifierScript.slice(allowlistStart, allowlistEnd)).toContain("'INSTALLED_E2E_PACKAGED_SUITE_TIMEOUT'");
  });

  it('tolerates NSIS registry keys disappearing while cleanup is enumerating them', async () => {
    const script = await readFile(installedScriptPath, 'utf8');
    expect(script.match(/if \(-not \(Test-Path -LiteralPath \$key\.PSPath\)\) \{ continue \}/gu)).toHaveLength(2);
  });

  it('validates one or more strict portable launch evidence files through the API and CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-portable-evidence-'));
    temporaryRoots.push(root);
    const first = path.join(root, 'release-portable-unpacked.json');
    const second = path.join(root, 'release-portable.json');
    await writePortableEvidence(first);
    await writePortableEvidence(second);

    await expect(verifyPortableEvidenceFiles([first, second])).resolves.toEqual({ ok: true, errors: [] });
    const scriptPath = path.resolve('scripts', 'verify-evidence.mjs');
    const cli = spawnSync(process.execPath, [scriptPath, '--portable', first, second], { encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(cli.stdout.trim()).toBe('PASS');
    expect(cli.stderr).toBe('');
  });

  it('rejects non-portable, non-launch, multi-cycle, and unsafe portable evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-portable-invalid-'));
    temporaryRoots.push(root);
    const file = path.join(root, 'release-portable.json');

    const nonPortable = portableEvidence();
    nonPortable.portableMode = false;
    await writePortableEvidence(file, nonPortable);
    await expect(verifyPortableEvidenceFiles([file])).resolves.toEqual({
      ok: false,
      errors: ['release-portable.json:PACKAGED_EVIDENCE_INVALID']
    });

    const nonPortableCycle = portableEvidence();
    nonPortableCycle.cycles[0].portableMode = false;
    await writePortableEvidence(file, nonPortableCycle);
    await expect(verifyPortableEvidenceFiles([file])).resolves.toEqual({
      ok: false,
      errors: ['release-portable.json:PACKAGED_EVIDENCE_INVALID']
    });

    const wrongScenario = portableEvidence();
    wrongScenario.scenario = 'force-kill';
    await writePortableEvidence(file, wrongScenario);
    await expect(verifyPortableEvidenceFiles([file])).resolves.toEqual({
      ok: false,
      errors: ['release-portable.json:PACKAGED_EVIDENCE_INVALID']
    });

    const wrongCycles = portableEvidence();
    wrongCycles.cyclesRequested = 2;
    await writePortableEvidence(file, wrongCycles);
    await expect(verifyPortableEvidenceFiles([file])).resolves.toEqual({
      ok: false,
      errors: ['release-portable.json:PACKAGED_EVIDENCE_INVALID']
    });

    const unsafe = portableEvidence() as Record<string, unknown>;
    unsafe.rawOutput = 'must-not-be-accepted';
    await writePortableEvidence(file, unsafe);
    const result = await verifyPortableEvidenceFiles([file]);
    expect(result).toEqual({
      ok: false,
      errors: ['release-portable.json:PACKAGED_EVIDENCE_INVALID']
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-accepted');
  });

  it('accepts a benign Windows 8.3 directory alias without weakening reparse checks', async context => {
    if (process.platform !== 'win32') return context.skip('Windows path-alias regression');
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-evidence-alias-'));
    temporaryRoots.push(root);
    const alias = shortWindowsPath(root);
    if (!alias) return context.skip('The Windows volume does not expose a distinct 8.3 alias');

    const result = await verifyEvidenceDirectory(alias);
    expect(result.errors[0]).toBe('launch-1.json:PACKAGED_EVIDENCE_MISSING_OR_INVALID');
    expect(result.errors).not.toContain('<directory>:EVIDENCE_DIRECTORY_INVALID');
  });
});
