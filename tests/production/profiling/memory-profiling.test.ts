/**
 * Memory Profiling Test
 *
 * Profiles memory usage during real model inference:
 * - Heap usage trends
 * - RSS memory tracking
 * - Memory leak detection
 * - GC pressure analysis
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runRealModelBenchmark, type RealModelBenchmarkConfig } from '../helpers/real-model-harness.js';
import { ResourceMonitor } from '../helpers/resource-monitor.js';

describe('Memory Profiling', () => {
  const TEST_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

  beforeAll(() => {
    console.log(`\n========================================`);
    console.log(`Memory Profiling with Real Model`);
    console.log(`Model: ${TEST_MODEL}`);
    console.log(`========================================\n`);
  }, 60000);

  it('should profile memory usage during inference', async (): Promise<void> => {
    console.log(`\n--- Memory Usage Profile ---`);

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

    const result = await runRealModelBenchmark('Memory Profiling', config);

    monitor.stopMonitoring();
    const resourceAnalysis = monitor.analyzeUsage();
    const snapshots = monitor.getAllSnapshots();

    // Analyze memory usage
    const heapUsages = snapshots.map(s => s.memory.heapUsedMb);
    const rssUsages = snapshots.map(s => s.memory.rssMb);

    const heapAvg = heapUsages.reduce((sum, h) => sum + h, 0) / heapUsages.length;
    const _rssAvg = rssUsages.reduce((sum, r) => sum + r, 0) / rssUsages.length;

    console.log(`\n✅ Memory Profiling Results:`);
    console.log(`   Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`   Total requests: ${result.totalRequests}`);

    console.log(`\n   Heap Memory:`);
    console.log(`   Average: ${heapAvg.toFixed(1)}MB`);
    console.log(`   Peak: ${Math.max(...heapUsages)}MB`);
    console.log(`   Initial: ${heapUsages[0]}MB`);
    console.log(`   Final: ${heapUsages[heapUsages.length - 1]}MB`);

    console.log(`\n   RSS Memory:`);
    console.log(`   Average: ${resourceAnalysis.memory.avgMb}MB`);
    console.log(`   Peak: ${resourceAnalysis.memory.peakMb}MB`);
    console.log(`   Trend: ${resourceAnalysis.memory.trendMbPerSec.toFixed(3)}MB/sec`);

    console.log(`\n   Memory Efficiency:`);
    const memoryPerRequest = (resourceAnalysis.memory.avgMb / result.requestsPerSec);
    console.log(`   MB per req/sec: ${memoryPerRequest.toFixed(1)}MB`);

    // Validate memory usage
    expect(resourceAnalysis.memory.avgMb).toBeGreaterThan(0);
    expect(Math.abs(resourceAnalysis.memory.trendMbPerSec)).toBeLessThan(5); // < 5MB/sec leak
  }, 180000);

  it('should detect memory growth patterns', async (): Promise<void> => {
    console.log(`\n--- Memory Growth Pattern Analysis ---`);

    const config: RealModelBenchmarkConfig = {
      realModelId: TEST_MODEL,
      workers: 1,
      duration: 180000, // 3 minutes for better trend analysis
      concurrency: 3,
      warmupDuration: 5000,
      warmupRequests: 2,
      requestsPerSecond: 3,
    };

    const monitor = new ResourceMonitor();
    monitor.startMonitoring(5000); // Sample every 5 seconds

    const _result = await runRealModelBenchmark('Memory Growth Analysis', config);

    monitor.stopMonitoring();
    const snapshots = monitor.getAllSnapshots();

    // Analyze growth in 3 segments
    const segmentSize = Math.floor(snapshots.length / 3);
    const segment1 = snapshots.slice(0, segmentSize);
    const segment2 = snapshots.slice(segmentSize, segmentSize * 2);
    const segment3 = snapshots.slice(segmentSize * 2);

    const avgRss = (segment: typeof segment1): number =>
      segment.reduce((sum, s) => sum + s.memory.rss, 0) / segment.length;

    const segment1Avg = avgRss(segment1);
    const segment2Avg = avgRss(segment2);
    const segment3Avg = avgRss(segment3);

    console.log(`\n✅ Memory Growth Pattern:`);
    console.log(`   Segment 1 (0-1min): ${segment1Avg.toFixed(1)}MB`);
    console.log(`   Segment 2 (1-2min): ${segment2Avg.toFixed(1)}MB`);
    console.log(`   Segment 3 (2-3min): ${segment3Avg.toFixed(1)}MB`);

    const segment1to2Growth = segment2Avg - segment1Avg;
    const segment2to3Growth = segment3Avg - segment2Avg;

    console.log(`\n   Growth Analysis:`);
    console.log(`   Seg1→Seg2: ${segment1to2Growth > 0 ? '+' : ''}${segment1to2Growth.toFixed(1)}MB`);
    console.log(`   Seg2→Seg3: ${segment2to3Growth > 0 ? '+' : ''}${segment2to3Growth.toFixed(1)}MB`);

    // Validate reasonable growth
    expect(segment1to2Growth).toBeLessThan(200); // < 200MB growth per segment
    expect(segment2to3Growth).toBeLessThan(200);
  }, 240000);
});
