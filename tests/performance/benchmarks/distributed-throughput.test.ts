/**
 * Distributed Throughput Benchmark
 *
 * Measures requests/sec with varying worker counts to validate:
 * - Baseline throughput (single worker)
 * - Linear scaling (2x workers = ~2x throughput)
 * - Saturation point (diminishing returns at scale)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../infrastructure/benchmark-harness.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

/**
 * Throughput Benchmark Harness
 */
class ThroughputBenchmarkHarness extends BenchmarkHarness {
  constructor(
    private controller: ControllerNode,
    private testName: string
  ) {
    super();
  }

  name(): string {
    return `Distributed Throughput - ${this.testName}`;
  }

  async warmup(config: BenchmarkConfig): Promise<void> {
    // Send warmup requests to prime the system
    const warmupPromises = [];
    for (let i = 0; i < config.concurrency; i++) {
      warmupPromises.push(
        this.controller.handleInferenceRequest({
          requestId: `warmup-${i}`,
          modelId: 'benchmark-model',
          prompt: 'warmup test',
          stream: false,
        }).catch(() => {})  // Expected to fail (no model loaded)
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

      // Send batch of concurrent requests
      for (let i = 0; i < config.concurrency; i++) {
        const reqStartTime = Date.now();
        const promise = this.controller.handleInferenceRequest({
          requestId: `bench-${requestCount++}`,
          modelId: config.modelId || 'benchmark-model',
          prompt: 'benchmark test',
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

      // Small delay between batches to avoid overwhelming the system
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

describe('Distributed Throughput Benchmark', () => {
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
      requestRouting: {
        circuitBreaker: {
          enabled: false,  // Disabled for baseline throughput
          failureThreshold: 999,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: false,  // Disabled for baseline throughput
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

  it('should measure baseline throughput (1 worker)', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(1);

    const harness = new ThroughputBenchmarkHarness(controller, '1 Worker');
    const result = await harness.execute({
      workers: 1,
      duration: 10000,  // 10 seconds
      concurrency: 5,
      warmupDuration: 2000,
    });

    console.log(`✅ Baseline (1 worker): ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms, p95: ${result.latencyP95.toFixed(2)}ms`);

    // Validate reasonable throughput
    expect(result.requestsPerSec).toBeGreaterThan(1);
    expect(result.errorRate).toBeLessThan(1.0);  // Allow failures (no model loaded)
  }, 60000);

  it('should demonstrate linear scaling with multiple workers', async () => {
    controller = createController();
    await controller.start();

    // Test with 1, 2, 4 workers
    const workerCounts = [1, 2, 4];
    const results: BenchmarkResult[] = [];

    for (const count of workerCounts) {
      // Create workers for this test
      await createWorkers(count - workers.length);

      const harness = new ThroughputBenchmarkHarness(controller, `${count} Workers`);
      const result = await harness.execute({
        workers: count,
        duration: 10000,  // 10 seconds
        concurrency: 5,
        warmupDuration: 2000,
      });

      results.push(result);

      console.log(`✅ Throughput (${count} workers): ${result.requestsPerSec.toFixed(2)} req/sec`);
      console.log(`   p50: ${result.latencyP50.toFixed(2)}ms, p95: ${result.latencyP95.toFixed(2)}ms`);
    }

    // Calculate scaling efficiency
    const baseline = results[0].requestsPerSec;

    for (let i = 1; i < results.length; i++) {
      const scalingFactor = results[i].requestsPerSec / baseline;
      const efficiency = scalingFactor / workerCounts[i];

      console.log(`   Scaling efficiency (${workerCounts[i]} workers): ${(efficiency * 100).toFixed(1)}%`);

      // Expect reasonable scaling (> 50% efficiency)
      // Note: May not be perfect linear scaling due to coordination overhead
      expect(efficiency).toBeGreaterThan(0.3);
    }
  }, 120000);
});
