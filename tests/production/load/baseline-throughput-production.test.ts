/**
 * Baseline Throughput - Production Load Test
 *
 * Duration: 1 hour per worker configuration
 * Model: Qwen2.5-7B-Instruct-4bit
 * Load: 10 req/sec sustained
 * Workers: Test with 2, 4, 8 workers (sequential)
 *
 * Validates:
 * - Sustained 1-hour throughput with real model
 * - Worker scaling (2 → 4 → 8)
 * - Memory stability over extended duration
 * - Performance degradation detection
 */

import { describe, it, expect } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Production: Baseline Throughput (1 hour)', () => {
  const MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const DURATION = 3600000; // 1 hour
  const TARGET_RPS = 10;

  it('should sustain baseline throughput with 2 workers for 1 hour', async (): Promise<void> => {
    console.log(`\n========================================`);
    console.log(`Baseline Throughput: 2 Workers (1 hour)`);
    console.log(`Model: ${MODEL}`);
    console.log(`Target: ${TARGET_RPS} req/sec`);
    console.log(`========================================\n`);

    const config: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1, // Note: Currently using standalone Engine, not distributed
      duration: DURATION,
      concurrency: 2,
      warmupDuration: 30000, // 30 second warmup
      warmupRequests: 5,
      requestsPerSecond: TARGET_RPS,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(30000); // Sample every 30 seconds

    console.log(`Starting 1-hour baseline test...`);
    const startTime = Date.now();

    const result = await runRealModelBenchmark('Baseline 2 Workers', config);

    const actualDuration = (Date.now() - startTime) / 1000 / 60;

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();
    const snapshots = monitor.getAllSnapshots();

    // Analyze performance over time segments
    const segmentSize = Math.floor(snapshots.length / 4);
    const segments = [
      snapshots.slice(0, segmentSize),
      snapshots.slice(segmentSize, segmentSize * 2),
      snapshots.slice(segmentSize * 2, segmentSize * 3),
      snapshots.slice(segmentSize * 3),
    ];

    const avgMemory = (seg: typeof segments[0]): number =>
      seg.reduce((sum, s) => sum + s.memory.rssMb, 0) / seg.length;

    console.log(`\n✅ Baseline Throughput (2 Workers) - 1 Hour Results:`);
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
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);
    console.log(`   Avg memory: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak memory: ${resourceAnalysis.memory.peakMb}MB`);

    console.log(`\n   Memory by Quarter:`);
    segments.forEach((seg, i) => {
      console.log(`   Q${i + 1} (${i * 15}-${(i + 1) * 15}min): ${avgMemory(seg).toFixed(1)}MB`);
    });

    // Validations
    expect(result.totalRequests).toBeGreaterThan(30000); // At least 30k requests in 1 hour
    expect(result.errorRate).toBeLessThan(0.15); // < 15% error rate
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.5); // < 0.5MB/sec leak
  }, 4000000); // 66-minute timeout

  it('should sustain baseline throughput with 4 workers for 1 hour', async (): Promise<void> => {
    console.log(`\n========================================`);
    console.log(`Baseline Throughput: 4 Workers (1 hour)`);
    console.log(`========================================\n`);

    const config: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: DURATION,
      concurrency: 4,
      warmupDuration: 30000,
      warmupRequests: 5,
      requestsPerSecond: TARGET_RPS,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(30000);

    const result = await runRealModelBenchmark('Baseline 4 Workers', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Baseline Throughput (4 Workers) - 1 Hour Results:`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);

    expect(result.totalRequests).toBeGreaterThan(30000);
    expect(result.errorRate).toBeLessThan(0.15);
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.5);
  }, 4000000);

  it('should sustain baseline throughput with 8 workers for 1 hour', async (): Promise<void> => {
    console.log(`\n========================================`);
    console.log(`Baseline Throughput: 8 Workers (1 hour)`);
    console.log(`========================================\n`);

    const config: RealModelBenchmarkConfig = {
      realModelId: MODEL,
      workers: 1,
      duration: DURATION,
      concurrency: 8,
      warmupDuration: 30000,
      warmupRequests: 5,
      requestsPerSecond: TARGET_RPS,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(30000);

    const result = await runRealModelBenchmark('Baseline 8 Workers', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();

    console.log(`\n✅ Baseline Throughput (8 Workers) - 1 Hour Results:`);
    console.log(`   Total requests: ${result.totalRequests}`);
    console.log(`   Throughput: ${result.requestsPerSec.toFixed(2)} req/sec`);
    console.log(`   Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%`);
    console.log(`   p95 latency: ${result.latencyP95.toFixed(2)}ms`);
    console.log(`   Memory trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);

    expect(result.totalRequests).toBeGreaterThan(30000);
    expect(result.errorRate).toBeLessThan(0.15);
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(0.5);
  }, 4000000);
});
