/** Minimal RPC carrier adapted from @deepseek-ai/dsh-client-connection (MIT), DeepSeek Harness commit 47f943859b (upstream 0.1.0-rc.5); adapted-code source only, not an npm provenance record. */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { parseLoopbackRuntimeUrl, redactText } from './security.js';

const REMOTE_ERROR_CODES = new Set([
  'RPC_FAILED',
  'MISSING_CREDENTIAL', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'TRANSPORT', 'TIMEOUT',
  'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'TOOL_ARGUMENT_INVALID', 'TOOL_ESCALATION_REQUIRED',
  'REASONING_UNSUPPORTED', 'DSH_PROTOCOL_INCOMPATIBLE'
]);

const envelopeSchema = z.object({
  type: z.string().optional(),
  rpcId: z.string(),
  result: z.object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.unknown().optional() }).optional()
  })
});

const receiptSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }),
  z.object({ accepted: z.literal(false), reason: z.enum(['not-pending', 'bad-response']) })
]);

function normalizeRemoteCode(code: unknown): string {
  return typeof code === 'string' && REMOTE_ERROR_CODES.has(code) ? code : 'RPC_FAILED';
}

export class DshRpcError extends Error {
  constructor(readonly code: string, message: string) { super(redactText(message)); }

  static fromRemote(code: unknown): DshRpcError {
    const stableCode = normalizeRemoteCode(code);
    const message = stableCode === 'RPC_FAILED' ? 'RPC request failed.' : `RPC request failed (${stableCode}).`;
    return new DshRpcError(stableCode, message);
  }

