/**
 * Phase 2 Cache Performance Benchmark
 *
 * Measures the performance improvement of the Model Artifact Cache:
 * - Cold start (cache miss): First load, downloads from HuggingFace
 * - Warm start (cache hit): Subsequent loads from disk cache
 * - Target: 90%+ load time reduction
 *
 * Usage:
 *   npx tsx benchmarks/phase2/cache-performance.ts
 *
 * Models tested:
 *   - Small (1-2GB): Llama-3.2-1B-Instruct-4bit
 *   - Medium (4-5GB): Llama-3.2-3B-Instruct-4bit
 *   - Large (8-10GB): Qwen2.5-7B-Instruct-4bit (optional)
 */

import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Benchmark configuration
const testCacheDir = path.join(process.cwd(), '.benchmark-cache');

const MODELS = [
  {
    name: 'Llama-3.2-1B-4bit (Small)',
    id: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    size: '~1.5GB',
  },
  {
    name: 'Llama-3.2-3B-4bit (Medium)',
    id: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    size: '~4GB',
  },
  // Uncomment to test large models (requires significant disk space and time)
  // {
  //   name: 'Qwen2.5-7B-4bit (Large)',
  //   id: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  //   size: '~8GB',
  // },
];

interface BenchmarkResult {
  model: string;
  size: string;
  coldStartMs: number;
  warmStartMs: number;
  improvementPercent: number;
  cacheHit: boolean;
}

/**
 * Measure load time for a single model load
 */
async function measureLoadTime(engine: Engine, modelId: string): Promise<number> {
  const startTime = performance.now();
  const handle = await engine.loadModel({ model: modelId });
  const duration = performance.now() - startTime;

  // Verify model loaded
  if (handle.state !== 'ready') {
    throw new Error(`Model ${modelId} failed to load: state=${handle.state}`);
  }

  return duration;
}

/**
 * Benchmark a single model: cache miss + cache hit
 */
