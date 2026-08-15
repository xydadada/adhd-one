import { describe, expect, it } from 'vitest';
import { allowedExternalUrl, isExactOrigin, isPathInside, isTrustedControlUrl, parseLoopbackRuntimeUrl, redactText, validateArchiveEntry } from '../src/security.js';

describe('security boundaries', () => {
  it.each(['http://0.0.0.0:3000', 'http://127.0.0.1.evil.test:3000', 'http://user@127.0.0.1:3000', 'https://127.0.0.1:3000'])("rejects %s", value => expect(parseLoopbackRuntimeUrl(value)).toBeUndefined());
  it('requires an exact loopback origin', () => expect(isExactOrigin('http://127.0.0.1:3000/a', 'http://127.0.0.1:3000')).toBe(true));
  it('requires an exact ControlWindow document URL', () => {
    expect(isTrustedControlUrl('adhd-one://app/index.html')).toBe(true);
    expect(isTrustedControlUrl('adhd-one://app.evil/index.html')).toBe(false);
    expect(isTrustedControlUrl('adhd-one://app:99/index.html')).toBe(false);
    expect(isTrustedControlUrl('adhd-one://app/settings')).toBe(false);
  });
  it('restricts external navigation', () => {
    expect(allowedExternalUrl('https://github.com/xydadada/adhd-one')).toBeTruthy();
    expect(allowedExternalUrl('https://github.com.evil.test/')).toBeUndefined();
    expect(allowedExternalUrl('https://github.com:8443/xydadada/adhd-one')).toBeUndefined();
  });
  it('checks containment and archives', () => { expect(isPathInside('C:\\root', 'C:\\root\\ok')).toBe(true); expect(validateArchiveEntry('../bad')).toBe(false); expect(validateArchiveEntry('C:/bad')).toBe(false); });
  it('redacts secrets and local paths', () => {
    const redacted = redactText('Authorization: Basic dXNlcjpwYXNz apiKey="top-secret" DEEPSEEK_API_KEY=value C:\\Users\\Alice\\AppData file:///D:/private/log C%3A%5CUsers%5CAlice');
    expect(redacted).not.toMatch(/dXNlcj|top-secret|DEEPSEEK_API_KEY|Alice|private/iu);
  });
  it('redacts UNC paths and bare token assignments', () => {
    const unc = redactText('error at \\\\server\\share\\private\\file.txt');
    const labeledUnc = redactText('path:\\\\server\\share\\private\\file.txt');
    const extendedUnc = redactText('error at \\\\?\\UNC\\server\\share\\private\\file.txt');
    const fileUnc = redactText('error at file://server/share/private/file.txt');
    const token = redactText('request failed token=plain-token');

    expect(unc).not.toMatch(/server|share|private|file\.txt/iu);
    expect(labeledUnc).not.toMatch(/server|share|private|file\.txt/iu);
    expect(extendedUnc).not.toMatch(/server|share|private|file\.txt/iu);
    expect(fileUnc).not.toMatch(/server|share|private|file\.txt/iu);
    expect(token).not.toContain('plain-token');
  });
  it('redacts quoted JSON authorization values without leaking the token suffix', () => {
    const redacted = redactText('{"Authorization":"Bearer fake-secret","authorization":"Basic basic-secret"}');
    expect(redacted).not.toMatch(/fake-secret|basic-secret/iu);
  });
});
