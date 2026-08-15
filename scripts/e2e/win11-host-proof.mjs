import { createHash } from 'node:crypto';
import { createReadStream as defaultCreateReadStream } from 'node:fs';
import { lstat as defaultLstat, realpath as defaultRealpath } from 'node:fs/promises';
import { execFile as defaultExecFile } from 'node:child_process';
import { basename, isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(defaultExecFile);

export const WIN11_HOST_PROOF_EXPECTED_EXE = 'ADHD One.exe';
export const WIN11_HOST_PROOF_MIN_BUILD = 22_000;
export const WIN11_HOST_PROOF_POWERSHELL_TIMEOUT_MS = 15_000;

const ERROR_CODES = {
  INVALID_ARGUMENT: 'WIN11_HOST_PROOF_INVALID_ARGUMENT',
  EXECUTABLE_PATH_INVALID: 'WIN11_HOST_PROOF_EXECUTABLE_PATH_INVALID',
  INVALID_EXECUTABLE_PATH: 'WIN11_HOST_PROOF_EXECUTABLE_PATH_INVALID',
  EXECUTABLE_NOT_FOUND: 'WIN11_HOST_PROOF_EXECUTABLE_NOT_FOUND',
  EXECUTABLE_NOT_FILE: 'WIN11_HOST_PROOF_EXECUTABLE_NOT_FILE',
  EXECUTABLE_METADATA_INVALID: 'WIN11_HOST_PROOF_EXECUTABLE_METADATA_INVALID',
  EXECUTABLE_SYMLINK: 'WIN11_HOST_PROOF_EXECUTABLE_SYMLINK_REJECTED',
  SYMLINK_REJECTED: 'WIN11_HOST_PROOF_EXECUTABLE_SYMLINK_REJECTED',
  EXECUTABLE_REPARSE: 'WIN11_HOST_PROOF_EXECUTABLE_REPARSE_REJECTED',
  REPARSE_REJECTED: 'WIN11_HOST_PROOF_EXECUTABLE_REPARSE_REJECTED',
  EXECUTABLE_NAME_INVALID: 'WIN11_HOST_PROOF_EXECUTABLE_NAME_INVALID',
  BASENAME_INVALID: 'WIN11_HOST_PROOF_EXECUTABLE_NAME_INVALID',
  EXECUTABLE_HASH_FAILED: 'WIN11_HOST_PROOF_EXECUTABLE_HASH_FAILED',
  HASH_FAILED: 'WIN11_HOST_PROOF_EXECUTABLE_HASH_FAILED',
  EXEC_FILE_INVALID: 'WIN11_HOST_PROOF_EXEC_FILE_INVALID',
  HOST_QUERY_FAILED: 'WIN11_HOST_PROOF_HOST_QUERY_FAILED',
  POWERSHELL_FAILED: 'WIN11_HOST_PROOF_HOST_QUERY_FAILED',
  HOST_OUTPUT_INVALID: 'WIN11_HOST_PROOF_HOST_OUTPUT_INVALID',
  HOST_RESULT_INVALID: 'WIN11_HOST_PROOF_HOST_OUTPUT_INVALID',
  HOST_NOT_WINDOWS_11: 'WIN11_HOST_PROOF_HOST_NOT_WINDOWS_11',
  NOT_WINDOWS_11: 'WIN11_HOST_PROOF_HOST_NOT_WINDOWS_11',
  HOST_NOT_X64: 'WIN11_HOST_PROOF_HOST_NOT_X64',
  NOT_X64: 'WIN11_HOST_PROOF_HOST_NOT_X64',
  HOST_BUILD_INVALID: 'WIN11_HOST_PROOF_HOST_BUILD_INVALID',
  BUILD_TOO_OLD: 'WIN11_HOST_PROOF_HOST_BUILD_INVALID'
};

export const WIN11_HOST_PROOF_ERRORS = Object.freeze(ERROR_CODES);
export const WIN11_HOST_PROOF_ERROR_CODES = WIN11_HOST_PROOF_ERRORS;

const POWERSHELL_OPTIONS = Object.freeze({
  windowsHide: true,
  timeout: WIN11_HOST_PROOF_POWERSHELL_TIMEOUT_MS,
  maxBuffer: 1024 * 1024
});

/**
 * The command returns only the host fields needed by the path-free evidence
 * contract. ProductName/CurrentBuildNumber are normalized from CIM here so
 * the parser can also accept the corresponding Get-ComputerInfo names.
 */
export const WIN11_HOST_PROOF_POWERSHELL_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$os = Get-CimInstance -ClassName Win32_OperatingSystem -Property Caption,BuildNumber,OSArchitecture,ProductType -ErrorAction Stop',
  '[PSCustomObject]@{ ProductName = [string]$os.Caption; CurrentBuildNumber = [string]$os.BuildNumber; OSArchitecture = [string]$os.OSArchitecture; ProductType = [int]$os.ProductType } | ConvertTo-Json -Compress'
].join('; ');

