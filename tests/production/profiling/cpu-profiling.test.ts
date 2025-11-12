/**
 * CPU Profiling Test
 *
 * Profiles CPU usage during real model inference:
 * - CPU utilization trends
 * - User vs system time breakdown
 * - CPU efficiency analysis
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('CPU Profiling', () => {
  const TEST_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`CPU Profiling with Real Model`);
    console.log(`Model: ${TEST_MODEL}`);
    console.log(`========================================\n`);
  }, 60000);

  it('should profile CPU usage during inference', async () => {
    console.log(`\n--- CPU Usage Profile ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 120000, // 2 minutes
      concurrency: 2,
      warmupDuration: 10000,
      warmupRequests: 3,
      requestsPerSecond: 2,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(2000); // Sample every 2 seconds

    const result = await runRealModelBenchmark('CPU Profiling', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();
    const snapshots = monitor.getAllSnapshots();

    // Analyze CPU usage over time
    const cpuUsages = snapshots.map(s => s.cpu.totalPercent);
    const userCpuAvg = snapshots.reduce((sum, s) => sum + s.cpu.userPercent, 0) / snapshots.length;
    const systemCpuAvg = snapshots.reduce((sum, s) => sum + s.cpu.systemPercent, 0) / snapshots.length;

    console.log(`\n✅ CPU Profiling Results:`);
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);

    console.log(`\n   CPU Usage:`);
    console.log(`   Average total: ${resourceAnalysis.cpu.avgPercent.toFixed(1)}%`);
    console.log(`   Peak total: ${resourceAnalysis.cpu.peakPercent.toFixed(1)}%`);
    console.log(`   Average user: ${userCpuAvg.toFixed(1)}%`);
    console.log(`   Average system: ${systemCpuAvg.toFixed(1)}%`);
    console.log(`   User/System ratio: ${(userCpuAvg / systemCpuAvg).toFixed(2)}x`);

    console.log(`\n   CPU Efficiency:`);
    const cpuPerRequest = (resourceAnalysis.cpu.avgPercent / result.requestsPerSec);
    console.log(`   CPU % per req/sec: ${cpuPerRequest.toFixed(1)}%`);

    // Validate CPU usage is reasonable
    expect(resourceAnalysis.cpu.avgPercent).toBeGreaterThan(0);
    expect(resourceAnalysis.cpu.peakPercent).toBeLessThan(100);
  }, 180000);

  it('should analyze CPU distribution across load phases', async () => {
    console.log(`\n--- CPU Load Phase Analysis ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 90000, // 90 seconds (3 phases of 30s each)
      concurrency: 1, // Start with low load
      warmupDuration: 5000,
      warmupRequests: 2,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(1000); // Sample every 1 second

    const result = await runRealModelBenchmark('CPU Phase Analysis', config);

    monitor.stopMonitoring();
    const snapshots = monitor.getAllSnapshots();

    // Divide into 3 phases
    const phaseSize = Math.floor(snapshots.length / 3);
    const phase1 = snapshots.slice(0, phaseSize);
    const phase2 = snapshots.slice(phaseSize, phaseSize * 2);
    const phase3 = snapshots.slice(phaseSize * 2);

    const avgCpu = (phase: typeof phase1) =>
      phase.reduce((sum, s) => sum + s.cpu.totalPercent, 0) / phase.length;

    console.log(`\n✅ CPU Phase Analysis:`);
    console.log(`   Phase 1 (early): ${avgCpu(phase1).toFixed(1)}%`);
    console.log(`   Phase 2 (middle): ${avgCpu(phase2).toFixed(1)}%`);
    console.log(`   Phase 3 (late): ${avgCpu(phase3).toFixed(1)}%`);

    // Validate reasonable CPU distribution
    expect(avgCpu(phase1)).toBeGreaterThan(0);
    expect(avgCpu(phase2)).toBeGreaterThan(0);
    expect(avgCpu(phase3)).toBeGreaterThan(0);
  }, 150000);
});
