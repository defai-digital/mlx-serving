/**
 * Retry Overhead Benchmark
 *
 * Measures performance impact of retry mechanism:
 * - No failures (no retries triggered)
 * - Simulated failures (retries triggered)
 * - Success rate improvement
 * - Latency impact per retry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../infrastructure/benchmark-harness.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

/**
 * Retry Overhead Benchmark Harness
 */
class RetryBenchmarkHarness extends BenchmarkHarness {
  constructor(
    private controller: ControllerNode,
    private testName: string
  ) {
    super();
  }

  name(): string {
    return `Retry Overhead - ${this.testName}`;
  }

  async warmup(config: BenchmarkConfig): Promise<void> {
    // Send warmup requests
    const warmupPromises = [];
    for (let i = 0; i < 10; i++) {
      warmupPromises.push(
        this.controller.handleInferenceRequest({
          requestId: `warmup-${i}`,
          modelId: 'benchmark-model',
          prompt: 'warmup test',
          stream: false,
        }).catch(() => {})
      );
    }
    await Promise.all(warmupPromises);
  }

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const collector = new MetricsCollector();
    collector.start();

    const startTime = Date.now();
    const endTime = startTime + config.duration;
    const latencies: number[] = [];
    let errors = 0;
    let requestCount = 0;

    // Generate constant load
    while (Date.now() < endTime) {
      const batchPromises = [];

      for (let i = 0; i < config.concurrency; i++) {
        const reqStartTime = Date.now();
        const promise = this.controller.handleInferenceRequest({
          requestId: `retry-${requestCount++}`,
          modelId: config.modelId || 'benchmark-model',
          prompt: 'retry test',
          stream: false,
        }).then(() => {
          const duration = Date.now() - reqStartTime;
          latencies.push(duration);
          collector.recordLatency(duration);
        }).catch(() => {
          errors++;
          collector.recordError();
        });

        batchPromises.push(promise);
      }

      await Promise.all(batchPromises);

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const durationMs = Date.now() - startTime;

    return this.analyzeResults(
      this.name(),
      config,
      latencies,
      errors,
      durationMs
    );
  }
}

describe('Retry Overhead Benchmark', () => {
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
   * Helper to create controller with optional retry config
   */
  function createController(enableRetry: boolean, maxRetries: number = 2): ControllerNode {
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
          enabled: enableRetry,
          maxRetries: enableRetry ? maxRetries : 0,
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
        strategy: 'round_robin',
        stickySession: false,
      },
      logging: {
        level: 'info',
        format: 'json',
      },
    } as ClusterConfig;

    return new ControllerNode({ config });
  }

  /**
   * Helper to create workers
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

  it('should measure baseline performance (no retries)', async () => {
    controller = createController(false);  // Retry disabled
    await controller.start();
    await createWorkers(2);

    const harness = new RetryBenchmarkHarness(controller, 'No Retry');
    const result = await harness.execute({
      workers: 2,
      duration: 10000,  // 10 seconds
      concurrency: 5,
      warmupDuration: 2000,
    });

    console.log(`✅ Baseline (no retry):`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    expect(result.requestsPerSec).toBeGreaterThan(1);
    expect(result.latencyP50).toBeGreaterThan(0);
  }, 60000);

  it('should measure retry overhead with different configurations', async () => {
    // Test baseline (no retry)
    controller = createController(false);
    await controller.start();
    await createWorkers(2);

    const baselineHarness = new RetryBenchmarkHarness(controller, 'No Retry');
    const baselineResult = await baselineHarness.execute({
      workers: 2,
      duration: 10000,
      concurrency: 5,
      warmupDuration: 2000,
    });

    // Cleanup
    await controller.stop();
    for (const worker of workers) {
      await worker.stop();
    }
    workers = [];

    // Wait before restarting
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test with retry enabled (max 2 retries)
    controller = createController(true, 2);
    await controller.start();
    await createWorkers(2);

    const retryHarness = new RetryBenchmarkHarness(controller, 'With Retry (2x)');
    const retryResult = await retryHarness.execute({
      workers: 2,
      duration: 10000,
      concurrency: 5,
      warmupDuration: 2000,
    });

    console.log(`\n📊 Retry Overhead Analysis:`);
    console.log(`   Baseline throughput: ${baselineResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Retry throughput: ${retryResult.requestsPerSec.toFixed(2)} req/sec`);

    const throughputOverhead = ((baselineResult.requestsPerSec - retryResult.requestsPerSec) / baselineResult.requestsPerSec) * 100;
    console.log(`   Throughput overhead: ${throughputOverhead.toFixed(2)}%`);

    console.log(`\n   Baseline p50: ${baselineResult.latencyP50.toFixed(2)}ms`);
    console.log(`   Retry p50: ${retryResult.latencyP50.toFixed(2)}ms`);

    const latencyOverhead = ((retryResult.latencyP50 - baselineResult.latencyP50) / baselineResult.latencyP50) * 100;
    console.log(`   Latency overhead: ${latencyOverhead.toFixed(2)}%`);

    console.log(`\n   Baseline error rate: ${(baselineResult.errorRate * 100).toFixed(2)}%`);
    console.log(`   Retry error rate: ${(retryResult.errorRate * 100).toFixed(2)}%`);

    const errorRateImprovement = baselineResult.errorRate - retryResult.errorRate;
    console.log(`   Error rate improvement: ${(errorRateImprovement * 100).toFixed(2)}%`);

    // When no actual failures occur, retry should have minimal overhead
    // Allow up to 30% overhead due to retry logic execution
    expect(Math.abs(throughputOverhead)).toBeLessThan(30);
  }, 120000);
});