export class Win11HostProofError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Win11HostProofError';
    this.code = code;
    this.errors = Object.freeze([code]);
  }
}

function fail(code) {
  throw new Win11HostProofError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstField(value, names) {
  for (const name of names) {
    if (hasOwn(value, name)) return value[name];
  }
  return undefined;
}

function validateExecutablePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_PATH_INVALID);
  }
  if (basename(value) !== WIN11_HOST_PROOF_EXPECTED_EXE) {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_NAME_INVALID);
  }
  return value;
}

function fileOperation(options, name, defaultOperation) {
  const groups = [options];
  if (isRecord(options.fileSystem)) groups.push(options.fileSystem);
  if (isRecord(options.fs)) groups.push(options.fs);
  for (const group of groups) {
    if (hasOwn(group, name)) return group[name];
  }
  return defaultOperation;
}

function resolveFileOperations(options) {
  if (!isRecord(options)) fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  const operations = {
    lstat: fileOperation(options, 'lstat', defaultLstat),
    realpath: fileOperation(options, 'realpath', defaultRealpath),
    createReadStream: fileOperation(options, 'createReadStream', defaultCreateReadStream)
  };
  if (typeof operations.lstat !== 'function'
    || typeof operations.realpath !== 'function'
    || typeof operations.createReadStream !== 'function') {
    fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  }
  return operations;
}

function hasReparseMarker(stats) {
  if (stats.reparsePoint === true || stats.reparseTag !== undefined && stats.reparseTag !== null) return true;
  if (stats.isReparsePoint === true) return true;
  return typeof stats.isReparsePoint === 'function' && stats.isReparsePoint() === true;
}

function comparablePath(value) {
  return normalize(value)
    .replace(/^\\\\\?\\/u, '')
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US');
}

async function inspectExecutable(executablePath, operations, checkCanonicalPath) {
  let stats;
  try {
    stats = await operations.lstat(executablePath);
  } catch {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_NOT_FOUND);
  }

  if (!stats || typeof stats.isSymbolicLink !== 'function' || typeof stats.isFile !== 'function') {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_METADATA_INVALID);
  }
  if (stats.isSymbolicLink()) fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_SYMLINK);
  if (hasReparseMarker(stats)) fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_REPARSE);
  if (!stats.isFile()) fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_NOT_FILE);

  if (checkCanonicalPath) {
    let canonicalPath;
    try {
      canonicalPath = await operations.realpath(executablePath);
    } catch {
      fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_PATH_INVALID);
    }
    if (typeof canonicalPath !== 'string') fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_PATH_INVALID);
    if (comparablePath(canonicalPath) !== comparablePath(executablePath)) {
      let canonicalStats;
      try { canonicalStats = await operations.lstat(canonicalPath); }
      catch { fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_REPARSE); }
      const sameIdentity = typeof stats.dev === 'number' && typeof stats.ino === 'number'
        && stats.ino !== 0 && canonicalStats?.dev === stats.dev && canonicalStats?.ino === stats.ino;
      if (!sameIdentity) fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_REPARSE);
    }
  }
}

