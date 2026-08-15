[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SetupPath,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot,
  [Parameter(Mandatory = $true)][string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function ConvertTo-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$ErrorCode
  )

  if ([string]::IsNullOrWhiteSpace($Value)) { throw $ErrorCode }

  $isFullyQualified = $false
  try {
    $isFullyQualified = [IO.Path]::IsPathFullyQualified($Value)
  } catch {
    $isFullyQualified = $Value -match '^(?:[A-Za-z]:[\\/]|\\\\)'
  }
  if (-not $isFullyQualified) { throw $ErrorCode }

  try {
    return [IO.Path]::GetFullPath($Value)
  } catch {
    throw $ErrorCode
  }
}

function Get-ExistingDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ErrorCode
  )

  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    throw $ErrorCode
  }
  if (-not $item.PSIsContainer) { throw $ErrorCode }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ErrorCode }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Get-ExistingFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ErrorCode
  )

  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    throw $ErrorCode
  }
  if ($item.PSIsContainer) { throw $ErrorCode }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $ErrorCode }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Test-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $normalizedRoot = $Root.TrimEnd('\')
  $prefix = $normalizedRoot + [IO.Path]::DirectorySeparatorChar
  return $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ErrorCode
  )

  try {
    $cursor = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while ($null -ne $cursor) {
      if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw $ErrorCode
      }
      if ([IO.Path]::GetFullPath($cursor.FullName).TrimEnd('\') -ieq $Root.TrimEnd('\')) {
        return
      }
      $cursor = $cursor.Parent
    }
  } catch {
    if ([string]$_.Exception.Message -eq $ErrorCode) { throw }
    throw $ErrorCode
  }
  throw $ErrorCode
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    [Environment]::OSVersion.Version.Major -ne 10 -or
    [Environment]::OSVersion.Version.Build -lt 22000) {
  throw 'WIN11_MATRIX_WINDOWS_REQUIRED'
}

$setup = ConvertTo-AbsolutePath -Value $SetupPath -ErrorCode 'WIN11_MATRIX_SETUP_NOT_ABSOLUTE'
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'WIN11_MATRIX_SETUP_INVALID' }
$setup = Get-ExistingFile -Path $setup -ErrorCode 'WIN11_MATRIX_SETUP_INVALID'

$repoRoot = ConvertTo-AbsolutePath -Value $RepoRoot -ErrorCode 'WIN11_MATRIX_REPO_NOT_ABSOLUTE'
$repoRoot = Get-ExistingDirectory -Path $repoRoot -ErrorCode 'WIN11_MATRIX_REPO_INVALID'

$installedScript = Get-ExistingFile `
  -Path (Join-Path $repoRoot 'scripts/e2e/installed.ps1') `
  -ErrorCode 'WIN11_MATRIX_INSTALLED_SCRIPT_MISSING'
$nodePath = Get-ExistingFile `
  -Path (Join-Path $repoRoot 'node.exe') `
  -ErrorCode 'WIN11_MATRIX_NODE_MISSING'
$hostProofScript = Get-ExistingFile `
  -Path (Join-Path $repoRoot 'scripts/e2e/win11-host-proof.mjs') `
  -ErrorCode 'WIN11_MATRIX_HOST_PROOF_MISSING'

$hostProofOutput = & $nodePath $hostProofScript --host-only
if ($LASTEXITCODE -ne 0) { throw 'WIN11_MATRIX_HOST_PROOF_FAILED' }
try {
  $hostProof = $hostProofOutput | ConvertFrom-Json
} catch {
  throw 'WIN11_MATRIX_HOST_PROOF_INVALID'
}
if ($hostProof.os -ne 'Windows 11' -or
    $hostProof.architecture -ne 'x64' -or
    $hostProof.buildNumber -lt 22000) {
  throw 'WIN11_MATRIX_HOST_PROOF_INVALID'
}

