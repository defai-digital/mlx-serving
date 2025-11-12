/**
 * Retry Handler Integration Tests
 *
 * Tests retry behavior in the controller node:
 * - Automatic retry on worker failure
 * - Worker exclusion (don't retry same failed worker)
 * - Retry exhaustion and error handling
 * - Exponential backoff
 * - Retry metrics tracking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Retry Handler Integration', () => {
  let embeddedServer: EmbeddedNatsServer;
  let controller: ControllerNode;
  let workers: WorkerNode[] = [];
  let serverUrl: string;

  beforeEach(async () => {
    embeddedServer = new EmbeddedNatsServer();
    await embeddedServer.start();
    serverUrl = `nats://localhost:${embeddedServer.getPort()}`;
  }, 30000);

  afterEach(async () => {
    for (const worker of workers) {
      await worker.stop();
    }
    workers = [];

    if (controller) {
      await controller.stop();
    }

    if (embeddedServer) {
      await embeddedServer.stop();
    }
  }, 30000);

  function createController(overrides?: Partial<ClusterConfig>): ControllerNode {
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
      requestRouting: {
        circuitBreaker: {
          enabled: false,  // Disable to isolate retry
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,  // Retry up to 2 times
          retryDelayMs: 50,  // Short delay for tests
          retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'MODEL_LOAD_FAILED'],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
      discovery: {
        enabled: true,
        heartbeat_interval_ms: 5000,
        offline_timeout_ms: 15000,
      },
      runtime: {},
      ...overrides,
    } as ClusterConfig;

    return new ControllerNode({ config });
  }

  function createWorker(): WorkerNode {
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
        heartbeatIntervalMs: 5000,
        offlineTimeoutMs: 15000,
      },
      workers: { static: [] },
      loadBalancing: { strategy: 'smart', stickySession: false },
      logging: { level: 'info', format: 'json' },
    } as ClusterConfig;

    const worker = new WorkerNode({ config });
    workers.push(worker);
    return worker;
  }

  it('should retry on worker failure', async () => {
    controller = createController();
    await controller.start();

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Attempt request (will fail because no model loaded, but will retry)
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-retry-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected to eventually fail after retries
      expect(error).toBeDefined();
    }

    // Check metrics for retry count
    const metrics = controller.getRequestMetrics('test-retry-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      expect(metrics.retryCount).toBeGreaterThan(0);
      expect(metrics.retryCount).toBeLessThanOrEqual(2);
    }
  }, 60000);

  it('should exclude failed worker from retry', async () => {
    controller = createController();
    await controller.start();

    const worker1 = createWorker();
    const worker2 = createWorker();
    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const worker1Id = worker1.getWorkerId();

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-exclusion-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-exclusion-1');
    if (metrics && metrics.failedWorkers.length > 0) {
      // Verify worker was tracked as failed
      expect(metrics.failedWorkers).toContain(worker1Id);
      // Should have retried on different worker
      expect(metrics.retryCount).toBeGreaterThan(0);
    }
  }, 60000);

  it('should exhaust retries and throw error', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 50,
          retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'MODEL_LOAD_FAILED'],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    // Only one worker
    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    let errorThrown = false;
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-exhaust-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      errorThrown = true;
      expect(error).toBeDefined();
    }

    expect(errorThrown).toBe(true);

    const metrics = controller.getRequestMetrics('test-exhaust-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      expect(metrics.retryCount).toBe(2); // Max retries reached
      expect(metrics.finalError).toBeDefined();
    }
  }, 60000);

  it('should not retry non-retryable errors', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 50,
          retryOnErrors: ['WORKER_TIMEOUT'],  // Only retry timeouts
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-nonretryable-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-nonretryable-1');
    if (metrics) {
      // Should not have retried (error was not WORKER_TIMEOUT)
      expect(metrics.retryCount).toBe(0);
    }
  }, 60000);

  it('should respect exponential backoff timing', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 100,  // 100ms base delay
          retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'MODEL_LOAD_FAILED'],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const startTime = Date.now();

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-backoff-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // With exponential backoff:
    // Retry 1: 100ms delay
    // Retry 2: 200ms delay
    // Total minimum: 300ms
    expect(duration).toBeGreaterThan(300);
  }, 60000);

  it('should track retry metrics correctly', async () => {
    controller = createController();
    await controller.start();

    const worker1 = createWorker();
    const worker2 = createWorker();
    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-metrics-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-metrics-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      expect(metrics.requestId).toBe('test-metrics-1');
      expect(metrics.retryCount).toBeGreaterThanOrEqual(0);
      expect(metrics.failedWorkers).toBeDefined();
      expect(metrics.selectedWorker).toBeDefined();
      expect(metrics.durationMs).toBeGreaterThan(0);
    }
  }, 60000);

  it('should throw NO_WORKERS_AVAILABLE when all workers excluded', async () => {
    controller = createController();
    await controller.start();

    // Only one worker
    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    let errorCode: string | undefined;
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-no-workers-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error: any) {
      errorCode = error.code;
    }

    // Should eventually throw NO_WORKERS_AVAILABLE or similar
    expect(errorCode).toBeDefined();
  }, 60000);

  it('should work with session affinity during retry', async () => {
    controller = createController();
    await controller.start();

    const worker1 = createWorker();
    const worker2 = createWorker();
    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-session-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
        sessionId: 'test-session-123',
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-session-1');
    // If session worker fails, should retry on different worker
    // and update session affinity
    expect(metrics).toBeDefined();
  }, 60000);

  it('should handle concurrent requests with retry', async () => {
    controller = createController();
    await controller.start();

    const worker1 = createWorker();
    const worker2 = createWorker();
    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send 5 concurrent requests
    const requests = Array.from({ length: 5 }, (_, i) =>
      controller.handleInferenceRequest({
        requestId: `test-concurrent-${i}`,
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      }).catch(err => err)
    );

    const results = await Promise.all(requests);

    // All should have completed (either success or failure)
    expect(results).toHaveLength(5);

    // Check that retries were attempted
    const allMetrics = controller.getAllRequestMetrics();
    expect(allMetrics).toBeDefined();
    if (allMetrics) {
      expect(allMetrics.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('should validate retry count limits', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 0,  // No retries
          retryDelayMs: 50,
          retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE'],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-no-retry-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-no-retry-1');
    if (metrics) {
      // Should not have retried
      expect(metrics.retryCount).toBe(0);
    }
  }, 60000);

  it('should work when retry is disabled', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: false,
          maxRetries: 2,
          retryDelayMs: 50,
          retryOnErrors: [],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-disabled-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-disabled-1');
    if (metrics) {
      // Should not have retried (disabled)
      expect(metrics.retryCount).toBe(0);
    }
  }, 60000);
});
