import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../scripts/e2e/updater-feed.mjs', import.meta.url), 'utf8');

describe('electron-updater feed E2E harness', () => {
  it('is loopback-only and removes ambient network credentials', () => {
    expect(script).toContain("server.listen(0, '127.0.0.1')");
    expect(script).toMatch(/server\.on\('connection',[\s\S]*remoteAddress !== '127\.0\.0\.1'[\s\S]*remoteAddress !== '::ffff:127\.0\.0\.1'[\s\S]*nonLoopbackConnection = true;[\s\S]*socket\.destroy\(\)/u);
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      expect(script).toContain(`delete process.env.${name}`);
    }
    expect(script).toContain("process.env.NO_PROXY = '127.0.0.1,localhost'");
    expect(script).toContain("setProxy({ mode: 'direct' })");
    expect(script).toContain("'ELECTRON_RUN_AS_NODE'");
    expect(script).toContain('delete childEnvironment[name]');
  });

  it('exercises the real GitHub provider, preview fallback, and SHA-512 rejection', () => {
    expect(script).toContain("provider: 'github'");
    expect(script).toContain("protocol: 'http'");
    expect(script).toContain('vPrefixedTagName: true');
    expect(script).toContain("provider?.constructor?.name !== 'GitHubProvider'");
    expect(script).toContain('await updater.checkForUpdates()');
    expect(script).toContain('await updater.downloadUpdate()');
    expect(script).toContain('downloadedBuffer.equals(scenario.installerBuffer)');
    expect(script).toContain("!feed.state.previewChannelMissed || !feed.state.previewFallbackServed");
    expect(script).toContain("error?.code === 'ERR_CHECKSUM_MISMATCH'");
    expect(script).toContain("fail('CHECKSUM_MISMATCH_NOT_REPORTED')");
    expect(script).toContain("if (!feed.state.wrongChecksumServed) fail('WRONG_CHECKSUM_FEED_NOT_REQUESTED')");
  });

  it('cannot install and has bounded, stable output', () => {
    expect(script).toContain("fail('INSTALL_ATTEMPTED')");
    expect(script).toMatch(/relaunch\(\) \{[\s\S]*fail\('INSTALL_ATTEMPTED'\);[\s\S]*quit\(\) \{[\s\S]*fail\('INSTALL_ATTEMPTED'\)/u);
    expect(script).toContain("updater.quitAndInstall = () => fail('INSTALL_ATTEMPTED')");
    expect(script).toContain("updater.install = () => fail('INSTALL_ATTEMPTED')");
    expect(script).toContain('updater.autoDownload = false');
    expect(script).toContain('updater.autoInstallOnAppQuit = false');
    expect(script).toContain('updater.autoRunAppAfterInstall = false');
    expect(script).toMatch(/timer = setTimeout\(\(\) => \{[\s\S]*child\.kill\(\);[\s\S]*\}, 120000\)/u);
    expect(script).toContain("result.code === 0 && childOutcome === 'UPDATER_FEED_E2E_OK'");
    expect(script).toContain("writeOutcome('UPDATER_FEED_E2E_OK')");
  });
});
