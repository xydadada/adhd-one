import { randomBytes } from 'node:crypto';
import { createConnection, createServer, isIP } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { measureWindowsProcessCpu } from './windows-process-cpu.mjs';
import { collectExecutableProof } from './win11-host-proof.mjs';

const execFileAsync = promisify(execFile);

const CONTROL_WINDOW_TIMEOUT_MS = 60_000;
const CDP_TIMEOUT_MS = 30_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const FORCE_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_TREE_DISCOVERY_TIMEOUT_MS = 20_000;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;
const PROCESS_PATH_AUDIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const TEMP_ROOT_PREFIX = 'adhd-one-packaged-e2e-';
const RUNTIME_ROLLBACK_STATE_VERSION = '999.0.0-e2e-broken';
const RUNTIME_ROLLBACK_PACKAGE_VERSION = '998.0.0-e2e-mismatch';
const QUALIFICATION_EVIDENCE_SCHEMA_VERSION = 1;
const QUALIFICATION_EVIDENCE_TOOL = 'adhd-one-packaged-qualification';
const QUALIFICATION_LIMITS = Object.freeze({ firstInteractiveMs: 15_000, hotReadyMs: 8_000, idleCpuPercent: 1, exitMs: 5_000 });

const E2E_SCENARIOS = new Set(['launch', 'force-kill', 'workspace-write', 'runtime-rollback']);
export const CLI_SCENARIOS = new Set([...E2E_SCENARIOS, 'qualification']);
const EVIDENCE_CLEANUP_STATES = new Set(['pending', 'removed', 'failed', 'not-created']);
const WORKSPACE_RPC_CLIENT_SOURCES = new Set(['not-run', 'packaged-asar', 'local-out', 'unavailable']);
const WORKSPACE_PERMISSION_MODES = new Set(['not-run', 'workspace-write', 'danger-full-access', 'other', 'unknown']);
const WORKSPACE_APPROVAL_STATES = new Set(['not-requested', 'unexpected', 'rejected']);
const PROCESS_AUDIT_KINDS = new Set(['known-identity', 'known-ancestor', 'temp-root', 'launch-executable']);
const WORKSPACE_PROVIDER_SEQUENCES = new Set(['not-run', 'matched', 'mismatch', 'unknown']);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TRUSTED_ERROR_CODE_PREFIXES = [
  'APP_', 'APPLICATION_', 'RUNTIME_', 'CONTROL_', 'HOST_', 'CDP_', 'E2E_',
  'LOOPBACK_', 'PROCESS_', 'EXE_', 'INVALID_', 'NOT_', 'ACCESS_', 'NETWORK_',
  'WORKSPACE_', 'MOCK_', 'RPC_', 'DSH_', 'PORTABLE_', 'CLEANUP_', 'WINDOWS_'
];

function safeCode(value) {
  const candidate = String(value ?? '').toUpperCase();
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : undefined;
}

export function stableErrorCode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object' && typeof value.code === 'string') {
    const code = safeCode(value.code);
    if (code && (code.startsWith('E') || TRUSTED_ERROR_CODE_PREFIXES.some(prefix => code.startsWith(prefix)))) return code;
  }
  const message = value instanceof Error ? value.message : String(value);
  const explicitCodes = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu);
  if (explicitCodes?.length) {
    const trusted = explicitCodes.findLast(code => TRUSTED_ERROR_CODE_PREFIXES.some(prefix => code.startsWith(prefix)));
    if (trusted) return safeCode(trusted);
  }
  const systemCode = message.match(/\bE[A-Z0-9_]{2,}\b/gu)?.[0];
  if (systemCode) return safeCode(systemCode);
  if (/timeout/iu.test(message)) return 'E2E_TIMEOUT';
  if (/not found/iu.test(message)) return 'NOT_FOUND';
  if (/permission|access denied/iu.test(message)) return 'ACCESS_DENIED';
  if (/invalid|missing|required|unknown|duplicate/iu.test(message)) return 'INVALID_ARGUMENT';
  if (/fetch|network|connect|socket/iu.test(message)) return 'NETWORK_ERROR';
  return 'E2E_ERROR';
}

function isTimeoutLike(value) {
  const text = value instanceof Error
    ? `${value.name ?? ''} ${value.message ?? ''}`
    : String(value ?? '');
  return /timeout|timed[ -]?out|deadline exceeded/iu.test(text);
}

export function stableStageErrorCode(value, failureCode, timeoutCode) {
  const code = stableErrorCode(value);
  if (code && code !== 'E2E_TIMEOUT' && code !== 'E2E_ERROR' && code !== 'ETIMEDOUT') return code;
  if (code === 'E2E_TIMEOUT' || code === 'ETIMEDOUT' || isTimeoutLike(value)) {
    return safeCode(timeoutCode) ?? 'E2E_TIMEOUT';
  }
  return safeCode(failureCode) ?? 'E2E_ERROR';
}

function stableStageError(value, failureCode, timeoutCode) {
  return new Error(stableStageErrorCode(value, failureCode, timeoutCode));
}

async function withStableStage(operation, failureCode, timeoutCode) {
  try {
    return await operation();
  } catch (error) {
    throw stableStageError(error, failureCode, timeoutCode);
  }
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safePid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeExitCode(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0) ? value : undefined;
}

function safeSignal(value) {
  if (value === null) return null;
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : undefined;
}

function safeExecutableName(value) {
  const text = String(value ?? '');
  if (/%(?:25|2f|3a|5c)/iu.test(text)) return '<redacted-executable>';
  const name = path.win32.basename(text);
  if (!name || name === '.') return '<unknown-executable>';
  return /sk-[A-Za-z0-9_-]{8,}|authorization|api[_-]?key|secret|token/iu.test(name) ? '<redacted-executable>' : name;
}

function safeTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value) ? value : new Date().toISOString();
}

function safeScenario(value) {
  return E2E_SCENARIOS.has(value) ? value : 'launch';
}

function sanitizeRuntimeRollbackEvidence(value, scenario) {
  const rollback = value ?? {};
  const requested = scenario === 'runtime-rollback';
  return {
    requested,
    verified: requested && rollback.verified === true,
    candidateSeeded: requested && rollback.candidateSeeded === true,
    bundledActive: requested && rollback.bundledActive === true,
    previousCandidateRecorded: requested && rollback.previousCandidateRecorded === true,
    healthy: requested && rollback.healthy === true,
    candidateCleared: requested && rollback.candidateCleared === true,
    rollbackMarkerRecorded: requested && rollback.rollbackMarkerRecorded === true,
    candidateSlotRetained: requested && rollback.candidateSlotRetained === true,
    readyVerified: requested && rollback.readyVerified === true,
    postExitVerified: requested && rollback.postExitVerified === true
  };
}

function safeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function sanitizeWorkspaceEvidence(value, scenario) {
  const workspace = value ?? {};
  const requested = scenario === 'workspace-write';
  return {
    requested,
    verified: requested && workspace.verified === true,
    rpcClientSource: requested ? safeEnum(workspace.rpcClientSource, WORKSPACE_RPC_CLIENT_SOURCES, 'unavailable') : 'not-run',
    permissionMode: requested ? safeEnum(workspace.permissionMode, WORKSPACE_PERMISSION_MODES, 'unknown') : 'not-run',
    approval: requested ? safeEnum(workspace.approval, WORKSPACE_APPROVAL_STATES, 'not-requested') : 'not-requested',
    providerSequence: requested ? safeEnum(workspace.providerSequence, WORKSPACE_PROVIDER_SEQUENCES, 'unknown') : 'not-run',
    approvalRequested: requested && workspace.approvalRequested === true,
    sessionCreated: requested && workspace.sessionCreated === true,
    sessionArchived: requested && workspace.sessionArchived === true,
    historyVerified: requested && workspace.historyVerified === true,
    providerAuthVerified: requested && workspace.providerAuthVerified === true,
    powerShellCall: requested && workspace.powerShellCall === true,
    toolResult: requested && workspace.toolResult === true,
    sentinelFile: requested && workspace.sentinelFile === true,
    secondProviderTurn: requested && workspace.secondProviderTurn === true,
    finalNonce: requested && workspace.finalNonce === true
  };
}

function sanitizeCycleEvidence(record, defaultScenario = 'launch') {
  const cycle = record ?? {};
  const scenario = safeScenario(cycle.scenario ?? defaultScenario);
  const errorCode = cycle.errorCode === undefined
    ? undefined
    : stableStageErrorCode(cycle.errorCode, 'E2E_CYCLE_FAILED', 'E2E_CYCLE_TIMEOUT');
  return {
    cycle: nonNegativeInteger(cycle.cycle, 0),
    scenario,
    passed: cycle.passed === true,
    launchVerified: cycle.launchVerified === true,
    launchMs: nonNegativeInteger(cycle.launchMs),
    controlWindowMs: nonNegativeInteger(cycle.controlWindowMs),
    runtimeReadyMs: nonNegativeInteger(cycle.runtimeReadyMs),
    exitMs: nonNegativeInteger(cycle.exitMs),
    pid: safePid(cycle.pid),
    cdpPort: nonNegativeInteger(cycle.cdpPort),
    portableMode: cycle.portableMode === true,
    controlWindowVerified: cycle.controlWindowVerified === true,
    runtimeReadyVerified: cycle.runtimeReadyVerified === true,
    hostDescribeVerified: cycle.hostDescribeVerified === true,
    runtimePid: safePid(cycle.runtimePid),
    isolationVerified: cycle.isolationVerified === true,
    cdpClosed: cycle.cdpClosed === true,
    runtimePidExited: cycle.runtimePidExited === true,
    processTreeExited: cycle.processTreeExited === true,
    quitAccepted: cycle.quitAccepted === true,
    gracefulExitVerified: cycle.gracefulExitVerified === true,
    exitVerified: cycle.exitVerified === true,
    processTreeCount: nonNegativeInteger(cycle.processTreeCount, 0),
    remainingPids: Array.isArray(cycle.remainingPids) ? cycle.remainingPids.map(safePid).filter(pid => pid !== undefined) : [],
    exitCode: safeExitCode(cycle.exitCode),
    exitSignal: safeSignal(cycle.exitSignal),
    forceKillRequested: scenario === 'force-kill',
    forceKillVerified: scenario === 'force-kill' && cycle.forceKillVerified === true,
    forcedTermination: cycle.forcedTermination === true,
    cleanup: EVIDENCE_CLEANUP_STATES.has(cycle.cleanup) ? cycle.cleanup : 'unknown',
    cleanupRootExisted: cycle.cleanupRootExisted === true,
    cleanupRootAbsent: cycle.cleanupRootAbsent === true,
    cleanupVerified: cycle.cleanupVerified === true,
    finalScopedProcessAuditPassed: cycle.finalScopedProcessAuditPassed === true,
    finalScopedProcessAuditCount: nonNegativeInteger(cycle.finalScopedProcessAuditCount, 0),
    finalScopedProcessAuditPids: Array.isArray(cycle.finalScopedProcessAuditPids)
      ? cycle.finalScopedProcessAuditPids.map(safePid).filter(pid => pid !== undefined)
      : [],
    finalScopedProcessAuditKinds: Array.isArray(cycle.finalScopedProcessAuditKinds)
      ? [...new Set(cycle.finalScopedProcessAuditKinds.filter(kind => PROCESS_AUDIT_KINDS.has(kind)))].sort()
      : [],
    errorCode,
    stdoutBytes: nonNegativeInteger(cycle.stdoutBytes, 0),
    stderrBytes: nonNegativeInteger(cycle.stderrBytes, 0),
    workspaceWriteVerified: scenario === 'workspace-write' && cycle.workspaceWriteVerified === true,
    workspaceWrite: sanitizeWorkspaceEvidence(cycle.workspaceWrite, scenario),
    runtimeRollbackVerified: scenario === 'runtime-rollback' && cycle.runtimeRollbackVerified === true,
    runtimeRollback: sanitizeRuntimeRollbackEvidence(cycle.runtimeRollback, scenario)
  };
}

