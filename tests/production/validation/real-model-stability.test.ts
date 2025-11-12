/**
 * Real Model Stability Test
 *
 * Validates system stability with real MLX models:
 * - Long-duration testing (memory leaks detection)
 * - Performance degradation over time
 * - Error rate stability
 * - Resource usage trends
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Real Model Stability Validation', () => {
  const TEST_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit'; // Faster small model
  const monitor = new ResourceMonitor();

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`Real Model Stability Validation`);
    console.log(`Model: ${TEST_MODEL}`);
    console.log(`========================================\n`);
  }, 60000);

  afterAll(() => {
    monitor.stopMonitoring();
    console.log(`\n========================================`);
    console.log(`Stability Validation Complete`);
    console.log(`========================================\n`);
  });

  it('should maintain performance over 30-minute duration', async () => {
    console.log(`\n--- 30-Minute Stability Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 1800000, // 30 minutes
      concurrency: 2,
      warmupDuration: 10000,
      warmupRequests: 3,
      requestsPerSecond: 1, // Light load for long test
    };

    // Start resource monitoring
    monitor.startMonitoring(10000); // Sample every 10 seconds

    const result = await runRealModelBenchmark('30-Min Stability', config);

    // Stop monitoring and analyze
    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ 30-Minute Stability Results:`);
    console.log(`   Duration: ${(result.durationMs / 60000).toFixed(1)} minutes`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    console.log(`\n   Resource Stability:`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);

    // Validate no memory leaks (< 1MB/sec growth)
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(1);

    // Validate stable performance
    expect(result.errorRate).toBeLessThan(0.1); // < 10% error rate
    expect(result.totalRequests).toBeGreaterThan(1500); // At least 1500 requests
  }, 2000000); // 33-minute timeout

  it('should detect memory leaks in short duration', async () => {
    console.log(`\n--- Memory Leak Detection (10 min) ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 600000, // 10 minutes
      concurrency: 3,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 3,
    };

    monitor.reset();
    monitor.startMonitoring(5000); // Sample every 5 seconds

    const result = await runRealModelBenchmark('Memory Leak Detection', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    // Get snapshots for trend analysis
    const snapshots = monitor.getAllSnapshots();
    const memoryUsages = snapshots.map(s => s.memory.rssMb);

    console.log(`\n✅ Memory Leak Detection Results:`);
    console.log(`   Duration: ${(result.durationMs / 60000).toFixed(1)} minutes`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Memory samples: ${memoryUsages.length}`);
    console.log(`   Initial memory: ${memoryUsages[0]}MB`);
    console.log(`   Final memory: ${memoryUsages[memoryUsages.length - 1]}MB`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);
    console.log(`   Total growth: ${(memoryUsages[memoryUsages.length - 1] - memoryUsages[0])}MB`);

    // Validate no significant memory leak
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(2);

    // Total memory growth should be < 200MB over 10 minutes
    const totalGrowth = memoryUsages[memoryUsages.length - 1] - memoryUsages[0];
    expect(totalGrowth).toBeLessThan(200);
  }, 700000); // 12-minute timeout

  it('should maintain stable error rate', async () => {
    console.log(`\n--- Error Rate Stability Test (5 min) ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 300000, // 5 minutes
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 2,
    };

    const result = await runRealModelBenchmark('Error Rate Stability', config);

    console.log(`\n✅ Error Rate Stability Results:`);
    console.log(`   Duration: ${(result.durationMs / 60000).toFixed(1)} minutes`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Successful: ${result.successfulRequests}`);
    console.log(`   Failed: ${result.failedRequests}`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    // Validate stable error rate
    expect(result.errorRate).toBeLessThan(0.15); // < 15% error rate
    expect(result.totalRequests).toBeGreaterThan(500); // At least 500 requests
  }, 400000); // 7-minute timeout
});
