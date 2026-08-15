import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshRpcClient, DshRpcError } from '../src/dsh-rpc-client.js';

const runtimeUrl = 'http://127.0.0.1:43123';

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectSafeError(error: unknown, ...secrets: string[]): asserts error is Error {
  expect(error).toBeInstanceOf(Error);
  const candidate = error as Error;
  for (const secret of secrets) {
    expect(candidate.message).not.toContain(secret);
    expect(JSON.stringify(candidate)).not.toContain(secret);
  }
}

describe('DshRpcError security boundary', () => {
  it('normalizes unknown remote codes and never retains or serializes remote text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string };
      return new Response(JSON.stringify({
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'REMOTE_FAILURE',
            message: 'provider failed Authorization: Bearer bearer-secret at C:\\Users\\Alice\\private\\request.json',
            details: {
              responseBody: 'response-body-secret',
              authorization: 'Bearer details-secret',
              path: 'C:\\Users\\Alice\\private\\response.json'
            }
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const thrown = await captureError(() => new DshRpcClient(runtimeUrl).call('host.describe', {}));

    expect(thrown).toBeInstanceOf(DshRpcError);
    const error = thrown as DshRpcError;
    expect(error.code).toBe('RPC_FAILED');
    expect(error.message).toBe('RPC request failed.');
    expect(Object.prototype.hasOwnProperty.call(error, 'details')).toBe(false);
    expect('details' in error).toBe(false);
    expect(JSON.stringify(error)).toEqual(JSON.stringify({ code: 'RPC_FAILED' }));
    expectSafeError(error, 'bearer-secret', 'bearer details-secret', 'response-body-secret', 'Alice', 'private');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Provider Doctor stable codes while dropping remote message text', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string };
      return new Response(JSON.stringify({
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'AUTH', message: 'Authorization: Bearer provider-secret C:\\Users\\Alice\\private\\auth.json' } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const thrown = await captureError(() => new DshRpcClient(runtimeUrl).call('host.describe', {}));

    expect(thrown).toBeInstanceOf(DshRpcError);
    const error = thrown as DshRpcError;
    expect(error.code).toBe('AUTH');
    expect(error.message).toBe('RPC request failed (AUTH).');
    expect(JSON.stringify(error)).toEqual(JSON.stringify({ code: 'AUTH' }));
    expectSafeError(error, 'provider-secret', 'Alice', 'private');
  });

  it('does not expose an HTTP response body or malformed body in the public error', async () => {
    const body = 'Authorization: Bearer response-secret C:\\Users\\Alice\\private\\body.json';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 502 }));

    const httpThrown = await captureError(() => new DshRpcClient(runtimeUrl).call('host.describe', {}));
    expect(httpThrown).toBeInstanceOf(DshRpcError);
    expect(httpThrown).toMatchObject({ code: 'HTTP_502', message: 'RPC host.describe returned HTTP 502' });
    expectSafeError(httpThrown, 'response-secret', 'Alice', 'private');

    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const malformedThrown = await captureError(() => new DshRpcClient(runtimeUrl).call('host.describe', {}));
    expect(malformedThrown).toBeInstanceOf(DshRpcError);
    expect(malformedThrown).toMatchObject({ code: 'MALFORMED_RESPONSE', message: 'RPC host.describe returned malformed JSON' });
    expectSafeError(malformedThrown, 'response-secret', 'Alice', 'private');
  });

  it('keeps rpc protocol mismatch errors stable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      rpcId: 'wrong-rpc-id',
      result: { ok: true, value: {} }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const thrown = await captureError(() => new DshRpcClient(runtimeUrl).call('host.describe', {}));

    expect(thrown).toBeInstanceOf(DshRpcError);
    expect(thrown).toMatchObject({ code: 'RPC_ID_MISMATCH', message: 'RPC host.describe returned the wrong rpcId' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves abort cancellation while the request is pending', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const running = new DshRpcClient(runtimeUrl).call('host.describe', {}, 10_000, controller.signal);

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires the official accepted receipt from /api/respond', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    await expect(new DshRpcClient(runtimeUrl).respond('approval-rpc', { outcome: 'rejected' })).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: false, reason: 'not-pending' }), { status: 200 }));
    await expect(new DshRpcClient(runtimeUrl).respond('approval-rpc', { outcome: 'rejected' })).rejects.toMatchObject({ code: 'DSH_PROTOCOL_INCOMPATIBLE' });

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(new DshRpcClient(runtimeUrl).respond('approval-rpc', { outcome: 'rejected' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});