export function sanitizeEvidence(evidence) {
  const scenario = safeScenario(evidence?.scenario);
  const cycles = Array.isArray(evidence?.cycles) ? evidence.cycles.map(cycle => sanitizeCycleEvidence(cycle, scenario)) : [];
  return {
    schemaVersion: 1,
    tool: 'adhd-one-packaged-e2e',
    generatedAt: safeTimestamp(evidence?.generatedAt),
    executable: safeExecutableName(evidence?.executable),
    scenario,
    portableMode: evidence?.portableMode === true,
    launchVerified: evidence?.launchVerified === true,
    forceKillRequested: scenario === 'force-kill',
    forceKillVerified: scenario === 'force-kill' && evidence?.forceKillVerified === true,
    quitAccepted: evidence?.quitAccepted === true,
    gracefulExitVerified: evidence?.gracefulExitVerified === true,
    exitVerified: evidence?.exitVerified === true,
    cleanupVerified: evidence?.cleanupVerified === true,
    finalScopedProcessAuditPassed: evidence?.finalScopedProcessAuditPassed === true,
    workspaceWriteRequested: scenario === 'workspace-write',
    workspaceWriteVerified: scenario === 'workspace-write' && evidence?.workspaceWriteVerified === true,
    runtimeRollbackRequested: scenario === 'runtime-rollback',
    runtimeRollbackVerified: scenario === 'runtime-rollback' && evidence?.runtimeRollbackVerified === true,
    cyclesRequested: nonNegativeInteger(evidence?.cyclesRequested, cycles.length),
    cyclesCompleted: nonNegativeInteger(evidence?.cyclesCompleted, cycles.length),
    passed: evidence?.passed === true,
    cycles
  };
}

function sanitizeQualificationCycle(record) {
  const cycle = record ?? {};
  const forcedTermination = cycle.forcedTermination === true;
  const hostToolchainPathExcluded = cycle.hostToolchainPathExcluded === true;
  const idleCpuMeasured = cycle.idleCpuMeasured === true;
  const spawnToControlWindowMs = nonNegativeInteger(cycle.spawnToControlWindowMs);
  const restartToReadyMs = nonNegativeInteger(cycle.restartToReadyMs);
  const idleCpuPercent = nonNegativeFiniteNumber(cycle.idleCpuPercent);
  const idleCpuProcessCount = nonNegativeInteger(cycle.idleCpuProcessCount, 0);
  const executableSha256 = typeof cycle.executableSha256 === 'string' && SHA256_PATTERN.test(cycle.executableSha256)
    ? cycle.executableSha256
    : undefined;
  const quitToExitMs = nonNegativeInteger(cycle.quitToExitMs);
  const withinLimits = spawnToControlWindowMs !== undefined && spawnToControlWindowMs <= QUALIFICATION_LIMITS.firstInteractiveMs
    && restartToReadyMs !== undefined && restartToReadyMs <= QUALIFICATION_LIMITS.hotReadyMs
    && idleCpuPercent !== undefined && idleCpuPercent < QUALIFICATION_LIMITS.idleCpuPercent
    && quitToExitMs !== undefined && quitToExitMs <= QUALIFICATION_LIMITS.exitMs;
  const errorCode = cycle.errorCode === undefined
    ? undefined
    : stableStageErrorCode(cycle.errorCode, 'QUALIFICATION_FAILED', 'QUALIFICATION_TIMEOUT');
  return {
    cycle: nonNegativeInteger(cycle.cycle, 1),
    scenario: 'qualification',
    passed: cycle.passed === true && !forcedTermination && hostToolchainPathExcluded
      && executableSha256 !== undefined && idleCpuMeasured && idleCpuProcessCount > 0 && withinLimits,
    spawnVerified: cycle.spawnVerified === true,
    hostToolchainPathExcluded,
    executableSha256,
    spawnToControlWindowMs,
    controlWindowVerified: cycle.controlWindowVerified === true,
    controlWindowOperational: cycle.controlWindowOperational === true,
    coldRuntimeReadyVerified: cycle.coldRuntimeReadyVerified === true,
    coldGeneration: nonNegativeInteger(cycle.coldGeneration),
    restartRequested: cycle.restartRequested === true,
    restartRuntimeAccepted: cycle.restartRuntimeAccepted === true,
    restartReadyVerified: cycle.restartReadyVerified === true,
    restartToReadyMs,
    idleCpuMeasured,
    idleCpuPercent,
    idleCpuProcessCount,
    hotGeneration: nonNegativeInteger(cycle.hotGeneration),
    electronRootStable: cycle.electronRootStable === true,
    coldProcessTreeObserved: cycle.coldProcessTreeObserved === true,
    hotProcessTreeObserved: cycle.hotProcessTreeObserved === true,
    coldProcessTreeCount: nonNegativeInteger(cycle.coldProcessTreeCount, 0),
    hotProcessTreeCount: nonNegativeInteger(cycle.hotProcessTreeCount, 0),
    mergedProcessTreeCount: nonNegativeInteger(cycle.mergedProcessTreeCount, 0),
    processTreeExited: cycle.processTreeExited === true,
    quitAccepted: cycle.quitAccepted === true,
    quitToExitMs,
    gracefulExitVerified: cycle.gracefulExitVerified === true,
    forcedTermination,
    exitCode: safeExitCode(cycle.exitCode),
    exitSignal: safeSignal(cycle.exitSignal),
    exitVerified: cycle.exitVerified === true,
    cdpClosed: cycle.cdpClosed === true,
    cleanup: EVIDENCE_CLEANUP_STATES.has(cycle.cleanup) ? cycle.cleanup : 'unknown',
    cleanupRootExisted: cycle.cleanupRootExisted === true,
    cleanupRootAbsent: cycle.cleanupRootAbsent === true,
    cleanupVerified: cycle.cleanupVerified === true,
    finalScopedProcessAuditPassed: cycle.finalScopedProcessAuditPassed === true,
    finalScopedProcessAuditCount: nonNegativeInteger(cycle.finalScopedProcessAuditCount, 0),
    errorCode
  };
}

export function sanitizeQualificationEvidence(evidence) {
  const rawCycles = Array.isArray(evidence?.cycles) ? evidence.cycles : [];
  const cycles = rawCycles.length > 0 ? [sanitizeQualificationCycle(rawCycles[0])] : [];
  const forcedTermination = cycles[0]?.forcedTermination === true;
  return {
    schemaVersion: QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
    tool: QUALIFICATION_EVIDENCE_TOOL,
    generatedAt: safeTimestamp(evidence?.generatedAt),
    scenario: 'qualification',
    cyclesRequested: 1,
    cyclesCompleted: cycles.length === 1 ? 1 : 0,
    spawnVerified: evidence?.spawnVerified === true,
    coldStartVerified: evidence?.coldStartVerified === true,
    restartRuntimeVerified: evidence?.restartRuntimeVerified === true,
    electronRootStable: evidence?.electronRootStable === true,
    quitAccepted: evidence?.quitAccepted === true,
    gracefulExitVerified: evidence?.gracefulExitVerified === true,
    exitVerified: evidence?.exitVerified === true,
    cleanupVerified: evidence?.cleanupVerified === true,
    finalScopedProcessAuditPassed: evidence?.finalScopedProcessAuditPassed === true,
    passed: evidence?.passed === true && !forcedTermination && cycles[0]?.passed === true,
    cycles
  };
}

function countStreamBytes(stats, chunk) {
  stats.bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
}

function usage() {
  return [
    'Usage:',
    '  node scripts/e2e/packaged.mjs --exe <path-to-app-exe> --output <json-file-or-directory> [--cycles <n>] [--scenario <launch|force-kill|workspace-write|runtime-rollback|qualification>] [--require-portable]',
    '',
    'The executable must be the installed or extracted ADHD One application executable, not the NSIS installer.'
  ].join('\n');
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('INVALID_ARGUMENT');
  const values = { exe: undefined, output: undefined, cycles: 1, scenario: 'launch', requirePortable: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string') throw new Error('INVALID_ARGUMENT');
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exitCode = 0;
      return undefined;
    }
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    let value = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (name !== '--exe' && name !== '--output' && name !== '--cycles' && name !== '--scenario' && name !== '--require-portable') {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate argument: ${name}`);
    seen.add(name);
    if (name === '--require-portable') {
      if (equal >= 0) throw new Error('--require-portable does not accept a value');
      values.requirePortable = true;
      continue;
    }
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (name === '--exe') values.exe = value;
    else if (name === '--output') values.output = value;
    else if (name === '--cycles') {
      const cycles = Number(value);
      if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) throw new Error('--cycles must be an integer from 1 to 100');
      values.cycles = cycles;
    } else {
      if (!CLI_SCENARIOS.has(value)) throw new Error('--scenario must be launch, force-kill, workspace-write, runtime-rollback, or qualification');
      values.scenario = value;
    }
  }
  if (!values.exe || !values.output) throw new Error(`--exe and --output are required\n\n${usage()}`);
  if (values.scenario === 'qualification') values.cycles = 1;
  return values;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function findFreeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LOOPBACK_PORT_ALLOCATION_FAILED');
  return port;
}

function removeEnvironmentKeys(environment, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  for (const key of Object.keys(environment)) if (wanted.has(key.toLowerCase())) delete environment[key];
}

function createTestEnvironment(root, appData, localAppData) {
  const environment = { ...process.env };
  removeEnvironmentKeys(environment, [
    'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
    'NPM_CONFIG_PREFIX', 'PNPM_HOME', 'npm_config_prefix', 'npm_execpath'
  ]);
  for (const key of Object.keys(environment)) if (/(?:api.?key|authorization|credential|secret|token)/iu.test(key)) delete environment[key];
  const systemRoot = environment.SystemRoot ?? environment.windir ?? 'C:\\Windows';
  const profile = path.join(root, 'profile');
  const temp = path.join(root, 'temp');
  environment.APPDATA = appData;
  environment.LOCALAPPDATA = localAppData;
  environment.USERPROFILE = profile;
  environment.HOME = profile;
  environment.HOMEDRIVE = path.parse(profile).root;
  environment.HOMEPATH = profile.slice(path.parse(profile).root.length);
  environment.TEMP = temp;
  environment.TMP = temp;
  environment.SystemRoot = systemRoot;
  environment.windir = systemRoot;
  environment.ComSpec = path.join(systemRoot, 'System32', 'cmd.exe');
  environment.PATH = path.join(systemRoot, 'System32');
  return environment;
}

export function isHostToolchainPathExcluded(environment) {
  if (!environment || typeof environment !== 'object') return false;
  const systemRoot = environment.SystemRoot ?? environment.windir;
  if (typeof systemRoot !== 'string' || systemRoot.length === 0) return false;
  return environment.PATH === path.win32.join(systemRoot, 'System32');
}

function observeExit(child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ...result, at: Date.now() });
    };
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', error => finish({
      code: null,
      signal: null,
      errorCode: stableStageErrorCode(error, 'PROCESS_EXIT_FAILED', 'PROCESS_EXIT_TIMEOUT')
    }));
    if (child.exitCode !== null || child.signalCode !== null) finish({ code: child.exitCode, signal: child.signalCode });
  });
}

async function exitedWithin(exitPromise, milliseconds) {
  try {
    await withTimeout(exitPromise, milliseconds, 'PROCESS_EXIT');
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'PROCESS_EXIT_TIMEOUT') return false;
    return true;
  }
}

async function exitInfoWithin(exitPromise, milliseconds) {
  try {
    return await withTimeout(exitPromise, milliseconds, 'PROCESS_EXIT');
  } catch (error) {
    if (error instanceof Error && error.message === 'PROCESS_EXIT_TIMEOUT') return undefined;
    return undefined;
  }
}

function isLoopbackHostname(value) {
  const hostname = String(value ?? '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost') return true;
  const addressType = isIP(hostname);
  if (addressType === 4) {
    const octets = hostname.split('.').map(Number);
    return octets.length === 4 && octets[0] === 127;
  }
  return addressType === 6 && hostname === '::1';
}

export function isValidCdpWebSocketUrl(candidate, expectedPort) {
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) return false;
  let url;
  try { url = new URL(candidate); }
  catch { return false; }
  return (url.protocol === 'ws:' || url.protocol === 'wss:')
    && isLoopbackHostname(url.hostname)
    && url.port !== ''
    && Number(url.port) === expectedPort
    && url.username === ''
    && url.password === '';
}

export async function waitForCdp(port, child) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('APPLICATION_EXITED_BEFORE_CDP');
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        let version;
        try { version = await response.json(); }
        catch { version = undefined; }
        if (isRecord(version) && isValidCdpWebSocketUrl(version.webSocketDebuggerUrl, port)) {
          // Playwright's connectOverCDP performs its own /json/version discovery.
          // Validate Chromium's advertised websocket first, then give Playwright
          // the stable HTTP endpoint instead of coupling to a transient browser id.
          return endpoint;
        }
      }
    } catch {
      // The stable discovery timeout below is the only observable failure detail.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('CDP_DISCOVERY_TIMEOUT');
}

function isControlUrl(candidate) {
  try {
    const url = new URL(candidate);
    return url.protocol === 'adhd-one:' && url.hostname === 'app';
  } catch {
    return candidate.startsWith('adhd-one://app');
  }
}

function allPages(browser) {
  return browser.contexts().flatMap(context => context.pages());
}

async function waitForControlWindow(browser, child, exitPromise) {
  const deadline = Date.now() + CONTROL_WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('APPLICATION_EXITED_BEFORE_CONTROL_WINDOW');
    try {
      const control = allPages(browser).find(page => isControlUrl(page.url()));
      if (control && !control.isClosed()) {
        await control.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
        await control.locator('#state').waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
        if (await control.locator('#state').count()) return control;
      }
    } catch (error) {
      throw stableStageError(error, 'CONTROL_WINDOW_FAILED', 'CONTROL_WINDOW_TIMEOUT');
    }
    const exited = await Promise.race([exitPromise, Promise.resolve(undefined)]);
    if (exited) throw new Error('APPLICATION_EXITED_BEFORE_CONTROL_WINDOW');
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('CONTROL_WINDOW_TIMEOUT');
}

export async function waitForRuntimeReady(control, child, exitPromise, minimumGeneration = 0) {
  if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0) throw new Error('INVALID_MINIMUM_GENERATION');
  const deadline = Date.now() + CONTROL_WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('APPLICATION_EXITED_WHILE_WAITING_FOR_READY');
    if (control.isClosed()) throw new Error('CONTROL_WINDOW_CLOSED_BEFORE_READY');
    const statusText = (await control.locator('#state').textContent().catch(() => ''))?.trim() ?? '';
    if (/^Harness[：:]\s*ready\b/iu.test(statusText)) {
      const snapshot = await withStableStage(
        () => control.evaluate(() => window.adhdOne.getAppSnapshot()),
        'RUNTIME_SNAPSHOT_EVALUATE_FAILED',
        'RUNTIME_SNAPSHOT_EVALUATE_TIMEOUT'
      );
      const runtime = snapshot?.runtime;
      if (runtime?.state === 'ready' && safePid(runtime.pid) && runtime.url
        && Number.isSafeInteger(runtime.generation) && runtime.generation >= minimumGeneration) {
        return { snapshot };
      }
      if (minimumGeneration > 0 && Number.isSafeInteger(runtime?.generation)
        && runtime.generation < minimumGeneration) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      if (minimumGeneration > 0 && ['preparing', 'starting', 'stopping', 'updating'].includes(runtime?.state)) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error('RUNTIME_SNAPSHOT_NOT_READY');
    }
    if (/^Harness[：:]\s*failed\b/iu.test(statusText)) throw new Error('RUNTIME_FAILED');
    const exited = await Promise.race([exitPromise, Promise.resolve(undefined)]);
    if (exited) throw new Error('APPLICATION_EXITED_WHILE_WAITING_FOR_READY');
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('RUNTIME_READY_TIMEOUT');
}

async function verifyControlWindowOperational(control) {
  const state = await withStableStage(
    () => control.evaluate(() => ({
      stateElement: Boolean(document.querySelector('#state')),
      snapshot: typeof window.adhdOne?.getAppSnapshot === 'function',
      restartRuntime: typeof window.adhdOne?.restartRuntime === 'function',
      quitApp: typeof window.adhdOne?.quitApp === 'function'
    })),
    'CONTROL_WINDOW_OPERATIONAL_CHECK_FAILED',
    'CONTROL_WINDOW_OPERATIONAL_CHECK_TIMEOUT'
  );
  return state?.stateElement === true && state.snapshot === true
    && state.restartRuntime === true && state.quitApp === true;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestHostDescribe(runtimeUrl, cycle) {
  const response = await withStableStage(
    () => fetch(`${runtimeUrl}/api/host.describe`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${cycle}`, method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(5_000)
    }),
    'HOST_DESCRIBE_FAILED',
    'HOST_DESCRIBE_TIMEOUT'
  );
  let value;
  try { value = await response.json(); }
  catch (error) { throw stableStageError(error, 'HOST_DESCRIBE_RESPONSE_INVALID', 'HOST_DESCRIBE_TIMEOUT'); }
  if (!response.ok) throw new Error('HOST_DESCRIBE_HTTP_ERROR');
  if (value?.result?.ok !== true) throw new Error('HOST_DESCRIBE_FAILED');
  return value;
}

