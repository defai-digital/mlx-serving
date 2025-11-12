/**
 * Real Model Latency Test
 *
 * Validates latency distribution with real MLX models:
 * - Measures p50, p95, p99, p99.9 latencies
 * - Tests under varying load conditions
 * - Validates SLA compliance
 * - Identifies latency outliers
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';

describe('Real Model Latency Validation', () => {
  const TEST_MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`Real Model Latency Validation`);
    console.log(`Model: ${TEST_MODEL}`);
    console.log(`========================================\n`);
  }, 60000);

  afterAll(() => {
    console.log(`\n========================================`);
    console.log(`Latency Validation Complete`);
    console.log(`========================================\n`);
  });

  it('should measure latency under low load', async () => {
    console.log(`\n--- Low Load Latency Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 1, // Sequential requests
      warmupDuration: 10000,
      warmupRequests: 3,
    };

    const result = await runRealModelBenchmark('Low Load Latency', config);

    console.log(`\n✅ Low Load Latency Results:`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);
    console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    // Validate low latency under minimal load
    expect(result.latencyP50).toBeLessThan(5000); // p50 < 5s
    expect(result.latencyP95).toBeLessThan(10000); // p95 < 10s
    expect(result.errorRate).toBeLessThan(0.05); // < 5% error rate
  }, 120000);

  it('should measure latency under medium load', async () => {
    console.log(`\n--- Medium Load Latency Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 3, // 3 concurrent requests
      warmupDuration: 5000,
      warmupRequests: 3,
      requestsPerSecond: 3,
    };

    const result = await runRealModelBenchmark('Medium Load Latency', config);

    console.log(`\n✅ Medium Load Latency Results:`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);
    console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    // Validate acceptable latency under medium load
    expect(result.latencyP50).toBeLessThan(8000); // p50 < 8s
    expect(result.latencyP95).toBeLessThan(15000); // p95 < 15s
    expect(result.errorRate).toBeLessThan(0.1); // < 10% error rate
  }, 120000);

  it('should measure latency under high load', async () => {
    console.log(`\n--- High Load Latency Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 5, // 5 concurrent requests
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 5,
    };

    const result = await runRealModelBenchmark('High Load Latency', config);

    console.log(`\n✅ High Load Latency Results:`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);
    console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    // Validate degradation under high load
    expect(result.latencyP50).toBeLessThan(12000); // p50 < 12s
    expect(result.latencyP95).toBeLessThan(25000); // p95 < 25s
    expect(result.errorRate).toBeLessThan(0.2); // < 20% error rate
  }, 120000);

  it('should validate SLA compliance', async () => {
    console.log(`\n--- SLA Compliance Test ---`);

    // Define SLA targets
    const SLA = {
      p50Target: 5000,  // 5 seconds
      p95Target: 12000, // 12 seconds
      p99Target: 20000, // 20 seconds
      errorRateTarget: 0.05, // 5%
    };

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 120000, // 2 minutes for more reliable stats
      concurrency: 2,
      warmupDuration: 10000,
      warmupRequests: 3,
      requestsPerSecond: 2,
    };

    const result = await runRealModelBenchmark('SLA Compliance', config);

    const slaCompliance = {
      p50: result.latencyP50 <= SLA.p50Target,
      p95: result.latencyP95 <= SLA.p95Target,
      p99: result.latencyP99 <= SLA.p99Target,
      errorRate: result.errorRate <= SLA.errorRateTarget,
    };

    const allSLAsMet = Object.values(slaCompliance).every(met => met);

    console.log(`\n✅ SLA Compliance Results:`);
    console.log(`   Target p50: ${SLA.p50Target}ms → Actual: ${result.latencyP50.toFixed(2)}ms ${slaCompliance.p50 ? '✅' : '❌'}`);
    console.log(`   Target p95: ${SLA.p95Target}ms → Actual: ${result.latencyP95.toFixed(2)}ms ${slaCompliance.p95 ? '✅' : '❌'}`);
    console.log(`   Target p99: ${SLA.p99Target}ms → Actual: ${result.latencyP99.toFixed(2)}ms ${slaCompliance.p99 ? '✅' : '❌'}`);
    console.log(`   Target error rate: ${(SLA.errorRateTarget * 100).toFixed(1)}% → Actual: ${(result.errorRate * 100).toFixed(2)}% ${slaCompliance.errorRate ? '✅' : '❌'}`);
    console.log(`\n   Overall SLA Compliance: ${allSLAsMet ? '✅ PASS' : '❌ FAIL'}`);

    // At least p95 and error rate should meet SLA
    expect(slaCompliance.p95).toBe(true);
    expect(slaCompliance.errorRate).toBe(true);
  }, 180000);

  it('should identify latency outliers', async () => {
    console.log(`\n--- Latency Outlier Detection ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 2,
    };

    const result = await runRealModelBenchmark('Outlier Detection', config);

    // Calculate outlier metrics
    const p99_p95_ratio = result.latencyP99 / result.latencyP95;
    const p999_p99_ratio = result.latencyP999 / result.latencyP99;

    console.log(`\n✅ Outlier Analysis:`);
    console.log(`   p50: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   p99: ${result.latencyP99.toFixed(2)}ms`);
    console.log(`   p99.9: ${result.latencyP999.toFixed(2)}ms`);
    console.log(`\n   p99/p95 ratio: ${p99_p95_ratio.toFixed(2)}x`);
    console.log(`   p99.9/p99 ratio: ${p999_p99_ratio.toFixed(2)}x`);

    // Validate reasonable outlier distribution
    // p99 should not be more than 3x p95
    expect(p99_p95_ratio).toBeLessThan(3);

    // p99.9 should not be more than 5x p99
    expect(p999_p99_ratio).toBeLessThan(5);
  }, 120000);
});
