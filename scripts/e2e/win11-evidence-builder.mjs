import {
  validateWin11Evidence,
  WIN11_EVIDENCE_ERRORS,
  WIN11_EVIDENCE_SCHEMA_VERSION,
  WIN11_EVIDENCE_TOOL
} from './verify-win11-evidence.mjs';

const INPUT_KEYS = new Set([
  'host',
  'executable',
  'firstInteractiveMs',
  'hotStartReadyMs',
  'idleCpuPercent',
  'exitMs',
  'residualProcesses'
]);
const HOST_KEYS = new Set(['os', 'architecture', 'buildNumber']);
const EXECUTABLE_INPUT_KEYS = new Set(['basename', 'sha256', 'sha256Verified']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors, code) {
  if (!errors.includes(code)) errors.push(code);
}

function hasExactKeys(value, allowed, errors) {
  if (!isRecord(value)) {
    addError(errors, WIN11_EVIDENCE_ERRORS.OBJECT_INVALID);
    return false;
  }

  let valid = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      addError(errors, WIN11_EVIDENCE_ERRORS.EXTRA_FIELD);
      valid = false;
    }
  }
  for (const key of allowed) {
    if (!hasOwn(value, key)) {
      addError(errors, WIN11_EVIDENCE_ERRORS.REQUIRED_FIELD_MISSING);
      valid = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) {
      addError(errors, WIN11_EVIDENCE_ERRORS.INVALID_ARGUMENT);
      valid = false;
    }
  }
  return valid;
}

function throwBuilderError(errors) {
  const stableErrors = [...new Set(errors)];
  if (stableErrors.length === 0) stableErrors.push(WIN11_EVIDENCE_ERRORS.INVALID_ARGUMENT);
  throw new Win11EvidenceBuilderError(stableErrors);
}

/**
 * Error raised when the builder cannot produce verifier-accepted evidence.
 * Only stable verifier error codes are retained; input values are never
 * included in the error message.
 */
export class Win11EvidenceBuilderError extends TypeError {
  constructor(errors) {
    const stableErrors = [...new Set(errors)];
    super(`Windows 11 evidence rejected: ${stableErrors.join(' ')}`);
    this.name = 'Win11EvidenceBuilderError';
    this.code = stableErrors[0] ?? WIN11_EVIDENCE_ERRORS.INVALID_ARGUMENT;
    this.errors = Object.freeze(stableErrors);
  }
}

/**
 * Build the path-free Windows 11 qualification record from already collected
 * and verified values. This function performs no host, file, process, or
 * digest collection. `residualProcesses` may be the verified residual count
 * or the verified list of residual processes; only an empty list/count zero
 * can produce a passing record, and no list item is copied to the result.
 *
 * The accepted input shape is exact:
 * {
 *   host: { os, architecture, buildNumber },
 *   executable: { basename, sha256, sha256Verified },
 *   firstInteractiveMs,
 *   hotStartReadyMs,
 *   idleCpuPercent,
 *   exitMs,
 *   residualProcesses
 * }
 */
function buildWin11EvidenceUnchecked(input) {
  if (!isRecord(input)) throwBuilderError([WIN11_EVIDENCE_ERRORS.ROOT_INVALID]);

  const errors = [];
  hasExactKeys(input, INPUT_KEYS, errors);
  hasExactKeys(input.host, HOST_KEYS, errors);
  hasExactKeys(input.executable, EXECUTABLE_INPUT_KEYS, errors);
  if (errors.length > 0) throwBuilderError(errors);

  const evidence = {
    schemaVersion: WIN11_EVIDENCE_SCHEMA_VERSION,
    tool: WIN11_EVIDENCE_TOOL,
    platform: {
      os: input.host.os,
      architecture: input.host.architecture,
      buildNumber: input.host.buildNumber
    },
    executable: {
      name: input.executable.basename,
      sha256: input.executable.sha256,
      sha256Verified: input.executable.sha256Verified
    },
    performance: {
      firstInteractiveMs: input.firstInteractiveMs,
      hotStartReadyMs: input.hotStartReadyMs,
      idleCpuPercent: input.idleCpuPercent,
      exitMs: input.exitMs
    },
    processes: {
      residualCount: Array.isArray(input.residualProcesses)
        ? input.residualProcesses.length
        : input.residualProcesses
    }
  };

  const result = validateWin11Evidence(evidence);
  if (!result.ok) throwBuilderError(result.errors);
  return evidence;
}

export function buildWin11Evidence(input) {
  try {
    return buildWin11EvidenceUnchecked(input);
  } catch (error) {
    if (error instanceof Win11EvidenceBuilderError) throw error;
    throwBuilderError([WIN11_EVIDENCE_ERRORS.INVALID_ARGUMENT]);
  }
}

export default buildWin11Evidence;
