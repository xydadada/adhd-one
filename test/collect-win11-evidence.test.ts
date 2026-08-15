import { describe, expect, it } from 'vitest';
import {
  qualificationMetrics,
  WIN11_EVIDENCE_COLLECTOR_ERRORS as ERROR
} from '../scripts/e2e/collect-win11-evidence.mjs';

function validQualification() {
  return {
    schemaVersion: 1,
    tool: 'adhd-one-packaged-qualification',
    generatedAt: '2026-08-15T00:00:00.000Z',
    scenario: 'qualification',
    cyclesRequested: 1,
    cyclesCompleted: 1,
    spawnVerified: true,
    coldStartVerified: true,
    restartRuntimeVerified: true,
    electronRootStable: true,
    quitAccepted: true,
    gracefulExitVerified: true,
    exitVerified: true,
    cleanupVerified: true,
    finalScopedProcessAuditPassed: true,
    passed: true,
    cycles: [{
      cycle: 1,
      scenario: 'qualification',
      passed: true,
      spawnVerified: true,
      hostToolchainPathExcluded: true,
      executableSha256: 'a'.repeat(64),
      spawnToControlWindowMs: 1200,
      controlWindowVerified: true,
      controlWindowOperational: true,
      coldRuntimeReadyVerified: true,
      coldGeneration: 1,
      restartRequested: true,
      restartRuntimeAccepted: true,
      restartReadyVerified: true,
      restartToReadyMs: 700,
      idleCpuMeasured: true,
      idleCpuPercent: 0.25,
      idleCpuProcessCount: 4,
      hotGeneration: 2,
      electronRootStable: true,
      coldProcessTreeObserved: true,
      hotProcessTreeObserved: true,
      coldProcessTreeCount: 3,
      hotProcessTreeCount: 3,
      mergedProcessTreeCount: 4,
      processTreeExited: true,
      quitAccepted: true,
      quitToExitMs: 300,
      gracefulExitVerified: true,
      forcedTermination: false,
      exitCode: 0,
      exitSignal: null,
      exitVerified: true,
      cdpClosed: true,
      cleanup: 'removed',
      cleanupRootExisted: true,
      cleanupRootAbsent: true,
      cleanupVerified: true,
      finalScopedProcessAuditPassed: true,
      finalScopedProcessAuditCount: 0
    }]
  };
}

describe('Windows 11 evidence collector mapping', () => {
  it('maps only verified qualification metrics into the builder input', () => {
    expect(qualificationMetrics(validQualification())).toEqual({
      firstInteractiveMs: 1200,
      hotStartReadyMs: 700,
      idleCpuPercent: 0.25,
      exitMs: 300,
      residualProcesses: 0,
      executableSha256: 'a'.repeat(64)
    });
  });

  it.each([
    ['passed', false],
    ['finalScopedProcessAuditPassed', false]
  ])('rejects a failed top-level gate %s', (key, value) => {
    const input = validQualification();
    (input as Record<string, unknown>)[key] = value;
    expect(() => qualificationMetrics(input)).toThrow(ERROR.INPUT_INVALID);
  });

  it.each([
    ['idleCpuMeasured', false],
    ['idleCpuProcessCount', 0],
    ['finalScopedProcessAuditCount', 1],
    ['forcedTermination', true],
    ['idleCpuPercent', Number.NaN]
  ])('rejects an untrusted cycle field %s', (key, value) => {
    const input = validQualification();
    (input.cycles[0] as Record<string, unknown>)[key] = value;
    expect(() => qualificationMetrics(input)).toThrow(ERROR.INPUT_INVALID);
  });

  it('rejects error-bearing, duplicate, or missing cycle evidence', () => {
    const errored = validQualification();
    (errored.cycles[0] as Record<string, unknown>).errorCode = 'QUALIFICATION_FAILED';
    expect(() => qualificationMetrics(errored)).toThrow(ERROR.INPUT_INVALID);

    const duplicate = validQualification();
    duplicate.cycles.push({ ...duplicate.cycles[0] });
    expect(() => qualificationMetrics(duplicate)).toThrow(ERROR.INPUT_INVALID);

    const missing = validQualification();
    missing.cycles = [];
    expect(() => qualificationMetrics(missing)).toThrow(ERROR.INPUT_INVALID);
  });
});
