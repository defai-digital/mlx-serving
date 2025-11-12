import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpsMultiplexer } from '../../../src/bridge/ops-multiplexer.js';
import type { MultiplexerDispatch } from '../../../src/bridge/ops-multiplexer.js';

describe('OpsMultiplexer', () => {
  let dispatchMock: ReturnType<typeof vi.fn<Parameters<MultiplexerDispatch>, ReturnType<MultiplexerDispatch>>>;
  let multiplexer: OpsMultiplexer;

  beforeEach(() => {
    vi.useFakeTimers();

    dispatchMock = vi.fn() as typeof dispatchMock;
    multiplexer = new OpsMultiplexer({
      dispatch: dispatchMock as MultiplexerDispatch,
      minHoldMs: 1,
      maxHoldMs: 4,
      minBatchSize: 2,
      maxBatchSize: 8,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('batches tokenize requests by model', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [
        { success: true, result: { tokens: [1] } },
        { success: true, result: { tokens: [2] } },
      ],
    });

    const promiseA = multiplexer.request('tokenize', {
      model_id: 'model-A',
      text: 'hello',
    });
    const promiseB = multiplexer.request('tokenize', {
      model_id: 'model-A',
      text: 'world',
    });

    await vi.advanceTimersByTimeAsync(2);

    await expect(promiseA).resolves.toEqual({ tokens: [1] });
    await expect(promiseB).resolves.toEqual({ tokens: [2] });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      'batch_tokenize',
      {
        requests: [
          { model_id: 'model-A', text: 'hello' },
          { model_id: 'model-A', text: 'world' },
        ],
      },
      undefined
    );

    const stats = multiplexer.getStats();
    expect(stats.batchesDispatched).toBe(1);
    expect(stats.batchedRequests).toBe(2);
  });

  it('flushes high priority requests immediately', async () => {
    dispatchMock.mockResolvedValueOnce({ tokens: [42] });

    const promise = multiplexer.request('tokenize', {
      model_id: 'model-B',
      text: 'fast',
    }, { priority: 'high' });

    await expect(promise).resolves.toEqual({ tokens: [42] });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      'tokenize',
      { model_id: 'model-B', text: 'fast' },
      expect.objectContaining({ priority: 'high' })
    );

    const stats = multiplexer.getStats();
    expect(stats.soloDispatches).toBe(1);
    expect(stats.batchedRequests).toBe(0);
  });

  it('falls back to solo when custom timeout provided', () => {
    const result = multiplexer.request('tokenize', { model_id: 'x', text: 'y' }, { timeout: 5 });
    expect(result).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();

    const stats = multiplexer.getStats();
    expect(stats.soloRequests).toBe(1);
  });
});
