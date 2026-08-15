import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWin11Evidence } from './win11-evidence-builder.mjs';
import { collectWin11HostProof } from './win11-host-proof.mjs';
import { hasDuplicateJsonKeys } from './verify-win11-evidence.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const BOOLEAN_GATES = [
  'spawnVerified', 'coldStartVerified', 'restartRuntimeVerified', 'electronRootStable',
  'quitAccepted', 'gracefulExitVerified', 'exitVerified', 'cleanupVerified',
  'finalScopedProcessAuditPassed'
];
const TOP_KEYS = new Set([
  'schemaVersion', 'tool', 'generatedAt', 'scenario', 'cyclesRequested', 'cyclesCompleted',
  ...BOOLEAN_GATES, 'passed', 'cycles'
]);
const CYCLE_KEYS = new Set([
  'cycle', 'scenario', 'passed', 'spawnVerified', 'hostToolchainPathExcluded', 'executableSha256',
  'spawnToControlWindowMs', 'controlWindowVerified', 'controlWindowOperational',
  'coldRuntimeReadyVerified', 'coldGeneration', 'restartRequested', 'restartRuntimeAccepted',
  'restartReadyVerified', 'restartToReadyMs', 'idleCpuMeasured', 'idleCpuPercent',
  'idleCpuProcessCount', 'hotGeneration', 'electronRootStable', 'coldProcessTreeObserved',
  'hotProcessTreeObserved', 'coldProcessTreeCount', 'hotProcessTreeCount',
  'mergedProcessTreeCount', 'processTreeExited', 'quitAccepted', 'quitToExitMs',
  'gracefulExitVerified', 'forcedTermination', 'exitCode', 'exitSignal', 'exitVerified',
  'cdpClosed', 'cleanup', 'cleanupRootExisted', 'cleanupRootAbsent', 'cleanupVerified',
  'finalScopedProcessAuditPassed', 'finalScopedProcessAuditCount'
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const WIN11_EVIDENCE_COLLECTOR_ERRORS = Object.freeze({
  INVALID_ARGUMENT: 'WIN11_EVIDENCE_COLLECTOR_INVALID_ARGUMENT',
  INPUT_UNREADABLE: 'WIN11_EVIDENCE_COLLECTOR_INPUT_UNREADABLE',
  INPUT_TOO_LARGE: 'WIN11_EVIDENCE_COLLECTOR_INPUT_TOO_LARGE',
  INPUT_INVALID: 'WIN11_EVIDENCE_COLLECTOR_INPUT_INVALID',
  OUTPUT_EXISTS: 'WIN11_EVIDENCE_COLLECTOR_OUTPUT_EXISTS',
  OUTPUT_FAILED: 'WIN11_EVIDENCE_COLLECTOR_OUTPUT_FAILED'
});

export class Win11EvidenceCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Win11EvidenceCollectorError';
    this.code = code;
  }
}

function fail(code) { throw new Win11EvidenceCollectorError(code); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function nonNegativeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
}

