import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectExecutableProof,
  collectWin11HostProof,
  collectWindowsHostProof,
  WIN11_HOST_PROOF_ERRORS as ERROR,
  WIN11_HOST_PROOF_EXPECTED_EXE,
  WIN11_HOST_PROOF_POWERSHELL_SCRIPT,
  Win11HostProofError
} from '../scripts/e2e/win11-host-proof.mjs';

type ProofError = Error & { code?: string; errors?: readonly string[] };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function expectedSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function makeExecutable(content = 'temporary ADHD One executable fixture\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'win11-host-proof-'));
  roots.push(root);
  const executablePath = path.join(root, WIN11_HOST_PROOF_EXPECTED_EXE);
  await writeFile(executablePath, content, 'utf8');
  return executablePath;
}

describe('Windows 11 host and executable proof collector', () => {
  it('streams a real temporary executable and returns only basename plus verified lowercase digest', async () => {
    const content = 'small executable fixture';
    const executablePath = await makeExecutable(content);

    await expect(collectExecutableProof(executablePath)).resolves.toEqual({
      basename: WIN11_HOST_PROOF_EXPECTED_EXE,
      sha256: expectedSha256(content),
      sha256Verified: true
    });
    const proof = await collectExecutableProof(executablePath);
    expect(JSON.stringify(proof)).not.toContain(executablePath);
    expect(proof.sha256).toBe(proof.sha256.toLowerCase());
  });

  it('rejects relative, missing, wrong-name, directory, symlink, and reparse-risk paths', async () => {
    await expect(collectExecutableProof('ADHD One.exe')).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_PATH_INVALID
    });

    const missing = path.join(os.tmpdir(), 'win11-host-proof-missing', WIN11_HOST_PROOF_EXPECTED_EXE);
    await expect(collectExecutableProof(missing)).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_NOT_FOUND
    });

    const wrongName = path.join(os.tmpdir(), 'not-adhd-one.exe');
    await expect(collectExecutableProof(wrongName)).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_NAME_INVALID
    });

    const executablePath = await makeExecutable();
    const directory = path.dirname(executablePath);
    await expect(collectExecutableProof(directory)).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_NAME_INVALID
    });

    const symlinkLstat = vi.fn().mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => false
    });
    await expect(collectExecutableProof(executablePath, { lstat: symlinkLstat })).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_SYMLINK
    });

    const reparseLstat = vi.fn().mockResolvedValue({
      isSymbolicLink: () => false,
      isFile: () => true,
      isReparsePoint: () => true
    });
    await expect(collectExecutableProof(executablePath, { lstat: reparseLstat })).rejects.toMatchObject({
      code: ERROR.EXECUTABLE_REPARSE
    });
  });

  it('uses an injected PowerShell/CIM runner and normalizes the host to strict Windows 11 x64', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ProductName: 'Microsoft Windows 11 Pro',
        CurrentBuildNumber: '22000',
        OSArchitecture: '64-bit',
        ProductType: 1
      })
    });

    await expect(collectWindowsHostProof({ execFile: run })).resolves.toEqual({
      os: 'Windows 11',
      architecture: 'x64',
      buildNumber: 22_000
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe('powershell.exe');
    expect(run.mock.calls[0]?.[1]).toEqual(['-NoProfile', '-NonInteractive', '-Command', WIN11_HOST_PROOF_POWERSHELL_SCRIPT]);
    expect(run.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 15_000 });
  });

  it('accepts Get-ComputerInfo field names but never copies raw host output', async () => {
    const secretPath = 'C:\\Users\\Alice\\private\\ADHD One.exe';
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        WindowsProductName: 'Windows 11 Home',
        WindowsCurrentBuildNumber: 26100,
        OsArchitecture: 'AMD64',
        ProductType: 1,
        SecretPath: secretPath
      })
    });

    const host = await collectWindowsHostProof({ run });
    expect(host).toEqual({ os: 'Windows 11', architecture: 'x64', buildNumber: 26_100 });
    expect(JSON.stringify(host)).not.toContain('Alice');
  });

  it.each([
    [{ ProductName: 'Microsoft Windows 10 Pro', CurrentBuildNumber: 26100, OSArchitecture: '64-bit', ProductType: 1 }, ERROR.HOST_NOT_WINDOWS_11],
    [{ ProductName: 'Windows 11 Pro', CurrentBuildNumber: 26100, OSArchitecture: 'ARM64', ProductType: 1 }, ERROR.HOST_NOT_X64],
    [{ ProductName: 'Windows 11 Pro', CurrentBuildNumber: 21_999, OSArchitecture: 'x64', ProductType: 1 }, ERROR.HOST_BUILD_INVALID],
    [{ ProductName: 'Windows 11 Pro', CurrentBuildNumber: 'not-a-build', OSArchitecture: 'x64', ProductType: 1 }, ERROR.HOST_BUILD_INVALID],
    [{ ProductName: 'Windows 11 Pro', CurrentBuildNumber: 26100, OSArchitecture: 'x64', ProductType: 3 }, ERROR.HOST_NOT_WINDOWS_11]
  ] as const)('rejects host that cannot prove Windows 11 x64 build >= 22000', async (value, code) => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(value) });
    await expect(collectWindowsHostProof({ execFile: run })).rejects.toMatchObject({ code });
  });

  it('maps command and JSON failures to stable value-free errors', async () => {
    const secretPath = 'C:\\Users\\Alice\\private\\ADHD One.exe';
    const commandError = vi.fn().mockRejectedValue(new Error(`CIM failed at ${secretPath}`));
    const rejected = await collectWindowsHostProof({ execFile: commandError }).catch(error => error as ProofError);
    expect(rejected).toBeInstanceOf(Win11HostProofError);
    expect(rejected.code).toBe(ERROR.HOST_QUERY_FAILED);
    expect(JSON.stringify(rejected)).not.toContain('Alice');

    const invalidJson = vi.fn().mockResolvedValue({ stdout: `not json ${secretPath}` });
    const invalid = await collectWindowsHostProof({ execFile: invalidJson }).catch(error => error as ProofError);
    expect(invalid.code).toBe(ERROR.HOST_OUTPUT_INVALID);
    expect(JSON.stringify(invalid)).not.toContain('Alice');
  });

  it('maps hostile option getters to a stable value-free error', async () => {
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, 'run', {
      enumerable: true,
      get: () => { throw new Error('C:\\Users\\Alice\\secret'); }
    });
    const error = await collectWindowsHostProof(options).catch(value => value as ProofError);
    expect(error.code).toBe(ERROR.INVALID_ARGUMENT);
    expect(String(error)).not.toContain('Alice');
  });

  it('combines the two proofs with no absolute path and never invokes real CIM in the test', async () => {
    const executablePath = await makeExecutable('combined proof fixture');
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ProductName: 'Windows 11 Pro', CurrentBuildNumber: 22621, OSArchitecture: 'x64', ProductType: 1 })
    });

    const proof = await collectWin11HostProof({ executablePath, execFile: run });
    expect(proof).toEqual({
      host: { os: 'Windows 11', architecture: 'x64', buildNumber: 22_621 },
      executable: {
        basename: WIN11_HOST_PROOF_EXPECTED_EXE,
        sha256: expectedSha256('combined proof fixture'),
        sha256Verified: true
      }
    });
    expect(JSON.stringify(proof)).not.toContain(executablePath);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not expose input values in validation errors', async () => {
    const secretPath = 'C:\\Users\\Alice\\private\\not-adhd.exe';
    const error = await collectExecutableProof(secretPath).catch(value => value as ProofError);
    expect(error).toBeInstanceOf(Win11HostProofError);
    expect(error.code).toBe(ERROR.EXECUTABLE_NAME_INVALID);
    expect(error.errors).toEqual([ERROR.EXECUTABLE_NAME_INVALID]);
    expect(JSON.stringify(error)).not.toMatch(/Alice|not-adhd/iu);
  });
});
