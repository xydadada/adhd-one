/** Minimal RPC carrier adapted from @deepseek-ai/dsh-client-connection (MIT), commit 47f943859b. */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { parseLoopbackRuntimeUrl } from './security.js';

const envelopeSchema = z.object({
  type: z.string().optional(),
  rpcId: z.string(),
  result: z.object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional()
  })
});

export class DshRpcError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export class DshRpcClient {
  private readonly origin: string;
  constructor(runtimeUrl: string) {
    const parsed = parseLoopbackRuntimeUrl(runtimeUrl);
    if (!parsed) throw new Error('INVALID_RUNTIME_ORIGIN');
    this.origin = parsed.origin;
  }

  async call<T = unknown>(method: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
    if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/u.test(method)) throw new Error('INVALID_RPC_METHOD');
    const rpcId = randomBytes(12).toString('hex');
    const response = await fetch(`${this.origin}/api/${method}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new DshRpcError(`HTTP_${response.status}`, `RPC ${method} returned HTTP ${response.status}`);
    const envelope = envelopeSchema.parse(await response.json());
    if (envelope.rpcId !== rpcId) throw new DshRpcError('RPC_ID_MISMATCH', `RPC ${method} returned the wrong rpcId`);
    if (!envelope.result.ok) throw new DshRpcError(envelope.result.error?.code ?? 'RPC_FAILED', envelope.result.error?.message ?? `${method} failed`, envelope.result.error?.details);
    return envelope.result.value as T;
  }

  openMux(onEnvelope: (envelope: { rpcId: string; payload: Record<string, unknown> }) => void): { close(): void; opened: Promise<void> } {
    const url = new URL('/api/events.mux', this.origin);
    url.protocol = 'ws:';
    const socket = new WebSocket(url);
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.on('message', data => {
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
      try {
        const value = JSON.parse(data.toString()) as { rpcId?: unknown; payload?: unknown };
        if (typeof value.rpcId === 'string' && value.payload && typeof value.payload === 'object') {
          onEnvelope({ rpcId: value.rpcId, payload: value.payload as Record<string, unknown> });
        }
      } catch {}
    });
    return { opened, close: () => socket.close() };
  }

  async respond(rpcId: string, value: unknown): Promise<void> {
    const response = await fetch(`${this.origin}/api/respond`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new DshRpcError(`HTTP_${response.status}`, `respond returned HTTP ${response.status}`);
  }
}
