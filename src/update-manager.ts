import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import updaterPackage from 'electron-updater';
import { verify, type Bundle } from 'sigstore';
import { z } from 'zod';
import semver from 'semver';
import { NtExecutable } from 'pe-library';
import { parseSevenZipSlt, scanExtractedTreeNoReparse } from './archive-inspection.js';
import { preflightRuntimeClosure } from './runtime-closure-inspector.js';
import { runRuntimeStagingSmoke } from './runtime-staging-smoke.js';
import { assertNoWindowsReparseComponents } from './windows-platform.js';
import type { RuntimeManifestV1, UpdateChannel, UpdateSnapshotV2, UpdateTarget } from './types.js';
import { DSH_VERSION } from './types.js';
import {
  createRuntimeCommitJournal,
  createRuntimeCommitTxid,
  parseRuntimeCommitJournal,
  recoverRuntimeCommit,
  writeRuntimeCommitJournal,
  type RuntimeCommitState
} from './runtime-commit-journal.js';

const updater = () => updaterPackage.autoUpdater;
const execFileAsync = promisify(execFile);
const DSH_RPC_PROTOCOL_VERSION = '1.0.0';

export interface AppUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1), channel: z.enum(['stable', 'preview']), generatedAt: z.iso.datetime(),
  minAppVersion: z.string(), platform: z.literal('win32'), arch: z.literal('x64'),
  runtime: z.object({ version: z.string(), dshPackage: z.literal('@deepseek-ai/dsh'), dshIntegrity: z.string(), nodeVersion: z.string(), pnpmVersion: z.string(), protocolCompatibility: z.string() }),
  asset: z.object({ name: z.string(), url: z.url(), size: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
  source: z.object({ upstreamRepo: z.literal('deepseek-ai/DeepSeek-Harness'), npmPublishedAt: z.string(), upstreamCommit: z.string().optional() }),
  attestation: z.object({ repository: z.literal('xydadada/adhd-one'), workflow: z.string(), ref: z.string(), subjectDigest: z.string() }), notesUrl: z.string().optional()
});

const githubDownloadHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const runtimeProgressByteThreshold = 256 * 1024;
const runtimeProgressTimeThresholdMs = 100;
const attestationResponseLimit = 4 * 1024 * 1024;
const attestationResponseSchema = z.object({
  attestations: z.array(z.object({ bundle: z.unknown().optional() }).passthrough()).max(64).optional()
}).passthrough();

export function runtimeValidationEnvironment(nodePath: string, home: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: process.env.ComSpec ?? path.win32.join(systemRoot, 'System32', 'cmd.exe'),
    SystemDrive: process.env.SystemDrive ?? path.win32.parse(systemRoot).root.replace(/[\\/]$/u, ''),
    TEMP: process.env.TEMP ?? path.win32.join(systemRoot, 'Temp'),
    TMP: process.env.TMP ?? process.env.TEMP ?? path.win32.join(systemRoot, 'Temp'),
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE ?? 'AMD64',
    PATH: [path.win32.dirname(nodePath), path.win32.join(systemRoot, 'System32')].join(';'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1'
  };
  return environment;
}

const runtimeStateSchema = z.object({
  active: z.enum(['A', 'B', 'bundled']).optional(),
  previous: z.enum(['A', 'B', 'bundled']).optional(),
  version: z.string().optional(),
  healthy: z.boolean().optional(),
  candidate: z.boolean().optional()
}).passthrough().superRefine((value, context) => {
  if ((value.active === 'A' || value.active === 'B') && value.previous === value.active) {
    context.addIssue({ code: 'custom', message: 'runtime previous slot must differ from active slot' });
  }
});

const runtimeStateFileName = 'runtime-state.json';
const runtimeCommitJournalFileName = '.runtime-commit-journal.json';

function trustedGithubUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !githubDownloadHosts.has(url.hostname)) throw new Error('UNTRUSTED_GITHUB_URL');
  return url;
}

async function fetchGithub(url: string, signal: AbortSignal): Promise<Response> {
  let current = trustedGithubUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('GITHUB_REDIRECT_MISSING');
    current = trustedGithubUrl(new URL(location, current).href);
  }
  throw new Error('GITHUB_REDIRECT_LIMIT');
}

