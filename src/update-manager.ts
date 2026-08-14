import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import updaterPackage from 'electron-updater';
import { verify, type Bundle } from 'sigstore';
import { z } from 'zod';
import { validateArchiveEntry } from './security.js';
import { writeFileAtomic } from './settings-store.js';
import type { RuntimeManifestV1, UpdateSnapshot, UpdateTarget } from './types.js';

const updater = () => updaterPackage.autoUpdater;

const manifestSchema = z.object({
  schemaVersion: z.literal(1), channel: z.enum(['stable', 'preview']), generatedAt: z.iso.datetime(),
  minAppVersion: z.string(), platform: z.literal('win32'), arch: z.literal('x64'),
  runtime: z.object({ version: z.string(), dshPackage: z.literal('@deepseek-ai/dsh'), dshIntegrity: z.string(), nodeVersion: z.string(), pnpmVersion: z.string(), protocolCompatibility: z.string() }),
  asset: z.object({ name: z.string(), url: z.url(), size: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
  source: z.object({ upstreamRepo: z.literal('deepseek-ai/DeepSeek-Harness'), npmPublishedAt: z.string(), upstreamCommit: z.string().optional() }),
  attestation: z.object({ repository: z.literal('xydadada/adhd-one'), workflow: z.string(), ref: z.string(), subjectDigest: z.string() }), notesUrl: z.string().optional()
});

export function parseRuntimeManifest(value: unknown, channel: 'stable' | 'preview'): RuntimeManifestV1 {
  const parsed = manifestSchema.parse(value) as RuntimeManifestV1;
  if (parsed.channel !== channel) throw new Error('RUNTIME_CHANNEL_MISMATCH');
  if (channel === 'stable' && /(?:alpha|beta|rc)/iu.test(parsed.runtime.version)) throw new Error('PRERELEASE_ON_STABLE');
  const url = new URL(parsed.asset.url);
  if (url.protocol !== 'https:' || !['github.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('UNTRUSTED_RUNTIME_ASSET');
  if (parsed.attestation.subjectDigest !== `sha256:${parsed.asset.sha256}`) throw new Error('ATTESTATION_DIGEST_MISMATCH');
  return parsed;
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verifyGithubAttestation(filename: string, digest: string, tag: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/xydadada/adhd-one/attestations/sha256:${digest}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`ATTESTATION_HTTP_${response.status}`);
  const body = await response.json() as { attestations?: Array<{ bundle?: Bundle }> };
  const bundle = body.attestations?.[0]?.bundle;
  if (!bundle) throw new Error('ATTESTATION_NOT_FOUND');
  await verify(bundle, await readFile(filename), {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: `https://github.com/xydadada/adhd-one/.github/workflows/release.yml@refs/tags/${tag}`
  });
}

interface UpdatePaths { staging: string; runtimes: string; sevenZip: string }

export class UpdateManager extends EventEmitter {
  private snapshots = new Map<UpdateTarget, UpdateSnapshot>([['app', { target: 'app', state: 'idle' }], ['runtime', { target: 'runtime', state: 'idle' }]]);
  private manifest?: RuntimeManifestV1;
  constructor(private readonly paths: UpdatePaths, private readonly appVersion: string, private readonly manifestUrl: string) {
    super(); updater().autoDownload = false; updater().allowPrerelease = false;
  }
  snapshot(target: UpdateTarget): UpdateSnapshot { return structuredClone(this.snapshots.get(target)!); }
  private set(target: UpdateTarget, patch: Partial<UpdateSnapshot>): void {
    const next = { ...this.snapshot(target), ...patch } as UpdateSnapshot; this.snapshots.set(target, next); this.emit('changed', next);
  }
  async check(target: UpdateTarget, channel: 'stable' | 'preview'): Promise<UpdateSnapshot> {
    this.set(target, { state: 'checking', error: undefined });
    try {
      if (target === 'app') {
        updater().allowPrerelease = channel === 'preview';
        const result = await updater().checkForUpdates();
        const version = result?.updateInfo.version;
        this.set(target, version && version !== this.appVersion ? { state: 'available', version } : { state: 'idle' });
      } else {
        const response = await fetch(this.manifestUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_048_576) throw new Error(`MANIFEST_HTTP_${response.status}`);
        this.manifest = parseRuntimeManifest(await response.json(), channel);
        this.set(target, { state: 'available', version: this.manifest.runtime.version });
      }
    } catch (error) { this.set(target, { state: 'failed', error: { code: 'UPDATE_CHECK_FAILED', message: error instanceof Error ? error.message : String(error) } }); }
    return this.snapshot(target);
  }
  async confirm(target: UpdateTarget): Promise<void> {
    if (target === 'app') {
      this.set(target, { state: 'downloading' });
      const result = await updater().downloadUpdate();
      const filename = result[0]; if (!filename) throw new Error('UPDATE_FILE_MISSING');
      const digest = await sha256(filename); await verifyGithubAttestation(filename, digest, `v${this.snapshot('app').version ?? this.appVersion}`);
      this.set(target, { state: 'verified' }); return;
    }
    if (!this.manifest) throw new Error('RUNTIME_MANIFEST_MISSING');
    const manifest = this.manifest; await mkdir(this.paths.staging, { recursive: true });
    const part = path.join(this.paths.staging, `${manifest.asset.name}.part`); await rm(part, { force: true });
    this.set(target, { state: 'downloading' });
    const response = await fetch(manifest.asset.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`RUNTIME_DOWNLOAD_HTTP_${response.status}`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > manifest.asset.size) throw new Error('RUNTIME_ASSET_TOO_LARGE'); chunks.push(chunk); }
    if (size !== manifest.asset.size) throw new Error('RUNTIME_SIZE_MISMATCH'); await writeFile(part, Buffer.concat(chunks));
    if (await sha256(part) !== manifest.asset.sha256) throw new Error('RUNTIME_SHA256_MISMATCH');
    await verifyGithubAttestation(part, manifest.asset.sha256, manifest.attestation.ref.replace(/^refs\/tags\//u, ''));
    this.set(target, { state: 'verified' });
  }
  async activateStaged(slot: 'A' | 'B', entries: readonly string[]): Promise<void> {
    for (const entry of entries) if (!validateArchiveEntry(entry)) throw new Error(`UNSAFE_ARCHIVE_ENTRY:${entry}`);
    const source = path.join(this.paths.staging, this.manifest!.asset.name + '.part');
    if (!(await stat(source)).isFile()) throw new Error('STAGED_RUNTIME_MISSING');
    const stateFile = path.join(this.paths.runtimes, 'runtime-state.json');
    await mkdir(this.paths.runtimes, { recursive: true });
    await writeFileAtomic(stateFile, JSON.stringify({ active: slot, previous: slot === 'A' ? 'B' : 'A', version: this.manifest!.runtime.version }) + '\n');
  }
  quitAndInstall(): void { updater().quitAndInstall(false, true); }
}
