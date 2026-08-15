import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGED_FILES = Object.freeze([
  Object.freeze({ name: 'launch-1.json', scenario: 'launch', cycles: 1 }),
  Object.freeze({ name: 'force-kill-1.json', scenario: 'force-kill', cycles: 1 }),
  Object.freeze({ name: 'workspace-write-1.json', scenario: 'workspace-write', cycles: 1 }),
  Object.freeze({ name: 'runtime-rollback-1.json', scenario: 'runtime-rollback', cycles: 1 }),
  Object.freeze({ name: 'launch-10.json', scenario: 'launch', cycles: 10 })
]);
const PORTABLE_EVIDENCE_EXPECTATION = Object.freeze({ scenario: 'launch', cycles: 1 });
const INSTALLED_SUMMARY_FILE = 'installed-summary.json';
const EVIDENCE_FILE_NAMES = Object.freeze([
  ...PACKAGED_FILES.map(file => file.name),
  INSTALLED_SUMMARY_FILE
]);
const EVIDENCE_FILE_NAME_SET = new Set(EVIDENCE_FILE_NAMES);

const TOP_KEYS = new Set([
  'schemaVersion', 'tool', 'generatedAt', 'executable', 'scenario', 'portableMode',
  'launchVerified', 'forceKillRequested', 'forceKillVerified', 'quitAccepted',
  'gracefulExitVerified', 'exitVerified', 'cleanupVerified',
  'finalScopedProcessAuditPassed', 'workspaceWriteRequested', 'workspaceWriteVerified',
  'runtimeRollbackRequested', 'runtimeRollbackVerified',
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
  'finalScopedProcessAuditPids', 'finalScopedProcessAuditKinds', 'errorCode', 'stdoutBytes', 'stderrBytes',
  'workspaceWriteVerified', 'workspaceWrite', 'runtimeRollbackVerified', 'runtimeRollback'
]);

const WORKSPACE_KEYS = new Set([
  'requested', 'verified', 'rpcClientSource', 'permissionMode', 'approval',
  'providerSequence', 'approvalRequested', 'sessionCreated', 'sessionArchived',
  'historyVerified', 'providerAuthVerified', 'powerShellCall', 'toolResult',
  'sentinelFile', 'secondProviderTurn', 'finalNonce'
]);

