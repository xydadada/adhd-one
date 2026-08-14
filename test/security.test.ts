import { describe, expect, it } from 'vitest';
import { allowedExternalUrl, isExactOrigin, isPathInside, parseLoopbackRuntimeUrl, redactText, validateArchiveEntry } from '../src/security.js';

describe('security boundaries', () => {
  it.each(['http://0.0.0.0:3000', 'http://127.0.0.1.evil.test:3000', 'http://user@127.0.0.1:3000', 'https://127.0.0.1:3000'])("rejects %s", value => expect(parseLoopbackRuntimeUrl(value)).toBeUndefined());
  it('requires an exact loopback origin', () => expect(isExactOrigin('http://127.0.0.1:3000/a', 'http://127.0.0.1:3000')).toBe(true));
  it('restricts external navigation', () => { expect(allowedExternalUrl('https://github.com/xydadada/adhd-one')).toBeTruthy(); expect(allowedExternalUrl('https://github.com.evil.test/')).toBeUndefined(); });
  it('checks containment and archives', () => { expect(isPathInside('C:\\root', 'C:\\root\\ok')).toBe(true); expect(validateArchiveEntry('../bad')).toBe(false); expect(validateArchiveEntry('C:/bad')).toBe(false); });
  it('redacts secrets', () => expect(redactText('Authorization: Bearer secret sk-123456789')).not.toContain('secret'));
});
