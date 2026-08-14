import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { DshRpcClient, DshRpcError } from './dsh-rpc-client.js';
import { RuntimeController, type RuntimePaths } from './runtime-controller.js';
import { SettingsStore, writeFileAtomic } from './settings-store.js';
import type { RuntimeSlot } from './types.js';

interface RuntimeStagingSmokeInput {
  validationRoot: string;
  slot: Exclude<RuntimeSlot, 'bundled'>;
  version: string;
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
}

type RecordValue = Record<string, unknown>;

export const RUNTIME_SMOKE_APPROVAL_REJECTED = 'RUNTIME_SMOKE_APPROVAL_REJECTED';
export const TOOL_ESCALATION = 'TOOL_ESCALATION';

/** The rc.6 approval/requested frame. Tool arguments are deliberately not part of this frame. */
interface DshRc6ApprovalRequestedPayload {
  type: 'approval/requested';
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface RuntimeSmokeApprovalDecision {
  applicable: boolean;
  outcome?: 'rejected';
  approvalId?: string;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseApprovalRequestedPayload(value: unknown): DshRc6ApprovalRequestedPayload | undefined {
  if (!isRecord(value) || value.type !== 'approval/requested'
    || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || typeof value.approvalId !== 'string' || value.approvalId.length === 0
    || typeof value.toolName !== 'string') return undefined;
  if (value.callId !== undefined && (typeof value.callId !== 'string' || value.callId.length === 0)) return undefined;
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined;
  return {
    type: 'approval/requested',
    sessionId: value.sessionId,
    approvalId: value.approvalId,
    toolName: value.toolName,
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.reason === undefined ? {} : { reason: value.reason })
  };
}

/**
 * rc.6 approval/requested has no tool arguments or path. A current-session
 * approval is therefore always rejected; malformed approval frames still fail
 * the smoke, but cannot be answered without a schema-valid approvalId.
 */
export function decideRuntimeSmokeApproval(value: unknown, sessionId: string): RuntimeSmokeApprovalDecision {
  if (!isRecord(value) || value.type !== 'approval/requested' || value.sessionId !== sessionId) {
    return { applicable: false };
  }
  const approval = parseApprovalRequestedPayload(value);
  return {
    applicable: true,
    outcome: 'rejected',
    ...(approval === undefined ? {} : { approvalId: approval.approvalId })
  };
}

export function createRuntimeSmokeApprovalRejectedError(): DshRpcError {
  return new DshRpcError(RUNTIME_SMOKE_APPROVAL_REJECTED, TOOL_ESCALATION);
}

function waitForCompletedTurn(events: RecordValue[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('RUNTIME_SMOKE_TIMEOUT'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      const completed = events.some(event => event.type === 'turn/end' && isRecord(event.data)
        && isRecord(event.data.reason) && event.data.reason.kind === 'completed');
      if (!completed) return;
      clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 25);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  });
}

function eventText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(eventText).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  return 'content' in value ? eventText(value.content) : '';
}

function assertToolRoundTrip(events: RecordValue[], nonce: string, sentinelName: string): void {
  const callIndex = events.findIndex(event => event.type === 'tool/call' && isRecord(event.data)
    && event.data.name === 'write' && typeof event.data.callId === 'string');
  const callEvent = callIndex >= 0 ? events[callIndex] : undefined;
  const callData = callEvent && isRecord(callEvent.data) ? callEvent.data : undefined;
  if (!callData || typeof callData.callId !== 'string' || typeof callData.arguments !== 'string') {
    throw new Error('RUNTIME_SMOKE_TOOL_CALL_MISSING');
  }
  let argumentsValue: unknown;
  try { argumentsValue = JSON.parse(callData.arguments); } catch { throw new Error('RUNTIME_SMOKE_TOOL_ARGUMENT_INVALID'); }
  if (!isRecord(argumentsValue) || argumentsValue.file_path !== sentinelName || argumentsValue.content !== nonce) {
    throw new Error('RUNTIME_SMOKE_TOOL_ARGUMENT_INVALID');
  }
  const resultIndex = events.findIndex((event, index) => index > callIndex && event.type === 'tool/result'
    && isRecord(event.data) && isRecord(event.data.message) && isRecord(event.data.message.source)
    && event.data.message.source.kind === 'tool' && event.data.message.source.callId === callData.callId
    && Array.isArray(event.data.message.content) && event.data.message.content.some(block => isRecord(block)
      && block.type === 'tool-result' && block.toolCallId === callData.callId && block.isError !== true));
  if (resultIndex < 0) throw new Error('RUNTIME_SMOKE_TOOL_RESULT_MISSING');
  const finalIndex = events.findIndex((event, index) => index > resultIndex && event.type === 'assistant/message'
    && isRecord(event.data) && isRecord(event.data.message) && eventText(event.data.message.content).trim() === nonce);
  if (finalIndex < 0) throw new Error('RUNTIME_SMOKE_FINAL_RESPONSE_MISSING');
  const completedAfterFinal = events.some((event, index) => index > finalIndex && event.type === 'turn/end'
    && isRecord(event.data) && isRecord(event.data.reason) && event.data.reason.kind === 'completed');
  if (!completedAfterFinal) throw new Error('RUNTIME_SMOKE_TURN_END_MISSING');
}

