import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_SCENARIOS,
  isHostToolchainPathExcluded,
  parseArgs,
  sanitizeQualificationEvidence
} from '../scripts/e2e/packaged.mjs';

const packagedScriptPath = path.resolve('scripts', 'e2e', 'packaged.mjs');

describe('packaged qualification contracts', () => {
  it('keeps the fixed E2E scenario set separate from the CLI qualification scenario', async () => {
    const script = await readFile(packagedScriptPath, 'utf8');

    expect(script).toContain("const E2E_SCENARIOS = new Set(['launch', 'force-kill', 'workspace-write', 'runtime-rollback']);");
    expect(script).toContain("new Set([...E2E_SCENARIOS, 'qualification'])");
    expect(CLI_SCENARIOS.has('qualification')).toBe(true);
    expect(CLI_SCENARIOS.has('launch')).toBe(true);
    expect(script).toContain("QUALIFICATION_EVIDENCE_TOOL = 'adhd-one-packaged-qualification'");
    expect(script).toContain("scenario === 'qualification' ? 'qualification-evidence.json' : 'packaged-evidence.json'");
  });

  it('parses qualification and forces one cycle without changing legacy CLI boundaries', () => {
    expect(parseArgs([
      '--exe', 'C:\\release\\ADHD One.exe',
      '--output', 'C:\\evidence\\qualification',
      '--scenario', 'qualification',
      '--cycles', '10'
    ])).toMatchObject({
      exe: 'C:\\release\\ADHD One.exe',
      output: 'C:\\evidence\\qualification',
      scenario: 'qualification',
      cycles: 1,
      requirePortable: false
    });

    expect(parseArgs(['--exe=x.exe', '--output=result.json'])).toMatchObject({
      scenario: 'launch',
      cycles: 1
    });
    expect(() => parseArgs(['--exe', 'app.exe', '--output', 'result.json', '--scenario', 'not-a-scenario']))
      .toThrow(/scenario/iu);
    expect(() => parseArgs(['--exe', 'app.exe', '--output', 'result.json', '--cycles', '0']))
      .toThrow(/cycles/iu);
    expect(() => parseArgs(['--exe', 'app.exe', '--output', 'result.json', '--cycles', '101']))
      .toThrow(/cycles/iu);
    expect(() => parseArgs(['--exe', 'app.exe', '--output', 'result.json', '--exe', 'again.exe']))
      .toThrow(/duplicate/iu);
    expect(() => parseArgs(['--exe', 'app.exe', '--output', 'result.json', '--require-portable=true']))
      .toThrow(/require-portable/iu);
    expect(() => parseArgs(undefined as unknown as string[])).toThrow('INVALID_ARGUMENT');
  });

  it('sanitizes qualification evidence independently and drops paths, raw text, and extra cycles', () => {
    const value = sanitizeQualificationEvidence({
      generatedAt: '2026-08-15T00:00:00.000Z',
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
      rawOutput: 'C:\\Users\\Alice\\secret',
      cpu: 99,
      host: 'Alice-PC',
      sha256: 'deadbeef',
      cycles: [{
        cycle: 1,
        passed: true,
        spawnVerified: true,
        hostToolchainPathExcluded: true,
        spawnToControlWindowMs: 12,
        controlWindowVerified: true,
        controlWindowOperational: true,
        coldRuntimeReadyVerified: true,
        coldGeneration: 1,
        restartRequested: true,
        restartRuntimeAccepted: true,
        restartReadyVerified: true,
        restartToReadyMs: 45,
        idleCpuMeasured: true,
        idleCpuPercent: 0.25,
        idleCpuProcessCount: 3,
        hotGeneration: 2,
        electronRootStable: true,
        coldProcessTreeObserved: true,
        hotProcessTreeObserved: true,
        coldProcessTreeCount: 2,
        hotProcessTreeCount: 2,
        mergedProcessTreeCount: 3,
        processTreeExited: true,
        quitAccepted: true,
        quitToExitMs: 25,
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
        finalScopedProcessAuditCount: 0,
        errorCode: new Error('C:\\Users\\Alice\\AppData\\Local\\secret')
      }, {
        cycle: 2,
        passed: true,
        rawOutput: 'must not escape'
      }]
    });

    expect(value).toMatchObject({
      schemaVersion: 1,
      tool: 'adhd-one-packaged-qualification',
      scenario: 'qualification',
      cyclesRequested: 1,
      cyclesCompleted: 1,
      passed: true
    });
    expect(value.cycles).toHaveLength(1);
    expect(value.cycles[0]).toMatchObject({
      scenario: 'qualification',
      hostToolchainPathExcluded: true,
      coldGeneration: 1,
      hotGeneration: 2,
      idleCpuMeasured: true,
      idleCpuPercent: 0.25,
      idleCpuProcessCount: 3,
      electronRootStable: true,
      quitToExitMs: 25,
      forcedTermination: false,
      errorCode: 'QUALIFICATION_FAILED'
    });
    expect(JSON.stringify(value)).not.toMatch(/Alice|secret|AppData|rawOutput|"cpu":|"host":|sha256|deadbeef/iu);
  });

  it('proves the app launch environment excludes the inherited host toolchain PATH', () => {
    expect(isHostToolchainPathExcluded({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32'
    })).toBe(true);
    expect(isHostToolchainPathExcluded({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Program Files\\nodejs;C:\\Windows\\System32'
    })).toBe(false);
    expect(isHostToolchainPathExcluded({ PATH: 'C:\\Windows\\System32' })).toBe(false);
  });

  it('cannot sanitize a forced termination as a passing qualification', () => {
    const value = sanitizeQualificationEvidence({
      passed: true,
      cycles: [{
        passed: true,
        forcedTermination: true,
        errorCode: 'C:\\private\\failure'
      }]
    });

    expect(value.passed).toBe(false);
    expect(value.cycles[0]?.passed).toBe(false);
    expect(value.cycles[0]?.forcedTermination).toBe(true);
    expect(value.cycles[0]?.errorCode).toBe('QUALIFICATION_FAILED');
    expect(JSON.stringify(value)).not.toContain('private');
  });

  it.each([
    ['spawnToControlWindowMs', 15_001],
    ['restartToReadyMs', 8_001],
    ['idleCpuPercent', 1],
    ['quitToExitMs', 5_001]
  ])('fails closed when %s exceeds the qualification limit', (field, value) => {
    const cycle = {
      passed: true,
      hostToolchainPathExcluded: true,
      spawnToControlWindowMs: 1,
      restartToReadyMs: 1,
      idleCpuMeasured: true,
      idleCpuPercent: 0.5,
      idleCpuProcessCount: 3,
      quitToExitMs: 1,
      forcedTermination: false,
      [field]: value
    };
    expect(sanitizeQualificationEvidence({ passed: true, cycles: [cycle] }).passed).toBe(false);
  });

  it('fails closed when the real CPU measurement marker or process count is missing', () => {
    const base = {
      passed: true,
      hostToolchainPathExcluded: true,
      spawnToControlWindowMs: 1,
      restartToReadyMs: 1,
      idleCpuMeasured: true,
      idleCpuPercent: 0.1,
      idleCpuProcessCount: 3,
      quitToExitMs: 1,
      forcedTermination: false
    };
    expect(sanitizeQualificationEvidence({ passed: true, cycles: [{ ...base, idleCpuMeasured: false }] }).passed).toBe(false);
    expect(sanitizeQualificationEvidence({ passed: true, cycles: [{ ...base, idleCpuProcessCount: 0 }] }).passed).toBe(false);
  });

  it('statically requires the same ControlWindow/profile flow, generation gate, merged audit, and quit timing', async () => {
    const script = await readFile(packagedScriptPath, 'utf8');
    const qualificationStart = script.indexOf('async function runQualificationCycle');
    const qualificationEnd = script.indexOf('async function runCycle', qualificationStart);
    expect(qualificationStart).toBeGreaterThanOrEqual(0);
    expect(qualificationEnd).toBeGreaterThan(qualificationStart);
    const qualification = script.slice(qualificationStart, qualificationEnd);

    expect(qualification.match(/spawn\(/gu)).toHaveLength(1);
    expect(qualification).toContain('waitForControlWindow(browser, child, exitPromise)');
    expect(qualification).toContain('isHostToolchainPathExcluded(environment)');
    expect(qualification).toContain('control.evaluate(() => window.adhdOne.restartRuntime())');
    expect(qualification).toContain('waitForRuntimeReady(control, child, exitPromise, minimumGeneration)');
    expect(qualification).toContain('mergeProcessTrees(coldTree, hotTree)');
    expect(qualification).toContain('measureWindowsProcessCpu({ rootPid: child.pid })');
    expect(qualification).toContain('record.idleCpuPercent < QUALIFICATION_LIMITS.idleCpuPercent');
    expect(qualification).not.toMatch(/requestHostDescribe|host\.describe|sha256|hash/iu);

    const terminationStart = script.indexOf('async function terminateQualificationApplication');
    const terminationEnd = script.indexOf('async function prepareRun', terminationStart);
    const termination = script.slice(terminationStart, terminationEnd);
    expect(termination.indexOf('quitStartedAt = performance.now()')).toBeGreaterThanOrEqual(0);
    expect(termination.indexOf('quitStartedAt = performance.now()'))
      .toBeLessThan(termination.indexOf('control.evaluate(() => window.adhdOne.quitApp())'));
    expect(qualification).toContain('&& !record.forcedTermination');
    expect(script).toContain('minimumGeneration = 0');
  });
});
