#!/usr/bin/env node

import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const closureRoot = path.join(root, 'vendor', 'runtime-closure');
const compiledSmoke = path.join(root, 'out', 'runtime-staging-smoke.js');
const dshPackage = path.join(closureRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SAFE_CODE_PREFIXES = [
  'DSH_', 'HOST_', 'INVALID_', 'RUNTIME_', 'STALE_', 'SUPERVISOR_', 'WORKSPACE_'
];

function stableErrorCode(value) {
  const candidate = value && typeof value === 'object' && typeof value.code === 'string'
    ? value.code.toUpperCase()
    : undefined;
  if (candidate && SAFE_CODE_PATTERN.test(candidate) && SAFE_CODE_PREFIXES.some(prefix => candidate.startsWith(prefix))) {
    return candidate;
  }

  const message = value instanceof Error ? value.message : String(value ?? '');
  const codes = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu) ?? [];
  const trusted = codes.findLast(code => SAFE_CODE_PREFIXES.some(prefix => code.startsWith(prefix)));
  if (trusted && SAFE_CODE_PATTERN.test(trusted)) return trusted;
  if (/ENOENT|cannot find module|not found|missing/iu.test(message)) return 'RUNTIME_STAGING_INPUT_MISSING';
  if (/EACCES|EPERM|access denied|permission/iu.test(message)) return 'RUNTIME_STAGING_ACCESS_DENIED';
  if (/timeout|timed out/iu.test(message)) return 'RUNTIME_STAGING_TIMEOUT';
  return 'RUNTIME_STAGING_FAILED';
}

function volumeRoot(filename) {
  return path.parse(path.resolve(filename)).root.toLowerCase();
}

async function requireFile(filename, errorCode) {
  const info = await stat(filename).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) throw new Error(errorCode);
}

async function requireDirectory(directory, errorCode) {
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(errorCode);
}

async function createValidationRoot() {
  const sourceVolume = volumeRoot(closureRoot);
  const candidates = [os.tmpdir(), path.dirname(root)];
  const seen = new Set();
  for (const parent of candidates) {
    const resolvedParent = path.resolve(parent);
    if (seen.has(resolvedParent) || volumeRoot(resolvedParent) !== sourceVolume) continue;
    seen.add(resolvedParent);
    try {
      return await mkdtemp(path.join(resolvedParent, 'adhd-runtime-staging-'));
    } catch {
      // Try the next same-volume parent without exposing the OS error.
    }
  }
  throw new Error('RUNTIME_STAGING_TEMP_CREATE_FAILED');
}

async function readRuntimeVersion() {
  try {
    const value = JSON.parse(await readFile(dshPackage, 'utf8'));
    if (typeof value.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value.version)) {
      throw new Error('RUNTIME_STAGING_VERSION_INVALID');
    }
    return value.version;
  } catch (error) {
    if (error instanceof Error && error.message === 'RUNTIME_STAGING_VERSION_INVALID') throw error;
    throw new Error('RUNTIME_STAGING_VERSION_MISSING');
  }
}

async function removeValidationRoot(validationRoot) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await rm(validationRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      const stillExists = await stat(validationRoot).then(() => true, error => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      if (!stillExists) return;
    } catch {
      // Windows may release a runtime file only after its process exits.
    }
    await delay(200);
  }
  throw new Error('RUNTIME_STAGING_CLEANUP_FAILED');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('RUNTIME_STAGING_WINDOWS_ONLY');
  await requireFile(compiledSmoke, 'RUNTIME_STAGING_COMPILED_SMOKE_MISSING');
  await requireDirectory(closureRoot, 'RUNTIME_STAGING_CLOSURE_MISSING');
  const version = await readRuntimeVersion();

  const smokeModule = await import(pathToFileURL(compiledSmoke).href);
  if (typeof smokeModule.runRuntimeStagingSmoke !== 'function') {
    throw new Error('RUNTIME_STAGING_EXPORT_MISSING');
  }

  let validationRoot;
  let failure;
  let cleanupFailure;
  try {
    validationRoot = await createValidationRoot();
    await cp(closureRoot, path.join(validationRoot, 'slot-A'), {
      recursive: true,
      force: false,
      errorOnExist: true
    });
    await smokeModule.runRuntimeStagingSmoke({
      validationRoot,
      slot: 'A',
      version,
      appPath: root,
      resourcesPath: root,
      packaged: false
    });
  } catch (error) {
    failure = error;
  } finally {
    if (validationRoot) {
      try {
        await removeValidationRoot(validationRoot);
      } catch {
        cleanupFailure = new Error('RUNTIME_STAGING_CLEANUP_FAILED');
      }
    }
  }

  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'RUNTIME_STAGING_FAILED_WITH_CLEANUP');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  console.log(`RUNTIME_STAGING_OK slot=A version=${version}`);
}

try {
  await main();
} catch (error) {
  console.error(`RUNTIME_STAGING_FAILED:${stableErrorCode(error)}`);
  process.exitCode = 1;
}
