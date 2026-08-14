import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');
const dist = path.join(root, 'dist');
const appManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

export function validateReleaseIdentity(packageVersion, environment = process.env) {
  if (typeof packageVersion !== 'string' || semver.valid(packageVersion, { loose: false }) === null) {
    throw new Error('RELEASE_VERSION_INVALID');
  }

  const expectedTag = `v${packageVersion}`;
  const expectedRef = `refs/tags/${expectedTag}`;
  const configuredTag = environment.GITHUB_REF_NAME;
  const configuredRef = environment.GITHUB_REF;
  if (configuredTag !== undefined && configuredTag !== expectedTag) throw new Error('RELEASE_TAG_IDENTITY_MISMATCH');
  if (configuredRef !== undefined && configuredRef !== expectedRef) throw new Error('RELEASE_REF_IDENTITY_MISMATCH');

  return { tag: configuredTag ?? expectedTag, ref: configuredRef ?? expectedRef };
}

export function releaseMetadataLinks({ tag, ref }, runtimeName) {
  return {
    assetUrl: `https://github.com/xydadada/adhd-one/releases/download/${tag}/${runtimeName}`,
    attestationRef: ref,
    notesUrl: `https://github.com/xydadada/adhd-one/releases/tag/${tag}`
  };
}

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function generateReleaseMetadata() {
  const { tag: validatedTag, ref: validatedRef } = validateReleaseIdentity(appManifest.version, process.env);
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'package-lock.json'), 'utf8'));
  const dshPackage = runtimeManifest.packages['node_modules/@deepseek-ai/dsh'];
  const pnpmPackage = runtimeManifest.packages['node_modules/pnpm'];
  if (!appManifest.version || !dshPackage?.version || !dshPackage?.integrity || !pnpmPackage?.version) throw new Error('RELEASE_VERSION_METADATA_MISSING');
  const runtimeName = `ADHD-One-Runtime-${dshPackage.version}-win-x64.7z`;
  const runtimeFile = path.join(dist, runtimeName);
  const dshNpmPublishedAt = '2026-08-13T12:35:03.812Z';
  await fs.copyFile(path.join(root, 'vendor', 'dsh-runtime.7z'), runtimeFile);
  await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(dist, 'THIRD_PARTY_NOTICES.md'));

  const runtimeSha256 = await digest(runtimeFile);
  const runtimeSize = (await fs.stat(runtimeFile)).size;
  const links = releaseMetadataLinks({ tag: validatedTag, ref: validatedRef }, runtimeName);
  const manifest = {
    schemaVersion: 1, channel: semver.prerelease(dshPackage.version) ? 'preview' : 'stable', generatedAt: new Date().toISOString(), minAppVersion: appManifest.version,
    platform: 'win32', arch: 'x64',
    runtime: { version: dshPackage.version, dshPackage: '@deepseek-ai/dsh', dshIntegrity: dshPackage.integrity, nodeVersion: '24.18.0', pnpmVersion: pnpmPackage.version, protocolCompatibility: '^1' },
    asset: { name: runtimeName, url: links.assetUrl, size: runtimeSize, sha256: runtimeSha256 },
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
    attestation: { repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml', ref: links.attestationRef, subjectDigest: `sha256:${runtimeSha256}` },
    notesUrl: links.notesUrl
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await generateReleaseMetadata();
