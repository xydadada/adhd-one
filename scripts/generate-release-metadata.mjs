import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const appManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME ?? `v${appManifest.version}`;
const runtimeManifest = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'package-lock.json'), 'utf8'));
const dshPackage = runtimeManifest.packages['node_modules/@deepseek-ai/dsh'];
const pnpmPackage = runtimeManifest.packages['node_modules/pnpm'];
if (!appManifest.version || !dshPackage?.version || !dshPackage?.integrity || !pnpmPackage?.version) throw new Error('RELEASE_VERSION_METADATA_MISSING');
const runtimeName = `ADHD-One-Runtime-${dshPackage.version}-win-x64.7z`;
const runtimeFile = path.join(dist, runtimeName);
const dshNpmPublishedAt = '2026-08-13T12:35:03.812Z';
await fs.copyFile(path.join(root, 'vendor', 'dsh-runtime.7z'), runtimeFile);
await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(dist, 'THIRD_PARTY_NOTICES.md'));

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const runtimeSha256 = await digest(runtimeFile);
const runtimeSize = (await fs.stat(runtimeFile)).size;
const manifest = {
  schemaVersion: 1, channel: semver.prerelease(dshPackage.version) ? 'preview' : 'stable', generatedAt: new Date().toISOString(), minAppVersion: appManifest.version,
  platform: 'win32', arch: 'x64',
  runtime: { version: dshPackage.version, dshPackage: '@deepseek-ai/dsh', dshIntegrity: dshPackage.integrity, nodeVersion: '24.18.0', pnpmVersion: pnpmPackage.version, protocolCompatibility: '^1' },
  asset: { name: runtimeName, url: `https://github.com/xydadada/adhd-one/releases/download/${tag}/${runtimeName}`, size: runtimeSize, sha256: runtimeSha256 },
  source: {
    upstreamRepo: 'deepseek-ai/DeepSeek-Harness',
    npmPackage: '@deepseek-ai/dsh',
    npmVersion: dshPackage.version,
    npmIntegrity: dshPackage.integrity,
    npmResolved: dshPackage.resolved,
    npmPublishedAt: dshNpmPublishedAt,
    adaptedSourceCommit: '47f943859bef60e4160492346772ded9b24f765a',
    adaptedSourceRelease: '0.1.0-rc.5',
    adaptedSourceRole: 'adapted-code-source-only'
  },
  attestation: { repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml', ref: `refs/tags/${tag}`, subjectDigest: `sha256:${runtimeSha256}` },
  notesUrl: `https://github.com/xydadada/adhd-one/releases/tag/${tag}`
};
await fs.writeFile(path.join(dist, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const assets = [
  `ADHD-One-Setup-${appManifest.version}-x64.exe`,
  `ADHD-One-Portable-${appManifest.version}-win-x64.zip`,
  runtimeName,
  `ADHD-One-${appManifest.version}.spdx.json`,
  'latest.yml',
  'runtime-manifest.json',
  'THIRD_PARTY_NOTICES.md'
];
for (const name of assets) if (!(await fs.stat(path.join(dist, name)).then(value => value.isFile()).catch(() => false))) throw new Error(`RELEASE_ASSET_MISSING:${name}`);
const lines = [];
for (const name of assets) lines.push(`${await digest(path.join(dist, name))}  ${name}`);
await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
