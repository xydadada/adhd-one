import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { connect as connectTcp, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { connect as connectTls } from 'node:tls';
import type { RuntimeController } from './runtime-controller.js';
import { DshRpcClient, DshRpcError } from './dsh-rpc-client.js';
import { redactText } from './security.js';
import type { DoctorCheckV2, DoctorEvidenceV2, DoctorProgress, DoctorReportV2 } from './types.js';

const ERROR_CODES = new Set([
  'MISSING_CREDENTIAL', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'TRANSPORT', 'TIMEOUT',
  'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'TOOL_ARGUMENT_INVALID', 'TOOL_ESCALATION_REQUIRED',
  'REASONING_UNSUPPORTED', 'DSH_PROTOCOL_INCOMPATIBLE'
]);

interface RecordValue { [key: string]: unknown }

interface SessionEventValue extends RecordValue {
  type?: unknown;
  seq?: unknown;
  data?: unknown;
}

interface HistoryEntryValue { event?: unknown }

interface DeepEvidence {
  toolCalls: number;
  toolResults: number;
  assistantMessagesWithNonce: number;
  turnEnds: number;
  callIds: string[];
  flags: DoctorEvidenceV2;
}

interface DefaultRoute {
  provider?: string;
  model?: string;
  endpoint?: string;
}

interface DeepCheckOutcome {
  check: DoctorCheckV2;
  route?: DefaultRoute;
  evidence: DoctorEvidenceV2;
}

class DeepEvidenceError extends DshRpcError {
  constructor(code: string, message: string, readonly evidence: DoctorEvidenceV2) {
    super(code, message);
  }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyEvidence(): DoctorEvidenceV2 {
  return {
    toolCall: false,
    toolResult: false,
    argumentsParsed: false,
    fileVerified: false,
    secondTurnConsumed: false,
    finalNonce: false
  };
}

function intersectEvidence(left: DoctorEvidenceV2, right: DoctorEvidenceV2): DoctorEvidenceV2 {
  return {
    toolCall: left.toolCall && right.toolCall,
    toolResult: left.toolResult && right.toolResult,
    argumentsParsed: left.argumentsParsed && right.argumentsParsed,
    fileVerified: left.fileVerified && right.fileVerified,
    secondTurnConsumed: left.secondTurnConsumed && right.secondTurnConsumed,
    finalNonce: left.finalNonce && right.finalNonce
  };
}

function hasEvidence(value: DoctorEvidenceV2): boolean {
  return Object.values(value).some(Boolean);
}

function providerLabel(value: string): string {
  return redactText(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

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

function safeFailureSummary(code: string): string {
  // Do not echo provider/server text: it can contain paths, headers or credentials.
  return `Provider Doctor check failed (${code}).`;
}

function summarize(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return { count: value.length };
    return undefined;
  }
  const safe: Record<string, unknown> = {};
  for (const key of ['provider', 'model', 'routable', 'configured', 'source', 'authorable', 'hasDocument']) {
    if (typeof value[key] === 'string') safe[key] = redactText(value[key]);
    else if (typeof value[key] === 'boolean' || typeof value[key] === 'number') safe[key] = value[key];
  }
  for (const key of ['items', 'providers', 'models', 'presets', 'groups', 'failures', 'namespaces']) {
    if (Array.isArray(value[key])) safe[`${key}Count`] = value[key].length;
  }
  const credentials = value.credentials;
  if (isRecord(credentials)) {
    const entries = Object.values(credentials).filter(isRecord);
    safe.credentialsCount = entries.length;
    safe.configuredCredentialCount = entries.filter(entry => entry.configured === true).length;
  }
  return Object.keys(safe).length ? safe : undefined;
}

interface CheckOutcome<T> { check: DoctorCheckV2; value?: T }

interface ProviderProbe {
  provider: string;
  settingsNs: string;
  baseURL: string;
  api?: string;
}

function providerProbes(settingsValue: unknown): ProviderProbe[] {
  if (!isRecord(settingsValue) || !Array.isArray(settingsValue.namespaces)) return [];
  const probes: ProviderProbe[] = [];
  for (const namespace of settingsValue.namespaces) {
    if (!isRecord(namespace) || namespace.ns !== 'llm-pi-ai' || !isRecord(namespace.value)) continue;
    const providers = isRecord(namespace.value.providers) ? namespace.value.providers : undefined;
    if (!providers) continue;
    for (const [provider, raw] of Object.entries(providers)) {
      if (!isRecord(raw) || typeof raw.baseURL !== 'string') continue;
      probes.push({ provider, settingsNs: namespace.ns, baseURL: raw.baseURL, ...(typeof raw.api === 'string' ? { api: raw.api } : {}) });
    }
  }
  return probes;
}

function validateProviderEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DshRpcError('TRANSPORT', 'Provider endpoint is not a valid URL'); }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new DshRpcError('TRANSPORT', 'Provider endpoint is not allowed');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !loopback) throw new DshRpcError('TRANSPORT', 'Provider endpoint must use HTTPS');
  return url;
}

