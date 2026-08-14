import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'windows.yml');
const installedScriptPath = path.resolve('scripts', 'e2e', 'installed.ps1');

describe('Windows verification workflow', () => {
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
    expect(workflow).toContain('portableMode=true');
    expect(workflow).toContain('Packaged Portable win-unpacked launch smoke');
    expect(workflow).toContain('--output evidence/portable-win-unpacked-launch.json');
    expect(workflow).not.toContain('evidence/win-unpacked-launch.json');
  });

  it('verifies installed evidence before upload without validating portable evidence', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const installedSuite = workflow.indexOf('      - name: NSIS installed E2E suite and uninstall residue check');
    const verifier = workflow.indexOf('      - name: Verify installed E2E evidence');
    const upload = workflow.indexOf('      - name: Upload installed evidence');
    const portableJob = workflow.slice(workflow.indexOf('  portable-e2e:'));

    expect(installedSuite).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(installedSuite);
    expect(upload).toBeGreaterThan(verifier);
    expect(workflow.match(/npm run verify:evidence -- evidence\/installed/gu)).toHaveLength(1);
    expect(portableJob).not.toContain('verify:evidence');
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