export async function runRuntimeStagingSmoke(input: RuntimeStagingSmokeInput): Promise<void> {
  const stateFile = path.join(input.validationRoot, 'runtime-state.json');
  const settingsFile = path.join(input.validationRoot, 'settings.json');
  const dshHome = path.join(input.validationRoot, 'dsh-home');
  const logs = path.join(input.validationRoot, 'logs');
  const workspace = path.join(input.validationRoot, 'workspace');
  const nonce = randomBytes(16).toString('hex');
  const sentinelName = `runtime-smoke-${nonce}.txt`;
  const sentinel = path.join(workspace, sentinelName);
  const apiKey = `runtime-smoke-${randomBytes(12).toString('hex')}`;
  await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(logs, { recursive: true })]);
  await writeFile(path.join(dshHome, 'settings.yaml'), 'permission:\n  defaultPreset: danger-full-access\n', { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(dshHome, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n', { encoding: 'utf8', flag: 'wx' });
  await writeFileAtomic(stateFile, `${JSON.stringify({ schemaVersion: 1, active: input.slot, previous: 'bundled', version: input.version, healthy: false })}\n`);

  const settings = new SettingsStore(settingsFile);
  await settings.load();
  await settings.setWorkspace(workspace);
  const mock = await startMockLlmServer({
    host: '127.0.0.1', port: 0, apiKey,
    sequence: ['tool_call_success', 'success'], repeatLast: false,
    successText: nonce, toolName: 'write',
    toolArguments: JSON.stringify({ file_path: sentinelName, content: nonce })
  });
  const paths: RuntimePaths = {
    appPath: input.appPath, resourcesPath: input.resourcesPath, packaged: input.packaged,
    dshHome, logs, runtimes: input.validationRoot
  };
  const runtime = new RuntimeController(settings, paths, {
    isolatedEnv: true,
    overrides: { DEEPSEEK_BASE_URL: mock.baseURL, DEEPSEEK_API_KEY: apiKey }
  });
  let mux: ReturnType<DshRpcClient['openMux']> | undefined;
  let sessionId: string | undefined;
  let failure: unknown;
  let approvalFailure: DshRpcError | undefined;
  let rejectApprovalFailure: (reason?: unknown) => void = () => undefined;
  const approvalFailureSignal = new Promise<never>((_, reject) => { rejectApprovalFailure = reject; });
  void approvalFailureSignal.catch(() => undefined);
  const approvalResponses: Promise<void>[] = [];
  const failOnApproval = () => {
    if (approvalFailure !== undefined) return;
    approvalFailure = createRuntimeSmokeApprovalRejectedError();
    rejectApprovalFailure(approvalFailure);
  };
  try {
    const snapshot = await runtime.start();
    if (snapshot.state !== 'ready' || !snapshot.url || snapshot.slot !== input.slot || snapshot.runtimeVersion !== input.version) {
      throw new Error('RUNTIME_SMOKE_NOT_READY');
    }
    const client = new DshRpcClient(snapshot.url);
    await client.call('host.describe', {}, 10_000);
    await client.call('agentPreset.list', {}, 10_000);
    const events: RecordValue[] = [];
    const timeout = AbortSignal.timeout(90_000);
    mux = client.openMux(envelope => {
      const payload = envelope.payload;
      const approval = decideRuntimeSmokeApproval(payload, sessionId ?? '');
      if (approval.applicable) {
        failOnApproval();
        if (approval.approvalId !== undefined && sessionId !== undefined) {
          approvalResponses.push(client.respond(envelope.rpcId, {
            sessionId,
            approvalId: approval.approvalId,
            outcome: 'rejected'
          }, timeout).then(() => undefined).catch(() => undefined));
        }
      }
      if (payload.type === 'session/event' && payload.sessionId === sessionId && isRecord(payload.event)) events.push(payload.event);
    }, timeout);
    await mux.opened;
    const created = await client.call<{ sessionId: string }>('session.create', { cwd: workspace }, 15_000, timeout);
    sessionId = created.sessionId;
    const models = await client.call<{ routable: boolean }>('session.models', { sessionId }, 15_000, timeout);
    if (!models.routable) throw new Error('RUNTIME_SMOKE_MODEL_NOT_ROUTABLE');
    await client.call('session.prompt', {
      sessionId,
      content: [{ type: 'text', text: `Create ${sentinelName} with the write tool using only file_path and content, write exactly ${nonce}, then reply with exactly ${nonce}. Do not request approval or escalate permissions.` }],
      mode: 'queue'
    }, 15_000, timeout);
    await Promise.race([waitForCompletedTurn(events, timeout), approvalFailureSignal]);
    if (approvalFailure !== undefined) throw approvalFailure;
    await Promise.all(approvalResponses);
    if (approvalFailure !== undefined) throw approvalFailure;
    assertToolRoundTrip(events, nonce, sentinelName);
    if ((await readFile(sentinel, 'utf8')).trim() !== nonce) throw new Error('RUNTIME_SMOKE_SENTINEL_MISMATCH');
    if (mock.requests.length !== 2 || mock.requests[0]?.behavior !== 'tool_call_success' || mock.requests[1]?.behavior !== 'success') {
      throw new Error('RUNTIME_SMOKE_PROVIDER_SEQUENCE_MISMATCH');
    }
    await client.call('workspace.archiveSession', { sessionId }, 5_000, timeout);
  } catch (error) {
    failure = error;
  } finally {
    await Promise.allSettled(approvalResponses);
    mux?.close();
    try { await runtime.stop(); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'RUNTIME_SMOKE_STOP_FAILED'); }
    try { await mock.close(); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'RUNTIME_SMOKE_MOCK_STOP_FAILED'); }
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
  if (approvalFailure !== undefined) failure = approvalFailure;
  if (failure !== undefined) throw failure;
}
