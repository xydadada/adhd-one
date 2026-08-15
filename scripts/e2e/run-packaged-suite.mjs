import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGED_SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, 'packaged.mjs');
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const RUNTIME_ROLLBACK_PROOF_KEYS = Object.freeze([
  'requested', 'verified', 'candidateSeeded', 'bundledActive',
  'previousCandidateRecorded', 'healthy', 'candidateCleared',
  'rollbackMarkerRecorded', 'candidateSlotRetained', 'readyVerified', 'postExitVerified'
]);

export const PACKAGED_SUITE_STEPS = Object.freeze([
  Object.freeze({
    id: 'launch-1',
    scenario: 'launch',
    cycles: 1,
    evidenceFile: 'launch-1.json',
    failureCode: 'PACKAGED_SUITE_LAUNCH_FAILED'
  }),
  Object.freeze({
    id: 'force-kill-1',
    scenario: 'force-kill',
    cycles: 1,
    evidenceFile: 'force-kill-1.json',
    failureCode: 'PACKAGED_SUITE_FORCE_KILL_FAILED'
  }),
  Object.freeze({
    id: 'workspace-write-1',
    scenario: 'workspace-write',
    cycles: 1,
    evidenceFile: 'workspace-write-1.json',
    failureCode: 'PACKAGED_SUITE_WORKSPACE_WRITE_FAILED'
  }),
  Object.freeze({
    id: 'runtime-rollback-1',
    scenario: 'runtime-rollback',
    cycles: 1,
    evidenceFile: 'runtime-rollback-1.json',
    failureCode: 'PACKAGED_SUITE_RUNTIME_ROLLBACK_FAILED'
  }),
  Object.freeze({
    id: 'launch-10',
    scenario: 'launch',
    cycles: 10,
    evidenceFile: 'launch-10.json',
    failureCode: 'PACKAGED_SUITE_LAUNCH_TEN_CYCLES_FAILED'
  })
]);

function suiteError(code, exitCode) {
  const error = new Error(code);
  error.code = code;
  error.suiteExitCode = exitCode;
  return error;
}

function safeErrorCode(value) {
  const candidate = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : 'PACKAGED_SUITE_FAILED';
}

function usage() {
  return [
    'Usage:',
    '  node scripts/e2e/run-packaged-suite.mjs --exe <path-to-app-exe> --evidence-dir <directory>',
    '',
    'Runs launch x1, force-kill x1, workspace-write x1, runtime-rollback x1, and launch x10 in that order.'
  ].join('\n');
}

export function parseSuiteArgs(argv) {
  if (!Array.isArray(argv)) throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  const values = { exe: undefined, evidenceDir: undefined };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (typeof token !== 'string') throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    let value = equal >= 0 ? token.slice(equal + 1) : undefined;
    if (name !== '--exe' && name !== '--evidence-dir') throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
    if (seen.has(name)) throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
    seen.add(name);
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
    }
    if (name === '--exe') values.exe = value;
    else values.evidenceDir = value;
  }
  if (!values.exe || !values.evidenceDir) throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  return {
    help: false,
    exe: path.resolve(values.exe),
    evidenceDir: path.resolve(values.evidenceDir)
  };
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object'
    || typeof options.exe !== 'string' || options.exe.length === 0
    || typeof options.evidenceDir !== 'string' || options.evidenceDir.length === 0) {
    throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  }
  if (typeof options.spawnImpl !== 'undefined' && typeof options.spawnImpl !== 'function') {
    throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  }
  if (typeof options.mkdirImpl !== 'undefined' && typeof options.mkdirImpl !== 'function') {
    throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  }
  if (typeof options.readFileImpl !== 'undefined' && typeof options.readFileImpl !== 'function') {
    throw suiteError('PACKAGED_SUITE_INVALID_ARGUMENT', 2);
  }
  return {
    exe: path.resolve(options.exe),
    evidenceDir: path.resolve(options.evidenceDir),
    spawnImpl: options.spawnImpl ?? spawn,
    mkdirImpl: options.mkdirImpl ?? mkdir,
    readFileImpl: options.readFileImpl ?? readFile
  };
}

function childArguments(step, exe, evidenceDir) {
  return [
    PACKAGED_SCRIPT_PATH,
    '--exe', exe,
    '--output', path.join(evidenceDir, step.evidenceFile),
    '--scenario', step.scenario,
    '--cycles', String(step.cycles)
  ];
}

function terminateChildTree(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15_000
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* best effort after a hard deadline */ }
}

function waitForChild(child, timeoutMs) {
  if (!child || typeof child.once !== 'function') {
    return Promise.resolve({ spawnError: true, code: null, signal: null });
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateChildTree(child);
      finish({ spawnError: false, timedOut: true, code: null, signal: null });
    }, timeoutMs);
    child.once('error', () => finish({ spawnError: true, code: null, signal: null }));
    child.once('close', (code, signal) => finish({
      spawnError: false,
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === 'string' ? signal : null
    }));
  });
}

