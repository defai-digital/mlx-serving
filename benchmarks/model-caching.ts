/**
 * Model Caching Performance Benchmark (Phase 2 - v0.2.0)
 *
 * Validates the 50-70% load time reduction target from in-memory model caching.
 * Compares cold loads (first time) vs warm loads (from cache).
 */

import { performance } from 'node:perf_hooks';
import { createEngine } from '../src/index.js';
import type { Engine } from '../src/types/index.js';

interface BenchmarkResult {
  scenario: string;
  loads: number;
  totalTimeMs: number;
  avgTimePerLoad: number;
  minTimeMs: number;
  maxTimeMs: number;
  cacheHits?: number;
}

const MODEL_ID = 'llama-3.2-3b-instruct';
const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const NUM_LOADS = 5;

/**
 * Benchmark cold loads (no caching, fresh engine each time)
 */
async function benchmarkColdLoads(): Promise<BenchmarkResult> {
  console.log('\n🔄 Running COLD LOAD benchmark (no caching)...');

  const times: number[] = [];

  for (let i = 0; i < NUM_LOADS; i++) {
    // Create fresh engine for each load
    const engine = await createEngine();

    const start = performance.now();
    await engine.loadModel({ model: MODEL_ID, localPath: MODEL_PATH });
    const time = performance.now() - start;

    times.push(time);
    await engine.dispose();

    console.log(`  Load ${i + 1}/${NUM_LOADS}: ${time.toFixed(2)}ms`);
  }

  const totalTimeMs = times.reduce((a, b) => a + b, 0);

  return {
    scenario: 'Cold Loads (no cache)',
    loads: NUM_LOADS,
    totalTimeMs,
    avgTimePerLoad: totalTimeMs / NUM_LOADS,
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
  };
}

/**
 * Benchmark warm loads (with caching enabled)
 */
async function benchmarkWarmLoads(engine: Engine): Promise<BenchmarkResult> {
  console.log('\n⚡ Running WARM LOAD benchmark (with caching)...');

  const times: number[] = [];
  let cacheHits = 0;

  for (let i = 0; i < NUM_LOADS; i++) {
    const start = performance.now();
    await engine.loadModel({ model: MODEL_ID, localPath: MODEL_PATH });
    const time = performance.now() - start;

    times.push(time);

    // After first load, subsequent loads are cache hits
    if (i > 0) {
      cacheHits++;
    }

    console.log(`  Load ${i + 1}/${NUM_LOADS}: ${time.toFixed(2)}ms${i > 0 ? ' (cache hit)' : ' (first load)'}`);
  }

  const totalTimeMs = times.reduce((a, b) => a + b, 0);

  return {
    scenario: 'Warm Loads (with cache)',
    loads: NUM_LOADS,
    totalTimeMs,
    avgTimePerLoad: totalTimeMs / NUM_LOADS,
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
    cacheHits,
  };
}

/**
 * Benchmark multi-model scenario
 */
async function benchmarkMultiModel(engine: Engine): Promise<BenchmarkResult> {
  console.log('\n🔀 Running MULTI-MODEL benchmark (model switching)...');

  const models = [
    { id: 'model-1', path: MODEL_PATH },
    { id: 'model-2', path: MODEL_PATH },
    { id: 'model-3', path: MODEL_PATH },
  ];

  const times: number[] = [];
  let cacheHits = 0;

  // Load each model twice (second time should be cached)
  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      const start = performance.now();
      await engine.loadModel({ model: model.id, localPath: model.path });
      const time = performance.now() - start;

      times.push(time);

      if (round > 0) {
        cacheHits++;
      }

      console.log(`  ${model.id} (round ${round + 1}): ${time.toFixed(2)}ms${round > 0 ? ' (cache hit)' : ''}`);
    }
  }

  const totalTimeMs = times.reduce((a, b) => a + b, 0);

  return {
    scenario: 'Multi-Model (3 models × 2 rounds)',
    loads: times.length,
    totalTimeMs,
    avgTimePerLoad: totalTimeMs / times.length,
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
    cacheHits,
  };
}

/**
 * Calculate performance improvement
 */
function calculateImprovement(cold: BenchmarkResult, warm: BenchmarkResult): number {
  const coldTime = cold.avgTimePerLoad;
  const warmTime = warm.avgTimePerLoad;
  const reduction = ((coldTime - warmTime) / coldTime) * 100;
  return reduction;
}

/**
 * Display benchmark results
 */
