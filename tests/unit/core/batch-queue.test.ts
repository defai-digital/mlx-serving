import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchQueue } from '../../../src/core/batch-queue.js';
import type { JsonRpcTransport } from '../../../src/bridge/jsonrpc-transport.js';

describe('BatchQueue', () => {
  let mockTransport: Partial<JsonRpcTransport>;
  let batchQueue: BatchQueue;

  beforeEach(() => {
    vi.useFakeTimers();

    mockTransport = {
      request: vi.fn() as unknown as JsonRpcTransport['request'],
    };

    batchQueue = new BatchQueue(mockTransport as JsonRpcTransport, {
      maxBatchSize: 3,
      flushIntervalMs: 10,
      enabled: true,
    });
  });

  afterEach(() => {
    batchQueue.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Tokenize Batching', () => {
    it('batches multiple tokenize requests', async () => {
      // Phase 1: Mock batch_tokenize endpoint
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { tokens: [1, 2, 3] }, error: null },
            { success: true, result: { tokens: [4, 5, 6] }, error: null },
          ]
        });

      const promise1 = batchQueue.tokenize({
        model_id: 'test-model',
        text: 'Hello',
      });
      const promise2 = batchQueue.tokenize({
        model_id: 'test-model',
        text: 'World',
      });

      await vi.advanceTimersByTimeAsync(10);

      const results = await Promise.all([promise1, promise2]);

      // Phase 1: Expect single batch_tokenize call instead of 2 individual calls
      expect(mockTransport.request).toHaveBeenCalledTimes(1);
      expect(mockTransport.request).toHaveBeenCalledWith(
        'batch_tokenize',
        {
          requests: [
            { model_id: 'test-model', text: 'Hello' },
            { model_id: 'test-model', text: 'World' },
          ]
        }
      );

      expect(results[0]).toEqual({ tokens: [1, 2, 3] });
      expect(results[1]).toEqual({ tokens: [4, 5, 6] });
    });

    it('flushes immediately when maxBatchSize reached', async () => {
      // Phase 1: Mock batch_tokenize with 3 requests
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { tokens: [1] }, error: null },
            { success: true, result: { tokens: [2] }, error: null },
            { success: true, result: { tokens: [3] }, error: null },
          ]
        });

      const promise1 = batchQueue.tokenize({ model_id: 'test', text: 'A' });
      const promise2 = batchQueue.tokenize({ model_id: 'test', text: 'B' });
      const promise3 = batchQueue.tokenize({ model_id: 'test', text: 'C' });

      await Promise.all([promise1, promise2, promise3]);

      // Phase 1: Expect single batch_tokenize call with 3 requests
      expect(mockTransport.request).toHaveBeenCalledTimes(1);
      expect(mockTransport.request).toHaveBeenCalledWith(
        'batch_tokenize',
        {
          requests: [
            { model_id: 'test', text: 'A' },
            { model_id: 'test', text: 'B' },
            { model_id: 'test', text: 'C' },
          ]
        }
      );
    });

    it('isolates errors across tokenize requests', async () => {
      // Phase 1: Mock batch_tokenize with mixed success/failure
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { tokens: [1, 2, 3] }, error: null },
            { success: false, result: null, error: 'Tokenization failed' },
          ]
        });

      const promise1 = batchQueue.tokenize({
        model_id: 'test-model',
        text: 'Hello',
      });
      const promise2 = batchQueue.tokenize({
        model_id: 'test-model',
        text: 'Bad',
      });

      const successExpectation = expect(promise1).resolves.toEqual({ tokens: [1, 2, 3] });
      const failureExpectation = expect(promise2).rejects.toThrow('Tokenization failed');

      await vi.advanceTimersByTimeAsync(10);

      await successExpectation;
      await failureExpectation;
    });

    it('rejects all requests on transport error', async () => {
      // Phase 1: Mock transport-level error
      (mockTransport.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Transport error')
      );

      const promise1 = batchQueue.tokenize({
        model_id: 'test',
        text: 'Hello',
      });
      const promise2 = batchQueue.tokenize({
        model_id: 'test',
        text: 'World',
      });

      const rejection1 = expect(promise1).rejects.toThrow('Transport error');
      const rejection2 = expect(promise2).rejects.toThrow('Transport error');

      await vi.advanceTimersByTimeAsync(10);

      await rejection1;
      await rejection2;
    });
  });

  describe('Check Draft Batching', () => {
    it('batches multiple check draft requests', async () => {
      // Phase 1: Mock batch_check_draft endpoint
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { compatible: true }, error: null },
            { success: true, result: { compatible: false, reasons: ['mismatch'] }, error: null },
          ]
        });

      const promise1 = batchQueue.checkDraft({
        primary_id: 'model-1',
        draft_id: 'draft-1',
      });
      const promise2 = batchQueue.checkDraft({
        primary_id: 'model-2',
        draft_id: 'draft-2',
      });

      await vi.advanceTimersByTimeAsync(10);

      const results = await Promise.all([promise1, promise2]);

      // Phase 1: Expect single batch_check_draft call
      expect(mockTransport.request).toHaveBeenCalledTimes(1);
      expect(mockTransport.request).toHaveBeenCalledWith(
        'batch_check_draft',
        {
          requests: [
            { primary_id: 'model-1', draft_id: 'draft-1' },
            { primary_id: 'model-2', draft_id: 'draft-2' },
          ]
        }
      );

      expect(results[0]).toEqual({ compatible: true });
      expect(results[1]).toEqual({ compatible: false, reasons: ['mismatch'] });
    });
  });

  describe('Fallback Mode', () => {
    it('falls back to direct requests when batching disabled', async () => {
      const noBatchQueue = new BatchQueue(mockTransport as JsonRpcTransport, {
        enabled: false,
      });

      (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        tokens: [1, 2, 3],
      });

      const result = await noBatchQueue.tokenize({
        model_id: 'test',
        text: 'Hello',
      });

      // Should call tokenize directly, not batch_tokenize
      expect(mockTransport.request).toHaveBeenCalledWith('tokenize', {
        model_id: 'test',
        text: 'Hello',
      });

      expect(result).toEqual({ tokens: [1, 2, 3] });

      noBatchQueue.cleanup();
    });
  });

  describe('Statistics', () => {
    it('tracks batching statistics', async () => {
      // Phase 1: Mock batch_tokenize with 2 requests
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { tokens: [1] }, error: null },
            { success: true, result: { tokens: [2] }, error: null },
          ]
        });

      // Queue 2 requests
      const promise1 = batchQueue.tokenize({ model_id: 'test', text: 'A' });
      const promise2 = batchQueue.tokenize({ model_id: 'test', text: 'B' });

      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([promise1, promise2]);

      const stats = batchQueue.getStats();

      expect(stats.tokenizeBatches).toBe(1);
      expect(stats.tokenizeRequests).toBe(2);
      expect(stats.tokenizeEfficiency).toBe(2); // 2 requests / 1 batch
      expect(stats.tokenizeQueueSize).toBe(0);
    });

    it('can reset statistics', () => {
      batchQueue.resetStats();

      const stats = batchQueue.getStats();

      expect(stats.tokenizeBatches).toBe(0);
      expect(stats.tokenizeRequests).toBe(0);
    });
  });

  describe('Flush Method', () => {
    it('manually flushes all queues', async () => {
      // Phase 1: Mock both batch endpoints
      (mockTransport.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { tokens: [1] }, error: null },
          ]
        })
        .mockResolvedValueOnce({
          results: [
            { success: true, result: { compatible: true }, error: null },
          ]
        });

      // Queue requests without waiting
      const tokenizePromise = batchQueue.tokenize({
        model_id: 'test',
        text: 'Hello',
      });
      const draftPromise = batchQueue.checkDraft({
        primary_id: 'model',
        draft_id: 'draft',
      });

      // Manually flush
      await batchQueue.flush();

      await Promise.all([tokenizePromise, draftPromise]);

      // Phase 1: Expect batch_tokenize and batch_check_draft calls
      expect(mockTransport.request).toHaveBeenCalledTimes(2);
      expect(mockTransport.request).toHaveBeenNthCalledWith(
        1,
        'batch_tokenize',
        { requests: [{ model_id: 'test', text: 'Hello' }] }
      );
      expect(mockTransport.request).toHaveBeenNthCalledWith(
        2,
        'batch_check_draft',
        { requests: [{ primary_id: 'model', draft_id: 'draft' }] }
      );
    });
  });

  describe('Cleanup', () => {
    it('clears timers on cleanup', () => {
      // Queue a request to schedule a timer
      batchQueue.tokenize({ model_id: 'test', text: 'Hello' });

      // Cleanup should clear the timer
      batchQueue.cleanup();

      // Timer should be cleared (no more scheduled)
      const timers = vi.getTimerCount();
      expect(timers).toBe(0);
    });
  });
});
