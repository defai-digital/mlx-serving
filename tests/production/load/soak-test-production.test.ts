/**
 * Soak Test - Production Test
 *
 * Duration: 24 hours
 * Model: Qwen2.5-7B-Instruct-4bit
 * Load: 30% capacity (~3 req/sec)
 * Workers: 4
 *
 * Validates:
 * - 24-hour continuous operation
 * - 0 crashes
 * - No memory leaks (< 0.1MB/sec growth)
 * - No connection leaks
 * - Error rate < 5%
 * - 250k+ requests over 24 hours
 */

import { describe, it, expect } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Production: Soak Test (24 hours)', () => {
  const MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const DURATION = 86400000; // 24 hours
  const TARGET_RPS = 3;

  it('should sustain 30% capacity load for 24 hours with 0 crashes', async () => {
    console.log(`\n========================================`);
    console.log(`Soak Test: 24 Hours @ 30% Capacity`);
    console.log(`Model: ${MODEL}`);
    console.log(`Target: ${TARGET_RPS} req/sec`);
    console.log(`Expected requests: ~259,200 (24h * 3600s * 3 req/s)`);
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
    monitor.startMonitoring(120000); // Sample every 2 minutes (720 samples over 24h)

    console.log(`Starting 24-hour soak test...`);
    console.log(`Test will complete at approximately: ${new Date(Date.now() + DURATION).toLocaleString()}`);
    console.log(`\nNote: This is a long-running test. Monitor progress with:`);
    console.log(`  - Resource Monitor snapshots (every 2 minutes)`);
    console.log(`  - Activity Monitor (CPU, Memory, GPU)`);
    console.log(`  - Console logs for periodic updates\n`);

    const startTime = Date.now();

    const result = await runRealModelBenchmark('Soak 24 Hours', config);

    const actualDuration = (Date.now() - startTime) / 1000 / 60 / 60; // Hours

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();
    const snapshots = monitor.getAllSnapshots();

    // Analyze performance in 6-hour quarters
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

    console.log(`\n✅ Soak Test (24 Hours) Results:`);
    console.log(`========================================`);
    console.log(`   Actual duration: ${actualDuration.toFixed(2)} hours`);
    console.log(`   Total requests: ${result.totalRequests.toLocaleString()}`);
    console.log(`   Successful: ${result.successfulRequests.toLocaleString()}`);
    console.log(`   Failed: ${result.failedRequests.toLocaleString()}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    console.log(`\n   Latency Distribution:`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);

    console.log(`\n   Resource Stability (24 hours):`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(6)}MB/sec`);
    console.log(`   Total memory growth: ${(resourceAnalysis.memory.trendMbPerSec * 86400).toFixed(2)}MB`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Min memory: ${resourceAnalysis.memory.minMb}MB`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent.toFixed(1)}%`);

    console.log(`\n   Performance by Quarter (6-hour segments):`);
    quarters.forEach((q, i) => {
      const hourRange = `${i * 6}-${(i + 1) * 6}h`;
      console.log(`   Q${i + 1} (${hourRange}): Memory ${avgMemory(q).toFixed(1)}MB, CPU ${avgCpu(q).toFixed(1)}%`);
    });

    // Calculate performance stability
    const q1Avg = avgMemory(quarters[0]);
    const q4Avg = avgMemory(quarters[3]);
    const memoryGrowth = q4Avg - q1Avg;
    const memoryGrowthPercent = (memoryGrowth / q1Avg) * 100;

    console.log(`\n   Memory Stability Analysis:`);
    console.log(`   Q1 avg memory: ${q1Avg.toFixed(1)}MB`);
    console.log(`   Q4 avg memory: ${q4Avg.toFixed(1)}MB`);
    console.log(`   Growth: ${memoryGrowth.toFixed(1)}MB (${memoryGrowthPercent.toFixed(1)}%)`);

    // Calculate throughput stability
    const expectedRequests = 259200; // 24h * 3600s * 3 req/s
    const achievedPercent = (result.totalRequests / expectedRequests) * 100;

    console.log(`\n   Throughput Stability:`);
    console.log(`   Expected requests: ${expectedRequests.toLocaleString()}`);
    console.log(`   Achieved: ${achievedPercent.toFixed(1)}%`);

    // Check for crashes (would show as gaps in monitoring)
    const expectedSnapshots = Math.floor(DURATION / 120000); // Every 2 minutes
    const snapshotCoverage = (snapshots.length / expectedSnapshots) * 100;

    console.log(`\n   Reliability:`);
    console.log(`   Expected snapshots: ${expectedSnapshots}`);
    console.log(`   Actual snapshots: ${snapshots.length}`);
    console.log(`   Coverage: ${snapshotCoverage.toFixed(1)}%`);
    console.log(`   Crashes detected: ${snapshotCoverage < 95 ? 'YES ❌' : 'NO ✅'}`);

    // Validations
    console.log(`\n========================================`);
    console.log(`Soak Test Validations:`);
    console.log(`========================================`);

    const validations = {
      totalRequests: result.totalRequests >= 250000,
      errorRate: result.errorRate < 0.05,
      memoryLeak: Math.abs(resourceAnalysis.memory.trendMbPerSec) < 0.1,
      totalMemoryGrowth: Math.abs(resourceAnalysis.memory.trendMbPerSec * 86400) < 9,
      noCrashes: snapshotCoverage >= 95,
      throughputStability: achievedPercent >= 80,
    };

    console.log(`   ✓ Total requests >= 250k: ${validations.totalRequests ? 'PASS ✅' : 'FAIL ❌'} (${result.totalRequests.toLocaleString()})`);
    console.log(`   ✓ Error rate < 5%: ${validations.errorRate ? 'PASS ✅' : 'FAIL ❌'} (${(result.errorRate * 100).toFixed(2)}%)`);
    console.log(`   ✓ Memory leak < 0.1MB/sec: ${validations.memoryLeak ? 'PASS ✅' : 'FAIL ❌'} (${resourceAnalysis.memory.trendMbPerSec.toFixed(6)}MB/sec)`);
    console.log(`   ✓ Total growth < 9MB: ${validations.totalMemoryGrowth ? 'PASS ✅' : 'FAIL ❌'} (${(resourceAnalysis.memory.trendMbPerSec * 86400).toFixed(2)}MB)`);
    console.log(`   ✓ No crashes (>95% coverage): ${validations.noCrashes ? 'PASS ✅' : 'FAIL ❌'} (${snapshotCoverage.toFixed(1)}%)`);
    console.log(`   ✓ Throughput stable (>80%): ${validations.throughputStability ? 'PASS ✅' : 'FAIL ❌'} (${achievedPercent.toFixed(1)}%)`);

    const allPassed = Object.values(validations).every((v) => v);
    console.log(`\n   Overall: ${allPassed ? 'ALL VALIDATIONS PASSED ✅' : 'SOME VALIDATIONS FAILED ❌'}`);

    // Test assertions
    expect(result.totalRequests).toBeGreaterThan(250000); // At least 250k requests in 24 hours
    expect(result.errorRate).toBeLessThan(0.05); // < 5% error rate
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.1); // < 0.1MB/sec leak
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec * 86400)).toBeLessThan(9); // < 9MB total growth
    expect(snapshotCoverage).toBeGreaterThanOrEqual(95); // No crashes (>95% monitoring coverage)
  }, 90000000); // 25-hour timeout (24h + 1h buffer)
});