async function streamSha256(executablePath, createReadStream) {
  let stream;
  try {
    stream = createReadStream(executablePath);
  } catch {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_HASH_FAILED);
  }

  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_HASH_FAILED);
  }

  const hash = createHash('sha256');
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch {
    fail(WIN11_HOST_PROOF_ERRORS.EXECUTABLE_HASH_FAILED);
  }
  return hash.digest('hex').toLowerCase();
}

function executableArguments(pathOrOptions, maybeOptions) {
  if (typeof pathOrOptions === 'string') {
    return { executablePath: pathOrOptions, options: maybeOptions ?? {} };
  }
  if (isRecord(pathOrOptions)) {
    return {
      executablePath: pathOrOptions.executablePath ?? pathOrOptions.exePath ?? pathOrOptions.path,
      options: pathOrOptions
    };
  }
  return { executablePath: pathOrOptions, options: maybeOptions ?? {} };
}

/**
 * Lstats and streams the supplied packaged executable. The returned object is
 * deliberately path-free and only contains the basename and a verified,
 * lowercase SHA-256 digest.
 */
async function collectExecutableProofUnsafe(pathOrOptions, maybeOptions) {
  const { executablePath, options } = executableArguments(pathOrOptions, maybeOptions);
  const validPath = validateExecutablePath(executablePath);
  const operations = resolveFileOperations(options);
  const hasInjectedLstat = operations.lstat !== defaultLstat;
  const hasInjectedRealpath = operations.realpath !== defaultRealpath;
  await inspectExecutable(validPath, operations, !hasInjectedLstat || hasInjectedRealpath);
  const sha256 = await streamSha256(validPath, operations.createReadStream);
  return {
    basename: WIN11_HOST_PROOF_EXPECTED_EXE,
    sha256,
    sha256Verified: true
  };
}

export async function collectExecutableProof(pathOrOptions, maybeOptions) {
  try {
    return await collectExecutableProofUnsafe(pathOrOptions, maybeOptions);
  } catch (error) {
    if (error instanceof Win11HostProofError) throw error;
    fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  }
}

function parsePowerShellJson(result) {
  let stdout = isRecord(result) && hasOwn(result, 'stdout') ? result.stdout : result;
  if (Buffer.isBuffer(stdout)) stdout = stdout.toString('utf8');
  if (typeof stdout !== 'string') fail(WIN11_HOST_PROOF_ERRORS.HOST_OUTPUT_INVALID);
  try {
    return JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
  } catch {
    fail(WIN11_HOST_PROOF_ERRORS.HOST_OUTPUT_INVALID);
  }
}

function normalizeProductName(value) {
  return typeof value === 'string' && /^(?:microsoft\s+)?windows\s+11(?:\s|$)/iu.test(value.trim());
}

function normalizeX64(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, '');
  return normalized === 'x64'
    || normalized === 'amd64'
    || normalized === '64-bit'
    || normalized === '64bit'
    || normalized === '64';
}

