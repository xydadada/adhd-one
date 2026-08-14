import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { assertNoWindowsReparseComponents } from './windows-platform.js';

/**
 * The injected 7za runner must return stdout decoded as UTF-8. This module
 * never consults a Windows code page, starts 7za, or extracts files. The
 * exported post-extraction scanner only reads a caller-provided staging tree.
 */
export type SevenZipSltOutput = string | Uint8Array;

export interface ArchiveInspectionLimits {
  /** Maximum number of archive entries, excluding the 7za archive header. */
  readonly maxEntries?: number;
  /** Maximum uncompressed Size of one entry. */
  readonly maxFileSize?: number;
  /** Maximum sum of uncompressed Size values. */
  readonly maxTotalSize?: number;
  /** Alias for maxEntries for callers that prefer the longer name. */
  readonly maxEntryCount?: number;
  /** Alias for maxFileSize for callers that prefer the longer name. */
  readonly maxSingleFileSize?: number;
  /** Alias for maxTotalSize that makes the uncompressed meaning explicit. */
  readonly maxTotalUncompressedSize?: number;
}

export const DEFAULT_ARCHIVE_INSPECTION_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxFileSize: 512 * 1024 * 1024,
  maxTotalSize: 4 * 1024 * 1024 * 1024
} satisfies Required<Pick<ArchiveInspectionLimits, 'maxEntries' | 'maxFileSize' | 'maxTotalSize'>>);

/** Short alias kept for callers that only need the default policy. */
export const DEFAULT_ARCHIVE_LIMITS = DEFAULT_ARCHIVE_INSPECTION_LIMITS;

export interface ArchiveInspectionEntry {
  /** Path with Windows separators converted to '/' and one trailing separator removed. */
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

export interface ArchiveInspectionResult {
  readonly entries: readonly ArchiveInspectionEntry[];
  readonly entryCount: number;
  readonly totalSize: number;
  readonly totalUncompressedSize: number;
}

export type ArchiveInspectionErrorCode =
  | 'ARCHIVE_OUTPUT_NOT_UTF8'
  | 'ARCHIVE_OUTPUT_INVALID'
  | 'ARCHIVE_LIMITS_INVALID'
  | 'ARCHIVE_RECORD_INVALID'
  | 'ARCHIVE_UNKNOWN_FIELD'
  | 'ARCHIVE_DUPLICATE_FIELD'
  | 'ARCHIVE_HEADER_INVALID'
  | 'ARCHIVE_SIZE_INVALID'
  | 'ARCHIVE_ENTRY_LIMIT_EXCEEDED'
  | 'ARCHIVE_FILE_SIZE_EXCEEDED'
  | 'ARCHIVE_TOTAL_SIZE_EXCEEDED'
  | 'ARCHIVE_EMPTY'
  | 'ARCHIVE_UNSAFE_PATH'
  | 'ARCHIVE_PATH_COLLISION'
  | 'ARCHIVE_SPECIAL_ENTRY'
  | 'ARCHIVE_EXTRACTED_REPARSE'
  | 'ARCHIVE_EXTRACTED_EXTRA'
  | 'ARCHIVE_EXTRACTED_MISSING'
  | 'ARCHIVE_EXTRACTED_TYPE_MISMATCH'
  | 'ARCHIVE_EXTRACTED_SIZE_MISMATCH'
  | 'ARCHIVE_EXTRACTED_SCAN_FAILED'
  | 'ARCHIVE_LIST_FAILED'
  | 'ARCHIVE_RUNNER_INVALID';

export class ArchiveInspectionError extends Error {
  readonly code: ArchiveInspectionErrorCode;
  readonly record?: number;
  readonly field?: string;

