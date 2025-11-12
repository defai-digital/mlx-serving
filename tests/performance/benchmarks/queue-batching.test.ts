/**
 * Queue & Batching Efficiency Benchmark
 *
 * Measures queueing and batching performance:
 * - Queue depth impact on latency
 * - Batch formation time
 * - Batching throughput improvement
 * - Different batch sizes (2, 4, 8, 16, 32)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../infrastructure/benchmark-harness.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

/**
 * Queue & Batching Benchmark Harness
 */
class QueueBatchingBenchmarkHarness extends BenchmarkHarness {
  constructor(
    private controller: ControllerNode,
    private testName: string
  ) {
    super();
  }

  name(): string {
    return `Queue & Batching - ${this.testName}`;
  }

  async warmup(_config: BenchmarkConfig): Promise<void> {
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

  async run(_config: BenchmarkConfig): Promise<BenchmarkResult> {
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
          requestId: `queue-${requestCount++}`,
          modelId: config.modelId || 'benchmark-model',
          prompt: 'queue batching test',
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

describe('Queue & Batching Efficiency Benchmark', () => {
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
   * Helper to create workers with custom queue/batch config
   */
  async function createWorkers(
    count: number,
    queueConfig?: { maxDepth: number; batchSize: number }
  ): Promise<WorkerNode[]> {
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
          queue: queueConfig ? {
            enabled: true,
            maxDepth: queueConfig.maxDepth,
            priorityLevels: 5,
            defaultPriority: 3,
            dropPolicy: 'oldest',
          } : undefined,
          batching: queueConfig ? {
            enabled: true,
            maxBatchSize: queueConfig.batchSize,
            minBatchSize: 1,
            formationTimeoutMs: 100,
            adaptiveSizing: true,
          } : undefined,
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

  it('should measure baseline performance (no batching)', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);  // No queue/batch config

    const harness = new QueueBatchingBenchmarkHarness(controller, 'No Batching');
    const result = await harness.execute({
      workers: 2,
      duration: 10000,  // 10 seconds
      concurrency: 5,
      warmupDuration: 2000,
    });

    console.log(`✅ Baseline (no batching):`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

    expect(result.requestsPerSec).toBeGreaterThan(1);
    expect(result.latencyP50).toBeGreaterThan(0);
  }, 60000);

  it('should measure queueing and batching efficiency', async () => {
    controller = createController();
    await controller.start();

    // Test different batch configurations
    const batchConfigs = [
      { name: 'No Batching', maxDepth: 0, batchSize: 1 },
      { name: 'Small Batches (4)', maxDepth: 100, batchSize: 4 },
      { name: 'Medium Batches (8)', maxDepth: 100, batchSize: 8 },
      { name: 'Large Batches (16)', maxDepth: 100, batchSize: 16 },
    ];

    const results: Array<{ config: typeof batchConfigs[0]; result: BenchmarkResult }> = [];

    for (const batchConfig of batchConfigs) {
      // Cleanup previous workers
      for (const worker of workers) {
        await worker.stop();
      }
      workers = [];

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create workers with specific config
      if (batchConfig.batchSize === 1) {
        await createWorkers(2);  // No batching
      } else {
        await createWorkers(2, {
          maxDepth: batchConfig.maxDepth,
          batchSize: batchConfig.batchSize,
        });
      }

      const harness = new QueueBatchingBenchmarkHarness(controller, batchConfig.name);
      const result = await harness.execute({
        workers: 2,
        duration: 10000,  // 10 seconds
        concurrency: 10,  // High concurrency for batching
        warmupDuration: 2000,
      });

      results.push({ config: batchConfig, result });

      console.log(`✅ ${batchConfig.name}:`);
      console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
      console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
      console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
      console.log(`   p99 latency: ${result.latencyP99.toFixed(2)}ms`);
    }

    // Analyze batching efficiency
    const baseline = results[0].result;

    console.log(`\n📊 Batching Efficiency Analysis:`);
    for (let i = 0; i < results.length; i++) {
      const { config, result } = results[i];

      if (i === 0) {
        console.log(`   ${config.name}: ${result.requestsPerSec.toFixed(2)} req/sec (baseline)`);
      } else {
        const throughputImprovement = ((result.requestsPerSec - baseline.requestsPerSec) / baseline.requestsPerSec) * 100;
        const latencyImpact = ((result.latencyP50 - baseline.latencyP50) / baseline.latencyP50) * 100;

        console.log(`   ${config.name}:`);
        console.log(`      Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
        console.log(`      Throughput change: ${throughputImprovement >= 0 ? '+' : ''}${throughputImprovement.toFixed(2)}%`);
        console.log(`      Latency change: ${latencyImpact >= 0 ? '+' : ''}${latencyImpact.toFixed(2)}%`);

        // Validate reasonable behavior
        expect(result.requestsPerSec).toBeGreaterThan(0);
        expect(result.latencyP50).toBeGreaterThan(0);
      }
    }
  }, 180000);
});
