import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateWin11Evidence,
  verifyWin11EvidenceFile,
  WIN11_EVIDENCE_ERRORS as ERROR,
  WIN11_EVIDENCE_LIMITS as LIMITS,
  WIN11_EVIDENCE_SCHEMA_VERSION,
  WIN11_EVIDENCE_TOOL
} from '../scripts/e2e/verify-win11-evidence.mjs';

type JsonObject = Record<string, unknown>;

const roots: string[] = [];
const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/e2e/verify-win11-evidence.mjs');

function validEvidence(): JsonObject {
  return {
    schemaVersion: WIN11_EVIDENCE_SCHEMA_VERSION,
    tool: WIN11_EVIDENCE_TOOL,
    platform: {
      os: 'Windows 11',
      architecture: 'x64',
      buildNumber: 26100
    },
    executable: {
      name: 'ADHD One.exe',
      sha256: 'a'.repeat(64),
      sha256Verified: true
    },
    performance: {
      firstInteractiveMs: LIMITS.firstInteractiveMs,
      hotStartReadyMs: LIMITS.hotStartReadyMs,
      idleCpuPercent: 0.999,
      exitMs: LIMITS.exitMs
    },
    processes: {
      residualCount: 0
    }
  };
}

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('offline Windows 11 evidence verifier', () => {
  it('accepts the exact boundary values and returns no errors', () => {
    expect(validateWin11Evidence(validEvidence())).toEqual({ ok: true, errors: [] });
  });

  it('rejects extra fields at every schema level', () => {
    const topLevel = validEvidence();
    topLevel.extra = 'must be rejected';
    expect(validateWin11Evidence(topLevel).errors).toContain(ERROR.EXTRA_FIELD);

    const nested = validEvidence();
    (nested.performance as JsonObject).extra = 1;
    expect(validateWin11Evidence(nested).errors).toContain(ERROR.EXTRA_FIELD);
  });

  it('rejects paths and never returns the sensitive path in an error', () => {
    const evidence = validEvidence();
    (evidence.executable as JsonObject).name = 'C:\\Users\\Alice\\ADHD One.exe';
    const result = validateWin11Evidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(ERROR.SENSITIVE_PATH);
    expect(JSON.stringify(result)).not.toContain('Alice');
  });

  it('requires the packaged ADHD One executable name', () => {
    const evidence = validEvidence();
    (evidence.executable as JsonObject).name = 'payload.exe';
    expect(validateWin11Evidence(evidence)).toEqual({ ok: false, errors: [ERROR.EXECUTABLE_INVALID] });
  });

  it('requires Windows 11 x64 and an explicitly verified lowercase SHA-256 digest', () => {
    const platform = validEvidence();
    (platform.platform as JsonObject).os = 'Windows 10';
    (platform.platform as JsonObject).architecture = 'arm64';
    expect(validateWin11Evidence(platform).errors).toContain(ERROR.PLATFORM_INVALID);

    const build = validEvidence();
    (build.platform as JsonObject).buildNumber = 21999;
    expect(validateWin11Evidence(build).errors).toContain(ERROR.PLATFORM_BUILD_INVALID);

    const digest = validEvidence();
    const executable = digest.executable as JsonObject;
    executable.sha256 = 'A'.repeat(64);
    executable.sha256Verified = false;
    const result = validateWin11Evidence(digest);
    expect(result.errors).toContain(ERROR.SHA256_INVALID);
    expect(result.errors).toContain(ERROR.SHA256_UNVERIFIED);
  });

  it.each([
    ['firstInteractiveMs', LIMITS.firstInteractiveMs + 1, ERROR.FIRST_INTERACTION_TIMEOUT],
    ['hotStartReadyMs', LIMITS.hotStartReadyMs + 1, ERROR.HOT_START_TIMEOUT],
    ['idleCpuPercent', LIMITS.idleCpuPercentExclusive, ERROR.IDLE_CPU_LIMIT],
    ['exitMs', LIMITS.exitMs + 1, ERROR.EXIT_TIMEOUT]
  ] as const)('rejects a failed performance gate for %s', (field, value, error) => {
    const evidence = validEvidence();
    (evidence.performance as JsonObject)[field] = value;
    expect(validateWin11Evidence(evidence).errors).toContain(error);
  });

  it('rejects invalid metric types, negative values, and residual processes', () => {
    const evidence = validEvidence();
    const performance = evidence.performance as JsonObject;
    performance.firstInteractiveMs = -1;
    performance.idleCpuPercent = '0.5';
    (evidence.processes as JsonObject).residualCount = 1;
    const result = validateWin11Evidence(evidence);
    expect(result.errors).toContain(ERROR.PERFORMANCE_INVALID);
    expect(result.errors).toContain(ERROR.RESIDUAL_PROCESSES);
  });

  it('reads only the supplied JSON file and keeps CLI failures value-free', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'win11-evidence-'));
    roots.push(root);
    const validPath = path.join(root, 'valid.json');
    await writeFile(validPath, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    await expect(verifyWin11EvidenceFile(validPath)).resolves.toEqual({ ok: true, errors: [] });

    const cliPass = spawnSync(process.execPath, [scriptPath, validPath], { encoding: 'utf8' });
    expect(cliPass.status).toBe(0);
    expect(cliPass.stdout.trim()).toBe('PASS');
    expect(cliPass.stderr).toBe('');

    const invalidPath = path.join(root, 'invalid.json');
    await writeFile(invalidPath, JSON.stringify({
      ...validEvidence(),
      executable: {
        ...(validEvidence().executable as JsonObject),
        name: 'C:\\Users\\Alice\\ADHD One.exe'
      }
    }), 'utf8');
    const cliFail = spawnSync(process.execPath, [scriptPath, invalidPath], { encoding: 'utf8' });
    expect(cliFail.status).toBe(1);
    expect(`${cliFail.stdout}\n${cliFail.stderr}`).not.toContain('Alice');
    await expect(readFile(invalidPath, 'utf8')).resolves.toContain('Alice');
  });

  it('rejects duplicate JSON keys before parsing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'win11-evidence-'));
    roots.push(root);
    const filename = path.join(root, 'duplicate.json');
    const text = JSON.stringify(validEvidence()).replace(
      '"sha256Verified":true',
      '"sha256Verified":false,"sha256Verified":true'
    );
    await writeFile(filename, text, 'utf8');
    await expect(verifyWin11EvidenceFile(filename)).resolves.toEqual({
      ok: false,
      errors: [ERROR.JSON_INVALID]
    });
  });

  it('normalizes escaped duplicate keys but scopes names to each object', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'win11-evidence-'));
    roots.push(root);
    const escapedDuplicate = path.join(root, 'escaped-duplicate.json');
    const duplicateText = JSON.stringify(validEvidence()).replace(
      '"sha256Verified":true',
      '"sha256Verified":false,"\\u0073ha256Verified":true'
    );
    await writeFile(escapedDuplicate, duplicateText, 'utf8');
    await expect(verifyWin11EvidenceFile(escapedDuplicate)).resolves.toEqual({
      ok: false,
      errors: [ERROR.JSON_INVALID]
    });

    const repeatedAcrossObjects = path.join(root, 'repeated-across-objects.json');
    const evidence = validEvidence();
    (evidence.platform as JsonObject).shared = 1;
    (evidence.executable as JsonObject).shared = 2;
    await writeFile(repeatedAcrossObjects, JSON.stringify(evidence), 'utf8');
    const result = await verifyWin11EvidenceFile(repeatedAcrossObjects);
    expect(result.errors).toEqual([ERROR.EXTRA_FIELD]);
  });

  it('does not accept a self-reported pass field or a path-like unknown field', () => {
    const evidence = clone(validEvidence());
    evidence.passed = true;
    evidence.exePath = 'C:\\Users\\Alice\\ADHD One.exe';
    const result = validateWin11Evidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([ERROR.EXTRA_FIELD]);
    expect(JSON.stringify(result)).not.toMatch(/Alice|ADHD One/iu);
  });

  it('rejects non-enumerable and symbol extra fields for direct object callers', () => {
    const hidden = validEvidence();
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    expect(validateWin11Evidence(hidden).errors).toContain(ERROR.EXTRA_FIELD);

    const symbolic = validEvidence();
    Object.defineProperty(symbolic, Symbol('hidden'), { value: true, enumerable: false });
    expect(validateWin11Evidence(symbolic).errors).toContain(ERROR.EXTRA_FIELD);
  });
});
