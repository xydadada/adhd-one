import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateUpstreamRuntime } from '../scripts/check-upstream-runtime.mjs';

const current = {
  version: '0.1.0-rc.6',
  integrity: 'sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg=='
};

function metadata(version: string, integrity = current.integrity): Record<string, unknown> {
  return { name: '@deepseek-ai/dsh', version, dist: { integrity } };
}

describe('official DSH upstream monitor', () => {
  it('reports the exact locked release as current', () => {
    expect(evaluateUpstreamRuntime(current, metadata(current.version))).toMatchObject({
      status: 'current', requiresAttention: false, currentVersion: current.version, latestVersion: current.version
    });
  });

  it('reports a newer prerelease without changing local dependencies', () => {
    expect(evaluateUpstreamRuntime(current, metadata('0.1.0-rc.7', 'sha512-YWJjZA=='))).toMatchObject({
      status: 'update-available', requiresAttention: true, latestVersion: '0.1.0-rc.7'
    });
    expect(current.version).toBe('0.1.0-rc.6');
  });

  it('fails attention closed when the registry mutates integrity for the same version', () => {
    expect(evaluateUpstreamRuntime(current, metadata(current.version, 'sha512-YWJjZA=='))).toMatchObject({
      status: 'integrity-mismatch', requiresAttention: true
    });
  });

  it('flags a latest-tag regression and rejects malformed registry data', () => {
    expect(evaluateUpstreamRuntime(current, metadata('0.1.0-rc.5', 'sha512-YWJjZA=='))).toMatchObject({
      status: 'tag-regression', requiresAttention: true
    });
    expect(() => evaluateUpstreamRuntime(current, { name: '@deepseek-ai/dsh', version: 'latest', dist: {} })).toThrow('UPSTREAM_METADATA_INVALID');
    expect(() => evaluateUpstreamRuntime(current, { name: 'lookalike', version: current.version, dist: { integrity: current.integrity } })).toThrow('UPSTREAM_METADATA_INVALID');
  });

  it('keeps the scheduled workflow read-only toward Runtime and GitHub', async () => {
    const workflow = await readFile(path.resolve('.github', 'workflows', 'upstream-monitor.yml'), 'utf8');
    expect(workflow).toContain("cron: '17 3 * * 1'");
    expect(workflow).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(workflow).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('issues: write');
    expect(workflow).not.toContain('gh issue');
    expect(workflow).not.toMatch(/npm (?:install|update) @deepseek-ai\/dsh/u);
    expect(workflow).not.toContain('gh release create');
  });
});
