#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultWinUnpacked = path.join('dist', 'win-unpacked');

const mockServerName = '@deepseek-ai/dsh-llm-mock-server';
const mockServerPrefix = `node_modules/${mockServerName}`;
const requiredAsarFiles = [
  'out/main.js',
  'out/runtime-staging-smoke.js',
  `${mockServerPrefix}/package.json`,
  `${mockServerPrefix}/lib/index.js`,
  `${mockServerPrefix}/lib/invariant.js`
];
const requiredResourceFiles = [
  'node-runtime/node.exe',
  'supervisor/supervisor.mjs',
  'tools/7za.exe'
];
const requiredRuntimeFiles = [
  'package.json',
  'package-lock.json',
  'bin/node.cmd',
  'bin/pnpm.cmd',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-subprocess-local/package.json',
  'node_modules/node-pty/package.json',
  'node_modules/pnpm/package.json',
  'node_modules/pnpm/bin/pnpm.cjs'
];
const requiredArchiveEntries = [
  'node-runtime/node.exe',
  'dsh-runtime/package.json',
  'dsh-runtime/package-lock.json',
  'dsh-runtime/bin/node.cmd',
  'dsh-runtime/bin/pnpm.cmd',
  'dsh-runtime/node_modules/@deepseek-ai/dsh/package.json',
  'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'dsh-runtime/node_modules/@deepseek-ai/dsh-subprocess-local/package.json',
  'dsh-runtime/node_modules/node-pty/package.json',
  'dsh-runtime/node_modules/pnpm/package.json',
  'dsh-runtime/node_modules/pnpm/bin/pnpm.cjs'
];

function fail(code, detail) {
  throw new Error(`${code}${detail ? `: ${detail}` : ''}`);
}

function normalizeEntry(value) {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
}

function isMockServerEntry(value) {
  const entry = `/${normalizeEntry(value).toLowerCase()}/`;
  const needle = `/${mockServerName.toLowerCase()}/`;
  return entry.includes(needle);
}

function parseArgs(argv) {
  let rootArg;
  let mode = 'auto';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/verify-package-closure.mjs [win-unpacked] [--mode setup|portable]');
      process.exit(0);
    }
    if (argument === '--mode') {
      mode = argv[index + 1] ?? '';
      index += 1;
    } else if (argument?.startsWith('--mode=')) {
      mode = argument.slice('--mode='.length);
    } else if (argument?.startsWith('-')) {
      fail('PACKAGE_CLOSURE_USAGE', `unknown option ${argument}`);
    } else if (rootArg === undefined) {
      rootArg = argument;
    } else {
      fail('PACKAGE_CLOSURE_USAGE', `unexpected argument ${argument}`);
    }
  }

  if (mode !== 'auto' && mode !== 'setup' && mode !== 'portable') {
    fail('PACKAGE_CLOSURE_USAGE', `invalid mode ${mode}; expected setup or portable`);
  }
  return { root: path.resolve(rootArg ?? defaultWinUnpacked), mode };
}

