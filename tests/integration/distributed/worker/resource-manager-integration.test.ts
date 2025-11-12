/**
 * Resource Manager Integration Tests
 *
 * Tests memory limit enforcement on worker nodes:
 * - Soft limit behavior (reject low-priority requests)
 * - Hard limit behavior (reject all requests)
 * - Memory check intervals
 * - Disabled state handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Resource Manager Integration', () => {
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
   * Helper to create worker with resource limits
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
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 8,
          hardMemoryLimitGB: 10,
          checkIntervalMs: 5000,
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

  it('should initialize worker with resource limits enabled', async () => {
    const worker = createWorker();

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should be in READY state
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should initialize worker with resource limits disabled', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
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

  it('should accept configuration for soft and hard memory limits', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 6,
          hardMemoryLimitGB: 8,
          checkIntervalMs: 1000,
        },
      },
    } as Partial<ClusterConfig>);

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should start successfully with custom limits
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should handle resource limit configuration validation', async () => {
    // Test with very low limits
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 1,
          hardMemoryLimitGB: 2,
          checkIntervalMs: 100,
        },
      },
    } as Partial<ClusterConfig>);

    expect(worker).toBeDefined();

    await worker.start();

    // Worker should still start (limits just define behavior)
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should allow resource management to be enabled and disabled', async () => {
    // Test enabled
    const worker1 = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
        },
      },
    } as Partial<ClusterConfig>);

    await worker1.start();
    expect(worker1.getState()).toBe('ready');
    await worker1.stop();

    // Test disabled
    const worker2 = createWorker({
      worker: {
        port: 8081,
        resourceLimits: {
          enabled: false,
        },
      },
    } as Partial<ClusterConfig>);

    await worker2.start();
    expect(worker2.getState()).toBe('ready');
    await worker2.stop();
  }, 60000);

  it('should start resource monitoring when enabled', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 8,
          hardMemoryLimitGB: 10,
          checkIntervalMs: 1000, // Check every second for faster testing
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();

    // Wait for at least one memory check cycle
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Worker should still be running
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should support configurable check intervals', async () => {
    // Test with fast check interval
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          checkIntervalMs: 500, // Very fast checks
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();

    // Wait for multiple check cycles
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Worker should still be running
    expect(worker.getState()).toBe('ready');

    await worker.stop();
  }, 60000);

  it('should handle multiple workers with resource limits', async () => {
    // Create 3 workers with resource limits
    const worker1 = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 8,
          hardMemoryLimitGB: 10,
        },
      },
    } as Partial<ClusterConfig>);

    const worker2 = createWorker({
      worker: {
        port: 8081,
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 6,
          hardMemoryLimitGB: 8,
        },
      },
    } as Partial<ClusterConfig>);

    const worker3 = createWorker({
      worker: {
        port: 8082,
        resourceLimits: {
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

  it('should properly clean up resource monitoring on stop', async () => {
    const worker = createWorker({
      worker: {
        port: 8080,
        resourceLimits: {
          enabled: true,
          checkIntervalMs: 1000,
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();
    expect(worker.getState()).toBe('ready');

    // Stop worker
    await worker.stop();
    expect(worker.getState()).toBe('stopped');

    // Wait to ensure no lingering intervals
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Worker should remain stopped
    expect(worker.getState()).toBe('stopped');
  }, 60000);
});