async function readJsonBounded(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('RESPONSE_BODY_MISSING');
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > limit) throw new Error('MANIFEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const releaseListSchema = z.array(z.object({
  draft: z.boolean(), prerelease: z.boolean(), tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() }))
}));

async function resolveRuntimeManifestUrl(source: string, channel: 'stable' | 'preview'): Promise<string | undefined> {
  const url = new URL(source);
  if (url.hostname !== 'api.github.com') return source;
  if (url.protocol !== 'https:' || url.pathname !== '/repos/xydadada/adhd-one/releases') throw new Error('UNTRUSTED_RELEASES_API');
  const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`RELEASES_HTTP_${response.status}`);
  const releases = releaseListSchema.parse(await readJsonBounded(response, 2 * 1024 * 1024))
    .filter(release => !release.draft && (channel === 'preview' || !release.prerelease))
    .filter(release => {
      const version = semver.valid(release.tag_name.replace(/^v/u, ''));
      return Boolean(version && (channel === 'preview' || !semver.prerelease(version)));
    })
    .sort((left, right) => semver.rcompare(left.tag_name.replace(/^v/u, ''), right.tag_name.replace(/^v/u, '')));
  const asset = releases[0]?.assets.find(value => value.name === 'runtime-manifest.json');
  return asset?.browser_download_url;
}

export function parseRuntimeManifest(value: unknown, channel: 'stable' | 'preview', appVersion?: string): RuntimeManifestV1 {
  const parsed = manifestSchema.parse(value) as RuntimeManifestV1;
  if (parsed.channel !== channel) throw new Error('RUNTIME_CHANNEL_MISMATCH');
  if (!semver.valid(parsed.runtime.version) || !semver.valid(parsed.minAppVersion)) throw new Error('INVALID_RUNTIME_SEMVER');
  if (!semver.validRange(parsed.runtime.protocolCompatibility)
    || !semver.satisfies(DSH_RPC_PROTOCOL_VERSION, parsed.runtime.protocolCompatibility)) {
    throw new Error('DSH_PROTOCOL_INCOMPATIBLE');
  }
  if (channel === 'stable' && semver.prerelease(parsed.runtime.version)) throw new Error('PRERELEASE_ON_STABLE');
  if (appVersion && (!semver.valid(appVersion) || semver.lt(appVersion, parsed.minAppVersion))) throw new Error('APP_VERSION_TOO_OLD');
  try { trustedGithubUrl(parsed.asset.url); } catch { throw new Error('UNTRUSTED_RUNTIME_ASSET'); }
  if (parsed.attestation.subjectDigest !== `sha256:${parsed.asset.sha256}`) throw new Error('ATTESTATION_DIGEST_MISMATCH');
  if (parsed.attestation.workflow !== '.github/workflows/release.yml' || !/^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.attestation.ref)) throw new Error('ATTESTATION_IDENTITY_INVALID');
  const tag = parsed.attestation.ref.replace(/^refs\/tags\//u, '');
  const assetUrl = new URL(parsed.asset.url);
  if (!/^[A-Za-z0-9._-]+$/u.test(parsed.asset.name)
    || decodeURIComponent(assetUrl.pathname) !== `/xydadada/adhd-one/releases/download/${tag}/${parsed.asset.name}`) throw new Error('RUNTIME_RELEASE_IDENTITY_MISMATCH');
  return parsed;
}

export function isRuntimeUpgrade(candidate: string, current: string): boolean {
  return Boolean(semver.valid(candidate) && semver.valid(current) && semver.gt(candidate, current));
}