$evidenceRoot = ConvertTo-AbsolutePath -Value $EvidenceRoot -ErrorCode 'WIN11_MATRIX_EVIDENCE_NOT_ABSOLUTE'
if (Test-Path -LiteralPath $evidenceRoot) { throw 'WIN11_MATRIX_EVIDENCE_MUST_BE_NEW' }
if (-not (Test-ChildPath -Candidate $evidenceRoot -Root $repoRoot)) {
  throw 'WIN11_MATRIX_EVIDENCE_OUTSIDE_REPO'
}

$repoPrefix = $repoRoot.TrimEnd('\\') + [IO.Path]::DirectorySeparatorChar
$relativeEvidencePath = $evidenceRoot.Substring($repoPrefix.Length)
$relativeEvidenceParts = @($relativeEvidencePath -split '[\\/]' | Where-Object {
  -not [string]::IsNullOrEmpty($_)
})
if ($relativeEvidenceParts.Count -eq 0) { throw 'WIN11_MATRIX_EVIDENCE_OUTSIDE_REPO' }

$cursor = $repoRoot
for ($index = 0; $index -lt $relativeEvidenceParts.Count; $index++) {
  $part = $relativeEvidenceParts[$index]
  $next = Join-Path $cursor $part
  $isFinal = $index -eq ($relativeEvidenceParts.Count - 1)
  if (Test-Path -LiteralPath $next) {
    if ($isFinal) { throw 'WIN11_MATRIX_EVIDENCE_MUST_BE_NEW' }
    $cursor = Get-ExistingDirectory -Path $next -ErrorCode 'WIN11_MATRIX_EVIDENCE_PARENT_INVALID'
    continue
  }

  if ($isFinal) {
    [IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
  } else {
    [IO.Directory]::CreateDirectory($next) | Out-Null
  }
  $cursor = Get-ExistingDirectory -Path $next -ErrorCode 'WIN11_MATRIX_EVIDENCE_CREATE_FAILED'
}

$evidenceRoot = Get-ExistingDirectory -Path $evidenceRoot -ErrorCode 'WIN11_MATRIX_EVIDENCE_CREATE_FAILED'
if (-not (Test-ChildPath -Candidate $evidenceRoot -Root $repoRoot)) {
  throw 'WIN11_MATRIX_EVIDENCE_OUTSIDE_REPO'
}
Assert-NoReparsePath -Path $evidenceRoot -Root $repoRoot -ErrorCode 'WIN11_MATRIX_EVIDENCE_UNSAFE'

$targetInstallPathLength = 280
$guidPlaceholder = '0' * 32
$installPathSuffix = [IO.Path]::DirectorySeparatorChar +
  'adhd-one-installed-' + $guidPlaceholder +
  [IO.Path]::DirectorySeparatorChar + 'install'
$matrixDefinitions = @(
  [pscustomobject]@{ Name = 'ascii'; LongPath = $false }
  [pscustomobject]@{ Name = '中文'; LongPath = $false }
  [pscustomobject]@{ Name = '中文 空格'; LongPath = $false }
  [pscustomobject]@{ Name = 'long-path'; LongPath = $true }
)

$usedPaths = @()
$matrix = foreach ($definition in $matrixDefinitions) {
  $rowRoot = Join-Path $evidenceRoot $definition.Name
  if (Test-Path -LiteralPath $rowRoot) { throw 'WIN11_MATRIX_ROW_MUST_BE_NEW' }
  [IO.Directory]::CreateDirectory($rowRoot) | Out-Null

  $runnerTemp = Join-Path $rowRoot 'runner-temp'
  if ($definition.LongPath) {
    $longPrefix = Join-Path $rowRoot 'long-'
    $paddingLength = $targetInstallPathLength - ($longPrefix.Length + $installPathSuffix.Length)
    if ($paddingLength -lt 1 -or $paddingLength -gt 220) {
      throw 'WIN11_MATRIX_LONG_PATH_CANNOT_BE_BUILT'
    }
    $runnerTemp = $longPrefix + ('x' * $paddingLength)
    $installProbe = $runnerTemp + $installPathSuffix
    if ($installProbe.Length -ne $targetInstallPathLength) {
      throw 'WIN11_MATRIX_LONG_PATH_INVALID'
    }
  }

  $temp = Join-Path $rowRoot 'temp'
  $tmp = Join-Path $rowRoot 'tmp'
  $evidence = Join-Path $rowRoot 'evidence'
  $rowPaths = @($runnerTemp, $temp, $tmp, $evidence)
  if (@($rowPaths | Sort-Object -Unique).Count -ne 4) {
    throw 'WIN11_MATRIX_ROW_PATHS_NOT_UNIQUE'
  }
  foreach ($path in $rowPaths) {
    if ($usedPaths -contains $path) { throw 'WIN11_MATRIX_PATHS_NOT_UNIQUE' }
    $usedPaths += $path
    [IO.Directory]::CreateDirectory($path) | Out-Null
  }

  [pscustomobject]@{
    Name = $definition.Name
    RUNNER_TEMP = [IO.Path]::GetFullPath($runnerTemp)
    TEMP = [IO.Path]::GetFullPath($temp)
    TMP = [IO.Path]::GetFullPath($tmp)
    Evidence = [IO.Path]::GetFullPath($evidence)
  }
}

$environmentNames = @('RUNNER_TEMP', 'TEMP', 'TMP')
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $existing = Get-Item -LiteralPath ("Env:{0}" -f $name) -ErrorAction SilentlyContinue
  $present = $null -ne $existing
  $value = $null
  if ($present) { $value = [string]$existing.Value }
  $savedEnvironment[$name] = @{ Present = $present; Value = $value }
}

