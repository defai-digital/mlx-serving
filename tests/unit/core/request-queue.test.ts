import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestQueue } from '../../../src/core/request-queue.js';

describe('RequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Execution', () => {
    it('executes a single request immediately', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const executor = vi.fn(async () => 'result');

      const promise = queue.execute(executor);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('result');
      expect(executor).toHaveBeenCalledOnce();
    });

    it('returns executor result', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const result = await queue.execute(async () => ({ data: 'test' }));

      expect(result).toEqual({ data: 'test' });
    });

    it('propagates executor errors', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const error = new Error('Test error');

      await expect(
        queue.execute(async () => {
          throw error;
        })
      ).rejects.toThrow('Test error');
    });
  });

  describe('Concurrency Control', () => {
    it('enforces max concurrent limit', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const activeCount: number[] = [];
      let currentActive = 0;

      const createExecutor = (delay: number) => async () => {
        currentActive++;
        activeCount.push(currentActive);
        await new Promise((resolve) => setTimeout(resolve, delay));
        currentActive--;
      };

      // Start 5 requests with max 2 concurrent
      const promises = [
        queue.execute(createExecutor(100)),
        queue.execute(createExecutor(100)),
        queue.execute(createExecutor(100)),
        queue.execute(createExecutor(100)),
        queue.execute(createExecutor(100)),
      ];

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      // Should never exceed max concurrent (2)
      expect(Math.max(...activeCount)).toBeLessThanOrEqual(2);
    });

    it('processes queued requests after completion', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const executionOrder: number[] = [];

      const createExecutor = (id: number) => async () => {
        executionOrder.push(id);
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      // Start 3 requests with max 1 concurrent
      const promises = [
        queue.execute(createExecutor(1)),
        queue.execute(createExecutor(2)),
        queue.execute(createExecutor(3)),
      ];

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      // Should execute in FIFO order
      expect(executionOrder).toEqual([1, 2, 3]);
    });
  });

  describe('FIFO Ordering', () => {
    it('maintains FIFO fairness', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const completionOrder: string[] = [];

      const createExecutor = (id: string) => async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completionOrder.push(id);
      };

      // Enqueue requests
      const promises = [
        queue.execute(createExecutor('A')),
        queue.execute(createExecutor('B')),
        queue.execute(createExecutor('C')),
        queue.execute(createExecutor('D')),
      ];

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      expect(completionOrder).toEqual(['A', 'B', 'C', 'D']);
    });
  });

  describe('Timeout Handling', () => {
    it('times out requests after timeout period', async () => {
      const queue = new RequestQueue({
        maxConcurrent: 1,
        requestTimeoutMs: 1000,
      });

      const slowExecutor = async (): Promise<string> => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return 'done';
      };

      const promise = queue.execute(slowExecutor);
      // Attach error handler immediately to prevent unhandled rejection warning
      void promise.catch(() => {});

      // Advance time past timeout
      await vi.advanceTimersByTimeAsync(1500);

      await expect(promise).rejects.toThrow(/timed out/);
    });

    it('clears timeout on successful completion', async () => {
      const queue = new RequestQueue({
        maxConcurrent: 1,
        requestTimeoutMs: 1000,
      });

      const executor = async (): Promise<string> => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'done';
      };

      const promise = queue.execute(executor);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('done');
    });
  });

  describe('Cancellation', () => {
    it('rejects cancelled pending requests', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });

      // Block queue with long-running request
      const blocker = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      // Enqueue request that will be pending
      const pendingPromise = queue.execute(async () => 'result');
      // Attach error handler immediately to prevent unhandled rejection warning
      void pendingPromise.catch(() => {});

      // Cancel by getting stats and finding pending request
      const stats = queue.getStats();
      expect(stats.pending).toBe(1);

      // Cancel pending request
      queue.clearPending();

      await expect(pendingPromise).rejects.toThrow('cancelled');

      // Complete blocker
      await vi.runAllTimersAsync();
      await blocker;
    });

    it('processes next request after cancellation', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const executionOrder: number[] = [];

      // Block queue
      const blocker = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      // Enqueue 2 requests
      const firstPending = queue.execute(async () => {
        executionOrder.push(1);
      });
      const secondPending = queue.execute(async () => {
        executionOrder.push(2);
      });
      // Attach error handlers immediately to prevent unhandled rejection warnings
      void firstPending.catch(() => {});
      void secondPending.catch(() => {});

      // Clear pending (cancels both)
      queue.clearPending();

      // Complete blocker
      await vi.runAllTimersAsync();
      await blocker;

      // Both pending requests should be cancelled
      await expect(firstPending).rejects.toThrow('cancelled');
      await expect(secondPending).rejects.toThrow('cancelled');

      // Nothing should have executed
      expect(executionOrder.length).toBe(0);

      // But new requests should still work
      const newPromise = queue.execute(async () => {
        executionOrder.push(3);
      });
      await vi.runAllTimersAsync();
      await newPromise;

      expect(executionOrder).toEqual([3]);
    });
  });

  describe('Drain Functionality', () => {
    it('waits for all active and pending requests', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const completionOrder: number[] = [];

      const createExecutor = (id: number, delay: number) => async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        completionOrder.push(id);
      };

      // Start multiple requests
      queue.execute(createExecutor(1, 100));
      queue.execute(createExecutor(2, 200));
      queue.execute(createExecutor(3, 150));

      // Drain should wait for all
      const drainPromise = queue.drain();

      await vi.runAllTimersAsync();
      await drainPromise;

      expect(completionOrder).toHaveLength(3);
      expect(queue.isEmpty()).toBe(true);
    });

    it('returns immediately if queue is empty', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });

      const startTime = Date.now();
      await queue.drain();
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('reports accurate queue statistics', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });

      // Initially empty
      expect(queue.getStats()).toEqual({
        pending: 0,
        active: 0,
        queued: 0,
        maxConcurrent: 2,
      });

      // Block queue with 2 active requests
      const blocker1 = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 1000))
      );
      const blocker2 = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      // Add 3 pending requests
      const pending1 = queue.execute(async () => 'result');
      const pending2 = queue.execute(async () => 'result');
      const pending3 = queue.execute(async () => 'result');

      // Should have 2 active, 3 pending
      const stats = queue.getStats();
      expect(stats.active).toBe(2);
      expect(stats.pending).toBe(3);
      expect(stats.queued).toBe(3);
      expect(stats.maxConcurrent).toBe(2);

      // Complete all
      await vi.runAllTimersAsync();
      await Promise.all([blocker1, blocker2, pending1, pending2, pending3]);

      // Should be empty
      expect(queue.getStats()).toEqual({
        pending: 0,
        active: 0,
        queued: 0,
        maxConcurrent: 2,
      });
    });

    it('isEmpty returns correct status', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });

      expect(queue.isEmpty()).toBe(true);

      const promise = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      expect(queue.isEmpty()).toBe(false);

      await vi.runAllTimersAsync();
      await promise;

      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('processes next request after error', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const executionOrder: number[] = [];

      // First request throws error
      const errorPromise = queue.execute(async () => {
        executionOrder.push(1);
        throw new Error('Test error');
      });
      // Attach error handler immediately to prevent unhandled rejection warning
      void errorPromise.catch(() => {});

      // Second request should still execute
      const successPromise = queue.execute(async () => {
        executionOrder.push(2);
        return 'success';
      });

      await vi.runAllTimersAsync();

      await expect(errorPromise).rejects.toThrow('Test error');
      await expect(successPromise).resolves.toBe('success');

      expect(executionOrder).toEqual([1, 2]);
    });
  });

  describe('maxConcurrent Validation (Bug #71)', () => {
    it('throws error for non-integer maxConcurrent', () => {
      expect(() => new RequestQueue({ maxConcurrent: 3.5 })).toThrow(
        'RequestQueue: maxConcurrent must be an integer, got 3.5'
      );

      expect(() => new RequestQueue({ maxConcurrent: 2.1 })).toThrow(
        'RequestQueue: maxConcurrent must be an integer, got 2.1'
      );

      expect(() => new RequestQueue({ maxConcurrent: Number.NaN })).toThrow(
        'RequestQueue: maxConcurrent must be an integer, got NaN'
      );
    });

    it('converts 0 to unlimited concurrency (infinity)', async () => {
      const queue = new RequestQueue({ maxConcurrent: 0 });
      const stats = queue.getStats();

      expect(stats.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
    });

    it('converts negative values to unlimited concurrency (infinity)', async () => {
      const queue1 = new RequestQueue({ maxConcurrent: -1 });
      expect(queue1.getStats().maxConcurrent).toBe(Number.POSITIVE_INFINITY);

      const queue2 = new RequestQueue({ maxConcurrent: -100 });
      expect(queue2.getStats().maxConcurrent).toBe(Number.POSITIVE_INFINITY);
    });

    it('uses positive integers as-is for strict limits', async () => {
      const queue1 = new RequestQueue({ maxConcurrent: 1 });
      expect(queue1.getStats().maxConcurrent).toBe(1);

      const queue2 = new RequestQueue({ maxConcurrent: 5 });
      expect(queue2.getStats().maxConcurrent).toBe(5);

      const queue3 = new RequestQueue({ maxConcurrent: 100 });
      expect(queue3.getStats().maxConcurrent).toBe(100);
    });

    it('allows unlimited concurrency when maxConcurrent is 0', async () => {
      const queue = new RequestQueue({ maxConcurrent: 0 });
      const executionOrder: number[] = [];
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const createExecutor = (id: number) => async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push(id);
        currentConcurrent--;
      };

      // Start 10 requests with unlimited concurrency
      const promises = Array.from({ length: 10 }, (_, i) =>
        queue.execute(createExecutor(i + 1))
      );

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      // All should execute concurrently (no limit)
      expect(maxConcurrent).toBe(10);
      expect(executionOrder).toHaveLength(10);
    });
  });

  describe('clearPending', () => {
    it('clears all pending requests', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });

      // Block queue
      const blocker = queue.execute(
        async () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      // Add pending requests
      const pending1 = queue.execute(async () => 'result1');
      const pending2 = queue.execute(async () => 'result2');
      const pending3 = queue.execute(async () => 'result3');
      // Attach error handlers immediately to prevent unhandled rejection warnings
      void pending1.catch(() => {});
      void pending2.catch(() => {});
      void pending3.catch(() => {});

      expect(queue.getStats().pending).toBe(3);

      // Clear all pending
      queue.clearPending();

      expect(queue.getStats().pending).toBe(0);

      await expect(pending1).rejects.toThrow('cancelled');
      await expect(pending2).rejects.toThrow('cancelled');
      await expect(pending3).rejects.toThrow('cancelled');

      // Complete blocker
      await vi.runAllTimersAsync();
      await blocker;
    });

    it('does not affect active requests', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const results: string[] = [];

      // Start 2 active requests
      const active1 = queue.execute(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        results.push('active1');
        return 'active1';
      });

      const active2 = queue.execute(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        results.push('active2');
        return 'active2';
      });

      // Add pending request
      const pending = queue.execute(async () => 'pending');
      // Attach error handler immediately to prevent unhandled rejection warning
      void pending.catch(() => {});

      // Clear pending (should not affect active)
      queue.clearPending();

      await vi.runAllTimersAsync();

      await expect(active1).resolves.toBe('active1');
      await expect(active2).resolves.toBe('active2');
      await expect(pending).rejects.toThrow('cancelled');

      expect(results).toEqual(['active1', 'active2']);
    });
  });
});
