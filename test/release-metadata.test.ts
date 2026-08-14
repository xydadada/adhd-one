import { describe, expect, it } from 'vitest';
import { releaseMetadataLinks, validateReleaseIdentity } from '../scripts/generate-release-metadata.mjs';

const packageVersion = '0.2.0-beta.2';
const expectedTag = `v${packageVersion}`;
const expectedRef = `refs/tags/${expectedTag}`;

describe('release metadata identity', () => {
  it('uses the package version when release environment values are absent', () => {
    expect(validateReleaseIdentity(packageVersion, {})).toEqual({ tag: expectedTag, ref: expectedRef });
  });

  it('accepts only the exact expected tag and ref pair', () => {
    const identity = validateReleaseIdentity(packageVersion, { GITHUB_REF_NAME: expectedTag, GITHUB_REF: expectedRef });
    expect(identity).toEqual({ tag: expectedTag, ref: expectedRef });

    expect(releaseMetadataLinks(identity, 'runtime.7z')).toEqual({
      assetUrl: `https://github.com/xydadada/adhd-one/releases/download/${expectedTag}/runtime.7z`,
      attestationRef: expectedRef,
      notesUrl: `https://github.com/xydadada/adhd-one/releases/tag/${expectedTag}`
    });
  });

  it.each([
    ['', 'RELEASE_TAG_IDENTITY_MISMATCH'],
    ['v0.2.0-beta.1', 'RELEASE_TAG_IDENTITY_MISMATCH'],
    [`refs/tags/${expectedTag}`, 'RELEASE_TAG_IDENTITY_MISMATCH']
  ])('rejects an invalid GITHUB_REF_NAME: %s', (value, errorCode) => {
    expect(() => validateReleaseIdentity(packageVersion, { GITHUB_REF_NAME: value })).toThrow(errorCode);
  });

  it.each([
    ['', 'RELEASE_REF_IDENTITY_MISMATCH'],
    [`refs/heads/${expectedTag}`, 'RELEASE_REF_IDENTITY_MISMATCH'],
    [`refs/tags/v0.2.0-beta.1`, 'RELEASE_REF_IDENTITY_MISMATCH']
  ])('rejects an invalid GITHUB_REF: %s', (value, errorCode) => {
    expect(() => validateReleaseIdentity(packageVersion, { GITHUB_REF: value })).toThrow(errorCode);
  });

  it('rejects a package version outside the strict SemVer contract', () => {
    expect(() => validateReleaseIdentity('0.2', {})).toThrow('RELEASE_VERSION_INVALID');
  });
});
