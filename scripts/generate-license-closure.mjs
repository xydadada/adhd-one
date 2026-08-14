import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportPath = path.join(root, 'build', 'licenses', 'license-closure.json');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const schemaVersion = 2;
const generatorName = 'scripts/generate-license-closure.mjs';
const licenseTextFileName = 'THIRD_PARTY_LICENSES.txt';
const appAllowedLicenses = new Set([
  'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'ISC', 'MIT', 'Python-2.0'
]);
const runtimeAllowedLicenses = new Set([
  ...appAllowedLicenses,
  '0BSD', 'Apache-2.0 AND LGPL-3.0-or-later', 'LGPL-3.0-or-later'
]);
const knownLicenseAtoms = new Set([
  ...appAllowedLicenses,
  '0BSD', 'LGPL-3.0-or-later'
]);
const packageResourcePattern = /^(?:licen[cs]e|copying|notice|unlicense|patent|readme)(?:[._ -]|$)/iu;
const primaryLicenseResourcePattern = /^(?:licen[cs]e|copying|notice|unlicense|patent)(?:[._ -]|$)/iu;
const fallbackLicenseTexts = new Map([
  ['BlueOak-1.0.0', `Blue Oak Model License 1.0.0

This license permits use, reproduction, modification, distribution, and sublicensing
of the licensed work, subject to retaining copyright and license notices and to the
conditions stated in the Blue Oak Model License 1.0.0. The licensor provides the work
as-is, without warranty, and disclaims liability to the maximum extent permitted by
law.

Canonical license text: https://blueoakcouncil.org/license/1.0.0`]
]);

function fail(code, detail = '') {
  throw new Error(`${code}${detail ? `:${detail}` : ''}`);
}

