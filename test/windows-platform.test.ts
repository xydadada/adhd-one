import { describe, expect, it } from 'vitest';
import { buildUnicodeEnvironment, buildWindowsCommandLine, quoteWindowsArg } from '../src/windows-platform.js';

describe('Windows launcher helpers', () => {
  it('quotes spaces, quotes and trailing slashes', () => { expect(quoteWindowsArg('a b')).toBe('"a b"'); expect(buildWindowsCommandLine('C:\\a b\\node.exe', ['x"y'])).toContain('\\"'); });
  it('builds a sorted double-null UTF-16 environment', () => { const text = buildUnicodeEnvironment({ z: '2', A: '1' }).toString('utf16le'); expect(text).toBe('A=1\0z=2\0\0'); });
});
