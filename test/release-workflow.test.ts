import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github', 'workflows', 'release.yml');

describe('release workflow identity gates', () => {
  it('uses pinned Node 24 artifact download and attestation actions', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(workflow.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/gu)).toHaveLength(1);
    expect(workflow.match(/actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/gu)).toHaveLength(1);
    expect(workflow).not.toMatch(/d3f86a106a0bac45b974a628896c90dbdf5c8093|ce27ba3b4a9a139d9a20a4a07d69fabb52f1e5bc/u);
  });

  it('gates release metadata on the real Runtime update staging smoke', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const build = workflow.indexOf('npm run build:win');
    const updateSmoke = workflow.indexOf('npm run smoke:runtime-update');
    const metadata = workflow.indexOf('Generate runtime manifest and checksums');
    expect(updateSmoke).toBeGreaterThan(build);
    expect(metadata).toBeGreaterThan(updateSmoke);
  });

  it('runs the real electron-updater feed gate before release metadata', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const build = workflow.indexOf('npm run build:win');
    const feed = workflow.indexOf('npm run e2e:updater-feed');
    const metadata = workflow.indexOf('Generate runtime manifest and checksums');
    expect(workflow.match(/npm run e2e:updater-feed/gu)).toHaveLength(1);
    expect(feed).toBeGreaterThan(build);
    expect(metadata).toBeGreaterThan(feed);
  });

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

  it('verifies installed and both Portable E2E evidence outputs before upload', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const installedSuite = workflow.indexOf('      - name: NSIS installed E2E suite and uninstall residue check');
    const verifier = workflow.indexOf('      - name: Verify release installed E2E evidence');
    const portableVerifier = workflow.indexOf('      - name: Verify Portable E2E evidence');
    const evidenceUpload = workflow.indexOf('      - name: Upload release E2E evidence');
    const portableUnpackedOutput = workflow.indexOf('--output evidence/release-portable-unpacked.json');
    const portableOutput = workflow.indexOf('--output evidence/release-portable.json');

    expect(installedSuite).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(installedSuite);
    expect(portableUnpackedOutput).toBeGreaterThanOrEqual(0);
    expect(portableOutput).toBeGreaterThan(portableUnpackedOutput);
    expect(portableVerifier).toBeGreaterThan(portableOutput);
    expect(evidenceUpload).toBeGreaterThan(verifier);
    expect(evidenceUpload).toBeGreaterThan(portableVerifier);
    expect(workflow.match(/npm run verify:evidence -- evidence\/release-installed/gu)).toHaveLength(1);
    expect(workflow.match(/--require-portable/gu)).toHaveLength(2);
    expect(workflow).toContain('npm run verify:evidence -- --portable evidence/release-portable-unpacked.json evidence/release-portable.json');
    expect(workflow).not.toContain('Assert-ExactProperties');
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
    expect(workflow).toContain('--json id,tagName,isDraft,isPrerelease,assets');
    expect(workflow).toContain('$release.tagName');
    expect(workflow).toContain('$release.isDraft');
    expect(workflow).toContain('$release.isPrerelease');
    expect(workflow).toContain('$remoteAssetNameSet');
    expect(workflow).toContain('$remoteAssetSizes[$name] -ne $localAssetSizes[$name]');
  });

  it('pins release create and view to RELEASE_REPOSITORY and verifies every remote asset digest', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const createArguments = workflow.indexOf("$arguments = @('release', 'create'");
    const createCall = workflow.indexOf('gh @arguments', createArguments);
    const releaseView = workflow.indexOf('gh release view', createCall);
    const draftCheck = workflow.indexOf('Release must remain a draft during pre-publication verification');
    const digestCheck = workflow.indexOf('Published release asset SHA-256 digest for $name does not match local digest');
    const publishArguments = workflow.indexOf("$publishArguments = @('release', 'edit'");
    const finalReadback = workflow.indexOf('$finalReleaseViewJson', publishArguments);

    expect(createArguments).toBeGreaterThanOrEqual(0);
    expect(createCall).toBeGreaterThan(createArguments);
    expect(workflow.slice(createArguments, createCall)).toContain("'--repo', $env:RELEASE_REPOSITORY");
    expect(workflow.slice(createArguments, createCall)).toContain("'--draft'");
    expect(releaseView).toBeGreaterThan(createCall);
    expect(workflow.slice(releaseView, releaseView + 180)).toContain('--repo $env:RELEASE_REPOSITORY');
    expect(draftCheck).toBeGreaterThan(releaseView);
    expect(digestCheck).toBeGreaterThan(releaseView);
    expect(publishArguments).toBeGreaterThan(digestCheck);
    expect(workflow.slice(publishArguments, finalReadback)).toContain("'--repo', $env:RELEASE_REPOSITORY, '--draft=false'");
    expect(finalReadback).toBeGreaterThan(publishArguments);
    expect(workflow).toContain('$releaseId = [string]$release.id');
    expect(workflow).toContain("$releaseId -notmatch '^[1-9][0-9]*$'");
    expect(workflow).toContain('$releaseApiPath = "repos/$env:RELEASE_REPOSITORY/releases/$releaseId"');
    expect(workflow).toContain('gh api $releaseApiPath -H');
    expect(workflow).toContain('$remoteAsset.digest');
    expect(workflow).toContain('$localAssetDigests[$name]');
    expect(workflow).toContain('Published release asset has no SHA-256 digest');
    expect(workflow).toContain('Published release asset SHA-256 digest for $name does not match local digest');
    expect(workflow).toContain('Final release must not be a draft');
    expect(workflow).toContain('$finalRelease.isPrerelease');
  });
});
