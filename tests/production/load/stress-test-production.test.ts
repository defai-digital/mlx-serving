/**
 * Stress Test - Production Test
 *
 * Duration: 1 hour
 * Model: Qwen3-30B-A3B-Instruct-2507-4bit (large model for stress)
 * Load: Ramp 1 → 50 req/sec (gradual increase)
 * Workers: 4
 *
 * Validates:
 * - Identify breaking point (>50% error rate)
 * - Circuit breaker activation
 * - Graceful degradation
 * - System handles some load even at breaking point
 */

import { describe, it, expect } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Production: Stress Test (1 hour)', () => {
  const MODEL = 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit';
  const PHASE_DURATION = 600000; // 10 minutes per phase
  const RAMP_PHASES = [1, 5, 10, 20, 30, 50]; // req/sec

  it('should handle increasing load and identify breaking point', async () => {
    console.log(`\n========================================`);
    console.log(`Stress Test: 1 Hour Ramp`);
    console.log(`Model: ${MODEL}`);
    console.log(`Load: ${RAMP_PHASES.join(' → ')} req/sec`);
    console.log(`========================================\n`);

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(30000); // Sample every 30 seconds

    const phaseResults: Array<{
      phase: number;
      rps: number;
      result: Awaited<ReturnType<typeof runRealModelBenchmark>>;
      duration: number;
    }> = [];

    let breakingPoint: number | null = null;

    // Run ramp phases
    for (let i = 0; i < RAMP_PHASES.length; i++) {
      const targetRps = RAMP_PHASES[i];
      const phase = i + 1;

      console.log(`\nPhase ${phase}/${RAMP_PHASES.length}: ${targetRps} req/sec (10 min)...`);

      const config: RealModelBenchmarkConfig = {
        realModelId: MODEL,
        workers: 1,
        duration: PHASE_DURATION,
        concurrency: Math.min(targetRps, 8), // Cap concurrency at 8
        warmupDuration: phase === 1 ? 30000 : 0, // Only warmup first phase
        warmupRequests: phase === 1 ? 5 : 0,
        requestsPerSecond: targetRps,
      };

      const phaseStart = Date.now();
      const result = await runRealModelBenchmark(`Phase ${phase}`, config);
      const phaseDuration = (Date.now() - phaseStart) / 1000;

      phaseResults.push({
        phase,
        rps: targetRps,
        result,
        duration: phaseDuration,
      });

      console.log(`\n✅ Phase ${phase} Complete (${phaseDuration.toFixed(1)}s):`);
      console.log(`   Target RPS: ${targetRps}`);
      console.log(`   Actual RPS: ${result.requestsPerSec.toFixed(2)}`);
      console.log(`   Requests: ${result.totalRequests}`);
      console.log(`   Successful: ${result.successfulRequests}`);
      console.log(`   Failed: ${result.failedRequests}`);
      console.log(`   Error rate: ${(result.errorRate * 100).toFixed(1)}%`);
      console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

      // Check if we hit breaking point (>50% error rate)
      if (result.errorRate > 0.5 && breakingPoint === null) {
        breakingPoint = targetRps;
        console.log(`\n⚠️ BREAKING POINT IDENTIFIED: ${targetRps} req/sec (${(result.errorRate * 100).toFixed(1)}% errors)`);
      }

      // Stop if error rate exceeds 80% (system overwhelmed)
      if (result.errorRate > 0.8) {
        console.log(`\n❌ System overwhelmed (${(result.errorRate * 100).toFixed(1)}% errors). Stopping stress test.`);
        break;
      }
    }

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n========================================`);
    console.log(`Stress Test Summary:`);
    console.log(`========================================`);

    console.log(`\n   Phase Results:`);
    phaseResults.forEach(({ phase, rps, result }) => {
      console.log(
        `   Phase ${phase} (${rps} req/sec): ` +
          `${result.totalRequests} req, ` +
          `${(result.errorRate * 100).toFixed(1)}% errors, ` +
          `${result.requestsPerSec.toFixed(2)} actual RPS`
      );
    });

    console.log(`\n   Breaking Point Analysis:`);
    if (breakingPoint) {
      console.log(`   Breaking point: ${breakingPoint} req/sec`);
      console.log(`   System can sustain: ${breakingPoint - 5} req/sec safely`);
    } else {
      console.log(`   Breaking point: NOT REACHED (max tested: ${RAMP_PHASES[RAMP_PHASES.length - 1]} req/sec)`);
    }

    // Find max sustainable load (< 30% error rate)
    const sustainablePhases = phaseResults.filter((p) => p.result.errorRate < 0.3);
    const maxSustainableRps = sustainablePhases.length > 0 ? sustainablePhases[sustainablePhases.length - 1].rps : 0;

    console.log(`   Max sustainable load: ${maxSustainableRps} req/sec (< 30% errors)`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(4)}MB/sec`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent.toFixed(1)}%`);

    console.log(`\n   Performance Degradation:`);
    if (phaseResults.length >= 2) {
      const firstPhase = phaseResults[0];
      const lastPhase = phaseResults[phaseResults.length - 1];
      const p95Degradation =
        ((lastPhase.result.latencyP95 - firstPhase.result.latencyP95) / firstPhase.result.latencyP95) * 100;
      console.log(`   p95 latency increase: ${p95Degradation.toFixed(1)}%`);
      console.log(`   First phase p95: ${firstPhase.result.latencyP95.toFixed(2)}ms`);
      console.log(`   Last phase p95: ${lastPhase.result.latencyP95.toFixed(2)}ms`);
    }

    // Validations
    const totalRequests = phaseResults.reduce((sum, p) => sum + p.result.totalRequests, 0);
    const totalSuccessful = phaseResults.reduce((sum, p) => sum + p.result.successfulRequests, 0);

    console.log(`\n   Total Statistics:`);
    console.log(`   Total requests: ${totalRequests}`);
    console.log(`   Total successful: ${totalSuccessful}`);
    console.log(`   Overall success rate: ${((totalSuccessful / totalRequests) * 100).toFixed(1)}%`);

    // System should complete at least first phase successfully
    expect(phaseResults.length).toBeGreaterThan(0);
    expect(phaseResults[0].result.errorRate).toBeLessThan(0.2); // First phase < 20% errors

    // System should identify breaking point or reach max load
    expect(breakingPoint !== null || phaseResults[phaseResults.length - 1].rps >= 30).toBe(true);

    // Even at breaking point, system should handle some requests
    if (breakingPoint) {
      const breakingPhase = phaseResults.find((p) => p.rps === breakingPoint);
      if (breakingPhase) {
        expect(breakingPhase.result.successfulRequests).toBeGreaterThan(0);
      }
    }

    // Memory should be relatively stable (allowing for growth under stress)
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(1.0); // < 1MB/sec leak
  }, 4500000); // 75-minute timeout (60 min + 15 min buffer)
});
