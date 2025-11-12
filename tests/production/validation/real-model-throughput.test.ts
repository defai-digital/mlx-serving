/**
 * Real Model Throughput Test
 *
 * Validates actual throughput with real MLX models:
 * - Qwen2.5-7B-Instruct-4bit (small model)
 * - Measures real requests/second
 * - Validates sustained performance
 * - Monitors resource usage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Real Model Throughput Validation', () => {
  const TEST_MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const monitor = new ResourceMonitor();

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`Real Model Throughput Validation`);
    console.log(`Model: ${TEST_MODEL}`);
    console.log(`========================================\n`);
  }, 60000);

  afterAll(() => {
    monitor.stopMonitoring();
    console.log(`\n========================================`);
    console.log(`Throughput Validation Complete`);
    console.log(`========================================\n`);
  });

  it('should measure baseline throughput with real model', async () => {
    console.log(`\n--- Baseline Throughput Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 1,
      warmupDuration: 10000, // 10 seconds
      warmupRequests: 5,
    };

    // Start resource monitoring
    monitor.startMonitoring(2000); // Sample every 2 seconds

    const result = await runRealModelBenchmark('Baseline Throughput', config);

    // Stop monitoring and analyze
    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Baseline Throughput Results:`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99 latency: ${result.latencyP99.toFixed(2)}ms`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec}MB/sec`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent}%`);
    console.log(`   Peak CPU: ${resourceAnalysis.cpu.peakPercent}%`);

    // Validate results
    expect(result.requestsPerSec).toBeGreaterThan(0);
    expect(result.errorRate).toBeLessThan(0.1); // < 10% error rate
    expect(result.latencyP95).toBeLessThan(10000); // p95 < 10s for small model

    // Resource validation
    expect(resourceAnalysis.memory.trendMbPerSec).toBeLessThan(10); // < 10MB/sec leak
  }, 120000); // 2-minute timeout

  it('should measure sustained throughput over 5 minutes', async () => {
    console.log(`\n--- Sustained Throughput Test (5 min) ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 300000, // 5 minutes
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 3,
      requestsPerSecond: 2, // Rate limiting
    };

    monitor.reset();
    monitor.startMonitoring(5000); // Sample every 5 seconds

    const result = await runRealModelBenchmark('Sustained Throughput', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Sustained Throughput Results:`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec}MB/sec`);

    // Validate sustained performance
    expect(result.requestsPerSec).toBeGreaterThan(1); // At least 1 req/sec
    expect(result.errorRate).toBeLessThan(0.15); // < 15% error rate
    expect(result.totalRequests).toBeGreaterThan(500); // At least 500 requests in 5 min

    // Validate no significant memory leak
    expect(resourceAnalysis.memory.trendMbPerSec).toBeLessThan(5); // < 5MB/sec
  }, 360000); // 6-minute timeout

  it('should handle concurrent requests efficiently', async () => {
    console.log(`\n--- Concurrent Throughput Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 4, // 4 concurrent requests
      warmupDuration: 5000,
      warmupRequests: 3,
      requestsPerSecond: 4,
    };

    monitor.reset();
    monitor.startMonitoring(2000);

    const result = await runRealModelBenchmark('Concurrent Throughput', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Concurrent Throughput Results:`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99 latency: ${result.latencyP99.toFixed(2)}ms`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Peak CPU: ${resourceAnalysis.cpu.peakPercent}%`);

    // Validate concurrent performance
    expect(result.requestsPerSec).toBeGreaterThan(2); // At least 2 req/sec with concurrency
    expect(result.errorRate).toBeLessThan(0.2); // < 20% error rate
    expect(result.latencyP95).toBeLessThan(15000); // p95 < 15s
  }, 120000);

  it('should validate throughput consistency across multiple runs', async () => {
    console.log(`\n--- Throughput Consistency Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 30000, // 30 seconds per run
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 2,
    };

    const throughputs: number[] = [];
    const numRuns = 3;

    for (let i = 0; i < numRuns; i++) {
      console.log(`\nRun ${i + 1}/${numRuns}`);

      const result = await runRealModelBenchmark(`Consistency Run ${i + 1}`, config);
      throughputs.push(result.requestsPerSec);

      console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
      console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

      // Short delay between runs
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Calculate coefficient of variation
    const avgThroughput = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
    const variance = throughputs.reduce((acc, t) => acc + Math.pow(t - avgThroughput, 2), 0) / throughputs.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = (stdDev / avgThroughput) * 100;

    console.log(`\n✅ Consistency Analysis:`);
    console.log(`   Throughputs: ${throughputs.map(t => t.toFixed(2)).join(', ')} req/sec`);
    console.log(`   Average: ${avgThroughput.toFixed(2)} req/sec`);
    console.log(`   Std Dev: ${stdDev.toFixed(2)} req/sec`);
    console.log(`   CV: ${coefficientOfVariation.toFixed(1)}%`);

    // Validate consistency (CV < 30% is acceptable)
    expect(coefficientOfVariation).toBeLessThan(30);
  }, 180000); // 3-minute timeout
});
