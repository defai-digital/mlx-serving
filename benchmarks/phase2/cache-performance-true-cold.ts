/**
 * Phase 2 Cache Performance Benchmark (True Cold Start)
 *
 * Measures true performance improvement by clearing HuggingFace cache
 * to force internet download on cold start.
 *
 * ⚠️  WARNING: This will download 1.5GB from internet!
 *
 * Usage:
 *   npx tsx benchmarks/phase2/cache-performance-true-cold.ts
 */

import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

// Benchmark configuration
const testCacheDir = path.join(process.cwd(), '.benchmark-cache-true-cold');
const hfCacheDir = path.join(os.homedir(), '.cache', 'huggingface');

const TEST_MODEL = {
  name: 'Llama-3.2-1B-4bit (Small)',
  id: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
  size: '~1.5GB',
  hfRepoId: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
};

/**
 * Clear HuggingFace cache for a specific model
 */
async function clearHuggingFaceCache(modelId: string): Promise<void> {
  const hfPath = path.join(hfCacheDir, 'hub');

  try {
    // Find model directories in HuggingFace cache
    const entries = await fs.readdir(hfPath, { withFileTypes: true });
    const sanitizedModelId = modelId.replace('/', '--');

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.includes(sanitizedModelId)) {
        const fullPath = path.join(hfPath, entry.name);
        console.log(`   Removing: ${fullPath}`);
        await fs.rm(fullPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.warn(`   Warning: Could not clear HuggingFace cache: ${error}`);
  }
}

/**
 * Measure load time for a single model load
 */
async function measureLoadTime(engine: Engine, modelId: string): Promise<number> {
  const startTime = performance.now();
  const handle = await engine.loadModel({ model: modelId });
  const duration = performance.now() - startTime;

  if (handle.state !== 'ready') {
    throw new Error(`Model ${modelId} failed to load: state=${handle.state}`);
  }

  return duration;
}

/**
 * Main benchmark function
 */
async function main(): Promise<void> {
  console.log('============================================================');
  console.log('Phase 2: Model Artifact Cache Performance Benchmark');
  console.log('(True Cold Start - Internet Download)');
  console.log('============================================================');
  console.log(`\n⚠️  WARNING: This will download ~1.5GB from internet!\n`);
  console.log(`Cache Directory: ${testCacheDir}`);
  console.log(`Model: ${TEST_MODEL.name}`);
  console.log(`Target: 90%+ load time reduction\n`);

  // Clean both caches
  console.log('🧹 Cleaning caches...');
  await fs.rm(testCacheDir, { recursive: true, force: true });
  console.log('   ✓ mlx-serving cache cleaned');

  await clearHuggingFaceCache(TEST_MODEL.hfRepoId);
  console.log('   ✓ HuggingFace cache cleaned\n');

  // Create engine with cache enabled
  console.log('🚀 Starting mlx-serving engine...');
  const engine = await createEngine({
    cache: {
      enabled: true,
      cacheDir: testCacheDir,  // Use camelCase
      maxSizeBytes: 50e9,       // Use camelCase
      validateOnStartup: true,  // Use camelCase
    },
  });
  console.log('   ✓ Engine started\n');

  try {
    // === TRUE COLD START (Download from internet) ===
    console.log(`${'='.repeat(70)}`);
    console.log('⏱️  TRUE COLD START (downloading from internet)...');
    console.log(`${'='.repeat(70)}`);

    const coldStartMs = await measureLoadTime(engine, TEST_MODEL.id);
    console.log(`✓ Completed in ${coldStartMs.toFixed(0)}ms (${(coldStartMs / 1000).toFixed(1)}s)`);

    const stats1 = await engine.getArtifactCacheHealth();
    console.log(`Cache: ${stats1.entryCount} entries, ${(stats1.sizeBytes / 1e9).toFixed(2)} GB\n`);

    // Unload model
    console.log('🔄 Unloading model...');
    await engine.unloadModel(TEST_MODEL.id);

    // Wait for cache storage to complete
    console.log('⏳ Waiting for cache storage (3s)...\n');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // === WARM START (Load from artifact cache) ===
    console.log(`${'='.repeat(70)}`);
    console.log('⏱️  WARM START (loading from artifact cache)...');
    console.log(`${'='.repeat(70)}`);

    const warmStartMs = await measureLoadTime(engine, TEST_MODEL.id);
    console.log(`✓ Completed in ${warmStartMs.toFixed(0)}ms (${(warmStartMs / 1000).toFixed(1)}s)`);

    const stats2 = await engine.getArtifactCacheHealth();
    console.log(`Cache: ${stats2.entryCount} entries, hit rate: ${(stats2.hitRate * 100).toFixed(1)}%\n`);

    // === RESULTS ===
    const improvementPercent = ((coldStartMs - warmStartMs) / coldStartMs) * 100;
    const speedup = coldStartMs / warmStartMs;

    console.log(`\n${'='.repeat(70)}`);
    console.log('📊 RESULTS');
    console.log(`${'='.repeat(70)}`);
    console.log(`\nModel: ${TEST_MODEL.name} (${TEST_MODEL.size})`);
    console.log(`\n  True Cold Start (internet): ${(coldStartMs / 1000).toFixed(1)}s`);
    console.log(`  Warm Start (cache):         ${(warmStartMs / 1000).toFixed(1)}s`);
    console.log(`\n  ⚡ Improvement: ${improvementPercent.toFixed(1)}%`);
    console.log(`  ⚡ Speedup:     ${speedup.toFixed(1)}x`);

    if (improvementPercent >= 90) {
      console.log(`\n  ✅ PHASE 2 TARGET MET: ${improvementPercent.toFixed(1)}% >= 90%`);
    } else if (improvementPercent >= 80) {
      console.log(`\n  ⚠️  Close to target: ${improvementPercent.toFixed(1)}% (target: 90%)`);
    } else {
      console.log(`\n  ❌ Below target: ${improvementPercent.toFixed(1)}% < 90%`);
    }

    console.log(`\n${'='.repeat(70)}\n`);

    // Cleanup
    await engine.unloadModel(TEST_MODEL.id);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    throw error;
  } finally {
    console.log('🧹 Cleaning up...');
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
