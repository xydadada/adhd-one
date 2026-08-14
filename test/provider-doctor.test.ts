import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshRpcClient } from '../src/dsh-rpc-client.js';
import { ProviderDoctor } from '../src/provider-doctor.js';

const runtime = {
  snapshot: () => ({
    state: 'ready' as const,
    generation: 1,
    runtimeVersion: '0.1.0-rc.6',
    runtimeSlot: 'bundled' as const,
    url: 'http://127.0.0.1:43123'
  })
};

const responseValue = (method: string): unknown => {
  switch (method) {
    case 'host.describe': return { version: 'test' };
    case 'agentPreset.list': return { items: [] };
    case 'llm.providers': return { providers: [] };
    case 'llm.models': return { models: [] };
    case 'settings.describe': return { namespaces: [{ value: { apiKeyEnv: 'CUSTOM_API_KEY' } }] };
    case 'credentials.describe': return { credentials: { CUSTOM_API_KEY: { configured: false, writable: true } } };
    default: return {};
  }
};

function createDoctor(cacheRoot: string): ProviderDoctor {
  return new ProviderDoctor(runtime as never, cacheRoot, '0.2.0-test', () => undefined);
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'adhd-provider-doctor-'));
}

interface ResultMetadataOverride {
  turn?: number;
  step?: number;
  toolCallId?: string;
}

function sessionEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { seq, time: 1_725_000_000_000 + seq, type, data, ...extra };
}

