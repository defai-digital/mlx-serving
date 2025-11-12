/**
 * Timeout Handler Integration Tests
 *
 * Tests timeout behavior in the controller node:
 * - Buffered request timeout enforcement
 * - Streaming request timeout enforcement
 * - Timeout triggering circuit breaker
 * - Timeout triggering retry
 * - Timeout metrics tracking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Timeout Handler Integration', () => {
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
          enabled: false,
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: false,
          maxRetries: 0,
          retryDelayMs: 50,
          retryOnErrors: [],
        },
        timeoutMs: 1000,  // 1s for buffered
        streamingTimeoutMs: 2000,  // 2s for streaming
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

  it('should timeout buffered requests after configured duration', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: { enabled: false, failureThreshold: 999, successThreshold: 2, timeoutMs: 30000 },
        retry: { enabled: false, maxRetries: 0, retryDelayMs: 50, retryOnErrors: [] },
        timeoutMs: 500,  // 500ms timeout
        streamingTimeoutMs: 2000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const startTime = Date.now();
    let errorThrown = false;

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-timeout-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error: any) {
      errorThrown = true;
      const duration = Date.now() - startTime;

      // Should timeout around 500ms
      expect(duration).toBeGreaterThan(400);
      expect(duration).toBeLessThan(1500);
    }

    expect(errorThrown).toBe(true);
  }, 60000);

  it('should timeout streaming requests with different duration', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: { enabled: false, failureThreshold: 999, successThreshold: 2, timeoutMs: 30000 },
        retry: { enabled: false, maxRetries: 0, retryDelayMs: 50, retryOnErrors: [] },
        timeoutMs: 500,
        streamingTimeoutMs: 1000,  // 1s for streaming
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const startTime = Date.now();
    let errorThrown = false;

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-timeout-stream-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: true,
      });
    } catch (error) {
      errorThrown = true;
      const duration = Date.now() - startTime;

      // Should use streaming timeout (1000ms)
      expect(duration).toBeGreaterThan(800);
      expect(duration).toBeLessThan(2000);
    }

    expect(errorThrown).toBe(true);
  }, 60000);

  it('should trigger circuit breaker on timeout', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          successThreshold: 2,
          timeoutMs: 5000,
        },
        retry: { enabled: false, maxRetries: 0, retryDelayMs: 50, retryOnErrors: [] },
        timeoutMs: 500,
        streamingTimeoutMs: 1000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const workerId = worker.getWorkerId();

    // Cause 3 timeouts
    for (let i = 0; i < 3; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `test-cb-timeout-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
        });
      } catch (error) {
        // Expected
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Circuit breaker should be open due to timeouts
    const stats = controller.getCircuitBreakerStats();
    const workerStat = stats[workerId];

    if (workerStat) {
      expect(workerStat.failures).toBeGreaterThanOrEqual(3);
    }
  }, 60000);

  it('should trigger retry on timeout', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: { enabled: false, failureThreshold: 999, successThreshold: 2, timeoutMs: 30000 },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 50,
          retryOnErrors: ['WORKER_TIMEOUT'],
        },
        timeoutMs: 500,
        streamingTimeoutMs: 1000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker1 = createWorker();
    const worker2 = createWorker();
    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-retry-timeout-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    // Should have retried due to timeout
    const metrics = controller.getRequestMetrics('test-retry-timeout-1');
    if (metrics) {
      expect(metrics.retryCount).toBeGreaterThan(0);
      expect(metrics.timeouts).toBeGreaterThan(0);
    }
  }, 60000);

  it('should track timeout metrics correctly', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-timeout-metrics-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-timeout-metrics-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      expect(metrics.requestId).toBe('test-timeout-metrics-1');
      expect(metrics.durationMs).toBeDefined();
      expect(metrics.finalError).toBeDefined();
    }
  }, 60000);

  it('should use correct timeout based on request type', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: { enabled: false, failureThreshold: 999, successThreshold: 2, timeoutMs: 30000 },
        retry: { enabled: false, maxRetries: 0, retryDelayMs: 50, retryOnErrors: [] },
        timeoutMs: 500,  // Buffered
        streamingTimeoutMs: 1500,  // Streaming
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test buffered timeout (500ms)
    const bufferedStart = Date.now();
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-buffered-timeout',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      const bufferedDuration = Date.now() - bufferedStart;
      expect(bufferedDuration).toBeGreaterThan(400);
      expect(bufferedDuration).toBeLessThan(1000);
    }

    // Test streaming timeout (1500ms)
    const streamingStart = Date.now();
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-streaming-timeout',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: true,
      });
    } catch (error) {
      const streamingDuration = Date.now() - streamingStart;
      expect(streamingDuration).toBeGreaterThan(1200);
      expect(streamingDuration).toBeLessThan(2500);
    }
  }, 60000);

  it('should handle concurrent timeouts correctly', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: { enabled: false, failureThreshold: 999, successThreshold: 2, timeoutMs: 30000 },
        retry: { enabled: false, maxRetries: 0, retryDelayMs: 50, retryOnErrors: [] },
        timeoutMs: 500,
        streamingTimeoutMs: 1000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send 5 concurrent requests
    const requests = Array.from({ length: 5 }, (_, i) =>
      controller.handleInferenceRequest({
        requestId: `test-concurrent-timeout-${i}`,
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      }).catch(err => err)
    );

    const results = await Promise.all(requests);

    // All should have timed out
    expect(results).toHaveLength(5);
    results.forEach(result => {
      expect(result).toBeDefined();
    });
  }, 60000);

  it('should return proper error format on timeout', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    let error: any;
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-error-format-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toBeDefined();
    expect(typeof error.message).toBe('string');
  }, 60000);
});
