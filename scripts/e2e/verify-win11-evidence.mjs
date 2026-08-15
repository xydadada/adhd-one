import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Offline Windows 11 evidence contract.
 *
 * The verifier accepts exactly this JSON shape:
 * {
 *   "schemaVersion": 1,
 *   "tool": "adhd-one-win11-evidence",
 *   "platform": { "os": "Windows 11", "architecture": "x64", "buildNumber": 26100 },
 *   "executable": {
 *     "name": "ADHD One.exe",
 *     "sha256": "<64 lowercase hexadecimal characters>",
 *     "sha256Verified": true
 *   },
 *   "performance": {
 *     "firstInteractiveMs": 15000,
 *     "hotStartReadyMs": 8000,
 *     "idleCpuPercent": 0.99,
 *     "exitMs": 5000
 *   },
 *   "processes": { "residualCount": 0 }
 * }
 *
 * The executable digest is evidence produced by the E2E runner. This module
 * deliberately does not open the executable or inspect the host: offline
 * verification can validate the digest format and the producer's explicit
 * hash-verification assertion only.
 */

export const WIN11_EVIDENCE_SCHEMA_VERSION = 1;
export const WIN11_EVIDENCE_TOOL = 'adhd-one-win11-evidence';
export const WIN11_EVIDENCE_LIMITS = Object.freeze({
  firstInteractiveMs: 15_000,
  hotStartReadyMs: 8_000,
  idleCpuPercentExclusive: 1,
  exitMs: 5_000
});

const MAX_JSON_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_EXE_NAME = 'ADHD One.exe';

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'tool',
  'platform',
  'executable',
  'performance',
  'processes'
]);
const PLATFORM_KEYS = new Set(['os', 'architecture', 'buildNumber']);
const EXECUTABLE_KEYS = new Set(['name', 'sha256', 'sha256Verified']);
const PERFORMANCE_KEYS = new Set([
  'firstInteractiveMs',
  'hotStartReadyMs',
  'idleCpuPercent',
  'exitMs'
]);
const PROCESS_KEYS = new Set(['residualCount']);

const ERROR = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  FILE_UNREADABLE: 'EVIDENCE_FILE_UNREADABLE',
  JSON_INVALID: 'EVIDENCE_JSON_INVALID',
  JSON_TOO_LARGE: 'EVIDENCE_JSON_TOO_LARGE',
  ROOT_INVALID: 'SCHEMA_ROOT_INVALID',
  OBJECT_INVALID: 'SCHEMA_OBJECT_INVALID',
  EXTRA_FIELD: 'SCHEMA_EXTRA_FIELD',
  REQUIRED_FIELD_MISSING: 'SCHEMA_REQUIRED_FIELD_MISSING',
  VERSION_INVALID: 'SCHEMA_VERSION_INVALID',
  TOOL_INVALID: 'TOOL_INVALID',
  PLATFORM_INVALID: 'PLATFORM_INVALID',
  PLATFORM_BUILD_INVALID: 'PLATFORM_BUILD_INVALID',
  EXECUTABLE_INVALID: 'EXE_INVALID',
  SENSITIVE_PATH: 'SENSITIVE_PATH_REJECTED',
  SHA256_INVALID: 'EXE_SHA256_INVALID',
  SHA256_UNVERIFIED: 'EXE_SHA256_UNVERIFIED',
  PERFORMANCE_INVALID: 'PERFORMANCE_INVALID',
  FIRST_INTERACTION_TIMEOUT: 'FIRST_INTERACTION_TIMEOUT',
  HOT_START_TIMEOUT: 'HOT_START_READY_TIMEOUT',
  IDLE_CPU_LIMIT: 'IDLE_CPU_LIMIT_EXCEEDED',
  EXIT_TIMEOUT: 'EXIT_TIMEOUT',
  RESIDUAL_COUNT_INVALID: 'RESIDUAL_PROCESS_COUNT_INVALID',
  RESIDUAL_PROCESSES: 'RESIDUAL_PROCESSES_PRESENT'
});

function addError(errors, code) {
  if (!errors.includes(code)) errors.push(code);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value, allowed, errors) {
  if (!isRecord(value)) {
    addError(errors, ERROR.OBJECT_INVALID);
    return false;
  }

  let valid = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      addError(errors, ERROR.EXTRA_FIELD);
      valid = false;
    }
  }
  for (const key of allowed) {
    if (!hasOwn(value, key)) {
      addError(errors, ERROR.REQUIRED_FIELD_MISSING);
      valid = false;
    }
  }
  return valid;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function looksLikePath(value) {
  return typeof value === 'string'
    && (value.includes('\\')
      || value.includes('/')
      || /^[A-Za-z]:/u.test(value)
      || value.includes('\0')
      || value === '.'
      || value === '..');
}

