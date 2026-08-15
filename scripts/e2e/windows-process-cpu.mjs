import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_PROCESS_CPU_SAMPLE_INTERVAL_MS = 60_000;
export const WINDOWS_PROCESS_CPU_ERROR_CODES = Object.freeze({
  MISSING_SNAPSHOT: 'WINDOWS_PROCESS_CPU_MISSING_SNAPSHOT',
  INVALID_SNAPSHOT: 'WINDOWS_PROCESS_CPU_INVALID_SNAPSHOT',
  MISSING_FIELD: 'WINDOWS_PROCESS_CPU_MISSING_FIELD',
  INVALID_PROCESS_ID: 'WINDOWS_PROCESS_CPU_INVALID_PROCESS_ID',
  INVALID_PROCESS_TIME: 'WINDOWS_PROCESS_CPU_INVALID_PROCESS_TIME',
  MISSING_ROOT: 'WINDOWS_PROCESS_CPU_MISSING_ROOT',
  DUPLICATE_PROCESS: 'WINDOWS_PROCESS_CPU_DUPLICATE_PROCESS',
  PID_REUSED: 'WINDOWS_PROCESS_CPU_PID_REUSED',
  MEMBERS_CHANGED: 'WINDOWS_PROCESS_CPU_MEMBERS_CHANGED',
  NEGATIVE_DELTA: 'WINDOWS_PROCESS_CPU_NEGATIVE_DELTA',
  INVALID_LOGICAL_PROCESSORS: 'WINDOWS_PROCESS_CPU_INVALID_LOGICAL_PROCESSORS',
  INVALID_ELAPSED_TIME: 'WINDOWS_PROCESS_CPU_INVALID_ELAPSED_TIME',
  WINDOW_TOO_SHORT: 'WINDOWS_PROCESS_CPU_WINDOW_TOO_SHORT',
  INVALID_SAMPLER: 'WINDOWS_PROCESS_CPU_INVALID_SAMPLER',
  SNAPSHOT_FAILED: 'WINDOWS_PROCESS_CPU_SNAPSHOT_FAILED'
});

const POWERSHELL_PROCESS_SNAPSHOT = [
  '$ErrorActionPreference = "Stop";',
  '$selfPid = $PID;',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime',
  '| Where-Object { $_.ProcessId -gt 0 -and $_.ProcessId -ne $selfPid }',
  '| ForEach-Object { [PSCustomObject]@{',
  'ProcessId = $_.ProcessId;',
  'ParentProcessId = $_.ParentProcessId;',
  'CreationDate = [string]$_.CreationDate;',
  'UserModeTime = [string]$_.UserModeTime;',
  'KernelModeTime = [string]$_.KernelModeTime',
  '} }',
  '| ConvertTo-Json -Compress'
].join(' ');

const POWERSHELL_PROCESS_SNAPSHOT_OPTIONS = Object.freeze({
  windowsHide: true,
  timeout: 15_000,
  maxBuffer: 8 * 1024 * 1024
});

export class WindowsProcessCpuError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsProcessCpuError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new WindowsProcessCpuError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readField(value, names, field, index) {
  if (!isRecord(value)) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_SNAPSHOT, `process ${index} is not an object`);
  }
  for (const name of names) {
    if (hasOwn(value, name) && value[name] !== undefined && value[name] !== null) return value[name];
  }
  fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MISSING_FIELD, `process ${index} is missing ${field}`);
}

function parseProcessId(value, field, index, allowZero = false) {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(candidate) || (allowZero ? candidate < 0 : candidate <= 0)) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_PROCESS_ID, `process ${index} has an invalid ${field}`);
  }
  return candidate;
}

function parseCreationDate(value, index) {
  const candidate = value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!candidate) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MISSING_FIELD, `process ${index} is missing CreationDate`);
  }
  return candidate;
}

