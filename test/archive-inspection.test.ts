import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveInspectionError,
  inspectArchiveWith7za,
  parseSevenZipSlt,
  scanExtractedTreeNoReparse
} from '../src/archive-inspection.js';

const limits = {
  maxEntries: 10,
  maxFileSize: 100,
  maxTotalSize: 250
} as const;

function listing(entries: string[], header = true): string {
  const archiveHeader = header
    ? [
      'Path = C:\\download\\runtime.7z',
      'Type = 7z',
      'Physical Size = 123',
      'Headers Size = 12',
      'Method = LZMA2:24',
      'Solid = +',
      'Blocks = 1'
    ].join('\r\n')
    : '';
  return [
    '7-Zip (a) 21.07 (x64)',
    'Scanning the drive for archives:',
    '1 file, 123 bytes (1 KiB)',
    'Listing archive: C:\\download\\runtime.7z',
    '--',
    archiveHeader,
    '----------',
    ...entries
  ].filter(Boolean).join('\r\n\r\n');
}

function entry(path: string, size: number | string, extra: string[] = []): string {
  return [
    `Path = ${path}`,
    `Size = ${size}`,
    'Packed Size = ',
    'Created = 2026-08-14 18:13:38',
    'Accessed = 2026-08-14 18:13:38',
    'Modified = 2026-08-14 18:13:38',
    'Attributes = A',
    'CRC = C58ECA01',
    'Encrypted = -',
    'Method = LZMA2:24',
    'Block = 0',
    ...extra
  ].join('\r\n');
}