const RUNTIME_ROLLBACK_KEYS = new Set([
  'requested', 'verified', 'candidateSeeded', 'bundledActive',
  'previousCandidateRecorded', 'healthy', 'candidateCleared',
  'rollbackMarkerRecorded', 'candidateSlotRetained', 'readyVerified', 'postExitVerified'
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
  'finalScopedProcessAuditPassed', 'workspaceWriteVerified',
  'runtimeRollbackVerified'
];

const POSITIVE_CYCLE_NUMBER_KEYS = [
  'pid', 'runtimePid', 'cdpPort', 'processTreeCount'
];

const NON_NEGATIVE_CYCLE_NUMBER_KEYS = [
  'launchMs', 'controlWindowMs', 'runtimeReadyMs', 'exitMs',
  'finalScopedProcessAuditCount', 'stdoutBytes', 'stderrBytes'
];

const WORKSPACE_BOOLEAN_KEYS = [
  'requested', 'verified', 'approvalRequested', 'sessionCreated', 'sessionArchived',
  'historyVerified', 'providerAuthVerified', 'powerShellCall', 'toolResult',
  'sentinelFile', 'secondProviderTurn', 'finalNonce'
];

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const PROCESS_AUDIT_KINDS = new Set(['known-identity', 'known-ancestor', 'temp-root', 'launch-executable']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PRODUCTION_ERROR_CODES = new Set([
  'ACCESS_DENIED',
  'APPDATA_ISOLATION_FAILED',
  'APPLICATION_DID_NOT_EXIT_GRACEFULLY',
  'APPLICATION_EXITED_BEFORE_CDP',
  'APPLICATION_EXITED_BEFORE_CONTROL_WINDOW',
  'APPLICATION_EXITED_BY_SIGNAL',
  'APPLICATION_EXITED_WHILE_WAITING_FOR_READY',
  'APPLICATION_FORCE_KILL_FAILED',
  'APPLICATION_GRACEFUL_EXIT_FAILED',
  'APPLICATION_PROCESS_REMAINED',
  'APP_QUIT_NOT_ACCEPTED',
  'APP_QUIT_REQUEST_FAILED',
  'CDP_CONNECT_FAILED',
  'CDP_CONNECT_TIMEOUT',
  'CDP_DISCOVERY_TIMEOUT',
  'CDP_REMAINED_OPEN',
  'CLEANUP_FAILED',
  'CLEANUP_ROOT_MISSING_BEFORE_RM',
  'CLEANUP_ROOT_NOT_DIRECTORY',
  'CLEANUP_ROOT_REAPPEARED',
  'CLEANUP_ROOT_REMAINS',
  'CLEANUP_ROOT_STAT_FAILED',
  'CLEANUP_ROOT_STAT_TIMEOUT',
  'CLEANUP_ROOT_UNEXPECTED',
  'CLEANUP_TIMEOUT',
  'CONTROL_WINDOW_CLOSED_BEFORE_READY',
  'CONTROL_WINDOW_FAILED',
  'CONTROL_WINDOW_TIMEOUT',
  'E2E_CYCLE_FAILED',
  'E2E_CYCLE_TIMEOUT',
  'E2E_ERROR',
  'E2E_MAIN_FAILED',
  'E2E_MAIN_TIMEOUT',
  'E2E_TIMEOUT',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ENOENT',
  'ENOTDIR',
  'EXE_NOT_FOUND',
  'HOST_DESCRIBE_FAILED',
  'HOST_DESCRIBE_HTTP_ERROR',
  'HOST_DESCRIBE_RESPONSE_INVALID',
  'HOST_DESCRIBE_TIMEOUT',
  'INVALID_ARGUMENT',
  'INSTALLED_E2E_FAILED',
  'INSTALLED_E2E_INSTALL_DIRECTORY_REMAINED',
  'INSTALLED_E2E_INSTALL_FAILED',
  'INSTALLED_E2E_INSTALL_TIMEOUT',
  'INSTALLED_E2E_INSTALL_MARKER_REMAINED',
  'INSTALLED_E2E_LAYOUT_INVALID',
  'INSTALLED_E2E_PACKAGED_SUITE_FAILED',
  'INSTALLED_E2E_PACKAGED_SUITE_TIMEOUT',
  'INSTALLED_E2E_PREEXISTING_INSTALL',
  'INSTALLED_E2E_PREEXISTING_SHORTCUT',
  'INSTALLED_E2E_PROCESS_AUDIT_FAILED',
  'INSTALLED_E2E_PROCESS_REMAINED',
  'INSTALLED_E2E_PROCESS_REMAINED_AFTER_UNINSTALL',
  'INSTALLED_E2E_REGISTRY_AUDIT_FAILED',
  'INSTALLED_E2E_REGISTRY_REMAINED',
  'INSTALLED_E2E_RUNTIME_ARCHIVE_REMAINED',
  'INSTALLED_E2E_RUNTIME_NOT_EXPANDED',
  'INSTALLED_E2E_SETUP_MISSING',
  'INSTALLED_E2E_SHELL_FOLDER_UNAVAILABLE',
  'INSTALLED_E2E_SHORTCUT_CREATION_INVALID',
  'INSTALLED_E2E_SHORTCUT_REMAINED',
  'INSTALLED_E2E_UNINSTALLER_AMBIGUOUS',
  'INSTALLED_E2E_UNINSTALLER_DISCOVERY_FAILED',
  'INSTALLED_E2E_UNINSTALLER_MISSING',
  'INSTALLED_E2E_UNINSTALL_FAILED',
  'INSTALLED_E2E_UNINSTALL_RECORD_INVALID',
  'INSTALLED_E2E_UNINSTALL_TIMEOUT',
  'INSTALLED_E2E_UNSAFE_NSiS_PATH',
  'LOOPBACK_PORT_ALLOCATION_FAILED',
  'MOCK_CLOSE_FAILED',
  'MOCK_CLOSE_TIMEOUT',
  'NETWORK_ERROR',
  'NOT_FOUND',
  'PACKAGED_E2E_IS_WINDOWS_ONLY',
  'PORTABLE_MARKER_COPY_FAILED',
  'PORTABLE_MARKER_MISSING',
  'PROCESS_EXIT_FAILED',
  'PROCESS_EXIT_TIMEOUT',
  'PROCESS_PATH_AUDIT_FAILED',
  'PROCESS_PATH_AUDIT_FOUND',
  'PROCESS_PATH_AUDIT_TIMEOUT',
  'PROCESS_TREE_AUDIT_FAILED',
  'PROCESS_TREE_AUDIT_TIMEOUT',
  'RUNTIME_FAILED',
  'RUNTIME_ROLLBACK_FAILED',
  'RUNTIME_ROLLBACK_REQUIRES_INSTALLED',
  'RUNTIME_ROLLBACK_SLOT_PRESENT',
  'RUNTIME_PID_NOT_IN_APP_PROCESS_TREE',
  'RUNTIME_PROCESS_REMAINED',
  'RUNTIME_READY_TIMEOUT',
  'RUNTIME_SNAPSHOT_EVALUATE_FAILED',
  'RUNTIME_SNAPSHOT_EVALUATE_TIMEOUT',
  'RUNTIME_SNAPSHOT_NOT_READY',
  'WORKSPACE_ASAR_EXTRACTOR_MISSING',
  'WORKSPACE_ASAR_NOT_FILE',
  'WORKSPACE_HOST_DESCRIBE_FAILED',
  'WORKSPACE_HOST_DESCRIBE_TIMEOUT',
  'WORKSPACE_MUX_OPEN_FAILED',
  'WORKSPACE_MUX_OPEN_TIMEOUT',
  'WORKSPACE_MUX_READY_FAILED',
  'WORKSPACE_MUX_READY_TIMEOUT',
  'WORKSPACE_RPC_CLIENT_INVALID',
  'WORKSPACE_RPC_CLIENT_LOAD_FAILED',
  'WORKSPACE_RPC_CLIENT_LOAD_TIMEOUT',
  'WORKSPACE_RPC_CLIENT_MISSING_FROM_ASAR',
  'WORKSPACE_RPC_CLIENT_NOT_FOUND',
  'WORKSPACE_SESSION_ARCHIVE_FAILED',
  'WORKSPACE_SESSION_ARCHIVE_TIMEOUT',
  'WORKSPACE_SESSION_CREATE_FAILED',
  'WORKSPACE_SESSION_CREATE_TIMEOUT',
  'WORKSPACE_SESSION_HISTORY_FAILED',
  'WORKSPACE_SESSION_HISTORY_TIMEOUT',
  'WORKSPACE_SESSION_MODELS_FAILED',
  'WORKSPACE_SESSION_MODELS_TIMEOUT',
  'WORKSPACE_SESSION_PROMPT_FAILED',
  'WORKSPACE_SESSION_PROMPT_TIMEOUT',
  'WORKSPACE_WRITE_APPROVAL_REQUESTED',
  'WORKSPACE_WRITE_EVIDENCE_INCOMPLETE',
  'WORKSPACE_WRITE_FAILED',
  'WORKSPACE_WRITE_FINAL_NONCE_MISSING',
  'WORKSPACE_WRITE_HISTORY_INCOMPLETE',
  'WORKSPACE_WRITE_HISTORY_INVALID',
  'WORKSPACE_WRITE_MODEL_NOT_ROUTABLE',
  'WORKSPACE_WRITE_MUX_PROTOCOL_ERROR',
  'WORKSPACE_WRITE_PERMISSION_MODE_MISMATCH',
  'WORKSPACE_WRITE_POWERSHELL_ARGUMENT_INVALID',
  'WORKSPACE_WRITE_POWERSHELL_CALL_MISSING',
  'WORKSPACE_WRITE_PROMPT_NOT_ACCEPTED',
  'WORKSPACE_WRITE_PROVIDER_SEQUENCE_MISMATCH',
  'WORKSPACE_WRITE_SENTINEL_MISMATCH',
  'WORKSPACE_WRITE_SESSION_ARCHIVE_FAILED',
  'WORKSPACE_WRITE_SESSION_ARCHIVE_TIMEOUT',
  'WORKSPACE_WRITE_SESSION_CREATE_INVALID',
  'WORKSPACE_WRITE_TIMEOUT',
  'WORKSPACE_WRITE_TOOL_RESULT_MISSING',
  'WORKSPACE_WRITE_TURN_END_MISSING',
  'WORKSPACE_WRITE_TURN_FAILED'
]);

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

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isKnownProductionErrorCode(value) {
  return typeof value === 'string' && PRODUCTION_ERROR_CODES.has(value);
}

function isNullableProductionErrorCode(value) {
  return value === null || isKnownProductionErrorCode(value);
}

function validPackagedEvidence(value, expected, expectedPortableMode = false) {
  if (!hasOnlyKeys(value, TOP_KEYS)) return false;
  if (value.schemaVersion !== 1 || value.tool !== 'adhd-one-packaged-e2e') return false;
  if (typeof value.generatedAt !== 'string' || !ISO_TIMESTAMP.test(value.generatedAt)
    || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (value.executable !== 'ADHD One.exe' || value.portableMode !== expectedPortableMode) return false;
  if (value.scenario !== expected.scenario || !Array.isArray(value.cycles)
    || value.cyclesRequested !== expected.cycles || value.cyclesCompleted !== expected.cycles
    || value.cycles.length !== expected.cycles || value.passed !== true) return false;
  const topBooleanKeys = [
    'portableMode', 'launchVerified', 'forceKillRequested', 'forceKillVerified',
    'quitAccepted', 'gracefulExitVerified', 'exitVerified', 'cleanupVerified',
    'finalScopedProcessAuditPassed', 'workspaceWriteRequested', 'workspaceWriteVerified',
    'runtimeRollbackRequested', 'runtimeRollbackVerified'
  ];
  if (!isBooleanRecord(value, topBooleanKeys)
    || value.launchVerified !== true
    || value.exitVerified !== true
    || value.cleanupVerified !== true
    || value.finalScopedProcessAuditPassed !== true) return false;

  const isForceKill = expected.scenario === 'force-kill';
  const isWorkspaceWrite = expected.scenario === 'workspace-write';
  const isRuntimeRollback = expected.scenario === 'runtime-rollback';
  if (value.forceKillRequested !== isForceKill || value.forceKillVerified !== isForceKill
    || value.workspaceWriteRequested !== isWorkspaceWrite
    || value.workspaceWriteVerified !== isWorkspaceWrite
    || value.runtimeRollbackRequested !== isRuntimeRollback
    || value.runtimeRollbackVerified !== isRuntimeRollback) return false;
  if (isForceKill) {
    if (value.quitAccepted !== false || value.gracefulExitVerified !== false) return false;
  } else if (value.quitAccepted !== true || value.gracefulExitVerified !== true) return false;

  return value.cycles.every((cycle, index) => validCycle(
    cycle, value, expected, index, expectedPortableMode
  ));
}

function validCycle(cycle, evidence, expected, index, expectedPortableMode = false) {
  if (!hasOnlyKeys(cycle, CYCLE_KEYS, [...CYCLE_KEYS].filter(key => key !== 'errorCode'))) return false;
  if (cycle.cycle !== index + 1 || cycle.scenario !== expected.scenario
    || cycle.portableMode !== expectedPortableMode
    || !isBooleanRecord(cycle, CYCLE_BOOLEAN_KEYS)
    || !POSITIVE_CYCLE_NUMBER_KEYS.every(key => isPositiveInteger(cycle[key]))
    || !NON_NEGATIVE_CYCLE_NUMBER_KEYS.every(key => isNonNegativeInteger(cycle[key]))) return false;
  if (cycle.errorCode !== undefined && !isNullableProductionErrorCode(cycle.errorCode)) return false;
  if (!Array.isArray(cycle.remainingPids) || !Array.isArray(cycle.finalScopedProcessAuditPids)
    || !Array.isArray(cycle.finalScopedProcessAuditKinds)
    || !cycle.remainingPids.every(isPositiveInteger)
    || !cycle.finalScopedProcessAuditPids.every(isPositiveInteger)
    || !cycle.finalScopedProcessAuditKinds.every(kind => PROCESS_AUDIT_KINDS.has(kind))
    || cycle.remainingPids.length !== 0
    || cycle.finalScopedProcessAuditCount !== cycle.finalScopedProcessAuditPids.length
    || (cycle.finalScopedProcessAuditPassed === true && (cycle.finalScopedProcessAuditCount !== 0 || cycle.finalScopedProcessAuditKinds.length !== 0))) return false;
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
  if (cycle.workspaceWriteVerified !== (expected.scenario === 'workspace-write')) return false;
  if (!validRuntimeRollbackEvidence(cycle.runtimeRollback, expected.scenario === 'runtime-rollback')) return false;
  return cycle.runtimeRollbackVerified === (expected.scenario === 'runtime-rollback');
}

function validRuntimeRollbackEvidence(value, requested) {
  if (!hasOnlyKeys(value, RUNTIME_ROLLBACK_KEYS)
    || !isBooleanRecord(value, [...RUNTIME_ROLLBACK_KEYS])) return false;
  return Object.values(value).every(actual => actual === requested);
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
    || !Array.isArray(value.cleanupErrorCodes)
    || !value.cleanupErrorCodes.every(isKnownProductionErrorCode)
    || value.cleanupErrorCodes.length !== 0) return false;
  const requiredTrue = [
    'installStarted', 'installCompleted', 'shortcutsCreated', 'suitePassed',
    'uninstallAttempted', 'uninstallSucceeded', 'installDirectoryRemoved',
    'processClean', 'registryClean', 'shortcutsClean'
  ];
  if (!isBooleanRecord(value, [
    ...requiredTrue, 'installLocationRecordMatched', 'uninstallCommandRecordMatched'
  ]) || !requiredTrue.every(key => value[key] === true)) return false;
  if (!value.installLocationRecordMatched && !value.uninstallCommandRecordMatched) return false;
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

function stripWindowsNamespacePrefix(value) {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

function comparablePath(value) {
  const normalized = path.normalize(stripWindowsNamespacePrefix(path.normalize(value)));
  const root = path.parse(normalized).root;
  const withoutTrailingSeparator = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/u, '')
    : normalized;
  return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isPathWithin(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative.length > 0 && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isLinkOrReparse(value) {
  return value?.isSymbolicLink?.() === true || value?.isReparsePoint?.() === true;
}

async function pathHasReparseComponent(filename) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return true;
    }
    if (isLinkOrReparse(info)) return true;
  }
  return false;
}

function directoryFailure() {
  return { ok: false, errors: [failure('<directory>', 'EVIDENCE_DIRECTORY_INVALID')] };
}

function fileFailure(name) {
  return {
    ok: false,
    errors: [failure(name, name === INSTALLED_SUMMARY_FILE
      ? 'INSTALLED_SUMMARY_INVALID'
      : 'PACKAGED_EVIDENCE_INVALID')]
  };
}

async function inspectEvidenceDirectory(directory) {
  let absoluteDirectory;
  try {
    absoluteDirectory = path.resolve(directory);
  } catch {
    return directoryFailure();
  }

  let directoryInfo;
  try {
    directoryInfo = await lstat(absoluteDirectory);
  } catch {
    return directoryFailure();
  }
  if (!directoryInfo.isDirectory() || isLinkOrReparse(directoryInfo)) return directoryFailure();

  // A Windows TEMP variable may use an 8.3 alias while realpath() returns the
  // long spelling. Reject actual reparse components, but allow equivalent
  // spellings of an ordinary directory and use its canonical path below.
  if (await pathHasReparseComponent(absoluteDirectory)) return directoryFailure();

  let realDirectory;
  try {
    realDirectory = await realpath(absoluteDirectory);
  } catch {
    return directoryFailure();
  }
  absoluteDirectory = realDirectory;

  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return directoryFailure();
  }

  const names = new Set(entries.map(entry => entry.name));
  const missing = EVIDENCE_FILE_NAMES.filter(name => !names.has(name));
  const hasExtra = entries.length !== EVIDENCE_FILE_NAMES.length
    || entries.some(entry => !EVIDENCE_FILE_NAME_SET.has(entry.name));
  if (missing.length > 0 || hasExtra) {
    const errors = missing.map(name => failure(name, name === INSTALLED_SUMMARY_FILE
      ? 'INSTALLED_SUMMARY_MISSING'
      : 'PACKAGED_EVIDENCE_MISSING_OR_INVALID'));
    if (hasExtra) errors.push(failure('<directory>', 'EVIDENCE_DIRECTORY_CONTENTS_INVALID'));
    return { ok: false, errors };
  }

  for (const name of EVIDENCE_FILE_NAMES) {
    const entry = entries.find(candidate => candidate.name === name);
    const filename = path.join(absoluteDirectory, name);
    let fileInfo;
    try {
      fileInfo = await lstat(filename);
    } catch {
      return fileFailure(name);
    }
    if (!entry || isLinkOrReparse(entry) || isLinkOrReparse(fileInfo) || !fileInfo.isFile()) {
      return fileFailure(name);
    }

    let realFile;
    try {
      realFile = await realpath(filename);
    } catch {
      return fileFailure(name);
    }
    if (!isPathWithin(realDirectory, realFile) || !samePath(path.dirname(realFile), realDirectory)) {
      return fileFailure(name);
    }
  }
  return { ok: true, directory: absoluteDirectory };
}

export async function verifyEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    return { ok: false, errors: [failure('<directory>', 'INVALID_ARGUMENT')] };
  }
  const inspected = await inspectEvidenceDirectory(directory);
  if (!inspected.ok) return inspected;
  const evidenceDirectory = inspected.directory;

  const errors = [];
  for (const expected of PACKAGED_FILES) {
    const file = path.join(evidenceDirectory, expected.name);
    const value = await readJson(file);
    if (value === undefined) {
      errors.push(failure(expected.name, 'PACKAGED_EVIDENCE_MISSING_OR_INVALID'));
    } else if (!validPackagedEvidence(value, expected)) {
      errors.push(failure(expected.name, 'PACKAGED_EVIDENCE_INVALID'));
    }
  }

  const summary = await readJson(path.join(evidenceDirectory, INSTALLED_SUMMARY_FILE));
  if (summary === undefined || !validInstalledSummary(summary)) {
    errors.push(failure(INSTALLED_SUMMARY_FILE, 'INSTALLED_SUMMARY_INVALID'));
  }
  return { ok: errors.length === 0, errors };
}