export function selectRuntimeInstallSlots(current: { active?: 'A' | 'B' | 'bundled'; previous?: 'A' | 'B' | 'bundled'; healthy?: boolean; candidate?: boolean }): { slot: 'A' | 'B'; previous: 'A' | 'B' | 'bundled' } {
  const activeSlot = current.active === 'A' || current.active === 'B' ? current.active : undefined;
  const pendingCandidate = Boolean(activeSlot && (current.healthy !== true || current.candidate === true));
  const slot: 'A' | 'B' = pendingCandidate ? activeSlot! : activeSlot === 'A' ? 'B' : 'A';
  const recordedPrevious = current.previous === activeSlot ? 'bundled' : current.previous ?? 'bundled';
  const previous = current.active === 'bundled' ? 'bundled'
    : activeSlot && !pendingCandidate && current.healthy === true ? activeSlot : recordedPrevious;
  return { slot, previous };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verifyGithubAttestation(digest: string, tag: string, assetName: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(digest) || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)
    || !/^[A-Za-z0-9._-]+$/u.test(assetName)) throw new Error('ATTESTATION_INPUT_INVALID');
  const issuer = 'https://token.actions.githubusercontent.com';
  const identity = `https://github.com/xydadada/adhd-one/.github/workflows/release.yml@refs/tags/${tag}`;
  const response = await fetch(`https://api.github.com/repos/xydadada/adhd-one/attestations/sha256:${digest}`, {
    redirect: 'error',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`ATTESTATION_HTTP_${response.status}`);
  const body = attestationResponseSchema.parse(await readJsonBounded(response, attestationResponseLimit));
  const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const entry of body.attestations ?? []) {
    const bundle = entry.bundle as Bundle | undefined;
    if (!bundle?.dsseEnvelope?.payload || bundle.dsseEnvelope.payloadType !== 'application/vnd.in-toto+json') continue;
    try {
      const signer = await verify(bundle, {
        ctLogThreshold: 1,
        tlogThreshold: 1,
        certificateIssuer: issuer,
        certificateIdentityURI: `^${escapedIdentity}$`
      });
      if (signer.identity?.extensions?.issuer !== issuer || signer.identity.subjectAlternativeName !== identity) continue;
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
        _type?: unknown;
        predicateType?: unknown;
        subject?: Array<{ name?: unknown; digest?: { sha256?: unknown } } | null>;
      };
      if (statement._type === 'https://in-toto.io/Statement/v1'
        && statement.predicateType === 'https://in-toto.io/attestation/release/v0.1'
        && Array.isArray(statement.subject)
        && statement.subject.some(subject => subject?.digest?.sha256 === digest && typeof subject.name === 'string'
          && (subject.name === assetName || subject.name.replace(/\\/gu, '/').endsWith(`/${assetName}`)))) return;
    } catch { continue; }
  }
  throw new Error('ATTESTATION_NOT_FOUND');
}

interface UpdatePaths {
  staging: string;
  runtimes: string;
  sevenZip: string;
  appPath?: string;
  resourcesPath?: string;
  packaged?: boolean;
}

interface AppUpdateCandidate {
  readonly version: string;
  readonly tag: string;
  readonly assetName: string;
  readonly generation: number;
}

interface RuntimeUpdateCandidate {
  readonly manifest: RuntimeManifestV1;
  readonly channel: 'stable' | 'preview';
  readonly generation: number;
}

type UpdateCandidate = AppUpdateCandidate | RuntimeUpdateCandidate;

