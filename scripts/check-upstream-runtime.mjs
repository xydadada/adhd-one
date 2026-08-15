import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

export const OFFICIAL_DSH_PACKAGE = '@deepseek-ai/dsh';
export const OFFICIAL_DSH_TAGS_URL = 'https://registry.npmjs.org/-/package/%40deepseek-ai%2Fdsh/dist-tags';
export const OFFICIAL_DSH_VERSION_URL = 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh/';
const MAX_METADATA_BYTES = 1024 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function validIntegrity(value) {
  return typeof value === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

export function evaluateUpstreamRuntime(current, metadata) {
  const packageMetadata = record(metadata);
  const dist = record(packageMetadata?.dist);
  const latestVersion = packageMetadata?.version;
  const latestIntegrity = dist?.integrity;
  if (packageMetadata?.name !== OFFICIAL_DSH_PACKAGE || typeof latestVersion !== 'string' || !semver.valid(latestVersion)) {
    throw new Error('UPSTREAM_METADATA_INVALID');
  }
  if (!validIntegrity(latestIntegrity)) throw new Error('UPSTREAM_INTEGRITY_INVALID');
  if (!semver.valid(current.version) || !validIntegrity(current.integrity)) throw new Error('CURRENT_RUNTIME_INVALID');

  let status;
  if (latestVersion === current.version) status = latestIntegrity === current.integrity ? 'current' : 'integrity-mismatch';
  else status = semver.gt(latestVersion, current.version) ? 'update-available' : 'tag-regression';

  return {
    schemaVersion: 1,
    package: OFFICIAL_DSH_PACKAGE,
    status,
    requiresAttention: status !== 'current',
    currentVersion: current.version,
    currentIntegrity: current.integrity,
    latestVersion,
    latestIntegrity
  };
}

export async function readCurrentRuntime(root = process.cwd()) {
  const manifest = JSON.parse(await readFile(path.join(root, 'runtime', 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'runtime', 'package-lock.json'), 'utf8'));
  const declaredVersion = manifest.dependencies?.[OFFICIAL_DSH_PACKAGE];
  const locked = lock.packages?.[`node_modules/${OFFICIAL_DSH_PACKAGE}`];
  if (typeof declaredVersion !== 'string' || !semver.valid(declaredVersion) || locked?.version !== declaredVersion || !validIntegrity(locked?.integrity)) {
    throw new Error('CURRENT_RUNTIME_LOCK_MISMATCH');
  }
  return { version: declaredVersion, integrity: locked.integrity };
}

export async function checkUpstreamRuntime(options = {}) {
  const root = options.root ?? process.cwd();
  const tagsUrl = options.tagsUrl ?? OFFICIAL_DSH_TAGS_URL;
  const versionUrl = options.versionUrl ?? OFFICIAL_DSH_VERSION_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = await readCurrentRuntime(root);
  const fetchJson = async url => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) throw new Error('UPSTREAM_METADATA_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) throw new Error('UPSTREAM_METADATA_TOO_LARGE');
    try { return JSON.parse(text); } catch { throw new Error('UPSTREAM_METADATA_INVALID'); }
  };

  const tags = record(await fetchJson(tagsUrl));
  if (typeof tags?.latest !== 'string' || !semver.valid(tags.latest)
    || (tags.next !== undefined && (typeof tags.next !== 'string' || !semver.valid(tags.next)))) {
    throw new Error('UPSTREAM_TAGS_INVALID');
  }
  const taggedVersions = [...new Set([current.version, tags.latest, tags.next].filter(Boolean))];
  const metadataEntries = await Promise.all(taggedVersions.map(async version => [version, await fetchJson(`${versionUrl}${encodeURIComponent(version)}`)]));
  const evaluations = Object.fromEntries(metadataEntries.map(([version, metadata]) => [version, evaluateUpstreamRuntime(current, metadata)]));
  const currentEvaluation = evaluations[current.version];
  const taggedEvaluations = [evaluations[tags.latest], tags.next ? evaluations[tags.next] : undefined].filter(Boolean);
  let status = 'current';
  if (currentEvaluation.status === 'integrity-mismatch') status = 'integrity-mismatch';
  else if (taggedEvaluations.some(value => value.status === 'update-available')) status = 'update-available';
  else if (taggedEvaluations.some(value => value.status === 'tag-regression')) status = 'tag-regression';
  return {
    schemaVersion: 1,
    package: OFFICIAL_DSH_PACKAGE,
    status,
    requiresAttention: status !== 'current',
    currentVersion: current.version,
    currentIntegrity: current.integrity,
    latestVersion: tags.latest,
    nextVersion: tags.next,
    versions: Object.fromEntries(Object.entries(evaluations).map(([version, value]) => [version, { integrity: value.latestIntegrity }]))
  };
}

async function appendGitHubSummary(result) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const summary = [
    '## Official DSH upstream monitor', '',
    `- Status: \`${result.status}\``,
    `- Locked: \`${result.currentVersion}\``,
    `- npm latest: \`${result.latestVersion}\``,
    `- npm next: \`${result.nextVersion ?? 'not set'}\``, '',
    'No dependency, lockfile, Runtime asset, Release, or issue was modified.'
  ].join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
}

async function main() {
  const result = await checkUpstreamRuntime();
  await appendGitHubSummary(result);
  console.log(JSON.stringify(result, null, 2));
  if (result.requiresAttention) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'UPSTREAM_MONITOR_FAILED');
    process.exitCode = 1;
  });
}