async function existingInfo(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireDirectory(filename, label) {
  const info = await existingInfo(filename);
  if (!info?.isDirectory()) fail('PACKAGE_CLOSURE_MISSING_DIRECTORY', `${label}: ${filename}`);
}

async function requireFile(filename, label, allowEmpty = false) {
  const info = await existingInfo(filename);
  if (!info?.isFile()) fail('PACKAGE_CLOSURE_MISSING_FILE', `${label}: ${filename}`);
  if (!allowEmpty && info.size === 0) fail('PACKAGE_CLOSURE_EMPTY_FILE', `${label}: ${filename}`);
}

async function requireAbsent(filename, label) {
  const info = await existingInfo(filename);
  if (info) fail('PACKAGE_CLOSURE_UNEXPECTED_PATH', `${label}: ${filename}`);
}

async function readJson(filename, label) {
  await requireFile(filename, label);
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    fail('PACKAGE_CLOSURE_INVALID_JSON', `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readFully(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) fail('PACKAGE_CLOSURE_INVALID_ASAR', 'truncated archive');
    offset += result.bytesRead;
  }
}

async function readAsarHeader(handle) {
  const sizeBuffer = Buffer.alloc(8);
  await readFully(handle, sizeBuffer, 0);
  const headerSize = sizeBuffer.readUInt32LE(4);
  if (headerSize < 8 || headerSize > 128 * 1024 * 1024) fail('PACKAGE_CLOSURE_INVALID_ASAR', 'invalid header size');

  const headerBuffer = Buffer.alloc(headerSize);
  await readFully(handle, headerBuffer, 8);
  const payloadSize = headerBuffer.readUInt32LE(0);
  const jsonSize = headerBuffer.readInt32LE(4);
  if (payloadSize > headerBuffer.length || jsonSize < 0 || jsonSize > headerBuffer.length - 8) {
    fail('PACKAGE_CLOSURE_INVALID_ASAR', 'invalid header pickle');
  }

  let header;
  try {
    header = JSON.parse(headerBuffer.subarray(8, 8 + jsonSize).toString('utf8'));
  } catch (error) {
    fail('PACKAGE_CLOSURE_INVALID_ASAR', `invalid header JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
    fail('PACKAGE_CLOSURE_INVALID_ASAR', 'header has no file tree');
  }

  const entries = new Map();
  const visit = (node, prefix) => {
    if (!node || typeof node !== 'object' || !node.files || typeof node.files !== 'object') return;
    for (const [name, child] of Object.entries(node.files)) {
      if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        fail('PACKAGE_CLOSURE_INVALID_ASAR', `invalid entry name ${name}`);
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (child && typeof child === 'object' && child.files && typeof child.files === 'object') visit(child, relative);
      else entries.set(normalizeEntry(relative), child);
    }
  };
  visit(header, '');
  const archiveSize = Number((await handle.stat()).size);
  if (!Number.isSafeInteger(archiveSize)) fail('PACKAGE_CLOSURE_INVALID_ASAR', 'archive is too large');
  return { entries, dataOffset: 8 + headerSize, archiveSize };
}

async function readAsarFile(handle, archiveInfo, relativePath) {
  const normalized = normalizeEntry(relativePath);
  const info = archiveInfo.entries.get(normalized);
  if (!info) fail('PACKAGE_CLOSURE_MISSING_ASAR_FILE', normalized);
  if (info.unpacked || info.link || info.files) fail('PACKAGE_CLOSURE_INVALID_ASAR_FILE', normalized);
  const size = Number(info.size);
  const offset = Number(info.offset);
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
    fail('PACKAGE_CLOSURE_INVALID_ASAR_FILE', normalized);
  }
  const start = archiveInfo.dataOffset + offset;
  if (start < 0 || start + size > archiveInfo.archiveSize) fail('PACKAGE_CLOSURE_INVALID_ASAR_FILE', normalized);
  const content = Buffer.alloc(size);
  await readFully(handle, content, start);
  return content;
}

function packageRelativePath(value) {
  if (typeof value !== 'string') return undefined;
  const relative = normalizeEntry(value.startsWith('./') ? value.slice(2) : value);
  if (!relative || relative.includes('..') || value.startsWith('/')) return undefined;
  return relative;
}

function collectExportTargets(value, targets) {
  if (typeof value === 'string') {
    const relative = packageRelativePath(value);
    if (relative?.startsWith('lib/') && !relative.endsWith('.d.ts')) targets.add(relative);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExportTargets(item, targets);
  }
}

function verifyMockServerLibFiles(entries) {
  const libEntries = [...entries].filter(entry => entry.startsWith(`${mockServerPrefix}/lib/`));
  if (libEntries.length === 0) fail('PACKAGE_CLOSURE_MOCK_SERVER_LIB_MISSING');
}

