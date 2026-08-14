import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const tag = process.env.GITHUB_REF_NAME ?? 'v0.2.0';
const runtimeName = 'ADHD-One-Runtime-0.1.0-rc.6-win-x64.7z';
const runtimeFile = path.join(dist, runtimeName);
await fs.copyFile(path.join(root, 'vendor', 'dsh-runtime.7z'), runtimeFile);

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const runtimeSha256 = await digest(runtimeFile);
const runtimeSize = (await fs.stat(runtimeFile)).size;
const manifest = {
  schemaVersion: 1, channel: tag.includes('-') ? 'preview' : 'stable', generatedAt: new Date().toISOString(), minAppVersion: '0.2.0',
  platform: 'win32', arch: 'x64',
  runtime: { version: '0.1.0-rc.6', dshPackage: '@deepseek-ai/dsh', dshIntegrity: 'sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==', nodeVersion: '24.18.0', pnpmVersion: '11.21.0', protocolCompatibility: '^1' },
  asset: { name: runtimeName, url: `https://github.com/xydadada/adhd-one/releases/download/${tag}/${runtimeName}`, size: runtimeSize, sha256: runtimeSha256 },
  source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness', npmPublishedAt: '2026-08-13T12:35:03.812Z', upstreamCommit: '47f943859bef60e4160492346772ded9b24f765a' },
  attestation: { repository: 'xydadada/adhd-one', workflow: '.github/workflows/release.yml', ref: `refs/tags/${tag}`, subjectDigest: `sha256:${runtimeSha256}` },
  notesUrl: `https://github.com/xydadada/adhd-one/releases/tag/${tag}`
};
await fs.writeFile(path.join(dist, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const assets = (await fs.readdir(dist, { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.(?:exe|zip|7z|json)$/u.test(entry.name) && entry.name !== 'SHA256SUMS.txt')
  .map(entry => entry.name).sort();
const lines = [];
for (const name of assets) lines.push(`${await digest(path.join(dist, name))}  ${name}`);
await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