  toJSON(): { code: string } {
    return { code: this.code };
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function requestSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(external ? abortReason(external) : new DOMException('The operation was aborted.', 'AbortError'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      external?.removeEventListener('abort', onAbort);
    }
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

export class DshRpcClient {
  private readonly origin: string;
  constructor(runtimeUrl: string) {
    const parsed = parseLoopbackRuntimeUrl(runtimeUrl);
    if (!parsed) throw new Error('INVALID_RUNTIME_ORIGIN');
    this.origin = parsed.origin;
  }

  async call<T = unknown>(method: string, payload: unknown, timeoutMs = 10_000, externalSignal?: AbortSignal): Promise<T> {
    if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/u.test(method)) throw new Error('INVALID_RPC_METHOD');
    const rpcId = randomBytes(12).toString('hex');
    const request = requestSignal(timeoutMs, externalSignal);
    try {
      const response = await abortable(fetch(`${this.origin}/api/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: request.signal
      }), request.signal);
      if (!response.ok) throw new DshRpcError(`HTTP_${response.status}`, `RPC ${method} returned HTTP ${response.status}`);
      let raw: unknown;
      try { raw = await abortable(response.json(), request.signal); }
      catch (error) {
        if (request.signal.aborted) throw error;
        throw new DshRpcError('MALFORMED_RESPONSE', `RPC ${method} returned malformed JSON`);
      }
      let envelope: z.infer<typeof envelopeSchema>;
      try { envelope = envelopeSchema.parse(raw); }
      catch { throw new DshRpcError('MALFORMED_RESPONSE', `RPC ${method} returned an invalid envelope`); }
      if (envelope.rpcId !== rpcId) throw new DshRpcError('RPC_ID_MISMATCH', `RPC ${method} returned the wrong rpcId`);
      if (!envelope.result.ok) throw DshRpcError.fromRemote(envelope.result.error?.code);
      return envelope.result.value as T;
    } finally {
      request.dispose();
    }
  }

  openMux(
    onEnvelope: (envelope: { rpcId: string; payload: Record<string, unknown> }) => void,
    externalSignal?: AbortSignal,
    onProtocolError?: (error: DshRpcError) => void
  ): { close(): void; opened: Promise<void> } {
    const url = new URL('/api/events.mux', this.origin);
    url.protocol = 'ws:';
    if (externalSignal?.aborted) return { close: () => undefined, opened: Promise.reject(abortReason(externalSignal)) };

    const socket = new WebSocket(url);
    let openSettled = false;
    let openedSuccessfully = false;
    let closed = false;
    let terminalReported = false;
    let resolveOpened!: () => void;
    let rejectOpened!: (reason?: unknown) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
    const finishOpen = (error?: unknown) => {
      if (openSettled) return;
      openSettled = true;
      if (error === undefined) resolveOpened(); else rejectOpened(error);
    };
    const terminate = (reason?: unknown) => {
      if (reason !== undefined) finishOpen(reason);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate();
      else if (socket.readyState === WebSocket.CLOSING) return;
      else socket.close();
    };
    const reportTerminal = (code: 'TRANSPORT' | 'STREAM_CLOSED', message: string) => {
      if (closed || terminalReported) return;
      terminalReported = true;
      onProtocolError?.(new DshRpcError(code, message));
    };
    const onAbort = () => {
      closed = true;
      terminate(abortReason(externalSignal!));
    };
    const onOpen = () => {
      openedSuccessfully = true;
      finishOpen();
    };
    const onError = (error: unknown) => {
      if (!openedSuccessfully) finishOpen(error);
      else reportTerminal('TRANSPORT', 'Mux transport failed after opening.');
    };
    const onClose = () => {
      const expected = closed;
      externalSignal?.removeEventListener('abort', onAbort);
      if (!openedSuccessfully) finishOpen(new DshRpcError('STREAM_CLOSED', 'Mux closed before opening.'));
      else if (!expected) reportTerminal('STREAM_CLOSED', 'Mux closed before the diagnostic turn completed.');
      closed = true;
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    socket.once('open', onOpen);
    socket.on('error', onError);
    socket.once('close', onClose);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    socket.on('message', data => {
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
        onProtocolError?.(new DshRpcError('MALFORMED_RESPONSE', 'Mux returned an unsupported frame type'));
        return;
      }
      try {
        const value = JSON.parse(data.toString()) as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
        const payload = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
          ? value.payload as Record<string, unknown>
          : undefined;
        if (value.type !== 'server-request' || typeof value.rpcId !== 'string' || typeof value.method !== 'string'
          || !payload || typeof payload.type !== 'string' || value.method !== payload.type) {
          onProtocolError?.(new DshRpcError('MALFORMED_RESPONSE', 'Mux returned an invalid envelope'));
          return;
        }
        try { onEnvelope({ rpcId: value.rpcId, payload }); }
        catch { onProtocolError?.(new DshRpcError('MALFORMED_RESPONSE', 'Mux envelope handler rejected a frame')); }
      } catch {
        onProtocolError?.(new DshRpcError('MALFORMED_RESPONSE', 'Mux returned malformed JSON'));
      }
    });
    if (externalSignal?.aborted) onAbort();
    return {
      opened,
      close: () => {
        if (closed) return;
        closed = true;
        externalSignal?.removeEventListener('abort', onAbort);
        socket.removeListener('open', onOpen);
        terminate(openSettled ? undefined : new Error('MUX_CLOSED_BEFORE_OPEN'));
        if (socket.readyState === WebSocket.CLOSED) {
          socket.removeListener('error', onError);
          socket.removeListener('close', onClose);
        }
      }
    };
  }

  async respond(rpcId: string, value: unknown, externalSignal?: AbortSignal): Promise<void> {
    const request = requestSignal(5_000, externalSignal);
    try {
      const response = await abortable(fetch(`${this.origin}/api/respond`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
        signal: request.signal
      }), request.signal);
      if (!response.ok) throw new DshRpcError(`HTTP_${response.status}`, `respond returned HTTP ${response.status}`);
      let raw: unknown;
      try { raw = await abortable(response.json(), request.signal); }
      catch (error) {
        if (request.signal.aborted) throw error;
        throw new DshRpcError('MALFORMED_RESPONSE', 'respond returned malformed JSON');
      }
      const receipt = receiptSchema.safeParse(raw);
      if (!receipt.success) throw new DshRpcError('MALFORMED_RESPONSE', 'respond returned an invalid receipt');
      if (!receipt.data.accepted) throw new DshRpcError('DSH_PROTOCOL_INCOMPATIBLE', 'respond rejected the pending approval response');
    } finally {
      request.dispose();
    }
  }
}