async function verifyAppAsar(archive) {
  let handle;
  try {
    handle = await open(archive, 'r');
    const archiveInfo = await readAsarHeader(handle);
    const entries = new Set(archiveInfo.entries.keys());
    for (const relativePath of requiredAsarFiles) await readAsarFile(handle, archiveInfo, relativePath);
    const packageBytes = await readAsarFile(handle, archiveInfo, `${mockServerPrefix}/package.json`);
    let packageInfo;
    try {
      packageInfo = JSON.parse(packageBytes.toString('utf8'));
    } catch (error) {
      fail('PACKAGE_CLOSURE_INVALID_MOCK_SERVER_PACKAGE', error instanceof Error ? error.message : String(error));
    }
    if (packageInfo.name !== mockServerName) fail('PACKAGE_CLOSURE_MOCK_SERVER_PACKAGE_MISMATCH', 'package name');
    const main = packageRelativePath(packageInfo.main);
    if (!main) fail('PACKAGE_CLOSURE_MOCK_SERVER_MAIN_MISSING');
    await readAsarFile(handle, archiveInfo, `${mockServerPrefix}/${main}`);
    const exportTargets = new Set();
    collectExportTargets(packageInfo.exports, exportTargets);
    for (const target of exportTargets) await readAsarFile(handle, archiveInfo, `${mockServerPrefix}/${target}`);
    verifyMockServerLibFiles(entries);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PACKAGE_CLOSURE_')) throw error;
    fail('PACKAGE_CLOSURE_INVALID_ASAR', error instanceof Error ? error.message : String(error));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function rejectMockServerInDirectory(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch (error) {
      fail('PACKAGE_CLOSURE_RUNTIME_WALK_FAILED', `${current}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const child of children) {
      const childPath = path.join(current, child.name);
      const relative = normalizeEntry(path.relative(directory, childPath));
      if (isMockServerEntry(relative)) fail('PACKAGE_CLOSURE_MOCK_SERVER_IN_RUNTIME', relative);
      if (child.isDirectory()) pending.push(childPath);
    }
  }
}

async function verifyRuntimeMetadata(runtimeRoot) {
  const manifest = await readJson(path.join(runtimeRoot, 'package.json'), 'dsh-runtime/package.json');
  const lock = await readJson(path.join(runtimeRoot, 'package-lock.json'), 'dsh-runtime/package-lock.json');
  const lockPackages = lock?.packages;
  const lockRoot = lockPackages?.[''];
  if (lock?.lockfileVersion !== 3 || !lockPackages || !lockRoot || !manifest?.dependencies) {
    fail('PACKAGE_CLOSURE_RUNTIME_METADATA_INCOMPLETE');
  }
  if (manifest.name !== lockRoot.name || manifest.version !== lockRoot.version) {
    fail('PACKAGE_CLOSURE_RUNTIME_METADATA_MISMATCH', 'root package');
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lockRoot.dependencies?.[name] !== version) fail('PACKAGE_CLOSURE_RUNTIME_METADATA_MISMATCH', name);
  }
  for (const name of Object.keys(lockRoot.dependencies ?? {})) {
    if (manifest.dependencies[name] === undefined) fail('PACKAGE_CLOSURE_RUNTIME_METADATA_MISMATCH', name);
  }

  const packageChecks = [
    ['node_modules/@deepseek-ai/dsh', '@deepseek-ai/dsh'],
    ['node_modules/@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-subprocess-local'],
    ['node_modules/node-pty', 'node-pty'],
    ['node_modules/pnpm', 'pnpm']
  ];
  for (const [relativePath, expectedName] of packageChecks) {
    const packageInfo = await readJson(path.join(runtimeRoot, relativePath, 'package.json'), `${relativePath}/package.json`);
    if (packageInfo.name !== expectedName) fail('PACKAGE_CLOSURE_RUNTIME_PACKAGE_MISMATCH', relativePath);
    const lockEntry = lockPackages[relativePath];
    if (!lockEntry || packageInfo.version !== lockEntry.version) fail('PACKAGE_CLOSURE_RUNTIME_LOCK_MISMATCH', relativePath);
  }
}

async function verifyExpandedRuntime(resources) {
  const runtimeRoot = path.join(resources, 'dsh-runtime');
  await requireDirectory(runtimeRoot, 'resources/dsh-runtime');
  for (const relativePath of requiredRuntimeFiles) {
    await requireFile(path.join(runtimeRoot, ...relativePath.split('/')), `resources/dsh-runtime/${relativePath}`);
  }
  await verifyRuntimeMetadata(runtimeRoot);
  await rejectMockServerInDirectory(runtimeRoot);
}

function archiveEntries(output) {
  const entries = new Set();
  for (const match of output.matchAll(/^Path = (.+)$/gmu)) {
    const entry = normalizeEntry(match[1]);
    if (entry) entries.add(entry);
  }
  return entries;
}

async function verifyRuntimeArchive(resources) {
  const archive = path.join(resources, 'dsh-runtime.7z');
  await requireFile(archive, 'resources/dsh-runtime.7z');
  const sevenZip = path.join(resources, 'tools', '7za.exe');
  try {
    const result = await execFileAsync(sevenZip, ['l', '-slt', archive], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024
    });
    const entries = archiveEntries(result.stdout);
    for (const relativePath of requiredArchiveEntries) {
      if (!entries.has(relativePath)) fail('PACKAGE_CLOSURE_MISSING_ARCHIVE_ENTRY', relativePath);
    }
    for (const entry of entries) {
      if (isMockServerEntry(entry)) fail('PACKAGE_CLOSURE_MOCK_SERVER_IN_RUNTIME', entry);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PACKAGE_CLOSURE_')) throw error;
    fail('PACKAGE_CLOSURE_INVALID_RUNTIME_ARCHIVE', error instanceof Error ? error.message : String(error));
  }
}

async function detectMode(resources) {
  const marker = await existingInfo(path.join(resources, 'portable.marker'));
  const expanded = await existingInfo(path.join(resources, 'dsh-runtime'));
  const archive = await existingInfo(path.join(resources, 'dsh-runtime.7z'));
  if (expanded?.isDirectory() && !archive) return 'portable';
  if (archive?.isFile() && !expanded) return 'setup';
  if (marker) return 'portable';
  fail('PACKAGE_CLOSURE_MODE_UNDETERMINED');
}

async function verifyMode(resources, requestedMode) {
  const mode = requestedMode === 'auto' ? await detectMode(resources) : requestedMode;
  const marker = path.join(resources, 'portable.marker');
  const expanded = path.join(resources, 'dsh-runtime');
  const archive = path.join(resources, 'dsh-runtime.7z');
  if (mode === 'portable') {
    await requireFile(marker, 'portable marker', true);
    await requireAbsent(archive, 'setup runtime archive in portable package');
    await verifyExpandedRuntime(resources);
  } else {
    await requireAbsent(marker, 'portable marker in setup package');
    await requireAbsent(expanded, 'expanded runtime in setup package');
    await verifyRuntimeArchive(resources);
  }
  return mode;
}

async function main() {
  const { root, mode: requestedMode } = parseArgs(process.argv.slice(2));
  await requireDirectory(root, 'win-unpacked root');
  const resources = path.join(root, 'resources');
  await requireDirectory(resources, 'resources');
  await requireFile(path.join(resources, 'app.asar'), 'resources/app.asar');
  for (const relativePath of requiredResourceFiles) {
    await requireFile(path.join(resources, ...relativePath.split('/')), `resources/${relativePath}`);
  }
  await verifyAppAsar(path.join(resources, 'app.asar'));
  const mode = await verifyMode(resources, requestedMode);
  console.log(`PACKAGE_CLOSURE_OK mode=${mode}`);
}

try {
  await main();
} catch (error) {
  console.error(`PACKAGE_CLOSURE_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
