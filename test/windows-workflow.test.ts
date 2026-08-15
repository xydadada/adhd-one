import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'windows.yml');
const installedScriptPath = path.resolve('scripts', 'e2e', 'installed.ps1');

describe('Windows verification workflow', () => {
  it('runs the real Runtime update staging smoke after the shared build', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('npm run smoke:runtime-update');
    expect(workflow.indexOf('npm run smoke:runtime-update')).toBeGreaterThan(workflow.indexOf('npm run build:win'));
  });

  it('builds Windows artifacts exactly once', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow.match(/npm run build:win/gu)).toHaveLength(1);
  });

  it('runs installed and portable E2E as independent consumers', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toMatch(/installed-e2e:\s+needs: build-windows/u);
    expect(workflow).toMatch(/portable-e2e:\s+needs: build-windows/u);
    expect(workflow).toContain('setup_artifact_name: ${{ steps.artifact-names.outputs.setup_artifact_name }}');
    expect(workflow).toContain('portable_artifact_name: ${{ steps.artifact-names.outputs.portable_artifact_name }}');
    expect(workflow).toContain('name: ${{ needs.build-windows.outputs.setup_artifact_name }}');
    expect(workflow).toContain('name: ${{ needs.build-windows.outputs.portable_artifact_name }}');
    expect(workflow).toContain('adhd-one-installed-evidence-${{ github.sha }}-${{ github.run_attempt }}');
    expect(workflow).toContain('adhd-one-portable-evidence-${{ github.sha }}-${{ github.run_attempt }}');
    expect(workflow).toContain('--require-portable');
    expect(workflow).toContain('Packaged Portable win-unpacked launch smoke');
    expect(workflow).toContain('--output evidence/portable-win-unpacked-launch.json');
    expect(workflow).not.toContain('evidence/win-unpacked-launch.json');
  });

  it('verifies installed and both Portable evidence files before upload', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const installedSuite = workflow.indexOf('      - name: NSIS installed E2E suite and uninstall residue check');
    const verifier = workflow.indexOf('      - name: Verify installed E2E evidence');
    const upload = workflow.indexOf('      - name: Upload installed evidence');
    const portableJob = workflow.slice(workflow.indexOf('  portable-e2e:'));
    const unpackedVerifier = workflow.indexOf('      - name: Verify packaged Portable win-unpacked evidence');
    const portableVerifier = portableJob.indexOf('      - name: Verify Portable ZIP evidence');
    const portableUpload = portableJob.indexOf('      - name: Upload Portable evidence');

    expect(installedSuite).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(installedSuite);
    expect(upload).toBeGreaterThan(verifier);
    expect(workflow.match(/npm run verify:evidence -- evidence\/installed/gu)).toHaveLength(1);
    expect(unpackedVerifier).toBeGreaterThan(workflow.indexOf('      - name: Packaged Portable win-unpacked launch smoke'));
    expect(portableVerifier).toBeGreaterThanOrEqual(0);
    expect(portableUpload).toBeGreaterThan(portableVerifier);
    expect(workflow.match(/npm run verify:evidence -- --portable evidence\/portable-(?:win-unpacked-launch|launch)\.json/gu)).toHaveLength(2);
    expect(portableJob).toContain('if-no-files-found: error');
  });

  it('cleans the bounded Portable ZIP extraction directory in a finally block', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const portableJob = workflow.slice(workflow.indexOf('  portable-e2e:'));
    expect(portableJob).toContain('[IO.Path]::GetFullPath($env:RUNNER_TEMP)');
    expect(portableJob).toContain("throw 'Portable extraction path escaped RUNNER_TEMP'");
    expect(portableJob).toMatch(/try \{[\s\S]+\} finally \{[\s\S]+Remove-Item -LiteralPath \$portableRoot -Recurse -Force/u);
    expect(portableJob).toContain("throw 'Portable extraction directory cleanup failed'");
  });

  it('binds latest.yml installer metadata to the exact Setup file', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const assetGate = workflow.slice(
      workflow.indexOf('      - name: Verify package version and Windows assets'),
      workflow.indexOf('      - name: Packaged Portable win-unpacked launch smoke'),
    );

    expect(assetGate).toContain('$setupPath = Join-Path $dist $setupName');
    expect(assetGate).toContain('$portablePath = Join-Path $dist $portableName');
    expect(assetGate).toContain('$latestPathMatch');
    expect(assetGate).toContain('$latestSha512Match');
    expect(assetGate).toContain('$latestInstallerPath -ne $setupName');
    expect(assetGate).toContain('[System.IO.File]::OpenRead($setupPath)');
    expect(assetGate).toContain('$sha512.ComputeHash($setupStream)');
    expect(assetGate).not.toContain('ReadAllBytes');
    expect(assetGate).toContain('[Convert]::ToBase64String');
    expect(assetGate).toContain('$actualSha512 -ne $latestSha512');
  });

  it('uploads only the exact versioned Setup and Portable paths', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const setupUploadStart = workflow.indexOf('      - name: Upload Setup input');
    const portableUploadStart = workflow.indexOf('      - name: Upload Portable input');
    const evidenceUploadStart = workflow.indexOf('      - name: Upload build evidence');
    const setupUpload = workflow.slice(setupUploadStart, portableUploadStart);
    const portableUpload = workflow.slice(portableUploadStart, evidenceUploadStart);

    expect(setupUpload).toContain('${{ steps.windows-assets.outputs.setup_path }}');
    expect(setupUpload).toContain('dist/latest.yml');
    expect(setupUpload).not.toContain('*');
    expect(portableUpload).toContain('${{ steps.windows-assets.outputs.portable_path }}');
    expect(portableUpload).not.toContain('*');
    expect(workflow).toContain('"setup_path=dist/$setupName"');
    expect(workflow).toContain('"portable_path=dist/$portableName"');
  });

  it('bounds both the installed job and a stalled NSIS installer', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const installedJob = workflow.slice(
      workflow.indexOf('  installed-e2e:'),
      workflow.indexOf('  portable-e2e:'),
    );
    const installedScript = await readFile(installedScriptPath, 'utf8');

    expect(installedJob).toContain('timeout-minutes: 40');
    expect(installedScript).toContain('$install.WaitForExit(300000)');
    expect(installedScript).toContain('$install.Kill($true)');
    expect(installedScript).toContain("throw 'INSTALLED_E2E_INSTALL_TIMEOUT'");
    expect(installedScript).not.toMatch(/Start-Process[^\r\n]+-Wait\s+-PassThru/u);
  });

  it('fails the final gate unless every producer and E2E job succeeds', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('needs: [build-windows, installed-e2e, portable-e2e]');
    expect(workflow).toContain('test "$BUILD_RESULT" = success');
    expect(workflow).toContain('test "$INSTALLED_RESULT" = success');
    expect(workflow).toContain('test "$PORTABLE_RESULT" = success');
  });
});