async function verifyEvidence(readFileImpl, outputPath, step, startedAt) {
  let text;
  try {
    text = await readFileImpl(outputPath, 'utf8');
  } catch {
    throw suiteError('PACKAGED_SUITE_EVIDENCE_MISSING', 1);
  }
  try {
    const evidence = JSON.parse(text);
    const cycles = Array.isArray(evidence.cycles) ? evidence.cycles : [];
    const generatedAt = Date.parse(evidence.generatedAt);
    const cyclesValid = cycles.length === step.cycles && cycles.every((cycle, index) => {
      if (typeof cycle !== 'object' || cycle === null
        || cycle.cycle !== index + 1
        || cycle.scenario !== step.scenario
        || cycle.passed !== true
        || typeof cycle.portableMode !== 'boolean'
        || cycle.launchVerified !== true
        || cycle.cleanupVerified !== true
        || cycle.cleanup !== 'removed'
        || cycle.exitVerified !== true
        || cycle.finalScopedProcessAuditPassed !== true
        || cycle.cdpClosed !== true
        || cycle.processTreeExited !== true
        || cycle.runtimePidExited !== true
        || !Array.isArray(cycle.remainingPids)
        || cycle.remainingPids.length !== 0) return false;
      if (step.scenario !== 'force-kill'
        && (cycle.quitAccepted !== true || cycle.gracefulExitVerified !== true)) return false;
      if (step.scenario === 'force-kill' && cycle.forceKillVerified !== true) return false;
      if (step.scenario === 'workspace-write' && cycle.workspaceWriteVerified !== true) return false;
      if (step.scenario === 'runtime-rollback') {
        const proof = cycle.runtimeRollback;
        if (cycle.runtimeRollbackVerified !== true || typeof proof !== 'object' || proof === null
          || Object.keys(proof).length !== RUNTIME_ROLLBACK_PROOF_KEYS.length
          || !RUNTIME_ROLLBACK_PROOF_KEYS.every(key => proof[key] === true)) return false;
      }
      return true;
    });
    const normalExitValid = step.scenario === 'force-kill'
      || (evidence.quitAccepted === true && evidence.gracefulExitVerified === true);
    if (typeof evidence !== 'object' || evidence === null
      || evidence.schemaVersion !== 1
      || evidence.tool !== 'adhd-one-packaged-e2e'
      || !Number.isFinite(generatedAt)
      || generatedAt < startedAt - 5_000
      || evidence.passed !== true
      || evidence.scenario !== step.scenario
      || typeof evidence.portableMode !== 'boolean'
      || evidence.launchVerified !== true
      || evidence.exitVerified !== true
      || evidence.cleanupVerified !== true
      || evidence.finalScopedProcessAuditPassed !== true
      || !normalExitValid
      || evidence.cyclesRequested !== step.cycles
      || evidence.cyclesCompleted !== step.cycles
      || !cyclesValid) {
      throw new Error('invalid evidence');
    }
    if (step.scenario === 'force-kill'
      && (evidence.forceKillRequested !== true || evidence.forceKillVerified !== true)) {
      throw new Error('invalid force-kill evidence');
    }
    if (step.scenario === 'workspace-write'
      && (evidence.workspaceWriteRequested !== true || evidence.workspaceWriteVerified !== true)) {
      throw new Error('invalid workspace-write evidence');
    }
    if (step.scenario === 'runtime-rollback'
      && (evidence.runtimeRollbackRequested !== true || evidence.runtimeRollbackVerified !== true)) {
      throw new Error('invalid runtime-rollback evidence');
    }
  } catch {
    throw suiteError('PACKAGED_SUITE_EVIDENCE_INVALID', 1);
  }
}

export async function runPackagedSuite(options) {
  const normalized = normalizeOptions(options);
  try {
    await normalized.mkdirImpl(normalized.evidenceDir, { recursive: true });
  } catch {
    throw suiteError('PACKAGED_SUITE_EVIDENCE_DIR_FAILED', 2);
  }

  const completed = [];
  for (const step of PACKAGED_SUITE_STEPS) {
    const outputPath = path.join(normalized.evidenceDir, step.evidenceFile);
    await rm(outputPath, { force: true });
    const startedAt = Date.now();
    let child;
    try {
      child = normalized.spawnImpl(process.execPath, childArguments(step, normalized.exe, normalized.evidenceDir), {
        cwd: REPOSITORY_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        shell: false
      });
    } catch {
      throw suiteError(`${step.failureCode}_SPAWN`, 2);
    }
    const result = await waitForChild(child, 30_000 + step.cycles * 120_000);
    if (result.spawnError) throw suiteError(`${step.failureCode}_SPAWN`, 2);
    if (result.timedOut) throw suiteError(`${step.failureCode}_TIMEOUT`, 1);
    if (result.code !== 0 || result.signal !== null) throw suiteError(step.failureCode, 1);
    await verifyEvidence(normalized.readFileImpl, outputPath, step, startedAt);
    completed.push({ id: step.id, scenario: step.scenario, cycles: step.cycles, evidencePath: outputPath });
  }
  return { exe: normalized.exe, evidenceDir: normalized.evidenceDir, steps: completed };
}

async function main() {
  const options = parseSuiteArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runPackagedSuite(options);
  console.log(`PASS packaged suite: ${result.steps.length}/${PACKAGED_SUITE_STEPS.length} steps`);
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => {
    console.error(`packaged suite failed: ${safeErrorCode(error)}`);
    process.exitCode = Number.isInteger(error?.suiteExitCode) ? error.suiteExitCode : 2;
  });
}