function parseOption(name) {
  const indexes = args.reduce((result, argument, index) => argument === name ? [...result, index] : result, []);
  if (indexes.length > 1) fail('LICENSE_CLOSURE_USAGE', `${name} may be specified only once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail('LICENSE_CLOSURE_USAGE', `${name} requires a value`);
  return value;
}

const valueOptions = new Set(['--app-node-modules', '--runtime-node-modules', '--output', '--package-root']);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--check') continue;
  if (valueOptions.has(argument)) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail('LICENSE_CLOSURE_USAGE', `${argument} requires a value`);
    index += 1;
    continue;
  }
  fail('LICENSE_CLOSURE_USAGE', `unknown option ${argument}`);
}

const appNodeModules = path.resolve(root, parseOption('--app-node-modules') ?? 'node_modules');
const runtimeNodeModules = path.resolve(root, parseOption('--runtime-node-modules') ?? path.join('runtime', 'node_modules'));
const reportPath = path.resolve(root, parseOption('--output') ?? path.relative(root, defaultReportPath));
const licenseTextPath = path.join(path.dirname(reportPath), licenseTextFileName);
const packageRootOption = parseOption('--package-root');
const packageRoot = packageRootOption === undefined ? undefined : path.resolve(root, packageRootOption);
if (packageRoot && !checkOnly) fail('LICENSE_CLOSURE_USAGE', '--package-root requires --check');

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sortedBytewise(values) {
  return [...values].sort(bytewiseCompare);
}

function slash(filename) {
  return filename.replaceAll('\\', '/');
}

function comparablePath(filename) {
  const normalized = path.normalize(path.resolve(filename));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSamePhysicalPath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isWithin(filename, parent) {
  const relative = path.relative(comparablePath(parent), comparablePath(filename));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativePath(base, filename) {
  if (!isWithin(filename, base)) fail('LICENSE_CLOSURE_PATH_ESCAPE', `${filename} outside ${base}`);
  return slash(path.relative(base, filename));
}

function isSafeRelativePath(filename) {
  return typeof filename === 'string' && filename.length > 0 && !filename.startsWith('/')
    && !/^[A-Za-z]:[\\/]/u.test(filename)
    && !filename.split('/').includes('..');
}

async function physicalStat(filename, code, allowMissing = false) {
  let info;
  try {
    info = await fs.lstat(filename);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return undefined;
    fail(code, `${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink()) fail('LICENSE_CLOSURE_REPARSE_POINT', filename);
  if (!info.isFile() && !info.isDirectory()) fail('LICENSE_CLOSURE_UNSUPPORTED_ENTRY', filename);
  let realPath;
  try {
    realPath = await fs.realpath(filename);
  } catch (error) {
    fail('LICENSE_CLOSURE_PHYSICAL_WALK_FAILED', `${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isSamePhysicalPath(filename, realPath)) {
    fail('LICENSE_CLOSURE_REPARSE_POINT', `${filename}->${realPath}`);
  }
  return info;
}

async function exists(filename) {
  return Boolean(await physicalStat(filename, 'LICENSE_CLOSURE_PHYSICAL_STAT_FAILED', true));
}

async function isDirectory(filename) {
  const info = await physicalStat(filename, 'LICENSE_CLOSURE_PHYSICAL_STAT_FAILED', true);
  return Boolean(info?.isDirectory());
}

async function physicalEntries(directory) {
  const info = await physicalStat(directory, 'LICENSE_CLOSURE_PHYSICAL_WALK_FAILED');
  if (!info.isDirectory()) fail('LICENSE_CLOSURE_PHYSICAL_ROOT_NOT_DIRECTORY', directory);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail('LICENSE_CLOSURE_PHYSICAL_WALK_FAILED', `${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = [];
  for (const entry of sortedBytewise(entries.map(value => value.name))) {
    const entryPath = path.join(directory, entry);
    const entryInfo = await physicalStat(entryPath, 'LICENSE_CLOSURE_PHYSICAL_WALK_FAILED');
    result.push({ name: entry, path: entryPath, info: entryInfo });
  }
  return result;
}

async function readJson(filename, code) {
  await physicalStat(filename, code);
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    fail(code, `${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readText(filename, code) {
  const info = await physicalStat(filename, code);
  if (!info.isFile()) fail(code, `${filename} is not a file`);
  try {
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    fail(code, `${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeText(value) {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd();
  return `${normalized}\n`;
}

function normalizeLicense(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    const values = raw.map(value => {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim();
      return '';
    }).filter(Boolean);
    return values.length > 0 ? values.join(' AND ') : undefined;
  }
  if (raw && typeof raw === 'object' && typeof raw.type === 'string') return raw.type.trim();
  return undefined;
}

function licenseAtoms(expression) {
  return expression
    .replace(/[()]/gu, '')
    .split(/\s+(?:AND|OR|WITH)\s+/iu)
    .map(value => value.trim())
    .filter(Boolean);
}

function allowedLicensesForScope(scope) {
  return scope === 'app-production' ? appAllowedLicenses : runtimeAllowedLicenses;
}

function validateLicenseDeclaration(license, packageName, packageDir, packageFiles, scope) {
  if (!license || /^(?:unknown|unlicensed|none|proprietary)$/iu.test(license)) {
    fail('LICENSE_CLOSURE_LICENSE_MISSING', `${packageName} at ${packageDir}`);
  }
  const seeLicense = /^SEE LICENSE IN\s+(.+)$/iu.exec(license);
  if (seeLicense) {
    const referenced = seeLicense[1].trim();
    const normalized = referenced.replaceAll('\\', '/');
    if (!packageFiles.some(filename => filename === referenced || filename === normalized || filename.endsWith(`/${normalized}`))) {
      fail('LICENSE_CLOSURE_LICENSE_RESOURCE_MISSING', `${packageName}: ${referenced}`);
    }
    fail('LICENSE_CLOSURE_LICENSE_POLICY', `${packageName}: custom SEE LICENSE IN declarations are not allowlisted`);
  }
  for (const atom of licenseAtoms(license)) {
    if (!knownLicenseAtoms.has(atom)) fail('LICENSE_CLOSURE_LICENSE_UNKNOWN', `${packageName}: ${license}`);
  }
  if (!allowedLicensesForScope(scope).has(license)) {
    fail('LICENSE_CLOSURE_LICENSE_POLICY', `${packageName}: ${license} in ${scope}`);
  }
}

async function packageDirectories(nodeModulesDir) {
  const rootInfo = await physicalStat(nodeModulesDir, 'LICENSE_CLOSURE_PHYSICAL_ROOT_MISSING', true);
  if (!rootInfo) fail('LICENSE_CLOSURE_PHYSICAL_ROOT_MISSING', nodeModulesDir);
  if (!rootInfo.isDirectory()) fail('LICENSE_CLOSURE_PHYSICAL_ROOT_NOT_DIRECTORY', nodeModulesDir);
  const result = [];
  for (const entry of await physicalEntries(nodeModulesDir)) {
    if (!entry.info.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of await physicalEntries(entry.path)) {
        if (!scopedEntry.info.isDirectory() || scopedEntry.name.startsWith('.')) continue;
        const packageDir = scopedEntry.path;
        if (!(await exists(path.join(packageDir, 'package.json')))) {
          fail('LICENSE_CLOSURE_PACKAGE_METADATA_MISSING', packageDir);
        }
        result.push(packageDir);
      }
      continue;
    }
    if (!(await exists(path.join(entry.path, 'package.json')))) {
      fail('LICENSE_CLOSURE_PACKAGE_METADATA_MISSING', entry.path);
    }
    result.push(entry.path);
  }
  return result;
}

async function nestedNodeModules(packageDir) {
  const result = [];
  async function visit(directory) {
    for (const entry of await physicalEntries(directory)) {
      if (!entry.info.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') {
        result.push(entry.path);
        continue;
      }
      await visit(entry.path);
    }
  }
  await visit(packageDir);
  return result;
}

function packageKey(entry) {
  return `${entry.name}@${entry.version}|${entry.license}`;
}

function sortedPackageKeys(entries) {
  return entries.map(packageKey).sort(bytewiseCompare);
}

function packageKeyListsEqual(left, right) {
  return JSON.stringify(sortedPackageKeys(left)) === JSON.stringify(sortedPackageKeys(right));
}

function stablePackages(report) {
  return JSON.stringify(report.packages.map(packageEntry => ({
    scope: packageEntry.scope,
    name: packageEntry.name,
    version: packageEntry.version,
    license: packageEntry.license,
    path: packageEntry.path,
    integrity: packageEntry.integrity ?? null,
    licenseResources: packageEntry.licenseResources,
    licenseTextId: packageEntry.licenseTextId
  })));
}

function stableReport(report) {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    generator: report.generator,
    platform: report.platform,
    arch: report.arch,
    roots: report.roots,
    licenses: report.licenses,
    licenseTextFile: report.licenseTextFile,
    licenseTextSha256: report.licenseTextSha256,
    licenseTextBytes: report.licenseTextBytes,
    packages: JSON.parse(stablePackages(report))
  });
}

async function loadLockfile(filename) {
  const lock = await readJson(filename, 'LICENSE_CLOSURE_LOCKFILE_INVALID');
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    fail('LICENSE_CLOSURE_LOCKFILE_UNSUPPORTED', filename);
  }
  return lock;
}

async function packageDirectoryExists(candidate) {
  const info = await physicalStat(candidate, 'LICENSE_CLOSURE_PHYSICAL_STAT_FAILED', true);
  if (!info) return false;
  if (!info.isDirectory()) fail('LICENSE_CLOSURE_PACKAGE_NOT_DIRECTORY', candidate);
  const manifestInfo = await physicalStat(path.join(candidate, 'package.json'), 'LICENSE_CLOSURE_PHYSICAL_STAT_FAILED', true);
  return Boolean(manifestInfo?.isFile());
}

async function resolvePackage(fromDir, packageName, physicalRoot) {
  let current = fromDir;
  while (true) {
    if (path.basename(current) !== 'node_modules') {
      const candidate = path.join(current, 'node_modules', ...packageName.split('/'));
      if (isWithin(candidate, physicalRoot) && await packageDirectoryExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current || !isWithin(parent, physicalRoot)) break;
    current = parent;
  }
  return undefined;
}

function isPrunedRuntimePath(filename, context) {
  if (!['runtime', 'vendor', 'dist'].includes(context.scope)) return false;
  const relative = relativePath(context.logicalRoot, filename);
  return /(?:^|\/)node_modules\/pnpm\/artifacts(?:\/|$)/u.test(relative)
    || /(?:^|\/)node_modules\/pnpm\/dist\/node_modules\/@reflink\/(?:reflink-darwin-arm64|reflink-darwin-x64|reflink-win32-arm64-msvc)(?:\/|$)/u.test(relative);
}

function makeLicenseTextId(scope, relative) {
  return `${scope}/${relative}`;
}

async function addPackage(packageDir, context) {
  await physicalStat(packageDir, 'LICENSE_CLOSURE_PHYSICAL_WALK_FAILED');
  const realDir = await fs.realpath(packageDir).catch(error => {
    fail('LICENSE_CLOSURE_PHYSICAL_WALK_FAILED', `${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const identity = `${context.scope}:${comparablePath(realDir)}`;
  if (context.seen.has(identity)) return context.seen.get(identity);

  const packageJsonPath = path.join(packageDir, 'package.json');
  const manifest = await readJson(packageJsonPath, 'LICENSE_CLOSURE_PACKAGE_METADATA_INVALID');
  if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) {
    fail('LICENSE_CLOSURE_PACKAGE_METADATA_INCOMPLETE', packageJsonPath);
  }
  const license = normalizeLicense(manifest.license ?? manifest.licenses);
  const packageEntries = await physicalEntries(packageDir);
  const packageFiles = packageEntries.filter(entry => entry.info.isFile()).map(entry => entry.name);
  validateLicenseDeclaration(license, `${manifest.name}@${manifest.version}`, packageDir, packageFiles, context.scope);

  const relative = relativePath(context.logicalRoot, packageDir);
  const lockEntry = context.lock?.packages?.[relative];
  if (lockEntry && lockEntry.version !== manifest.version) {
    fail('LICENSE_CLOSURE_LOCK_VERSION_MISMATCH', `${relative}: ${manifest.version} != ${lockEntry.version}`);
  }
  if (lockEntry?.license && normalizeLicense(lockEntry.license) !== license) {
    fail('LICENSE_CLOSURE_LOCK_LICENSE_MISMATCH', `${relative}: ${license} != ${lockEntry.license}`);
  }

  const primaryLicenseFiles = packageFiles.filter(filename => primaryLicenseResourcePattern.test(filename));
  const fallbackLicenseFiles = packageFiles.filter(filename => packageResourcePattern.test(filename));
  const licenseResources = sortedBytewise(primaryLicenseFiles.length > 0 ? primaryLicenseFiles : fallbackLicenseFiles)
    .map(filename => `${relative}/${filename}`);
  if (licenseResources.length === 0) licenseResources.push(`${relative}/package.json#license`);
  const entry = {
    scope: context.scope,
    name: manifest.name,
    version: manifest.version,
    license,
    path: relative,
    integrity: lockEntry?.integrity,
    licenseResources,
    licenseTextId: makeLicenseTextId(context.scope, relative)
  };
  context.seen.set(identity, entry);
  if (context.entries) context.entries.push(entry);
  return entry;
}

async function collectAllPhysicalPackages(nodeModulesDir, context) {
  for (const packageDir of await packageDirectories(nodeModulesDir)) {
    if (isPrunedRuntimePath(packageDir, context)) continue;
    await addPackage(packageDir, context);
    for (const nested of await nestedNodeModules(packageDir)) {
      if (isPrunedRuntimePath(nested, context)) continue;
      await collectAllPhysicalPackages(nested, context);
    }
  }
}

async function collectProductionPackages(packageJsonPath, context) {
  const manifest = await readJson(packageJsonPath, 'LICENSE_CLOSURE_ROOT_MANIFEST_INVALID');
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') {
    fail('LICENSE_CLOSURE_ROOT_DEPENDENCIES_MISSING', packageJsonPath);
  }
  const visited = new Set();
  async function visit(packageDir, requestedBy) {
    const realDir = await fs.realpath(packageDir).catch(error => {
      fail('LICENSE_CLOSURE_PHYSICAL_WALK_FAILED', `${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const identity = comparablePath(realDir);
    if (visited.has(identity)) return;
    visited.add(identity);
    const packageEntry = await addPackage(packageDir, context);
    const packageManifest = await readJson(path.join(packageDir, 'package.json'), 'LICENSE_CLOSURE_PACKAGE_METADATA_INVALID');
    const dependencies = { ...(packageManifest.dependencies ?? {}), ...(packageManifest.optionalDependencies ?? {}) };
    for (const [name, specification] of Object.entries(dependencies)) {
      const dependencyDir = await resolvePackage(packageDir, name, context.logicalRoot);
      if (!dependencyDir) {
        if (Object.prototype.hasOwnProperty.call(packageManifest.optionalDependencies ?? {}, name)) continue;
        fail('LICENSE_CLOSURE_DEPENDENCY_MISSING', `${requestedBy} -> ${name}@${specification}`);
      }
      await visit(dependencyDir, `${packageManifest.name} -> ${name}@${specification}`);
    }
    for (const name of Object.keys(packageManifest.peerDependencies ?? {})) {
      const peerDir = await resolvePackage(packageDir, name, context.logicalRoot);
      if (peerDir) await visit(peerDir, `${packageManifest.name} peer -> ${name}`);
    }
    for (const nested of await nestedNodeModules(packageDir)) {
      if (isPrunedRuntimePath(nested, context)) continue;
      await collectAllPhysicalPackages(nested, context);
    }
    return packageEntry;
  }
  for (const [name, specification] of Object.entries(manifest.dependencies)) {
    const dependencyDir = await resolvePackage(path.dirname(packageJsonPath), name, context.logicalRoot);
    if (!dependencyDir) fail('LICENSE_CLOSURE_DEPENDENCY_MISSING', `root -> ${name}@${specification}`);
    await visit(dependencyDir, `root -> ${name}@${specification}`);
  }
}

async function findNodeModulesDirectories(directory) {
  const result = [];
  async function visit(current) {
    const info = await physicalStat(current, 'LICENSE_CLOSURE_PHYSICAL_WALK_FAILED', true);
    if (!info) return;
    if (!info.isDirectory()) return;
    for (const entry of await physicalEntries(current)) {
      if (!entry.info.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') {
        result.push(entry.path);
        continue;
      }
      await visit(entry.path);
    }
  }
  await visit(directory);
  return result;
}

async function validateDistPhysicalClosure(runtimeEntries) {
  const distRoot = path.join(root, 'dist');
  if (!(await isDirectory(distRoot))) return;
  const distNodeModules = (await findNodeModulesDirectories(distRoot))
    .filter(directory => relativePath(distRoot, directory).split('/').includes('resources'));
  if (distNodeModules.length === 0) return;
  const context = {
    scope: 'dist',
    logicalRoot: distRoot,
    lock: undefined,
    seen: new Map(),
    entries: []
  };
  for (const directory of distNodeModules) await collectAllPhysicalPackages(directory, context);
  const runtimeNodeModulesInDist = distNodeModules.filter(directory => relativePath(distRoot, directory).split('/').includes('dsh-runtime'));
  if (runtimeNodeModulesInDist.length > 0) {
    const runtimeContext = {
      scope: 'dist',
      logicalRoot: distRoot,
      lock: undefined,
      seen: new Map(),
      entries: []
    };
    for (const directory of runtimeNodeModulesInDist) await collectAllPhysicalPackages(directory, runtimeContext);
    if (!packageKeyListsEqual(runtimeContext.entries, runtimeEntries)) {
      fail('LICENSE_CLOSURE_DIST_RUNTIME_MISMATCH', `source=${runtimeEntries.length} dist=${runtimeContext.entries.length}`);
    }
  }
}

async function validateOptionalRuntimeMirror(runtimeEntries) {
  const mirrorRoot = path.join(root, 'vendor', 'runtime-closure', 'dsh-runtime', 'node_modules');
  if (!(await isDirectory(mirrorRoot))) return;
  const context = {
    scope: 'vendor',
    logicalRoot: path.join(root, 'vendor', 'runtime-closure', 'dsh-runtime'),
    lock: undefined,
    seen: new Map(),
    entries: []
  };
  await collectAllPhysicalPackages(mirrorRoot, context);
  if (!packageKeyListsEqual(context.entries, runtimeEntries)) {
    fail('LICENSE_CLOSURE_VENDOR_RUNTIME_MISMATCH', `source=${runtimeEntries.length} vendor=${context.entries.length}`);
  }
}

function validateReportShape(report, filename) {
  if (report?.schemaVersion !== schemaVersion || report?.generator !== generatorName
    || !Array.isArray(report?.packages) || !Array.isArray(report?.roots)
    || report?.licenseTextFile !== licenseTextFileName
    || typeof report?.licenseTextSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(report.licenseTextSha256)
    || !Number.isInteger(report?.licenseTextBytes) || report.licenseTextBytes < 1
    || !Array.isArray(report?.licenses)) {
    fail('LICENSE_CLOSURE_REPORT_INVALID', filename);
  }
  const seen = new Set();
  const expectedLicenses = [];
  for (const entry of report.packages) {
    if (!entry || typeof entry.scope !== 'string' || typeof entry.name !== 'string' || typeof entry.version !== 'string'
      || typeof entry.license !== 'string' || typeof entry.path !== 'string' || !Array.isArray(entry.licenseResources)
      || typeof entry.licenseTextId !== 'string' || !isSafeRelativePath(entry.path)) {
      fail('LICENSE_CLOSURE_REPORT_ENTRY_INVALID', filename);
    }
    const key = `${entry.scope}:${entry.path}`;
    if (seen.has(key)) fail('LICENSE_CLOSURE_REPORT_DUPLICATE', key);
    seen.add(key);
    if (entry.licenseTextId !== makeLicenseTextId(entry.scope, entry.path)) {
      fail('LICENSE_CLOSURE_REPORT_LICENSE_TEXT_ID_INVALID', key);
    }
    validateLicenseDeclaration(entry.license, `${entry.name}@${entry.version}`, entry.path, entry.licenseResources, entry.scope);
    expectedLicenses.push(entry.license);
  }
  const sortedExpectedLicenses = sortedBytewise(new Set(expectedLicenses));
  if (JSON.stringify(report.licenses) !== JSON.stringify(sortedExpectedLicenses)) {
    fail('LICENSE_CLOSURE_REPORT_LICENSES_INVALID', filename);
  }
  const sortedPackages = [...report.packages].sort((left, right) => bytewiseCompare(
    `${left.scope}/${left.path}`,
    `${right.scope}/${right.path}`
  ));
  if (JSON.stringify(report.packages) !== JSON.stringify(sortedPackages)) {
    fail('LICENSE_CLOSURE_REPORT_ORDER_INVALID', filename);
  }
}

function sourceRootForScope(scope) {
  if (scope === 'app-production') return root;
  if (scope === 'runtime') return path.join(root, 'runtime');
  fail('LICENSE_CLOSURE_SCOPE_INVALID', scope);
}

function resourcePathForEntry(entry, resource) {
  if (resource.endsWith('#license')) return undefined;
  const resourceName = resource.slice(0, resource.lastIndexOf('/'));
  const sourceRoot = sourceRootForScope(entry.scope);
  const fullPath = path.resolve(sourceRoot, resource);
  if (!isWithin(fullPath, sourceRoot) || !resourceName.startsWith(entry.path)) {
    fail('LICENSE_CLOSURE_LICENSE_RESOURCE_INVALID', `${entry.scope}:${resource}`);
  }
  return fullPath;
}

async function loadEntryLicenseResources(entry) {
  const resources = [];
  for (const resource of entry.licenseResources) {
    const fullPath = resourcePathForEntry(entry, resource);
    if (!fullPath) continue;
    const text = normalizeText(await readText(fullPath, 'LICENSE_CLOSURE_LICENSE_RESOURCE_MISSING'));
    if (text.trim().length === 0) fail('LICENSE_CLOSURE_LICENSE_TEXT_EMPTY', resource);
    resources.push({ resource, text });
  }
  return resources;
}

async function buildLicenseResourceCache(entries) {
  const cache = new Map();
  for (const entry of entries) cache.set(entry.licenseTextId, await loadEntryLicenseResources(entry));
  return cache;
}

function canonicalTextForLicense(license, entries, resourceCache) {
  const atoms = licenseAtoms(license);
  const sections = [];
  for (const atom of atoms) {
    const representative = entries.find(entry => entry.license === atom && (resourceCache.get(entry.licenseTextId)?.length ?? 0) > 0);
    if (representative) {
      const resources = resourceCache.get(representative.licenseTextId);
      const preferred = resources.find(item => !/^readme(?:[._ -]|$)/iu.test(path.basename(item.resource))) ?? resources[0];
      sections.push(`Canonical ${atom} text, carried from ${representative.scope}/${representative.path} (${preferred.resource}):\n${preferred.text.trimEnd()}`);
      continue;
    }
    const fallback = fallbackLicenseTexts.get(atom);
    if (!fallback) fail('LICENSE_CLOSURE_LICENSE_TEXT_MISSING', atom);
    sections.push(`Canonical ${atom} text:\n${normalizeText(fallback).trimEnd()}`);
  }
  if (sections.length === 0) fail('LICENSE_CLOSURE_LICENSE_TEXT_MISSING', license);
  return `${sections.join('\n\n')}\n`;
}

async function buildMergedLicenseText(entries) {
  const resourceCache = await buildLicenseResourceCache(entries);
  const lines = [
    '# ADHD One third-party license texts',
    `# Generated by ${generatorName}; schema ${schemaVersion}`,
    '# Each package record in license-closure.json has one matching package section below.',
    ''
  ];
  for (const entry of entries) {
    const resources = resourceCache.get(entry.licenseTextId) ?? [];
    lines.push(`@@ PACKAGE ${entry.licenseTextId} @@`);
    lines.push(`Name: ${entry.name}`);
    lines.push(`Version: ${entry.version}`);
    lines.push(`License: ${entry.license}`);
    lines.push(`Scope: ${entry.scope}`);
    lines.push(`Physical path: ${entry.path}`);
    lines.push(`Reported resources: ${entry.licenseResources.join(', ')}`);
    lines.push('<<< BEGIN LICENSE TEXT >>>');
    if (resources.length > 0) {
      for (const resource of resources) {
        lines.push(`--- SOURCE ${resource.resource} ---`);
        lines.push(resource.text.trimEnd());
      }
    } else {
      lines.push('--- SOURCE SPDX/canonical fallback ---');
      lines.push(canonicalTextForLicense(entry.license, entries, resourceCache).trimEnd());
    }
    lines.push('<<< END LICENSE TEXT >>>');
    lines.push(`@@ END PACKAGE ${entry.licenseTextId} @@`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function countOccurrences(text, value) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(value, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + value.length;
  }
}

function validateLicenseText(report, text, filename) {
  if (sha256Text(text) !== report.licenseTextSha256 || Buffer.byteLength(text, 'utf8') !== report.licenseTextBytes) {
    fail('LICENSE_CLOSURE_LICENSE_TEXT_DIGEST_MISMATCH', filename);
  }
  const ids = new Set(report.packages.map(entry => entry.licenseTextId));
  const markerPattern = /^@@ PACKAGE (.+) @@$/gmu;
  const foundIds = [];
  for (const match of text.matchAll(markerPattern)) foundIds.push(match[1]);
  if (foundIds.length !== ids.size || foundIds.some(id => !ids.has(id)) || new Set(foundIds).size !== ids.size) {
    fail('LICENSE_CLOSURE_LICENSE_TEXT_PACKAGE_MISMATCH', filename);
  }
  for (const entry of report.packages) {
    const begin = `@@ PACKAGE ${entry.licenseTextId} @@`;
    const end = `@@ END PACKAGE ${entry.licenseTextId} @@`;
    if (countOccurrences(text, begin) !== 1 || countOccurrences(text, end) !== 1) {
      fail('LICENSE_CLOSURE_LICENSE_TEXT_PACKAGE_MISSING', `${filename}:${entry.licenseTextId}`);
    }
    const start = text.indexOf(begin);
    const endIndex = text.indexOf(end, start + begin.length);
    const section = text.slice(start, endIndex === -1 ? text.length : endIndex);
    if (!section.includes(`License: ${entry.license}\n`) || !section.includes('<<< BEGIN LICENSE TEXT >>>\n')) {
      fail('LICENSE_CLOSURE_LICENSE_TEXT_ENTRY_INVALID', `${filename}:${entry.licenseTextId}`);
    }
    const contentStart = section.indexOf('<<< BEGIN LICENSE TEXT >>>\n') + '<<< BEGIN LICENSE TEXT >>>\n'.length;
    if (section.slice(contentStart).trim().length === 0) {
      fail('LICENSE_CLOSURE_LICENSE_TEXT_ENTRY_EMPTY', `${filename}:${entry.licenseTextId}`);
    }
  }
}

async function validatePackagedLicenseCarrier(packageRoot, report, reportText, mergedText) {
  const packageRootInfo = await physicalStat(packageRoot, 'LICENSE_CLOSURE_PACKAGE_ROOT_MISSING');
  if (!packageRootInfo.isDirectory()) fail('LICENSE_CLOSURE_PACKAGE_ROOT_INVALID', packageRoot);
  const packagedLicenses = path.join(packageRoot, 'resources', 'licenses');
  const packagedLicensesInfo = await physicalStat(packagedLicenses, 'LICENSE_CLOSURE_PACKAGED_LICENSE_ROOT_MISSING');
  if (!packagedLicensesInfo.isDirectory()) fail('LICENSE_CLOSURE_PACKAGED_LICENSE_ROOT_INVALID', packagedLicenses);
  const packagedReportPath = path.join(packagedLicenses, 'license-closure.json');
  const packagedTextPath = path.join(packagedLicenses, licenseTextFileName);
  const packagedReportText = await readText(packagedReportPath, 'LICENSE_CLOSURE_PACKAGED_REPORT_MISSING');
  const packagedText = await readText(packagedTextPath, 'LICENSE_CLOSURE_PACKAGED_LICENSE_TEXT_MISSING');
  if (packagedReportText !== reportText) fail('LICENSE_CLOSURE_PACKAGED_REPORT_MISMATCH', packagedReportPath);
  if (packagedText !== mergedText) fail('LICENSE_CLOSURE_PACKAGED_LICENSE_TEXT_MISMATCH', packagedTextPath);
  const packagedReport = await readJson(packagedReportPath, 'LICENSE_CLOSURE_PACKAGED_REPORT_INVALID');
  validateReportShape(packagedReport, packagedReportPath);
  validateLicenseText(packagedReport, packagedText, packagedTextPath);
}

async function main() {
  const rootManifest = path.join(root, 'package.json');
  const runtimeManifest = path.join(root, 'runtime', 'package.json');
  const rootLock = await loadLockfile(path.join(root, 'package-lock.json'));
  const runtimeLock = await loadLockfile(path.join(root, 'runtime', 'package-lock.json'));
  if (!(await exists(rootManifest)) || !(await exists(runtimeManifest))) fail('LICENSE_CLOSURE_MANIFEST_MISSING');

  const appContext = {
    scope: 'app-production', logicalRoot: root, lock: rootLock, seen: new Map(), entries: []
  };
  const runtimeContext = {
    scope: 'runtime', logicalRoot: path.join(root, 'runtime'), lock: runtimeLock, seen: new Map(), entries: []
  };
  await collectProductionPackages(rootManifest, appContext);
  await collectAllPhysicalPackages(runtimeNodeModules, runtimeContext);
  const allEntries = [...appContext.entries, ...runtimeContext.entries].sort((left, right) => bytewiseCompare(
    `${left.scope}/${left.path}`,
    `${right.scope}/${right.path}`
  ));
  if (runtimeContext.entries.length === 0) fail('LICENSE_CLOSURE_RUNTIME_EMPTY');
  if (!runtimeContext.entries.some(entry => /\/pnpm\/dist\/node_modules\//u.test(entry.path))) {
    fail('LICENSE_CLOSURE_RECURSION_GAP', 'runtime/node_modules/pnpm/dist/node_modules');
  }
  await validateDistPhysicalClosure(runtimeContext.entries);
  await validateOptionalRuntimeMirror(runtimeContext.entries);

  const mergedText = await buildMergedLicenseText(allEntries);
  const report = {
    schemaVersion,
    generator: generatorName,
    platform: process.platform,
    arch: process.arch,
    licenseTextFile: licenseTextFileName,
    licenseTextSha256: sha256Text(mergedText),
    licenseTextBytes: Buffer.byteLength(mergedText, 'utf8'),
    roots: [
      {
        scope: 'app-production',
        physicalRoot: relativePath(root, appNodeModules),
        lockfile: 'package-lock.json',
        selection: 'package.json production dependencies and their physically resolved dependencies',
        packageCount: appContext.entries.length
      },
      {
        scope: 'runtime',
        physicalRoot: relativePath(root, runtimeNodeModules),
        lockfile: 'runtime/package-lock.json',
        selection: 'every physical package recursively found below node_modules, including pnpm/dist/node_modules',
        packageCount: runtimeContext.entries.length
      }
    ],
    licenses: sortedBytewise(new Set(allEntries.map(entry => entry.license))),
    packages: allEntries
  };
  const reportText = serializeReport(report);

  if (checkOnly) {
    const tracked = await readJson(reportPath, 'LICENSE_CLOSURE_RESOURCE_MISSING');
    validateReportShape(tracked, reportPath);
    const trackedTextPath = path.join(path.dirname(reportPath), tracked.licenseTextFile);
    const trackedText = await readText(trackedTextPath, 'LICENSE_CLOSURE_LICENSE_TEXT_MISSING');
    validateLicenseText(tracked, trackedText, trackedTextPath);
    if (tracked.platform === report.platform && tracked.arch === report.arch) {
      if (stableReport(tracked) !== stableReport(report) || trackedText !== mergedText) {
        fail('LICENSE_CLOSURE_STALE', reportPath);
      }
    }
    if (packageRoot) await validatePackagedLicenseCarrier(packageRoot, report, reportText, mergedText);
    console.log(`LICENSE_CLOSURE_OK app=${appContext.entries.length} runtime=${runtimeContext.entries.length} platform=${report.platform}`);
    return;
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, reportText, 'utf8');
  await fs.writeFile(licenseTextPath, mergedText, 'utf8');
  console.log(`LICENSE_CLOSURE_WRITTEN ${relativePath(root, reportPath)} ${relativePath(root, licenseTextPath)} app=${appContext.entries.length} runtime=${runtimeContext.entries.length}`);
}

await main();
