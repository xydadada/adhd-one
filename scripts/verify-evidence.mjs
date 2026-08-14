import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGED_FILES = Object.freeze([
  Object.freeze({ name: 'launch-1.json', scenario: 'launch', cycles: 1 }),
  Object.freeze({ name: 'force-kill-1.json', scenario: 'force-kill', cycles: 1 }),
  Object.freeze({ name: 'workspace-write-1.json', scenario: 'workspace-write', cycles: 1 }),
  Object.freeze({ name: 'launch-10.json', scenario: 'launch', cycles: 10 })
]);

const TOP_KEYS = new Set([
  'schemaVersion', 'tool', 'generatedAt', 'executable', 'scenario', 'portableMode',
  'launchVerified', 'forceKillRequested', 'forceKillVerified', 'quitAccepted',
  'gracefulExitVerified', 'exitVerified', 'cleanupVerified',
  'finalScopedProcessAuditPassed', 'workspaceWriteRequested', 'workspaceWriteVerified',
  'cyclesRequested', 'cyclesCompleted', 'passed', 'cycles'
]);

const CYCLE_KEYS = new Set([
  'cycle', 'scenario', 'passed', 'launchVerified', 'launchMs', 'controlWindowMs',
  'runtimeReadyMs', 'exitMs', 'pid', 'cdpPort', 'portableMode', 'controlWindowVerified',
  'runtimeReadyVerified', 'hostDescribeVerified', 'runtimePid', 'isolationVerified',
  'cdpClosed', 'runtimePidExited', 'processTreeExited', 'quitAccepted',
  'gracefulExitVerified', 'exitVerified', 'processTreeCount', 'remainingPids', 'exitCode',
  'exitSignal', 'forceKillRequested', 'forceKillVerified', 'forcedTermination', 'cleanup',
  'cleanupRootExisted', 'cleanupRootAbsent', 'cleanupVerified',
  'finalScopedProcessAuditPassed', 'finalScopedProcessAuditCount',
  'finalScopedProcessAuditPids', 'errorCode', 'stdoutBytes', 'stderrBytes',
  'workspaceWriteVerified', 'workspaceWrite'
]);

const WORKSPACE_KEYS = new Set([
  'requested', 'verified', 'rpcClientSource', 'permissionMode', 'approval',
  'providerSequence', 'approvalRequested', 'sessionCreated', 'sessionArchived',
  'historyVerified', 'providerAuthVerified', 'powerShellCall', 'toolResult',
  'sentinelFile', 'secondProviderTurn', 'finalNonce'
]);

const SUMMARY_KEYS = new Set([
  'schemaVersion', 'tool', 'passed', 'installStarted', 'installCompleted',
  'shortcutsCreated', 'suitePassed', 'uninstallAttempted', 'uninstallSucceeded',
  'uninstallExitCode', 'uninstallRecordCount', 'matchingUninstallRecordCount',
  'installLocationRecordMatched', 'uninstallCommandRecordMatched',
  'installDirectoryRemoved', 'processClean', 'registryClean', 'shortcutsClean',
  'errorCode', 'cleanupErrorCodes'
]);

const CYCLE_BOOLEAN_KEYS = [
  'passed', 'launchVerified', 'portableMode', 'controlWindowVerified',
  'runtimeReadyVerified', 'hostDescribeVerified', 'isolationVerified', 'cdpClosed',
  'runtimePidExited', 'processTreeExited', 'quitAccepted', 'gracefulExitVerified',
  'exitVerified', 'forceKillRequested', 'forceKillVerified', 'forcedTermination',
  'cleanupRootExisted', 'cleanupRootAbsent', 'cleanupVerified',
  'finalScopedProcessAuditPassed', 'workspaceWriteVerified'
];

const CYCLE_NUMBER_KEYS = [
  'launchMs', 'controlWindowMs', 'runtimeReadyMs', 'exitMs', 'pid', 'cdpPort',
  'runtimePid', 'processTreeCount', 'finalScopedProcessAuditCount', 'stdoutBytes',
  'stderrBytes'
];

const WORKSPACE_BOOLEAN_KEYS = [
  'requested', 'verified', 'approvalRequested', 'sessionCreated', 'sessionArchived',
  'historyVerified', 'providerAuthVerified', 'powerShellCall', 'toolResult',
  'sentinelFile', 'secondProviderTurn', 'finalNonce'
];

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed, required = allowed) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => allowed.has(key)) && [...required].every(key => keys.includes(key));
}