function roundTripEvents(nonce: string, sentinelName: string, override: ResultMetadataOverride = {}): Array<Record<string, unknown>> {
  const resultMessage = (id: string, sourceCallId: string, blockToolCallId: string, text: string): Record<string, unknown> => ({
    id,
    role: 'user',
    source: { kind: 'tool', callId: sourceCallId },
    content: [{ type: 'tool-result', toolCallId: blockToolCallId, content: [{ type: 'text', text }], isError: false }]
  });
  return [
    sessionEvent(1, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-write',
      name: 'write',
      arguments: JSON.stringify({ file_path: sentinelName, content: nonce })
    }),
    sessionEvent(2, 'tool/result', {
      turn: override.turn ?? 1,
      step: override.step ?? 1,
      message: resultMessage('result-write', 'call-write', override.toolCallId ?? 'call-write', 'written')
    }, { sourceEventSeqs: [1], surfaceOp: 'append' }),
    sessionEvent(3, 'tool/call', {
      turn: 1,
      step: 2,
      callId: 'call-read',
      name: 'read',
      arguments: JSON.stringify({ file_path: sentinelName })
    }),
    sessionEvent(4, 'tool/result', {
      turn: 1,
      step: 2,
      message: resultMessage('result-read', 'call-read', 'call-read', nonce)
    }, { sourceEventSeqs: [3], surfaceOp: 'append' }),
    sessionEvent(5, 'assistant/message', {
      turn: 1,
      step: 3,
      message: { id: 'assistant-final', role: 'assistant', content: [{ type: 'text', text: nonce }] }
    }),
    sessionEvent(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProviderDoctor', () => {
  it('runs credentials.describe with only credential references and never values', async () => {
    const root = await tempRoot();
    const calls: Array<{ method: string; payload: unknown }> = [];
    const call = vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push({ method, payload });
      return responseValue(method) as never;
    });
    try {
      const report = await createDoctor(root).run('quick');
      const credentialsCall = calls.find(item => item.method === 'credentials.describe');
      expect(credentialsCall).toBeDefined();
      expect(credentialsCall?.payload).toEqual({ refs: ['CUSTOM_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'] });
      expect(report.checks.find(check => check.id === 'credentials')).toMatchObject({ status: 'pass' });
      expect(JSON.stringify(report)).not.toContain('secret-value');
      expect(call).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits a V2 Quick report with timing, a per-run request id, and empty evidence', async () => {
    const root = await tempRoot();
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async method => responseValue(method) as never);
    try {
      const doctor = createDoctor(root);
      const first = await doctor.run('quick');
      const second = await doctor.run('quick');
      expect(first.schemaVersion).toBe(2);
      expect(first.requestId).toMatch(/^[a-f0-9]{32}$/u);
      expect(second.requestId).toMatch(/^[a-f0-9]{32}$/u);
      expect(second.requestId).not.toBe(first.requestId);
      expect(first.durationMs).toEqual(expect.any(Number));
      expect(first.durationMs).toBeGreaterThanOrEqual(0);
      for (const check of first.checks) {
        expect(check.durationMs).toEqual(expect.any(Number));
        expect(check.durationMs).toBeGreaterThanOrEqual(0);
      }
      expect(first.evidence).toEqual({
        toolCall: false,
        toolResult: false,
        argumentsParsed: false,
        fileVerified: false,
        secondTurnConsumed: false,
        finalNonce: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a valid HTTPS path and discovers models without sending an API key', async () => {
    const root = await tempRoot();
    const calls: Array<{ method: string; payload: unknown }> = [];
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'settings.describe') return {
        namespaces: [{ ns: 'llm-pi-ai', value: { providers: { gateway: { baseURL: 'https://127.0.0.1:9/openai/v1/', api: 'openai-completions', apiKeyEnv: 'GATEWAY_KEY' } } } }]
      } as never;
      if (method === 'credentials.describe') return { credentials: { GATEWAY_KEY: { configured: true, source: 'store' } } } as never;
      if (method === 'llm.discoverModels') return { models: [{ id: 'test-model' }] } as never;
      return responseValue(method) as never;
    });
    try {
      const report = await createDoctor(root).run('quick');
      expect(report.checks.find(check => check.id === 'endpoint:gateway')).toMatchObject({ status: 'pass' });
      expect(report.checks.find(check => check.id === 'discover-models:gateway')).toMatchObject({ status: 'pass' });
      expect(report.provider).toBe('gateway');
      expect(report.endpoint).toBe('https://127.0.0.1:9/…');
      const discovery = calls.find(call => call.method === 'llm.discoverModels');
      expect(discovery?.payload).toEqual({ settingsNs: 'llm-pi-ai', provider: 'gateway', baseURL: 'https://127.0.0.1:9/openai/v1/', api: 'openai-completions' });
      expect(JSON.stringify(discovery?.payload)).not.toContain('apiKey');
      expect(JSON.stringify(report)).not.toContain('GATEWAY_KEY');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows loopback HTTP endpoints while continuing the Quick Doctor checks', async () => {
    const root = await tempRoot();
    const calls: Array<{ method: string; payload: unknown }> = [];
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'settings.describe') return {
        namespaces: [{ ns: 'llm-pi-ai', value: { providers: { gateway: { baseURL: 'http://127.0.0.1:9/local/v1/', api: 'openai-completions' } } } }]
      } as never;
      if (method === 'llm.discoverModels') return { models: [{ id: 'loopback-model' }] } as never;
      return responseValue(method) as never;
    });
    try {
      const report = await createDoctor(root).run('quick');
      expect(report.checks.find(check => check.id === 'endpoint:gateway')).toMatchObject({ status: 'pass' });
      expect(calls.some(call => call.method === 'llm.discoverModels')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['public HTTP', 'http://api.example.test/provider/v1/'],
    ['userinfo', 'https://doctor-user:embedded-secret@api.example.test/provider/v1/'],
    ['invalid scheme', 'ftp://api.example.test/provider/v1/']
  ])('refuses %s provider endpoints before discovery', async (_label, baseURL) => {
    const root = await tempRoot();
    const calls: Array<{ method: string; payload: unknown }> = [];
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'settings.describe') return {
        namespaces: [{ ns: 'llm-pi-ai', value: { providers: { gateway: { baseURL, api: 'openai-completions' } } } }]
      } as never;
      if (method === 'llm.discoverModels') return { models: [{ id: 'must-not-be-used' }] } as never;
      return responseValue(method) as never;
    });
    try {
      const report = await createDoctor(root).run('quick');
      expect(report.checks.find(check => check.id === 'endpoint:gateway')).toMatchObject({ status: 'fail', code: 'TRANSPORT' });
      expect(calls.some(call => call.method === 'llm.discoverModels')).toBe(false);
      expect(report.checks.some(check => check.id.startsWith('dns:') || check.id.startsWith('connect:'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing models', {}],
    ['empty models', { models: [] }],
    ['invalid model entry', { models: [{ id: 42 }] }]
  ])('fails discovery for %s responses', async (_label, discoveryResponse) => {
    const root = await tempRoot();
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async method => {
      if (method === 'settings.describe') return {
        namespaces: [{ ns: 'llm-pi-ai', value: { providers: { gateway: { baseURL: 'https://127.0.0.1:9/openai/v1/', api: 'openai-completions' } } } }]
      } as never;
      if (method === 'llm.discoverModels') return discoveryResponse as never;
      return responseValue(method) as never;
    });
    try {
      const report = await createDoctor(root).run('quick');
      expect(report.checks.find(check => check.id === 'discover-models:gateway')).toMatchObject({ status: 'fail', code: 'MALFORMED_RESPONSE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates valid credential refs and excludes invalid refs', async () => {
    const root = await tempRoot();
    const calls: Array<{ method: string; payload: unknown }> = [];
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'settings.describe') return {
        namespaces: [{
          ns: 'llm-pi-ai',
          value: {
            apiKeyEnv: 'VALID_KEY',
            providers: {
              gateway: {
                baseURL: 'https://127.0.0.1:9/openai/v1/',
                api: 'openai-completions',
                apiKeyEnv: 'GATEWAY_KEY',
                credentialRef: 'GATEWAY_KEY',
                duplicate: { apiKeyEnv: 'VALID_KEY', credentialRef: 'SHARED_KEY' },
                invalid: { apiKeyEnv: 'NOT-AN-ENV', credentialRef: '123_NOT_VALID' }
              },
              other: { credentialRef: 'SHARED_KEY' }
            }
          }
        }]
      } as never;
      return responseValue(method) as never;
    });
    try {
      await createDoctor(root).run('quick');
      const credentialsCall = calls.find(call => call.method === 'credentials.describe');
      expect(credentialsCall?.payload).toEqual({ refs: ['DEEPSEEK_API_KEY', 'GATEWAY_KEY', 'OPENAI_API_KEY', 'SHARED_KEY', 'VALID_KEY'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes reports without credential values or full sensitive endpoint paths', async () => {
    const root = await tempRoot();
    const credentialValue = 'credential-value-never-report';
    const sensitiveEndpoint = 'https://127.0.0.1:9/tenant/private/provider/v1/?token=endpoint-secret';
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async method => {
      if (method === 'settings.describe') return {
        namespaces: [{ ns: 'llm-pi-ai', value: { providers: { gateway: {
          baseURL: sensitiveEndpoint,
          api: 'openai-completions',
          apiKeyEnv: 'SENSITIVE_KEY',
          apiKey: credentialValue
        } } } }]
      } as never;
      if (method === 'credentials.describe') return {
        credentials: { SENSITIVE_KEY: { configured: true, source: 'store', value: credentialValue } }
      } as never;
      if (method === 'llm.discoverModels') return { models: [{ id: 'safe-model' }] } as never;
      return responseValue(method) as never;
    });
    try {
      const doctor = createDoctor(root);
      const report = await doctor.run('quick');
      const serialized = JSON.stringify(report);
      const serializedSnapshot = JSON.stringify(doctor.report());
      for (const output of [serialized, serializedSnapshot]) {
        expect(output).not.toContain(credentialValue);
        expect(output).not.toContain(sensitiveEndpoint);
        expect(output).not.toContain('/tenant/private/provider/v1/');
        expect(output).not.toContain('endpoint-secret');
      }
      expect(report.checks.find(check => check.id === 'endpoint:gateway')).toMatchObject({
        status: 'pass',
        details: { source: 'https://127.0.0.1:9/…' }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires matching tool-call/result, nonce assistant message, and turn end in history and mux', async () => {
    const root = await tempRoot();
    let emitMux: ((envelope: { rpcId: string; payload: Record<string, unknown> }) => void) | undefined;
    const events: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    vi.spyOn(DshRpcClient.prototype, 'openMux').mockImplementation(onEnvelope => {
      emitMux = onEnvelope;
      return { opened: Promise.resolve(), close: vi.fn() };
    });
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push(method);
      if (method === 'settings.describe') return { namespaces: [] } as never;
      if (method === 'credentials.describe') return { credentials: {} } as never;
      if (method === 'session.create') return { sessionId: 'doctor-session' } as never;
      if (method === 'session.models') return { routable: true, current: { provider: 'deepseek', model: 'deepseek-chat' } } as never;
      if (method === 'session.prompt') {
        const prompt = payload as { content: Array<{ text: string }> };
        const match = prompt.content[0]?.text.match(/create ([^,]+), write exactly ([a-f0-9]+),/u);
        if (!match) throw new Error('test prompt did not contain the sentinel');
        await writeFile(path.join((await findWorkspace(root)), match[1]), match[2], 'utf8');
        events.push(...roundTripEvents(match[2], match[1]));
        for (const event of events) emitMux?.({ rpcId: `event-${String(event.seq)}`, payload: { type: 'session/event', sessionId: 'doctor-session', event } });
        return {} as never;
      }
      if (method === 'session.history') return { hasMore: false, events: events.map(event => ({ event })) } as never;
      return {} as never;
    });
    try {
      const reportPromise = createDoctor(root).run('deep');
      await waitFor(() => calls.includes('session.create'));
      const report = await reportPromise;
      const deep = report.checks.find(check => check.id === 'deep-tool-round-trip');
      expect(deep).toMatchObject({ status: 'pass' });
      expect(deep?.details).toMatchObject({ historyToolCalls: 2, historyToolResults: 2, muxToolCalls: 2, muxToolResults: 2, assistantNonce: true, turnEnded: true });
      expect(report.schemaVersion).toBe(2);
      expect(report.provider).toBe('deepseek');
      expect(report.model).toBe('deepseek-chat');
      expect(report.evidence).toEqual({
        toolCall: true,
        toolResult: true,
        argumentsParsed: true,
        fileVerified: true,
        secondTurnConsumed: true,
        finalNonce: true
      });
      expect(JSON.stringify(report)).not.toMatch(/rpcId|doctor-session|call-write/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['turn', { turn: 2 }],
    ['step', { step: 99 }],
    ['toolCallId', { toolCallId: 'wrong-tool-call' }]
  ])('rejects a mismatched tool result %s as DSH_PROTOCOL_INCOMPATIBLE', async (_label, override) => {
    const root = await tempRoot();
    let emitMux: ((envelope: { rpcId: string; payload: Record<string, unknown> }) => void) | undefined;
    const events: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    vi.spyOn(DshRpcClient.prototype, 'openMux').mockImplementation(onEnvelope => {
      emitMux = onEnvelope;
      return { opened: Promise.resolve(), close: vi.fn() };
    });
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      calls.push(method);
      if (method === 'settings.describe') return { namespaces: [] } as never;
      if (method === 'credentials.describe') return { credentials: {} } as never;
      if (method === 'session.create') return { sessionId: 'doctor-session' } as never;
      if (method === 'session.models') return { routable: true, current: { provider: 'deepseek', model: 'deepseek-chat' } } as never;
      if (method === 'session.prompt') {
        const prompt = payload as { content: Array<{ text: string }> };
        const match = prompt.content[0]?.text.match(/create ([^,]+), write exactly ([a-f0-9]+),/u);
        if (!match) throw new Error('test prompt did not contain the sentinel');
        await writeFile(path.join((await findWorkspace(root)), match[1]), match[2], 'utf8');
        events.push(...roundTripEvents(match[2], match[1], override));
        for (const event of events) emitMux?.({ rpcId: `event-${String(event.seq)}`, payload: { type: 'session/event', sessionId: 'doctor-session', event } });
        return {} as never;
      }
      if (method === 'session.history') return { hasMore: false, events: events.map(event => ({ event })) } as never;
      return {} as never;
    });
    try {
      const report = await createDoctor(root).run('deep');
      const deep = report.checks.find(check => check.id === 'deep-tool-round-trip');
      expect(deep).toMatchObject({ status: 'fail', code: 'DSH_PROTOCOL_INCOMPATIBLE' });
      expect(calls).toContain('session.history');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies unparseable tool arguments without echoing provider text', async () => {
    const root = await tempRoot();
    let emitMux: ((envelope: { rpcId: string; payload: Record<string, unknown> }) => void) | undefined;
    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(DshRpcClient.prototype, 'openMux').mockImplementation(onEnvelope => {
      emitMux = onEnvelope;
      return { opened: Promise.resolve(), close: vi.fn() };
    });
    vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation(async (method, payload) => {
      if (method === 'settings.describe') return { namespaces: [] } as never;
      if (method === 'credentials.describe') return { credentials: {} } as never;
      if (method === 'session.create') return { sessionId: 'doctor-session' } as never;
      if (method === 'session.models') return { routable: true, current: { provider: 'deepseek', model: 'deepseek-chat' } } as never;
      if (method === 'session.prompt') {
        const prompt = payload as { content: Array<{ text: string }> };
        const match = prompt.content[0]?.text.match(/write exactly ([a-f0-9]+),/u);
        if (!match) throw new Error('test prompt did not contain a nonce');
        events.push(
          sessionEvent(1, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: '{not-json' }),
          sessionEvent(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
        );
        for (const event of events) emitMux?.({ rpcId: `event-${String(event.seq)}`, payload: { type: 'session/event', sessionId: 'doctor-session', event } });
        return {} as never;
      }
      if (method === 'session.history') return { hasMore: false, events: events.map(event => ({ event })) } as never;
      return {} as never;
    });
    try {
      const report = await createDoctor(root).run('deep');
      const deep = report.checks.find(check => check.id === 'deep-tool-round-trip');
      expect(deep).toMatchObject({ status: 'fail', code: 'TOOL_ARGUMENT_INVALID' });
      expect(report.evidence).toMatchObject({ toolCall: true, toolResult: false, argumentsParsed: false, fileVerified: false, secondTurnConsumed: false, finalNonce: false });
      expect(deep?.summary).not.toContain('not-json');
      expect(deep?.summary).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels all quick RPC calls promptly', async () => {
    const root = await tempRoot();
    const call = vi.spyOn(DshRpcClient.prototype, 'call').mockImplementation((_method, _payload, _timeout, signal) => new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    try {
      const doctor = createDoctor(root);
      const running = doctor.run('quick');
      await waitFor(() => call.mock.calls.length >= 4);
      const started = Date.now();
      doctor.cancel();
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('DshRpcClient cancellation', () => {
  it('passes cancellation into a pending fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    try {
      const running = new DshRpcClient('http://127.0.0.1:43123').call('host.describe', {}, 10_000, controller.signal);
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('cancels a WebSocket while its opening handshake is waiting', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const handle = new DshRpcClient(`http://127.0.0.1:${port}`).openMux(() => undefined, controller.signal);
    controller.abort();
    try {
      await expect(handle.opened).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      handle.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  if (!predicate()) throw new Error('test condition timed out');
}

async function findWorkspace(root: string): Promise<string> {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(root, { withFileTypes: true }));
  const workspace = entries.find(entry => entry.isDirectory() && entry.name.startsWith('doctor-'));
  if (!workspace) throw new Error('diagnostic workspace was not created');
  return path.join(root, workspace.name);
}
