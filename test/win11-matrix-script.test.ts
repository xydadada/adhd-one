import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts', 'e2e', 'win11-matrix.ps1');

async function readMatrixScript(): Promise<string> {
  return readFile(scriptPath, 'utf8');
}

describe('Windows 11 path matrix script contract', () => {
  it('declares the three required inputs and strictly validates safe absolute paths', async () => {
    const script = await readMatrixScript();

    expect(script).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$SetupPath/u);
    expect(script).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$EvidenceRoot/u);
    expect(script).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$RepoRoot/u);
    expect(script).toContain('[IO.Path]::IsPathFullyQualified($Value)');
    expect(script).toContain('Test-Path -LiteralPath $setup');
    expect(script).toContain('Get-ExistingFile -Path $setup');
    expect(script).toContain("if (Test-Path -LiteralPath $evidenceRoot) { throw 'WIN11_MATRIX_EVIDENCE_MUST_BE_NEW' }");
    expect(script).toContain("Test-ChildPath -Candidate $evidenceRoot -Root $repoRoot");
    expect(script).toContain('[IO.Directory]::CreateDirectory($evidenceRoot)');
    expect(script).not.toMatch(/New-Item[^\r\n]*-LiteralPath/iu);
    expect(script).toContain('ReparsePoint');
    expect(script).toContain("PlatformID]::Win32NT");
    expect(script).toContain("Version.Build -lt 22000");
  });

  it('contains exactly four explicit matrix rows and the long-path target', async () => {
    const script = await readMatrixScript();
    const rowNames = [...script.matchAll(/Name\s*=\s*'([^']+)'/gu)].map(match => match[1]);

    expect(rowNames).toEqual(['ascii', '中文', '中文 空格', 'long-path']);
    expect(script).toContain("$targetInstallPathLength = 280");
    expect(script).toContain("'adhd-one-installed-' + $guidPlaceholder");
    expect(script).toContain("if ($installProbe.Length -lt 270 -or $installProbe.Length -gt 290)");
    expect(script).toContain("$runnerTemp = $longPrefix + ('x' * $paddingLength)");
    expect(script).toContain("Name = $definition.Name");
    expect(script).toContain('RUNNER_TEMP = [IO.Path]::GetFullPath($runnerTemp)');
    expect(script).toContain('TEMP = [IO.Path]::GetFullPath($temp)');
    expect(script).toContain('TMP = [IO.Path]::GetFullPath($tmp)');
    expect(script).toContain('Evidence = [IO.Path]::GetFullPath($evidence)');
    expect(script).toContain("Sort-Object -Unique");
    expect(script).toContain("$usedPaths -contains $path");
  });

  it('references only the existing installed and evidence verifier scripts', async () => {
    const script = await readMatrixScript();
    const installedCall = script.indexOf('& $installedScript -SetupPath $setup -EvidenceDirectory $row.Evidence');
    const verifierCall = script.indexOf('& node $verifyScript $row.Evidence');

    expect(script).toContain("Join-Path $repoRoot 'scripts/e2e/installed.ps1'");
    expect(script).toContain("Join-Path $repoRoot 'scripts/verify-evidence.mjs'");
    expect(installedCall).toBeGreaterThanOrEqual(0);
    expect(verifierCall).toBeGreaterThan(installedCall);
    expect(script).toContain("if (-not $?) { throw ('WIN11_MATRIX_INSTALLED_FAILED_{0}' -f $row.Name) }");
    expect(script).toContain("if ($LASTEXITCODE -ne 0) { throw ('WIN11_MATRIX_VERIFY_FAILED_{0}' -f $row.Name) }");
    expect(script).toContain('foreach ($row in $matrix)');
    expect(script).not.toMatch(/Start-(?:Job|ThreadJob)/iu);
    expect(script).not.toMatch(/ForEach-Object\s+-Parallel/iu);
    expect(script).not.toMatch(/npm\s+(?:run\s+)?(?:build|package)|electron-builder/iu);
  });

  it('restores all three environment variables in finally and does not perform an install in the test', async () => {
    const script = await readMatrixScript();
    const finallyStart = script.indexOf('\nfinally {');
    const finallyBlock = script.slice(finallyStart);

    expect(finallyStart).toBeGreaterThan(0);
    expect(script).toContain('$env:RUNNER_TEMP = $row.RUNNER_TEMP');
    expect(script).toContain('$env:TEMP = $row.TEMP');
    expect(script).toContain('$env:TMP = $row.TMP');
    expect(finallyBlock).toContain('Set-Item -LiteralPath ("Env:{0}" -f $name) -Value $saved.Value');
    expect(finallyBlock).toContain('Remove-Item -LiteralPath ("Env:{0}" -f $name)');
    expect(finallyBlock).toContain('Pop-Location');
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Push-Location -LiteralPath $repoRoot');

    // This test reads the script only; it intentionally never invokes pwsh, node, or the setup.
    expect(scriptPath.endsWith(path.join('scripts', 'e2e', 'win11-matrix.ps1'))).toBe(true);
  });
});
