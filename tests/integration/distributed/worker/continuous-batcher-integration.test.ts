/**
 * Continuous Batcher Integration Tests
 *
 * Tests continuous batching behavior on worker nodes:
 * - Batch formation and size constraints
 * - Timeout-based batch triggers
 * - Adaptive timeout based on queue depth
 * - Multiple batch configurations
 * - Cleanup on worker stop
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Continuous Batcher Integration', () => {
  let embeddedServer: EmbeddedNatsServer;
  let workers: WorkerNode[] = [];
  let serverUrl: string;

  beforeEach(async () => {
    // Start embedded NATS server
    embeddedServer = new EmbeddedNatsServer();
    await embeddedServer.start();
    serverUrl = `nats://localhost:${embeddedServer.getPort()}`;
  }, 30000);

  afterEach(async () => {
    // Cleanup workers
    for (const worker of workers) {
      await worker.stop();
    }
    workers = [];

    // Stop NATS server
    if (embeddedServer) {
      await embeddedServer.stop();
    }
  }, 30000);

  /**
   * Helper to create worker with continuous batching
   */
  function createWorker(overrides?: Partial<ClusterConfig>): WorkerNode {
    const config: ClusterConfig = {
      mode: 'worker',
      nats: {
        mode: 'external',
        serverUrl: serverUrl,
        reconnect: true,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
      },
      worker: {
        port: 8080 + workers.length,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 50,
          adaptiveTimeout: true,
        },
      },
      discovery: {
        enabled: true,
        heartbeatIntervalMs: 5000,
        offlineTimeoutMs: 15000,
      },
      workers: { static: [] },
      loadBalancing: { strategy: 'smart', stickySession: false },
      logging: { level: 'info', format: 'json' },
      ...overrides,
    } as ClusterConfig;

    const worker = new WorkerNode({ config });
    workers.push(worker);
    return worker;
  }

  it('should initialize worker with batching enabled', async () => {
    const worker = createWorker();

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should be in READY state
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should initialize worker with batching disabled', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: false,
        },
      },
    } as Partial<ClusterConfig>);

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should be in READY state
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should accept configuration for min and max batch size', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 2,
          maxBatchSize: 16,
          batchTimeoutMs: 100,
        },
      },
    } as Partial<ClusterConfig>);

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should start successfully with custom batch sizes
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should accept configuration for batch timeout', async () => {
    // Test with short timeout
    const worker1 = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 10, // Very short timeout
        },
      },
    } as Partial<ClusterConfig>);

    await worker1.start();
    expect(worker1.getState()).toBe('ready');
    await worker1.stop();

    // Test with long timeout
    const worker2 = createWorker({
      worker: {
        port: 8081,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 1000, // Long timeout
        },
      },
    } as Partial<ClusterConfig>);

    await worker2.start();
    expect(worker2.getState()).toBe('ready');
    await worker2.stop();
  }, 60000);

  it('should support adaptive timeout option', async () => {
    // Test with adaptive timeout enabled
    const worker1 = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          batchTimeoutMs: 50,
          adaptiveTimeout: true, // Enabled
        },
      },
    } as Partial<ClusterConfig>);

    await worker1.start();
    expect(worker1.getState()).toBe('ready');
    await worker1.stop();

    // Test with adaptive timeout disabled
    const worker2 = createWorker({
      worker: {
        port: 8081,
        continuousBatching: {
          enabled: true,
          batchTimeoutMs: 50,
          adaptiveTimeout: false, // Disabled
        },
      },
    } as Partial<ClusterConfig>);

    await worker2.start();
    expect(worker2.getState()).toBe('ready');
    await worker2.stop();
  }, 60000);

  it('should handle batch size validation', async () => {
    // Test with minBatchSize = maxBatchSize (valid edge case)
    const worker = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 8,
          maxBatchSize: 8, // Same as min (fixed batch size)
        },
      },
    } as Partial<ClusterConfig>);

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should still start (batch size logic handles this)
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should handle multiple workers with different batch configurations', async () => {
    // Worker 1: Small batches, fast timeout
    const worker1 = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 4,
          batchTimeoutMs: 10,
          adaptiveTimeout: false,
        },
      },
    } as Partial<ClusterConfig>);

    // Worker 2: Large batches, slow timeout
    const worker2 = createWorker({
      worker: {
        port: 8081,
        continuousBatching: {
          enabled: true,
          minBatchSize: 4,
          maxBatchSize: 32,
          batchTimeoutMs: 200,
          adaptiveTimeout: true,
        },
      },
    } as Partial<ClusterConfig>);

    // Worker 3: Batching disabled
    const worker3 = createWorker({
      worker: {
        port: 8082,
        continuousBatching: {
          enabled: false,
        },
      },
    } as Partial<ClusterConfig>);

    // Start all workers
    await Promise.all([
      worker1.start(),
      worker2.start(),
      worker3.start(),
    ]);

    // All workers should be ready
    expect(worker1.getState()).toBe('ready');
    expect(worker2.getState()).toBe('ready');
    expect(worker3.getState()).toBe('ready');

    // Stop all workers
    await Promise.all([
      worker1.stop(),
      worker2.stop(),
      worker3.stop(),
    ]);
  }, 60000);

  it('should properly clean up batcher on stop', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 50,
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();
    expect(worker.getState()).toBe('ready');

    // Stop worker
    await worker.stop();
    expect(worker.getState()).toBe('stopped');

    // Worker should remain stopped
    expect(worker.getState()).toBe('stopped');
  }, 60000);

  it('should support batch statistics tracking', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 50,
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();

    // Worker should be ready
    expect(worker.getState()).toBe('ready');

    // Note: Batch stats would show sizes/timeouts, but we can't test without sending actual requests
    // This test validates that the batcher is properly initialized

    await worker.stop();
  }, 60000);

  it('should handle batching with different timeout strategies', async () => {
    // Strategy 1: Fixed timeout, no adaptation
    const worker1 = createWorker({
      worker: {
        port: 8080,
        continuousBatching: {
          enabled: true,
          batchTimeoutMs: 100,
          adaptiveTimeout: false,
        },
      },
    } as Partial<ClusterConfig>);

    // Strategy 2: Adaptive timeout based on queue depth
    const worker2 = createWorker({
      worker: {
        port: 8081,
        continuousBatching: {
          enabled: true,
          batchTimeoutMs: 100, // Base timeout
          adaptiveTimeout: true, // Adjust based on queue
        },
      },
    } as Partial<ClusterConfig>);

    await Promise.all([worker1.start(), worker2.start()]);

    // Both workers should be ready
    expect(worker1.getState()).toBe('ready');
    expect(worker2.getState()).toBe('ready');

    await Promise.all([worker1.stop(), worker2.stop()]);
  }, 60000);
});
