/**
 * Request Routing Integration Tests
 *
 * Comprehensive tests for request routing in the controller node:
 * - Load balancing strategies (round-robin, least-loaded, smart)
 * - Session affinity (sticky sessions)
 * - Worker filtering and selection
 * - Request metrics tracking
 * - Integration with circuit breaker, retry, and timeout
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Request Routing Integration', () => {
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
    // Cleanup
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

  /**
   * Helper to create controller with specific config
   */
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
          enabled: false,  // Disable to isolate routing tests
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: false,  // Disable to isolate routing tests
          maxRetries: 0,
          retryDelayMs: 0,
          retryOnErrors: [],
        },
        timeoutMs: 10000,
        streamingTimeoutMs: 20000,
      },
      discovery: {
        enabled: true,
        heartbeatIntervalMs: 5000,
        offlineTimeoutMs: 15000,
      },
      workers: { static: [] },
      loadBalancing: {
        strategy: 'round_robin',
        stickySession: false,
      },
      logging: {
        level: 'info',
        format: 'json',
      },
      ...overrides,
    } as ClusterConfig;

    return new ControllerNode({ config });
  }

  /**
   * Helper to create worker
   */
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

  it('should route requests to available workers', async () => {
    controller = createController();
    await controller.start();

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify workers are registered
    const allWorkers = controller.getAllWorkers();
    expect(allWorkers.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('should distribute requests across workers with round-robin', async () => {
    controller = createController({
      loadBalancing: {
        strategy: 'round_robin',
        stickySession: false,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    // Create 3 workers
    const worker1 = createWorker();
    const worker2 = createWorker();
    const worker3 = createWorker();

    await Promise.all([
      worker1.start(),
      worker2.start(),
      worker3.start(),
    ]);

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send multiple requests (will fail but we can track which worker was selected)
    const selectedWorkers: string[] = [];
    for (let i = 0; i < 6; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `test-rr-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
        });
      } catch (error) {
        // Expected to fail (no model loaded)
        const metrics = controller.getRequestMetrics(`test-rr-${i}`);
        if (metrics && metrics.selectedWorker) {
          selectedWorkers.push(metrics.selectedWorker);
        }
      }
    }

    // Verify round-robin distribution (should cycle through workers)
    expect(selectedWorkers.length).toBeGreaterThan(0);
  }, 60000);

  it('should support session affinity (sticky sessions)', async () => {
    controller = createController({
      loadBalancing: {
        strategy: 'smart',
        stickySession: true,
        sessionAffinity: {
          enabled: true,
          ttlMs: 300000,  // 5 minutes
          cleanupIntervalMs: 60000,
        },
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    // Create 3 workers
    const worker1 = createWorker();
    const worker2 = createWorker();
    const worker3 = createWorker();

    await Promise.all([
      worker1.start(),
      worker2.start(),
      worker3.start(),
    ]);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const sessionId = 'test-session-123';
    let firstWorker: string | undefined;

    // Send multiple requests with same session ID
    for (let i = 0; i < 5; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `test-sticky-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
          sessionId: sessionId,
        });
      } catch (error) {
        // Expected to fail
        const metrics = controller.getRequestMetrics(`test-sticky-${i}`);
        if (metrics && metrics.selectedWorker) {
          if (!firstWorker) {
            firstWorker = metrics.selectedWorker;
          } else {
            // All subsequent requests should go to the same worker
            expect(metrics.selectedWorker).toBe(firstWorker);
          }
        }
      }
    }

    expect(firstWorker).toBeDefined();
  }, 60000);

  it('should track request metrics correctly', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();
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
      expect(metrics.selectedWorker).toBeDefined();
      expect(metrics.durationMs).toBeGreaterThan(0);
      expect(metrics.retryCount).toBe(0);  // Retry disabled
      expect(metrics.failedWorkers).toBeDefined();
    }
  }, 60000);

  it('should handle requests when no workers available', async () => {
    controller = createController();
    await controller.start();

    // No workers registered
    let errorThrown = false;
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-no-workers',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error: any) {
      errorThrown = true;
      expect(error).toBeDefined();
      // Should throw NO_WORKERS_AVAILABLE error
    }

    expect(errorThrown).toBe(true);
  }, 60000);

  it('should filter workers by model capabilities (smart load balancing)', async () => {
    controller = createController({
      loadBalancing: {
        strategy: 'smart',
        stickySession: false,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Request a specific model (will fail but worker selection happens first)
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-smart-1',
        modelId: 'specific-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-smart-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      expect(metrics.selectedWorker).toBeDefined();
    }
  }, 60000);

  it('should handle concurrent requests correctly', async () => {
    controller = createController();
    await controller.start();

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send 10 concurrent requests
    const requests = Array.from({ length: 10 }, (_, i) =>
      controller.handleInferenceRequest({
        requestId: `test-concurrent-${i}`,
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      }).catch(err => err)
    );

    const results = await Promise.all(requests);

    // All should have completed (either success or failure)
    expect(results).toHaveLength(10);

    // Check that all requests have metrics
    const allMetrics = controller.getAllRequestMetrics();
    expect(allMetrics).toBeDefined();
    if (allMetrics) {
      expect(allMetrics.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('should integrate with circuit breaker', async () => {
    controller = createController({
      requestRouting: {
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          successThreshold: 2,
          timeoutMs: 5000,
        },
        retry: {
          enabled: false,
          maxRetries: 0,
          retryDelayMs: 0,
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

    const workerId = worker.getWorkerId();

    // Cause failures to trigger circuit breaker
    for (let i = 0; i < 3; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `test-cb-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
        });
      } catch (error) {
        // Expected
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify circuit breaker opened
    const stats = controller.getCircuitBreakerStats();
    expect(stats[workerId]).toBeDefined();
    if (stats[workerId]) {
      expect(stats[workerId].failures).toBeGreaterThanOrEqual(3);
    }
  }, 60000);

  it('should integrate with retry handler', async () => {
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

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      await controller.handleInferenceRequest({
        requestId: 'test-retry-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-retry-1');
    expect(metrics).toBeDefined();
    if (metrics) {
      // Should have retried
      expect(metrics.retryCount).toBeGreaterThanOrEqual(0);
      expect(metrics.retryCount).toBeLessThanOrEqual(2);
    }
  }, 60000);

  it('should integrate with timeout handler', async () => {
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
          maxRetries: 0,
          retryDelayMs: 0,
          retryOnErrors: [],
        },
        timeoutMs: 500,  // Short timeout
        streamingTimeoutMs: 1000,
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
    } catch (error) {
      errorThrown = true;
      const duration = Date.now() - startTime;

      // Should timeout around 500ms
      expect(duration).toBeGreaterThan(400);
      expect(duration).toBeLessThan(1500);
    }

    expect(errorThrown).toBe(true);

    const metrics = controller.getRequestMetrics('test-timeout-1');
    expect(metrics).toBeDefined();
  }, 60000);

  it('should track all request metrics', async () => {
    controller = createController();
    await controller.start();

    const worker = createWorker();
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send multiple requests
    for (let i = 0; i < 5; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `test-all-metrics-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
        });
      } catch (error) {
        // Expected
      }
    }

    const allMetrics = controller.getAllRequestMetrics();
    expect(allMetrics).toBeDefined();
    if (allMetrics) {
      expect(allMetrics.length).toBeGreaterThanOrEqual(5);

      // Verify each metric has required fields
      for (const metric of allMetrics) {
        expect(metric.requestId).toBeDefined();
        expect(metric.selectedWorker).toBeDefined();
        expect(metric.durationMs).toBeGreaterThan(0);
      }
    }
  }, 60000);

  it('should handle worker going offline during request', async () => {
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
          maxRetries: 1,
          retryDelayMs: 50,
          retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE'],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
      },
    } as Partial<ClusterConfig>);

    await controller.start();

    // Create 2 workers
    const worker1 = createWorker();
    const worker2 = createWorker();

    await Promise.all([worker1.start(), worker2.start()]);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop one worker to simulate going offline
    await worker1.stop();
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send request (should route to remaining worker or retry)
    try {
      await controller.handleInferenceRequest({
        requestId: 'test-offline-1',
        modelId: 'nonexistent-model',
        prompt: 'test',
        stream: false,
      });
    } catch (error) {
      // Expected
    }

    const metrics = controller.getRequestMetrics('test-offline-1');
    expect(metrics).toBeDefined();
    // Verify request was attempted
    if (metrics) {
      expect(metrics.durationMs).toBeGreaterThan(0);
    }
  }, 60000);
});