async function benchmarkModel(engine: Engine, model: {
  name: string;
  id: string;
  size: string;
}): Promise<BenchmarkResult> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Benchmarking: ${model.name}`);
  console.log(`   Model ID: ${model.id}`);
  console.log(`   Size: ${model.size}`);
  console.log(`${'='.repeat(70)}`);

  // 1. Cold start (cache miss) - downloads from HuggingFace
  console.log('\n⏱️  Cold Start (cache miss)...');
  const coldStartMs = await measureLoadTime(engine, model.id);
  console.log(`   ✓ Completed in ${coldStartMs.toFixed(0)}ms (${(coldStartMs / 1000).toFixed(1)}s)`);

  // Check cache stats after first load
  const stats1 = await engine.getArtifactCacheHealth();
  console.log(`   Cache stats: ${stats1.entryCount} entries, healthy: ${stats1.healthy}`);

  // 2. Unload model (clear in-memory cache, keep disk cache)
  console.log('\n🔄 Unloading model...');
  await engine.unloadModel(model.id);
  console.log('   ✓ Model unloaded');

  // 3. Warm start (cache hit) - loads from disk cache
  console.log('\n⏱️  Warm Start (cache hit)...');
  const warmStartMs = await measureLoadTime(engine, model.id);
  console.log(`   ✓ Completed in ${warmStartMs.toFixed(0)}ms (${(warmStartMs / 1000).toFixed(1)}s)`);

  // Check cache stats after second load
  const stats2 = await engine.getArtifactCacheHealth();
  console.log(`   Cache stats: ${stats2.entryCount} entries, hit rate: ${(stats2.hitRate * 100).toFixed(1)}%`);

  // 4. Calculate improvement
  const improvementPercent = ((coldStartMs - warmStartMs) / coldStartMs) * 100;

  console.log(`\n📈 Results:`);
  console.log(`   Cold Start: ${coldStartMs.toFixed(0)}ms`);
  console.log(`   Warm Start: ${warmStartMs.toFixed(0)}ms`);
  console.log(`   Improvement: ${improvementPercent.toFixed(1)}% faster`);
  console.log(`   Speedup: ${(coldStartMs / warmStartMs).toFixed(1)}x`);

  if (improvementPercent >= 90) {
    console.log(`   ✅ Target met: ${improvementPercent.toFixed(1)}% >= 90% target`);
  } else if (improvementPercent >= 80) {
    console.log(`   ⚠️  Close to target: ${improvementPercent.toFixed(1)}% (target: 90%)`);
  } else {
    console.log(`   ❌ Below target: ${improvementPercent.toFixed(1)}% < 80%`);
  }

  // Unload for cleanup
  await engine.unloadModel(model.id);

  return {
    model: model.name,
    size: model.size,
    coldStartMs,
    warmStartMs,
    improvementPercent,
    cacheHit: stats2.hitRate > 0,
  };
}

/**
 * Print summary table of all results
 */
function printSummary(results: BenchmarkResult[]): void {
  console.log(`\n\n${'='.repeat(90)}`);
  console.log('📊 BENCHMARK SUMMARY');
  console.log(`${'='.repeat(90)}\n`);

  console.log('| Model                | Size   | Cold Start | Warm Start | Improvement | Speedup |');
  console.log('|----------------------|--------|------------|------------|-------------|---------|');

  for (const result of results) {
    const coldStart = `${(result.coldStartMs / 1000).toFixed(1)}s`;
    const warmStart = `${(result.warmStartMs / 1000).toFixed(1)}s`;
    const improvement = `${result.improvementPercent.toFixed(1)}%`;
    const speedup = `${(result.coldStartMs / result.warmStartMs).toFixed(1)}x`;

    console.log(
      `| ${result.model.padEnd(20)} | ${result.size.padEnd(6)} | ${coldStart.padEnd(10)} | ${warmStart.padEnd(10)} | ${improvement.padEnd(11)} | ${speedup.padEnd(7)} |`
    );
  }

  console.log('');

  // Calculate averages
  const avgImprovement =
    results.reduce((sum, r) => sum + r.improvementPercent, 0) / results.length;
  const avgSpeedup =
    results.reduce((sum, r) => sum + r.coldStartMs / r.warmStartMs, 0) / results.length;

  console.log(`\n📈 Average Improvement: ${avgImprovement.toFixed(1)}%`);
  console.log(`📈 Average Speedup: ${avgSpeedup.toFixed(1)}x`);

  if (avgImprovement >= 90) {
    console.log(`\n✅ Phase 2 cache performance target MET: ${avgImprovement.toFixed(1)}% >= 90%`);
  } else {
    console.log(
      `\n⚠️  Phase 2 cache performance: ${avgImprovement.toFixed(1)}% (target: 90%+)`
    );
  }

  console.log(`\n${'='.repeat(90)}`);
}

/**
 * Main benchmark function
 */
async function main(): Promise<void> {
  console.log('============================================================');
  console.log('Phase 2: Model Artifact Cache Performance Benchmark');
  console.log('============================================================');
  console.log(`\nCache Directory: ${testCacheDir}`);
  console.log(`Models: ${MODELS.length}`);
  console.log(`Target: 90%+ load time reduction\n`);

  // Clean cache directory before starting
  console.log('🧹 Cleaning cache directory...');
  await fs.rm(testCacheDir, { recursive: true, force: true });
  console.log('   ✓ Cache cleaned\n');

  // Create engine with cache enabled
  console.log('🚀 Starting mlx-serving engine...');
  const engine = await createEngine({
    cache: {
      enabled: true,
      cacheDir: testCacheDir,      // Use camelCase
      maxSizeBytes: 50e9,           // 50GB
      validateOnStartup: true,      // Use camelCase
    },
  });
  console.log('   ✓ Engine started');

  const results: BenchmarkResult[] = [];

  try {
    // Benchmark each model
    for (const model of MODELS) {
      const result = await benchmarkModel(engine, model);
      results.push(result);

      // Small delay between models
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Print summary
    printSummary(results);

    // Print cache final stats
    const finalStats = await engine.getArtifactCacheHealth();
    console.log(`\n📁 Final Cache Statistics:`);
    console.log(`   Total Entries: ${finalStats.entryCount}`);
    console.log(`   Total Size: ${(finalStats.sizeBytes / 1e9).toFixed(2)} GB`);
    console.log(`   Hit Rate: ${(finalStats.hitRate * 100).toFixed(1)}%`);
    console.log(`   Healthy: ${finalStats.healthy}`);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    throw error;
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await engine.dispose();
    console.log('   ✓ Engine disposed');

    // Optionally clean cache directory
    // await fs.rm(testCacheDir, { recursive: true, force: true });
    // console.log('   ✓ Cache directory removed');
  }

  console.log('\n✅ Benchmark complete!');
}

// Run benchmark
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
