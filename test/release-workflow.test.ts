import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'release.yml');

describe('release workflow identity gates', () => {
  it('binds release notes to the complete tag or version', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain('The first RELEASE_NOTES.md heading must contain the complete release tag/version');
    expect(workflow).toContain("$env:RELEASE_TAG");
    expect(workflow).toContain("$env:RELEASE_VERSION");
  });

  it('rejects a preview runtime from a Stable app release', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow).toContain("$manifestChannel -ne 'stable'");
    expect(workflow).toContain('$dshSemVer.PreReleaseLabel');
    expect(workflow).toContain('cannot publish runtime channel=');
  });
});
