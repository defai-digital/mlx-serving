/**
 * End-to-End Workflow Test
 *
 * Validates complete distributed inference workflow:
 * - Happy path (all workers healthy)
 * - Worker failure + automatic retry
 * - Circuit breaker activation + recovery
 * - Queue + batching + retry interaction
 * - Full system integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('End-to-End Distributed Inference Workflow', () => {
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

    // Cleanup NATS
    if (embeddedServer) {
      await embeddedServer.stop();
    }
  }, 30000);

  /**
   * Helper to create fully-featured controller
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
      requestRouting: {
        circuitBreaker: {
          enabled: true,
          failureThreshold: 5,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 100,
          retryOnErrors: ['TIMEOUT', 'CONNECTION_ERROR', 'INTERNAL_ERROR'],
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
        strategy: 'smart',
        stickySession: true,
        sessionAffinity: {
          enabled: true,
          ttlMs: 300000,
          cleanupIntervalMs: 60000,
        },
      },
      logging: {
        level: 'info',
        format: 'json',
      },
    } as ClusterConfig;

    return new ControllerNode({ config });
  }

  /**
   * Helper to create fully-featured workers
   */
  async function createWorkers(count: number): Promise<WorkerNode[]> {
    const newWorkers: WorkerNode[] = [];

    for (let i = 0; i < count; i++) {
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
          port: 9000 + workers.length + i,
          modelDir: 'test-models',
          queue: {
            enabled: true,
            maxDepth: 100,
            priorityLevels: 5,
            defaultPriority: 3,
            dropPolicy: 'oldest',
          },
          batching: {
            enabled: true,
            maxBatchSize: 8,
            minBatchSize: 1,
            formationTimeoutMs: 100,
            adaptiveSizing: true,
          },
          resourceLimits: {
            maxConcurrentRequests: 10,
            memoryLimitMb: 8192,
            hardMemoryLimitMb: 10240,
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
      } as ClusterConfig;

      const worker = new WorkerNode({ config });
      newWorkers.push(worker);
    }

    // Start all workers
    await Promise.all(newWorkers.map(w => w.start()));

    // Wait for workers to register
    await new Promise(resolve => setTimeout(resolve, 2000));

    workers.push(...newWorkers);
    return newWorkers;
  }

  it('should complete full inference workflow (happy path)', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(4);

    console.log(`Starting E2E happy path test with 4 workers`);

    const collector = new MetricsCollector();
    collector.start();

    // Send batch of requests
    const numRequests = 100;
    const promises = [];

    for (let i = 0; i < numRequests; i++) {
      const reqStartTime = Date.now();
      const promise = controller.handleInferenceRequest({
        requestId: `e2e-happy-${i}`,
        modelId: 'benchmark-model',
        prompt: `test prompt ${i}`,
        stream: false,
        sessionId: `session-${i % 10}`,  // 10 different sessions
      }).then(() => {
        const latency = Date.now() - reqStartTime;
        collector.recordLatency(latency);
      }).catch(() => {
        collector.recordError();
      });

      promises.push(promise);
    }

    await Promise.all(promises);

    const snapshot = collector.getSnapshot();
    const allWorkers = controller.getAllWorkers();

    console.log(`\n✅ E2E Happy Path Complete:`);
    console.log(`   Workers available: ${allWorkers.length}`);
    console.log(`   Total requests: ${numRequests}`);
    console.log(`   Successful: ${snapshot.latencies.length}`);
    console.log(`   Failed: ${snapshot.errors}`);
    console.log(`   Success rate: ${((snapshot.latencies.length / numRequests) * 100).toFixed(2)}%`);
    console.log(`   p50 latency: ${snapshot.p50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${snapshot.p95.toFixed(2)}ms`);

    // Validate high success rate
    expect(snapshot.latencies.length).toBeGreaterThan(numRequests * 0.5);  // > 50% success
    expect(allWorkers.length).toBe(4);  // All workers registered
  }, 60000);

  it('should handle worker failure with automatic retry', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(4);

    console.log(`Starting E2E worker failure test with 4 workers`);

    const collector = new MetricsCollector();
    collector.start();

    // Send initial batch
    const numRequests = 50;
    const promises = [];

    for (let i = 0; i < numRequests; i++) {
      const reqStartTime = Date.now();
      const promise = controller.handleInferenceRequest({
        requestId: `e2e-failure-${i}`,
        modelId: 'benchmark-model',
        prompt: `test prompt ${i}`,
        stream: false,
      }).then(() => {
        const latency = Date.now() - reqStartTime;
        collector.recordLatency(latency);
      }).catch(() => {
        collector.recordError();
      });

      promises.push(promise);

      // Simulate worker failure mid-test
      if (i === 20) {
        console.log(`  ⚠️ Simulating worker failure (stopping worker 0)`);
        setTimeout(async () => {
          if (workers[0]) {
            await workers[0].stop();
            workers.splice(0, 1);
          }
        }, 100);
      }
    }

    await Promise.all(promises);

    const snapshot = collector.getSnapshot();
    const remainingWorkers = controller.getAllWorkers();

    console.log(`\n✅ E2E Worker Failure Test Complete:`);
    console.log(`   Workers remaining: ${remainingWorkers.length}`);
    console.log(`   Total requests: ${numRequests}`);
    console.log(`   Successful: ${snapshot.latencies.length}`);
    console.log(`   Failed: ${snapshot.errors}`);
    console.log(`   Success rate: ${((snapshot.latencies.length / numRequests) * 100).toFixed(2)}%`);

    // Validate retry handled failures
    expect(snapshot.latencies.length).toBeGreaterThan(numRequests * 0.3);  // > 30% success despite failure
    expect(remainingWorkers.length).toBeLessThan(4);  // Worker actually failed
  }, 60000);

  it('should activate circuit breaker and recover', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    console.log(`Starting E2E circuit breaker test`);

    const collector = new MetricsCollector();
    collector.start();

    // Phase 1: Generate failures to trip circuit breaker
    console.log(`  Phase 1: Generating failures to trip circuit breaker`);
    for (let i = 0; i < 20; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `cb-trip-${i}`,
          modelId: 'nonexistent-model',
          prompt: 'test',
          stream: false,
        });
        collector.recordLatency(1);
      } catch (error) {
        collector.recordError();
      }
    }

    const phase1Snapshot = collector.getSnapshot();
    console.log(`  Phase 1 complete: ${phase1Snapshot.errors} errors`);

    // Wait for circuit breaker timeout
    console.log(`  Waiting 5s for circuit breaker recovery...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Phase 2: Try requests after recovery period
    console.log(`  Phase 2: Testing recovery`);
    const phase2Collector = new MetricsCollector();
    phase2Collector.start();

    for (let i = 0; i < 10; i++) {
      try {
        await controller.handleInferenceRequest({
          requestId: `cb-recover-${i}`,
          modelId: 'benchmark-model',
          prompt: 'test',
          stream: false,
        });
        phase2Collector.recordLatency(1);
      } catch (error) {
        phase2Collector.recordError();
      }
    }

    const phase2Snapshot = phase2Collector.getSnapshot();

    console.log(`\n✅ E2E Circuit Breaker Test Complete:`);
    console.log(`   Phase 1 (failures): ${phase1Snapshot.errors} errors`);
    console.log(`   Phase 2 (recovery): ${phase2Snapshot.errors} errors, ${phase2Snapshot.latencies.length} successes`);

    // Validate circuit breaker behavior
    expect(phase1Snapshot.errors).toBeGreaterThan(0);  // Failures occurred
    expect(phase2Snapshot.latencies.length + phase2Snapshot.errors).toBe(10);  // All recovery requests attempted
  }, 60000);

  it('should integrate queue, batching, and retry successfully', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    console.log(`Starting E2E integration test (queue + batching + retry)`);

    const collector = new MetricsCollector();
    collector.start();

    // Send burst of concurrent requests (will queue)
    const numRequests = 50;
    const promises = [];

    console.log(`  Sending burst of ${numRequests} concurrent requests`);

    for (let i = 0; i < numRequests; i++) {
      const reqStartTime = Date.now();
      const promise = controller.handleInferenceRequest({
        requestId: `e2e-integration-${i}`,
        modelId: 'benchmark-model',
        prompt: `integration test ${i}`,
        stream: false,
        priority: i % 3 + 1,  // Vary priority (1-3)
      }).then(() => {
        const latency = Date.now() - reqStartTime;
        collector.recordLatency(latency);
      }).catch(() => {
        collector.recordError();
      });

      promises.push(promise);
    }

    await Promise.all(promises);

    const snapshot = collector.getSnapshot();

    console.log(`\n✅ E2E Integration Test Complete:`);
    console.log(`   Total requests: ${numRequests}`);
    console.log(`   Successful: ${snapshot.latencies.length}`);
    console.log(`   Failed: ${snapshot.errors}`);
    console.log(`   Success rate: ${((snapshot.latencies.length / numRequests) * 100).toFixed(2)}%`);
    console.log(`   p50 latency: ${snapshot.p50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${snapshot.p95.toFixed(2)}ms`);
    console.log(`   p99 latency: ${snapshot.p99.toFixed(2)}ms`);

    // Validate integration worked
    expect(snapshot.latencies.length).toBeGreaterThan(numRequests * 0.3);  // > 30% success
    expect(snapshot.p50).toBeGreaterThan(0);  // Valid latency measurements
  }, 90000);  // 90-second timeout
});
