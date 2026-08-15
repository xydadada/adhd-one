import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  cdpClosed,
  hasObservedProcessTree,
  isValidCdpWebSocketUrl,
  sanitizeEvidence,
  scopedProcessKind,
  shouldCopyPortableEntry,
  stableErrorCode,
  stableStageErrorCode,
  verifyRuntimeRollbackState,
  waitForCdp,
  waitForProcessTree
} from '../scripts/e2e/packaged.mjs';

describe('packaged E2E evidence safety', () => {
  it('never copies existing portable user data into a clean E2E app clone', () => {
    const root = path.resolve('portable-fixture', 'ADHD-One');
    expect(shouldCopyPortableEntry(root, root)).toBe(true);
    expect(shouldCopyPortableEntry(root, path.join(root, 'resources', 'portable.marker'))).toBe(true);
    expect(shouldCopyPortableEntry(root, path.join(root, 'portable-data'))).toBe(false);
    expect(shouldCopyPortableEntry(root, path.join(root, 'portable-data', 'settings.json'))).toBe(false);
    expect(shouldCopyPortableEntry(root, path.join(root, 'portable-data-backup', 'settings.json'))).toBe(true);
  });

  it('keeps only the evidence allowlist and never serializes raw output or paths', () => {
    const value = sanitizeEvidence({
      generatedAt: '2026-08-14T00:00:00.000Z',
      executable: 'C:\\Users\\Alice\\secret\\ADHD One.exe',
      cyclesRequested: 1,
      cyclesCompleted: 1,
      passed: false,
      rawEnvironment: { DEEPSEEK_API_KEY: 'sk-super-secret' },
      cycles: [{
        cycle: 1,
        passed: false,
        errorCode: new Error('C:\\Users\\Alice\\AppData Authorization: Bearer token EADDRINUSE'),
        stdout: 'sk-super-secret',
        stderr: 'C%3A%5CUsers%5CAlice',
        stdoutBytes: 12,
        stderrBytes: 18,
        remainingPids: [123, 'C:\\private'],
        finalScopedProcessAuditKinds: ['known-ancestor', 'C:\\private'],
        cleanup: 'failed'
      }]
    });

    const serialized = JSON.stringify(value);
    expect(value.executable).toBe('ADHD One.exe');
    expect(value.cycles[0]?.errorCode).toBe('EADDRINUSE');
    expect(value.cycles[0]?.remainingPids).toEqual([123]);
    expect(value.cycles[0]?.finalScopedProcessAuditKinds).toEqual(['known-ancestor']);
    expect(serialized).not.toMatch(/Alice|AppData|Authorization|super-secret|rawEnvironment|stdout"|stderr"|%5C/iu);
  });

  it('maps arbitrary provider text to a stable generic code', () => {
    expect(stableErrorCode('provider said user body text')).toBe('E2E_ERROR');
    expect(stableErrorCode('Authorization: Bearer MY_SECRET_TOKEN')).toBe('E2E_ERROR');
    expect(stableErrorCode({ code: 'SECRET_IDENTIFIER' })).toBe('E2E_ERROR');
  });

  it('treats only an explicit loopback connection refusal as a closed CDP port', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    await expect(cdpClosed(address.port)).resolves.toBe(false);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await expect(cdpClosed(address.port)).resolves.toBe(true);
  });

  it('accepts only loopback ws URLs with the exact CDP port', () => {
    expect(isValidCdpWebSocketUrl('ws://127.0.0.1:43123/devtools/browser/id', 43123)).toBe(true);
    expect(isValidCdpWebSocketUrl('wss://[::1]:43123/devtools/browser/id', 43123)).toBe(true);
    expect(isValidCdpWebSocketUrl('http://127.0.0.1:43123/json/version', 43123)).toBe(false);
    expect(isValidCdpWebSocketUrl('ws://127.0.0.1:43124/devtools/browser/id', 43123)).toBe(false);
    expect(isValidCdpWebSocketUrl('ws://example.test:43123/devtools/browser/id', 43123)).toBe(false);
    expect(isValidCdpWebSocketUrl('ws://user:pass@127.0.0.1:43123/devtools/browser/id', 43123)).toBe(false);
  });

  it('returns the HTTP discovery endpoint after validating /json/version', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: calls++ === 0
          ? 'http://127.0.0.1:43123/json/version'
          : 'ws://127.0.0.1:43123/devtools/browser/id'
      })
    } as Response);
    try {
      await expect(waitForCdp(43123, { exitCode: null, signalCode: null })).resolves
        .toBe('http://127.0.0.1:43123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps raw stage failures to stable stage-specific codes', () => {
    expect(stableStageErrorCode(new Error('Timeout 5000ms exceeded: secret path'), 'HOST_DESCRIBE_FAILED', 'HOST_DESCRIBE_TIMEOUT'))
      .toBe('HOST_DESCRIBE_TIMEOUT');
    expect(stableStageErrorCode({ code: 'ETIMEDOUT' }, 'HOST_DESCRIBE_FAILED', 'HOST_DESCRIBE_TIMEOUT'))
      .toBe('HOST_DESCRIBE_TIMEOUT');
    expect(stableStageErrorCode(new Error('provider returned an opaque body'), 'RUNTIME_SNAPSHOT_EVALUATE_FAILED', 'RUNTIME_SNAPSHOT_EVALUATE_TIMEOUT'))
      .toBe('RUNTIME_SNAPSHOT_EVALUATE_FAILED');
  });

  it('retries a transiently empty Windows process snapshot until the runtime is linked to the Electron root', async () => {
    let calls = 0;
    const root = { pid: 100, parentPid: 1, name: 'ADHD One.exe', executablePath: 'C:\\ADHD One.exe', created: '20260815120000.000000+000' };
    const runtime = { pid: 200, parentPid: 100, name: 'node.exe', executablePath: 'C:\\node.exe', created: '20260815120001.000000+000' };
    const tree = await waitForProcessTree(async () => (++calls === 1 ? [] : [root, runtime]), 100, 200, 1_000, 0);

    expect(calls).toBe(2);
    expect(tree.map(item => item.pid)).toEqual([100, 200]);
  });

  it('retries a transient Windows process snapshot failure', async () => {
    let calls = 0;
    const root = { pid: 100, parentPid: 1, name: 'ADHD One.exe', executablePath: 'C:\\ADHD One.exe', created: '20260815120000.000000+000' };
    const runtime = { pid: 200, parentPid: 100, name: 'node.exe', executablePath: 'C:\\node.exe', created: '20260815120001.000000+000' };
    const tree = await waitForProcessTree(async () => {
      if (++calls === 1) throw new Error('transient CIM timeout');
      return [root, runtime];
    }, 100, 200, 1_000, 0);

    expect(calls).toBe(2);
    expect(tree.map(item => item.pid)).toEqual([100, 200]);
  });

  it('does not attach an orphan whose stale parent PID was reused by Electron', async () => {
    const root = { pid: 100, parentPid: 1, created: '20260815120000.000000+000' };
    const runtime = { pid: 200, parentPid: 100, created: '20260815120001.000000+000' };
    const staleOrphan = { pid: 300, parentPid: 100, created: '20260814120000.000000+000' };
    const staleDescendant = { pid: 400, parentPid: 300, created: '20260814120001.000000+000' };

    const tree = await waitForProcessTree(
      async () => [root, runtime, staleOrphan, staleDescendant],
      root.pid,
      runtime.pid,
      0,
      0
    );

    expect(tree.map(item => item.pid)).toEqual([100, 200]);
  });

  it.each(['', 'not-a-wmi-date'])('does not attach a child with unprovable CreationDate %j', async created => {
    const root = { pid: 100, parentPid: 1, created: '20260815120000.000000+000' };
    const runtime = { pid: 200, parentPid: 100, created: '20260815120001.000000+000' };
    const unproven = { pid: 300, parentPid: 100, created };

    const tree = await waitForProcessTree(async () => [root, runtime, unproven], 100, 200, 0, 0);

    expect(tree.map(item => item.pid)).toEqual([100, 200]);
  });

  it('requires both the Electron root and runtime before treating a process tree as observed', () => {
    const root = { pid: 100, parentPid: 1 };
    const runtime = { pid: 200, parentPid: 100 };

    expect(hasObservedProcessTree([root, runtime], 100, 200)).toBe(true);
    expect(hasObservedProcessTree([], 100, 200)).toBe(false);
    expect(hasObservedProcessTree([root], 100, 200)).toBe(false);
  });

  it('does not claim an unrelated same-path process without this E2E launch markers', () => {
    const item = { pid: 300, parentPid: 1, executablePath: 'C:\\ADHD One.exe', created: '20260815000000.000000+000', commandLine: '"C:\\ADHD One.exe"' };
    const scope = { knownByPid: new Map(), knownPids: new Set(), startedAt: 0, tempRoots: [], executablePaths: ['C:\\ADHD One.exe'], commandMarkers: ['--user-data-dir=C:\\e2e', '--remote-debugging-port=43123'] };

    expect(scopedProcessKind(item, new Map(), scope)).toBeUndefined();
    expect(scopedProcessKind({ ...item, commandLine: `${item.commandLine} ${scope.commandMarkers.join(' ')}` }, new Map(), scope)).toBe('launch-executable');
  });

  it('keeps workspace-write evidence to booleans and enums', () => {
    const value = sanitizeEvidence({
      scenario: 'workspace-write',
      portableMode: true,
      workspaceWriteVerified: true,
      quitAccepted: true,
      gracefulExitVerified: true,
      cleanupVerified: true,
      cyclesRequested: 1,
      cyclesCompleted: 1,
      passed: true,
      cycles: [{
        cycle: 1,
        scenario: 'workspace-write',
        passed: true,
        portableMode: true,
        workspaceWriteVerified: true,
        quitAccepted: true,
        gracefulExitVerified: true,
        cleanup: 'removed',
        cleanupVerified: true,
        finalScopedProcessAuditPassed: true,
        workspaceWrite: {
          verified: true,
          rpcClientSource: 'packaged-asar',
          permissionMode: 'workspace-write',
          approval: 'not-requested',
          providerSequence: 'matched',
          approvalRequested: false,
          sessionCreated: true,
          sessionArchived: true,
          historyVerified: true,
          providerAuthVerified: true,
          powerShellCall: true,
          toolResult: true,
          sentinelFile: true,
          secondProviderTurn: true,
          finalNonce: true,
          sessionId: 'session-must-not-escape',
          nonce: 'nonce-must-not-escape',
          sentinelPath: 'C:\\private\\sentinel.txt',
          runtimeUrl: 'http://127.0.0.1:43123',
          DEEPSEEK_API_KEY: 'fake-key-must-not-escape'
        }
      }]
    });

    expect(value.workspaceWriteRequested).toBe(true);
    expect(value.portableMode).toBe(true);
    expect(value.quitAccepted).toBe(true);
    expect(value.gracefulExitVerified).toBe(true);
    expect(value.cleanupVerified).toBe(true);
    expect(value.workspaceWriteVerified).toBe(true);
    expect(value.cycles[0]?.workspaceWrite).toEqual({
      requested: true,
      verified: true,
      rpcClientSource: 'packaged-asar',
      permissionMode: 'workspace-write',
      approval: 'not-requested',
      providerSequence: 'matched',
      approvalRequested: false,
      sessionCreated: true,
      sessionArchived: true,
      historyVerified: true,
      providerAuthVerified: true,
      powerShellCall: true,
      toolResult: true,
      sentinelFile: true,
      secondProviderTurn: true,
      finalNonce: true
    });
    expect(value.cycles[0]).toMatchObject({
      portableMode: true,
      quitAccepted: true,
      gracefulExitVerified: true,
      cleanup: 'removed',
      cleanupVerified: true,
      finalScopedProcessAuditPassed: true
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toMatch(/session-must-not-escape|nonce-must-not-escape|private|43123|fake-key-must-not-escape|runtimeUrl|sentinelPath/iu);
  });

  it('keeps runtime rollback evidence to booleans only', () => {
    const value = sanitizeEvidence({
      scenario: 'runtime-rollback',
      runtimeRollbackVerified: true,
      cycles: [{
        cycle: 1,
        scenario: 'runtime-rollback',
        runtimeRollbackVerified: true,
        runtimeRollback: {
          verified: true,
          candidateSeeded: true,
          bundledActive: true,
          previousCandidateRecorded: true,
          healthy: true,
          candidateCleared: true,
          rollbackMarkerRecorded: true,
          candidateSlotRetained: true,
          readyVerified: true,
          postExitVerified: true,
          version: '999.0.0-e2e-broken',
          stateFile: 'C:\\Users\\Alice\\AppData\\runtime-state.json',
          rawState: { token: 'secret-must-not-escape' }
        }
      }]
    });

    expect(value.runtimeRollbackRequested).toBe(true);
    expect(value.runtimeRollbackVerified).toBe(true);
    expect(value.cycles[0]?.runtimeRollback).toEqual({
      requested: true,
      verified: true,
      candidateSeeded: true,
      bundledActive: true,
      previousCandidateRecorded: true,
      healthy: true,
      candidateCleared: true,
      rollbackMarkerRecorded: true,
      candidateSlotRetained: true,
      readyVerified: true,
      postExitVerified: true
    });
    expect(JSON.stringify(value)).not.toMatch(/Alice|AppData|stateFile|rawState|secret-must-not-escape|999\.0\.0/iu);
  });

  it('verifies persisted bundled rollback without exposing the state body', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-rollback-evidence-'));
    try {
      const runtimes = path.join(root, 'runtimes');
      const candidateSlot = path.join(runtimes, 'slot-B');
      const packageDirectory = path.join(candidateSlot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '998.0.0-e2e-mismatch'
      }));
      await writeFile(path.join(runtimes, 'runtime-state.json'), JSON.stringify({
        schemaVersion: 1,
        active: 'bundled',
        previous: 'B',
        version: '0.1.0-rc.6',
        healthy: true,
        candidate: false,
        rolledBackFrom: 'B'
      }));
      await expect(verifyRuntimeRollbackState(runtimes, candidateSlot, { slot: 'bundled' })).resolves.toEqual({
        verified: true,
        candidateSeeded: true,
        bundledActive: true,
        previousCandidateRecorded: true,
        healthy: true,
        candidateCleared: true,
        rollbackMarkerRecorded: true,
        candidateSlotRetained: true
      });
      await expect(readFile(path.join(runtimes, 'runtime-state.json'), 'utf8')).resolves.toContain('rolledBackFrom');
      await writeFile(path.join(packageDirectory, 'package.json'), '{}');
      await expect(verifyRuntimeRollbackState(runtimes, candidateSlot, { slot: 'bundled' })).resolves.toMatchObject({
        verified: false,
        candidateSeeded: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
