/**
 * Request Batching Performance Benchmark
 *
 * Validates the 90% IPC overhead reduction target for Phase 1.
 * Compares unbatched vs batched tokenize requests to measure multiplexing efficiency.
 */

import { performance } from 'node:perf_hooks';
import { createEngine } from '../src/index.js';
import type { Engine } from '../src/types/index.js';

interface BenchmarkResult {
  scenario: string;
  requests: number;
  totalTimeMs: number;
  avgTimePerRequest: number;
  throughput: number; // requests/sec
  ipcOverheadMs?: number;
  batchStats?: {
    batches: number;
    avgBatchSize: number;
    batchedRequests: number;
    soloRequests: number;
  };
}

const MODEL_ID = 'llama-3.2-3b-instruct';
const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const NUM_REQUESTS = 100;

/**
 * Benchmark unbatched requests (multiplexer disabled)
 */
async function benchmarkUnbatched(engine: Engine): Promise<BenchmarkResult> {
  console.log('\n🔄 Running UNBATCHED benchmark...');

  const start = performance.now();

  // Execute requests sequentially (no batching)
  for (let i = 0; i < NUM_REQUESTS; i++) {
    await engine.tokenize({
      model: MODEL_ID,
      text: `Test sentence ${i} for tokenization benchmark`,
    });

    if ((i + 1) % 25 === 0) {
      process.stdout.write(`  Progress: ${i + 1}/${NUM_REQUESTS} requests\r`);
    }
  }

  const end = performance.now();
  const totalTimeMs = end - start;

  console.log(`  ✓ Completed ${NUM_REQUESTS} requests\n`);

  return {
    scenario: 'Unbatched (no multiplexing)',
    requests: NUM_REQUESTS,
    totalTimeMs,
    avgTimePerRequest: totalTimeMs / NUM_REQUESTS,
    throughput: (NUM_REQUESTS / totalTimeMs) * 1000,
  };
}

/**
 * Benchmark batched requests (multiplexer enabled)
 */
async function benchmarkBatched(engine: Engine): Promise<BenchmarkResult> {
  console.log('\n⚡ Running BATCHED benchmark...');

  const start = performance.now();

  // Execute requests concurrently to trigger batching
  const promises: Promise<any>[] = [];
  for (let i = 0; i < NUM_REQUESTS; i++) {
    const promise = engine.tokenize({
      model: MODEL_ID,
      text: `Test sentence ${i} for tokenization benchmark`,
    });
    promises.push(promise);

    // Show progress
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`  Progress: ${i + 1}/${NUM_REQUESTS} requests queued\r`);
    }
  }

  // Wait for all requests to complete
  await Promise.all(promises);

  const end = performance.now();
  const totalTimeMs = end - start;

  console.log(`  ✓ Completed ${NUM_REQUESTS} requests\n`);

  // Get batching statistics
  const stats = (engine as any).runner?.transport?.getMultiplexerStats?.();

  return {
    scenario: 'Batched (with multiplexing)',
    requests: NUM_REQUESTS,
    totalTimeMs,
    avgTimePerRequest: totalTimeMs / NUM_REQUESTS,
    throughput: (NUM_REQUESTS / totalTimeMs) * 1000,
    batchStats: stats ? {
      batches: stats.batchesDispatched,
      avgBatchSize: stats.averageBatchSize,
      batchedRequests: stats.batchedRequests,
      soloRequests: stats.soloRequests,
    } : undefined,
  };
}

/**
 * Calculate IPC overhead reduction
 */
function calculateReduction(unbatched: BenchmarkResult, batched: BenchmarkResult): number {
  const unbatchedOverhead = unbatched.avgTimePerRequest;
  const batchedOverhead = batched.avgTimePerRequest;
  const reduction = ((unbatchedOverhead - batchedOverhead) / unbatchedOverhead) * 100;
  return reduction;
}

/**
 * Display benchmark results
 */