function parseBuildNumber(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeHostProof(value) {
  if (!isRecord(value)) fail(WIN11_HOST_PROOF_ERRORS.HOST_OUTPUT_INVALID);

  const productName = firstField(value, [
    'ProductName',
    'WindowsProductName',
    'Caption',
    'productName',
    'windowsProductName',
    'caption'
  ]);
  if (productName === undefined) fail(WIN11_HOST_PROOF_ERRORS.HOST_OUTPUT_INVALID);
  if (!normalizeProductName(productName)) fail(WIN11_HOST_PROOF_ERRORS.HOST_NOT_WINDOWS_11);

  const productType = firstField(value, ['ProductType', 'productType']);
  if (productType !== 1) fail(WIN11_HOST_PROOF_ERRORS.HOST_NOT_WINDOWS_11);

  const architecture = firstField(value, [
    'OSArchitecture',
    'OsArchitecture',
    'Architecture',
    'osArchitecture',
    'architecture'
  ]);
  if (architecture === undefined) fail(WIN11_HOST_PROOF_ERRORS.HOST_OUTPUT_INVALID);
  if (!normalizeX64(architecture)) fail(WIN11_HOST_PROOF_ERRORS.HOST_NOT_X64);

  const build = parseBuildNumber(firstField(value, [
    'CurrentBuildNumber',
    'WindowsCurrentBuildNumber',
    'BuildNumber',
    'currentBuildNumber',
    'windowsCurrentBuildNumber',
    'buildNumber'
  ]));
  if (build === undefined || build < WIN11_HOST_PROOF_MIN_BUILD) {
    fail(WIN11_HOST_PROOF_ERRORS.HOST_BUILD_INVALID);
  }

  return {
    os: 'Windows 11',
    architecture: 'x64',
    buildNumber: build
  };
}

function hostOptions(value) {
  if (!isRecord(value)) fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  const runner = value.run ?? value.execFile ?? execFileAsync;
  if (typeof runner !== 'function') fail(WIN11_HOST_PROOF_ERRORS.EXEC_FILE_INVALID);
  return runner;
}

/** Queries Windows host state through an injectable PowerShell execFile runner. */
async function collectWindowsHostProofUnsafe(options = {}) {
  const runner = hostOptions(options);
  let result;
  try {
    result = await runner(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WIN11_HOST_PROOF_POWERSHELL_SCRIPT],
      POWERSHELL_OPTIONS
    );
  } catch {
    fail(WIN11_HOST_PROOF_ERRORS.HOST_QUERY_FAILED);
  }
  return normalizeHostProof(parsePowerShellJson(result));
}

export async function collectWindowsHostProof(options = {}) {
  try {
    return await collectWindowsHostProofUnsafe(options);
  } catch (error) {
    if (error instanceof Win11HostProofError) throw error;
    fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  }
}

function collectorArguments(pathOrOptions, maybeOptions) {
  if (typeof pathOrOptions === 'string') {
    return { executablePath: pathOrOptions, options: maybeOptions ?? {} };
  }
  if (isRecord(pathOrOptions)) {
    return {
      executablePath: pathOrOptions.executablePath ?? pathOrOptions.exePath ?? pathOrOptions.path,
      options: maybeOptions ?? pathOrOptions
    };
  }
  return { executablePath: pathOrOptions, options: maybeOptions ?? {} };
}

/** Collects the reusable host and executable proofs in builder-compatible shape. */
export async function collectWin11HostProof(pathOrOptions, maybeOptions) {
  const { executablePath, options } = collectorArguments(pathOrOptions, maybeOptions);
  const executable = await collectExecutableProof(executablePath, options);
  const host = await collectWindowsHostProof(options);
  return { host, executable };
}

export const collectHostProof = collectWindowsHostProof;
export const hashExecutable = collectExecutableProof;
export const collectWindows11HostProof = collectWin11HostProof;
export const collectWindows11HostEvidence = collectWin11HostProof;

export default collectWin11HostProof;

export async function runWin11HostProofCli(argv = process.argv.slice(2), options = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== '--host-only') {
    fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  }
  const write = options.write ?? (value => process.stdout.write(value));
  if (typeof write !== 'function') fail(WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT);
  const host = await collectWindowsHostProof(options);
  write(`${JSON.stringify(host)}\n`);
  return host;
}

const invokedPath = process.argv[1];
if (typeof invokedPath === 'string' && pathToFileURL(invokedPath).href === import.meta.url) {
  runWin11HostProofCli().catch(error => {
    const code = error instanceof Win11HostProofError ? error.code : WIN11_HOST_PROOF_ERRORS.INVALID_ARGUMENT;
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
