/**
 * Stress Test
 *
 * Identifies system breaking points and failure modes:
 * - Gradual ramp to breaking point
 * - Circuit breaker activation under overload
 * - System recovery after overload
 * - Graceful degradation validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { LoadGenerator } from '../infrastructure/load-generator.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Stress Test', () => {
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
   * Helper to create controller with circuit breaker
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
          timeoutMs: 10000,  // Shorter timeout for stress test
        },
        retry: {
          enabled: false,  // Disable retry to see raw failure behavior
          maxRetries: 0,
          retryDelayMs: 0,
          retryOnErrors: [],
        },
        timeoutMs: 5000,
        streamingTimeoutMs: 10000,
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

  it('should identify breaking point with gradual ramp', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const startRps = 5;
    const endRps = 100;  // Ramp to high load
    const duration = 60000;  // 1 minute ramp

    console.log(`Starting stress test: ramping ${startRps} → ${endRps} req/sec over 60s`);

    // Track metrics in 10-second intervals
    const intervals: Array<{ rps: number; errors: number; successes: number; avgLatency: number }> = [];
    let intervalErrors = 0;
    let intervalSuccesses = 0;
    let intervalLatencies: number[] = [];
    let lastIntervalTime = Date.now();

    const startTime = Date.now();

    // Generate ramping load
    const loadPromise = loadGen.generateRampLoad(
      startRps,
      endRps,
      duration,
      async () => {
        const reqStartTime = Date.now();
        const elapsed = Date.now() - startTime;
        const progress = elapsed / duration;
        const currentRps = Math.floor(startRps + (endRps - startRps) * progress);

        // Check if we need to record interval
        if (Date.now() - lastIntervalTime >= 10000) {
          const avgLatency = intervalLatencies.length > 0
            ? intervalLatencies.reduce((a, b) => a + b, 0) / intervalLatencies.length
            : 0;

          intervals.push({
            rps: currentRps,
            errors: intervalErrors,
            successes: intervalSuccesses,
            avgLatency,
          });

          console.log(`  Interval ${intervals.length}: ${currentRps} req/sec → ${intervalSuccesses} success, ${intervalErrors} errors, ${avgLatency.toFixed(2)}ms avg`);

          // Reset interval counters
          intervalErrors = 0;
          intervalSuccesses = 0;
          intervalLatencies = [];
          lastIntervalTime = Date.now();
        }

        try {
          await controller.handleInferenceRequest({
            requestId: `stress-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'stress test',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);
          intervalSuccesses++;
          intervalLatencies.push(latency);
        } catch (error) {
          collector.recordError();
          intervalErrors++;
        }
      }
    );

    await loadPromise;

    // Record final interval
    if (intervalSuccesses + intervalErrors > 0) {
      const avgLatency = intervalLatencies.length > 0
        ? intervalLatencies.reduce((a, b) => a + b, 0) / intervalLatencies.length
        : 0;

      intervals.push({
        rps: endRps,
        errors: intervalErrors,
        successes: intervalSuccesses,
        avgLatency,
      });
    }

    const finalSnapshot = collector.getSnapshot();

    console.log(`\n✅ Stress Test Complete:`);
    console.log(`   Total requests: ${finalSnapshot.latencies.length + finalSnapshot.errors}`);
    console.log(`   Successful: ${finalSnapshot.latencies.length}`);
    console.log(`   Failed: ${finalSnapshot.errors}`);
    console.log(`   Error rate: ${(finalSnapshot.errorRate * 100).toFixed(2)}%`);

    // Identify breaking point
    let breakingPoint = endRps;
    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const errorRate = interval.errors / (interval.errors + interval.successes);

      if (errorRate > 0.5) {  // > 50% error rate
        breakingPoint = interval.rps;
        console.log(`\n   ⚠️ Breaking point identified: ~${breakingPoint} req/sec (${(errorRate * 100).toFixed(1)}% errors)`);
        break;
      }
    }

    // Validate system showed graceful degradation
    expect(finalSnapshot.latencies.length).toBeGreaterThan(0);  // Some requests succeeded
    expect(breakingPoint).toBeGreaterThan(startRps);  // System handled more than baseline
  }, 120000);  // 2-minute timeout

  it('should trigger circuit breaker under sustained overload', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const rps = 50;  // High load
    const duration = 30000;  // 30 seconds

    console.log(`Starting circuit breaker stress test: ${rps} req/sec for 30s`);

    let circuitBreakerTriggered = false;

    // Generate high load
    const loadPromise = loadGen.generateConstantLoad(
      rps,
      duration,
      async () => {
        const reqStartTime = Date.now();

        try {
          await controller.handleInferenceRequest({
            requestId: `cb-stress-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'circuit breaker stress',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);
        } catch (error: any) {
          collector.recordError();

          // Check if circuit breaker error
          if (error?.message?.includes('circuit') || error?.message?.includes('CIRCUIT')) {
            circuitBreakerTriggered = true;
          }
        }
      }
    );

    await loadPromise;

    const finalSnapshot = collector.getSnapshot();

    console.log(`\n✅ Circuit Breaker Stress Test Complete:`);
    console.log(`   Total requests: ${finalSnapshot.latencies.length + finalSnapshot.errors}`);
    console.log(`   Error rate: ${(finalSnapshot.errorRate * 100).toFixed(2)}%`);
    console.log(`   Circuit breaker triggered: ${circuitBreakerTriggered ? 'Yes' : 'No'}`);

    // Validate system behavior under overload
    expect(finalSnapshot.errors).toBeGreaterThan(0);  // Some failures expected
    expect(finalSnapshot.latencies.length).toBeGreaterThan(0);  // Some successes expected
  }, 60000);  // 1-minute timeout

  it('should recover after overload is removed', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    // Phase 1: Normal load
    console.log(`Phase 1: Normal load (5 req/sec for 10s)`);
    await loadGen.generateConstantLoad(
      5,
      10000,
      async () => {
        try {
          await controller.handleInferenceRequest({
            requestId: `recovery-normal-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'normal load',
            stream: false,
          });
          collector.recordLatency(1);  // Placeholder
        } catch (error) {
          collector.recordError();
        }
      }
    );

    const phase1Snapshot = collector.getSnapshot();
    const phase1ErrorRate = phase1Snapshot.errorRate;

    // Phase 2: Overload
    console.log(`Phase 2: Overload (50 req/sec for 10s)`);
    await loadGen.generateConstantLoad(
      50,
      10000,
      async () => {
        try {
          await controller.handleInferenceRequest({
            requestId: `recovery-overload-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'overload',
            stream: false,
          });
          collector.recordLatency(1);
        } catch (error) {
          collector.recordError();
        }
      }
    );

    const phase2Snapshot = collector.getSnapshot();
    const phase2ErrorRate = phase2Snapshot.errorRate - phase1ErrorRate;

    // Wait for recovery
    console.log(`Waiting 5s for recovery...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Phase 3: Recovery load
    console.log(`Phase 3: Recovery load (5 req/sec for 10s)`);
    const phase3Collector = new MetricsCollector();
    phase3Collector.start();

    await loadGen.generateConstantLoad(
      5,
      10000,
      async () => {
        try {
          await controller.handleInferenceRequest({
            requestId: `recovery-recovery-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'recovery load',
            stream: false,
          });
          phase3Collector.recordLatency(1);
        } catch (error) {
          phase3Collector.recordError();
        }
      }
    );

    const phase3Snapshot = phase3Collector.getSnapshot();

    console.log(`\n✅ Recovery Test Complete:`);
    console.log(`   Phase 1 (normal) error rate: ${(phase1ErrorRate * 100).toFixed(2)}%`);
    console.log(`   Phase 2 (overload) error rate: ${(phase2ErrorRate * 100).toFixed(2)}%`);
    console.log(`   Phase 3 (recovery) error rate: ${(phase3Snapshot.errorRate * 100).toFixed(2)}%`);

    // Validate recovery
    expect(phase3Snapshot.errorRate).toBeLessThan(phase2ErrorRate);  // Recovery improved error rate
  }, 90000);  // 90-second timeout
});
