import { describe, expect, it } from 'vitest';
import { parseRuntimeManifest } from '../src/update-manager.js';

const manifest = { schemaVersion: 1, channel: 'stable', generatedAt: '2026-08-14T00:00:00.000Z', minAppVersion: '0.2.0', platform: 'win32', arch: 'x64', runtime: { version: '0.1.0', dshPackage: '@deepseek-ai/dsh', dshIntegrity: 'sha512-x', nodeVersion: '24.18.0', pnpmVersion: '11.21.0', protocolCompatibility: '^1' }, asset: { name: 'runtime.7z', url: 'https://github.com/xydadada/adhd-one/releases/download/v0.2.0/runtime.7z', size: 10, sha256: 'a'.repeat(64) }, source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness', npmPublishedAt: '2026-08-14' }, attestation: { repository: 'xydadada/adhd-one', workflow: 'release.yml', ref: 'refs/tags/v0.2.0', subjectDigest: `sha256:${'a'.repeat(64)}` } } as const;
describe('runtime manifest', () => {
  it('accepts a pinned stable GitHub asset', () => expect(parseRuntimeManifest(manifest, 'stable').runtime.version).toBe('0.1.0'));
  it('rejects channel and digest confusion', () => { expect(() => parseRuntimeManifest({ ...manifest, channel: 'preview' }, 'stable')).toThrow(); expect(() => parseRuntimeManifest({ ...manifest, attestation: { ...manifest.attestation, subjectDigest: 'sha256:bad' } }, 'stable')).toThrow(); });
  it('rejects untrusted asset hosts', () => expect(() => parseRuntimeManifest({ ...manifest, asset: { ...manifest.asset, url: 'https://evil.test/runtime.7z' } }, 'stable')).toThrow());
});