function eventText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(eventText).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if ('content' in value) return eventText(value.content);
  if ('message' in value) return eventText(value.message);
  return '';
}

function sessionEvent(value) {
  return isRecord(value) && typeof value.type === 'string'
    && Number.isInteger(value.seq) && value.seq >= 0
    && typeof value.time === 'number' && Number.isFinite(value.time)
    && isRecord(value.data) ? value : undefined;
}

function historyEvents(value) {
  if (!isRecord(value) || !Array.isArray(value.events) || value.hasMore !== false) {
    throw new Error('WORKSPACE_WRITE_HISTORY_INCOMPLETE');
  }
  const events = [];
  for (const entry of value.events) {
    const event = sessionEvent(isRecord(entry) ? entry.event : undefined);
    if (!event) throw new Error('WORKSPACE_WRITE_HISTORY_INVALID');
    events.push(event);
  }
  return events;
}

function waitForCompletedTurn(events, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('WORKSPACE_WRITE_TIMEOUT'));
    };
    const check = () => {
      const completed = events.some(event => event.type === 'turn/end' && isRecord(event.data)
        && isRecord(event.data.reason) && event.data.reason.kind === 'completed');
      if (!completed) return;
      cleanup();
      resolve();
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setInterval(check, 25);
    timer.unref?.();
    check();
  });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function workspaceWritePlan() {
  const nonce = randomBytes(16).toString('hex');
  const sentinelName = `packaged-e2e-${nonce}.txt`;
  return {
    nonce,
    sentinelName,
    toolArguments: JSON.stringify({
      command: `Set-Content -LiteralPath ${powershellLiteral(sentinelName)} -Value ${powershellLiteral(nonce)} -NoNewline`,
      description: 'Write the temporary workspace sentinel file'
    })
  };
}

function normalizePermissionMode(value) {
  if (value === 'workspace-write') return 'workspace-write';
  if (value === 'danger-full-access') return 'danger-full-access';
  if (typeof value === 'string' && value.length > 0) return 'other';
  return 'unknown';
}

function permissionModeFromEvents(events) {
  for (const event of events.toReversed()) {
    if (!isRecord(event.data)) continue;
    if (event.type === 'permission/preset' && typeof event.data.preset === 'string') {
      return normalizePermissionMode(event.data.preset);
    }
    if (event.type === 'sandbox/mode' && typeof event.data.mode === 'string') {
      return normalizePermissionMode(event.data.mode);
    }
    if (event.type !== 'session/projection' || event.data.key !== 'permissions') continue;
    const projection = event.data.value;
    if (typeof projection === 'string') return normalizePermissionMode(projection);
    if (!isRecord(projection)) continue;
    for (const key of ['preset', 'currentValue', 'mode']) {
      if (typeof projection[key] === 'string') return normalizePermissionMode(projection[key]);
    }
  }
  return 'unknown';
}

function inspectWorkspaceEvents(events, nonce, sentinelName) {
  const callIndex = events.findIndex(event => event.type === 'tool/call' && isRecord(event.data)
    && event.data.name === 'pwsh' && typeof event.data.callId === 'string' && typeof event.data.arguments === 'string');
  if (callIndex < 0) throw new Error('WORKSPACE_WRITE_POWERSHELL_CALL_MISSING');
  const callData = events[callIndex].data;
  let argumentsValue;
  try { argumentsValue = JSON.parse(callData.arguments); }
  catch { throw new Error('WORKSPACE_WRITE_POWERSHELL_ARGUMENT_INVALID'); }
  if (!isRecord(argumentsValue) || typeof argumentsValue.command !== 'string'
    || !/set-content|writealltext/iu.test(argumentsValue.command)
    || !argumentsValue.command.includes(sentinelName) || !argumentsValue.command.includes(nonce)) {
    throw new Error('WORKSPACE_WRITE_POWERSHELL_ARGUMENT_INVALID');
  }

  const resultIndex = events.findIndex((event, index) => index > callIndex && event.type === 'tool/result'
    && isRecord(event.data) && isRecord(event.data.message) && isRecord(event.data.message.source)
    && event.data.message.source.kind === 'tool' && event.data.message.source.callId === callData.callId
    && Array.isArray(event.data.message.content) && event.data.message.content.some(block => isRecord(block)
      && block.type === 'tool-result' && block.toolCallId === callData.callId && block.isError !== true));
  if (resultIndex < 0) throw new Error('WORKSPACE_WRITE_TOOL_RESULT_MISSING');

  const finalIndex = events.findIndex((event, index) => index > resultIndex && event.type === 'assistant/message'
    && isRecord(event.data) && isRecord(event.data.message)
    && eventText(event.data.message.content).trim() === nonce);
  if (finalIndex < 0) throw new Error('WORKSPACE_WRITE_FINAL_NONCE_MISSING');
  const completed = events.some((event, index) => index > finalIndex && event.type === 'turn/end'
    && isRecord(event.data) && isRecord(event.data.reason) && event.data.reason.kind === 'completed');
  if (!completed) throw new Error('WORKSPACE_WRITE_TURN_END_MISSING');
  return { powerShellCall: true, toolResult: true, finalNonce: true };
}

function providerSequenceEvidence(mock, apiKey) {
  const requests = Array.isArray(mock?.requests) ? mock.requests : [];
  const providerAuthVerified = requests.length > 0
    && requests.every(request => isRecord(request.headers) && request.headers.authorization === `Bearer ${apiKey}`);
  const matched = requests.length === 2
    && requests[0]?.behavior === 'tool_call_success'
    && requests[1]?.behavior === 'success';
  return {
    providerAuthVerified,
    providerSequence: matched ? 'matched' : requests.length === 0 ? 'unknown' : 'mismatch',
    secondProviderTurn: matched
  };
}

async function importDshRpcClient(modulePath) {
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.DshRpcClient !== 'function') throw new Error('WORKSPACE_RPC_CLIENT_INVALID');
  return module.DshRpcClient;
}

async function loadDshRpcClient(executable, stagingRoot) {
  const asarPath = path.join(path.dirname(executable), 'resources', 'app.asar');
  let asarInfo;
  try { asarInfo = await stat(asarPath); }
  catch (error) {
    if (!isRecord(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
  }
  if (asarInfo) {
    if (!asarInfo.isFile()) throw new Error('WORKSPACE_ASAR_NOT_FILE');
    const asarModule = await import('@electron/asar');
    const extractAll = asarModule.extractAll ?? asarModule.default?.extractAll;
    if (typeof extractAll !== 'function') throw new Error('WORKSPACE_ASAR_EXTRACTOR_MISSING');
    const extractedRoot = path.join(stagingRoot, 'packaged-app');
    await mkdir(extractedRoot, { recursive: true });
    extractAll(asarPath, extractedRoot);
    const modulePath = path.join(extractedRoot, 'out', 'dsh-rpc-client.js');
    if (!await stat(modulePath).then(value => value.isFile()).catch(() => false)) {
      throw new Error('WORKSPACE_RPC_CLIENT_MISSING_FROM_ASAR');
    }
    return { DshRpcClient: await importDshRpcClient(modulePath), source: 'packaged-asar' };
  }

  const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(scriptRoot, '../../out/dsh-rpc-client.js'),
    path.resolve(process.cwd(), 'out/dsh-rpc-client.js')
  ];
  for (const modulePath of candidates) {
    if (!await stat(modulePath).then(value => value.isFile()).catch(() => false)) continue;
    try { return { DshRpcClient: await importDshRpcClient(modulePath), source: 'local-out' }; }
    catch { /* Try the next reliable build location. */ }
  }
  throw new Error('WORKSPACE_RPC_CLIENT_NOT_FOUND');
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function shouldCopyPortableEntry(sourceRoot, source) {
  const portableData = path.join(path.resolve(sourceRoot), 'portable-data');
  const candidate = path.resolve(source);
  return candidate !== portableData && !candidate.startsWith(`${portableData}${path.sep}`);
}

async function windowsProcesses(timeoutMs = WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS) {
  const boundedTimeoutMs = Math.min(WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS, Math.max(1, Math.trunc(timeoutMs)));
  const script = "$selfPid = $PID; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine | Where-Object { $_.ProcessId -ne $selfPid -and $_.ParentProcessId -ne $selfPid } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: boundedTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  return (Array.isArray(value) ? value : [value]).map(item => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    name: String(item.Name ?? ''),
    executablePath: String(item.ExecutablePath ?? ''),
    created: String(item.CreationDate ?? ''),
    commandLine: String(item.CommandLine ?? '')
  }));
}