  constructor(code: ArchiveInspectionErrorCode, record?: number, field?: string) {
    super(code);
    this.name = 'ArchiveInspectionError';
    this.code = code;
    if (record !== undefined) this.record = record;
    if (field !== undefined) this.field = field;
  }
}

interface RawSltRecord {
  readonly fields: Map<string, string>;
  readonly record: number;
}

// These are the property names emitted by 7-Zip 21.07's technical listing.
// Keep the allow-list explicit: unknown fields fail closed, while names such
// as "SHA-256", "64-bit", and "Physical Size can't be detected" retain the
// punctuation used by the real output.
const KNOWN_FIELDS = new Set([
  'Path',
  'Name',
  'Extension',
  'Folder',
  'Size',
  'Packed Size',
  'Attributes',
  'Created',
  'Accessed',
  'Modified',
  'Solid',
  'Commented',
  'Encrypted',
  'Split Before',
  'Split After',
  'Dictionary Size',
  'CRC',
  'Type',
  'Method',
  'Anti',
  'Host OS',
  'File System',
  'User',
  'Group',
  'Block',
  'Comment',
  'Position',
  'Path Prefix',
  'Folders',
  'Files',
  'Version',
  'Volume',
  'Multivolume',
  'Offset',
  'Links',
  'Blocks',
  'Volumes',
  'Volume Index',
  'Time Type',
  '64-bit',
  'Big-endian',
  'CPU',
  'Physical Size',
  'Headers Size',
  'Cluster Size',
  'Total Physical Size',
  'Checksum',
  'Characteristics',
  'Virtual Address',
  'ID',
  'Short Name',
  'Creator Application',
  'Sector Size',
  'Mode',
  'Error',
  'Total Size',
  'Free Space',
  'Label',
  'Local Name',
  'Provider',
  'NT Security',
  'Aux',
  'Deleted',
  'Tree',
  'SHA-1',
  'SHA-256',
  'Error Type',
  'Errors',
  'Warnings',
  'Warning',
  'Alternate Streams',
  'Alternate Streams Size',
  'Virtual Size',
  'Unpack Size',
  'SubType',
  'Short Comment',
  'Code Page',
  'Is not archive type',
  "Physical Size can't be detected",
  'Zeros Tail Is Allowed',
  'Tail Size',
  'Embedded Stub Size',
  'Link',
  'iNode',
  'Stream ID',
  'Read-only',
  'Out Name',
  'Copy Link',
  // These are explicitly rejected below rather than silently ignored.
  'Symbolic Link',
  'SymLink',
  'Hard Link',
  'Reparse Point',
  'Alternate Stream',
  'Alternate Stream Size',
  'Alternate Stream Name',
  'Stream',
  'Stream Size',
  'Streams',
  'SubStreams'
]);

const SPECIAL_ENTRY_FIELDS = new Set([
  'Link',
  'Links',
  'Copy Link',
  'Symbolic Link',
  'SymLink',
  'Hard Link',
  'Reparse Point',
  'Alternate Stream',
  'Alternate Stream Size',
  'Alternate Stream Name',
  'Alternate Streams',
  'Alternate Streams Size',
  'Stream',
  'Stream Size',
  'Streams',
  'SubStreams',
  'Anti'
]);

const HEADER_ONLY_FIELDS = new Set([
  'Type',
  'Physical Size',
  'Headers Size',
  'Solid',
  'Blocks',
  'Volumes',
  'Volume Index',
  'Offset',
  'Cluster Size',
  'Total Physical Size',
  'Tail Size',
  'Embedded Stub Size'
]);

const ENTRY_ONLY_FIELDS = new Set([
  'Name',
  'Extension',
  'Folder',
  'Size',
  'Packed Size',
  'Attributes',
  'Created',
  'Accessed',
  'Modified',
  'Commented',
  'Encrypted',
  'Split Before',
  'Split After',
  'Dictionary Size',
  'CRC',
  'Host OS',
  'File System',
  'User',
  'Group',
  'Block',
  'Comment',
  'Position',
  'Path Prefix',
  'Folders',
  'Files',
  'Version',
  'Volume',
  'Multivolume',
  'Time Type',
  '64-bit',
  'Big-endian',
  'CPU',
  'Checksum',
  'Characteristics',
  'Virtual Address',
  'ID',
  'Short Name',
  'Creator Application',
  'Sector Size',
  'Mode',
  'Error',
  'Total Size',
  'Free Space',
  'Label',
  'Local Name',
  'Provider',
  'NT Security',
  'Aux',
  'Deleted',
  'Tree',
  'SHA-1',
  'SHA-256',
  'Error Type',
  'Errors',
  'Warnings',
  'Warning',
  'Virtual Size',
  'Unpack Size',
  'SubType',
  'Short Comment',
  'Code Page',
  'Is not archive type',
  'Zeros Tail Is Allowed',
  'Read-only',
  'Out Name',
  'Stream ID'
]);

const UNSAFE_WINDOWS_PATH_CHARS = /[<>:"|?*]/u;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const HEX_CRC = /^[0-9A-Fa-f]{8}$/u;

function fail(code: ArchiveInspectionErrorCode, record?: number, field?: string): never {
  throw new ArchiveInspectionError(code, record, field);
}

function hasForbiddenUnicode(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return true;
    // C0/C1 controls, Unicode line separators, and all format characters.
    if ((codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028 || codePoint === 0x2029
      || (codePoint >= 0xe0000 && codePoint <= 0xe007f)
      || /\p{Cf}/u.test(character)) return true;
  }
  return false;
}

function assertWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail('ARCHIVE_OUTPUT_NOT_UTF8');
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail('ARCHIVE_OUTPUT_NOT_UTF8');
    }
  }
}