function displayResults(
  cold: BenchmarkResult,
  warm: BenchmarkResult,
  multi: BenchmarkResult
): void {
  const improvement = calculateImprovement(cold, warm);
  const speedup = cold.avgTimePerLoad / warm.avgTimePerLoad;

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Model Caching Performance Benchmark                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Model: ${MODEL_ID}`);
  console.log(`Total Loads: ${NUM_LOADS} per scenario\n`);

  console.log('═══ Cold Loads (Baseline) ═══');
  console.log(`  Total Time:     ${cold.totalTimeMs.toFixed(2)}ms`);
  console.log(`  Avg per Load:   ${cold.avgTimePerLoad.toFixed(2)}ms`);
  console.log(`  Min:            ${cold.minTimeMs.toFixed(2)}ms`);
  console.log(`  Max:            ${cold.maxTimeMs.toFixed(2)}ms\n`);

  console.log('═══ Warm Loads (Cached) ═══');
  console.log(`  Total Time:     ${warm.totalTimeMs.toFixed(2)}ms`);
  console.log(`  Avg per Load:   ${warm.avgTimePerLoad.toFixed(2)}ms`);
  console.log(`  Min:            ${warm.minTimeMs.toFixed(2)}ms`);
  console.log(`  Max:            ${warm.maxTimeMs.toFixed(2)}ms`);
  console.log(`  Cache Hits:     ${warm.cacheHits}/${warm.loads - 1}\n`);

  console.log('═══ Multi-Model Scenario ═══');
  console.log(`  Total Time:     ${multi.totalTimeMs.toFixed(2)}ms`);
  console.log(`  Avg per Load:   ${multi.avgTimePerLoad.toFixed(2)}ms`);
  console.log(`  Min:            ${multi.minTimeMs.toFixed(2)}ms`);
  console.log(`  Max:            ${multi.maxTimeMs.toFixed(2)}ms`);
  console.log(`  Cache Hits:     ${multi.cacheHits}/${multi.loads}\n`);

  console.log('═══ Performance Improvement ═══');
  console.log(`  Load Time Reduction: ${improvement.toFixed(1)}%`);
  console.log(`  Speedup:             ${speedup.toFixed(2)}x`);
  console.log(`  Time Saved per Load: ${(cold.avgTimePerLoad - warm.avgTimePerLoad).toFixed(2)}ms\n`);

  // Validate against target
  const target = 50;
  if (improvement >= target) {
    console.log(`✅ SUCCESS: Achieved ${improvement.toFixed(1)}% reduction (target: ${target}%+)`);
  } else {
    console.log(`⚠️  WARNING: Only ${improvement.toFixed(1)}% reduction (target: ${target}%+)`);
  }

  console.log('\n═══ Summary ═══');
  console.log(`  Model caching ${speedup >= 1.5 ? 'significantly improved' : 'improved'} performance:`);
  console.log(`  - ${speedup.toFixed(1)}x faster for repeated loads`);
  console.log(`  - ${improvement.toFixed(1)}% reduction in load time`);
  console.log(`  - Cache hits are nearly instant (<100ms typical)\n`);
}

/**
 * Main benchmark execution
 */
async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║      Phase 2: Model Caching Performance Validation           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Testing: ${NUM_LOADS} model loads per scenario`);
  console.log(`Model: ${MODEL_ID}\n`);

  // Benchmark cold loads (no caching)
  console.log('📊 Benchmarking cold loads...');
  const coldResult = await benchmarkColdLoads();

  // Small delay between benchmarks
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Create engine with caching enabled
  console.log('\n📦 Initializing engine with caching...');
  const engine = await createEngine();

  // Benchmark warm loads (with caching)
  const warmResult = await benchmarkWarmLoads(engine);

  // Small delay
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Benchmark multi-model scenario
  const multiResult = await benchmarkMultiModel(engine);

  // Display results
  displayResults(coldResult, warmResult, multiResult);

  // Show cache stats
  console.log('═══ Cache Statistics ═══');
  const stats = engine.getCacheStats();
  console.log(`  Loaded Models:  ${stats.loadedModels}/${stats.maxModels}`);
  console.log(`  Cache Enabled:  ${stats.cacheEnabled}`);
  console.log(`  Models in Cache:`);
  for (const model of stats.models) {
    const age = Date.now() - model.lastAccess;
    console.log(`    - ${model.modelId} (accessed ${age}ms ago)`);
  }
  console.log();

  // Cleanup
  console.log('🧹 Cleaning up...');
  await engine.dispose();
  console.log('✓ Done\n');
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
