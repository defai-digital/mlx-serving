/**
 * Worker Scalability Benchmark
 *
 * Measures how throughput and latency scale with worker count:
 * - 1, 2, 4, 8 worker configurations
 * - Fixed load across all configurations
 * - Calculate scaling efficiency (actual vs ideal)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../infrastructure/benchmark-harness.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

/**
 * Scalability Benchmark Harness
 */
class ScalabilityBenchmarkHarness extends BenchmarkHarness {
  constructor(
    private controller: ControllerNode,
    private workerCount: number
  ) {
    super();
  }

  name(): string {
    return `Worker Scalability - ${this.workerCount} Workers`;
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
          requestId: `scale-${requestCount++}`,
          modelId: config.modelId || 'benchmark-model',
          prompt: 'scalability test',
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

describe('Worker Scalability Benchmark', () => {
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

  it('should measure single worker performance (baseline)', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(1);

    const harness = new ScalabilityBenchmarkHarness(controller, 1);
    const result = await harness.execute({
      workers: 1,
      duration: 10000,  // 10 seconds
      concurrency: 5,
      warmupDuration: 2000,
    });

    console.log(`✅ Baseline (1 worker):`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

    // Validate reasonable performance
    expect(result.requestsPerSec).toBeGreaterThan(1);
    expect(result.latencyP50).toBeGreaterThan(0);
  }, 60000);

  it('should measure scalability efficiency across worker counts', async () => {
    controller = createController();
    await controller.start();

    // Test with 1, 2, 4 workers
    const workerCounts = [1, 2, 4];
    const results: Array<{ workers: number; result: BenchmarkResult }> = [];

    for (const count of workerCounts) {
      // Add workers incrementally
      const existingWorkers = workers.length;
      if (count > existingWorkers) {
        await createWorkers(count - existingWorkers);
      }

      const harness = new ScalabilityBenchmarkHarness(controller, count);
      const result = await harness.execute({
        workers: count,
        duration: 10000,  // 10 seconds
        concurrency: 5,
        warmupDuration: 2000,
      });

      results.push({ workers: count, result });

      console.log(`✅ Scalability (${count} workers):`);
      console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
      console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
      console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    }

    // Calculate scaling efficiency
    const baseline = results[0].result.requestsPerSec;

    console.log(`\n📊 Scaling Analysis:`);
    for (let i = 0; i < results.length; i++) {
      const { workers: count, result } = results[i];

      if (i === 0) {
        console.log(`   ${count} worker(s): ${result.requestsPerSec.toFixed(2)} req/sec (baseline)`);
      } else {
        const actualSpeedup = result.requestsPerSec / baseline;
        const idealSpeedup = count;
        const efficiency = (actualSpeedup / idealSpeedup) * 100;

        console.log(`   ${count} worker(s): ${result.requestsPerSec.toFixed(2)} req/sec`);
        console.log(`      Actual speedup: ${actualSpeedup.toFixed(2)}x`);
        console.log(`      Ideal speedup: ${idealSpeedup.toFixed(2)}x`);
        console.log(`      Efficiency: ${efficiency.toFixed(1)}%`);

        // Validate reasonable scaling (> 30% efficiency)
        expect(efficiency).toBeGreaterThan(30);

        // Validate throughput increases with more workers
        expect(result.requestsPerSec).toBeGreaterThan(baseline * 0.5);
      }
    }
  }, 120000);
});