$locationPushed = $false
try {
  Push-Location -LiteralPath $repoRoot
  $locationPushed = $true

  foreach ($row in $matrix) {
    $env:RUNNER_TEMP = $row.RUNNER_TEMP
    $env:TEMP = $row.TEMP
    $env:TMP = $row.TMP

    & $installedScript -SetupPath $setup -EvidenceDirectory $row.Evidence -NodePath $nodePath -Suite qualification
    if (-not $?) { throw ('WIN11_MATRIX_INSTALLED_FAILED_{0}' -f $row.Name) }

    $qualificationPath = Join-Path $row.Evidence 'qualification-evidence.json'
    $installedSummaryPath = Join-Path $row.Evidence 'installed-summary.json'
    try {
      $qualification = Get-Content -LiteralPath $qualificationPath -Raw -Encoding utf8 | ConvertFrom-Json
      $installedSummary = Get-Content -LiteralPath $installedSummaryPath -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
      throw ('WIN11_MATRIX_EVIDENCE_INVALID_{0}' -f $row.Name)
    }
    if ($qualification.schemaVersion -ne 1 -or
        $qualification.tool -ne 'adhd-one-packaged-qualification' -or
        $qualification.passed -ne $true -or
        $qualification.cyclesRequested -ne 1 -or
        $qualification.cyclesCompleted -ne 1 -or
        $installedSummary.tool -ne 'adhd-one-installed-e2e' -or
        $installedSummary.passed -ne $true) {
      throw ('WIN11_MATRIX_VERIFY_FAILED_{0}' -f $row.Name)
    }
  }
}
finally {
  foreach ($name in $environmentNames) {
    $saved = $savedEnvironment[$name]
    if ($saved.Present) {
      Set-Item -LiteralPath ("Env:{0}" -f $name) -Value $saved.Value
    } else {
      Remove-Item -LiteralPath ("Env:{0}" -f $name) -ErrorAction SilentlyContinue
    }
  }
  if ($locationPushed) { Pop-Location }
}

Write-Output ('PASS Windows 11 path matrix: {0} rows' -f $matrix.Count)
