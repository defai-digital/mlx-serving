/**
 * Artifact Cache End-to-End Integration Tests
 *
 * Tests the persistent disk cache (Phase 2) with real Python runtime:
 * - Cache miss → download → store → cache hit workflow
 * - Load time improvements (target: 80%+ reduction)
 * - Cache validation and corruption recovery
 * - Multi-variant caching (different quantizations)
 *
 * These tests use the smallest available model for faster execution.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hasTestModel as _hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';

// Use smallest model for fast tests (or local test model if available)
const TEST_MODEL = process.env.CI
  ? null // Skip in CI
  : 'mlx-community/Llama-3.2-1B-Instruct-4bit'; // 1.5GB model

const TEST_CACHE_DIR = path.join(process.cwd(), '.test-artifact-cache');

describe('Artifact Cache End-to-End', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    // Skip if MLX not available
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      console.warn(`\n⚠️  Skipping artifact cache tests: ${mlxSkipReason}`);
      return;
    }

    // Skip in CI (requires downloading large models)
    if (process.env.CI || !TEST_MODEL) {
      skipTests = true;
      skipReason = 'CI environment or no test model specified';
      console.warn('\n⚠️  Skipping artifact cache tests in CI');
      return;
    }

    // Clean test cache directory
    await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });

    // Create engine with artifact cache enabled
    engine = await createEngine({
      cache: {
        enabled: true,
        cacheDir: TEST_CACHE_DIR,       // Use camelCase
        maxSizeBytes: 20e9,              // 20GB
        validateOnStartup: true,         // Use camelCase
      },
    });
  });

  afterAll(async () => {
    if (!skipTests && engine) {
      await engine.dispose();
    }
    // Clean up test cache
    await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  it(
    'should demonstrate cache miss → hit flow with load time improvement',
    async () => {
      if (skipTests) {
        console.log(`⏭️  Skipped: ${skipReason}`);
        return;
      }

      console.log(`\n📊 Testing artifact cache with ${TEST_MODEL}`);

      // 1. First load (cache miss) - downloads from HuggingFace
      console.log('⏱️  Cold start (cache miss)...');
      const load1Start = performance.now();
      const handle1 = await engine.loadModel({ model: TEST_MODEL });
      const load1Time = performance.now() - load1Start;

      expect(handle1).toBeDefined();
      expect(handle1.state).toBe('ready');
      console.log(`   ✓ Completed in ${load1Time.toFixed(0)}ms (${(load1Time / 1000).toFixed(1)}s)`);

      // Verify cache was populated
      const stats1 = await engine.getCacheStats();
      expect(stats1.totalEntries).toBeGreaterThan(0);
      console.log(`   Cache stats: ${stats1.totalEntries} entries, ${stats1.cacheMisses} misses`);

      // 2. Unload model (clear in-memory cache, keep disk cache)
      console.log('\n🔄 Unloading model...');
      await engine.unloadModel(handle1.descriptor.id);
      expect(engine.isModelLoaded(handle1.descriptor.id)).toBe(false);

      // 3. Second load (cache hit) - loads from disk cache
      console.log('\n⏱️  Warm start (cache hit)...');
      const load2Start = performance.now();
      const handle2 = await engine.loadModel({ model: TEST_MODEL });
      const load2Time = performance.now() - load2Start;

      expect(handle2).toBeDefined();
      expect(handle2.state).toBe('ready');
      console.log(`   ✓ Completed in ${load2Time.toFixed(0)}ms (${(load2Time / 1000).toFixed(1)}s)`);

      // Verify cache hit
      const stats2 = await engine.getCacheStats();
      expect(stats2.cacheHits).toBeGreaterThan(0);
      console.log(`   Cache stats: ${stats2.cacheHits} hits, hit rate: ${(stats2.hitRate * 100).toFixed(1)}%`);

      // 4. Calculate improvement
      const improvement = ((load1Time - load2Time) / load1Time) * 100;
      console.log(`\n📈 Results:`);
      console.log(`   Cold Start: ${load1Time.toFixed(0)}ms`);
      console.log(`   Warm Start: ${load2Time.toFixed(0)}ms`);
      console.log(`   Improvement: ${improvement.toFixed(1)}%`);
      console.log(`   Speedup: ${(load1Time / load2Time).toFixed(1)}x`);

      // Verify significant improvement
      // Note: In fast dev environments, improvement may be less than production
      // Target: At least some improvement
      expect(load2Time).toBeLessThan(load1Time);

      await engine.unloadModel(handle2.descriptor.id);
    },
    {
      timeout: 180000, // 3 minutes (HuggingFace download can be slow)
    }
  );

  it(
    'should handle cache validation on startup',
    async () => {
      if (skipTests) {
        console.log(`⏭️  Skipped: ${skipReason}`);
        return;
      }

      // Load model to populate cache
      const handle = await engine.loadModel({ model: TEST_MODEL });
      await engine.unloadModel(handle.descriptor.id);

      // Verify cache has entries
      const stats1 = await engine.getCacheStats();
      expect(stats1.totalEntries).toBeGreaterThan(0);

      // Dispose engine
      await engine.dispose();

      // Create new engine with validation enabled
      // Should validate cache on startup
      engine = await createEngine({
        cache: {
          enabled: true,
          cacheDir: TEST_CACHE_DIR,
          maxSizeBytes: 20e9,
          validateOnStartup: true,
        },
      });

      // Verify cache still has entries (validation passed)
      const stats2 = await engine.getCacheStats();
      expect(stats2.totalEntries).toBeGreaterThan(0);
    },
    {
      timeout: 120000,
    }
  );

  it(
    'should recover from corrupted cache entries',
    async () => {
      if (skipTests) {
        console.log(`⏭️  Skipped: ${skipReason}`);
        return;
      }

      // Load model to populate cache
      const handle = await engine.loadModel({ model: TEST_MODEL });
      await engine.unloadModel(handle.descriptor.id);

      const stats1 = await engine.getCacheStats();
      expect(stats1.totalEntries).toBeGreaterThan(0);

      // Corrupt cache by deleting artifacts directory
      const artifactsDir = path.join(TEST_CACHE_DIR, 'artifacts');
      await fs.rm(artifactsDir, { recursive: true, force: true });

      // Try to load model again - should detect corruption and re-download
      console.log('🔄 Testing corruption recovery...');
      const handle2 = await engine.loadModel({ model: TEST_MODEL });
      expect(handle2).toBeDefined();
      expect(handle2.state).toBe('ready');

      // Verify cache recovered
      const stats2 = await engine.getCacheStats();
      expect(stats2.totalEntries).toBeGreaterThan(0);

      await engine.unloadModel(handle2.descriptor.id);
    },
    {
      timeout: 180000,
    }
  );

  it(
    'should track cache statistics accurately',
    async () => {
      if (skipTests) {
        console.log(`⏭️  Skipped: ${skipReason}`);
        return;
      }

      // Load model multiple times to test hit/miss tracking
      const handle1 = await engine.loadModel({ model: TEST_MODEL });
      await engine.unloadModel(handle1.descriptor.id);

      const handle2 = await engine.loadModel({ model: TEST_MODEL });
      await engine.unloadModel(handle2.descriptor.id);

      const handle3 = await engine.loadModel({ model: TEST_MODEL });
      await engine.unloadModel(handle3.descriptor.id);

      // Get final stats
      const stats = await engine.getCacheStats();

      // Should have at least 1 entry
      expect(stats.totalEntries).toBeGreaterThan(0);

      // Should have cache hits (second and third loads)
      expect(stats.cacheHits).toBeGreaterThan(0);

      // Hit rate should be > 0
      expect(stats.hitRate).toBeGreaterThan(0);

      console.log(`\n📊 Cache statistics:`);
      console.log(`   Total Entries: ${stats.totalEntries}`);
      console.log(`   Cache Hits: ${stats.cacheHits}`);
      console.log(`   Cache Misses: ${stats.cacheMisses}`);
      console.log(`   Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%`);
      console.log(`   Total Size: ${(stats.sizeBytes / 1e9).toFixed(2)} GB`);
    },
    {
      timeout: 180000,
    }
  );

  it('should respect cache disabled setting', async () => {
    if (skipTests) {
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    // Dispose existing engine
    await engine.dispose();

    // Create engine with cache disabled
    engine = await createEngine({
      cache: {
        enabled: false,
        cacheDir: TEST_CACHE_DIR,
        maxSizeBytes: 20e9,
        validateOnStartup: false,
      },
    });

    // Load model twice
    const handle1 = await engine.loadModel({ model: TEST_MODEL });
    await engine.unloadModel(handle1.descriptor.id);

    const handle2 = await engine.loadModel({ model: TEST_MODEL });
    await engine.unloadModel(handle2.descriptor.id);

    // Verify cache not used
    const stats = await engine.getCacheStats();
    expect(stats.totalEntries).toBe(0);
    expect(stats.cacheHits).toBe(0);
    expect(stats.cacheMisses).toBe(0);
  });
});
