import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { SettingsStore } from './settings-store.js';
import { createManagedProcess, type ManagedProcess } from './windows-platform.js';
import { parseLoopbackRuntimeUrl, redactText } from './security.js';
import { DSH_VERSION, type RuntimeSnapshot, type RuntimeSlot } from './types.js';

interface RuntimePaths {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  dshHome: string;
  logs: string;
}

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

export class RuntimeController extends EventEmitter {
  private snapshotValue: RuntimeSnapshot = { state: 'idle', generation: 0, runtimeVersion: DSH_VERSION, runtimeSlot: 'bundled' };
  private readonly queue = new SerialQueue();
  private process: ManagedProcess | undefined;
  private socket: Socket | undefined;
  private server: net.Server | undefined;
  private nonce: string | undefined;
  private stopping = false;
  private crashTimes: number[] = [];

  constructor(private readonly settings: SettingsStore, private readonly paths: RuntimePaths) { super(); }

  snapshot(): RuntimeSnapshot { return structuredClone(this.snapshotValue); }

  start(): Promise<RuntimeSnapshot> {
    return this.queue.run(async () => {
      if (this.snapshotValue.state === 'ready') return this.snapshot();
      if (['preparing', 'starting', 'stopping', 'updating'].includes(this.snapshotValue.state)) {
        throw new Error(`RUNTIME_BUSY:${this.snapshotValue.state}`);
      }
      return this.startAttempt(false);
    });
  }

  restart(): Promise<RuntimeSnapshot> {
    return this.queue.run(async () => { await this.stopInternal(); return this.startAttempt(false); });
  }

  stop(): Promise<RuntimeSnapshot> { return this.queue.run(() => this.stopInternal()); }

  setUpdating(updating: boolean): void {
    this.setSnapshot({ state: updating ? 'updating' : 'idle' });
  }

