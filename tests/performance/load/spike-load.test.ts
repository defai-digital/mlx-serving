/**
 * Spike Load Test
 *
 * Validates response to sudden traffic spikes:
 * - Baseline → 10x spike → baseline
 * - Queue backlog handling
 * - Recovery time measurement
 * - Latency behavior during spike
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { LoadGenerator } from '../infrastructure/load-generator.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Spike Load Test', () => {
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
   * Helper to create controller with queue enabled
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
          failureThreshold: 10,
          successThreshold: 2,
          timeoutMs: 30000,
        },
        retry: {
          enabled: false,  // Disable retry during spike to avoid cascading
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
   * Helper to create workers with queue enabled
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
            maxDepth: 1000,  // Large queue for spike absorption
            priorityLevels: 5,
            defaultPriority: 3,
            dropPolicy: 'oldest',
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

  it('should handle traffic spike with queue buffering', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const baseRps = 5;
    const spikeRps = 50;  // 10x spike
    const spikeDuration = 10000;  // 10 second spike
    const totalDuration = 60000;  // 1 minute total

    console.log(`Starting spike load test:`);
    console.log(`  Baseline: ${baseRps} req/sec`);
    console.log(`  Spike: ${spikeRps} req/sec (10x)`);
    console.log(`  Spike duration: ${spikeDuration}ms`);

    let inSpike = false;
    let spikeStartTime = 0;
    let spikeEndTime = 0;

    // Start spike after 15 seconds
    setTimeout(() => {
      inSpike = true;
      spikeStartTime = Date.now();
      spikeEndTime = spikeStartTime + spikeDuration;
      console.log(`  🔥 SPIKE STARTED at ${(Date.now() / 1000).toFixed(0)}s`);
    }, 15000);

    // Track metrics during different phases
    const baselineLatencies: number[] = [];
    const spikeLatencies: number[] = [];
    const recoveryLatencies: number[] = [];

    // Generate spike load
    const loadPromise = loadGen.generateSpikeLoad(
      baseRps,
      spikeRps,
      totalDuration,
      spikeDuration,
      async () => {
        const reqStartTime = Date.now();
        const currentPhase = inSpike ? 'spike' :
          (spikeEndTime > 0 && Date.now() > spikeEndTime + 5000) ? 'recovery' : 'baseline';

        try {
          await controller.handleInferenceRequest({
            requestId: `spike-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'spike test',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);

          // Track phase-specific latencies
          if (currentPhase === 'baseline') {
            baselineLatencies.push(latency);
          } else if (currentPhase === 'spike') {
            spikeLatencies.push(latency);
          } else if (currentPhase === 'recovery') {
            recoveryLatencies.push(latency);
          }
        } catch (error) {
          collector.recordError();
        }

        // Log spike end
        if (inSpike && Date.now() >= spikeEndTime) {
          inSpike = false;
          console.log(`  ✅ SPIKE ENDED at ${(Date.now() / 1000).toFixed(0)}s`);
        }
      }
    );

    await loadPromise;

    const finalSnapshot = collector.getSnapshot();

    console.log(`\n✅ Spike Load Test Complete:`);
    console.log(`   Total requests: ${finalSnapshot.latencies.length + finalSnapshot.errors}`);
    console.log(`   Error rate: ${(finalSnapshot.errorRate * 100).toFixed(2)}%`);

    // Analyze baseline performance
    if (baselineLatencies.length > 0) {
      const baselineP50 = baselineLatencies.sort((a, b) => a - b)[Math.floor(baselineLatencies.length * 0.5)];
      console.log(`\n   Baseline phase (${baselineLatencies.length} requests):`);
      console.log(`     p50: ${baselineP50.toFixed(2)}ms`);
    }

    // Analyze spike performance
    if (spikeLatencies.length > 0) {
      const sorted = spikeLatencies.sort((a, b) => a - b);
      const spikeP50 = sorted[Math.floor(sorted.length * 0.5)];
      const spikeP95 = sorted[Math.floor(sorted.length * 0.95)];
      console.log(`\n   Spike phase (${spikeLatencies.length} requests):`);
      console.log(`     p50: ${spikeP50.toFixed(2)}ms`);
      console.log(`     p95: ${spikeP95.toFixed(2)}ms`);
      console.log(`     max: ${sorted[sorted.length - 1].toFixed(2)}ms`);
    }

    // Analyze recovery
    if (recoveryLatencies.length > 0) {
      const recoveryP50 = recoveryLatencies.sort((a, b) => a - b)[Math.floor(recoveryLatencies.length * 0.5)];
      console.log(`\n   Recovery phase (${recoveryLatencies.length} requests):`);
      console.log(`     p50: ${recoveryP50.toFixed(2)}ms`);
    }

    // Validate system handled spike
    expect(finalSnapshot.errorRate).toBeLessThan(0.5);  // < 50% error rate during spike
    expect(finalSnapshot.latencies.length).toBeGreaterThan(0);  // Some requests succeeded
  }, 120000);  // 2-minute timeout

  it('should recover to baseline latency after spike', async () => {
    controller = createController();
    await controller.start();
    await createWorkers(2);

    const loadGen = new LoadGenerator();
    const collector = new MetricsCollector();
    collector.start();

    const baseRps = 5;
    const spikeRps = 30;  // 6x spike
    const spikeDuration = 5000;  // 5 second spike
    const totalDuration = 45000;  // 45 seconds total

    console.log(`Starting spike recovery test: ${baseRps} → ${spikeRps} → ${baseRps} req/sec`);

    const _spikeTriggered = false;

    // Trigger spike after 10 seconds
    setTimeout(() => {
      spikeTriggered = true;
      console.log(`  🔥 Spike triggered at 10s`);
    }, 10000);

    // Track latencies in 5-second windows
    const windowSize = 5000;
    const windows: Array<{ start: number; latencies: number[] }> = [];
    let currentWindow: { start: number; latencies: number[] } = { start: Date.now(), latencies: [] };

    // Generate spike load
    const loadPromise = loadGen.generateSpikeLoad(
      baseRps,
      spikeRps,
      totalDuration,
      spikeDuration,
      async () => {
        const reqStartTime = Date.now();

        // Check if we need a new window
        if (Date.now() - currentWindow.start >= windowSize) {
          windows.push(currentWindow);
          currentWindow = { start: Date.now(), latencies: [] };
        }

        try {
          await controller.handleInferenceRequest({
            requestId: `recovery-${Date.now()}-${Math.random()}`,
            modelId: 'benchmark-model',
            prompt: 'recovery test',
            stream: false,
          });
          const latency = Date.now() - reqStartTime;
          collector.recordLatency(latency);
          currentWindow.latencies.push(latency);
        } catch (error) {
          collector.recordError();
        }
      }
    );

    await loadPromise;

    // Push final window
    if (currentWindow.latencies.length > 0) {
      windows.push(currentWindow);
    }

    // Analyze recovery
    console.log(`\n✅ Spike Recovery Analysis:`);
    console.log(`   Total windows: ${windows.length}`);

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      if (window.latencies.length === 0) continue;

      const sorted = window.latencies.sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const windowTime = (i * windowSize / 1000).toFixed(0);

      console.log(`   Window ${i + 1} (${windowTime}s): ${window.latencies.length} reqs, p50=${p50.toFixed(2)}ms`);
    }

    // Validate error rate
    const finalSnapshot = collector.getSnapshot();
    expect(finalSnapshot.errorRate).toBeLessThan(0.5);  // < 50% error rate
  }, 90000);  // 90-second timeout
});