function portableFileLabel(filename) {
  try {
    return path.basename(path.resolve(filename)) || '<file>';
  } catch {
    return '<file>';
  }
}

async function inspectStandaloneEvidenceFile(filename) {
  let absoluteFile;
  try {
    absoluteFile = path.resolve(filename);
  } catch {
    return { ok: false, code: 'PACKAGED_EVIDENCE_INVALID' };
  }

  let fileInfo;
  try {
    fileInfo = await lstat(absoluteFile);
  } catch {
    return { ok: false, code: 'PACKAGED_EVIDENCE_MISSING_OR_INVALID' };
  }
  if (!fileInfo.isFile() || isLinkOrReparse(fileInfo)
    || await pathHasReparseComponent(absoluteFile)) {
    return { ok: false, code: 'PACKAGED_EVIDENCE_INVALID' };
  }

  let realFile;
  try {
    realFile = await realpath(absoluteFile);
  } catch {
    return { ok: false, code: 'PACKAGED_EVIDENCE_INVALID' };
  }
  return { ok: true, file: realFile };
}

export async function verifyPortableEvidenceFiles(files) {
  if (!Array.isArray(files) || files.length === 0
    || files.some(file => typeof file !== 'string' || file.length === 0 || file.startsWith('-'))) {
    return { ok: false, errors: [failure('<portable>', 'INVALID_ARGUMENT')] };
  }

  const errors = [];
  for (const filename of files) {
    const label = portableFileLabel(filename);
    const inspected = await inspectStandaloneEvidenceFile(filename);
    if (!inspected.ok) {
      errors.push(failure(label, inspected.code));
      continue;
    }
    const value = await readJson(inspected.file);
    if (value === undefined) {
      errors.push(failure(label, 'PACKAGED_EVIDENCE_MISSING_OR_INVALID'));
    } else if (!validPackagedEvidence(value, PORTABLE_EVIDENCE_EXPECTATION, true)) {
      errors.push(failure(label, 'PACKAGED_EVIDENCE_INVALID'));
    }
  }
  return { ok: errors.length === 0, errors };
}

export {
  PACKAGED_FILES,
  PORTABLE_EVIDENCE_EXPECTATION,
  validPackagedEvidence,
  validInstalledSummary
};

function isMain() {
  return process.argv[1]
    && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === '--portable') {
    const files = args.slice(1);
    if (files.length === 0 || files.some(file => file.length === 0 || file.startsWith('-'))) {
      console.error('FAIL INVALID_ARGUMENT');
      process.exitCode = 2;
    } else {
      try {
        const result = await verifyPortableEvidenceFiles(files);
        if (result.ok) console.log('PASS');
        else {
          console.error(`FAIL ${result.errors[0] ?? 'EVIDENCE_INVALID'}`);
          process.exitCode = 1;
        }
      } catch {
        console.error('FAIL PACKAGED_EVIDENCE_INVALID');
        process.exitCode = 2;
      }
    }
  } else if (args.length !== 1 || args[0].startsWith('-')) {
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