function expectCode(callback: () => unknown, code: ArchiveInspectionError['code']): void {
  try {
    callback();
    throw new Error('expected callback to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveInspectionError);
    expect((error as ArchiveInspectionError).code).toBe(code);
  }
}

async function expectAsyncCode(callback: () => Promise<unknown>, code: ArchiveInspectionError['code']): Promise<void> {
  try {
    await callback();
    throw new Error('expected promise to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveInspectionError);
    expect((error as ArchiveInspectionError).code).toBe(code);
  }
}

async function withTemporaryDirectory(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-inspection-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('strict 7za -slt archive inspection', () => {
  it('parses UTF-8 technical output without executing or extracting anything', () => {
    const result = parseSevenZipSlt(listing([
      entry('dsh-runtime\\bin\\node.cmd', 23),
      entry('dsh-runtime\\empty.txt', 0)
    ]), limits);

    expect(result).toMatchObject({ entryCount: 2, totalSize: 23, totalUncompressedSize: 23 });
    expect(result.entries).toEqual([
      { path: 'dsh-runtime/bin/node.cmd', size: 23, isDirectory: false },
      { path: 'dsh-runtime/empty.txt', size: 0, isDirectory: false }
    ]);
  });

  it('accepts a directory record and UTF-8 bytes, but rejects invalid UTF-8', () => {
    const directory = entry('dsh-runtime\\bin', 0).replace('Attributes = A', 'Attributes = D');
    const output = listing([directory]);
    expect(parseSevenZipSlt(new TextEncoder().encode(output), limits).entries[0]).toEqual({
      path: 'dsh-runtime/bin',
      size: 0,
      isDirectory: true
    });
    expectCode(() => parseSevenZipSlt(new Uint8Array([0xc3, 0x28]), limits), 'ARCHIVE_OUTPUT_NOT_UTF8');
  });

  it('accepts 21.07 Created/Accessed fields and field names containing hyphens', () => {
    const output = listing([entry('hash.txt', 1, ['SHA-256 = ' + 'a'.repeat(64)])]);
    expect(parseSevenZipSlt(output, limits).entries[0]).toEqual({
      path: 'hash.txt',
      size: 1,
      isDirectory: false
    });
  });

  it('uses the injected runner only for l -slt and parses its stdout', async () => {
    const run7za = vi.fn(async (args: readonly string[]) => ({ stdout: listing([entry('ok.txt', 3)]) }));

    await expect(inspectArchiveWith7za('runtime.7z', run7za, limits)).resolves.toMatchObject({ totalSize: 3 });
    expect(run7za).toHaveBeenCalledOnce();
    expect(run7za).toHaveBeenCalledWith(['l', '-slt', '-sccUTF-8', 'runtime.7z']);
  });

  it.each([
    ['entry count', [entry('a', 1), entry('b', 1)], { ...limits, maxEntries: 1 }, 'ARCHIVE_ENTRY_LIMIT_EXCEEDED'],
    ['single-file size', [entry('a', 101)], limits, 'ARCHIVE_FILE_SIZE_EXCEEDED'],
    ['cumulative size', [entry('a', 100), entry('b', 100), entry('c', 51)], limits, 'ARCHIVE_TOTAL_SIZE_EXCEEDED'],
    ['size overflow', [entry('a', Number.MAX_SAFE_INTEGER.toString()), entry('b', 1)], { ...limits, maxFileSize: Number.MAX_SAFE_INTEGER, maxTotalSize: Number.MAX_SAFE_INTEGER }, 'ARCHIVE_TOTAL_SIZE_EXCEEDED']
  ] as const)('enforces %s limits', (_name, entries, policy, code) => {
    expectCode(() => parseSevenZipSlt(listing(entries), policy), code);
  });

  it('rejects unsafe limits instead of allowing numeric overflow or infinity', () => {
    for (const policy of [
      { maxEntries: Number.POSITIVE_INFINITY },
      { maxFileSize: Number.MAX_SAFE_INTEGER + 1 },
      { maxTotalSize: 1.5 },
      { maxTotalUncompressedSize: -1 },
      { maxEntries: 1, maxEntryCount: 2 }
    ]) {
      expectCode(() => parseSevenZipSlt(listing([entry('a', 1)]), policy), 'ARCHIVE_LIMITS_INVALID');
    }
  });

  it('rejects exact, separator, Windows-case, and NFC/NFD path collisions', () => {
    expectCode(() => parseSevenZipSlt(listing([entry('same.txt', 1), entry('same.txt', 2)]), limits), 'ARCHIVE_PATH_COLLISION');
    expectCode(() => parseSevenZipSlt(listing([entry('dir/a.txt', 1), entry('dir\\a.txt', 2)]), limits), 'ARCHIVE_PATH_COLLISION');
    expectCode(() => parseSevenZipSlt(listing([entry('Readme', 1), entry('README', 2)]), limits), 'ARCHIVE_PATH_COLLISION');
    expectCode(() => parseSevenZipSlt(listing([entry('caf\u00e9.txt', 1), entry('cafe\u0301.txt', 2)]), limits), 'ARCHIVE_PATH_COLLISION');
    expectCode(() => parseSevenZipSlt(listing([entry('runtime', 0), entry('runtime/bin/node.exe', 1)]), limits), 'ARCHIVE_PATH_COLLISION');
    expectCode(() => parseSevenZipSlt(listing([entry('runtime/bin/node.exe', 1), entry('runtime', 0)]), limits), 'ARCHIVE_PATH_COLLISION');
  });

  it.each([
    'C:\\absolute.txt',
    '\\\\server\\share\\file.txt',
    '/absolute.txt',
    'safe/../file.txt',
    'safe/./file.txt',
    'safe\\..\\file.txt',
    'file.txt:secret',
    'file.txt:secret\\child',
    'trailing-dot.',
    'trailing-space ',
    'safe/dir.\\file.txt',
    'safe/dir /file.txt',
    'safe//file.txt',
    'safe\u0001.txt',
    'safe\u202e.txt',
    'safe\u200b.txt'
  ])('rejects unsafe path %j', path => {
    expectCode(() => parseSevenZipSlt(listing([entry(path, 1)]), limits), 'ARCHIVE_UNSAFE_PATH');
  });

  it.each([
    ['Symbolic Link = +', 'Symbolic Link'],
    ['Hard Link = +', 'Hard Link'],
    ['Link = target', 'Link'],
    ['Reparse Point = +', 'Reparse Point'],
    ['Alternate Stream = +', 'Alternate Stream'],
    ['Attributes = AL', 'Attributes']
  ] as const)('rejects %s', (fieldValue) => {
    const unsafeEntry = fieldValue.startsWith('Attributes =')
      ? entry('unsafe', 1).replace('Attributes = A', fieldValue)
      : entry('unsafe', 1, [fieldValue]);
    expectCode(() => parseSevenZipSlt(listing([unsafeEntry]), limits), 'ARCHIVE_SPECIAL_ENTRY');
  });

  it('fails closed for malformed records, unknown fields, duplicate fields, and bad sizes', () => {
    expectCode(() => parseSevenZipSlt('garbage\nPath = a.txt\nSize = 1', limits), 'ARCHIVE_RECORD_INVALID');
    expectCode(() => parseSevenZipSlt(listing([entry('a', 1, ['Unknown = value'])]), limits), 'ARCHIVE_UNKNOWN_FIELD');
    expectCode(() => parseSevenZipSlt(listing([entry('a', 1, ['Size = 2'])]), limits), 'ARCHIVE_DUPLICATE_FIELD');
    expectCode(() => parseSevenZipSlt(listing([entry('a', 'not-a-number' as unknown as number)]), limits), 'ARCHIVE_SIZE_INVALID');
    expectCode(() => parseSevenZipSlt('Path = a.txt\nSize = 1\rgarbage', limits), 'ARCHIVE_OUTPUT_INVALID');
    expectCode(() => parseSevenZipSlt(listing([], false), limits), 'ARCHIVE_EMPTY');
    expectCode(() => parseSevenZipSlt(listing([entry('a', 1)], false), limits), 'ARCHIVE_HEADER_INVALID');
  });

  it('rejects link-like attributes and contradictory directory metadata', () => {
    expectCode(() => parseSevenZipSlt(listing([entry('link', 0).replace('Attributes = A', 'Attributes = L')]), limits), 'ARCHIVE_SPECIAL_ENTRY');
    expectCode(() => parseSevenZipSlt(listing([entry('dir', 1, ['Folder = +'])]), limits), 'ARCHIVE_RECORD_INVALID');
    expectCode(() => parseSevenZipSlt(listing([entry('dir-by-attr', 1).replace('Attributes = A', 'Attributes = D')]), limits), 'ARCHIVE_RECORD_INVALID');
    expectCode(() => parseSevenZipSlt(listing([entry('file', 0, ['Folder = -']).replace('Attributes = A', 'Attributes = D')]), limits), 'ARCHIVE_RECORD_INVALID');
  });

  it('scans the actual extracted tree and requires an exact listing match', async () => {
    await withTemporaryDirectory(async root => {
      await mkdir(path.join(root, 'dsh-runtime', 'bin'), { recursive: true });
      await writeFile(path.join(root, 'dsh-runtime', 'bin', 'node.cmd'), 'abc');
      await mkdir(path.join(root, 'dsh-runtime', 'empty'));

      await expect(scanExtractedTreeNoReparse(root, [
        { path: 'dsh-runtime', size: 0, isDirectory: true },
        { path: 'dsh-runtime/bin', size: 0, isDirectory: true },
        { path: 'dsh-runtime/bin/node.cmd', size: 3, isDirectory: false },
        { path: 'dsh-runtime/empty', size: 0, isDirectory: true }
      ])).resolves.toBeUndefined();
    });
  });

  it('rejects extracted-tree reparse points before recursion', async () => {
    const root = path.resolve('archive-scan-root');
    const linkPath = path.join(root, 'link');
    const fakeFilesystem = {
      lstat: vi.fn(async (target: string) => ({
        size: 0,
        isDirectory: () => target === root,
        isFile: () => false,
        isSymbolicLink: () => false
      })),
      readdir: vi.fn(async (directory: string) => directory === root
        ? [{ name: 'link', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }]
        : []),
      assertNoReparse: vi.fn((target: string) => {
        if (target === linkPath) throw new Error('reparse');
      })
    };

    await expectAsyncCode(
      () => scanExtractedTreeNoReparse(root, [], fakeFilesystem),
      'ARCHIVE_EXTRACTED_REPARSE'
    );
  });

  it('rejects extra, missing, and size-mismatched extracted entries', async () => {
    await withTemporaryDirectory(async root => {
      await writeFile(path.join(root, 'extra.bin'), 'x');
      await expectAsyncCode(
        () => scanExtractedTreeNoReparse(root, []),
        'ARCHIVE_EXTRACTED_EXTRA'
      );
    });

    await withTemporaryDirectory(async root => {
      await expectAsyncCode(
        () => scanExtractedTreeNoReparse(root, [{ path: 'missing.bin', size: 1, isDirectory: false }]),
        'ARCHIVE_EXTRACTED_MISSING'
      );
    });

    await withTemporaryDirectory(async root => {
      await writeFile(path.join(root, 'runtime.bin'), 'abc');
      await expectAsyncCode(
        () => scanExtractedTreeNoReparse(root, [{ path: 'runtime.bin', size: 4, isDirectory: false }]),
        'ARCHIVE_EXTRACTED_SIZE_MISMATCH'
      );
    });
  });
});