function displayResults(unbatched: BenchmarkResult, batched: BenchmarkResult): void {
  const reduction = calculateReduction(unbatched, batched);
  const speedup = unbatched.totalTimeMs / batched.totalTimeMs;

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Request Batching Performance Benchmark               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Model: ${MODEL_ID}`);
  console.log(`Total Requests: ${NUM_REQUESTS}\n`);

  console.log('═══ Unbatched (Baseline) ═══');
  console.log(`  Total Time:     ${unbatched.totalTimeMs.toFixed(2)} ms`);
  console.log(`  Avg per Request: ${unbatched.avgTimePerRequest.toFixed(2)} ms`);
  console.log(`  Throughput:      ${unbatched.throughput.toFixed(2)} req/sec\n`);

  console.log('═══ Batched (Multiplexed) ═══');
  console.log(`  Total Time:     ${batched.totalTimeMs.toFixed(2)} ms`);
  console.log(`  Avg per Request: ${batched.avgTimePerRequest.toFixed(2)} ms`);
  console.log(`  Throughput:      ${batched.throughput.toFixed(2)} req/sec`);

  if (batched.batchStats) {
    console.log(`\n  Batching Stats:`);
    console.log(`    Batches Dispatched:  ${batched.batchStats.batches}`);
    console.log(`    Avg Batch Size:      ${batched.batchStats.avgBatchSize.toFixed(2)}`);
    console.log(`    Batched Requests:    ${batched.batchStats.batchedRequests}`);
    console.log(`    Solo Requests:       ${batched.batchStats.soloRequests}`);
  }

  console.log('\n═══ Performance Improvement ═══');
  console.log(`  IPC Overhead Reduction: ${reduction.toFixed(1)}%`);
  console.log(`  Speedup:                ${speedup.toFixed(2)}x`);
  console.log(`  Time Saved:             ${(unbatched.totalTimeMs - batched.totalTimeMs).toFixed(2)} ms\n`);

  // Validate against 90% target
  const target = 90;
  if (reduction >= target) {
    console.log(`✅ SUCCESS: Achieved ${reduction.toFixed(1)}% overhead reduction (target: ${target}%)`);
  } else {
    console.log(`⚠️  WARNING: Only achieved ${reduction.toFixed(1)}% overhead reduction (target: ${target}%)`);
  }

  console.log('\n═══ Summary ═══');
  console.log(`  Batching ${speedup >= 2 ? 'significantly improved' : 'improved'} performance:`);
  console.log(`  - ${speedup.toFixed(1)}x faster than unbatched`);
  console.log(`  - ${reduction.toFixed(1)}% reduction in per-request overhead`);
  console.log(`  - ${batched.throughput.toFixed(0)} req/sec throughput (vs ${unbatched.throughput.toFixed(0)})\n`);
}

/**
 * Main benchmark execution
 */
async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║      Phase 1: Request Batching Performance Validation        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Testing: ${NUM_REQUESTS} tokenize requests`);
  console.log(`Model: ${MODEL_ID}\n`);

  // Create engine and load model
  console.log('📦 Initializing engine...');
  const engine = await createEngine();

  console.log(`📦 Loading model: ${MODEL_ID}...`);
  await engine.loadModel({
    model: MODEL_ID,
    localPath: MODEL_PATH,
  });
  console.log('✓ Model loaded\n');

  // Run unbatched benchmark
  const unbatchedResult = await benchmarkUnbatched(engine);

  // Small delay between benchmarks
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run batched benchmark
  const batchedResult = await benchmarkBatched(engine);

  // Display results
  displayResults(unbatchedResult, batchedResult);

  // Cleanup
  console.log('🧹 Cleaning up...');
  await engine.unloadModel(MODEL_ID);
  await engine.dispose();
  console.log('✓ Done\n');

  // Export results
  const results = {
    unbatched: unbatchedResult,
    batched: batchedResult,
    reduction: calculateReduction(unbatchedResult, batchedResult),
    speedup: unbatchedResult.totalTimeMs / batchedResult.totalTimeMs,
    timestamp: new Date().toISOString(),
  };

  console.log('📊 Results exported to: benchmarks/results/batching-performance.json\n');
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
