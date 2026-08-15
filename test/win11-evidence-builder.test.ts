import { describe, expect, it } from 'vitest';
import {
  buildWin11Evidence,
  Win11EvidenceBuilderError
} from '../scripts/e2e/win11-evidence-builder.mjs';
import {
  validateWin11Evidence,
  WIN11_EVIDENCE_ERRORS as ERROR,
  WIN11_EVIDENCE_LIMITS as LIMITS,
  WIN11_EVIDENCE_SCHEMA_VERSION,
  WIN11_EVIDENCE_TOOL
} from '../scripts/e2e/verify-win11-evidence.mjs';

type JsonObject = Record<string, unknown>;
type BuilderError = Error & { code?: string; errors?: readonly string[] };

function validInput(): JsonObject {
  return {
    host: {
      os: 'Windows 11',
      architecture: 'x64',
      buildNumber: 22_000
    },
    executable: {
      basename: 'ADHD One.exe',
      sha256: 'a'.repeat(64),
      sha256Verified: true
    },
    firstInteractiveMs: LIMITS.firstInteractiveMs,
    hotStartReadyMs: LIMITS.hotStartReadyMs,
    idleCpuPercent: 0.999,
    exitMs: LIMITS.exitMs,
    residualProcesses: 0
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectRejected(input: unknown, ...codes: string[]): BuilderError {
  try {
    buildWin11Evidence(input);
  } catch (error) {
    expect(error).toBeInstanceOf(Win11EvidenceBuilderError);
    const builderError = error as BuilderError;
    expect(builderError.errors).toEqual(expect.arrayContaining(codes));
    return builderError;
  }
  throw new Error('Expected buildWin11Evidence to reject input');
}

describe('Windows 11 evidence builder', () => {
  it('builds the exact verifier shape from verified, path-free inputs', () => {
    const input = validInput();
    const evidence = buildWin11Evidence(input);

    expect(evidence).toEqual({
      schemaVersion: WIN11_EVIDENCE_SCHEMA_VERSION,
      tool: WIN11_EVIDENCE_TOOL,
      platform: {
        os: 'Windows 11',
        architecture: 'x64',
        buildNumber: 22_000
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
    });
    expect(validateWin11Evidence(evidence)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(evidence)).not.toMatch(/[\\/]|[A-Za-z]:/u);
  });

  it('accepts exact performance boundaries and an empty residual-process list', () => {
    const input = validInput();
    input.residualProcesses = [];

    const evidence = buildWin11Evidence(input);

    expect(evidence.performance).toEqual({
      firstInteractiveMs: 15_000,
      hotStartReadyMs: 8_000,
      idleCpuPercent: 0.999,
      exitMs: 5_000
    });
    expect(evidence.processes).toEqual({ residualCount: 0 });
  });

  it('does not mutate input or retain input object references', () => {
    const input = validInput();
    const before = clone(input);
    const evidence = buildWin11Evidence(input);

    expect(input).toEqual(before);
    expect(evidence.platform).not.toBe(input.host);
    expect(evidence.executable).not.toBe(input.executable);
    expect(evidence.performance).not.toBe(input);

    (evidence.platform as JsonObject).buildNumber = 22_001;
    expect((input.host as JsonObject).buildNumber).toBe(22_000);
  });

  it('rejects extra fields at the root and nested input levels', () => {
    const rootExtra = validInput();
    rootExtra.extra = true;
    expectRejected(rootExtra, ERROR.EXTRA_FIELD);

    const hostExtra = validInput();
    (hostExtra.host as JsonObject).extra = true;
    expectRejected(hostExtra, ERROR.EXTRA_FIELD);

    const executableExtra = validInput();
    (executableExtra.executable as JsonObject).path = 'C:\\Users\\Alice\\ADHD One.exe';
    const error = expectRejected(executableExtra, ERROR.EXTRA_FIELD);
    expect(JSON.stringify(error)).not.toMatch(/Alice|ADHD One/iu);
  });

  it('rejects accessors and proxies without leaking thrown values', () => {
    const accessor = validInput();
    Object.defineProperty(accessor, 'host', {
      enumerable: true,
      get: () => { throw new Error('SECRET_GETTER_VALUE'); }
    });
    expect(() => buildWin11Evidence(accessor)).toThrowError(expect.objectContaining({
      code: ERROR.INVALID_ARGUMENT
    }));

    const proxy = new Proxy(validInput(), {
      ownKeys: () => { throw new Error('SECRET_PROXY_VALUE'); }
    });
    try {
      buildWin11Evidence(proxy);
      throw new Error('expected proxy to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR.INVALID_ARGUMENT });
      expect(String(error)).not.toContain('SECRET_');
    }
  });

  it('rejects non-Windows 11 x64 hosts and builds below 22000', () => {
    const os = validInput();
    (os.host as JsonObject).os = 'Windows 10';
    (os.host as JsonObject).architecture = 'arm64';
    expectRejected(os, ERROR.PLATFORM_INVALID);

    const build = validInput();
    (build.host as JsonObject).buildNumber = 21_999;
    expectRejected(build, ERROR.PLATFORM_BUILD_INVALID);
  });

  it('requires a basename and never emits an executable path', () => {
    const path = validInput();
    (path.executable as JsonObject).basename = 'C:\\Users\\Alice\\ADHD One.exe';
    const error = expectRejected(path, ERROR.SENSITIVE_PATH);
    expect(JSON.stringify(error)).not.toMatch(/Alice|ADHD One/iu);

    const traversal = validInput();
    (traversal.executable as JsonObject).basename = '../ADHD One.exe';
    expectRejected(traversal, ERROR.SENSITIVE_PATH);
  });

  it('requires a lowercase, verified SHA-256 digest', () => {
    const uppercase = validInput();
    (uppercase.executable as JsonObject).sha256 = 'A'.repeat(64);
    expectRejected(uppercase, ERROR.SHA256_INVALID);

    const unverified = validInput();
    (unverified.executable as JsonObject).sha256Verified = false;
    expectRejected(unverified, ERROR.SHA256_UNVERIFIED);

    const malformed = validInput();
    (malformed.executable as JsonObject).sha256 = 'not-a-digest';
    expectRejected(malformed, ERROR.SHA256_INVALID);
  });

  it.each([
    ['firstInteractiveMs', Number.NaN],
    ['firstInteractiveMs', Number.POSITIVE_INFINITY],
    ['hotStartReadyMs', Number.NEGATIVE_INFINITY],
    ['idleCpuPercent', Number.NaN],
    ['idleCpuPercent', Number.POSITIVE_INFINITY],
    ['exitMs', Number.NEGATIVE_INFINITY]
  ] as const)('rejects non-finite metric %s=%s', (field, value) => {
    const input = validInput();
    input[field] = value;
    expectRejected(input, ERROR.PERFORMANCE_INVALID);
  });

  it.each([
    ['firstInteractiveMs', -1, ERROR.PERFORMANCE_INVALID],
    ['hotStartReadyMs', 8_001, ERROR.HOT_START_TIMEOUT],
    ['idleCpuPercent', 1, ERROR.IDLE_CPU_LIMIT],
    ['exitMs', 5_001, ERROR.EXIT_TIMEOUT]
  ] as const)('rejects metric %s=%s when it cannot pass the verifier', (field, value, error) => {
    const input = validInput();
    input[field] = value;
    expectRejected(input, error);
  });

  it('rejects residual processes and never copies their values into errors or output', () => {
    const input = validInput();
    input.residualProcesses = ['C:\\Users\\Alice\\ADHD One.exe'];
    const error = expectRejected(input, ERROR.RESIDUAL_PROCESSES);

    expect(JSON.stringify(error)).not.toMatch(/Alice|ADHD One/iu);
    expect(JSON.stringify(error)).not.toContain('C:\\');
  });

  it('rejects malformed root, missing fields, and wrong executable input names', () => {
    expectRejected(null, ERROR.ROOT_INVALID);

    const missing = validInput();
    delete missing.exitMs;
    expectRejected(missing, ERROR.REQUIRED_FIELD_MISSING);

    const wrongName = validInput();
    const executable = wrongName.executable as JsonObject;
    executable.name = executable.basename;
    delete executable.basename;
    expectRejected(wrongName, ERROR.EXTRA_FIELD, ERROR.REQUIRED_FIELD_MISSING);
  });
});
