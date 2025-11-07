import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JsonRpcTransport } from '../../../src/bridge/jsonrpc-transport.js';
import { CircuitBreaker } from '../../../src/utils/circuit-breaker.js';

const createTransport = (): JsonRpcTransport => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return new JsonRpcTransport({
    stdin,
    stdout,
    stderr,
    codec: {
      encode: (value) => Buffer.from(JSON.stringify(value)),
      decode: (buffer) => JSON.parse(buffer.toString()),
    },
  });
};

describe('JsonRpcTransport resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries idempotent methods on transient failures', async () => {
    const transport = createTransport();
    const timeoutError = new Error('Request timed out');
    timeoutError.name = 'TimeoutError';

    const perform = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce('tokenized');

    // Override the internal performRequest to avoid real IO during tests.
    // @ts-expect-error - accessing private member for test instrumentation
    transport.performRequest = perform;

    const promise = transport.request('tokenize', { text: 'hello' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('tokenized');

    expect(perform).toHaveBeenCalledTimes(2);
    await transport.close();
  });

  it('does not retry unsafe methods', async () => {
    const transport = createTransport();
    const failure = new Error('runtime mutation forbidden');
    (failure as NodeJS.ErrnoException).code = 'ECONNRESET';

    const perform = vi.fn().mockRejectedValue(failure);

    // @ts-expect-error - accessing private member for test instrumentation
    transport.performRequest = perform;

    const promise = transport.request('generate', { prompt: 'hi' });
    await expect(promise).rejects.toThrow('runtime mutation forbidden');
    expect(perform).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  it('converts open circuit failures into transport errors', async () => {
    vi.useRealTimers();
    const transport = createTransport();

    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 10000,
      halfOpenMaxCalls: 1,
      halfOpenSuccessThreshold: 1,
      failureWindowMs: 0,
    });

    // @ts-expect-error - accessing private member for test instrumentation
    transport.circuitBreaker = breaker;

    const failure = new Error('python runtime crashed');
    const perform = vi.fn().mockRejectedValue(failure);

    // @ts-expect-error - accessing private member for test instrumentation
    transport.performRequest = perform;

    await expect(
      transport.request('tokenize', { text: 'sample' })
    ).rejects.toThrow('python runtime crashed');

    await expect(
      transport.request('tokenize', { text: 'sample' })
    ).rejects.toMatchObject({
      name: 'EngineError',
      code: 'TransportError',
      message: expect.stringContaining('circuit open'),
      details: expect.objectContaining({
        method: 'tokenize',
      }),
    });

    expect(perform).toHaveBeenCalledTimes(1);
    await transport.close();
  });
});
