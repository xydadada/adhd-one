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

type EvidenceMutator = (evidence: Record<string, unknown>, cycles: Array<Record<string, unknown>>) => void;

function fakeSpawnFactory(
  calls: Array<{ command: string; args: string[]; options: unknown }>,
  failingIndex = -1,
  mutateEvidence?: EvidenceMutator
) {
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
          const evidence = {
            schemaVersion: 1,
            tool: 'adhd-one-packaged-e2e',
            generatedAt: new Date().toISOString(),
            passed: true,
            scenario,
            portableMode: false,
            launchVerified: true,
            quitAccepted: scenario !== 'force-kill',
            gracefulExitVerified: scenario !== 'force-kill',
            exitVerified: true,
            cleanup: 'removed',
            cleanupVerified: true,
            finalScopedProcessAuditPassed: true,
            forceKillRequested: scenario === 'force-kill',
            forceKillVerified: scenario === 'force-kill',
            workspaceWriteRequested: scenario === 'workspace-write',
            workspaceWriteVerified: scenario === 'workspace-write',
            runtimeRollbackRequested: scenario === 'runtime-rollback',
            runtimeRollbackVerified: scenario === 'runtime-rollback',
            cyclesRequested: cycles,
            cyclesCompleted: cycles,
            cycles: Array.from({ length: cycles }, (_, index) => ({
              cycle: index + 1,
              scenario,
              passed: true,
              portableMode: false,
              launchVerified: true,
              quitAccepted: scenario !== 'force-kill',
              gracefulExitVerified: scenario !== 'force-kill',
              cleanupVerified: true,
              cleanup: 'removed',
              finalScopedProcessAuditPassed: true,
              exitVerified: true,
              cdpClosed: true,
              processTreeExited: true,
              runtimePidExited: true,
              remainingPids: [],
              forceKillVerified: scenario === 'force-kill',
              workspaceWriteVerified: scenario === 'workspace-write',
              runtimeRollbackVerified: scenario === 'runtime-rollback'
            }))
          };
          mutateEvidence?.(
            evidence as unknown as Record<string, unknown>,
            evidence.cycles as unknown as Array<Record<string, unknown>>
          );
          await writeFile(outputPath, `${JSON.stringify(evidence)}\n`, 'utf8');
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

  it('calls the five fixed scenarios in order with independent evidence files', async () => {
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
    expect(calls).toHaveLength(5);
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
      { command: process.execPath, script: PACKAGED_SCRIPT_PATH, exe: path.resolve(exe), output: 'runtime-rollback-1.json', scenario: 'runtime-rollback', cycles: '1' },
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

  const contractNegativeCases: Array<{ name: string; mutate: EvidenceMutator }> = [
    {
      name: 'portableMode is omitted',
      mutate: (evidence, cycles) => {
        delete evidence.portableMode;
        cycles.forEach(cycle => delete cycle.portableMode);
      }
    },
    {
      name: 'quitAccepted is omitted',
      mutate: (evidence, cycles) => {
        delete evidence.quitAccepted;
        cycles.forEach(cycle => delete cycle.quitAccepted);
      }
    },
    {
      name: 'quitAccepted is false',
      mutate: (evidence, cycles) => {
        evidence.quitAccepted = false;
        cycles.forEach(cycle => { cycle.quitAccepted = false; });
      }
    },
    {
      name: 'gracefulExitVerified is omitted',
      mutate: (evidence, cycles) => {
        delete evidence.gracefulExitVerified;
        cycles.forEach(cycle => delete cycle.gracefulExitVerified);
      }
    },
    {
      name: 'gracefulExitVerified is false',
      mutate: (evidence, cycles) => {
        evidence.gracefulExitVerified = false;
        cycles.forEach(cycle => { cycle.gracefulExitVerified = false; });
      }
    },
    {
      name: 'cleanupVerified is omitted',
      mutate: (evidence, cycles) => {
        delete evidence.cleanupVerified;
        cycles.forEach(cycle => delete cycle.cleanupVerified);
      }
    },
    {
      name: 'cleanupVerified is false',
      mutate: (evidence, cycles) => {
        evidence.cleanupVerified = false;
        cycles.forEach(cycle => { cycle.cleanupVerified = false; });
      }
    },
    {
      name: 'cleanup is omitted',
      mutate: (evidence, cycles) => {
        delete evidence.cleanup;
        cycles.forEach(cycle => delete cycle.cleanup);
      }
    },
    {
      name: 'cleanup is not removed',
      mutate: (evidence, cycles) => {
        evidence.cleanup = 'failed';
        cycles.forEach(cycle => { cycle.cleanup = 'failed'; });
      }
    },
    {
      name: 'top-level finalScopedProcessAuditPassed is omitted',
      mutate: (evidence) => {
        delete evidence.finalScopedProcessAuditPassed;
      }
    },
    {
      name: 'top-level finalScopedProcessAuditPassed is false',
      mutate: (evidence) => {
        evidence.finalScopedProcessAuditPassed = false;
      }
    },
    {
      name: 'cycle finalScopedProcessAuditPassed is omitted',
      mutate: (_evidence, cycles) => {
        cycles.forEach(cycle => delete cycle.finalScopedProcessAuditPassed);
      }
    },
    {
      name: 'cycle finalScopedProcessAuditPassed is false',
      mutate: (_evidence, cycles) => {
        cycles.forEach(cycle => { cycle.finalScopedProcessAuditPassed = false; });
      }
    }
  ];

  it.each(contractNegativeCases)('rejects evidence when $name', async ({ mutate }) => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-suite-contract-test-'));
    temporaryRoots.push(evidenceDir);
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];

    await expect(runPackagedSuite({
      exe: path.join(evidenceDir, 'ADHD One.exe'),
      evidenceDir,
      spawnImpl: fakeSpawnFactory(calls, -1, mutate)
    })).rejects.toMatchObject({ code: 'PACKAGED_SUITE_EVIDENCE_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it('exempts force-kill from graceful quit evidence requirements', async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-suite-force-kill-contract-test-'));
    temporaryRoots.push(evidenceDir);
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const mutate: EvidenceMutator = (evidence, cycles) => {
      if (evidence.scenario !== 'force-kill') return;
      delete evidence.quitAccepted;
      delete evidence.gracefulExitVerified;
      cycles.forEach(cycle => {
        delete cycle.quitAccepted;
        delete cycle.gracefulExitVerified;
      });
    };

    await expect(runPackagedSuite({
      exe: path.join(evidenceDir, 'ADHD One.exe'),
      evidenceDir,
      spawnImpl: fakeSpawnFactory(calls, -1, mutate)
    })).resolves.toMatchObject({ steps: expect.any(Array) });
    expect(calls).toHaveLength(5);
  });
});