export class UpdateManager extends EventEmitter {
  private snapshots: Map<UpdateTarget, UpdateSnapshotV2>;
  private appCandidate?: AppUpdateCandidate;
  private runtimeCandidate?: RuntimeUpdateCandidate;
  private verifiedAppCandidate?: AppUpdateCandidate;
  private confirming = new Set<UpdateTarget>();
  private checkGenerations = new Map<UpdateTarget, number>();
  constructor(
    private readonly paths: UpdatePaths,
    private readonly appVersion: string,
    private readonly manifestUrl: string,
    private readonly portable = false,
    private readonly appUpdater: AppUpdaterAdapter = updater()
  ) {
    super();
    this.snapshots = new Map<UpdateTarget, UpdateSnapshotV2>([
      ['app', { target: 'app', channel: 'stable', phase: 'idle', currentVersion: appVersion, canConfirm: false, canInstall: false, rollback: false }],
      ['runtime', { target: 'runtime', channel: 'stable', phase: 'idle', currentVersion: DSH_VERSION, canConfirm: false, canInstall: false, rollback: false }]
    ]);
    this.appUpdater.autoDownload = false;
    this.appUpdater.autoInstallOnAppQuit = false;
    this.appUpdater.allowPrerelease = false;
  }
  snapshot(target: UpdateTarget): UpdateSnapshotV2 { return structuredClone(this.snapshots.get(target)!); }
  private set(target: UpdateTarget, patch: Partial<Omit<UpdateSnapshotV2, 'target' | 'canConfirm' | 'canInstall'>>): void {
    const next = { ...this.snapshot(target), ...patch } as UpdateSnapshotV2;
    for (const key of ['candidateVersion', 'receivedBytes', 'totalBytes', 'error'] as const) if (key in patch && patch[key] === undefined) delete next[key];
    next.canConfirm = next.phase === 'available';
    const appCandidate = this.appCandidate;
    next.canInstall = target === 'app' && !this.portable && next.phase === 'verified'
      && appCandidate !== undefined && this.verifiedAppCandidate === appCandidate
      && appCandidate.generation === this.checkGenerations.get('app') && next.candidateVersion === appCandidate.version;
    if (patch.rollback !== undefined) next.rollback = patch.rollback;
    this.snapshots.set(target, next); this.emit('changed', next);
  }
  private isCurrentConfirmation(target: UpdateTarget, generation: number | undefined, candidate: UpdateCandidate | undefined): boolean {
    if (generation === undefined || candidate === undefined || candidate.generation !== generation
      || this.checkGenerations.get(target) !== generation) return false;
    const snapshot = this.snapshot(target);
    if (target === 'app') {
      const appCandidate = candidate as AppUpdateCandidate;
      return this.appCandidate === appCandidate && snapshot.candidateVersion === appCandidate.version;
    }
    const runtimeCandidate = candidate as RuntimeUpdateCandidate;
    return this.runtimeCandidate === runtimeCandidate && snapshot.candidateVersion === runtimeCandidate.manifest.runtime.version;
  }
  private assertCurrentConfirmation(target: UpdateTarget, generation: number | undefined, candidate: UpdateCandidate | undefined): void {
    if (!this.isCurrentConfirmation(target, generation, candidate)) throw new Error('UPDATE_CONFIRM_STALE');
  }
  private async recoverRuntimeCommitIfPresent(): Promise<void> {
    const journalPath = path.join(this.paths.runtimes, runtimeCommitJournalFileName);
    let serialized: string;
    try {
      serialized = await readFile(journalPath, 'utf8');
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    const journal = parseRuntimeCommitJournal(JSON.parse(serialized) as unknown);
    await recoverRuntimeCommit({
      runtimeRoot: this.paths.runtimes,
      stateFile: runtimeStateFileName,
      journal,
      journalFile: runtimeCommitJournalFileName
    });
  }
  async check(target: UpdateTarget, channel: UpdateChannel): Promise<UpdateSnapshotV2> {
    if (this.confirming.has(target)) throw new Error('UPDATE_CONFIRM_IN_PROGRESS');
    const generation = (this.checkGenerations.get(target) ?? 0) + 1;
    this.checkGenerations.set(target, generation);
    if (target === 'app') { delete this.appCandidate; delete this.verifiedAppCandidate; }
    if (target === 'runtime') delete this.runtimeCandidate;
    this.set(target, {
      channel,
      phase: 'checking',
      currentVersion: target === 'app' ? this.appVersion : this.snapshot(target).currentVersion,
      candidateVersion: undefined,
      receivedBytes: undefined,
      totalBytes: undefined,
      error: undefined,
      rollback: false
    });
    try {
      if (target === 'app') {
        this.appUpdater.allowPrerelease = channel === 'preview';
        const result = await this.appUpdater.checkForUpdates() as { updateInfo?: { version?: string; tag?: unknown; files: Array<{ url: string }> } } | null;
        const updateInfo = result?.updateInfo;
        const version = updateInfo?.version;
        if (this.checkGenerations.get(target) !== generation) return this.snapshot(target);
        if (version && semver.valid(version) && semver.gt(version, this.appVersion)) {
          const assetName = `ADHD-One-Setup-${version}-x64.exe`;
          const matchingFiles = updateInfo.files.filter(file => file.url === assetName);
          if (updateInfo.tag !== `v${version}` || updateInfo.files.length !== 1 || matchingFiles.length !== 1) {
            throw new Error('APP_UPDATE_METADATA_MISMATCH');
          }
          this.appCandidate = { version, tag: updateInfo.tag, assetName, generation };
          this.set(target, { phase: 'available', candidateVersion: version });
        } else this.set(target, { phase: 'idle' });
      } else {
        const runtimeStatus = await this.currentRuntimeStatus();
        if (this.checkGenerations.get(target) !== generation) return this.snapshot(target);
        this.set(target, runtimeStatus);
        const manifestUrl = await resolveRuntimeManifestUrl(this.manifestUrl, channel);
        if (this.checkGenerations.get(target) !== generation) return this.snapshot(target);
        if (!manifestUrl) { this.set(target, { phase: 'idle' }); return this.snapshot(target); }
        const response = await fetchGithub(manifestUrl, AbortSignal.timeout(10_000));
        if (this.checkGenerations.get(target) !== generation) return this.snapshot(target);
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_048_576) throw new Error(`MANIFEST_HTTP_${response.status}`);
        const rawManifest = await readJsonBounded(response, 1_048_576);
        if (this.checkGenerations.get(target) !== generation) return this.snapshot(target);
        const advertisedChannel = z.object({ channel: z.enum(['stable', 'preview']) }).parse(rawManifest).channel;
        if (advertisedChannel !== channel) { this.set(target, { phase: 'idle' }); return this.snapshot(target); }
        const manifest = parseRuntimeManifest(rawManifest, channel, this.appVersion);
        const currentVersion = runtimeStatus.currentVersion;
        if (!isRuntimeUpgrade(manifest.runtime.version, currentVersion)) { this.set(target, { phase: 'idle', candidateVersion: undefined }); return this.snapshot(target); }
        this.runtimeCandidate = { manifest, channel, generation };
        this.set(target, { phase: 'available', candidateVersion: manifest.runtime.version });
      }
    } catch { if (this.checkGenerations.get(target) === generation) this.set(target, { phase: 'failed', error: { code: 'UPDATE_CHECK_FAILED', message: 'Update check failed.' } }); }
    return this.snapshot(target);
  }
  async confirm(target: UpdateTarget): Promise<void> {
    if (this.confirming.has(target)) throw new Error('UPDATE_CONFIRM_IN_PROGRESS');
    const generation = this.checkGenerations.get(target);
    const candidate: UpdateCandidate | undefined = target === 'app' ? this.appCandidate : this.runtimeCandidate;
    this.confirming.add(target);
    let runtimePart: string | undefined;
    try {
    if (this.snapshot(target).phase !== 'available') throw new Error('UPDATE_NOT_AVAILABLE');
    if (!this.isCurrentConfirmation(target, generation, candidate)) {
      throw new Error(target === 'app' ? 'APP_UPDATE_METADATA_MISSING' : 'RUNTIME_MANIFEST_MISSING');
    }
    const awaitCurrent = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await operation;
      this.assertCurrentConfirmation(target, generation, candidate);
      return result;
    };
    if (target === 'runtime') await awaitCurrent(this.recoverRuntimeCommitIfPresent());
    if (target === 'app') {
      if (this.portable) throw new Error('PORTABLE_UPDATE_DOWNLOAD_ONLY');
      const appCandidate = candidate as AppUpdateCandidate;
      delete this.verifiedAppCandidate;
      this.set(target, { phase: 'downloading' });
      const result = await awaitCurrent(this.appUpdater.downloadUpdate());
      const filename = result[0]; if (!filename) throw new Error('UPDATE_FILE_MISSING');
      if (path.basename(filename) !== appCandidate.assetName) throw new Error('UPDATE_ASSET_NAME_MISMATCH');
      const assetName = path.basename(filename);
      const digest = await awaitCurrent(sha256(filename));
      await awaitCurrent(verifyGithubAttestation(digest, appCandidate.tag, assetName));
      this.assertCurrentConfirmation(target, generation, candidate);
      this.verifiedAppCandidate = appCandidate;
      this.set(target, { phase: 'verified' }); return;
    }
    const runtimeCandidate = candidate as RuntimeUpdateCandidate;
    const manifest = runtimeCandidate.manifest; await awaitCurrent(mkdir(this.paths.staging, { recursive: true }));
    const part = path.join(this.paths.staging, `${manifest.asset.name}.part`); await awaitCurrent(rm(part, { force: true }));
    runtimePart = part;
    this.set(target, { phase: 'downloading', receivedBytes: 0, totalBytes: manifest.asset.size });
    const response = await awaitCurrent(fetchGithub(manifest.asset.url, AbortSignal.timeout(120_000)));
    if (!response.ok || !response.body) throw new Error(`RUNTIME_DOWNLOAD_HTTP_${response.status}`);
    const digest = createHash('sha256'); let size = 0;
    let lastReportedBytes = 0;
    let lastReportedAt = Date.now();
    const reportProgress = (receivedBytes: number, force = false): void => {
      if (!this.isCurrentConfirmation(target, generation, candidate)) return;
      const now = Date.now();
      if (!force && receivedBytes - lastReportedBytes < runtimeProgressByteThreshold && now - lastReportedAt < runtimeProgressTimeThresholdMs) return;
      if (receivedBytes === lastReportedBytes) return;
      this.set('runtime', { receivedBytes });
      lastReportedBytes = receivedBytes;
      lastReportedAt = now;
    };
    const handle = await awaitCurrent(open(part, 'wx'));
    try {
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > manifest.asset.size) { callback(new Error('RUNTIME_ASSET_TOO_LARGE')); return; }
        digest.update(chunk); reportProgress(size); callback(null, chunk);
      } });
      await awaitCurrent(pipeline(Readable.from(response.body as AsyncIterable<Uint8Array>), meter, handle.createWriteStream({ autoClose: false })));
      await awaitCurrent(handle.sync());
    } finally { await awaitCurrent(handle.close().catch(() => undefined)); }
    if (size <= manifest.asset.size) reportProgress(size, true);
    if (size !== manifest.asset.size) throw new Error('RUNTIME_SIZE_MISMATCH');
    if (digest.digest('hex') !== manifest.asset.sha256) throw new Error('RUNTIME_SHA256_MISMATCH');
    await awaitCurrent(verifyGithubAttestation(manifest.asset.sha256, manifest.attestation.ref.replace(/^refs\/tags\//u, ''), manifest.asset.name));
    this.assertCurrentConfirmation(target, generation, candidate);
    this.set(target, { phase: 'installing' });
    await awaitCurrent(this.installVerifiedRuntime(part, manifest));
    await awaitCurrent(rm(part, { force: true })); runtimePart = undefined;
    this.assertCurrentConfirmation(target, generation, candidate);
    this.set(target, { phase: 'verified', rollback: true });
    } catch (error) {
      if (runtimePart) await rm(runtimePart, { force: true }).catch(() => undefined);
      if (this.isCurrentConfirmation(target, generation, candidate)) {
        if (target === 'app' && this.verifiedAppCandidate === candidate) delete this.verifiedAppCandidate;
        this.set(target, { phase: 'failed', error: { code: 'UPDATE_INSTALL_FAILED', message: 'Update verification or installation failed.' } });
      }
      throw error;
    } finally {
      this.confirming.delete(target);
    }
  }
  private async installVerifiedRuntime(archive: string, manifest: RuntimeManifestV1): Promise<void> {
    await this.recoverRuntimeCommitIfPresent();
    await mkdir(this.paths.runtimes, { recursive: true });
    const stateFile = path.join(this.paths.runtimes, runtimeStateFileName);
    let beforeState: RuntimeCommitState | null = null;
    let current: { active?: 'A' | 'B' | 'bundled'; previous?: 'A' | 'B' | 'bundled'; healthy?: boolean; candidate?: boolean } = {};
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
      const validated = runtimeStateSchema.parse(parsed);
      beforeState = validated as RuntimeCommitState;
      current = {
        ...(validated.active !== undefined ? { active: validated.active } : {}),
        ...(validated.previous !== undefined ? { previous: validated.previous } : {}),
        ...(validated.healthy !== undefined ? { healthy: validated.healthy } : {}),
        ...(validated.candidate !== undefined ? { candidate: validated.candidate } : {})
      };
    } catch (error) {
      if (!isMissingPathError(error)) throw new Error('RUNTIME_STATE_INVALID', { cause: error });
    }
    const { slot, previous: previousHealthy } = selectRuntimeInstallSlots(current);
    const destinationName = `slot-${slot}`;
    const destination = path.join(this.paths.runtimes, destinationName);
    const validationRoot = path.join(this.paths.runtimes, `.staging-${slot}-${randomBytes(8).toString('hex')}`);
    const staging = path.join(validationRoot, `slot-${slot}`);
    await mkdir(staging, { recursive: true });
    const verifiedArchive = path.join(validationRoot, 'runtime.verified.7z');
    let journalWritten = false;
    try {
      await copyFile(archive, verifiedArchive, fsConstants.COPYFILE_EXCL);
      const assertVerifiedArchive = async (): Promise<void> => {
        const archiveStats = await stat(verifiedArchive);
        if (!archiveStats.isFile() || archiveStats.size !== manifest.asset.size) throw new Error('RUNTIME_VERIFIED_ARCHIVE_SIZE_MISMATCH');
        if (await sha256(verifiedArchive) !== manifest.asset.sha256) throw new Error('RUNTIME_VERIFIED_ARCHIVE_SHA256_MISMATCH');
      };
      await assertVerifiedArchive();
      const listing = await execFileAsync(this.paths.sevenZip, ['l', '-slt', '-sccUTF-8', verifiedArchive], {
        windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer'
      });
      const inspection = parseSevenZipSlt(listing.stdout, {
        maxEntries: 50_000,
        maxFileSize: 512 * 1024 * 1024,
        maxTotalSize: 1024 * 1024 * 1024
      });
      await assertVerifiedArchive();
      assertNoWindowsReparseComponents(staging);
      await execFileAsync(this.paths.sevenZip, ['x', '-y', '-sccUTF-8', `-o${staging}`, verifiedArchive], { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      await assertVerifiedArchive();
      await scanExtractedTreeNoReparse(staging, inspection.entries);
      await preflightRuntimeClosure({
        activeRuntimeRoot: path.join(staging, 'dsh-runtime'),
        slot,
        scanMode: 'deep'
      });
      const nodePath = path.join(staging, 'node-runtime', 'node.exe');
      const executable = NtExecutable.from(await readFile(nodePath), { ignoreCert: true });
      if (executable.is32bit() || executable.newHeader.fileHeader.machine !== 0x8664) throw new Error('RUNTIME_NODE_NOT_X64');
      const dshPackage = JSON.parse(await readFile(path.join(staging, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: string };
      const runtimePackage = JSON.parse(await readFile(path.join(staging, 'dsh-runtime', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      const runtimeLock = JSON.parse(await readFile(path.join(staging, 'dsh-runtime', 'package-lock.json'), 'utf8')) as { packages?: Record<string, { integrity?: string }> };
      if (dshPackage.version !== manifest.runtime.version || runtimePackage.dependencies?.['@deepseek-ai/dsh'] !== manifest.runtime.version
        || runtimePackage.dependencies?.pnpm !== manifest.runtime.pnpmVersion
        || runtimeLock.packages?.['node_modules/@deepseek-ai/dsh']?.integrity !== manifest.runtime.dshIntegrity) throw new Error('RUNTIME_PACKAGE_MISMATCH');
      const validationHome = path.join(validationRoot, 'version-home');
      await mkdir(path.join(validationHome, 'AppData', 'Roaming'), { recursive: true });
      await mkdir(path.join(validationHome, 'AppData', 'Local'), { recursive: true });
      const validationEnvironment = runtimeValidationEnvironment(nodePath, validationHome);
      const nodeVersion = (await execFileAsync(nodePath, ['--version'], {
        windowsHide: true, timeout: 10_000, env: validationEnvironment
      })).stdout.trim().replace(/^v/u, '');
      if (nodeVersion !== manifest.runtime.nodeVersion) throw new Error('RUNTIME_NODE_VERSION_MISMATCH');
      const dshEntry = path.join(staging, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      const dshVersion = (await execFileAsync(nodePath, [dshEntry, '--version'], { windowsHide: true, timeout: 20_000,
        env: validationEnvironment })).stdout;
      if (!dshVersion.includes(manifest.runtime.version)) throw new Error('RUNTIME_DSH_VERSION_MISMATCH');
      if (!this.paths.appPath || !this.paths.resourcesPath || typeof this.paths.packaged !== 'boolean') throw new Error('RUNTIME_SMOKE_PATHS_MISSING');
      await runRuntimeStagingSmoke({
        validationRoot, slot, version: manifest.runtime.version,
        appPath: this.paths.appPath, resourcesPath: this.paths.resourcesPath, packaged: this.paths.packaged
      });
      assertNoWindowsReparseComponents(destination);
      const destinationWasPresent = await pathExists(destination);
      const txid = createRuntimeCommitTxid();
      const afterState: RuntimeCommitState = {
        schemaVersion: 1,
        active: slot,
        previous: previousHealthy,
        version: manifest.runtime.version,
        healthy: false,
        candidate: true,
        installedAt: new Date().toISOString()
      };
      const journal = createRuntimeCommitJournal({
        txid,
        slot,
        stagingRoot: path.relative(this.paths.runtimes, validationRoot),
        staging: path.relative(this.paths.runtimes, staging),
        destination: destinationName,
        backup: `.rollback-${slot}-${txid}`,
        beforeState,
        afterState,
        destinationWasPresent
      });
      const journalPath = path.join(this.paths.runtimes, runtimeCommitJournalFileName);
      await writeRuntimeCommitJournal(journalPath, journal);
      journalWritten = true;
      await recoverRuntimeCommit({
        runtimeRoot: this.paths.runtimes,
        stateFile: runtimeStateFileName,
        journal,
        journalFile: runtimeCommitJournalFileName
      });
    } catch (error) {
      if (!journalWritten) await rm(validationRoot, { recursive: true, force: true });
      throw error;
    }
  }
  private async currentRuntimeStatus(): Promise<{ currentVersion: string; rollback: boolean }> {
    await this.recoverRuntimeCommitIfPresent();
    try {
      const state = runtimeStateSchema.parse(JSON.parse(await readFile(path.join(this.paths.runtimes, runtimeStateFileName), 'utf8')));
      const currentVersion = state.healthy === true && state.version && semver.valid(state.version) ? state.version : DSH_VERSION;
      const previous = state.previous ?? 'bundled';
      const rollback = (state.active === 'A' || state.active === 'B') && (state.healthy === false || state.candidate === true)
        && Boolean(state.version && semver.valid(state.version)) && previous !== state.active;
      return { currentVersion, rollback };
    } catch { return { currentVersion: DSH_VERSION, rollback: false }; }
  }
  async refreshRuntimeStatus(): Promise<UpdateSnapshotV2> {
    const status = await this.currentRuntimeStatus();
    this.set('runtime', {
      currentVersion: status.currentVersion,
      rollback: status.rollback,
      ...(!status.rollback ? { phase: 'idle' as const, candidateVersion: undefined } : {})
    });
    return this.snapshot('runtime');
  }
  isPortable(): boolean { return this.portable; }
  quitAndInstall(): void {
    const snapshot = this.snapshot('app');
    const candidate = this.appCandidate;
    if (this.portable || !snapshot.canInstall || !candidate || this.verifiedAppCandidate !== candidate
      || candidate.generation !== this.checkGenerations.get('app') || snapshot.candidateVersion !== candidate.version) {
      throw new Error('APP_UPDATE_NOT_VERIFIED');
    }
    this.appUpdater.quitAndInstall(false, true);
  }
}
