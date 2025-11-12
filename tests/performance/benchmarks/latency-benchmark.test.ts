/**
 * Latency Distribution Benchmark
 *
 * Measures latency percentiles (p50, p95, p99, p99.9) under different load conditions:
 * - Low load (< 10% capacity)
 * - Medium load (50% capacity)
 * - High load (90% capacity)
 * - Tail latency behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../infrastructure/benchmark-harness.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

/**
 * Latency Benchmark Harness
 */
class LatencyBenchmarkHarness extends BenchmarkHarness {
  constructor(
    private controller: ControllerNode,
    private testName: string
  ) {
    super();
  }

  name(): string {
    return `Latency Distribution - ${this.testName}`;
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

    // Generate load at specified concurrency
    while (Date.now() < endTime) {
      const batchPromises = [];

      for (let i = 0; i < config.concurrency; i++) {
        const reqStartTime = Date.now();
        const promise = this.controller.handleInferenceRequest({
          requestId: `latency-${requestCount++}`,
          modelId: config.modelId || 'benchmark-model',
          prompt: 'latency test',
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

      // Delay between batches to control load level
      await new Promise(resolve => setTimeout(resolve, 20));
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

describe('Latency Distribution Benchmark', () => {
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

  it('should measure low-load latency (< 10% capacity)', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const harness = new LatencyBenchmarkHarness(controller, 'Low Load');
    const result = await harness.execute({
      workers: 2,
      duration: 10000,  // 10 seconds
      concurrency: 2,   // Low concurrency
      warmupDuration: 2000,
    });

    console.log(`✅ Low Load Latency:`);
    console.log(`   p50:   ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95:   ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99:   ${result.latencyP99.toFixed(2)}ms`);
    console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);

    // Validate reasonable latencies
    expect(result.latencyP50).toBeGreaterThan(0);
    expect(result.latencyP95).toBeGreaterThan(result.latencyP50);
    expect(result.latencyP99).toBeGreaterThan(result.latencyP95);
    expect(result.latencyP999).toBeGreaterThan(result.latencyP99);
  }, 60000);

  it('should measure latency under varying load conditions', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    // Test different load levels
    const loadLevels = [
      { name: 'Low', concurrency: 2 },
      { name: 'Medium', concurrency: 5 },
      { name: 'High', concurrency: 10 },
    ];

    for (const level of loadLevels) {
      const harness = new LatencyBenchmarkHarness(controller, `${level.name} Load`);
      const result = await harness.execute({
        workers: 2,
        duration: 10000,  // 10 seconds
        concurrency: level.concurrency,
        warmupDuration: 2000,
      });

      console.log(`✅ ${level.name} Load (concurrency ${level.concurrency}):`);
      console.log(`   p50:   ${result.latencyP50.toFixed(2)}ms`);
      console.log(`   p95:   ${result.latencyP95.toFixed(2)}ms`);
      console.log(`   p99:   ${result.latencyP99.toFixed(2)}ms`);
      console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);
      console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);

      // Validate distribution properties
      expect(result.latencyP95).toBeGreaterThan(result.latencyP50);
      expect(result.latencyP99).toBeGreaterThan(result.latencyP95);

      // Tail latency should be reasonably bounded
      const tailLatencyRatio = result.latencyP999 / result.latencyP50;
      console.log(`   Tail ratio (p99.9/p50): ${tailLatencyRatio.toFixed(2)}x`);

      // Expect tail latency to be less than 100x median
      expect(tailLatencyRatio).toBeLessThan(100);
    }
  }, 120000);
});