function parseCounter(value, field, index) {
  if (typeof value === 'bigint') {
    if (value < 0n) fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_PROCESS_TIME, `process ${index} has a negative ${field}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_PROCESS_TIME, `process ${index} has an invalid ${field}`);
    }
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_PROCESS_TIME, `process ${index} has an invalid ${field}`);
  }
  return BigInt(value.trim());
}

function snapshotEntries(snapshot) {
  if (snapshot === undefined || snapshot === null) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MISSING_SNAPSHOT, 'process snapshot is required');
  }
  if (Array.isArray(snapshot)) return snapshot;
  if (isRecord(snapshot) && Array.isArray(snapshot.processes)) return snapshot.processes;
  return [snapshot];
}

function normalizeProcess(value, index) {
  const pid = parseProcessId(readField(value, ['pid', 'ProcessId', 'processId'], 'ProcessId', index), 'ProcessId', index);
  const parentPid = parseProcessId(
    readField(value, ['parentPid', 'ParentProcessId', 'parentProcessId'], 'ParentProcessId', index),
    'ParentProcessId',
    index,
    true
  );
  const creationDate = parseCreationDate(
    readField(value, ['creationDate', 'CreationDate', 'created', 'Created'], 'CreationDate', index),
    index
  );
  const userModeTime = parseCounter(
    readField(value, ['userModeTime', 'UserModeTime'], 'UserModeTime', index),
    'UserModeTime',
    index
  );
  const kernelModeTime = parseCounter(
    readField(value, ['kernelModeTime', 'KernelModeTime'], 'KernelModeTime', index),
    'KernelModeTime',
    index
  );
  return Object.freeze({ pid, parentPid, creationDate, userModeTime, kernelModeTime });
}

/**
 * Converts a PowerShell/JSON process snapshot to the strict internal shape.
 * The returned records contain BigInt CPU counters and are never mutated.
 */
export function normalizeWindowsProcessSnapshot(snapshot) {
  const processes = snapshotEntries(snapshot).map(normalizeProcess);
  const byPid = new Map();
  for (const process of processes) {
    const previous = byPid.get(process.pid);
    if (previous) {
      const code = previous.creationDate === process.creationDate
        ? WINDOWS_PROCESS_CPU_ERROR_CODES.DUPLICATE_PROCESS
        : WINDOWS_PROCESS_CPU_ERROR_CODES.PID_REUSED;
      fail(code, `process snapshot contains duplicate PID ${process.pid}`);
    }
    byPid.set(process.pid, process);
  }
  return processes;
}

export function processIdentity(process) {
  if (!isRecord(process) || !Number.isSafeInteger(process.pid) || typeof process.creationDate !== 'string') {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_SNAPSHOT, 'process identity is invalid');
  }
  return JSON.stringify([process.pid, process.creationDate]);
}

function selectProcessTree(processes, rootPid) {
  const root = parseProcessId(rootPid, 'root PID');
  const byPid = new Map(processes.map(process => [process.pid, process]));
  if (!byPid.has(root)) fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MISSING_ROOT, `root PID ${root} is missing`);

  const childrenByParent = new Map();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) ?? [];
    children.push(process);
    childrenByParent.set(process.parentPid, children);
  }

  const selected = [];
  const selectedPids = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const parentPid = pending.shift();
    if (parentPid === undefined) continue;
    const process = byPid.get(parentPid);
    if (!process || selectedPids.has(process.pid)) continue;
    selectedPids.add(process.pid);
    selected.push(process);
    for (const child of childrenByParent.get(process.pid) ?? []) {
      if (!selectedPids.has(child.pid)) pending.push(child.pid);
    }
  }
  return selected;
}

/** Returns the root and every currently reachable descendant, in traversal order. */
export function getWindowsProcessTree(snapshot, rootPid) {
  return selectProcessTree(normalizeWindowsProcessSnapshot(snapshot), rootPid);
}

function processMapByPid(processes) {
  return new Map(processes.map(process => [process.pid, process]));
}

function processMapByIdentity(processes) {
  return new Map(processes.map(process => [processIdentity(process), process]));
}

function assertTreeMembership(firstProcesses, secondProcesses, firstTree, secondTree) {
  const firstSnapshotByPid = processMapByPid(firstProcesses);
  const secondSnapshotByPid = processMapByPid(secondProcesses);
  const treePids = new Set([...firstTree, ...secondTree].map(process => process.pid));
  for (const pid of treePids) {
    const first = firstSnapshotByPid.get(pid);
    const second = secondSnapshotByPid.get(pid);
    if (first && second && first.creationDate !== second.creationDate) {
      fail(WINDOWS_PROCESS_CPU_ERROR_CODES.PID_REUSED, `PID ${pid} has different CreationDate values`);
    }
  }

  const firstIdentities = new Set(firstTree.map(processIdentity));
  const secondIdentities = new Set(secondTree.map(processIdentity));
  if (firstIdentities.size !== secondIdentities.size || [...firstIdentities].some(identity => !secondIdentities.has(identity))) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MEMBERS_CHANGED, 'Electron process-tree membership changed between samples');
  }
}

function positiveElapsed100ns(options) {
  const elapsed100ns = options.elapsed100ns ?? options.duration100ns;
  if (elapsed100ns !== undefined) {
    let parsed;
    try {
      parsed = typeof elapsed100ns === 'bigint'
        ? elapsed100ns
        : typeof elapsed100ns === 'string' && /^\d+$/u.test(elapsed100ns.trim())
          ? BigInt(elapsed100ns.trim())
          : null;
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed <= 0n) {
      fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME, 'elapsed time must be positive 100ns units');
    }
    return parsed;
  }

  const elapsedMs = options.elapsedMs ?? options.durationMs ?? WINDOWS_PROCESS_CPU_SAMPLE_INTERVAL_MS;
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs <= 0) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME, 'elapsed time must be a positive integer number of milliseconds');
  }
  return BigInt(elapsedMs) * 10_000n;
}

function positiveLogicalProcessorCount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_LOGICAL_PROCESSORS, 'logical processor count must be a positive integer');
  }
  return value;
}

function ceilDivide(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function roundedCpuPercent(totalDelta100ns, elapsed100ns, logicalProcessorCount) {
  // Store thousandths of a percent as an integer before converting to Number.
  const thousandths = ceilDivide(totalDelta100ns * 100_000n, elapsed100ns * BigInt(logicalProcessorCount));
  const result = Number(thousandths) / 1_000;
  if (!Number.isFinite(result)) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_PROCESS_TIME, 'calculated CPU percentage is not finite');
  }
  return result;
}

/**
 * Purely calculates a one-minute (or explicitly supplied duration) CPU result.
 * CPU counters are differenced per PID+CreationDate and only then summed.
 */
export function calculateWindowsProcessCpu({
  firstSnapshot,
  secondSnapshot,
  rootPid,
  logicalProcessorCount,
  elapsedMs,
  durationMs,
  elapsed100ns,
  duration100ns
} = {}) {
  const firstProcesses = normalizeWindowsProcessSnapshot(firstSnapshot);
  const secondProcesses = normalizeWindowsProcessSnapshot(secondSnapshot);
  const firstTree = selectProcessTree(firstProcesses, rootPid);
  const secondTree = selectProcessTree(secondProcesses, rootPid);
  assertTreeMembership(firstProcesses, secondProcesses, firstTree, secondTree);

  const firstByIdentity = processMapByIdentity(firstTree);
  const secondByIdentity = processMapByIdentity(secondTree);
  let totalDelta100ns = 0n;
  for (const [identity, first] of firstByIdentity) {
    const second = secondByIdentity.get(identity);
    if (!second) {
      fail(WINDOWS_PROCESS_CPU_ERROR_CODES.MEMBERS_CHANGED, 'process-tree membership changed between samples');
    }
    const userDelta = second.userModeTime - first.userModeTime;
    const kernelDelta = second.kernelModeTime - first.kernelModeTime;
    if (userDelta < 0n || kernelDelta < 0n) {
      fail(WINDOWS_PROCESS_CPU_ERROR_CODES.NEGATIVE_DELTA, `CPU counter decreased for ${identity}`);
    }
    totalDelta100ns += userDelta + kernelDelta;
  }

  const processors = positiveLogicalProcessorCount(logicalProcessorCount);
  const elapsed = positiveElapsed100ns({ elapsedMs, durationMs, elapsed100ns, duration100ns });
  const averageCpuPercent = roundedCpuPercent(totalDelta100ns, elapsed, processors);
  return Object.freeze({
    averageCpuPercent,
    cpuPercent: averageCpuPercent,
    totalCpuTimeDelta100ns: totalDelta100ns.toString(),
    elapsed100ns: elapsed.toString(),
    logicalProcessorCount: processors,
    processCount: firstTree.length
  });
}

/** Pure convenience function returning only the conservatively rounded percentage. */
export function calculateAverageCpuPercent(firstSnapshot, secondSnapshot, options = {}) {
  if (arguments.length === 1 && isRecord(firstSnapshot) && hasOwn(firstSnapshot, 'firstSnapshot')) {
    return calculateWindowsProcessCpu(firstSnapshot).averageCpuPercent;
  }
  return calculateWindowsProcessCpu({ ...options, firstSnapshot, secondSnapshot }).averageCpuPercent;
}

export const calculateCpuPercent = calculateAverageCpuPercent;

/** Parses PowerShell JSON without executing anything. */
export function parseWindowsProcessSnapshotJson(stdout) {
  let value;
  try {
    value = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_SNAPSHOT, 'PowerShell returned invalid JSON');
  }
  return normalizeWindowsProcessSnapshot(value);
}

/** Takes one Windows process snapshot; the command runner is injectable for tests. */
export async function sampleWindowsProcessSnapshot({ run = execFileAsync } = {}) {
  if (typeof run !== 'function') fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_SAMPLER, 'process snapshot runner must be a function');
  let result;
  try {
    result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROCESS_SNAPSHOT],
      POWERSHELL_PROCESS_SNAPSHOT_OPTIONS
    );
  } catch {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.SNAPSHOT_FAILED);
  }
  return parseWindowsProcessSnapshotJson(result?.stdout ?? result);
}

export function getLogicalProcessorCount() {
  const count = os.cpus().length;
  return positiveLogicalProcessorCount(count);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Samples twice around the fixed one-minute interval. Both the sampler and wait
 * function are injectable, so unit tests never sleep or touch the network.
 */
export async function measureWindowsProcessCpu({
  rootPid,
  sample = sampleWindowsProcessSnapshot,
  sampler,
  wait = delay,
  logicalProcessorCount,
  intervalMs = WINDOWS_PROCESS_CPU_SAMPLE_INTERVAL_MS,
  monotonicNow = process.hrtime.bigint
} = {}) {
  const selectedSampler = sampler ?? sample;
  if (typeof selectedSampler !== 'function' || typeof wait !== 'function' || typeof monotonicNow !== 'function') {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_SAMPLER, 'sampler and wait must be functions');
  }
  positiveElapsed100ns({ elapsedMs: intervalMs });
  const processors = logicalProcessorCount ?? getLogicalProcessorCount();
  positiveLogicalProcessorCount(processors);
  const requiredElapsedNs = BigInt(intervalMs) * 1_000_000n;
  const firstStartedAtNs = monotonicNow();
  if (typeof firstStartedAtNs !== 'bigint') {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME, 'monotonicNow must return nanoseconds as BigInt');
  }
  const firstSnapshot = await selectedSampler(rootPid);
  const firstEndedAtNs = monotonicNow();
  if (typeof firstEndedAtNs !== 'bigint' || firstEndedAtNs < firstStartedAtNs) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME);
  }
  await wait(intervalMs);
  const secondStartedAtNs = monotonicNow();
  if (typeof secondStartedAtNs !== 'bigint' || secondStartedAtNs < firstEndedAtNs) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME);
  }
  const secondSnapshot = await selectedSampler(rootPid);
  const secondEndedAtNs = monotonicNow();
  if (typeof secondEndedAtNs !== 'bigint' || secondEndedAtNs < secondStartedAtNs) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME, 'monotonicNow must return nanoseconds as BigInt');
  }
  const firstSampleAtNs = (firstStartedAtNs + firstEndedAtNs) / 2n;
  const secondSampleAtNs = (secondStartedAtNs + secondEndedAtNs) / 2n;
  const actualElapsedNs = secondSampleAtNs - firstSampleAtNs;
  if (actualElapsedNs < requiredElapsedNs) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.WINDOW_TOO_SHORT, 'actual sampling window is shorter than the requested interval');
  }
  const actualElapsed100ns = actualElapsedNs / 100n;
  if (actualElapsed100ns <= 0n) {
    fail(WINDOWS_PROCESS_CPU_ERROR_CODES.INVALID_ELAPSED_TIME, 'actual sampling window must be positive');
  }
  return calculateWindowsProcessCpu({
    firstSnapshot,
    secondSnapshot,
    rootPid,
    logicalProcessorCount: processors,
    elapsed100ns: actualElapsed100ns
  });
}

export const sampleOneMinuteWindowsProcessCpu = measureWindowsProcessCpu;