function processTree(processes, rootPid) {
  const root = processes.find(item => item.pid === rootPid);
  if (!root) return [];
  const selected = new Map();
  const pending = [root];
  while (pending.length) {
    const parent = pending.shift();
    if (!parent || selected.has(parent.pid)) continue;
    selected.set(parent.pid, parent);
    const parentCreatedAt = processCreationTime(parent.created);
    for (const item of processes) if (item.parentPid === parent.pid) {
      if (selected.has(item.pid)) continue;
      const childCreatedAt = processCreationTime(item.created);
      // ParentProcessId is only a numeric PID. Windows can retain it on an
      // orphan after that PID has been reused by a later Electron process.
      // A missing/invalid timestamp cannot prove parentage and must fail
      // closed. Otherwise a stale orphan can still pull an unrelated system
      // tree into E2E after its numeric parent PID has been reused.
      if (parentCreatedAt === undefined || childCreatedAt === undefined || childCreatedAt < parentCreatedAt) continue;
      pending.push(item);
    }
  }
  return [...selected.values()];
}

function mergeProcessTrees(...trees) {
  const merged = new Map();
  for (const tree of trees.flat()) {
    if (!safePid(tree?.pid)) continue;
    const key = `${tree.pid}:${String(tree.created ?? '')}`;
    if (!merged.has(key)) merged.set(key, tree);
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

function electronRootIdentityStable(coldTree, hotTree, rootPid) {
  const coldRoot = coldTree.find(item => item.pid === rootPid);
  const hotRoot = hotTree.find(item => item.pid === rootPid);
  return safePid(rootPid) !== undefined
    && sameProcessIdentity(coldRoot, hotRoot)
    && String(coldRoot?.created ?? '').length > 0;
}

export function hasObservedProcessTree(processes, rootPid, runtimePid) {
  return processes.some(item => item.pid === rootPid)
    && processes.some(item => item.pid === runtimePid);
}

export async function waitForProcessTree(readProcesses, rootPid, runtimePid, timeoutMs = PROCESS_TREE_DISCOVERY_TIMEOUT_MS, pollIntervalMs = 200) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastTree = [];
  let lastError;
  do {
    try {
      const remainingBudget = Math.max(1, deadline - Date.now());
      lastTree = processTree(await withTimeout(Promise.resolve(readProcesses(remainingBudget)), remainingBudget, 'PROCESS_TREE_DISCOVERY'), rootPid);
      lastError = undefined;
      if (hasObservedProcessTree(lastTree, rootPid, runtimePid)) return lastTree;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError) throw lastError;
      return lastTree;
    }
    await delay(Math.min(Math.max(0, pollIntervalMs), Math.max(0, deadline - Date.now())));
  } while (true);
}

function normalizedWindowsPath(value) {
  const text = String(value ?? '').trim().replace(/^['"]|['"]$/gu, '').replace(/\//gu, '\\');
  if (!text) return '';
  return path.win32.normalize(text).replace(/[\\]+$/u, '').toLowerCase();
}

function pathIsWithin(root, candidate) {
  const normalizedRoot = normalizedWindowsPath(root);
  const normalizedCandidate = normalizedWindowsPath(candidate);
  return Boolean(normalizedRoot && normalizedCandidate
    && (normalizedRoot === normalizedCandidate || normalizedCandidate.startsWith(`${normalizedRoot}\\`)));
}

function processCreationTime(value) {
  const text = String(value ?? '').trim();
  const wmi = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-]\d{3})?$/u);
  if (wmi) {
    const utc = Date.UTC(Number(wmi[1]), Number(wmi[2]) - 1, Number(wmi[3]), Number(wmi[4]), Number(wmi[5]), Number(wmi[6]), Number(wmi[7].padEnd(3, '0').slice(0, 3)));
    const offsetMinutes = Number(wmi[8] ?? 0);
    return Number.isFinite(utc) ? utc - offsetMinutes * 60_000 : undefined;
  }
  const serialized = text.match(/^\\?\/Date\((\d+)(?:[+-]\d+)?\)\\?\/$/u);
  if (serialized) return Number(serialized[1]);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function processStartedDuringCycle(item, startedAt) {
  const createdAt = processCreationTime(item?.created);
  return createdAt !== undefined && createdAt >= startedAt - FORCE_EXIT_TIMEOUT_MS;
}

function sameProcessIdentity(item, expected) {
  if (!item || !expected || safePid(item.pid) !== safePid(expected.pid)) return false;
  const actualCreated = String(item.created ?? '');
  const expectedCreated = String(expected.created ?? '');
  return actualCreated === expectedCreated && (actualCreated.length > 0 || expectedCreated.length > 0);
}

function hasKnownProcessAncestor(item, currentByPid, knownByPid, knownPids, startedAt) {
  let parentPid = safePid(item?.parentPid);
  const visited = new Set();
  while (parentPid && !visited.has(parentPid)) {
    visited.add(parentPid);
    const parent = currentByPid.get(parentPid);
    if (parent) {
      const known = knownByPid.get(parent.pid);
      if (known && sameProcessIdentity(parent, known)) return true;
      parentPid = safePid(parent.parentPid);
      continue;
    }
    return knownPids.has(parentPid) && processStartedDuringCycle(item, startedAt);
  }
  return false;
}

export function scopedProcessKind(item, currentByPid, scope) {
  const known = scope.knownByPid.get(item.pid);
  if (known && sameProcessIdentity(item, known)) return 'known-identity';
  if (hasKnownProcessAncestor(item, currentByPid, scope.knownByPid, scope.knownPids, scope.startedAt)) return 'known-ancestor';
  if (scope.tempRoots.some(root => pathIsWithin(root, item.executablePath))) return 'temp-root';
  if (!processStartedDuringCycle(item, scope.startedAt)) return undefined;
  const matchingExecutable = scope.executablePaths.some(executablePath =>
    normalizedWindowsPath(item.executablePath) === normalizedWindowsPath(executablePath));
  return matchingExecutable && scope.commandMarkers.every(marker => item.commandLine.includes(marker))
    ? 'launch-executable' : undefined;
}

async function auditScopedProcesses({ startedAt, rootPid, knownProcesses, executablePaths, tempRoots, commandMarkers }) {
  const knownByPid = new Map((knownProcesses ?? []).filter(item => safePid(item?.pid)).map(item => [item.pid, item]));
  const knownPids = new Set(knownByPid.keys());
  if (safePid(rootPid)) knownPids.add(rootPid);
  const scope = {
    startedAt,
    knownByPid,
    knownPids,
    executablePaths: [...new Set([
      ...(executablePaths ?? []),
      ...(knownProcesses ?? []).map(item => item?.executablePath)
    ].filter(value => typeof value === 'string' && value.length > 0))],
    tempRoots: [...new Set((tempRoots ?? []).filter(value => typeof value === 'string' && value.length > 0))],
    commandMarkers: [...new Set((commandMarkers ?? []).filter(value => typeof value === 'string' && value.length > 0))]
  };
  const deadline = Date.now() + PROCESS_PATH_AUDIT_TIMEOUT_MS;
  let lastMatches = [];
  try {
    while (true) {
      const remainingBudget = deadline - Date.now();
      if (remainingBudget <= 0) {
        return { verified: lastMatches.length === 0, pids: lastMatches.map(match => match.item.pid), kinds: [...new Set(lastMatches.map(match => match.kind))].sort() };
      }
      const processes = await windowsProcesses(remainingBudget);
      const currentByPid = new Map(processes.filter(item => safePid(item?.pid)).map(item => [item.pid, item]));
      lastMatches = processes.flatMap(item => {
        if (!safePid(item?.pid) || item.pid === process.pid) return [];
        const kind = scopedProcessKind(item, currentByPid, scope);
        return kind ? [{ item, kind }] : [];
      });
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { verified: lastMatches.length === 0, pids: lastMatches.map(match => match.item.pid), kinds: [...new Set(lastMatches.map(match => match.kind))].sort() };
      }
      await delay(Math.min(POLL_INTERVAL_MS, remaining));
    }
  } catch (error) {
    return {
      verified: false,
      pids: lastMatches.map(match => match.item.pid),
      kinds: [...new Set(lastMatches.map(match => match.kind))].sort(),
      errorCode: stableStageErrorCode(error, 'PROCESS_PATH_AUDIT_FAILED', 'PROCESS_PATH_AUDIT_TIMEOUT')
    };
  }
}

async function waitForProcessesGone(expected) {
  const deadline = Date.now() + FORCE_EXIT_TIMEOUT_MS;
  do {
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 0) return expected;
    const current = new Map((await windowsProcesses(remainingBudget)).map(item => [item.pid, item]));
    const remaining = expected.filter(item => current.get(item.pid)?.created === item.created);
    if (!remaining.length) return [];
    if (Date.now() >= deadline) return remaining;
    await delay(200);
  } while (true);
}

