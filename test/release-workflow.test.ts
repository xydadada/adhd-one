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

  it('verifies release-installed evidence before upload without validating portable evidence', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const installedSuite = workflow.indexOf('      - name: NSIS installed E2E suite and uninstall residue check');
    const verifier = workflow.indexOf('      - name: Verify release installed E2E evidence');
    const evidenceUpload = workflow.indexOf('      - name: Upload release E2E evidence');
    const portableOutput = workflow.indexOf('--output evidence/release-portable.json');

    expect(installedSuite).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(installedSuite);
    expect(evidenceUpload).toBeGreaterThan(verifier);
    expect(workflow.match(/npm run verify:evidence -- evidence\/release-installed/gu)).toHaveLength(1);
    expect(workflow.slice(portableOutput)).not.toContain('npm run verify:evidence');
  });

  it('labels the final win-unpacked tree as Portable and requires its marker', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const build = workflow.indexOf('npm run build:win');
    const archiveSmoke = workflow.indexOf('npm run smoke:runtime-archive');
    const metadata = workflow.indexOf('node scripts/generate-release-metadata.mjs');

    expect(archiveSmoke).toBeGreaterThan(build);
    expect(metadata).toBeGreaterThan(archiveSmoke);
    expect(workflow).toContain('Packaged Portable win-unpacked E2E');
    expect(workflow).toContain('--output evidence/release-portable-unpacked.json');
    expect(workflow).toContain('--require-portable');
    expect(workflow).not.toContain('evidence/release-packaged.json');
  });

  it('limits tag publishing to the target repository and its owner', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const triggerGuard = /if:\s+\$\{\{\s*github\.repository\s*==\s*'xydadada\/adhd-one'\s*&&\s*github\.ref_type\s*==\s*'tag'\s*&&\s*github\.actor\s*==\s*github\.repository_owner\s*\}\}/gu;

    expect(workflow.match(triggerGuard)).toHaveLength(2);
    expect(workflow).not.toContain('e0a0a28');
  });

  it('derives prerelease state from package SemVer and verifies the created release', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const create = workflow.indexOf('gh @arguments');
    const readback = workflow.indexOf('gh release view', create);

    expect(workflow).toContain('$packageSemVer.PreReleaseLabel');
    expect(workflow).toContain("if ($isPrerelease) { $arguments += '--prerelease' }");
    expect(workflow).not.toContain("$env:GITHUB_REF_NAME.Contains('-')");
    expect(readback).toBeGreaterThan(create);
    expect(workflow).toContain('--json tagName,isDraft,isPrerelease,assets');
    expect(workflow).toContain('$release.tagName');
    expect(workflow).toContain('$release.isDraft');
    expect(workflow).toContain('$release.isPrerelease');
    expect(workflow).toContain('$remoteAssetNameSet');
    expect(workflow).toContain('$remoteAssetSizes[$name] -ne $localAssetSizes[$name]');
  });
});
