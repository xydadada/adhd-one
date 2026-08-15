import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../scripts/e2e/updater-feed.mjs', import.meta.url), 'utf8');

describe('electron-updater feed E2E harness', () => {
  it('is loopback-only and removes ambient network credentials', () => {
    expect(script).toContain("server.listen(0, '127.0.0.1')");
    expect(script).toContain("socket.remoteAddress !== '127.0.0.1'");
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      expect(script).toContain(`delete process.env.${name}`);
    }
    expect(script).toContain("process.env.NO_PROXY = '127.0.0.1,localhost'");
    expect(script).toContain('delete childEnvironment[name]');
  });

  it('exercises the real GitHub provider, preview fallback, and SHA-512 rejection', () => {
    expect(script).toContain("provider: 'github'");
    expect(script).toContain('previewChannelMissed');
    expect(script).toContain('previewFallbackServed');
    expect(script).toContain("error?.code === 'ERR_CHECKSUM_MISMATCH'");
    expect(script).toContain('wrongChecksumServed');
  });

  it('cannot install and has bounded, stable output', () => {
    expect(script).toContain("fail('INSTALL_ATTEMPTED')");
    expect(script).toContain('120000');
    expect(script).toContain("writeOutcome('UPDATER_FEED_E2E_OK')");
    expect(script).not.toContain('console.log');
    expect(script).not.toContain('console.error');
  });
});