async function forceKillProcessTree(pid) {
  const target = safePid(pid);
  if (!target) return false;
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(target), '/T', '/F'], {
      windowsHide: true,
      timeout: FORCE_EXIT_TIMEOUT_MS,
      maxBuffer: 1 * 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureProcessesGone(expected) {
  let remaining = await waitForProcessesGone(expected);
  if (!remaining.length) return { remaining, forcedCleanup: false };
  await Promise.allSettled([...new Set(remaining.map(item => item.pid))].map(pid => forceKillProcessTree(pid)));
  remaining = await waitForProcessesGone(remaining);
  return { remaining, forcedCleanup: true };
}

export async function cdpClosed(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(isRecord(error) && error.code === 'ECONNREFUSED'));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function forceKillApplication(child, exitPromise) {
  const pid = safePid(child?.pid);
  if (!pid) return { forcedTermination: false, forceKillVerified: false, quitAccepted: false, gracefulExitVerified: false };
  const taskkillIssued = await forceKillProcessTree(pid);
  const exited = await exitedWithin(exitPromise, FORCE_EXIT_TIMEOUT_MS);
  return {
    forcedTermination: taskkillIssued,
    forceKillVerified: taskkillIssued && exited,
    quitAccepted: false,
    gracefulExitVerified: false
  };
}

async function terminateApplication(child, exitPromise, browser, control, scenario = 'launch') {
  if (scenario === 'force-kill') return forceKillApplication(child, exitPromise);
  let quitAccepted = false;
  for (let attempt = 0; attempt < 2 && control && !control.isClosed() && !quitAccepted; attempt += 1) {
    try {
      const response = await withTimeout(control.evaluate(() => window.adhdOne.quitApp()), 3_000, 'APP_QUIT');
      quitAccepted = response?.accepted === true;
    } catch { /* The renderer may disappear after accepting quit. */ }
    if (!quitAccepted && control && !control.isClosed()) await delay(200);
  }
  const gracefulExitVerified = quitAccepted && await exitedWithin(exitPromise, GRACEFUL_EXIT_TIMEOUT_MS);
  if (gracefulExitVerified) {
    return { forcedTermination: false, forceKillVerified: false, quitAccepted, gracefulExitVerified };
  }
  const forceKilled = await forceKillProcessTree(child.pid);
  await exitedWithin(exitPromise, FORCE_EXIT_TIMEOUT_MS);
  return { forcedTermination: forceKilled, forceKillVerified: false, quitAccepted, gracefulExitVerified: false };
}

async function terminateQualificationApplication(child, exitPromise, control) {
  let quitAccepted = false;
  let quitStartedAt;
  let quitErrorCode;
  if (control && !control.isClosed()) {
    // Start the exit measurement immediately before the first and only
    // SecureBridge quitApp call. A forced fallback is never a qualification pass.
    quitStartedAt = performance.now();
    try {
      const response = await withTimeout(control.evaluate(() => window.adhdOne.quitApp()), 3_000, 'APP_QUIT');
      quitAccepted = response?.accepted === true;
    } catch (error) {
      quitErrorCode = stableStageErrorCode(error, 'APP_QUIT_REQUEST_FAILED', 'APP_QUIT_TIMEOUT');
    }
  }
  const gracefulExit = quitAccepted ? await exitInfoWithin(exitPromise, GRACEFUL_EXIT_TIMEOUT_MS) : undefined;
  if (gracefulExit) {
    return {
      quitAccepted,
      gracefulExitVerified: true,
      forcedTermination: false,
      quitStartedAt,
      exitAt: performance.now(),
      errorCode: quitErrorCode
    };
  }

  const forcedTermination = await forceKillProcessTree(child.pid);
  const forcedExit = await exitInfoWithin(exitPromise, FORCE_EXIT_TIMEOUT_MS);
  return {
    quitAccepted,
    gracefulExitVerified: false,
    forcedTermination,
    quitStartedAt,
    exitAt: forcedExit ? performance.now() : undefined,
    errorCode: quitErrorCode
  };
}

async function prepareRun() {
  const root = await mkdtemp(path.join(os.tmpdir(), TEMP_ROOT_PREFIX));
  try {
    const appData = path.join(root, 'appdata');
    const localAppData = path.join(root, 'localappdata');
    const userData = path.join(root, 'user-data-dir');
    const profile = path.join(root, 'profile');
    const temp = path.join(root, 'temp');
    const workspace = path.join(root, 'workspace');
    await Promise.all([
      mkdir(path.join(appData, 'ADHD One'), { recursive: true }), mkdir(localAppData, { recursive: true }),
      mkdir(userData, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(temp, { recursive: true }), mkdir(workspace, { recursive: true })
    ]);
    const preferredPort = await findFreeLoopbackPort();
    const settings = { schemaVersion: 2, locale: 'zh-CN', workspace, preferredPort, appChannel: 'stable', runtimeChannel: 'stable', closeToTrayExplained: true, migration: { v1Imported: false, legacyDshPrompted: false } };
    await writeFile(path.join(appData, 'ADHD One', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { root, appData, localAppData, userData, profile, temp, workspace, settings };
  } catch (error) { await rm(root, { recursive: true, force: true }).catch(() => undefined); throw error; }
}

function isExpectedTempRoot(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  return path.dirname(resolvedRoot).toLowerCase() === resolvedTemp.toLowerCase()
    && path.basename(resolvedRoot).startsWith(TEMP_ROOT_PREFIX);
}

async function pathIsAbsent(candidate) {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT';
  }
}

async function cleanupPreparedRoot(prepared, record) {
  if (!isExpectedTempRoot(prepared.root)) {
    record.cleanup = 'failed';
    record.errorCode ??= 'CLEANUP_ROOT_UNEXPECTED';
    return;
  }
  let rootInfo;
  try {
    rootInfo = await lstat(prepared.root);
  } catch (error) {
    record.cleanup = 'failed';
    record.errorCode ??= isRecord(error) && error.code === 'ENOENT'
      ? 'CLEANUP_ROOT_MISSING_BEFORE_RM'
      : stableStageErrorCode(error, 'CLEANUP_ROOT_STAT_FAILED', 'CLEANUP_ROOT_STAT_TIMEOUT');
    return;
  }
  record.cleanupRootExisted = rootInfo.isDirectory() && !rootInfo.isSymbolicLink();
  if (!record.cleanupRootExisted) {
    record.cleanup = 'failed';
    record.errorCode ??= 'CLEANUP_ROOT_NOT_DIRECTORY';
    return;
  }

  let lastError;
  for (let attempt = 0; attempt < 3 && !record.cleanupRootAbsent; attempt += 1) {
    try {
      await rm(prepared.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      lastError = error;
    }
    record.cleanupRootAbsent = await pathIsAbsent(prepared.root);
    if (!record.cleanupRootAbsent && attempt < 2) await delay(250);
  }
  if (record.cleanupRootExisted && record.cleanupRootAbsent) {
    record.cleanup = 'removed';
    record.cleanupVerified = true;
    return;
  }
  record.cleanup = 'failed';
  record.errorCode ??= lastError
    ? stableStageErrorCode(lastError, 'CLEANUP_FAILED', 'CLEANUP_TIMEOUT')
    : 'CLEANUP_ROOT_REMAINS';
}

async function verifyFilesystemIsolation(prepared, launchExecutable, portableMode, workspace) {
  if (!isInside(prepared.root, workspace)) return false;
  const data = portableMode
    ? path.join(path.dirname(launchExecutable), 'portable-data')
    : path.join(prepared.appData, 'ADHD One');
  const local = portableMode
    ? path.join(data, 'local')
    : path.join(prepared.localAppData, 'ADHD One');
  const required = [
    data,
    local,
    path.join(data, 'settings.json'),
    path.join(data, 'dsh-home'),
    path.join(local, 'logs')
  ];
  if (!required.every(candidate => isInside(prepared.root, candidate))) return false;
  const kinds = await Promise.all(required.map(candidate => stat(candidate).catch(() => undefined)));
  return kinds.every((value, index) => index === 2 ? value?.isFile() === true : value?.isDirectory() === true);
}

async function prepareWorkspaceWriteDshHome(prepared, launchExecutable, portableMode) {
  const data = portableMode
    ? path.join(path.dirname(launchExecutable), 'portable-data')
    : path.join(prepared.appData, 'ADHD One');
  const dshHome = path.join(data, 'dsh-home');
  await mkdir(dshHome, { recursive: true });
  await Promise.all([
    writeFile(path.join(dshHome, 'settings.yaml'), 'permission:\n  defaultPreset: workspace-write\n', { encoding: 'utf8', flag: 'wx' }),
    writeFile(path.join(dshHome, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n', { encoding: 'utf8', flag: 'wx' })
  ]);
}

async function prepareRuntimeRollback(prepared, portableMode) {
  if (portableMode) throw new Error('RUNTIME_ROLLBACK_REQUIRES_INSTALLED');
  const runtimes = path.join(prepared.localAppData, 'ADHD One', 'runtimes');
  const candidateSlot = path.join(runtimes, 'slot-B');
  const packageDirectory = path.join(candidateSlot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');
  if (!await pathIsAbsent(candidateSlot)) throw new Error('RUNTIME_ROLLBACK_SLOT_PRESENT');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: RUNTIME_ROLLBACK_PACKAGE_VERSION })}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(runtimes, 'runtime-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    active: 'B',
    previous: 'bundled',
    version: RUNTIME_ROLLBACK_STATE_VERSION,
    healthy: false,
    candidate: true
  })}\n`, { encoding: 'utf8', flag: 'wx' });
  return { runtimes, candidateSlot };
}

export async function verifyRuntimeRollbackState(runtimes, candidateSlot, runtimeSnapshot) {
  let state;
  try { state = JSON.parse(await readFile(path.join(runtimes, 'runtime-state.json'), 'utf8')); }
  catch { return { verified: false }; }
  if (!isRecord(state)) return { verified: false };
  let candidatePackage;
  try {
    candidatePackage = JSON.parse(await readFile(path.join(candidateSlot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  } catch { candidatePackage = undefined; }
  const evidence = {
    verified: false,
    candidateSeeded: isRecord(candidatePackage)
      && candidatePackage.name === '@deepseek-ai/dsh'
      && candidatePackage.version === RUNTIME_ROLLBACK_PACKAGE_VERSION
      && candidatePackage.version !== RUNTIME_ROLLBACK_STATE_VERSION,
    bundledActive: state.active === 'bundled' && runtimeSnapshot?.slot === 'bundled',
    previousCandidateRecorded: state.previous === 'B',
    healthy: state.healthy === true,
    candidateCleared: state.candidate === false,
    rollbackMarkerRecorded: state.rolledBackFrom === 'B',
    candidateSlotRetained: await lstat(candidateSlot).then(value => value.isDirectory() && !value.isSymbolicLink()).catch(() => false)
  };
  evidence.verified = Object.entries(evidence).every(([key, value]) => key === 'verified' || value === true);
  return evidence;
}

async function runWorkspaceWrite(executable, prepared, snapshot, cycle, mock, apiKey, plan) {
  const outcome = {
    verified: false,
    rpcClientSource: 'unavailable',
    permissionMode: 'unknown',
    approval: 'not-requested',
    providerSequence: 'unknown',
    approvalRequested: false,
    sessionCreated: false,
    sessionArchived: false,
    historyVerified: false,
    providerAuthVerified: false,
    powerShellCall: false,
    toolResult: false,
    sentinelFile: false,
    secondProviderTurn: false,
    finalNonce: false,
    errorCode: undefined
  };
  let client;
  let mux;
  let sessionId;
  let approvalFailure;
  let rejectApprovalFailure = () => undefined;
  const approvalFailureSignal = new Promise((_, reject) => { rejectApprovalFailure = reject; });
  void approvalFailureSignal.catch(() => undefined);
  const approvalResponses = [];
  let rejectProtocolFailure = () => undefined;
  const protocolFailure = new Promise((_, reject) => { rejectProtocolFailure = reject; });
  void protocolFailure.catch(() => undefined);

  try {
    const loaded = await withStableStage(
      () => loadDshRpcClient(executable, path.join(prepared.root, `rpc-client-${cycle}`)),
      'WORKSPACE_RPC_CLIENT_LOAD_FAILED',
      'WORKSPACE_RPC_CLIENT_LOAD_TIMEOUT'
    );
    outcome.rpcClientSource = loaded.source;
    client = new loaded.DshRpcClient(snapshot.runtime.url);
    await withStableStage(
      () => client.call('host.describe', {}, 10_000),
      'WORKSPACE_HOST_DESCRIBE_FAILED',
      'WORKSPACE_HOST_DESCRIBE_TIMEOUT'
    );

    const events = [];
    const timeout = AbortSignal.timeout(90_000);
    mux = await withStableStage(() => client.openMux(envelope => {
      const payload = envelope.payload;
      if (payload.type === 'approval/requested' && payload.sessionId === sessionId) {
        outcome.approvalRequested = true;
        outcome.approval = 'rejected';
        approvalFailure = new Error('WORKSPACE_WRITE_APPROVAL_REQUESTED');
        rejectApprovalFailure(approvalFailure);
        if (typeof payload.approvalId === 'string' && payload.approvalId.length > 0) {
          approvalResponses.push(client.respond(envelope.rpcId, {
            sessionId,
            approvalId: payload.approvalId,
            outcome: 'rejected'
          }, timeout).then(() => undefined).catch(() => undefined));
        }
      }
      if (payload.type === 'session/event' && payload.sessionId === sessionId && isRecord(payload.event)) {
        events.push(payload.event);
      }
    }, timeout, error => {
      rejectProtocolFailure(error instanceof Error ? error : new Error('WORKSPACE_WRITE_MUX_PROTOCOL_ERROR'));
    }), 'WORKSPACE_MUX_OPEN_FAILED', 'WORKSPACE_MUX_OPEN_TIMEOUT');
    await withStableStage(() => mux.opened, 'WORKSPACE_MUX_READY_FAILED', 'WORKSPACE_MUX_READY_TIMEOUT');

    const created = await withStableStage(
      () => client.call('session.create', { cwd: prepared.workspace }, 15_000, timeout),
      'WORKSPACE_SESSION_CREATE_FAILED',
      'WORKSPACE_SESSION_CREATE_TIMEOUT'
    );
    if (!isRecord(created) || typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new Error('WORKSPACE_WRITE_SESSION_CREATE_INVALID');
    }
    sessionId = created.sessionId;
    outcome.sessionCreated = true;

    const models = await withStableStage(
      () => client.call('session.models', { sessionId }, 15_000, timeout),
      'WORKSPACE_SESSION_MODELS_FAILED',
      'WORKSPACE_SESSION_MODELS_TIMEOUT'
    );
    if (!isRecord(models) || models.routable !== true) throw new Error('WORKSPACE_WRITE_MODEL_NOT_ROUTABLE');

    const prompt = await withStableStage(() => client.call('session.prompt', {
      sessionId,
      content: [{ type: 'text', text: `Use the pwsh tool exactly once to write ${plan.sentinelName} in the current workspace with the requested sentinel value, then reply with exactly ${plan.nonce}. Do not ask for approval, use another tool, or access a path outside the current workspace.` }],
      mode: 'queue'
    }, 15_000, timeout), 'WORKSPACE_SESSION_PROMPT_FAILED', 'WORKSPACE_SESSION_PROMPT_TIMEOUT');
    if (!isRecord(prompt) || prompt.accepted !== true) throw new Error('WORKSPACE_WRITE_PROMPT_NOT_ACCEPTED');

    await withStableStage(
      () => Promise.race([waitForCompletedTurn(events, timeout), approvalFailureSignal, protocolFailure]),
      'WORKSPACE_WRITE_TURN_FAILED',
      'WORKSPACE_WRITE_TIMEOUT'
    );
    if (approvalFailure !== undefined) throw approvalFailure;
    await Promise.all(approvalResponses);
    if (approvalFailure !== undefined) throw approvalFailure;

    Object.assign(outcome, providerSequenceEvidence(mock, apiKey));
    if (outcome.providerSequence !== 'matched') throw new Error('WORKSPACE_WRITE_PROVIDER_SEQUENCE_MISMATCH');

    const history = historyEvents(await withStableStage(
      () => client.call('session.history', { sessionId, maxMessages: 200 }, 15_000, timeout),
      'WORKSPACE_SESSION_HISTORY_FAILED',
      'WORKSPACE_SESSION_HISTORY_TIMEOUT'
    ));
    const muxEvidence = inspectWorkspaceEvents(events, plan.nonce, plan.sentinelName);
    const historyEvidence = inspectWorkspaceEvents(history, plan.nonce, plan.sentinelName);
    outcome.powerShellCall = muxEvidence.powerShellCall && historyEvidence.powerShellCall;
    outcome.toolResult = muxEvidence.toolResult && historyEvidence.toolResult;
    outcome.finalNonce = muxEvidence.finalNonce && historyEvidence.finalNonce;
    outcome.historyVerified = true;
    outcome.permissionMode = permissionModeFromEvents(history);
    if (outcome.permissionMode !== 'workspace-write') throw new Error('WORKSPACE_WRITE_PERMISSION_MODE_MISMATCH');

    const sentinelContents = await readFile(path.join(prepared.workspace, plan.sentinelName), 'utf8');
    outcome.sentinelFile = sentinelContents.replace(/^\uFEFF/u, '') === plan.nonce;
    if (!outcome.sentinelFile) throw new Error('WORKSPACE_WRITE_SENTINEL_MISMATCH');

    await withStableStage(
      () => client.call('workspace.archiveSession', { sessionId }, 5_000, timeout),
      'WORKSPACE_SESSION_ARCHIVE_FAILED',
      'WORKSPACE_SESSION_ARCHIVE_TIMEOUT'
    );
    outcome.sessionArchived = true;
    outcome.verified = outcome.rpcClientSource === 'packaged-asar'
      && outcome.sessionCreated && outcome.sessionArchived && outcome.historyVerified
      && outcome.providerAuthVerified && outcome.powerShellCall && outcome.toolResult
      && outcome.sentinelFile && outcome.secondProviderTurn && outcome.finalNonce;
    if (!outcome.verified) throw new Error('WORKSPACE_WRITE_EVIDENCE_INCOMPLETE');
  } catch (error) {
    outcome.errorCode = stableStageErrorCode(error, 'WORKSPACE_WRITE_FAILED', 'WORKSPACE_WRITE_TIMEOUT');
  } finally {
    Object.assign(outcome, providerSequenceEvidence(mock, apiKey));
    await Promise.allSettled(approvalResponses);
    mux?.close();
    if (client && sessionId && !outcome.sessionArchived) {
      try {
        await withStableStage(
          () => client.call('workspace.archiveSession', { sessionId }, 5_000),
          'WORKSPACE_WRITE_SESSION_ARCHIVE_FAILED',
          'WORKSPACE_WRITE_SESSION_ARCHIVE_TIMEOUT'
        );
        outcome.sessionArchived = true;
      } catch {
        outcome.errorCode ??= 'WORKSPACE_WRITE_SESSION_ARCHIVE_FAILED';
      }
    }
  }
  return outcome;
}

function cycleFailureCode(record) {
  if (record.scenario === 'force-kill' && record.forceKillRequested && !record.forceKillVerified) return 'APPLICATION_FORCE_KILL_FAILED';
  if (record.scenario === 'workspace-write' && !record.workspaceWriteVerified) return 'WORKSPACE_WRITE_FAILED';
  if (record.scenario === 'runtime-rollback' && !record.runtimeRollbackVerified) return 'RUNTIME_ROLLBACK_FAILED';
  if (record.scenario !== 'force-kill' && !record.quitAccepted) return 'APP_QUIT_NOT_ACCEPTED';
  if (record.scenario !== 'force-kill' && !record.gracefulExitVerified) return 'APPLICATION_GRACEFUL_EXIT_FAILED';
  if (!record.finalScopedProcessAuditPassed) return 'PROCESS_PATH_AUDIT_FAILED';
  if (!record.cleanupVerified) return 'CLEANUP_FAILED';
  if (record.forcedTermination) return 'APPLICATION_DID_NOT_EXIT_GRACEFULLY';
  if (record.exitSignal) return 'APPLICATION_EXITED_BY_SIGNAL';
  if (record.exitCode !== undefined && record.exitCode !== null && record.exitCode !== 0) return `APPLICATION_EXIT_CODE_${record.exitCode}`;
  if (record.runtimePid && !record.runtimePidExited) return 'RUNTIME_PROCESS_REMAINED';
  if (record.remainingPids.length) return 'APPLICATION_PROCESS_REMAINED';
  if (record.cdpPort && !record.cdpClosed) return 'CDP_REMAINED_OPEN';
  return 'E2E_CYCLE_FAILED';
}

function qualificationFailureCode(record) {
  if (record.forcedTermination) return 'APPLICATION_DID_NOT_EXIT_GRACEFULLY';
  if (!record.spawnVerified) return 'APPLICATION_SPAWN_FAILED';
  if (!record.executableSha256) return 'EXE_SHA256_MISSING';
  if (!record.controlWindowVerified || !record.controlWindowOperational) return 'CONTROL_WINDOW_NOT_OPERATIONAL';
  if (!record.coldRuntimeReadyVerified) return 'RUNTIME_COLD_START_FAILED';
  if (!record.restartRequested || !record.restartRuntimeAccepted) return 'RUNTIME_RESTART_FAILED';
  if (!record.restartReadyVerified) return 'RUNTIME_RESTART_READY_FAILED';
  if (!record.electronRootStable) return 'ELECTRON_ROOT_IDENTITY_UNSTABLE';
  if (!record.idleCpuMeasured) return 'WINDOWS_PROCESS_CPU_NOT_MEASURED';
  if (!(record.idleCpuPercent < QUALIFICATION_LIMITS.idleCpuPercent)) return 'WINDOWS_PROCESS_CPU_LIMIT_EXCEEDED';
  if (!record.quitAccepted) return 'APP_QUIT_NOT_ACCEPTED';
  if (!record.gracefulExitVerified) return 'APPLICATION_GRACEFUL_EXIT_FAILED';
  if (!record.exitVerified) return 'APPLICATION_EXIT_VERIFICATION_FAILED';
  if (!record.finalScopedProcessAuditPassed) return 'PROCESS_PATH_AUDIT_FAILED';
  if (!record.cleanupVerified) return 'CLEANUP_FAILED';
  return 'QUALIFICATION_FAILED';
}

async function runQualificationCycle(executable, chromium, requirePortable = false) {
  const startedAt = Date.now();
  const record = {
    cycle: 1,
    scenario: 'qualification',
    passed: false,
    spawnVerified: false,
    hostToolchainPathExcluded: false,
    executableSha256: undefined,
    spawnToControlWindowMs: undefined,
    controlWindowVerified: false,
    controlWindowOperational: false,
    coldRuntimeReadyVerified: false,
    coldGeneration: undefined,
    restartRequested: false,
    restartRuntimeAccepted: false,
    restartReadyVerified: false,
    restartToReadyMs: undefined,
    idleCpuMeasured: false,
    idleCpuPercent: undefined,
    idleCpuProcessCount: 0,
    hotGeneration: undefined,
    electronRootStable: false,
    coldProcessTreeObserved: false,
    hotProcessTreeObserved: false,
    coldProcessTreeCount: 0,
    hotProcessTreeCount: 0,
    mergedProcessTreeCount: 0,
    processTreeExited: false,
    quitAccepted: false,
    quitToExitMs: undefined,
    gracefulExitVerified: false,
    forcedTermination: false,
    exitCode: undefined,
    exitSignal: undefined,
    exitVerified: false,
    cdpClosed: false,
    cleanup: 'pending',
    cleanupRootExisted: false,
    cleanupRootAbsent: false,
    cleanupVerified: false,
    finalScopedProcessAuditPassed: false,
    finalScopedProcessAuditCount: 0,
    errorCode: undefined
  };
  let prepared;
  let child;
  let browser;
  let control;
  let exitInfo;
  let exitPromise;
  let launchExecutable = executable;
  let remoteDebuggingPort;
  let coldTree = [];
  let hotTree = [];
  let mergedTree = [];
  try {
    prepared = await prepareRun();
    const portableMarker = path.join(path.dirname(executable), 'resources', 'portable.marker');
    const portableMode = await stat(portableMarker).then(value => value.isFile()).catch(() => false);
    if (requirePortable && !portableMode) throw new Error('PORTABLE_MARKER_MISSING');
    if (portableMode) {
      const sourceRoot = path.dirname(executable);
      const portableRoot = path.join(prepared.root, 'portable-app');
      await cp(sourceRoot, portableRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: source => shouldCopyPortableEntry(sourceRoot, source)
      });
      launchExecutable = path.join(portableRoot, path.basename(executable));
      const copiedMarker = path.join(path.dirname(launchExecutable), 'resources', 'portable.marker');
      if (!await stat(copiedMarker).then(value => value.isFile()).catch(() => false)) {
        throw new Error('PORTABLE_MARKER_COPY_FAILED');
      }
      const portableData = path.join(portableRoot, 'portable-data');
      await mkdir(portableData, { recursive: true });
      await writeFile(path.join(portableData, 'settings.json'), `${JSON.stringify(prepared.settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }

    remoteDebuggingPort = await findFreeLoopbackPort();
    const environment = createTestEnvironment(prepared.root, prepared.appData, prepared.localAppData);
    record.hostToolchainPathExcluded = isHostToolchainPathExcluded(environment);
    if (!record.hostToolchainPathExcluded) throw new Error('HOST_TOOLCHAIN_PATH_NOT_EXCLUDED');
    const executableProof = await collectExecutableProof(launchExecutable);
    record.executableSha256 = executableProof.sha256;
    const spawnStartedAt = performance.now();
    child = spawn(launchExecutable, [
      `--user-data-dir=${prepared.userData}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${remoteDebuggingPort}`
    ], { cwd: path.dirname(launchExecutable), env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    record.spawnVerified = safePid(child.pid) !== undefined;
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    exitPromise = observeExit(child).then(info => { exitInfo = info; return info; });

    const cdpEndpoint = await waitForCdp(remoteDebuggingPort, child);
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint, {
        timeout: 15_000,
        isLocal: true,
        noDefaults: true
      });
    } catch (error) {
      throw stableStageError(error, 'CDP_CONNECT_FAILED', 'CDP_CONNECT_TIMEOUT');
    }
    control = await waitForControlWindow(browser, child, exitPromise);
    record.spawnToControlWindowMs = Math.ceil(performance.now() - spawnStartedAt);
    record.controlWindowVerified = true;
    record.controlWindowOperational = await verifyControlWindowOperational(control);
    if (!record.controlWindowOperational) throw new Error('CONTROL_WINDOW_NOT_OPERATIONAL');

    const coldReady = await waitForRuntimeReady(control, child, exitPromise, 1);
    record.coldRuntimeReadyVerified = true;
    record.coldGeneration = coldReady.snapshot.runtime.generation;
    coldTree = await waitForProcessTree(windowsProcesses, child.pid, coldReady.snapshot.runtime.pid);
    record.coldProcessTreeCount = coldTree.length;
    record.coldProcessTreeObserved = hasObservedProcessTree(coldTree, child.pid, coldReady.snapshot.runtime.pid);
    if (!record.coldProcessTreeObserved) throw new Error('RUNTIME_COLD_PROCESS_TREE_NOT_OBSERVED');

    const minimumGeneration = coldReady.snapshot.runtime.generation + 1;
    if (!Number.isSafeInteger(minimumGeneration)) throw new Error('RUNTIME_GENERATION_INVALID');
    const restartStartedAt = performance.now();
    record.restartRequested = true;
    const restartSnapshot = await withStableStage(
      () => withTimeout(control.evaluate(() => window.adhdOne.restartRuntime()), QUALIFICATION_LIMITS.hotReadyMs, 'RUNTIME_RESTART'),
      'RUNTIME_RESTART_FAILED',
      'RUNTIME_RESTART_TIMEOUT'
    );
    record.restartRuntimeAccepted = restartSnapshot?.state === 'ready'
      && Number.isSafeInteger(restartSnapshot?.generation)
      && restartSnapshot.generation >= minimumGeneration;
    if (!record.restartRuntimeAccepted) throw new Error('RUNTIME_RESTART_NOT_READY');

    const hotReady = await waitForRuntimeReady(control, child, exitPromise, minimumGeneration);
    record.restartReadyVerified = true;
    record.hotGeneration = hotReady.snapshot.runtime.generation;
    record.restartToReadyMs = Math.ceil(performance.now() - restartStartedAt);
    hotTree = await waitForProcessTree(windowsProcesses, child.pid, hotReady.snapshot.runtime.pid);
    record.hotProcessTreeCount = hotTree.length;
    record.hotProcessTreeObserved = hasObservedProcessTree(hotTree, child.pid, hotReady.snapshot.runtime.pid);
    if (!record.hotProcessTreeObserved) throw new Error('RUNTIME_HOT_PROCESS_TREE_NOT_OBSERVED');
    record.electronRootStable = electronRootIdentityStable(coldTree, hotTree, child.pid);
    if (!record.electronRootStable) throw new Error('ELECTRON_ROOT_IDENTITY_UNSTABLE');
    const cpu = await withStableStage(
      () => withTimeout(measureWindowsProcessCpu({ rootPid: child.pid }), 90_000, 'WINDOWS_PROCESS_CPU'),
      'WINDOWS_PROCESS_CPU_FAILED',
      'WINDOWS_PROCESS_CPU_TIMEOUT'
    );
    record.idleCpuMeasured = true;
    record.idleCpuPercent = cpu.averageCpuPercent;
    record.idleCpuProcessCount = cpu.processCount;
    if (!(record.idleCpuPercent < QUALIFICATION_LIMITS.idleCpuPercent)) {
      throw new Error('WINDOWS_PROCESS_CPU_LIMIT_EXCEEDED');
    }
    mergedTree = mergeProcessTrees(coldTree, hotTree);
    record.mergedProcessTreeCount = mergedTree.length;
    if (mergedTree.length < 3) throw new Error('RUNTIME_COLD_HOT_PROCESS_TREES_INCOMPLETE');
  } catch (error) {
    record.errorCode = stableStageErrorCode(error, 'QUALIFICATION_FAILED', 'QUALIFICATION_TIMEOUT');
  } finally {
    if (child && exitPromise && !exitInfo) {
      const termination = await terminateQualificationApplication(child, exitPromise, control);
      record.quitAccepted = termination.quitAccepted === true;
      record.gracefulExitVerified = termination.gracefulExitVerified === true;
      record.forcedTermination = termination.forcedTermination === true;
      record.errorCode ??= termination.errorCode;
      if (termination.quitStartedAt !== undefined && termination.exitAt !== undefined) {
        record.quitToExitMs = Math.max(0, termination.exitAt - termination.quitStartedAt);
      }
    }
    if (browser) {
      try { await browser.close(); } catch { /* already disconnected */ }
    }
    if (exitInfo) {
      record.exitCode = exitInfo.code;
      record.exitSignal = exitInfo.signal;
      record.errorCode ??= exitInfo.errorCode;
      if (record.quitToExitMs === undefined && record.quitAccepted) {
        record.errorCode ??= 'APP_QUIT_EXIT_MEASUREMENT_MISSING';
      }
    }

    mergedTree = mergeProcessTrees(coldTree, hotTree);
    record.mergedProcessTreeCount = mergedTree.length;
    if (mergedTree.length) {
      try {
        const cleanup = await ensureProcessesGone(mergedTree);
        record.forcedTermination ||= cleanup.forcedCleanup;
        record.processTreeExited = cleanup.remaining.length === 0;
      } catch (error) {
        record.errorCode ??= stableStageErrorCode(error, 'PROCESS_TREE_AUDIT_FAILED', 'PROCESS_TREE_AUDIT_TIMEOUT');
      }
    }
    record.cdpClosed = await cdpClosed(remoteDebuggingPort ?? 0);

    if (prepared) {
      await cleanupPreparedRoot(prepared, record);
    } else {
      record.cleanup = 'not-created';
      record.cleanupVerified = false;
    }
    const processAudit = await auditScopedProcesses({
      startedAt,
      rootPid: child?.pid,
      knownProcesses: mergedTree,
      executablePaths: [executable, launchExecutable],
      tempRoots: prepared ? [prepared.root] : [],
      commandMarkers: prepared && remoteDebuggingPort
        ? [`--user-data-dir=${prepared.userData}`, `--remote-debugging-port=${remoteDebuggingPort}`]
        : []
    });
    const processTreesObserved = record.coldProcessTreeObserved && record.hotProcessTreeObserved;
    record.finalScopedProcessAuditPassed = processTreesObserved && processAudit.verified === true;
    record.finalScopedProcessAuditCount = processAudit.pids.length;
    record.errorCode ??= processAudit.errorCode;
    if (!processTreesObserved) record.errorCode ??= 'RUNTIME_COLD_HOT_PROCESS_TREE_NOT_OBSERVED';
    else if (!record.finalScopedProcessAuditPassed) record.errorCode ??= 'PROCESS_PATH_AUDIT_FOUND';
    if (prepared && record.cleanup === 'removed' && !await pathIsAbsent(prepared.root)) {
      record.cleanupRootAbsent = false;
      record.cleanup = 'failed';
      record.cleanupVerified = false;
      record.errorCode ??= 'CLEANUP_ROOT_REAPPEARED';
    }

    record.exitVerified = record.quitAccepted
      && record.gracefulExitVerified
      && !record.forcedTermination
      && record.quitToExitMs !== undefined
      && record.exitCode === 0
      && !record.exitSignal
      && record.processTreeExited
      && record.cdpClosed
      && record.finalScopedProcessAuditPassed;
    record.passed = record.spawnVerified
      && record.hostToolchainPathExcluded
      && typeof record.executableSha256 === 'string'
      && record.controlWindowVerified
      && record.controlWindowOperational
      && record.coldRuntimeReadyVerified
      && record.restartRequested
      && record.restartRuntimeAccepted
      && record.restartReadyVerified
      && record.electronRootStable
      && record.idleCpuMeasured
      && record.idleCpuPercent < QUALIFICATION_LIMITS.idleCpuPercent
      && record.spawnToControlWindowMs <= QUALIFICATION_LIMITS.firstInteractiveMs
      && record.restartToReadyMs <= QUALIFICATION_LIMITS.hotReadyMs
      && record.quitToExitMs <= QUALIFICATION_LIMITS.exitMs
      && record.exitVerified
      && record.cleanupVerified
      && record.finalScopedProcessAuditPassed;
    if (!record.passed) record.errorCode ??= qualificationFailureCode(record);
  }
  return record;
}

async function runQualification(executable, chromium, requirePortable = false) {
  return runQualificationCycle(executable, chromium, requirePortable);
}

async function runCycle(executable, cycle, chromium, scenario = 'launch', requirePortable = false) {
  const startedAt = Date.now();
  const record = {
    cycle,
    scenario,
    passed: false,
    launchVerified: false,
    launchMs: undefined,
    controlWindowMs: undefined,
    runtimeReadyMs: undefined,
    exitMs: undefined,
    pid: undefined,
    cdpPort: undefined,
    portableMode: false,
    controlWindowVerified: false,
    runtimeReadyVerified: false,
    hostDescribeVerified: false,
    runtimePid: undefined,
    isolationVerified: false,
    cdpClosed: false,
    runtimePidExited: false,
    processTreeExited: false,
    quitAccepted: false,
    gracefulExitVerified: false,
    exitVerified: false,
    processTreeCount: 0,
    remainingPids: [],
    exitCode: undefined,
    exitSignal: undefined,
    forceKillRequested: scenario === 'force-kill',
    forceKillVerified: false,
    forcedTermination: false,
    cleanup: 'pending',
    cleanupRootExisted: false,
    cleanupRootAbsent: false,
    cleanupVerified: false,
    finalScopedProcessAuditPassed: false,
    finalScopedProcessAuditCount: 0,
    finalScopedProcessAuditPids: [],
    finalScopedProcessAuditKinds: [],
    errorCode: undefined,
    stdoutBytes: 0,
    stderrBytes: 0,
    workspaceWriteVerified: false,
    workspaceWrite: {
      requested: scenario === 'workspace-write',
      verified: false,
      rpcClientSource: scenario === 'workspace-write' ? 'unavailable' : 'not-run',
      permissionMode: scenario === 'workspace-write' ? 'unknown' : 'not-run',
      approval: 'not-requested',
      providerSequence: scenario === 'workspace-write' ? 'unknown' : 'not-run',
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
    },
    runtimeRollbackVerified: false,
    runtimeRollback: {
      requested: scenario === 'runtime-rollback',
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
  };
  let prepared;
  let child;
  let browser;
  let control;
  let exitInfo;
  let exitPromise;
  let mock;
  let fakeApiKey;
  let workspacePlan;
  let rollbackPlan;
  let launchExecutable = executable;
  const stdoutStats = { bytes: 0 };
  const stderrStats = { bytes: 0 };
  let launchedTree = [];
  try {
    prepared = await prepareRun();
    if (scenario === 'workspace-write') {
      workspacePlan = workspaceWritePlan();
      fakeApiKey = `e2e-fake-${randomBytes(12).toString('hex')}`;
      mock = await startMockLlmServer({
        host: '127.0.0.1',
        port: 0,
        apiKey: fakeApiKey,
        sequence: ['tool_call_success', 'success'],
        repeatLast: false,
        successText: workspacePlan.nonce,
        toolName: 'pwsh',
        toolArguments: workspacePlan.toolArguments
      });
    }
    const portableMarker = path.join(path.dirname(executable), 'resources', 'portable.marker');
    const portableMode = await stat(portableMarker).then(value => value.isFile()).catch(() => false);
    record.portableMode = portableMode;
    if (requirePortable && !portableMode) throw new Error('PORTABLE_MARKER_MISSING');
    if (portableMode) {
      const sourceRoot = path.dirname(executable);
      const portableRoot = path.join(prepared.root, 'portable-app');
      await cp(sourceRoot, portableRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: source => shouldCopyPortableEntry(sourceRoot, source)
      });
      launchExecutable = path.join(portableRoot, path.basename(executable));
      const copiedMarker = path.join(path.dirname(launchExecutable), 'resources', 'portable.marker');
      if (!await stat(copiedMarker).then(value => value.isFile()).catch(() => false)) {
        throw new Error('PORTABLE_MARKER_COPY_FAILED');
      }
      const portableData = path.join(portableRoot, 'portable-data');
      await mkdir(portableData, { recursive: true });
      await writeFile(path.join(portableData, 'settings.json'), `${JSON.stringify(prepared.settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    if (scenario === 'workspace-write') {
      await prepareWorkspaceWriteDshHome(prepared, launchExecutable, portableMode);
    }
    if (scenario === 'runtime-rollback') {
      rollbackPlan = await prepareRuntimeRollback(prepared, portableMode);
      record.runtimeRollback.candidateSeeded = true;
    }
    const remoteDebuggingPort = await findFreeLoopbackPort();
    record.cdpPort = remoteDebuggingPort;
    const environment = createTestEnvironment(prepared.root, prepared.appData, prepared.localAppData);
    if (scenario === 'workspace-write') {
      removeEnvironmentKeys(environment, ['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'DSH_PERMISSION_MODE']);
      environment.DEEPSEEK_BASE_URL = mock.baseURL;
      environment.DEEPSEEK_API_KEY = fakeApiKey;
    }
    child = spawn(launchExecutable, [
      `--user-data-dir=${prepared.userData}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${remoteDebuggingPort}`
    ], { cwd: path.dirname(launchExecutable), env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    record.pid = child.pid;
    record.launchVerified = safePid(child.pid) !== undefined;
    child.stdout?.on('data', chunk => countStreamBytes(stdoutStats, chunk));
    child.stderr?.on('data', chunk => countStreamBytes(stderrStats, chunk));
    exitPromise = observeExit(child).then(info => { exitInfo = info; return info; });
    record.launchMs = Date.now() - startedAt;

    const cdpEndpoint = await waitForCdp(remoteDebuggingPort, child);
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint, {
        timeout: 15_000,
        isLocal: true,
        // Electron already owns this persistent context. Avoid applying
        // Playwright's launch-time context defaults while attaching over CDP.
        noDefaults: true
      });
    } catch (error) {
      throw stableStageError(error, 'CDP_CONNECT_FAILED', 'CDP_CONNECT_TIMEOUT');
    }
    control = await waitForControlWindow(browser, child, exitPromise);
    record.controlWindowMs = Date.now() - startedAt;
    record.controlWindowVerified = true;
    const ready = await waitForRuntimeReady(control, child, exitPromise);
    record.runtimeReadyVerified = true;
    record.runtimePid = ready.snapshot.runtime.pid;
    record.isolationVerified = await verifyFilesystemIsolation(prepared, launchExecutable, portableMode, prepared.workspace);
    if (!record.isolationVerified) throw new Error('APPDATA_ISOLATION_FAILED');
    await requestHostDescribe(ready.snapshot.runtime.url, cycle);
    record.hostDescribeVerified = true;
    if (scenario === 'runtime-rollback') {
      const rollbackEvidence = await verifyRuntimeRollbackState(rollbackPlan.runtimes, rollbackPlan.candidateSlot, ready.snapshot.runtime);
      record.runtimeRollback = { requested: true, ...rollbackEvidence, readyVerified: rollbackEvidence.verified, postExitVerified: false, verified: false };
      if (!rollbackEvidence.verified) throw new Error('RUNTIME_ROLLBACK_FAILED');
    }
    if (scenario === 'workspace-write') {
      const workspaceOutcome = await runWorkspaceWrite(launchExecutable, prepared, ready.snapshot, cycle, mock, fakeApiKey, workspacePlan);
      const { errorCode, ...workspaceEvidence } = workspaceOutcome;
      record.workspaceWrite = workspaceEvidence;
      record.workspaceWriteVerified = workspaceOutcome.verified === true;
      record.errorCode ??= errorCode;
      if (!record.workspaceWriteVerified) throw new Error(errorCode ?? 'WORKSPACE_WRITE_FAILED');
    }
    // CIM can transiently omit a just-started process even after CDP and the
    // runtime RPC are ready. Require a bounded, identity-linked snapshot rather
    // than treating one empty sample as proof that the runtime is unowned.
    launchedTree = await waitForProcessTree(windowsProcesses, child.pid, record.runtimePid);
    record.processTreeCount = launchedTree.length;
    if (!launchedTree.some(item => item.pid === record.runtimePid)) throw new Error('RUNTIME_PID_NOT_IN_APP_PROCESS_TREE');
    record.runtimeReadyMs = Date.now() - startedAt;
    record.passed = true;
  } catch (error) {
    record.errorCode = stableStageErrorCode(error, 'E2E_CYCLE_FAILED', 'E2E_CYCLE_TIMEOUT');
  } finally {
    if (child && exitPromise && !exitInfo) {
      const termination = await terminateApplication(child, exitPromise, browser, control, scenario);
      record.forcedTermination = termination.forcedTermination;
      record.forceKillVerified = termination.forceKillVerified;
      record.quitAccepted = termination.quitAccepted === true;
      record.gracefulExitVerified = termination.gracefulExitVerified === true;
      if (record.forcedTermination && termination.quitAccepted === false) record.errorCode ??= 'APP_QUIT_REQUEST_FAILED';
    }
    if (record.forcedTermination && scenario === 'launch') {
      record.passed = false;
      record.errorCode ??= 'APPLICATION_DID_NOT_EXIT_GRACEFULLY';
    }
    if (browser) {
      try { await browser.close(); } catch { /* already disconnected */ }
    }
    if (exitInfo) {
      record.exitMs = exitInfo.at - startedAt;
      record.exitCode = exitInfo.code;
      record.exitSignal = exitInfo.signal;
      record.errorCode ??= exitInfo.errorCode;
    }
    if (child && !launchedTree.length) {
      launchedTree = await windowsProcesses().then(processes => processTree(processes, child.pid)).catch(() => []);
      record.processTreeCount = launchedTree.length;
    }
    if (launchedTree.length) {
      try {
        const cleanup = await ensureProcessesGone(launchedTree);
        record.forcedTermination ||= cleanup.forcedCleanup;
        record.remainingPids = cleanup.remaining.map(item => item.pid);
        record.runtimePidExited = !cleanup.remaining.some(item => item.pid === record.runtimePid);
        record.processTreeExited = cleanup.remaining.length === 0;
      } catch (error) {
        record.errorCode ??= stableStageErrorCode(error, 'PROCESS_TREE_AUDIT_FAILED', 'PROCESS_TREE_AUDIT_TIMEOUT');
        record.passed = false;
      }
    }
    if (record.cdpPort) record.cdpClosed = await cdpClosed(record.cdpPort);
    record.stdoutBytes = stdoutStats.bytes;
    record.stderrBytes = stderrStats.bytes;
    if (mock) {
      try { await mock.close(); }
      catch (error) {
        record.errorCode ??= stableStageErrorCode(error, 'MOCK_CLOSE_FAILED', 'MOCK_CLOSE_TIMEOUT');
        record.passed = false;
      }
    }
    if (scenario === 'runtime-rollback' && rollbackPlan) {
      const postExit = await verifyRuntimeRollbackState(rollbackPlan.runtimes, rollbackPlan.candidateSlot, { slot: 'bundled' });
      const readyVerified = record.runtimeRollback.readyVerified === true;
      record.runtimeRollback = {
        requested: true,
        ...postExit,
        readyVerified,
        postExitVerified: postExit.verified === true,
        verified: readyVerified && postExit.verified === true
      };
      record.runtimeRollbackVerified = record.runtimeRollback.verified;
      if (!record.runtimeRollbackVerified) record.errorCode ??= 'RUNTIME_ROLLBACK_FAILED';
    }
    if (prepared) {
      await cleanupPreparedRoot(prepared, record);
    } else {
      record.cleanup = 'not-created';
      record.cleanupVerified = false;
    }
    const processAudit = await auditScopedProcesses({
      startedAt,
      rootPid: child?.pid,
      knownProcesses: launchedTree,
      executablePaths: [executable, launchExecutable],
      tempRoots: prepared ? [prepared.root] : [],
      commandMarkers: prepared && record.cdpPort
        ? [`--user-data-dir=${prepared.userData}`, `--remote-debugging-port=${record.cdpPort}`]
        : []
    });
    const processTreeObserved = hasObservedProcessTree(launchedTree, child?.pid, record.runtimePid);
    record.finalScopedProcessAuditPassed = processTreeObserved && processAudit.verified === true;
    record.finalScopedProcessAuditPids = processAudit.pids;
    record.finalScopedProcessAuditCount = processAudit.pids.length;
    record.finalScopedProcessAuditKinds = processAudit.kinds ?? [];
    record.errorCode ??= processAudit.errorCode;
    if (!processTreeObserved) record.errorCode ??= 'RUNTIME_PID_NOT_IN_APP_PROCESS_TREE';
    else if (!record.finalScopedProcessAuditPassed) record.errorCode ??= 'PROCESS_PATH_AUDIT_FOUND';
    if (prepared && record.cleanup === 'removed' && !await pathIsAbsent(prepared.root)) {
      record.cleanupRootAbsent = false;
      record.cleanup = 'failed';
      record.cleanupVerified = false;
      record.errorCode ??= 'CLEANUP_ROOT_REAPPEARED';
    }
    record.exitVerified = scenario === 'force-kill'
      ? record.forceKillVerified && record.processTreeExited && record.cdpClosed && record.finalScopedProcessAuditPassed
      : record.quitAccepted && record.gracefulExitVerified && !record.forcedTermination
        && record.exitCode === 0 && !record.exitSignal && record.processTreeExited && record.cdpClosed
        && record.finalScopedProcessAuditPassed;
    record.passed = record.passed && record.launchVerified && record.exitVerified && record.cleanupVerified
      && record.finalScopedProcessAuditPassed
      && (scenario !== 'workspace-write' || record.workspaceWriteVerified)
      && (scenario !== 'runtime-rollback' || record.runtimeRollbackVerified);
    if (!record.passed) record.errorCode ??= cycleFailureCode(record);
  }
  return record;
}

async function resolveOutputPath(argument, scenario = 'launch') {
  const resolved = path.resolve(argument);
  let existing;
  try { existing = await stat(resolved); } catch { existing = undefined; }
  const directory = existing?.isDirectory() || /[\\/]$/u.test(argument) || path.extname(resolved).toLowerCase() !== '.json';
  if (directory) {
    await mkdir(resolved, { recursive: true });
    return path.join(resolved, scenario === 'qualification' ? 'qualification-evidence.json' : 'packaged-evidence.json');
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('PACKAGED_E2E_IS_WINDOWS_ONLY');
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const executable = path.resolve(options.exe);
  const executableStat = await stat(executable).catch(() => undefined);
  if (!executableStat?.isFile()) throw new Error('EXE_NOT_FOUND');
  const output = await resolveOutputPath(options.output, options.scenario);
  const { chromium } = await import('playwright');
  if (options.scenario === 'qualification') {
    const result = await runQualification(executable, chromium, options.requirePortable);
    const evidence = sanitizeQualificationEvidence({
      generatedAt: new Date().toISOString(),
      spawnVerified: result.spawnVerified,
      coldStartVerified: result.spawnVerified && result.controlWindowVerified && result.controlWindowOperational && result.coldRuntimeReadyVerified,
      restartRuntimeVerified: result.restartRequested && result.restartRuntimeAccepted && result.restartReadyVerified,
      electronRootStable: result.electronRootStable,
      quitAccepted: result.quitAccepted,
      gracefulExitVerified: result.gracefulExitVerified,
      exitVerified: result.exitVerified,
      cleanupVerified: result.cleanupVerified,
      finalScopedProcessAuditPassed: result.finalScopedProcessAuditPassed,
      passed: result.passed,
      cycles: [result]
    });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8' });
    console.log(`${evidence.passed ? 'PASS' : 'FAIL'} packaged qualification: ${evidence.passed ? '1/1' : '0/1'}; evidence=${path.basename(output)}`);
    if (!evidence.passed) process.exitCode = 1;
    return;
  }
  const cycles = [];
  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    const result = await runCycle(executable, cycle, chromium, options.scenario, options.requirePortable);
    cycles.push(result);
    console.log(`packaged E2E cycle ${cycle}/${options.cycles}: ${result.passed ? 'PASS' : 'FAIL'}`);
  }
  const portableMode = cycles.length === options.cycles && cycles.length > 0 && cycles.every(item => item.portableMode === true);
  const launchVerified = cycles.length === options.cycles && cycles.every(item => item.launchVerified === true);
  const forceKillVerified = options.scenario === 'force-kill' && cycles.length === options.cycles && cycles.every(item => item.forceKillVerified === true);
  const quitAccepted = options.scenario === 'force-kill'
    ? false
    : cycles.length === options.cycles && cycles.every(item => item.quitAccepted === true);
  const gracefulExitVerified = options.scenario === 'force-kill'
    ? false
    : cycles.length === options.cycles && cycles.every(item => item.gracefulExitVerified === true);
  const exitVerified = cycles.length === options.cycles && cycles.every(item => item.exitVerified === true);
  const cleanupVerified = cycles.length === options.cycles && cycles.every(item => item.cleanupVerified === true);
  const finalScopedProcessAuditPassed = cycles.length === options.cycles
    && cycles.every(item => item.finalScopedProcessAuditPassed === true);
  const workspaceWriteVerified = options.scenario === 'workspace-write' && cycles.length === options.cycles && cycles.every(item => item.workspaceWriteVerified === true);
  const runtimeRollbackVerified = options.scenario === 'runtime-rollback' && cycles.length === options.cycles && cycles.every(item => item.runtimeRollbackVerified === true);
  const evidence = sanitizeEvidence({
    schemaVersion: 1,
    tool: 'adhd-one-packaged-e2e',
    generatedAt: new Date().toISOString(),
    executable: path.basename(executable),
    scenario: options.scenario,
    portableMode,
    launchVerified,
    forceKillRequested: options.scenario === 'force-kill',
    forceKillVerified,
    quitAccepted,
    gracefulExitVerified,
    exitVerified,
    cleanupVerified,
    finalScopedProcessAuditPassed,
    workspaceWriteRequested: options.scenario === 'workspace-write',
    workspaceWriteVerified,
    runtimeRollbackRequested: options.scenario === 'runtime-rollback',
    runtimeRollbackVerified,
    cyclesRequested: options.cycles,
    cyclesCompleted: cycles.length,
    passed: cycles.length === options.cycles && cycles.every(item => item.passed && item.cleanup === 'removed'),
    cycles
  });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8' });
  console.log(`${evidence.passed ? 'PASS' : 'FAIL'} packaged E2E: ${cycles.filter(item => item.passed).length}/${cycles.length} cycles; evidence=${path.basename(output)}`);
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => {
    console.error(`packaged E2E failed: ${stableStageErrorCode(error, 'E2E_MAIN_FAILED', 'E2E_MAIN_TIMEOUT')}`);
    console.error(usage());
    process.exitCode = 2;
  });
}
