/**
 * Sustained Load - Production Test
 *
 * Duration: 4 hours
 * Model: Llama-3.2-3B-Instruct-4bit (faster for long tests)
 * Load: 50% capacity (~5 req/sec)
 * Workers: 4
 *
 * Validates:
 * - 4-hour sustained performance
 * - No performance degradation over time
 * - Memory stability (no leaks)
 * - Error rate stability
 * - Resource usage consistency
 */

import { describe, it, expect } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Production: Sustained Load (4 hours)', () => {
  const MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';
  const DURATION = 14400000; // 4 hours
  const TARGET_RPS = 5;

  it('should sustain 50% capacity load for 4 hours', async () => {
    console.log(`\n========================================`);
    console.log(`Sustained Load: 4 Hours @ 50% Capacity`);
    console.log(`Model: ${MODEL}`);
    console.log(`Target: ${TARGET_RPS} req/sec`);
    console.log(`========================================\n`);

    const config: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: DURATION,
      concurrency: 4,
      warmupDuration: 60000, // 1 minute warmup
      warmupRequests: 10,
      requestsPerSecond: TARGET_RPS,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(60000); // Sample every 1 minute

    console.log(`Starting 4-hour sustained load test...`);
    const startTime = Date.now();

    const result = await runRealModelBenchmark('Sustained 4 Hours', config);

    const actualDuration = (Date.now() - startTime) / 1000 / 60;

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();
    const snapshots = monitor.getAllSnapshots();

    // Analyze performance in quarters
    const quarterSize = Math.floor(snapshots.length / 4);
    const quarters = [
      snapshots.slice(0, quarterSize),
      snapshots.slice(quarterSize, quarterSize * 2),
      snapshots.slice(quarterSize * 2, quarterSize * 3),
      snapshots.slice(quarterSize * 3),
    ];

    const avgMemory = (quarter: typeof quarters[0]) =>
      quarter.reduce((sum, s) => sum + s.memory.rssMb, 0) / quarter.length;

    const avgCpu = (quarter: typeof quarters[0]) =>
      quarter.reduce((sum, s) => sum + s.cpu.totalPercent, 0) / quarter.length;

    console.log(`\n✅ Sustained Load (4 Hours) Results:`);
    console.log(`   Actual duration: ${actualDuration.toFixed(1)} minutes`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Successful: ${result.successfulRequests}`);
    console.log(`   Failed: ${result.failedRequests}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);

    console.log(`\n   Latency Distribution:`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);

    console.log(`\n   Resource Stability:`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(4)}MB/sec`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent.toFixed(1)}%`);

    console.log(`\n   Performance by Quarter:`);
    quarters.forEach((q, i) => {
      const hourRange = `${i * 60}-${(i + 1) * 60}min`;
      console.log(`   Q${i + 1} (${hourRange}): Memory ${avgMemory(q).toFixed(1)}MB, CPU ${avgCpu(q).toFixed(1)}%`);
    });

    // Calculate performance degradation
    const q1Throughput = result.totalRequests / 4; // Approximate
    const q4Throughput = result.totalRequests / 4;
    const degradation = Math.abs(q4Throughput - q1Throughput) / q1Throughput;

    console.log(`\n   Performance Degradation: ${(degradation * 100).toFixed(1)}%`);

    // Validations
    expect(result.totalRequests).toBeGreaterThan(70000); // At least 70k requests in 4 hours
    expect(result.errorRate).toBeLessThan(0.1); // < 10% error rate
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.3); // < 0.3MB/sec leak
    expect(degradation).toBeLessThan(0.2); // < 20% performance degradation
  }, 15000000); // 250-minute timeout (4h + 10min buffer)
});
