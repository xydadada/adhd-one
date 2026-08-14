import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeController } from './runtime-controller.js';
import { DshRpcClient, DshRpcError } from './dsh-rpc-client.js';
import { redactText } from './security.js';
import type { DoctorCheck, DoctorProgress, DoctorReport } from './types.js';

const ERROR_CODES = new Set([
  'MISSING_CREDENTIAL', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'TRANSPORT', 'TIMEOUT',
  'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'TOOL_ARGUMENT_INVALID', 'TOOL_ESCALATION_REQUIRED',
  'REASONING_UNSUPPORTED', 'DSH_PROTOCOL_INCOMPATIBLE'
]);

function classify(error: unknown): string {
  const raw = error instanceof DshRpcError ? error.code : error instanceof Error ? error.message : String(error);
  const upper = raw.toUpperCase();
  for (const code of ERROR_CODES) if (upper.includes(code)) return code;
  if (/401|403|AUTH/iu.test(upper)) return 'AUTH';
  if (/429|RATE/iu.test(upper)) return 'RATE_LIMIT';
  if (/TIMEOUT|ABORT/iu.test(upper)) return 'TIMEOUT';
  if (/MODEL/iu.test(upper)) return 'MODEL_UNAVAILABLE';
  return 'TRANSPORT';
}

async function check(id: string, summary: string, operation: () => Promise<unknown>): Promise<DoctorCheck> {
  const started = Date.now();
  try {
    const value = await operation();
    const details = summarize(value);
    return { id, status: 'pass', summary, durationMs: Date.now() - started, ...(details ? { details } : {}) };
  } catch (error) {
    return { id, status: 'fail', code: classify(error), summary: redactText(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started };
  }
}

function summarize(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return { count: value.length };
  const record = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ['provider', 'model', 'routable', 'configured', 'source', 'authorable', 'hasDocument']) {
    if (typeof record[key] === 'string' || typeof record[key] === 'boolean' || typeof record[key] === 'number') safe[key] = record[key];
  }
  for (const key of ['items', 'providers', 'models', 'presets', 'groups', 'failures']) if (Array.isArray(record[key])) safe[`${key}Count`] = record[key].length;
  return Object.keys(safe).length ? safe : undefined;
}

export class ProviderDoctor {
  private controller?: AbortController;
  private lastReport?: DoctorReport;
  constructor(
    private readonly runtime: RuntimeController,
    private readonly cacheRoot: string,
    private readonly appVersion: string,
    private readonly progress: (progress: DoctorProgress) => void
  ) {}

  cancel(): void { this.controller?.abort(); }
  report(): DoctorReport | undefined { return this.lastReport ? structuredClone(this.lastReport) : undefined; }

  async run(mode: 'quick' | 'deep'): Promise<DoctorReport> {
    this.controller?.abort();
    this.controller = new AbortController();
    const snapshot = this.runtime.snapshot();
    if (snapshot.state !== 'ready' || !snapshot.url) throw new Error('RUNTIME_NOT_READY');
    const client = new DshRpcClient(snapshot.url);
    const checks: DoctorCheck[] = [];
    const tasks: Array<[string, string, () => Promise<unknown>]> = [
      ['host', 'Harness host RPC is ready.', () => client.call('host.describe', {})],
      ['presets', 'Agent preset catalog is readable.', () => client.call('agentPreset.list', {})],
      ['providers', 'Provider catalog is readable.', () => client.call('llm.providers', {})],
      ['models', 'Model catalog is readable.', () => client.call('llm.models', {})],
      ['settings', 'Provider settings are readable and redacted.', () => client.call('settings.describe', {})]
    ];
    this.progress({ phase: 'quick', message: '正在并行检查 Harness、Provider 和模型…', percent: 10 });
    checks.push(...await Promise.all(tasks.map(([id, summary, operation]) => check(id, summary, operation))));
    if (mode === 'deep') checks.push(await this.deepCheck(client));
    const report: DoctorReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      appVersion: this.appVersion,
      runtimeVersion: snapshot.runtimeVersion,
      platform: `${process.platform}-${process.arch} ${os.release()}`,
      mode,
      checks
    };
    this.lastReport = report;
    this.progress({ phase: 'complete', message: '诊断完成。', percent: 100 });
    return structuredClone(report);
  }

  private async deepCheck(client: DshRpcClient): Promise<DoctorCheck> {
    const started = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const workspace = path.join(this.cacheRoot, `doctor-${nonce}`);
    const sentinel = path.join(workspace, `adhd-one-doctor-${nonce}.txt`);
    await mkdir(workspace, { recursive: true });
    let sessionId: string | undefined;
    const mux = client.openMux(envelope => {
      const payload = envelope.payload;
      if (payload.type === 'approval/requested' && payload.sessionId === sessionId && typeof payload.approvalId === 'string') {
        void client.respond(envelope.rpcId, { sessionId, approvalId: payload.approvalId, outcome: 'rejected' });
      }
    });
    try {
      await mux.opened;
      this.progress({ phase: 'deep', message: '正在创建隔离诊断会话…', percent: 55 });
      const created = await client.call<{ sessionId: string }>('session.create', { cwd: workspace }, 15_000);
      sessionId = created.sessionId;
      const models = await client.call<{ current: { provider: string; model: string; reasoningEffort?: string }; routable: boolean }>('session.models', { sessionId });
      if (!models.routable) throw new DshRpcError('MODEL_UNAVAILABLE', 'The current model route is not available.');
      const prompt = `Provider Doctor check. In the current workspace, create ${path.basename(sentinel)}, write exactly ${nonce}, read it back, and reply with exactly ${nonce}. Do not access any path outside the current workspace.`;
      await client.call('session.prompt', { sessionId, content: [{ type: 'text', text: prompt }], mode: 'queue' }, 15_000);
      const deadline = Date.now() + 150_000;
      let finished = false;
      while (Date.now() < deadline) {
        if (this.controller?.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const history = await client.call<{ events: Array<{ event?: { type?: string; data?: unknown } }> }>('session.history', { sessionId, maxMessages: 200 }, 10_000);
        finished = history.events.some(item => item.event?.type === 'turn/end');
        if (finished) break;
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!finished) throw new DshRpcError('TIMEOUT', 'Deep tool-call check timed out.');
      const contents = await readFile(sentinel, 'utf8');
      if (contents.trim() !== nonce) throw new DshRpcError('TOOL_ARGUMENT_INVALID', 'The tool call did not produce the expected sentinel file.');
      await client.call('workspace.archiveSession', { sessionId }).catch(() => undefined);
      return {
        id: 'deep-tool-round-trip', status: 'pass', summary: '真实模型、工具调用、参数解析和文件往返均成功。',
        durationMs: Date.now() - started,
        details: { provider: models.current.provider, model: models.current.model, reasoningEffort: models.current.reasoningEffort ?? 'provider-default' }
      };
    } catch (error) {
      if (sessionId) await client.call('workspace.archiveSession', { sessionId }).catch(() => undefined);
      return { id: 'deep-tool-round-trip', status: 'fail', code: classify(error), summary: redactText(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started };
    } finally {
      mux.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
