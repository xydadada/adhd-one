import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsStore } from './settings-store.js';
import { writeFileAtomic } from './settings-store.js';
import { createManagedProcess, type ManagedProcess } from './windows-platform.js';
import { parseLoopbackRuntimeUrl, redactText } from './security.js';
import {
  preflightActiveRuntimeClosure,
  RuntimeClosurePreflightError
} from './runtime-closure-inspector.js';
import { parseRuntimeCommitJournal, recoverRuntimeCommit } from './runtime-commit-journal.js';
import { DSH_VERSION, type RuntimeSnapshotV2, type RuntimeSlot } from './types.js';

export interface RuntimePaths {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  dshHome: string;
  logs: string;
  runtimes: string;
}

export interface RuntimeEnvironmentOptions {
  isolatedEnv?: boolean;
  overrides?: NodeJS.ProcessEnv;
}

type RuntimeEnvironmentInput = RuntimeEnvironmentOptions | NodeJS.ProcessEnv;

const WINDOWS_RUNTIME_ENV_ALLOWLIST = [
  'ALLUSERSPROFILE',
  'ComSpec',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'windir'
] as const;

const RUNTIME_ENVIRONMENT_SANITIZED_KEYS = [
  'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'ADHD_SMOKE_DATA_ROOT'
] as const;

function findEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(environment, key)) return key;
  const lowerKey = key.toLowerCase();
  return Object.keys(environment).find(candidate => candidate.toLowerCase() === lowerKey);
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const actualKey = findEnvironmentKey(environment, key);
  return actualKey === undefined ? undefined : environment[actualKey];
}

function deleteEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): void {
  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(environment)) {
    if (existingKey.toLowerCase() === lowerKey) delete environment[existingKey];
  }
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, key: string, value: string): void {
  deleteEnvironmentKey(environment, key);
  environment[key] = value;
}

function applyEnvironmentOverrides(environment: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv | undefined): void {
  for (const [key, value] of Object.entries(overrides ?? {})) {
    deleteEnvironmentKey(environment, key);
    if (value !== undefined) environment[key] = value;
  }
}

function createIsolatedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of WINDOWS_RUNTIME_ENV_ALLOWLIST) {
    const value = environmentValue(source, key);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isRuntimeEnvironmentOptions(value: RuntimeEnvironmentInput): value is RuntimeEnvironmentOptions {
  const record = value as unknown as Record<string, unknown>;
  return typeof record.isolatedEnv === 'boolean'
    || (Object.prototype.hasOwnProperty.call(record, 'overrides')
      && typeof record.overrides === 'object' && record.overrides !== null);
}

interface RuntimeSelection { root: string; node: string; slot: RuntimeSlot; version: string; candidate: boolean }

type CandidateSlot = Exclude<RuntimeSlot, 'bundled'>;

interface RuntimeStateRecord {
  active?: CandidateSlot;
  previous?: RuntimeSlot;
  previousHealthy?: RuntimeSlot;
  version?: string;
  healthy?: boolean;
  candidate?: boolean;
}

type RuntimeSnapshotPatch = Partial<Omit<RuntimeSnapshotV2, 'health'>>;

type SupervisorMessage = {
  v: 1;
  generation: number;
  type: 'hello' | 'starting' | 'ready' | 'fatal' | 'stopping';
  nonce?: string;
  pid?: number;
  url?: string;
  code?: string;
  message?: string;
};

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

function healthForState(state: RuntimeSnapshotV2['state']): RuntimeSnapshotV2['health'] {
  if (state === 'ready') return 'healthy';
  if (state === 'failed') return 'unhealthy';
  return 'unknown';
}

export class RuntimeController extends EventEmitter {
  private snapshotValue: RuntimeSnapshotV2 = {
    state: 'idle', generation: 0, runtimeVersion: DSH_VERSION, slot: 'bundled', health: 'unknown', restartAttempt: 0
  };
  private readonly queue = new SerialQueue();
  private process: ManagedProcess | undefined;
  private nonce: string | undefined;
  private stopping = false;
  private stopRequested = false;
  private crashTimes: number[] = [];
  private pipeTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private crashWindowTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private candidateSlot: CandidateSlot | undefined;
  private candidateGeneration: number | undefined;
  private intentId = 0;

  constructor(
    private readonly settings: SettingsStore,
    private readonly paths: RuntimePaths,
    environment: RuntimeEnvironmentInput = {}
  ) {
    super();
    this.environmentOptions = isRuntimeEnvironmentOptions(environment) ? environment : { overrides: environment };
  }

  private readonly environmentOptions: RuntimeEnvironmentOptions;

  snapshot(): RuntimeSnapshotV2 { return structuredClone(this.snapshotValue); }

  start(): Promise<RuntimeSnapshotV2> {
    const intent = ++this.intentId;
    this.stopRequested = false;
    return this.queue.run(async () => {
      if (intent !== this.intentId) return this.snapshot();
      if (this.snapshotValue.state === 'ready') return this.snapshot();
      if (['preparing', 'starting', 'stopping', 'updating'].includes(this.snapshotValue.state)) {
        throw new Error(`RUNTIME_BUSY:${this.snapshotValue.state}`);
      }
      return this.startAttempt(false, intent);
    });
  }

  restart(): Promise<RuntimeSnapshotV2> {
    const intent = ++this.intentId;
    this.stopRequested = false;
    return this.queue.run(async () => { if (intent !== this.intentId) return this.snapshot(); await this.stopInternal(); return this.startAttempt(false, intent); });
  }

  stop(): Promise<RuntimeSnapshotV2> {
    ++this.intentId;
    this.stopRequested = true;
    this.cancelRestart();
    if (this.snapshotValue.state === 'preparing' || this.snapshotValue.state === 'starting') {
      try { this.process?.terminate(0); } catch {}
    }
    return this.queue.run(() => this.stopInternal());
  }

  /** Last-resort bounded shutdown used only when the coordinated quit deadline expires. */
  forceShutdown(): void {
    ++this.intentId;
    this.stopRequested = true;
    this.stopping = true;
    this.cancelRestart();
    const child = this.process;
    if (!child) return;
    try { child.terminate(1); } catch {}
    try { child.close(); } catch {}
    this.clearHandles(child);
  }

  setUpdating(updating: boolean): void {
    ++this.intentId;
    this.cancelRestart();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.stopRequested = updating;
    if (updating) {
      this.setSnapshot({ state: 'updating', pid: undefined, url: undefined, error: undefined });
      return;
    }
    this.stopRequested = false;
    this.setSnapshot({ state: 'idle', pid: undefined, url: undefined, error: undefined });
  }

  private async startAttempt(portFallback: boolean, intent: number): Promise<RuntimeSnapshotV2> {
    this.cancelRestart();
    this.refreshCrashWindow();
    if (this.cancelled(intent)) return this.cancelledSnapshot();
    const settings = this.settings.get();
    if (!settings.workspace) {
      this.setSnapshot({ state: 'failed', error: { code: 'WORKSPACE_REQUIRED', message: 'Choose a workspace before starting Harness.' } });
      return this.snapshot();
    }
    const generation = this.snapshotValue.generation + 1;
    this.stopping = false;
    this.setSnapshot({ state: 'preparing', generation, error: undefined, pid: undefined, url: undefined });
    try {
      await Promise.all([mkdir(this.paths.dshHome, { recursive: true }), mkdir(this.paths.logs, { recursive: true })]);
    } catch (error) {
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      this.setSnapshot({ state: 'failed', pid: undefined, url: undefined, error: {
        code: 'RUNTIME_PREPARE_FAILED', message: redactText(String(error instanceof Error ? error.message : error))
      } });
      return this.snapshot();
    }
    if (this.cancelled(intent)) return this.cancelledSnapshot();

    try {
      await this.recoverPendingRuntimeCommit();
    } catch {
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      this.setSnapshot({
        state: 'failed',
        pid: undefined,
        url: undefined,
        error: { code: 'RUNTIME_COMMIT_RECOVERY_FAILED', message: 'Runtime update recovery failed.' }
      });
      return this.snapshot();
    }
    if (this.cancelled(intent)) return this.cancelledSnapshot();

    const selection = await this.selectRuntime();
    if (this.cancelled(intent)) return this.cancelledSnapshot();
    const candidateRun = selection.slot !== 'bundled' && (selection.candidate || selection.slot === this.candidateSlot);
    if (!candidateRun && selection.slot !== this.candidateSlot) this.clearCandidateProbation();
    const runtimeRoot = selection.root;
    const node = selection.node;
    this.setSnapshot({ slot: selection.slot, runtimeVersion: selection.version });
    try {
      await preflightActiveRuntimeClosure({
        activeRuntimeRoot: runtimeRoot,
        slot: selection.slot,
        scanMode: 'registered'
      });
    } catch (error) {
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      if (candidateRun && selection.slot !== 'bundled' && await this.rollbackCandidate(selection.slot, true)) {
        this.clearCandidateProbation(selection.slot);
        return this.startAttempt(false, intent);
      }
      const code = error instanceof RuntimeClosurePreflightError
        ? error.code
        : 'RUNTIME_CLOSURE_SCAN_FAILED';
      this.setSnapshot({
        state: 'failed',
        pid: undefined,
        url: undefined,
        error: { code, message: 'Runtime package verification failed.' }
      });
      return this.snapshot();
    }
    if (this.cancelled(intent)) return this.cancelledSnapshot();
    const supervisor = this.paths.packaged ? path.join(this.paths.resourcesPath, 'supervisor', 'supervisor.mjs') : path.join(this.paths.appPath, 'src', 'supervisor.mjs');
    const dshEntry = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const binPath = path.join(runtimeRoot, 'bin');
    const logPath = path.join(this.paths.logs, `runtime-${new Date().toISOString().replaceAll(':', '-')}.log`);
    const nonce = randomBytes(32).toString('hex');
    this.nonce = nonce;

    const port = portFallback ? 0 : settings.preferredPort;
    const environment = this.runtimeEnvironment({ runtimeRoot, binPath, nonce, generation, dshEntry, logPath, port, node });
    this.setSnapshot({ state: 'starting' });
    let child: ManagedProcess;
    try { child = createManagedProcess({ executable: node, args: [supervisor], cwd: settings.workspace, env: environment }); }
    catch (error) {
      this.clearHandles();
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      this.setSnapshot({ state: 'failed', pid: undefined, error: { code: 'RUNTIME_SPAWN_FAILED', message: redactText(String(error instanceof Error ? error.message : error)) } });
      return this.snapshot();
    }
    this.process = child;
    this.setSnapshot({ pid: child.pid });
    if (this.cancelled(intent)) { await this.terminateAndRelease(child); return this.cancelledSnapshot(); }

    const ready = this.waitForReady(child, generation, nonce, child.pid).catch(error => ({ kind: 'fatal' as const, error }));
    const exited = child.wait().then(
      code => ({ kind: 'exit' as const, code }),
      error => ({ kind: 'wait-failed' as const, error })
    );
    let startupTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
      startupTimer = setTimeout(() => resolve({ kind: 'timeout' }), 45_000);
    });
    let outcome: Awaited<typeof ready> | Awaited<typeof exited> | { kind: 'timeout' };
    try {
      outcome = await Promise.race([ready, exited, timeout]);
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    if (outcome.kind !== 'ready') {
      await this.terminateAndRelease(child);
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      const portInUse = outcome.kind === 'fatal' && outcome.error instanceof Error
        && outcome.error.message.startsWith('PORT_IN_USE:');
      if (!portFallback && portInUse) return this.startAttempt(true, intent);
      if (candidateRun && selection.slot !== 'bundled' && await this.rollbackCandidate(selection.slot, true)) {
        this.clearCandidateProbation(selection.slot);
        return this.startAttempt(false, intent);
      }
      const message = outcome.kind === 'exit' ? `Harness exited with code ${outcome.code}.`
        : outcome.kind === 'wait-failed' ? redactText(String(outcome.error instanceof Error ? outcome.error.message : outcome.error))
        : outcome.kind === 'fatal' ? redactText(String(outcome.error instanceof Error ? outcome.error.message : outcome.error))
          : 'Harness startup timed out.';
      const code = outcome.kind === 'exit' ? 'RUNTIME_EXITED' : outcome.kind === 'wait-failed' ? 'RUNTIME_WAIT_FAILED' : outcome.kind === 'fatal' ? 'SUPERVISOR_FAILED' : 'RUNTIME_TIMEOUT';
      this.setSnapshot({ state: 'failed', error: { code, message }, pid: undefined });
      return this.snapshot();
    }

    const url = parseLoopbackRuntimeUrl(outcome.url);
    try {
      if (!url) throw new Error('INVALID_READY_URL');
      const verification = await Promise.race([
        this.verifyHost(url.origin).then(() => ({ kind: 'verified' as const })),
        exited
      ]);
      if (verification.kind === 'exit') throw new Error(`RUNTIME_EXITED_DURING_READINESS:${verification.code}`);
      if (verification.kind === 'wait-failed') throw verification.error;
      if (this.process !== child || generation !== this.snapshotValue.generation || this.stopping || this.cancelled(intent)) throw new Error('STALE_RUNTIME_READINESS');
    } catch (error) {
      await this.terminateAndRelease(child);
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      if (candidateRun && selection.slot !== 'bundled' && await this.rollbackCandidate(selection.slot, true)) {
        this.clearCandidateProbation(selection.slot);
        return this.startAttempt(false, intent);
      }
      this.setSnapshot({ state: 'failed', pid: undefined, error: { code: 'RUNTIME_READINESS_FAILED', message: redactText(String(error instanceof Error ? error.message : error)) } });
      return this.snapshot();
    }
    try {
      if (portFallback) await this.settings.update({ preferredPort: Number(url.port) });
      if (this.cancelled(intent)) throw new Error('STALE_RUNTIME_READINESS');
      if (selection.candidate && selection.slot !== 'bundled') await this.markRuntimeHealthy(selection.slot, selection.version);
      if (this.cancelled(intent)) throw new Error('STALE_RUNTIME_READINESS');
      if (candidateRun && selection.slot !== 'bundled') {
        this.candidateSlot = selection.slot;
        this.candidateGeneration = generation;
      }
      this.setSnapshot({ state: 'ready', url: url.origin });
      void exited.then(result => this.handleUnexpectedExit(child, generation, result.kind === 'exit' ? result.code : 1,
        result.kind === 'wait-failed' ? redactText(String(result.error instanceof Error ? result.error.message : result.error)) : undefined));
      this.armStableTimer(generation);
      this.emit('ready', this.snapshot());
      return this.snapshot();
    } catch (error) {
      await this.terminateAndRelease(child);
      if (this.cancelled(intent)) return this.cancelledSnapshot();
      this.setSnapshot({ state: 'failed', pid: undefined, url: undefined, error: { code: 'RUNTIME_BOOKKEEPING_FAILED', message: redactText(String(error instanceof Error ? error.message : error)) } });
      return this.snapshot();
    }
  }

  private runtimeEnvironment(input: {
    runtimeRoot: string; binPath: string; nonce: string; generation: number;
    dshEntry: string; logPath: string; port: number; node: string;
  }): NodeJS.ProcessEnv {
    const isolated = this.environmentOptions.isolatedEnv === true;
    const env = isolated ? createIsolatedEnvironment(process.env) : { ...process.env };
    applyEnvironmentOverrides(env, this.environmentOptions.overrides);
    for (const key of RUNTIME_ENVIRONMENT_SANITIZED_KEYS) deleteEnvironmentKey(env, key);

    const systemRoot = environmentValue(env, 'SystemRoot') ?? environmentValue(env, 'windir') ?? 'C:\\Windows';
    const runtimePath = isolated
      ? [input.binPath, path.win32.dirname(input.node), path.win32.join(systemRoot, 'System32')].join(';')
      : `${input.binPath};${path.dirname(process.execPath)};${environmentValue(env, 'PATH') ?? ''}`;
    setEnvironmentValue(env, 'PATH', runtimePath);

    const fixedEnvironment: Record<string, string> = {
      ADHD_NODE_EXE: input.node,
      DSH_HOME: this.paths.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP: '1',
      NO_COLOR: '1',
      ADHD_NONCE: input.nonce,
      ADHD_GENERATION: String(input.generation),
      ADHD_DSH_ENTRY: input.dshEntry,
      ADHD_LOG: input.logPath,
      ADHD_PORT: String(input.port),
      ADHD_RUNTIME_ROOT: input.runtimeRoot
    };
    for (const [key, value] of Object.entries(fixedEnvironment)) setEnvironmentValue(env, key, value);
    return env;
  }

  private waitForReady(child: ManagedProcess, generation: number, nonce: string, pid: number): Promise<{ kind: 'ready'; url: string }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let hello = false;
      let settled = false;
      const finish = (error?: unknown, url?: string): void => {
        if (settled) return;
        settled = true;
        if (this.pipeTimer) clearInterval(this.pipeTimer);
        this.pipeTimer = undefined;
        if (error) reject(error); else if (url) resolve({ kind: 'ready', url });
      };
      this.pipeTimer = setInterval(() => {
        try {
          buffer += child.readAvailable().toString('utf8');
          if (buffer.length > 65_536 && !buffer.includes('\n')) throw new Error('SUPERVISOR_FRAME_TOO_LARGE');
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (Buffer.byteLength(raw, 'utf8') > 65_536) throw new Error('SUPERVISOR_FRAME_TOO_LARGE');
            const message = JSON.parse(raw) as SupervisorMessage;
            if (message.v !== 1 || message.generation !== generation) continue;
            if (message.type === 'hello') {
              if (message.nonce !== nonce || message.pid !== pid) throw new Error('SUPERVISOR_HANDSHAKE_REJECTED');
              hello = true;
            } else if (message.type === 'ready' && hello && message.url) finish(undefined, message.url);
            else if (message.type === 'fatal' && hello) throw new Error(`${message.code ?? 'SUPERVISOR_FATAL'}:${redactText(message.message ?? '')}`);
          }
        } catch (error) { finish(error); }
      }, 50);
      this.pipeTimer.unref();
    });
  }

  private async verifyHost(origin: string): Promise<void> {
    const response = await fetch(`${origin}/api/host.describe`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomBytes(12).toString('hex'), method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`HOST_DESCRIBE_HTTP_${response.status}`);
    const value = await response.json() as { result?: { ok?: boolean; error?: { code?: string } } };
    if (value.result?.ok !== true) throw new Error(`HOST_DESCRIBE_FAILED:${value.result?.error?.code ?? 'unknown'}`);
  }

  private async selectRuntime(): Promise<RuntimeSelection> {
    const bundled: RuntimeSelection = {
      root: this.paths.packaged ? path.join(this.paths.resourcesPath, 'dsh-runtime') : path.join(this.paths.appPath, 'runtime'),
      node: this.paths.packaged ? path.join(this.paths.resourcesPath, 'node-runtime', 'node.exe') : path.join(this.paths.appPath, 'vendor', 'node', 'node.exe'),
      slot: 'bundled', version: DSH_VERSION, candidate: false
    };
    const stateFile = path.join(this.paths.runtimes, 'runtime-state.json');
    let state: { active?: 'A' | 'B'; version?: string; healthy?: boolean; candidate?: boolean };
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8')) as typeof state;
    } catch { return bundled; }
    if ((state.active !== 'A' && state.active !== 'B') || typeof state.version !== 'string') return bundled;
    try {
      const slotRoot = path.join(this.paths.runtimes, `slot-${state.active}`);
      const dshPackage = JSON.parse(await readFile(path.join(slotRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: string };
      if (dshPackage.version === state.version) {
        return { root: path.join(slotRoot, 'dsh-runtime'), node: path.join(slotRoot, 'node-runtime', 'node.exe'), slot: state.active, version: state.version, candidate: state.candidate === true || state.healthy !== true };
      }
    } catch { /* Persist rollback below instead of retrying a broken active slot forever. */ }
    if (await this.rollbackCandidate(state.active, true)) return this.selectRuntime();
    throw new Error('RUNTIME_SLOT_INVALID_ROLLBACK_FAILED');
  }

  private async recoverPendingRuntimeCommit(): Promise<void> {
    const journalFile = path.join(this.paths.runtimes, '.runtime-commit-journal.json');
    let raw: string;
    try {
      raw = await readFile(journalFile, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const journal = parseRuntimeCommitJournal(JSON.parse(raw) as unknown);
    await recoverRuntimeCommit({
      runtimeRoot: this.paths.runtimes,
      stateFile: 'runtime-state.json',
      journal,
      journalFile: '.runtime-commit-journal.json'
    });
  }

  private async markRuntimeHealthy(slot: 'A' | 'B', version: string): Promise<void> {
    const stateFile = path.join(this.paths.runtimes, 'runtime-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
    if (state.active !== slot || state.version !== version) return;
    await writeFileAtomic(stateFile, JSON.stringify({ ...state, healthy: true, candidate: true, healthyAt: new Date().toISOString() }) + '\n');
  }

  private async markRuntimeStable(slot: 'A' | 'B', version: string): Promise<void> {
    const stateFile = path.join(this.paths.runtimes, 'runtime-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
    if (state.active !== slot || state.version !== version || state.candidate !== true) return;
    await writeFileAtomic(stateFile, JSON.stringify({ ...state, healthy: true, candidate: false, stableAt: new Date().toISOString() }) + '\n');
  }

  private async rollbackCandidate(slot: 'A' | 'B', allowHealthy = false): Promise<boolean> {
    const stateFile = path.join(this.paths.runtimes, 'runtime-state.json');
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8')) as { active?: string; previous?: string; healthy?: boolean };
      if (state.active !== slot || (state.healthy === true && !allowHealthy)) return false;
      if (state.previous === 'A' || state.previous === 'B') {
        const previousPackage = JSON.parse(await readFile(path.join(this.paths.runtimes, `slot-${state.previous}`, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: string };
        await writeFileAtomic(stateFile, JSON.stringify({ schemaVersion: 1, active: state.previous, previous: 'bundled', version: previousPackage.version, healthy: true, candidate: false, rolledBackFrom: slot }) + '\n');
      } else {
        await writeFileAtomic(stateFile, JSON.stringify({ schemaVersion: 1, active: 'bundled', previous: slot, version: DSH_VERSION, healthy: true, candidate: false, rolledBackFrom: slot }) + '\n');
      }
      this.emit('rolled-back', { from: slot });
      return true;
    } catch { return false; }
  }

  private async stopInternal(): Promise<RuntimeSnapshotV2> {
    this.cancelRestart();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    const child = this.process;
    if (!child) { this.setSnapshot({ state: 'idle', pid: undefined, url: undefined, error: undefined }); return this.snapshot(); }
    this.stopping = true;
    this.setSnapshot({ state: 'stopping' });
    try { child.write(`${JSON.stringify({ v: 1, type: 'stop', nonce: this.nonce, generation: this.snapshotValue.generation })}\n`); } catch {}
    const deadline = Date.now() + 4_500;
    let exited = await child.waitForTreeExit(3_500).catch(() => false);
    if (!exited) {
      try { child.terminate(1); } catch {}
      exited = await child.waitForTreeExit(Math.max(0, deadline - Date.now())).catch(() => false);
    }
    child.close();
    this.clearHandles(child);
    if (!exited) {
      this.setSnapshot({ state: 'failed', pid: undefined, url: undefined, error: { code: 'RUNTIME_TERMINATION_TIMEOUT', message: 'Harness process tree did not terminate within the shutdown deadline.' } });
      throw new Error('RUNTIME_TERMINATION_TIMEOUT');
    }
    this.setSnapshot({ state: 'idle', pid: undefined, url: undefined, error: undefined });
    return this.snapshot();
  }

  private handleUnexpectedExit(child: ManagedProcess, generation: number, code: number, detail?: string): void {
    const current = this.process === child;
    if (current && (this.stopping || this.stopRequested)) return;
    child.close();
    if (current) this.clearHandles(child);
    if (!current || this.stopping || this.stopRequested || generation !== this.snapshotValue.generation || this.snapshotValue.state !== 'ready') return;
    this.setSnapshot({ state: 'failed', pid: undefined, url: undefined, error: { code: 'RUNTIME_CRASHED', message: detail ?? `Harness exited with code ${code}.` } });
    this.emit('crashed', this.snapshot());
    this.refreshCrashWindow();
    if (this.crashTimes.length >= 3) {
      this.setSnapshot({ restartAttempt: this.crashTimes.length });
      return;
    }
    const delays = [500, 1_500, 4_500];
    const delay = delays[this.crashTimes.length] ?? 4_500;
    this.crashTimes.push(Date.now());
    this.setSnapshot({ restartAttempt: this.crashTimes.length });
    const restartIntent = this.intentId;
    this.armCrashWindowTimer();
    if (this.candidateSlot === this.snapshotValue.slot && this.candidateGeneration === generation
      && this.crashTimes.length >= 3) {
      const slot = this.candidateSlot;
      void this.queue.run(async () => {
        if (this.stopRequested || restartIntent !== this.intentId) return this.snapshot();
        if (await this.rollbackCandidate(slot, true)) {
          this.clearCandidateProbation(slot);
          return this.startAttempt(false, restartIntent);
        }
        return this.snapshot();
      }).catch(() => undefined);
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopRequested || generation !== this.snapshotValue.generation || restartIntent !== this.intentId) return;
      void this.queue.run(() => restartIntent === this.intentId && !this.stopRequested ? this.startAttempt(false, restartIntent) : Promise.resolve(this.snapshot())).catch(() => undefined);
    }, delay);
    this.restartTimer.unref();
  }

  private async terminateAndRelease(child: ManagedProcess): Promise<void> {
    try { child.terminate(1); } catch {}
    const exited = await child.waitForTreeExit(4_500).catch(() => false);
    child.close();
    this.clearHandles(child);
    if (!exited) throw new Error('RUNTIME_TERMINATION_TIMEOUT');
  }

  private clearHandles(expected?: ManagedProcess): void {
    if (expected && this.process !== expected) return;
    if (this.pipeTimer) clearInterval(this.pipeTimer);
    this.pipeTimer = undefined;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.process = undefined; this.nonce = undefined;
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private cancelledSnapshot(): RuntimeSnapshotV2 {
    const state = this.snapshotValue.state === 'updating' ? 'updating' : 'idle';
    this.setSnapshot({ state, pid: undefined, url: undefined, error: undefined });
    return this.snapshot();
  }

  private clearCandidateProbation(slot?: CandidateSlot): void {
    if (slot !== undefined && this.candidateSlot !== slot) return;
    this.candidateSlot = undefined;
    this.candidateGeneration = undefined;
  }

  private armStableTimer(generation: number): void {
    this.stableTimer = setTimeout(() => {
      if (generation === this.snapshotValue.generation && this.snapshotValue.state === 'ready') {
        this.crashTimes = [];
        if (this.crashWindowTimer) clearTimeout(this.crashWindowTimer);
        this.crashWindowTimer = undefined;
        if (this.candidateGeneration === generation && this.candidateSlot) {
          const slot = this.candidateSlot;
          const version = this.snapshotValue.runtimeVersion;
          void this.markRuntimeStable(slot, version)
            .then(() => this.emit('stable', this.snapshot()))
            .catch(() => undefined);
          this.clearCandidateProbation(slot);
        }
        this.setSnapshot({ restartAttempt: 0 });
      }
    }, 600_000);
    this.stableTimer.unref();
  }

  private cancelled(intent: number): boolean { return this.stopRequested || intent !== this.intentId; }

  private armCrashWindowTimer(): void {
    if (this.crashWindowTimer) clearTimeout(this.crashWindowTimer);
    this.crashWindowTimer = undefined;
    const oldest = this.crashTimes[0];
    if (oldest === undefined) return;
    this.crashWindowTimer = setTimeout(() => {
      this.crashWindowTimer = undefined;
      this.refreshCrashWindow();
    }, Math.max(1, oldest + 600_000 - Date.now()));
    this.crashWindowTimer.unref();
  }

  private refreshCrashWindow(): void {
    const current = Date.now();
    this.crashTimes = this.crashTimes.filter(time => current - time < 600_000);
    if (this.snapshotValue.restartAttempt !== this.crashTimes.length) this.setSnapshot({ restartAttempt: this.crashTimes.length });
    this.armCrashWindowTimer();
  }

  private setSnapshot(patch: RuntimeSnapshotPatch): void {
    const state = patch.state ?? this.snapshotValue.state;
    this.snapshotValue = { ...this.snapshotValue, ...patch, health: healthForState(state) };
    for (const key of ['pid', 'url', 'error'] as const) if (patch[key] === undefined && key in patch) delete this.snapshotValue[key];
    this.emit('changed', this.snapshot());
  }
}
