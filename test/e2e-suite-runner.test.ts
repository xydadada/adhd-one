import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACKAGED_SCRIPT_PATH,
  PACKAGED_SUITE_STEPS,
  parseSuiteArgs,
  runPackagedSuite
} from '../scripts/e2e/run-packaged-suite.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function argumentValue(args: string[], name: string) {
  return args[args.indexOf(name) + 1];
}

function fakeSpawnFactory(calls: Array<{ command: string; args: string[]; options: unknown }>, failingIndex = -1) {
  return (command: string, args: string[], options: unknown) => {
    const callIndex = calls.length;
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    queueMicrotask(() => {
      void (async () => {
        if (callIndex !== failingIndex) {
          const outputPath = argumentValue(args, '--output');
          const scenario = argumentValue(args, '--scenario');
          const cycles = Number(argumentValue(args, '--cycles'));
          await writeFile(outputPath, `${JSON.stringify({
            schemaVersion: 1,
            tool: 'adhd-one-packaged-e2e',
            generatedAt: new Date().toISOString(),
            passed: true,
            scenario,
            launchVerified: true,
            exitVerified: true,
            cleanupVerified: true,
            forceKillRequested: scenario === 'force-kill',
            forceKillVerified: scenario === 'force-kill',
            workspaceWriteRequested: scenario === 'workspace-write',
            workspaceWriteVerified: scenario === 'workspace-write',
            cyclesRequested: cycles,
            cyclesCompleted: cycles,
            cycles: Array.from({ length: cycles }, (_, index) => ({
              cycle: index + 1,
              scenario,
              passed: true,
              launchVerified: true,
              cleanupVerified: true,
              exitVerified: true,
              cdpClosed: true,
              processTreeExited: true,
              runtimePidExited: true,
              remainingPids: [],
              forceKillVerified: scenario === 'force-kill',
              workspaceWriteVerified: scenario === 'workspace-write'
            }))
          })}\n`, 'utf8');
        }
        child.emit('close', callIndex === failingIndex ? 17 : 0, null);
      })();
    });
    return child;
  };
}

describe('packaged suite runner', () => {
  it('accepts only exe/evidence-dir and rejects scenario controls', () => {
    const exe = path.join(os.tmpdir(), 'ADHD One.exe');
    const evidenceDir = path.join(os.tmpdir(), 'packaged-suite-evidence');
    expect(parseSuiteArgs(['--exe', exe, '--evidence-dir', evidenceDir])).toEqual({
      help: false,
      exe: path.resolve(exe),
      evidenceDir: path.resolve(evidenceDir)
    });
    expect(() => parseSuiteArgs(['--exe', exe, '--evidence-dir', evidenceDir, '--cycles', '10']))
      .toThrow('PACKAGED_SUITE_INVALID_ARGUMENT');
  });

  it('calls the four fixed scenarios in order with independent evidence files', async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-suite-test-'));
    temporaryRoots.push(evidenceDir);
    const exe = path.join(evidenceDir, 'ADHD One.exe');
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];

    const result = await runPackagedSuite({
      exe,
      evidenceDir,
      spawnImpl: fakeSpawnFactory(calls)
    });

    expect(result.steps.map(step => step.id)).toEqual(PACKAGED_SUITE_STEPS.map(step => step.id));
    expect(calls).toHaveLength(4);
    expect(calls.map(call => ({
      command: call.command,
      script: call.args[0],
      exe: argumentValue(call.args, '--exe'),
      output: path.basename(argumentValue(call.args, '--output')),
      scenario: argumentValue(call.args, '--scenario'),
      cycles: argumentValue(call.args, '--cycles')
    }))).toEqual([
      { command: process.execPath, script: PACKAGED_SCRIPT_PATH, exe: path.resolve(exe), output: 'launch-1.json', scenario: 'launch', cycles: '1' },
      { command: process.execPath, script: PACKAGED_SCRIPT_PATH, exe: path.resolve(exe), output: 'force-kill-1.json', scenario: 'force-kill', cycles: '1' },
      { command: process.execPath, script: PACKAGED_SCRIPT_PATH, exe: path.resolve(exe), output: 'workspace-write-1.json', scenario: 'workspace-write', cycles: '1' },
      { command: process.execPath, script: PACKAGED_SCRIPT_PATH, exe: path.resolve(exe), output: 'launch-10.json', scenario: 'launch', cycles: '10' }
    ]);
    await expect(readFile(path.join(evidenceDir, 'workspace-write-1.json'), 'utf8')).resolves.toContain('workspace-write');
  });

  it('stops immediately on the first non-zero packaged child', async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-suite-test-'));
    temporaryRoots.push(evidenceDir);
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];

    await expect(runPackagedSuite({
      exe: path.join(evidenceDir, 'ADHD One.exe'),
      evidenceDir,
      spawnImpl: fakeSpawnFactory(calls, 1)
    })).rejects.toMatchObject({
      code: 'PACKAGED_SUITE_FORCE_KILL_FAILED',
      suiteExitCode: 1
    });
    expect(calls).toHaveLength(2);
  });

  it('rejects a top-level pass when cycle cleanup evidence is incomplete', async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-suite-test-'));
    temporaryRoots.push(evidenceDir);
    const spawnImpl = (_command: string, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        void writeFile(argumentValue(args, '--output'), JSON.stringify({
          passed: true,
          scenario: argumentValue(args, '--scenario'),
          cyclesRequested: 1,
          cyclesCompleted: 1,
          cycles: [{ passed: true, cleanupVerified: false }]
        })).then(() => child.emit('close', 0, null));
      });
      return child;
    };

    await expect(runPackagedSuite({
      exe: path.join(evidenceDir, 'ADHD One.exe'),
      evidenceDir,
      spawnImpl
    })).rejects.toMatchObject({ code: 'PACKAGED_SUITE_EVIDENCE_INVALID' });
  });
});
