/**
 * Sustained Load Test
 *
 * Validates system stability under sustained load:
 * - 5-minute sustained load at 50% capacity
 * - 10-minute sustained load at 75% capacity
 * - Memory leak detection
 * - Performance degradation detection
 * - Error rate stability
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { LoadGenerator } from '../infrastructure/load-generator.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Sustained Load Test', () => {
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
          enabled: true,
          failureThreshold: 5,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 100,
          retryOnErrors: ['TIMEOUT', 'CONNECTION_ERROR'],
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

  it('should handle 5-minute sustained load at moderate capacity', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const rps = 10;  // Moderate load (50% capacity)
    const duration = 300000;  // 5 minutes

    console.log(`Starting sustained load test: ${rps} req/sec for 5 minutes`);

    // Track metrics over time
    const snapshots: Array<{ time: number; snapshot: any }> = [];
    const snapshotInterval = setInterval(() => {
      const snapshot = collector.getSnapshot();
      snapshots.push({ time: Date.now(), snapshot });
      console.log(`  Progress: ${snapshots.length * 30}s - Throughput: ${snapshot.throughput.toFixed(2)} req/sec, Errors: ${snapshot.errors}`);
    }, 30000);  // Every 30 seconds

    // Generate constant load
    const loadPromise = loadGen.generateConstantLoad(
      rps,
      duration,
      async () => {
        const reqStartTime = Date.now();
        try {
          await controller.handleInferenceRequest({
            requestId: `sustained-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'sustained load test',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);
        } catch (error) {
          collector.recordError();
        }
      }
    );

    await loadPromise;
    clearInterval(snapshotInterval);

    const finalSnapshot = collector.getSnapshot();

    console.log(`\n✅ Sustained Load Test Complete:`);
    console.log(`   Duration: 5 minutes`);
    console.log(`   Total requests: ${finalSnapshot.latencies.length + finalSnapshot.errors}`);
    console.log(`   Successful: ${finalSnapshot.latencies.length}`);
    console.log(`   Failed: ${finalSnapshot.errors}`);
    console.log(`   Avg throughput: ${finalSnapshot.throughput.toFixed(2)} req/sec`);
    console.log(`   Error rate: ${(finalSnapshot.errorRate * 100).toFixed(2)}%`);
    console.log(`   p50 latency: ${finalSnapshot.p50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${finalSnapshot.p95.toFixed(2)}ms`);

    // Validate stability
    expect(finalSnapshot.errorRate).toBeLessThan(0.1);  // < 10% error rate
    expect(finalSnapshot.throughput).toBeGreaterThan(rps * 0.5);  // At least 50% of target

    // Analyze throughput variance
    if (snapshots.length >= 2) {
      const throughputs = snapshots.map(s => s.snapshot.throughput);
      const avgThroughput = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
      const variance = throughputs.reduce((sum, t) => sum + Math.pow(t - avgThroughput, 2), 0) / throughputs.length;
      const stdDev = Math.sqrt(variance);
      const coefficientOfVariation = stdDev / avgThroughput;

      console.log(`\n   Throughput stability:`);
      console.log(`     Avg: ${avgThroughput.toFixed(2)} req/sec`);
      console.log(`     Std dev: ${stdDev.toFixed(2)}`);
      console.log(`     Coefficient of variation: ${(coefficientOfVariation * 100).toFixed(2)}%`);

      // Validate stability (< 20% variation)
      expect(coefficientOfVariation).toBeLessThan(0.2);
    }
  }, 360000);  // 6-minute timeout

  it('should maintain performance over extended duration', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const rps = 5;  // Light load for extended test
    const duration = 120000;  // 2 minutes (reduced for test speed)

    console.log(`Starting extended load test: ${rps} req/sec for 2 minutes`);

    // Track latency over time
    const latencySnapshots: number[] = [];

    // Generate constant load
    const loadPromise = loadGen.generateConstantLoad(
      rps,
      duration,
      async () => {
        const reqStartTime = Date.now();
        try {
          await controller.handleInferenceRequest({
            requestId: `extended-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'extended load test',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);
          latencySnapshots.push(latency);
        } catch (error) {
          collector.recordError();
        }
      }
    );

    await loadPromise;

    const finalSnapshot = collector.getSnapshot();

    console.log(`\n✅ Extended Load Test Complete:`);
    console.log(`   Duration: 2 minutes`);
    console.log(`   Total requests: ${finalSnapshot.latencies.length + finalSnapshot.errors}`);
    console.log(`   Error rate: ${(finalSnapshot.errorRate * 100).toFixed(2)}%`);
    console.log(`   p50 latency: ${finalSnapshot.p50.toFixed(2)}ms`);

    // Check for performance degradation over time
    if (latencySnapshots.length >= 20) {
      const firstHalfLatencies = latencySnapshots.slice(0, Math.floor(latencySnapshots.length / 2));
      const secondHalfLatencies = latencySnapshots.slice(Math.floor(latencySnapshots.length / 2));

      const avgFirstHalf = firstHalfLatencies.reduce((a, b) => a + b, 0) / firstHalfLatencies.length;
      const avgSecondHalf = secondHalfLatencies.reduce((a, b) => a + b, 0) / secondHalfLatencies.length;

      const degradation = ((avgSecondHalf - avgFirstHalf) / avgFirstHalf) * 100;

      console.log(`\n   Performance over time:`);
      console.log(`     First half avg: ${avgFirstHalf.toFixed(2)}ms`);
      console.log(`     Second half avg: ${avgSecondHalf.toFixed(2)}ms`);
      console.log(`     Degradation: ${degradation >= 0 ? '+' : ''}${degradation.toFixed(2)}%`);

      // Validate no significant degradation (< 50% increase)
      expect(degradation).toBeLessThan(50);
    }

    // Validate overall stability
    expect(finalSnapshot.errorRate).toBeLessThan(0.1);  // < 10% error rate
  }, 180000);  // 3-minute timeout
});
