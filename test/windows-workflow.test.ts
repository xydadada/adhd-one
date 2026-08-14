import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'windows.yml');

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
  });

  it('fails the final gate unless every producer and E2E job succeeds', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('needs: [build-windows, installed-e2e, portable-e2e]');
    expect(workflow).toContain('test "$BUILD_RESULT" = success');
    expect(workflow).toContain('test "$INSTALLED_RESULT" = success');
    expect(workflow).toContain('test "$PORTABLE_RESULT" = success');
  });
});