  private async startAttempt(portFallback: boolean): Promise<RuntimeSnapshot> {
    const settings = this.settings.get();
    if (!settings.workspace) {
      this.setSnapshot({ state: 'failed', error: { code: 'WORKSPACE_REQUIRED', message: 'Choose a workspace before starting Harness.' } });
      return this.snapshot();
    }
    const generation = this.snapshotValue.generation + 1;
    this.stopping = false;
    this.setSnapshot({ state: 'preparing', generation, error: undefined, pid: undefined, url: undefined });
    await Promise.all([mkdir(this.paths.dshHome, { recursive: true }), mkdir(this.paths.logs, { recursive: true })]);

    const runtimeRoot = this.paths.packaged ? path.join(this.paths.resourcesPath, 'dsh-runtime') : path.join(this.paths.appPath, 'runtime');
    const node = this.paths.packaged ? path.join(this.paths.resourcesPath, 'node-runtime', 'node.exe') : path.join(this.paths.appPath, 'vendor', 'node', 'node.exe');
    const supervisor = this.paths.packaged ? path.join(this.paths.resourcesPath, 'supervisor', 'supervisor.mjs') : path.join(this.paths.appPath, 'src', 'supervisor.mjs');
    const dshEntry = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const binPath = path.join(runtimeRoot, 'bin');
    const logPath = path.join(this.paths.logs, `runtime-${new Date().toISOString().replaceAll(':', '-')}.log`);
    const nonce = randomBytes(32).toString('hex');
    const pipeName = `\\\\.\\pipe\\adhd-one-${randomBytes(32).toString('hex')}`;
    this.nonce = nonce;
    const server = net.createServer();
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipeName, resolve); });

    const port = portFallback ? 0 : settings.preferredPort;
    const environment = this.runtimeEnvironment({ runtimeRoot, binPath, pipeName, nonce, generation, dshEntry, logPath, port, node });
    this.setSnapshot({ state: 'starting' });
    const child = createManagedProcess({ executable: node, args: [supervisor], cwd: settings.workspace, env: environment });
    this.process = child;
    this.setSnapshot({ pid: child.pid });

    const ready = this.waitForReady(server, generation, nonce, child.pid);
    const exited = child.wait().then(code => ({ kind: 'exit' as const, code }));
    const timeout = new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 45_000));
    const outcome = await Promise.race([ready, exited, timeout]);
    if (outcome.kind !== 'ready') {
      child.terminate(1); child.close(); this.clearHandles();
      const log = await readFile(logPath, 'utf8').catch(() => '');
      if (!portFallback && /EADDRINUSE|address already in use/iu.test(log)) return this.startAttempt(true);
      const message = outcome.kind === 'exit' ? `Harness exited with code ${outcome.code}.` : 'Harness startup timed out.';
      this.setSnapshot({ state: 'failed', error: { code: outcome.kind === 'exit' ? 'RUNTIME_EXITED' : 'RUNTIME_TIMEOUT', message }, pid: undefined });
      return this.snapshot();
    }

    const url = parseLoopbackRuntimeUrl(outcome.url);
    if (!url) throw new Error('INVALID_READY_URL');
    await this.verifyHost(url.origin);
    if (portFallback) await this.settings.update({ preferredPort: Number(url.port) });
    this.setSnapshot({ state: 'ready', url: url.origin });
    this.emit('ready', this.snapshot());
    void exited.then(({ code }) => this.handleUnexpectedExit(generation, code));
    return this.snapshot();
  }

  private runtimeEnvironment(input: {
    runtimeRoot: string; binPath: string; pipeName: string; nonce: string; generation: number;
    dshEntry: string; logPath: string; port: number; node: string;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR']) delete env[key];
    return {
      ...env,
      PATH: `${input.binPath};${path.dirname(process.execPath)};${env.PATH ?? ''}`,
      ADHD_NODE_EXE: input.node,
      DSH_HOME: this.paths.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP: '1',
      NO_COLOR: '1',
      ADHD_PIPE: input.pipeName,
      ADHD_NONCE: input.nonce,
      ADHD_GENERATION: String(input.generation),
      ADHD_DSH_ENTRY: input.dshEntry,
      ADHD_LOG: input.logPath,
      ADHD_PORT: String(input.port),
      ADHD_RUNTIME_ROOT: input.runtimeRoot
    };
  }

  private waitForReady(server: net.Server, generation: number, nonce: string, pid: number): Promise<{ kind: 'ready'; url: string }> {
    return new Promise((resolve, reject) => {
      server.once('connection', socket => {
        this.socket = socket;
        socket.setEncoding('utf8');
        let buffer = '';
        let hello = false;
        socket.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 65_536) { socket.destroy(); reject(new Error('SUPERVISOR_FRAME_TOO_LARGE')); return; }
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              const message = JSON.parse(raw) as SupervisorMessage;
              if (message.v !== 1 || message.generation !== generation) continue;
              if (message.type === 'hello') {
                if (message.nonce !== nonce || message.pid !== pid) throw new Error('SUPERVISOR_HANDSHAKE_REJECTED');
                hello = true;
              } else if (message.type === 'ready' && hello && message.url) resolve({ kind: 'ready', url: message.url });
              else if (message.type === 'fatal' && hello) reject(new Error(`${message.code ?? 'SUPERVISOR_FATAL'}:${redactText(message.message ?? '')}`));
            } catch (error) { reject(error); }
          }
        });
      });
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

  private async stopInternal(): Promise<RuntimeSnapshot> {
    const child = this.process;
    if (!child) { this.setSnapshot({ state: 'idle', pid: undefined, url: undefined }); return this.snapshot(); }
    this.stopping = true;
    this.setSnapshot({ state: 'stopping' });
    this.socket?.write(`${JSON.stringify({ v: 1, type: 'stop', nonce: this.nonce, generation: this.snapshotValue.generation })}\n`);
    const graceful = child.wait().then(() => true).catch(() => false);
    const completed = await Promise.race([graceful, new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))]);
    if (!completed) child.terminate(1);
    child.close();
    this.clearHandles();
    this.setSnapshot({ state: 'idle', pid: undefined, url: undefined, error: undefined });
    return this.snapshot();
  }

  private handleUnexpectedExit(generation: number, code: number): void {
    if (this.stopping || generation !== this.snapshotValue.generation || this.snapshotValue.state !== 'ready') return;
    this.clearHandles();
    this.setSnapshot({ state: 'failed', pid: undefined, url: undefined, error: { code: 'RUNTIME_CRASHED', message: `Harness exited with code ${code}.` } });
    this.emit('crashed', this.snapshot());
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter(time => now - time < 600_000);
    if (this.crashTimes.length >= 3) return;
    const delays = [500, 1_500, 4_500];
    const delay = delays[this.crashTimes.length] ?? 4_500;
    this.crashTimes.push(now);
    setTimeout(() => void this.start().catch(() => undefined), delay);
  }

  private clearHandles(): void {
    this.socket?.destroy(); this.socket = undefined;
    this.server?.close(); this.server = undefined;
    this.process = undefined; this.nonce = undefined;
  }

  private setSnapshot(patch: Partial<RuntimeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch } as RuntimeSnapshot;
    for (const key of ['pid', 'url', 'error'] as const) if (patch[key] === undefined && key in patch) delete this.snapshotValue[key];
    this.emit('changed', this.snapshot());
  }
}