function decodeUtf8(output: SevenZipSltOutput): string {
  if (typeof output === 'string') {
    assertWellFormedUtf16(output);
    return output;
  }
  if (!(output instanceof Uint8Array)) fail('ARCHIVE_OUTPUT_INVALID');
  try {
    // ignoreBOM keeps a BOM visible; it is not valid 7za technical output and
    // is rejected by the strict record parser instead of being silently lost.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    fail('ARCHIVE_OUTPUT_NOT_UTF8');
  }
}

function isAllowedPreambleLine(line: string): boolean {
  return /^7-Zip (?:\([^\r\n)]+\)|\[[^\r\n\]]+\]) [^\r\n]+$/u.test(line)
    || line === 'Scanning the drive for archives:'
    || /^\d+ files?, [\d,]+ bytes \([^\r\n()]+\)$/u.test(line)
    || /^Listing archive: .+$/u.test(line);
}

function parseRecords(output: string): RawSltRecord[] {
  if (/\r(?!\n)/u.test(output)) fail('ARCHIVE_OUTPUT_INVALID');

  const records: RawSltRecord[] = [];
  let fields: Map<string, string> | undefined;
  let sawTechnicalLine = false;

  const flush = (): void => {
    if (fields === undefined) return;
    if (fields.size === 0) fail('ARCHIVE_RECORD_INVALID', records.length);
    records.push({ fields, record: records.length });
    fields = undefined;
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line === '--' || line === '----------') {
      flush();
      continue;
    }

    const match = /^(?<field>[0-9A-Za-z][0-9A-Za-z ._'~-]*) = (?<value>.*)$/u.exec(line);
    if (match?.groups === undefined) {
      if (!sawTechnicalLine && isAllowedPreambleLine(line)) continue;
      fail('ARCHIVE_RECORD_INVALID', records.length);
    }

    const field = match.groups.field;
    const value = match.groups.value;
    if (field === undefined || value === undefined) fail('ARCHIVE_RECORD_INVALID', records.length);
    sawTechnicalLine = true;
    if (!KNOWN_FIELDS.has(field)) fail('ARCHIVE_UNKNOWN_FIELD', records.length, field);
    if (field !== 'Path' && hasForbiddenUnicode(value)) fail('ARCHIVE_OUTPUT_INVALID', records.length, field);
    if (fields === undefined) fields = new Map();
    if (fields.has(field)) fail('ARCHIVE_DUPLICATE_FIELD', records.length, field);
    fields.set(field, value);
  }
  flush();

  if (records.length === 0) fail('ARCHIVE_EMPTY');
  return records;
}

function assertLimit(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('ARCHIVE_LIMITS_INVALID');
}

function chooseLimit(primary: number | undefined, alias: number | undefined, fallback: number): number {
  if (primary !== undefined && alias !== undefined && primary !== alias) fail('ARCHIVE_LIMITS_INVALID');
  const result = primary ?? alias ?? fallback;
  assertLimit(result);
  return result;
}

function normalizeLimits(options: ArchiveInspectionLimits | undefined): Required<Pick<ArchiveInspectionLimits, 'maxEntries' | 'maxFileSize' | 'maxTotalSize'>> {
  return {
    maxEntries: chooseLimit(options?.maxEntries, options?.maxEntryCount, DEFAULT_ARCHIVE_INSPECTION_LIMITS.maxEntries),
    maxFileSize: chooseLimit(options?.maxFileSize, options?.maxSingleFileSize, DEFAULT_ARCHIVE_INSPECTION_LIMITS.maxFileSize),
    maxTotalSize: chooseLimit(options?.maxTotalSize, options?.maxTotalUncompressedSize, DEFAULT_ARCHIVE_INSPECTION_LIMITS.maxTotalSize)
  };
}

function requiredField(fields: Map<string, string>, field: string, record: number): string {
  const value = fields.get(field);
  if (value === undefined) fail('ARCHIVE_RECORD_INVALID', record, field);
  return value;
}

function requiredHeaderField(fields: Map<string, string>, field: string, record: number): string {
  const value = fields.get(field);
  if (value === undefined) fail('ARCHIVE_HEADER_INVALID', record, field);
  return value;
}

function parseUnsigned(value: string, code: ArchiveInspectionErrorCode, record: number, field: string): number {
  if (!DECIMAL_INTEGER.test(value)) fail(code, record, field);
  let result = 0;
  for (const character of value) {
    const digit = character.charCodeAt(0) - 0x30;
    if (result > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) fail(code, record, field);
    result = result * 10 + digit;
  }
  return result;
}

function optionalUnsigned(fields: Map<string, string>, field: string, record: number): number | undefined {
  const value = fields.get(field);
  if (value === undefined || value === '') return undefined;
  return parseUnsigned(value, 'ARCHIVE_SIZE_INVALID', record, field);
}

function requireUnsigned(fields: Map<string, string>, field: string, record: number): number {
  return parseUnsigned(requiredField(fields, field, record), 'ARCHIVE_SIZE_INVALID', record, field);
}

function requireHeaderUnsigned(fields: Map<string, string>, field: string, record: number): number {
  const value = fields.get(field);
  if (value === undefined || !DECIMAL_INTEGER.test(value)) fail('ARCHIVE_HEADER_INVALID', record, field);
  return parseUnsigned(value, 'ARCHIVE_HEADER_INVALID', record, field);
}

function optionalHeaderUnsigned(fields: Map<string, string>, field: string, record: number): number | undefined {
  const value = fields.get(field);
  if (value === undefined || value === '') return undefined;
  if (!DECIMAL_INTEGER.test(value)) fail('ARCHIVE_HEADER_INVALID', record, field);
  return parseUnsigned(value, 'ARCHIVE_HEADER_INVALID', record, field);
}

function assertPlusMinus(fields: Map<string, string>, field: string, record: number): void {
  const value = fields.get(field);
  if (value !== undefined && value !== '+' && value !== '-') fail('ARCHIVE_RECORD_INVALID', record, field);
}

function collisionKeysForPath(normalizedPath: string): string[] {
  try {
    // Keep both forms in the collision set. This rejects an NFC spelling
    // colliding with an NFD spelling, including after Windows case folding.
    return [normalizedPath.normalize('NFC'), normalizedPath.normalize('NFD')]
      .map(value => value.toLocaleLowerCase('en-US'));
  } catch {
    return [];
  }
}

function pathPrefixes(normalizedPath: string): string[] {
  const components = normalizedPath.split('/');
  const prefixes: string[] = [];
  for (let index = 1; index < components.length; index += 1) {
    prefixes.push(components.slice(0, index).join('/'));
  }
  return prefixes;
}

function normalizeEntryPath(rawPath: string, record: number): { path: string; collisionKeys: string[] } {
  if (rawPath.length === 0 || hasForbiddenUnicode(rawPath)) fail('ARCHIVE_UNSAFE_PATH', record, 'Path');

  const withForwardSlashes = rawPath.replaceAll('\\', '/');
  if (withForwardSlashes.startsWith('/') || /^[A-Za-z]:/u.test(withForwardSlashes)) {
    fail('ARCHIVE_UNSAFE_PATH', record, 'Path');
  }

  const components = withForwardSlashes.split('/');
  if (components[components.length - 1] === '') components.pop();
  if (components.length === 0 || components.some(component => component.length === 0)) {
    fail('ARCHIVE_UNSAFE_PATH', record, 'Path');
  }

  for (const component of components) {
    if (component === '.' || component === '..' || component.endsWith('.') || component.endsWith(' ')
      || component.includes(':') || UNSAFE_WINDOWS_PATH_CHARS.test(component)) {
      fail('ARCHIVE_UNSAFE_PATH', record, 'Path');
    }
  }

  const normalizedPath = components.join('/');
  const collisionKeys = collisionKeysForPath(normalizedPath);
  if (collisionKeys.length === 0) fail('ARCHIVE_UNSAFE_PATH', record, 'Path');
  return { path: normalizedPath, collisionKeys };
}

interface IndexedArchivePath {
  readonly path: string;
  readonly isDirectory: boolean;
}

interface ArchivePathIndex {
  readonly explicitByAlias: Map<string, IndexedArchivePath>;
  readonly descendantPrefixesByAlias: Map<string, Set<string>>;
}

function createArchivePathIndex(): ArchivePathIndex {
  return {
    explicitByAlias: new Map(),
    descendantPrefixesByAlias: new Map()
  };
}

function assertPathCanBeIndexed(index: ArchivePathIndex, normalized: { path: string; collisionKeys: string[] }, isDirectory: boolean, record: number): void {
  // A duplicate full path, including a case/NFC/NFD alias, is never valid.
  if (normalized.collisionKeys.some(key => index.explicitByAlias.has(key))) {
    fail('ARCHIVE_PATH_COLLISION', record, 'Path');
  }

  // An explicit ancestor is allowed only when the spelling is exact and the
  // existing entry is a directory. A file ancestor or alias ancestor would
  // either make extraction impossible or merge two distinct archive paths.
  for (const prefix of pathPrefixes(normalized.path)) {
    for (const key of collisionKeysForPath(prefix)) {
      const ancestor = index.explicitByAlias.get(key);
      if (ancestor === undefined) continue;
      if (ancestor.path !== prefix || !ancestor.isDirectory) fail('ARCHIVE_PATH_COLLISION', record, 'Path');
    }
  }

  // If a descendant was listed first, the new entry is its ancestor. Apply
  // the same exact-directory rule in the reverse record order.
  for (const key of normalized.collisionKeys) {
    const descendantPrefixes = index.descendantPrefixesByAlias.get(key);
    if (descendantPrefixes === undefined) continue;
    for (const descendantPrefix of descendantPrefixes) {
      if (descendantPrefix !== normalized.path || !isDirectory) fail('ARCHIVE_PATH_COLLISION', record, 'Path');
    }
  }
}

function indexArchivePath(index: ArchivePathIndex, normalized: { path: string; collisionKeys: string[] }, isDirectory: boolean): void {
  const indexed: IndexedArchivePath = { path: normalized.path, isDirectory };
  for (const key of normalized.collisionKeys) index.explicitByAlias.set(key, indexed);
  for (const prefix of pathPrefixes(normalized.path)) {
    for (const key of collisionKeysForPath(prefix)) {
      let prefixes = index.descendantPrefixesByAlias.get(key);
      if (prefixes === undefined) {
        prefixes = new Set<string>();
        index.descendantPrefixesByAlias.set(key, prefixes);
      }
      prefixes.add(prefix);
    }
  }
}

function validateHeader(record: RawSltRecord): void {
  const { fields } = record;
  const path = requiredHeaderField(fields, 'Path', record.record);
  const type = requiredHeaderField(fields, 'Type', record.record);
  if (path.length === 0 || type.length === 0 || hasForbiddenUnicode(path) || hasForbiddenUnicode(type)) {
    fail('ARCHIVE_HEADER_INVALID', record.record);
  }
  requireHeaderUnsigned(fields, 'Physical Size', record.record);
  optionalHeaderUnsigned(fields, 'Headers Size', record.record);
  optionalHeaderUnsigned(fields, 'Blocks', record.record);
  optionalHeaderUnsigned(fields, 'Volumes', record.record);
  optionalHeaderUnsigned(fields, 'Volume Index', record.record);
  optionalHeaderUnsigned(fields, 'Offset', record.record);
  optionalHeaderUnsigned(fields, 'Cluster Size', record.record);
  optionalHeaderUnsigned(fields, 'Total Physical Size', record.record);
  optionalHeaderUnsigned(fields, 'Tail Size', record.record);
  optionalHeaderUnsigned(fields, 'Embedded Stub Size', record.record);
  assertPlusMinus(fields, 'Solid', record.record);

  for (const field of ENTRY_ONLY_FIELDS) {
    if (fields.has(field)) fail('ARCHIVE_HEADER_INVALID', record.record, field);
  }
  for (const field of SPECIAL_ENTRY_FIELDS) {
    if (fields.has(field)) fail('ARCHIVE_SPECIAL_ENTRY', record.record, field);
  }
}

function validateEntry(record: RawSltRecord, limits: Required<Pick<ArchiveInspectionLimits, 'maxEntries' | 'maxFileSize' | 'maxTotalSize'>>, pathIndex: ArchivePathIndex, totalSize: number): { entry: ArchiveInspectionEntry; totalSize: number } {
  const { fields } = record;
  for (const field of SPECIAL_ENTRY_FIELDS) {
    if (fields.has(field)) fail('ARCHIVE_SPECIAL_ENTRY', record.record, field);
  }

  const rawPath = requiredField(fields, 'Path', record.record);
  const normalized = normalizeEntryPath(rawPath, record.record);

  const size = requireUnsigned(fields, 'Size', record.record);
  if (size > limits.maxFileSize) fail('ARCHIVE_FILE_SIZE_EXCEEDED', record.record, 'Size');
  if (size > Number.MAX_SAFE_INTEGER - totalSize || size > limits.maxTotalSize - totalSize) {
    fail('ARCHIVE_TOTAL_SIZE_EXCEEDED', record.record, 'Size');
  }

  optionalUnsigned(fields, 'Packed Size', record.record);
  optionalUnsigned(fields, 'Block', record.record);
  assertPlusMinus(fields, 'Encrypted', record.record);
  const folder = fields.get('Folder');
  if (folder !== undefined && folder !== '+' && folder !== '-') fail('ARCHIVE_RECORD_INVALID', record.record, 'Folder');

  const attributes = fields.get('Attributes');
  if (attributes !== undefined) {
    if (!/^[A-Za-z0-9]+$/u.test(attributes)) fail('ARCHIVE_RECORD_INVALID', record.record, 'Attributes');
    if (/[Ll]/u.test(attributes)) fail('ARCHIVE_SPECIAL_ENTRY', record.record, 'Attributes');
  }
  if (fields.has('CRC')) {
    const crc = fields.get('CRC');
    if (crc !== undefined && crc !== '' && !HEX_CRC.test(crc)) fail('ARCHIVE_RECORD_INVALID', record.record, 'CRC');
  }

  const isDirectory = folder === '+' || attributes?.includes('D') === true;
  if (isDirectory && size !== 0) fail('ARCHIVE_RECORD_INVALID', record.record, 'Size');
  if (folder === '+' && attributes !== undefined && !attributes.includes('D')) {
    fail('ARCHIVE_RECORD_INVALID', record.record, 'Folder');
  }
  if (folder === '-' && attributes?.includes('D') === true) fail('ARCHIVE_RECORD_INVALID', record.record, 'Folder');

  assertPathCanBeIndexed(pathIndex, normalized, isDirectory, record.record);
  indexArchivePath(pathIndex, normalized, isDirectory);
  return {
    entry: { path: normalized.path, size, isDirectory },
    totalSize: totalSize + size
  };
}

/**
 * Parse and validate the UTF-8 technical output from `7za l -slt`.
 *
 * The function is deliberately pure: callers inject stdout (as a UTF-8
 * string or bytes), and this function performs no process, filesystem, or
 * extraction operation.
 */
export function parseSevenZipSlt(output: SevenZipSltOutput, options?: ArchiveInspectionLimits): ArchiveInspectionResult {
  const limits = normalizeLimits(options);
  const records = parseRecords(decodeUtf8(output));
  const entries: ArchiveInspectionEntry[] = [];
  const pathIndex = createArchivePathIndex();
  let totalSize = 0;

  const firstRecord = records[0];
  if (firstRecord === undefined) fail('ARCHIVE_EMPTY');
  validateHeader(firstRecord);

  for (const record of records.slice(1)) {
    const hasHeaderIndicator = [...HEADER_ONLY_FIELDS].some(field => record.fields.has(field));
    if (hasHeaderIndicator) fail('ARCHIVE_HEADER_INVALID', record.record);

    if (entries.length >= limits.maxEntries) fail('ARCHIVE_ENTRY_LIMIT_EXCEEDED', record.record);
    const validated = validateEntry(record, limits, pathIndex, totalSize);
    entries.push(validated.entry);
    totalSize = validated.totalSize;
  }

  if (entries.length === 0) fail('ARCHIVE_EMPTY');
  return Object.freeze({
    entries: Object.freeze(entries),
    entryCount: entries.length,
    totalSize,
    totalUncompressedSize: totalSize
  });
}

export type SevenZipSltCommandResult = SevenZipSltOutput | { readonly stdout: SevenZipSltOutput };
export type SevenZipSltRunner = (args: readonly string[]) => SevenZipSltCommandResult | Promise<SevenZipSltCommandResult>;

/**
 * Injectable adapter for the command boundary. The injected runner is the
 * only code that may execute 7za; this module only asks for `l -slt` output
 * with an explicit UTF-8 code page and then delegates to the pure parser.
 */
export async function inspectArchiveWith7za(
  archivePath: string,
  run7za: SevenZipSltRunner,
  options?: ArchiveInspectionLimits
): Promise<ArchiveInspectionResult> {
  if (typeof archivePath !== 'string' || archivePath.length === 0 || archivePath.includes('\0') || typeof run7za !== 'function') {
    fail('ARCHIVE_RUNNER_INVALID');
  }

  let result: SevenZipSltCommandResult;
  try {
    result = await run7za(['l', '-slt', '-sccUTF-8', archivePath]);
  } catch {
    fail('ARCHIVE_LIST_FAILED');
  }

  if (typeof result === 'object' && result !== null && 'stdout' in result) return parseSevenZipSlt(result.stdout, options);
  return parseSevenZipSlt(result, options);
}

export interface ExtractedTreeDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ExtractedTreeStats {
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Filesystem seam used by the scanner. The default implementation is the
 * real filesystem; the seam keeps reparse rejection testable without making
 * a symlink or junction on the host.
 */
export interface ExtractedTreeFilesystem {
  readonly lstat: (target: string) => Promise<ExtractedTreeStats>;
  readonly readdir: (directory: string) => Promise<readonly ExtractedTreeDirent[]>;
  readonly assertNoReparse?: (target: string) => void | Promise<void>;
}

const DEFAULT_EXTRACTED_TREE_FILESYSTEM: ExtractedTreeFilesystem = {
  lstat,
  readdir: async directory => readdir(directory, { withFileTypes: true }),
  assertNoReparse: assertNoWindowsReparseComponents
};

interface NormalizedExpectedEntry {
  readonly entry: ArchiveInspectionEntry;
  readonly path: string;
  readonly collisionKeys: readonly string[];
}

interface ActualTreeEntry {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly collisionKeys: readonly string[];
}

function normalizeExpectedEntries(expectedEntries: readonly ArchiveInspectionEntry[]): NormalizedExpectedEntry[] {
  if (!Array.isArray(expectedEntries)) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');

  const normalizedEntries: NormalizedExpectedEntry[] = [];
  const pathIndex = createArchivePathIndex();

  for (let index = 0; index < expectedEntries.length; index += 1) {
    const candidate = expectedEntries[index];
    if (candidate === undefined || candidate === null || typeof candidate.path !== 'string'
      || typeof candidate.isDirectory !== 'boolean' || !Number.isSafeInteger(candidate.size) || candidate.size < 0) {
      fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
    }
    if (candidate.isDirectory && candidate.size !== 0) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');

    const normalized = normalizeEntryPath(candidate.path, index);
    assertPathCanBeIndexed(pathIndex, normalized, candidate.isDirectory, index);
    indexArchivePath(pathIndex, normalized, candidate.isDirectory);
    normalizedEntries.push({ entry: candidate, path: normalized.path, collisionKeys: normalized.collisionKeys });
  }
  return normalizedEntries;
}

async function assertExtractedPathNoReparse(filesystem: ExtractedTreeFilesystem, target: string): Promise<void> {
  try {
    await filesystem.assertNoReparse?.(target);
  } catch {
    fail('ARCHIVE_EXTRACTED_REPARSE');
  }
}

/**
 * Enumerate the extracted tree without following links or other reparse
 * points, and require an exact path/type/size match with the archive listing.
 * This is intentionally separate from extraction: callers must invoke it
 * after 7za has finished writing the staging directory.
 */
export async function scanExtractedTreeNoReparse(
  staging: string,
  expectedEntries: readonly ArchiveInspectionEntry[],
  filesystem: ExtractedTreeFilesystem = DEFAULT_EXTRACTED_TREE_FILESYSTEM
): Promise<void> {
  if (typeof staging !== 'string' || staging.length === 0 || staging.includes('\0')) {
    fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
  }

  const normalizedExpected = normalizeExpectedEntries(expectedEntries);
  const expectedByKey = new Map<string, NormalizedExpectedEntry>();
  for (const expected of normalizedExpected) {
    for (const key of expected.collisionKeys) expectedByKey.set(key, expected);
  }

  let root: string;
  try {
    root = path.resolve(staging);
  } catch {
    fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
  }

  let rootStats: ExtractedTreeStats;
  try {
    await assertExtractedPathNoReparse(filesystem, root);
    rootStats = await filesystem.lstat(root);
  } catch (error) {
    if (error instanceof ArchiveInspectionError) throw error;
    fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
  }
  if (rootStats.isSymbolicLink()) fail('ARCHIVE_EXTRACTED_REPARSE');
  if (!rootStats.isDirectory()) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');

  const actualEntries: ActualTreeEntry[] = [];
  const actualByKey = new Map<string, ActualTreeEntry>();
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');

    let children: readonly ExtractedTreeDirent[];
    try {
      children = await filesystem.readdir(directory);
    } catch {
      fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
    }

    for (const child of children) {
      if (typeof child.name !== 'string' || child.name.length === 0 || child.name === '.' || child.name === '..'
        || child.name.includes('/') || child.name.includes('\\') || child.name.includes('\0')) {
        fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
      }

      const absolute = path.join(directory, child.name);
      await assertExtractedPathNoReparse(filesystem, absolute);
      if (child.isSymbolicLink()) fail('ARCHIVE_EXTRACTED_REPARSE');

      let stats: ExtractedTreeStats;
      try {
        stats = await filesystem.lstat(absolute);
      } catch {
        fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
      }
      if (stats.isSymbolicLink()) fail('ARCHIVE_EXTRACTED_REPARSE');

      const isDirectory = stats.isDirectory();
      const isFile = stats.isFile();
      if (!isDirectory && !isFile) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');
      if (!Number.isSafeInteger(stats.size) || stats.size < 0) fail('ARCHIVE_EXTRACTED_SCAN_FAILED');

      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      let normalized: { path: string; collisionKeys: string[] };
      try {
        normalized = normalizeEntryPath(relative, 0);
      } catch {
        fail('ARCHIVE_EXTRACTED_EXTRA');
      }
      if (normalized.collisionKeys.some(key => actualByKey.has(key))) fail('ARCHIVE_EXTRACTED_EXTRA');

      const actual: ActualTreeEntry = {
        path: normalized.path,
        size: stats.size,
        isDirectory,
        collisionKeys: normalized.collisionKeys
      };
      actualEntries.push(actual);
      for (const key of actual.collisionKeys) actualByKey.set(key, actual);
      if (isDirectory) pendingDirectories.push(absolute);
    }
  }

  const matchedExpected = new Set<NormalizedExpectedEntry>();
  for (const actual of actualEntries) {
    const expected = actual.collisionKeys.map(key => expectedByKey.get(key)).find(value => value !== undefined);
    if (expected === undefined) fail('ARCHIVE_EXTRACTED_EXTRA');
    matchedExpected.add(expected);
    if (actual.isDirectory !== expected.entry.isDirectory) fail('ARCHIVE_EXTRACTED_TYPE_MISMATCH');
    if (!actual.isDirectory && actual.size !== expected.entry.size) fail('ARCHIVE_EXTRACTED_SIZE_MISMATCH');
  }

  if (matchedExpected.size !== normalizedExpected.length) fail('ARCHIVE_EXTRACTED_MISSING');
}

// Friendly aliases for callers that use the executable's name in the API.
export const parse7zaSlt = parseSevenZipSlt;
export const inspect7zaSlt = parseSevenZipSlt;