function isBooleanRecord(value, keys) {
  return keys.every(key => typeof value[key] === 'boolean');
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPackagedEvidence(value, expected) {
  if (!hasOnlyKeys(value, TOP_KEYS)) return false;
  if (value.schemaVersion !== 1 || value.tool !== 'adhd-one-packaged-e2e') return false;
  if (typeof value.generatedAt !== 'string' || !ISO_TIMESTAMP.test(value.generatedAt)
    || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (typeof value.executable !== 'string' || value.executable.length === 0
    || /[\\/]/u.test(value.executable)) return false;
  if (value.scenario !== expected.scenario || !Array.isArray(value.cycles)
    || value.cyclesRequested !== expected.cycles || value.cyclesCompleted !== expected.cycles
    || value.cycles.length !== expected.cycles || value.passed !== true) return false;
  const topBooleanKeys = [
    'portableMode', 'launchVerified', 'forceKillRequested', 'forceKillVerified',
    'quitAccepted', 'gracefulExitVerified', 'exitVerified', 'cleanupVerified',
    'finalScopedProcessAuditPassed', 'workspaceWriteRequested', 'workspaceWriteVerified'
  ];
  if (!isBooleanRecord(value, topBooleanKeys)
    || value.launchVerified !== true
    || value.exitVerified !== true
    || value.cleanupVerified !== true
    || value.finalScopedProcessAuditPassed !== true) return false;

  const isForceKill = expected.scenario === 'force-kill';
  const isWorkspaceWrite = expected.scenario === 'workspace-write';
  if (value.forceKillRequested !== isForceKill || value.forceKillVerified !== isForceKill
    || value.workspaceWriteRequested !== isWorkspaceWrite
    || value.workspaceWriteVerified !== isWorkspaceWrite) return false;
  if (isForceKill) {
    if (value.quitAccepted !== false || value.gracefulExitVerified !== false) return false;
  } else if (value.quitAccepted !== true || value.gracefulExitVerified !== true) return false;

  return value.cycles.every((cycle, index) => validCycle(cycle, value, expected, index));
}

function validCycle(cycle, evidence, expected, index) {
  if (!hasOnlyKeys(cycle, CYCLE_KEYS, [...CYCLE_KEYS].filter(key => key !== 'errorCode'))) return false;
  if (cycle.cycle !== index + 1 || cycle.scenario !== expected.scenario
    || !isBooleanRecord(cycle, CYCLE_BOOLEAN_KEYS)
    || !CYCLE_NUMBER_KEYS.every(key => isNonNegativeInteger(cycle[key]))) return false;
  if (cycle.errorCode !== undefined && (typeof cycle.errorCode !== 'string' || !SAFE_CODE.test(cycle.errorCode))) return false;
  if (!Array.isArray(cycle.remainingPids) || !Array.isArray(cycle.finalScopedProcessAuditPids)
    || cycle.remainingPids.length !== 0 || cycle.finalScopedProcessAuditPids.length !== 0) return false;
  if ((cycle.exitCode !== null && !isNonNegativeInteger(cycle.exitCode))
    || (cycle.exitSignal !== null && (typeof cycle.exitSignal !== 'string' || !SAFE_CODE.test(cycle.exitSignal)))) return false;
  if (cycle.portableMode !== evidence.portableMode || cycle.passed !== true
    || cycle.launchVerified !== true || cycle.controlWindowVerified !== true
    || cycle.runtimeReadyVerified !== true || cycle.hostDescribeVerified !== true
    || cycle.isolationVerified !== true || cycle.cdpClosed !== true
    || cycle.runtimePidExited !== true || cycle.processTreeExited !== true
    || cycle.exitVerified !== true || cycle.cleanup !== 'removed'
    || cycle.cleanupRootExisted !== true || cycle.cleanupRootAbsent !== true
    || cycle.cleanupVerified !== true || cycle.finalScopedProcessAuditPassed !== true) return false;

  const isForceKill = expected.scenario === 'force-kill';
  if (cycle.forceKillRequested !== isForceKill || cycle.forceKillVerified !== isForceKill
    || cycle.forcedTermination !== isForceKill) return false;
  if (isForceKill) {
    if (cycle.quitAccepted !== false || cycle.gracefulExitVerified !== false) return false;
  } else if (cycle.quitAccepted !== true || cycle.gracefulExitVerified !== true
    || cycle.forcedTermination !== false || cycle.exitCode !== 0 || cycle.exitSignal !== null) return false;

  if (!validWorkspaceEvidence(cycle.workspaceWrite, expected.scenario === 'workspace-write')) return false;
  return cycle.workspaceWriteVerified === (expected.scenario === 'workspace-write');
}

function validWorkspaceEvidence(value, requested) {
  if (!hasOnlyKeys(value, WORKSPACE_KEYS)) return false;
  const expected = {
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
  if (!isBooleanRecord(value, WORKSPACE_BOOLEAN_KEYS)) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function validInstalledSummary(value) {
  if (!hasOnlyKeys(value, SUMMARY_KEYS)) return false;
  if (value.schemaVersion !== 1 || value.tool !== 'adhd-one-installed-e2e' || value.passed !== true
    || value.uninstallExitCode !== 0 || value.errorCode !== null
    || !Array.isArray(value.cleanupErrorCodes) || value.cleanupErrorCodes.length !== 0) return false;
  const requiredTrue = [
    'installStarted', 'installCompleted', 'shortcutsCreated', 'suitePassed',
    'uninstallAttempted', 'uninstallSucceeded', 'installDirectoryRemoved',
    'processClean', 'registryClean', 'shortcutsClean'
  ];
  if (!isBooleanRecord(value, [
    ...requiredTrue, 'installLocationRecordMatched'
  ]) || !requiredTrue.every(key => value[key] === true)) return false;
  if (value.installLocationRecordMatched !== true && value.uninstallCommandRecordMatched !== true) return false;
  return ['uninstallRecordCount', 'matchingUninstallRecordCount']
    .every(key => isNonNegativeInteger(value[key]))
    && value.uninstallRecordCount > 0
    && value.matchingUninstallRecordCount > 0
    && value.matchingUninstallRecordCount <= value.uninstallRecordCount;
}

async function readJson(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failure(file, code) {
  return `${file}:${code}`;
}

export async function verifyEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    return { ok: false, errors: [failure('<directory>', 'INVALID_ARGUMENT')] };
  }
  let directoryInfo;
  try {
    directoryInfo = await stat(path.resolve(directory));
  } catch {
    return { ok: false, errors: [failure('<directory>', 'EVIDENCE_DIRECTORY_INVALID')] };
  }
  if (!directoryInfo.isDirectory()) {
    return { ok: false, errors: [failure('<directory>', 'EVIDENCE_DIRECTORY_INVALID')] };
  }

  const errors = [];
  for (const expected of PACKAGED_FILES) {
    const file = path.join(directory, expected.name);
    const value = await readJson(file);
    if (value === undefined) {
      errors.push(failure(expected.name, 'PACKAGED_EVIDENCE_MISSING_OR_INVALID'));
    } else if (!validPackagedEvidence(value, expected)) {
      errors.push(failure(expected.name, 'PACKAGED_EVIDENCE_INVALID'));
    }
  }

  const summaryPath = path.join(directory, 'installed-summary.json');
  try {
    await access(summaryPath);
    const summary = await readJson(summaryPath);
    if (summary === undefined || !validInstalledSummary(summary)) {
      errors.push(failure('installed-summary.json', 'INSTALLED_SUMMARY_INVALID'));
    }
  } catch {
    // The packaged suite can be downloaded without the installed wrapper summary.
  }
  return { ok: errors.length === 0, errors };
}

export { PACKAGED_FILES, validPackagedEvidence, validInstalledSummary };

function isMain() {
  return process.argv[1]
    && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('FAIL INVALID_ARGUMENT');
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyEvidenceDirectory(args[0]);
      if (result.ok) console.log('PASS');
      else {
        console.error(`FAIL ${result.errors[0] ?? 'EVIDENCE_INVALID'}`);
        process.exitCode = 1;
      }
    } catch {
      console.error('FAIL EVIDENCE_DIRECTORY_INVALID');
      process.exitCode = 2;
    }
  }
}