export function qualificationMetrics(value) {
  if (!hasExactKeys(value, TOP_KEYS)
    || value.schemaVersion !== 1
    || value.tool !== 'adhd-one-packaged-qualification'
    || value.scenario !== 'qualification'
    || value.cyclesRequested !== 1
    || value.cyclesCompleted !== 1
    || typeof value.generatedAt !== 'string'
    || !ISO_TIMESTAMP.test(value.generatedAt)
    || value.passed !== true
    || BOOLEAN_GATES.some(key => value[key] !== true)
    || !Array.isArray(value.cycles)
    || value.cycles.length !== 1) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID);

  const cycle = value.cycles[0];
  if (!hasExactKeys(cycle, CYCLE_KEYS)
    || cycle.cycle !== 1
    || cycle.scenario !== 'qualification'
    || cycle.passed !== true
    || cycle.hostToolchainPathExcluded !== true
    || typeof cycle.executableSha256 !== 'string'
    || !SHA256.test(cycle.executableSha256)
    || cycle.spawnVerified !== true
    || cycle.controlWindowVerified !== true
    || cycle.controlWindowOperational !== true
    || cycle.coldRuntimeReadyVerified !== true
    || !nonNegativeInteger(cycle.coldGeneration)
    || cycle.restartRequested !== true
    || cycle.restartRuntimeAccepted !== true
    || cycle.restartReadyVerified !== true
    || !nonNegativeInteger(cycle.hotGeneration)
    || cycle.hotGeneration <= cycle.coldGeneration
    || cycle.electronRootStable !== true
    || cycle.coldProcessTreeObserved !== true
    || cycle.hotProcessTreeObserved !== true
    || !nonNegativeInteger(cycle.mergedProcessTreeCount)
    || cycle.mergedProcessTreeCount < 3
    || cycle.processTreeExited !== true
    || cycle.idleCpuMeasured !== true
    || !nonNegativeInteger(cycle.idleCpuProcessCount)
    || cycle.idleCpuProcessCount < 1
    || cycle.finalScopedProcessAuditPassed !== true
    || cycle.finalScopedProcessAuditCount !== 0
    || cycle.forcedTermination !== false
    || cycle.quitAccepted !== true
    || cycle.gracefulExitVerified !== true
    || cycle.exitCode !== 0
    || cycle.exitSignal !== null
    || cycle.exitVerified !== true
    || cycle.cdpClosed !== true
    || cycle.cleanup !== 'removed'
    || cycle.cleanupRootExisted !== true
    || cycle.cleanupRootAbsent !== true
    || cycle.cleanupVerified !== true
    || !nonNegativeInteger(cycle.spawnToControlWindowMs)
    || !nonNegativeInteger(cycle.restartToReadyMs)
    || !nonNegativeNumber(cycle.idleCpuPercent)
    || !nonNegativeInteger(cycle.quitToExitMs)
    || cycle.spawnToControlWindowMs > 15_000
    || cycle.restartToReadyMs > 8_000
    || cycle.idleCpuPercent >= 1
    || cycle.quitToExitMs > 5_000) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID);

  return Object.freeze({
    firstInteractiveMs: cycle.spawnToControlWindowMs,
    hotStartReadyMs: cycle.restartToReadyMs,
    idleCpuPercent: cycle.idleCpuPercent,
    exitMs: cycle.quitToExitMs,
    residualProcesses: cycle.finalScopedProcessAuditCount,
    executableSha256: cycle.executableSha256
  });
}

async function readQualification(filename) {
  let metadata;
  try { metadata = await lstat(filename); } catch { fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_UNREADABLE); }
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_UNREADABLE);
  if (metadata.size > MAX_INPUT_BYTES) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_TOO_LARGE);
  try {
    const text = await readFile(filename, 'utf8');
    if (hasDuplicateJsonKeys(text)) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID);
    return JSON.parse(text);
  }
  catch { fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID); }
}

export async function collectWin11Evidence({ executablePath, qualificationPath, outputPath } = {}) {
  if (![executablePath, qualificationPath, outputPath].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
  }
  if (path.dirname(qualificationPath) !== path.dirname(outputPath)) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
  const qualification = await readQualification(qualificationPath);
  const metrics = qualificationMetrics(qualification);
  const proof = await collectWin11HostProof(executablePath);
  if (proof.executable.sha256 !== metrics.executableSha256) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID);
  const { executableSha256: _boundDigest, ...builderMetrics } = metrics;
  const evidence = buildWin11Evidence({ ...proof, ...builderMetrics });
  try { await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    fail(error?.code === 'EEXIST' ? WIN11_EVIDENCE_COLLECTOR_ERRORS.OUTPUT_EXISTS : WIN11_EVIDENCE_COLLECTOR_ERRORS.OUTPUT_FAILED);
  }
  return evidence;
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--exe', '--qualification', '--output'].includes(name) || typeof value !== 'string' || value.startsWith('--')) {
      fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
    }
    const key = name === '--exe' ? 'executablePath' : name === '--qualification' ? 'qualificationPath' : 'outputPath';
    if (result[key] !== undefined) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
    result[key] = value;
  }
  if (Object.keys(result).length !== 3) fail(WIN11_EVIDENCE_COLLECTOR_ERRORS.INVALID_ARGUMENT);
  return result;
}

const invokedPath = process.argv[1];
if (typeof invokedPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  collectWin11Evidence(parseArgs(process.argv.slice(2))).catch(error => {
    const code = error instanceof Win11EvidenceCollectorError ? error.code : WIN11_EVIDENCE_COLLECTOR_ERRORS.INPUT_INVALID;
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
