import { describe, expect, it, vi } from 'vitest';
import {
  WINDOWS_PROCESS_CPU_ERROR_CODES,
  calculateAverageCpuPercent,
  calculateWindowsProcessCpu,
  measureWindowsProcessCpu
} from '../scripts/e2e/windows-process-cpu.mjs';

type Process = {
  pid: number;
  parentPid: number;
  creationDate: string;
  userModeTime: string;
  kernelModeTime: string;
};

function process(
  pid: number,
  parentPid: number,
  creationDate: string,
  userModeTime: bigint | number | string,
  kernelModeTime: bigint | number | string
): Process {
  return {
    pid,
    parentPid,
    creationDate,
    userModeTime: String(userModeTime),
    kernelModeTime: String(kernelModeTime)
  };
}

function snapshot(rootTime: bigint, childTime: bigint, grandchildTime = 0n): Process[] {
  return [
    process(100, 1, 'root-created', rootTime, 0n),
    process(200, 100, 'child-created', childTime, 0n),
    process(300, 200, 'grandchild-created', grandchildTime, 0n),
    process(999, 1, 'unrelated-created', 123n, 456n)
  ];
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('expected operation to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function expectAsyncCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
    throw new Error('expected operation to reject');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('strict Windows process CPU measurement', () => {
  it('uses the complete Electron descendant tree and BigInt 100ns counters', () => {
    const first = snapshot(1_000_000_000_000n, 2_000_000_000_000n, 3_000_000_000_000n);
    const second = snapshot(1_000_300_000_000n, 2_000_200_000_000n, 3_000_700_000_000n);

    const result = calculateWindowsProcessCpu({
      firstSnapshot: first,
      secondSnapshot: second,
      rootPid: 100,
      logicalProcessorCount: 2
    });

    expect(result.averageCpuPercent).toBe(100);
    expect(result.totalCpuTimeDelta100ns).toBe('1200000000');
    expect(result.processCount).toBe(3);
  });

  it('normalizes CPU by the number of logical processors', () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(600_000_000n, 0n);

    expect(calculateAverageCpuPercent(first, second, {
      rootPid: 100,
      logicalProcessorCount: 4
    })).toBe(25);
  });

  it('rounds upward to three decimal places using integer arithmetic', () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(18_000_001n, 0n);

    expect(calculateAverageCpuPercent(first, second, {
      rootPid: 100,
      logicalProcessorCount: 3
    })).toBe(1.001);
  });

  it('uses injected snapshots and wait without a real sixty-second delay', async () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(600_000_000n, 0n);
    const sample = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const wait = vi.fn().mockResolvedValue(undefined);
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(60_000_000_000n)
      .mockReturnValueOnce(60_000_000_000n);

    const result = await measureWindowsProcessCpu({
      rootPid: 100,
      sample,
      wait,
      logicalProcessorCount: 2,
      monotonicNow
    });

    expect(result.averageCpuPercent).toBe(50);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(60_000);
  });

  it('uses the actual monotonic window rather than intervalMs as the denominator', async () => {
    const sample = vi.fn()
      .mockResolvedValueOnce(snapshot(0n, 0n))
      .mockResolvedValueOnce(snapshot(600_000_000n, 0n));
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(10_000n)
      .mockReturnValueOnce(10_000n)
      .mockReturnValueOnce(120_000_010_000n)
      .mockReturnValueOnce(120_000_010_000n);

    const result = await measureWindowsProcessCpu({
      rootPid: 100,
      sample,
      wait: vi.fn().mockResolvedValue(undefined),
      logicalProcessorCount: 2,
      monotonicNow
    });

    expect(result.elapsed100ns).toBe('1200000000');
    expect(result.averageCpuPercent).toBe(25);
  });

  it('rejects an injected timer that ends before the requested interval', async () => {
    const sample = vi.fn()
      .mockResolvedValueOnce(snapshot(0n, 0n))
      .mockResolvedValueOnce(snapshot(1n, 0n));

    await expectAsyncCode(
      () => measureWindowsProcessCpu({
        rootPid: 100,
        sample,
        wait: vi.fn().mockResolvedValue(undefined),
        logicalProcessorCount: 1,
        monotonicNow: vi.fn()
          .mockReturnValueOnce(0n)
          .mockReturnValueOnce(0n)
          .mockReturnValueOnce(59_999_999_999n)
          .mockReturnValueOnce(59_999_999_999n)
      }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.WINDOW_TOO_SHORT
    );
  });

  it('rejects missing process fields', () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(1n, 0n);
    delete (second[0] as Partial<Process>).kernelModeTime;

    expectCode(
      () => calculateWindowsProcessCpu({ firstSnapshot: first, secondSnapshot: second, rootPid: 100, logicalProcessorCount: 1 }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.MISSING_FIELD
    );
  });

  it('rejects negative per-process counter deltas', () => {
    expectCode(
      () => calculateWindowsProcessCpu({
        firstSnapshot: snapshot(10n, 0n),
        secondSnapshot: snapshot(9n, 0n),
        rootPid: 100,
        logicalProcessorCount: 1
      }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.NEGATIVE_DELTA
    );
  });

  it('rejects PID reuse even when the reused PID remains under the root', () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(1n, 0n);
    second[1] = process(200, 100, 'different-child-created', 1n, 0n);

    expectCode(
      () => calculateWindowsProcessCpu({ firstSnapshot: first, secondSnapshot: second, rootPid: 100, logicalProcessorCount: 1 }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.PID_REUSED
    );
  });

  it('rejects any change to the complete descendant membership set', () => {
    const first = snapshot(0n, 0n);
    const second = snapshot(1n, 0n).filter(item => item.pid !== 300);

    expectCode(
      () => calculateWindowsProcessCpu({ firstSnapshot: first, secondSnapshot: second, rootPid: 100, logicalProcessorCount: 1 }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.MEMBERS_CHANGED
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid logical processor count %s', logicalProcessorCount => {
    expectCode(
      () => calculateWindowsProcessCpu({
        firstSnapshot: snapshot(0n, 0n),
        secondSnapshot: snapshot(1n, 0n),
        rootPid: 100,
        logicalProcessorCount
      }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_LOGICAL_PROCESSORS
    );
  });

  it.each([0, -1])('rejects non-positive elapsed time %s', elapsedMs => {
    expectCode(
      () => calculateWindowsProcessCpu({
        firstSnapshot: snapshot(0n, 0n),
        secondSnapshot: snapshot(1n, 0n),
        rootPid: 100,
        logicalProcessorCount: 1,
        elapsedMs
      }),
      WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME
    );
  });
});
