/**
 * Phase 2 Cache Performance Benchmark (With Wait for Storage)
 *
 * This version adds delays to ensure async cache storage completes
 * before attempting warm start loads.
 *
 * Usage:
 *   npx tsx benchmarks/phase2/cache-performance-with-wait.ts
 */

import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Benchmark configuration
const testCacheDir = path.join(process.cwd(), '.benchmark-cache-wait');

const MODELS = [
  {
    name: 'Llama-3.2-1B-4bit (Small)',
    id: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    size: '~1.5GB',
  },
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
 * Benchmark a single model: cache miss + cache hit (with wait for storage)
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

  // 3. WAIT for async cache storage to complete
  // The cache.store() operation is async and can take 300-900ms for large models
  // We need to wait for it to complete before attempting a warm start
  console.log('\n⏳ Waiting for cache storage to complete (3 seconds)...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Verify cache now has the entry
  const stats2 = await engine.getArtifactCacheHealth();
  console.log(`   Cache stats: ${stats2.entryCount} entries, size: ${(stats2.sizeBytes / 1e9).toFixed(2)} GB`);

  // 4. Warm start (cache hit) - loads from disk cache
  console.log('\n⏱️  Warm Start (cache hit)...');
  const warmStartMs = await measureLoadTime(engine, model.id);
  console.log(`   ✓ Completed in ${warmStartMs.toFixed(0)}ms (${(warmStartMs / 1000).toFixed(1)}s)`);

  // Check cache stats after second load
  const stats3 = await engine.getArtifactCacheHealth();
  console.log(`   Cache stats: ${stats3.entryCount} entries, hit rate: ${(stats3.hitRate * 100).toFixed(1)}%`);

  // 5. Calculate improvement
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
    cacheHit: stats3.hitRate > 0,
  };
}

/**
 * Main benchmark function
 */
async function main(): Promise<void> {
  console.log('============================================================');
  console.log('Phase 2: Model Artifact Cache Performance Benchmark');
  console.log('(With Wait for Async Storage)');
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
    }

    // Print summary
    console.log(`\n\n${'='.repeat(90)}`);
    console.log('📊 BENCHMARK SUMMARY');
    console.log(`${'='.repeat(90)}\n`);

    for (const result of results) {
      console.log(`Model: ${result.model}`);
      console.log(`  Cold Start: ${(result.coldStartMs / 1000).toFixed(1)}s`);
      console.log(`  Warm Start: ${(result.warmStartMs / 1000).toFixed(1)}s`);
      console.log(`  Improvement: ${result.improvementPercent.toFixed(1)}%`);
      console.log(`  Speedup: ${(result.coldStartMs / result.warmStartMs).toFixed(1)}x`);
      console.log(`  Cache Hit: ${result.cacheHit ? 'Yes' : 'No'}\n`);
    }

    // Print cache final stats
    const finalStats = await engine.getArtifactCacheHealth();
    console.log(`📁 Final Cache Statistics:`);
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
  }

  console.log('\n✅ Benchmark complete!');
}

// Run benchmark
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