function endpointView(url: URL): string {
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname === '/' ? '/' : '/…'}`;
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return endpointView(new URL(value)); }
  catch { return undefined; }
}

function routeFromValue(value: unknown): DefaultRoute {
  const route: DefaultRoute = {};
  const candidates: RecordValue[] = [];
  if (isRecord(value)) {
    candidates.push(value);
    for (const key of ['current', 'route', 'selection', 'default'] as const) {
      if (isRecord(value[key])) candidates.push(value[key]);
    }
  }
  for (const candidate of candidates) {
    if (!route.provider) {
      const provider = candidate.provider ?? candidate.defaultProvider;
      if (typeof provider === 'string' && provider.length > 0) route.provider = providerLabel(provider);
    }
    if (!route.model) {
      const model = candidate.model ?? candidate.defaultModel;
      if (typeof model === 'string' && model.length > 0) route.model = redactText(model);
    }
    if (!route.endpoint) {
      const endpoint = safeEndpoint(candidate.endpoint ?? candidate.baseURL);
      if (endpoint) route.endpoint = endpoint;
    }
  }
  return route;
}

function endpointForProvider(settingsValue: unknown, provider?: string): string | undefined {
  const probes = providerProbes(settingsValue);
  const probe = provider
    ? probes.find(item => providerLabel(item.provider) === provider || item.provider === provider)
    : probes.length === 1 ? probes[0] : undefined;
  return safeEndpoint(probe?.baseURL);
}

function catalogRoute(providerValue: unknown, modelsValue: unknown, settingsValue: unknown): DefaultRoute {
  let route = routeFromValue(providerValue);
  route = { ...route, ...routeFromValue(modelsValue) };
  const providerRecord = isRecord(providerValue) ? providerValue : undefined;
  const providerRows = providerRecord && Array.isArray(providerRecord.providers)
    ? providerRecord.providers.filter(isRecord)
    : [];
  const activeProviders = providerRows.filter(row => row.active === true && typeof row.provider === 'string');
  const activeProvider = activeProviders[0];
  if (!route.provider && activeProviders.length === 1 && activeProvider && typeof activeProvider.provider === 'string') {
    route.provider = providerLabel(activeProvider.provider);
  }

  const modelRecord = isRecord(modelsValue) ? modelsValue : undefined;
  const groups = modelRecord && Array.isArray(modelRecord.groups) ? modelRecord.groups.filter(isRecord) : [];
  const group = route.provider
    ? groups.find(item => typeof item.id === 'string' && (item.id === route.provider || providerLabel(item.id) === route.provider))
    : groups.length === 1 ? groups[0] : undefined;
  if (!route.provider && group && typeof group.id === 'string') route.provider = providerLabel(group.id);
  if (!route.model && group && Array.isArray(group.models) && group.models.length === 1) {
    const model = group.models[0];
    if (isRecord(model) && typeof model.id === 'string') route.model = redactText(model.id);
  }

  const settingsRoute = routeFromValue(settingsValue);
  route = { ...settingsRoute, ...route };
  if (!route.provider) {
    const probes = providerProbes(settingsValue);
    const probe = probes[0];
    if (probes.length === 1 && probe) route.provider = providerLabel(probe.provider);
  }
  if (!route.endpoint) {
    const endpoint = endpointForProvider(settingsValue, route.provider);
    if (endpoint) route.endpoint = endpoint;
  }
  return route;
}

function mergeRoute(primary: DefaultRoute, fallback: DefaultRoute): DefaultRoute {
  return {
    ...(primary.provider ?? fallback.provider ? { provider: primary.provider ?? fallback.provider } : {}),
    ...(primary.model ?? fallback.model ? { model: primary.model ?? fallback.model } : {}),
    ...(primary.endpoint ?? fallback.endpoint ? { endpoint: primary.endpoint ?? fallback.endpoint } : {})
  };
}

async function probeConnection(url: URL, signal: AbortSignal): Promise<{ transport: string }> {
  throwIfAborted(signal);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  await new Promise<void>((resolve, reject) => {
    const socket = url.protocol === 'https:'
      ? connectTls({ host: url.hostname, port, servername: isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true })
      : connectTcp({ host: url.hostname, port });
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => finish());
    socket.once('error', error => finish(error));
  });
  return { transport: url.protocol === 'https:' ? 'tls' : 'tcp' };
}

async function runCheck<T>(
  id: string,
  summary: string,
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<CheckOutcome<T>> {
  const started = Date.now();
  try {
    throwIfAborted(signal);
    const value = await operation();
    throwIfAborted(signal);
    const details = summarize(value);
    return { value, check: { id, status: 'pass', summary, durationMs: Date.now() - started, ...(details ? { details } : {}) } };
  } catch (error) {
    if (signal.aborted) throw error;
    const code = classify(error);
    return { check: { id, status: 'fail', code, summary: safeFailureSummary(code), durationMs: Date.now() - started } };
  }
}

function collectCredentialRefs(value: unknown): string[] {
  const refs = new Set(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']);
  const visit = (current: unknown, key?: string): void => {
    if (typeof current === 'string' && key && /(?:apiKeyEnv|credentialRef)$/iu.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(current)) {
      refs.add(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (isRecord(current)) {
      for (const [childKey, childValue] of Object.entries(current)) visit(childValue, childKey);
    }
  };
  visit(value);
  return [...refs].sort();
}

function withDeadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(abortReason(parent));
  if (parent.aborted) onAbort(); else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  };
}

function sessionEvent(value: unknown): SessionEventValue | undefined {
  return isRecord(value) && typeof value.type === 'string'
    && typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq >= 0
    && typeof value.time === 'number' && Number.isFinite(value.time)
    && isRecord(value.data) ? value as SessionEventValue : undefined;
}

function historyEvents(value: unknown): SessionEventValue[] {
  if (!isRecord(value) || !Array.isArray(value.events) || value.hasMore !== false) throw new DshRpcError('MALFORMED_RESPONSE', 'session.history returned an incomplete event list');
  const events: SessionEventValue[] = [];
  for (const entry of value.events) {
    const event = sessionEvent(isRecord(entry) ? entry.event : undefined);
    if (!event) throw new DshRpcError('MALFORMED_RESPONSE', 'session.history returned an invalid event entry');
    events.push(event);
  }
  return events;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if ('content' in value) return textContent(value.content);
  if ('message' in value) return textContent(value.message);
  return '';
}

function toolResultIdentity(message: RecordValue): { callId?: string; failed: boolean } {
  const source = isRecord(message.source) ? message.source : undefined;
  const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const callId = source?.kind === 'tool' && typeof source.callId === 'string' ? source.callId : undefined;
  return {
    ...(callId ? { callId } : {}),
    failed: blocks.some(block => block.type === 'tool-result' && block.isError === true)
  };
}

function inspectEventSequence(events: SessionEventValue[], nonce: string, sentinelName: string): DeepEvidence {
  const flags = emptyEvidence();
  const toolCalls = events.filter(event => event.type === 'tool/call');
  flags.toolCall = toolCalls.length > 0;
  if (toolCalls.length === 0) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed no tool/call event', flags);

  const callIds: string[] = [];
  const callPositions = new Map<string, { index: number; turn: number; step: number; seq: number }>();
  let writeCallId: string | undefined;
  let readCallId: string | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool/call') continue;
    const data = event.data;
    if (!isRecord(data) || typeof data.callId !== 'string' || typeof data.arguments !== 'string' || typeof data.name !== 'string'
      || typeof data.turn !== 'number' || !Number.isInteger(data.turn) || typeof data.step !== 'number' || !Number.isInteger(data.step)
      || typeof event.seq !== 'number') {
      throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'Deep check observed an invalid tool/call payload', flags);
    }
    if (callPositions.has(data.callId)) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed duplicate tool call ids', flags);
    try {
      const parsed = JSON.parse(data.arguments) as unknown;
      if (!isRecord(parsed)) throw new Error('tool arguments must be an object');
      if (data.name === 'write' || data.name === 'read') {
        if (typeof parsed.file_path !== 'string' || path.isAbsolute(parsed.file_path) || path.normalize(parsed.file_path) !== sentinelName) {
          throw new Error('tool path does not match the sentinel');
        }
        if (data.name === 'write') {
          if (parsed.content !== nonce || writeCallId) throw new Error('write arguments do not match the sentinel');
          writeCallId = data.callId;
        } else {
          if (readCallId) throw new Error('duplicate sentinel read');
          readCallId = data.callId;
        }
      }
    } catch {
      throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'Deep check observed unparseable tool arguments', flags);
    }
    callIds.push(data.callId);
    callPositions.set(data.callId, { index, turn: data.turn, step: data.step, seq: event.seq });
  }
  if (!writeCallId || !readCallId || (callPositions.get(writeCallId)?.index ?? Number.MAX_SAFE_INTEGER) >= (callPositions.get(readCallId)?.index ?? -1)) {
    throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'Deep check did not observe the required write then read tool sequence', flags);
  }
  flags.argumentsParsed = true;

  const toolResults = events.filter(event => event.type === 'tool/result');
  flags.toolResult = toolResults.length > 0;
  const resultPositions = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool/result') continue;
    const data = event.data;
    if (!isRecord(data)) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed an invalid tool/result payload', flags);
    const message = isRecord(data.message) ? data.message : undefined;
    if (!message) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed an invalid tool/result payload', flags);
    const identity = toolResultIdentity(message);
    if (!identity.callId) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed an invalid tool/result identity', flags);
    const call = callPositions.get(identity.callId);
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const matchingBlocks = blocks.filter(block => block.type === 'tool-result' && block.toolCallId === identity.callId);
    if (!call || call.index >= index) {
      throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed an unpaired tool/result event', flags);
    }
    if (data.turn !== call.turn || data.step !== call.step || message.role !== 'user' || typeof message.id !== 'string'
      || matchingBlocks.length !== 1 || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1
      || event.sourceEventSeqs[0] !== call.seq || event.surfaceOp !== 'append') {
      throw new DeepEvidenceError('DSH_PROTOCOL_INCOMPATIBLE', 'Deep check observed mismatched tool result metadata', flags);
    }
    if (identity.failed) throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'Deep check observed a failed tool result', flags);
    if (resultPositions.has(identity.callId)) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed duplicate tool results', flags);
    resultPositions.set(identity.callId, index);
  }
  for (const callId of callIds) {
    if (!resultPositions.has(callId)) throw new DeepEvidenceError('STREAM_CLOSED', 'Deep check observed a tool call without a result', flags);
  }
  if ((resultPositions.get(writeCallId) ?? Number.MAX_SAFE_INTEGER) >= (callPositions.get(readCallId)?.index ?? -1)) {
    throw new DeepEvidenceError('DSH_PROTOCOL_INCOMPATIBLE', 'Deep check observed read before the write result', flags);
  }

  const lastResult = Math.max(...resultPositions.values());
  const finalAssistantMessages = events.filter((event, index) => {
    if (event.type !== 'assistant/message' || index <= lastResult) return false;
    const data = event.data;
    return isRecord(data) && isRecord(data.message) && textContent(data.message.content).trim() === nonce;
  });
  if (finalAssistantMessages.length !== 1) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'Deep check observed no unique exact final assistant nonce', flags);
  flags.finalNonce = true;
  flags.secondTurnConsumed = true;

  const assistantIndex = events.findLastIndex((event, index) => {
    if (event.type !== 'assistant/message' || index <= lastResult) return false;
    const data = event.data;
    return isRecord(data) && isRecord(data.message) && textContent(data.message.content).trim() === nonce;
  });
  const turnEnds = events.filter((event, index) => {
    if (event.type !== 'turn/end' || index <= assistantIndex || !isRecord(event.data)) return false;
    return isRecord(event.data.reason) && event.data.reason.kind === 'completed';
  });
  if (turnEnds.length === 0) throw new DeepEvidenceError('STREAM_CLOSED', 'Deep check observed no turn/end after the final assistant message', flags);
  return { toolCalls: toolCalls.length, toolResults: toolResults.length, assistantMessagesWithNonce: finalAssistantMessages.length, turnEnds: turnEnds.length, callIds, flags };
}

function assertMatchingEvidence(history: DeepEvidence, mux: DeepEvidence): void {
  if (
    history.toolCalls !== mux.toolCalls ||
    history.toolResults !== mux.toolResults ||
    history.assistantMessagesWithNonce !== mux.assistantMessagesWithNonce ||
    history.turnEnds !== mux.turnEnds ||
    history.callIds.join('\u0000') !== mux.callIds.join('\u0000')
  ) {
    throw new DeepEvidenceError('DSH_PROTOCOL_INCOMPATIBLE', 'History and mux event evidence did not match', intersectEvidence(history.flags, mux.flags));
  }
}

export class ProviderDoctor {
  private controller: AbortController | undefined;
  private lastReport?: DoctorReportV2;
  constructor(
    private readonly runtime: RuntimeController,
    private readonly cacheRoot: string,
    private readonly appVersion: string,
    private readonly progress: (progress: DoctorProgress) => void
  ) {}

  cancel(): void { this.controller?.abort(new DOMException('The operation was cancelled.', 'AbortError')); }
  report(): DoctorReportV2 | undefined { return this.lastReport ? structuredClone(this.lastReport) : undefined; }

  async run(mode: 'quick' | 'deep'): Promise<DoctorReportV2> {
    const started = Date.now();
    const requestId = randomBytes(16).toString('hex');
    this.controller?.abort(new DOMException('A newer diagnostic run started.', 'AbortError'));
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      throwIfAborted(signal);
      const snapshot = this.runtime.snapshot();
      if (snapshot.state !== 'ready' || !snapshot.url) throw new Error('RUNTIME_NOT_READY');
      const client = new DshRpcClient(snapshot.url);
      const checks: DoctorCheckV2[] = [];
      const tasks: Array<[string, string, () => Promise<unknown>]> = [
        ['host', 'Harness host RPC is ready.', () => client.call('host.describe', {}, 10_000, signal)],
        ['presets', 'Agent preset catalog is readable.', () => client.call('agentPreset.list', {}, 10_000, signal)],
        ['providers', 'Provider catalog is readable.', () => client.call('llm.providers', {}, 10_000, signal)],
        ['models', 'Model catalog is readable.', () => client.call('llm.models', {}, 10_000, signal)]
      ];
      this.progress({ phase: 'quick', message: '正在并行检查 Harness、Provider 和模型…', percent: 10 });
      const taskResults = await Promise.all(tasks.map(([id, summary, operation]) => runCheck(id, summary, operation, signal)));
      checks.push(...taskResults.map(result => result.check));
      const providerCatalog = taskResults.find(result => result.check.id === 'providers')?.value;
      const modelCatalog = taskResults.find(result => result.check.id === 'models')?.value;
      const settings = await runCheck('settings', 'Provider settings are readable and redacted.', () => client.call('settings.describe', {}, 10_000, signal), signal);
      checks.push(settings.check);
      let route = catalogRoute(providerCatalog, modelCatalog, settings.value);
      const refs = collectCredentialRefs(settings.value);
      const credentials = await runCheck(
        'credentials',
        'Credential references are readable without exposing values.',
        () => client.call('credentials.describe', { refs }, 10_000, signal),
        signal
      );
      checks.push(credentials.check);
      const probes = providerProbes(settings.value);
      if (probes.length === 0) {
        checks.push({ id: 'provider-endpoints', status: 'skipped', summary: 'No explicit OpenAI-compatible endpoint is configured.', durationMs: 0 });
      }
      for (const probe of probes) {
        const label = providerLabel(probe.provider);
        const endpoint = await runCheck(`endpoint:${label}`, 'Provider endpoint format and HTTPS policy are valid.', async () => {
          const url = validateProviderEndpoint(probe.baseURL);
          return { provider: label, source: endpointView(url) };
        }, signal);
        checks.push(endpoint.check);
        if (endpoint.check.status !== 'pass') continue;
        const url = validateProviderEndpoint(probe.baseURL);
        const dnsDeadline = withDeadline(signal, 8_000);
        const connectDeadline = withDeadline(signal, 8_000);
        const networkChecks: Array<Promise<CheckOutcome<unknown>>> = [
          runCheck(`dns:${label}`, 'Provider hostname resolves.', async () => {
            const addresses = await awaitAbortable(lookup(url.hostname, { all: true, verbatim: true }), dnsDeadline.signal);
            if (addresses.length === 0) throw new DshRpcError('TRANSPORT', 'Provider hostname returned no addresses');
            return { provider: label, configured: true };
          }, dnsDeadline.signal),
          runCheck(`connect:${label}`, 'Provider TCP/TLS connection succeeds.', () => probeConnection(url, connectDeadline.signal), connectDeadline.signal)
        ];
        if (probe.api?.startsWith('openai-')) {
          networkChecks.push(runCheck(`discover-models:${label}`, 'OpenAI-compatible model discovery succeeds.', async () => {
            const payload = { settingsNs: probe.settingsNs, provider: probe.provider, baseURL: probe.baseURL, api: probe.api };
            const result = await client.call<{ models: Array<{ id: string }> }>('llm.discoverModels', payload, 15_000, signal);
            if (!Array.isArray(result.models) || result.models.length === 0 || result.models.some(model => !model || typeof model.id !== 'string')) {
              throw new DshRpcError('MALFORMED_RESPONSE', 'Model discovery returned no valid models');
            }
            return { provider: label, models: result.models };
          }, signal));
        }
        try { checks.push(...(await Promise.all(networkChecks)).map(result => result.check)); }
        finally { dnsDeadline.dispose(); connectDeadline.dispose(); }
      }
      let evidence = emptyEvidence();
      if (mode === 'deep') {
        const deep = await this.deepCheck(client, signal, settings.value);
        checks.push(deep.check);
        route = mergeRoute(deep.route ?? {}, route);
        evidence = deep.evidence;
      }
      const report: DoctorReportV2 = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        appVersion: this.appVersion,
        runtimeVersion: snapshot.runtimeVersion,
        platform: `${process.platform}-${process.arch} ${os.release()}`,
        mode,
        checks,
        durationMs: Date.now() - started,
        requestId,
        evidence,
        ...(route.provider ? { provider: route.provider } : {}),
        ...(route.model ? { model: route.model } : {}),
        ...(route.endpoint ? { endpoint: route.endpoint } : {})
      };
      this.lastReport = report;
      this.progress({ phase: 'complete', message: '诊断完成。', percent: 100 });
      return structuredClone(report);
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async deepCheck(client: DshRpcClient, parentSignal: AbortSignal, settingsValue: unknown): Promise<DeepCheckOutcome> {
    const started = Date.now();
    const deadline = withDeadline(parentSignal, 150_000);
    const signal = deadline.signal;
    const nonce = randomBytes(16).toString('hex');
    const workspace = path.join(this.cacheRoot, `doctor-${nonce}`);
    const sentinel = path.join(workspace, `adhd-one-doctor-${nonce}.txt`);
    const sentinelName = path.basename(sentinel);
    await mkdir(workspace, { recursive: true });
    let sessionId: string | undefined;
    const muxEvents: SessionEventValue[] = [];
    let muxMalformed = false;
    let resolveTurnEnd!: () => void;
    let rejectTurnEnd!: (reason?: unknown) => void;
    const turnEnded = new Promise<void>((resolve, reject) => { resolveTurnEnd = resolve; rejectTurnEnd = reject; });
    void turnEnded.catch(() => undefined);
    const onAbort = () => rejectTurnEnd(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    let approvalEscalated = false;
    const mux = client.openMux(envelope => {
      const payload = envelope.payload;
      if (payload.type === 'approval/requested' && payload.sessionId === sessionId && typeof payload.approvalId === 'string') {
        approvalEscalated = true;
        void client.respond(envelope.rpcId, { sessionId, approvalId: payload.approvalId, outcome: 'rejected' }, signal).catch(() => undefined);
      }
      if (payload.type !== 'session/event' || payload.sessionId !== sessionId) return;
      const event = sessionEvent(payload.event);
      if (!event) { muxMalformed = true; return; }
      muxEvents.push(event);
      if (event.type === 'turn/end') resolveTurnEnd();
    }, signal, error => {
      muxMalformed = true;
      rejectTurnEnd(error);
    });
    let outcome: DoctorCheckV2 | undefined;
    let route: DefaultRoute = {};
    let evidence = emptyEvidence();
    let archiveFailed = false;
    try {
      await mux.opened;
      this.progress({ phase: 'deep', message: '正在创建隔离诊断会话…', percent: 55 });
      const created = await client.call<unknown>('session.create', { cwd: workspace }, 15_000, signal);
      if (!isRecord(created) || typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
        throw new DshRpcError('MALFORMED_RESPONSE', 'session.create returned an invalid session id');
      }
      sessionId = created.sessionId;
      const models = await client.call<unknown>('session.models', { sessionId }, 15_000, signal);
      if (!isRecord(models) || typeof models.routable !== 'boolean' || !isRecord(models.current)
        || typeof models.current.provider !== 'string' || typeof models.current.model !== 'string') {
        throw new DshRpcError('MALFORMED_RESPONSE', 'session.models returned an invalid route');
      }
      const endpoint = endpointForProvider(settingsValue, models.current.provider);
      route = {
        provider: providerLabel(models.current.provider),
        model: redactText(models.current.model),
        ...(endpoint ? { endpoint } : {})
      };
      if (!models.routable) throw new DshRpcError('MODEL_UNAVAILABLE', 'The current model route is not available.');
      const prompt = `Provider Doctor check. In the current workspace, create ${path.basename(sentinel)}, write exactly ${nonce}, read it back, and reply with exactly ${nonce}. Do not access any path outside the current workspace.`;
      await client.call('session.prompt', { sessionId, content: [{ type: 'text', text: prompt }], mode: 'queue' }, 15_000, signal);
      await turnEnded;
      if (approvalEscalated) throw new DshRpcError('TOOL_ESCALATION_REQUIRED', 'The diagnostic session requested approval.');
      const history = await client.call<unknown>('session.history', { sessionId, maxMessages: 200 }, 15_000, signal);
      const historyEvidence = inspectEventSequence(historyEvents(history), nonce, sentinelName);
      evidence = historyEvidence.flags;
      if (muxMalformed) throw new DeepEvidenceError('MALFORMED_RESPONSE', 'The mux stream returned an invalid session event.', evidence);
      const muxEvidence = inspectEventSequence(muxEvents, nonce, sentinelName);
      evidence = intersectEvidence(historyEvidence.flags, muxEvidence.flags);
      assertMatchingEvidence(historyEvidence, muxEvidence);
      let contents: string;
      try { contents = await readFile(sentinel, 'utf8'); }
      catch { throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'The diagnostic sentinel file could not be verified.', evidence); }
      if (contents.trim() !== nonce) throw new DeepEvidenceError('TOOL_ARGUMENT_INVALID', 'The diagnostic sentinel file did not match.', evidence);
      evidence.fileVerified = true;
      outcome = {
        id: 'deep-tool-round-trip', status: 'pass', summary: '真实模型、工具调用、参数解析、mux/history 事件和文件往返均成功。',
        durationMs: Date.now() - started,
        details: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: typeof models.current.reasoningEffort === 'string' ? redactText(models.current.reasoningEffort) : 'provider-default',
          historyToolCalls: historyEvidence.toolCalls,
          historyToolResults: historyEvidence.toolResults,
          muxToolCalls: muxEvidence.toolCalls,
          muxToolResults: muxEvidence.toolResults,
          assistantNonce: true,
          turnEnded: true,
          fileVerified: true
        }
      };
    } catch (error) {
      if (parentSignal.aborted) throw error;
      if (error instanceof DeepEvidenceError) evidence = hasEvidence(evidence) ? intersectEvidence(evidence, error.evidence) : error.evidence;
      const code = classify(error);
      outcome = { id: 'deep-tool-round-trip', status: 'fail', code, summary: safeFailureSummary(code), durationMs: Date.now() - started };
    } finally {
      signal.removeEventListener('abort', onAbort);
      mux.close();
      deadline.dispose();
      if (sessionId) {
        const cleanupSignal = AbortSignal.timeout(2_500);
        try { await client.call('workspace.archiveSession', { sessionId }, 2_000, cleanupSignal); }
        catch { archiveFailed = true; }
      }
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!outcome) throw new DshRpcError('TRANSPORT', 'Deep check did not produce an outcome');
    if (archiveFailed) {
      outcome = {
        ...outcome,
        summary: `${outcome.summary} Diagnostic session archival failed.`,
        details: { ...(outcome.details ?? {}), sessionArchived: false }
      };
    }
    return { check: outcome, ...(Object.keys(route).length > 0 ? { route } : {}), evidence };
  }
}
