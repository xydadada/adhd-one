param(
  [Parameter(Mandatory = $true)][string]$SetupPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
$setup = [IO.Path]::GetFullPath($SetupPath)
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'INSTALLED_E2E_SETUP_MISSING' }

$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$runRoot = Join-Path $tempRoot ('adhd-one-installed-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $runRoot 'install'
if ($installRoot -match '\s') { throw 'INSTALLED_E2E_UNSAFE_NSiS_PATH' }
New-Item -ItemType Directory -Path $runRoot,$evidence -Force | Out-Null

function Get-AdhdUninstallRecords {
  foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
      $value = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      if ($null -ne $value -and [string]$value.DisplayName -like 'ADHD One*') {
        [pscustomobject]@{
          Key = $key.PSPath
          InstallLocation = [string]$value.InstallLocation
          QuietUninstallString = [string]$value.QuietUninstallString
        }
      }
    }
  }
}

function Get-InstallProcesses([string]$Root) {
  $prefix = ([IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)) { return $false }
    ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-InstallMarkers([string]$Root) {
  $expected = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
  foreach ($key in @(Get-ChildItem -LiteralPath 'HKCU:\Software' -ErrorAction Stop)) {
    $value = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
    if ($value.PSObject.Properties.Name -contains 'InstallLocation' -and [string]$value.InstallLocation -and
        ([IO.Path]::GetFullPath([string]$value.InstallLocation)).TrimEnd('\') -ieq $expected) { $key.PSPath }
  }
}

$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$appData = [Environment]::GetFolderPath('ApplicationData')
if ([string]::IsNullOrWhiteSpace($desktop) -or [string]::IsNullOrWhiteSpace($appData)) {
  throw 'INSTALLED_E2E_SHELL_FOLDER_UNAVAILABLE'
}
$shortcuts = @(
  (Join-Path $desktop 'ADHD One.lnk'),
  (Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\ADHD One.lnk'),
  (Join-Path $desktop 'Awesome DeepSeek Harness Desktop.lnk'),
  (Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Awesome DeepSeek Harness Desktop.lnk')
)
$expectedShortcuts = @($shortcuts[0], $shortcuts[1])
$legacyShortcuts = @($shortcuts[2], $shortcuts[3])
$primaryFailure = $null
$primaryCode = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$uninstaller = $null
$installStarted = $false
$installCompleted = $false
$suitePassed = $false
$uninstallAttempted = $false
$uninstallSucceeded = $false
$installDirectoryRemoved = $false
$processClean = $false
$registryClean = $false
$shortcutsClean = $false
$shortcutsCreated = $false
$uninstallExitCode = $null
try {
  if (@(Get-AdhdUninstallRecords).Count -ne 0) { throw 'INSTALLED_E2E_PREEXISTING_INSTALL' }
  if (@($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) { throw 'INSTALLED_E2E_PREEXISTING_SHORTCUT' }
  $installStarted = $true
  $install = Start-Process -FilePath $setup -ArgumentList @('/S', '/currentuser', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw 'INSTALLED_E2E_INSTALL_FAILED' }
  $installCompleted = $true

  $apps = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'ADHD One.exe')
  $uninstallers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'Uninstall ADHD One.exe')
  if ($apps.Count -ne 1 -or $uninstallers.Count -ne 1) { throw 'INSTALLED_E2E_LAYOUT_INVALID' }
  $uninstaller = $uninstallers[0].FullName
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'resources\dsh-runtime') -PathType Container)) {
    throw 'INSTALLED_E2E_RUNTIME_NOT_EXPANDED'
  }
  if (Test-Path -LiteralPath (Join-Path $installRoot 'resources\dsh-runtime.7z')) {
    throw 'INSTALLED_E2E_RUNTIME_ARCHIVE_REMAINED'
  }
  $records = @(Get-AdhdUninstallRecords | Where-Object {
    $_.InstallLocation -and ([IO.Path]::GetFullPath($_.InstallLocation)).TrimEnd('\') -ieq ([IO.Path]::GetFullPath($installRoot)).TrimEnd('\')
  })
  # NSIS may expose the same per-user ARP entry through more than one registry
  # view, and electron-builder does not guarantee a particular uninstall-string
  # spelling. The durable contract is an ARP record for this exact install plus
  # the official uninstaller discovered inside that install directory.
  if ($records.Count -lt 1) {
    throw 'INSTALLED_E2E_UNINSTALL_RECORD_INVALID'
  }
  $shortcutsCreated = (@($expectedShortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -eq $expectedShortcuts.Count)
  if (-not $shortcutsCreated -or @($legacyShortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) {
    throw 'INSTALLED_E2E_SHORTCUT_CREATION_INVALID'
  }

  & node scripts/e2e/run-packaged-suite.mjs --exe $apps[0].FullName --evidence-dir $evidence
  if ($LASTEXITCODE -ne 0) { throw 'INSTALLED_E2E_PACKAGED_SUITE_FAILED' }
  $suitePassed = $true
  if (@(Get-InstallProcesses $installRoot).Count -ne 0) { throw 'INSTALLED_E2E_PROCESS_REMAINED' }
} catch {
  $primaryFailure = $_
  $candidate = [string]$_.Exception.Message
  $primaryCode = if ($candidate -match '^[A-Z][A-Z0-9_]{1,63}$') { $candidate } else { 'INSTALLED_E2E_FAILED' }
} finally {
  if (-not $uninstaller -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
    try {
      $discovered = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'Uninstall ADHD One.exe' -ErrorAction Stop)
      if ($discovered.Count -eq 1) { $uninstaller = $discovered[0].FullName }
      elseif ($discovered.Count -gt 1) { $cleanupFailures.Add('INSTALLED_E2E_UNINSTALLER_AMBIGUOUS') }
    } catch { $cleanupFailures.Add('INSTALLED_E2E_UNINSTALLER_DISCOVERY_FAILED') }
  }
  if ($uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    $uninstallAttempted = $true
    try {
      $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru -WindowStyle Hidden
      if (-not $uninstall.WaitForExit(60000)) {
        $uninstall.Kill($true)
        $cleanupFailures.Add('INSTALLED_E2E_UNINSTALL_TIMEOUT')
      } else {
        $uninstallExitCode = $uninstall.ExitCode
        if ($uninstallExitCode -ne 0) { $cleanupFailures.Add('INSTALLED_E2E_UNINSTALL_FAILED') }
        else { $uninstallSucceeded = $true }
      }
    } catch { $cleanupFailures.Add('INSTALLED_E2E_UNINSTALL_FAILED') }
  } elseif (Test-Path -LiteralPath $installRoot) {
    $cleanupFailures.Add('INSTALLED_E2E_UNINSTALLER_MISSING')
  }

  # The NSIS launcher can exit after the install directory is removed but
  # before its elevated/child cleanup removes ARP keys and shortcuts. Poll the
  # complete uninstall contract instead of treating directory removal as the
  # completion signal.
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $installDirectoryRemoved = -not (Test-Path -LiteralPath $installRoot)
    $uninstallRecordsClean = (@(Get-AdhdUninstallRecords).Count -eq 0)
    $installMarkersClean = (@(Get-InstallMarkers $installRoot).Count -eq 0)
    $shortcutsClean = (@($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0)
    if ($installDirectoryRemoved -and $uninstallRecordsClean -and $installMarkersClean -and $shortcutsClean) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $installDirectoryRemoved) { $cleanupFailures.Add('INSTALLED_E2E_INSTALL_DIRECTORY_REMAINED') }
  try {
    $processClean = (@(Get-InstallProcesses $installRoot).Count -eq 0)
    if (-not $processClean) { $cleanupFailures.Add('INSTALLED_E2E_PROCESS_REMAINED_AFTER_UNINSTALL') }
  } catch { $cleanupFailures.Add('INSTALLED_E2E_PROCESS_AUDIT_FAILED') }
  try {
    # The preflight requires zero ADHD One records, so any matching record after
    # uninstall is residue even when InstallLocation is missing or corrupted.
    $registryClean = $uninstallRecordsClean -and $installMarkersClean
    if (-not $uninstallRecordsClean) { $cleanupFailures.Add('INSTALLED_E2E_REGISTRY_REMAINED') }
    if (-not $installMarkersClean) { $cleanupFailures.Add('INSTALLED_E2E_INSTALL_MARKER_REMAINED') }
  } catch { $cleanupFailures.Add('INSTALLED_E2E_REGISTRY_AUDIT_FAILED') }
  if (-not $shortcutsClean) { $cleanupFailures.Add('INSTALLED_E2E_SHORTCUT_REMAINED') }

  $summary = [ordered]@{
    schemaVersion = 1
    tool = 'adhd-one-installed-e2e'
    passed = ($null -eq $primaryFailure -and $cleanupFailures.Count -eq 0)
    installStarted = $installStarted
    installCompleted = $installCompleted
    shortcutsCreated = $shortcutsCreated
    suitePassed = $suitePassed
    uninstallAttempted = $uninstallAttempted
    uninstallSucceeded = $uninstallSucceeded
    uninstallExitCode = $uninstallExitCode
    installDirectoryRemoved = $installDirectoryRemoved
    processClean = $processClean
    registryClean = $registryClean
    shortcutsClean = $shortcutsClean
    errorCode = if ($primaryCode) { $primaryCode } elseif ($cleanupFailures.Count) { $cleanupFailures[0] } else { $null }
    cleanupErrorCodes = @($cleanupFailures)
  }
  $summary | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $evidence 'installed-summary.json') -Encoding utf8
}

if ($null -ne $primaryFailure -or $cleanupFailures.Count -ne 0) {
  $codes = @($primaryCode) + @($cleanupFailures) | Where-Object { $_ }
  throw ($codes -join ',')
}
Write-Output 'PASS installed E2E: install, packaged suite, uninstall, residue checks'
