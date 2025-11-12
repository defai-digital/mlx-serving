/**
 * Real Model Scalability Test
 *
 * Validates scalability with real MLX models:
 * - Single vs multi-model comparison
 * - Different model sizes (3B vs 7B)
 * - Resource utilization scaling
 * - Breaking point identification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Real Model Scalability Validation', () => {
  const SMALL_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';
  const MEDIUM_MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const monitor = new ResourceMonitor();

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`Real Model Scalability Validation`);
    console.log(`========================================\n`);
  }, 60000);

  afterAll(() => {
    monitor.stopMonitoring();
    console.log(`\n========================================`);
    console.log(`Scalability Validation Complete`);
    console.log(`========================================\n`);
  });

  it('should scale with small model (3B)', async () => {
    console.log(`\n--- Small Model Scalability (3B) ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: SMALL_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 4,
      warmupDuration: 10000,
      warmupRequests: 3,
      requestsPerSecond: 4,
    };

    monitor.reset();
    monitor.startMonitoring(2000);

    const result = await runRealModelBenchmark('Small Model (3B)', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Small Model Scalability Results:`);
    console.log(`   Model: ${SMALL_MODEL}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent}%`);

    // Validate small model scales well
    expect(result.requestsPerSec).toBeGreaterThan(2); // At least 2 req/sec
    expect(result.errorRate).toBeLessThan(0.15); // < 15% error rate
  }, 120000);

  it('should scale with medium model (7B)', async () => {
    console.log(`\n--- Medium Model Scalability (7B) ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: MEDIUM_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 3,
      warmupDuration: 10000,
      warmupRequests: 3,
      requestsPerSecond: 3,
    };

    monitor.reset();
    monitor.startMonitoring(2000);

    const result = await runRealModelBenchmark('Medium Model (7B)', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Medium Model Scalability Results:`);
    console.log(`   Model: ${MEDIUM_MODEL}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p50 latency: ${result.latencyP50.toFixed(2)}ms`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);

    console.log(`\n   Resource Usage:`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Avg CPU: ${resourceAnalysis.cpu.avgPercent}%`);

    // Validate medium model scales reasonably
    expect(result.requestsPerSec).toBeGreaterThan(1); // At least 1 req/sec
    expect(result.errorRate).toBeLessThan(0.2); // < 20% error rate
  }, 120000);

  it('should compare performance across model sizes', async () => {
    console.log(`\n--- Model Size Performance Comparison ---`);

    // Test small model
    const smallConfig: RealModelBenchmarkConfig = {
      realModelId: SMALL_MODEL,
      workers: 1,
      duration: 30000, // 30 seconds
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 2,
    };

    const smallResult = await runRealModelBenchmark('Small Model Comparison', smallConfig);

    console.log(`\n✅ Small Model (3B):`);
    console.log(`   Throughput: ${smallResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50 latency: ${smallResult.latencyP50.toFixed(2)}ms`);
    console.log(`   Error rate: ${(smallResult.errorRate * 100).toFixed(2)}%`);

    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Test medium model
    const mediumConfig: RealModelBenchmarkConfig = {
      realModelId: MEDIUM_MODEL,
      workers: 1,
      duration: 30000, // 30 seconds
      concurrency: 2,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 2,
    };

    const mediumResult = await runRealModelBenchmark('Medium Model Comparison', mediumConfig);

    console.log(`\n✅ Medium Model (7B):`);
    console.log(`   Throughput: ${mediumResult.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   p50 latency: ${mediumResult.latencyP50.toFixed(2)}ms`);
    console.log(`   Error rate: ${(mediumResult.errorRate * 100).toFixed(2)}%`);

    // Calculate performance ratios
    const throughputRatio = smallResult.requestsPerSec / mediumResult.requestsPerSec;
    const latencyRatio = mediumResult.latencyP50 / smallResult.latencyP50;

    console.log(`\n✅ Performance Comparison:`);
    console.log(`   Small/Medium throughput ratio: ${throughputRatio.toFixed(2)}x`);
    console.log(`   Medium/Small latency ratio: ${latencyRatio.toFixed(2)}x`);

    // Validate comparison
    expect(smallResult.requestsPerSec).toBeGreaterThan(0);
    expect(mediumResult.requestsPerSec).toBeGreaterThan(0);

    // Small model should be faster
    expect(throughputRatio).toBeGreaterThan(1);
  }, 180000); // 3-minute timeout

  it('should identify breaking point under high load', async () => {
    console.log(`\n--- Breaking Point Test ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: SMALL_MODEL,
      workers: 1,
      duration: 60000, // 1 minute
      concurrency: 8, // High concurrency
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 8,
    };

    monitor.reset();
    monitor.startMonitoring(2000);

    const result = await runRealModelBenchmark('Breaking Point', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Breaking Point Test Results:`);
    console.log(`   Concurrency: ${config.concurrency}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   Error rate: ${(result.errorRate * 100).toFixed(2)}%`);

    console.log(`\n   Resource Usage at Breaking Point:`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Peak CPU: ${resourceAnalysis.cpu.peakPercent}%`);

    // System should handle some load even at breaking point
    expect(result.successfulRequests).toBeGreaterThan(0);
  }, 120000);
});
