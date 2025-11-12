/**
 * Worker Node Integration Tests
 *
 * Tests complete WorkerNode integration:
 * - Registration with controller via discovery
 * - Heartbeat mechanism
 * - Worker lifecycle (INIT → READY → STOPPED)
 * - State transitions
 * - Full system integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Worker Node Integration', () => {
  let embeddedServer: EmbeddedNatsServer;
  let controller: ControllerNode;
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

    // Cleanup controller
    if (controller) {
      await controller.stop();
    }

    // Stop NATS server
    if (embeddedServer) {
      await embeddedServer.stop();
    }
  }, 30000);

  /**
   * Helper to create controller
   */
  function createController(): ControllerNode {
    const config: ClusterConfig = {
      mode: 'controller',
      nats: {
        mode: 'external',
        serverUrl: serverUrl,
        reconnect: true,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
      },
      controller: {
        port: 8081,
      },
      discovery: {
        enabled: true,
        heartbeatIntervalMs: 1000, // Fast heartbeat for testing
        offlineTimeoutMs: 3000,
      },
      workers: { static: [] },
      loadBalancing: { strategy: 'smart', stickySession: false },
      logging: { level: 'info', format: 'json' },
    } as ClusterConfig;

    return new ControllerNode({ config });
  }

  /**
   * Helper to create worker
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
        modelDir: 'test-models',
      },
      discovery: {
        enabled: true,
        heartbeatIntervalMs: 1000, // Fast heartbeat for testing
        offlineTimeoutMs: 3000,
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

  it('should register worker with controller via discovery', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();

    // Wait for discovery registration
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Controller should have discovered the worker
    const discoveredWorkers = controller.getAllWorkers();
    expect(discoveredWorkers.length).toBeGreaterThan(0);

    // Worker should be in READY state
    expect(worker.getState()).toBe('ready');
  }, 60000);

  it('should send heartbeats to controller', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();

    // Wait for initial registration
    await new Promise(resolve => setTimeout(resolve, 1500));

    const workers1 = controller.getAllWorkers();
    expect(workers1.length).toBeGreaterThan(0);

    // Wait for multiple heartbeat intervals
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Worker should still be active (heartbeats sent)
    const workers2 = controller.getAllWorkers();
    expect(workers2.length).toBeGreaterThan(0);
  }, 60000);

  it('should transition through lifecycle states correctly', async () => {
    const worker = createWorker();

    // Initially should be in init or ready state (depends on implementation)
    const initialState = worker.getState();
    expect(['idle', 'init', 'ready', 'stopped']).toContain(initialState);

    // After start, should be READY
    await worker.start();
    expect(worker.getState()).toBe('ready');

    // After stop, should be STOPPED
    await worker.stop();
    expect(worker.getState()).toBe('stopped');
  }, 60000);

  it('should handle multiple workers registering simultaneously', async () => {
    controller = createController();
    await controller.start();

    // Create 3 workers
    const worker1 = createWorker();
    const worker2 = createWorker();
    const worker3 = createWorker();

    // Start all workers simultaneously
    await Promise.all([
      worker1.start(),
      worker2.start(),
      worker3.start(),
    ]);

    // Wait for discovery
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Controller should have discovered all workers
    const discoveredWorkers = controller.getAllWorkers();
    expect(discoveredWorkers.length).toBe(3);

    // All workers should be READY
    expect(worker1.getState()).toBe('ready');
    expect(worker2.getState()).toBe('ready');
    expect(worker3.getState()).toBe('ready');
  }, 60000);

  it('should handle worker graceful shutdown', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();

    // Wait for registration
    await new Promise(resolve => setTimeout(resolve, 2000));

    const workers1 = controller.getAllWorkers();
    expect(workers1.length).toBe(1);

    // Gracefully stop worker
    await worker.stop();
    expect(worker.getState()).toBe('stopped');

    // Wait for heartbeat timeout
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Controller should detect worker offline
    const workers2 = controller.getAllWorkers();
    expect(workers2.length).toBe(0);
  }, 60000);

  it('should integrate all worker subsystems', async () => {
    // Create worker with all features enabled
    const worker = createWorker({
      worker: {
        port: 8080,
        modelDir: 'test-models',
        resourceLimits: {
          enabled: true,
          softMemoryLimitGB: 8,
          hardMemoryLimitGB: 10,
          checkIntervalMs: 5000,
        },
        requestQueue: {
          enabled: true,
          maxDepth: 100,
          rejectWhenFull: true,
          priorityLevels: 3,
        },
        continuousBatching: {
          enabled: true,
          minBatchSize: 1,
          maxBatchSize: 32,
          batchTimeoutMs: 50,
          adaptiveTimeout: true,
        },
      },
    } as Partial<ClusterConfig>);

    await worker.start();

    // Worker should successfully start with all features
    expect(worker.getState()).toBe('ready');

    // Worker should have proper ID
    const workerId = worker.getWorkerId();
    expect(workerId).toBeDefined();
    expect(typeof workerId).toBe('string');
    expect(workerId.length).toBeGreaterThan(0);

    await worker.stop();
    expect(worker.getState()).toBe('stopped');
  }, 60000);

  it('should handle worker restart', async () => {
    const worker = createWorker();

    // First start
    await worker.start();
    expect(worker.getState()).toBe('ready');

    // Stop
    await worker.stop();
    expect(worker.getState()).toBe('stopped');

    // Restart - should work
    await worker.start();
    expect(worker.getState()).toBe('ready');

    // Final cleanup
    await worker.stop();
  }, 60000);

  it('should maintain unique worker IDs', async () => {
    const worker1 = createWorker();
    const worker2 = createWorker();
    const worker3 = createWorker();

    await Promise.all([
      worker1.start(),
      worker2.start(),
      worker3.start(),
    ]);

    const id1 = worker1.getWorkerId();
    const id2 = worker2.getWorkerId();
    const id3 = worker3.getWorkerId();

    // All IDs should be unique
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);

    // All should be valid strings
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
    expect(typeof id3).toBe('string');
  }, 60000);

  it('should handle discovery with static worker configuration', async () => {
    // Create worker first to get its address
    const worker = createWorker();
    await worker.start();

    const workerId = worker.getWorkerId();

    // Create controller with static worker configuration
    const staticController = new ControllerNode({
      config: {
        mode: 'controller',
        nats: {
          mode: 'external',
          serverUrl: serverUrl,
          reconnect: true,
          maxReconnectAttempts: 10,
          reconnectTimeWait: 2000,
        },
        controller: {
          port: 8082,
        },
        discovery: {
          enabled: true,
          heartbeatIntervalMs: 1000,
          offlineTimeoutMs: 3000,
        },
        workers: {
          static: [
            {
              workerId: workerId,
              url: `http://localhost:${8080}`,
            },
          ],
        },
        loadBalancing: { strategy: 'smart', stickySession: false },
        logging: { level: 'info', format: 'json' },
      } as ClusterConfig,
    });

    await staticController.start();

    // Wait for registration
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Controller should have the static worker
    const discoveredWorkers = staticController.getAllWorkers();
    expect(discoveredWorkers.length).toBeGreaterThan(0);

    // Cleanup
    await staticController.stop();
  }, 60000);
});