function hasDuplicateJsonKeys(text) {
  const keys = new Set();
  const propertyPattern = /"(?:\\.|[^"\\])*"\s*:/gu;
  for (const match of text.matchAll(propertyPattern)) {
    const literal = match[0].slice(0, match[0].lastIndexOf(':')).trim();
    let key;
    try { key = JSON.parse(literal); }
    catch { return true; }
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function validatePlatform(value, errors) {
  if (!hasExactKeys(value, PLATFORM_KEYS, errors)) return;
  if (value.os !== 'Windows 11' || value.architecture !== 'x64') {
    addError(errors, ERROR.PLATFORM_INVALID);
  }
  if (!Number.isSafeInteger(value.buildNumber) || value.buildNumber < 22_000) {
    addError(errors, ERROR.PLATFORM_BUILD_INVALID);
  }
}

function validateExecutable(value, errors) {
  if (!hasExactKeys(value, EXECUTABLE_KEYS, errors)) return;

  if (value.name !== EXPECTED_EXE_NAME) {
    addError(errors, looksLikePath(value.name) ? ERROR.SENSITIVE_PATH : ERROR.EXECUTABLE_INVALID);
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    addError(errors, ERROR.SHA256_INVALID);
  }
  if (value.sha256Verified !== true) addError(errors, ERROR.SHA256_UNVERIFIED);
}

function validatePerformance(value, errors) {
  if (!hasExactKeys(value, PERFORMANCE_KEYS, errors)) return;

  const integerMetrics = ['firstInteractiveMs', 'hotStartReadyMs', 'exitMs'];
  if (integerMetrics.some(key => !isNonNegativeInteger(value[key]))) {
    addError(errors, ERROR.PERFORMANCE_INVALID);
  }
  if (!isFiniteNonNegativeNumber(value.idleCpuPercent)) {
    addError(errors, ERROR.PERFORMANCE_INVALID);
  }

  if (isNonNegativeInteger(value.firstInteractiveMs)
    && value.firstInteractiveMs > WIN11_EVIDENCE_LIMITS.firstInteractiveMs) {
    addError(errors, ERROR.FIRST_INTERACTION_TIMEOUT);
  }
  if (isNonNegativeInteger(value.hotStartReadyMs)
    && value.hotStartReadyMs > WIN11_EVIDENCE_LIMITS.hotStartReadyMs) {
    addError(errors, ERROR.HOT_START_TIMEOUT);
  }
  if (isFiniteNonNegativeNumber(value.idleCpuPercent)
    && value.idleCpuPercent >= WIN11_EVIDENCE_LIMITS.idleCpuPercentExclusive) {
    addError(errors, ERROR.IDLE_CPU_LIMIT);
  }
  if (isNonNegativeInteger(value.exitMs) && value.exitMs > WIN11_EVIDENCE_LIMITS.exitMs) {
    addError(errors, ERROR.EXIT_TIMEOUT);
  }
}

function validateProcesses(value, errors) {
  if (!hasExactKeys(value, PROCESS_KEYS, errors)) return;
  if (!isNonNegativeInteger(value.residualCount)) {
    addError(errors, ERROR.RESIDUAL_COUNT_INVALID);
  } else if (value.residualCount !== 0) {
    addError(errors, ERROR.RESIDUAL_PROCESSES);
  }
}

/**
 * Validate an already parsed evidence value without touching the host.
 * The returned errors are stable codes and never include input values.
 */
export function validateWin11Evidence(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: [ERROR.ROOT_INVALID] };

  hasExactKeys(value, TOP_LEVEL_KEYS, errors);
  if (value.schemaVersion !== WIN11_EVIDENCE_SCHEMA_VERSION) addError(errors, ERROR.VERSION_INVALID);
  if (value.tool !== WIN11_EVIDENCE_TOOL) addError(errors, ERROR.TOOL_INVALID);
  validatePlatform(value.platform, errors);
  validateExecutable(value.executable, errors);
  validatePerformance(value.performance, errors);
  validateProcesses(value.processes, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Verify a parsed value. A string is accepted as a convenience for callers
 * that want the file-reading entry point; the string itself is never echoed.
 */
export function verifyWin11Evidence(value) {
  return typeof value === 'string' ? verifyWin11EvidenceFile(value) : validateWin11Evidence(value);
}

/**
 * Read one caller-provided JSON file and validate it. No executable, process,
 * registry, environment, network, or other system state is inspected.
 */
export async function verifyWin11EvidenceFile(filename) {
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    return { ok: false, errors: [ERROR.INVALID_ARGUMENT] };
  }

  let text;
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) return { ok: false, errors: [ERROR.FILE_UNREADABLE] };
    if (metadata.size > MAX_JSON_BYTES) return { ok: false, errors: [ERROR.JSON_TOO_LARGE] };
    text = await readFile(filename, 'utf8');
  } catch {
    return { ok: false, errors: [ERROR.FILE_UNREADABLE] };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    return { ok: false, errors: [ERROR.JSON_TOO_LARGE] };
  }

  let value;
  try {
    if (hasDuplicateJsonKeys(text)) return { ok: false, errors: [ERROR.JSON_INVALID] };
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [ERROR.JSON_INVALID] };
  }
  return validateWin11Evidence(value);
}

export const WIN11_EVIDENCE_ERRORS = ERROR;

function isMain() {
  return process.argv[1]
    && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error(`FAIL ${ERROR.INVALID_ARGUMENT}`);
    process.exitCode = 2;
    return;
  }

  const result = await verifyWin11EvidenceFile(args[0]);
  if (result.ok) {
    console.log('PASS');
    return;
  }
  console.error(`FAIL ${result.errors.join(' ')}`);
  process.exitCode = 1;
}

if (isMain()) {
  main().catch(() => {
    console.error('FAIL VERIFIER_INTERNAL_ERROR');
    process.exitCode = 2;
  });
}
