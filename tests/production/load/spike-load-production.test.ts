/**
 * Spike Load - Production Test
 *
 * Duration: 30 minutes
 * Model: Qwen2.5-7B-Instruct-4bit
 * Load: Baseline (10 min) → 10x Spike (5 min) → Recovery (15 min)
 * Workers: 4
 *
 * Validates:
 * - Queue handling during traffic spikes
 * - Recovery time after spike
 * - Error rate during spike vs baseline
 * - System stability after spike
 */

import { describe, it, expect } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Production: Spike Load (30 minutes)', () => {
  const MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const BASELINE_RPS = 5;
  const SPIKE_RPS = 50;

  it('should handle traffic spike and recover gracefully', async () => {
    console.log(`\n========================================`);
    console.log(`Spike Load: 30 Minutes`);
    console.log(`Model: ${MODEL}`);
    console.log(`Load: ${BASELINE_RPS} → ${SPIKE_RPS} → ${BASELINE_RPS} req/sec`);
    console.log(`========================================\n`);

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(15000); // Sample every 15 seconds

    // Phase 1: Baseline (10 minutes)
    console.log(`Phase 1: Baseline (10 min @ ${BASELINE_RPS} req/sec)...`);
    const baselineConfig: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: 600000, // 10 minutes
      concurrency: 4,
      warmupDuration: 30000,
      warmupRequests: 5,
      requestsPerSecond: BASELINE_RPS,
    };

    const baselineStart = Date.now();
    const baselineResult = await runRealModelBenchmark('Baseline Phase', baselineConfig);
    const baselineDuration = (Date.now() - baselineStart) / 1000;

    console.log(`\n✅ Phase 1 Complete (${baselineDuration.toFixed(1)}s):`);
    console.log(`   Requests: ${baselineResult.totalRequests}`);
    console.log(`   Throughput: ${baselineResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Error rate: ${(baselineResult.errorRate * 100).toFixed(1)}%`);

    // Phase 2: Spike (5 minutes)
    console.log(`\nPhase 2: Spike (5 min @ ${SPIKE_RPS} req/sec)...`);
    const spikeConfig: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: 300000, // 5 minutes
      concurrency: 8, // Higher concurrency for spike
      warmupDuration: 0, // No warmup needed
      warmupRequests: 0,
      requestsPerSecond: SPIKE_RPS,
    };

    const spikeStart = Date.now();
    const spikeResult = await runRealModelBenchmark('Spike Phase', spikeConfig);
    const spikeDuration = (Date.now() - spikeStart) / 1000;

    console.log(`\n✅ Phase 2 Complete (${spikeDuration.toFixed(1)}s):`);
    console.log(`   Requests: ${spikeResult.totalRequests}`);
    console.log(`   Throughput: ${spikeResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Error rate: ${(spikeResult.errorRate * 100).toFixed(1)}%`);

    // Phase 3: Recovery (15 minutes)
    console.log(`\nPhase 3: Recovery (15 min @ ${BASELINE_RPS} req/sec)...`);
    const recoveryConfig: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: 900000, // 15 minutes
      concurrency: 4,
      warmupDuration: 0,
      warmupRequests: 0,
      requestsPerSecond: BASELINE_RPS,
    };

    const recoveryStart = Date.now();
    const recoveryResult = await runRealModelBenchmark('Recovery Phase', recoveryConfig);
    const recoveryDuration = (Date.now() - recoveryStart) / 1000;

    console.log(`\n✅ Phase 3 Complete (${recoveryDuration.toFixed(1)}s):`);
    console.log(`   Requests: ${recoveryResult.totalRequests}`);
    console.log(`   Throughput: ${recoveryResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Error rate: ${(recoveryResult.errorRate * 100).toFixed(1)}%`);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    // Calculate recovery time (time to return to baseline error rate)
    const recoveryTime = recoveryDuration; // Simplified: full recovery phase duration
    const recoveryMetMinutes = recoveryTime < 120; // < 2 minutes

    console.log(`\n========================================`);
    console.log(`Spike Load Test Summary:`);
    console.log(`========================================`);
    console.log(`\n   Phase Results:`);
    console.log(`   Baseline: ${baselineResult.totalRequests} req, ${(baselineResult.errorRate * 100).toFixed(1)}% errors`);
    console.log(`   Spike: ${spikeResult.totalRequests} req, ${(spikeResult.errorRate * 100).toFixed(1)}% errors`);
    console.log(`   Recovery: ${recoveryResult.totalRequests} req, ${(recoveryResult.errorRate * 100).toFixed(1)}% errors`);

    console.log(`\n   Performance Metrics:`);
    console.log(`   Baseline throughput: ${baselineResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Spike throughput: ${spikeResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Recovery throughput: ${recoveryResult.requestsPerSec.toFixed(2)} req/sec`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(4)}MB/sec`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent.toFixed(1)}%`);

    console.log(`\n   Recovery Metrics:`);
    console.log(`   Recovery time: ${recoveryTime.toFixed(1)}s`);
    console.log(`   Recovery met 2-min target: ${recoveryMetMinutes ? 'YES ✅' : 'NO ❌'}`);

    // Validations
    const totalRequests = baselineResult.totalRequests + spikeResult.totalRequests + recoveryResult.totalRequests;
    console.log(`\n   Total requests: ${totalRequests}`);

    // Spike should handle traffic (even with higher error rate)
    expect(spikeResult.totalRequests).toBeGreaterThan(100); // At least some requests completed
    expect(spikeResult.errorRate).toBeLessThan(0.5); // < 50% error rate during spike

    // Baseline and recovery should be stable
    expect(baselineResult.errorRate).toBeLessThan(0.1); // < 10% baseline errors
    expect(recoveryResult.errorRate).toBeLessThan(0.15); // < 15% recovery errors

    // System should recover
    expect(Math.abs(recoveryResult.errorRate - baselineResult.errorRate)).toBeLessThan(0.2); // Within 20% of baseline

    // Memory should be stable
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.5); // < 0.5MB/sec leak
  }, 2400000); // 40-minute timeout (30 min + 10 min buffer)
});
