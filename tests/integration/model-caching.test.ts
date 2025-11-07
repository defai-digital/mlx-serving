/**
 * Integration Tests: Model Caching (Phase 2 - v0.2.0)
 *
 * Tests the in-memory LRU model cache that keeps loaded models
 * for instant reuse (50-70% load time reduction).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';

// Path to the test model
const TEST_MODEL_PATH = './models/llama-3.2-3b-instruct';

describe('Model Caching Integration', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping model caching tests: ${mlxSkipReason}`);
      return;
    }

    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping model caching tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn(`   Required: ${TEST_MODEL_PATH}\n`);
      return;
    }

    engine = await createEngine();
  });

  afterAll(async () => {
    if (!skipTests && engine) {
      await engine.dispose();
    }
  });

  it('should support warmupModel API', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const modelId = 'test-model-warmup';

    // Warmup model
    await engine.warmupModel({ model: modelId, localPath: TEST_MODEL_PATH });

    // Check cache stats
    const stats = await engine.getCacheStats();
    expect(stats.loadedModels).toBeGreaterThan(0);
    expect(stats.cacheEnabled).toBe(true);
    expect(stats.maxModels).toBe(5); // From config

    // Find our model in the cache
    const cachedModel = stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    expect(cachedModel).toBeDefined();
    expect(cachedModel?.lastAccess).toBeGreaterThan(0);
  });

  it('should support snake_case warmup_model alias', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const modelId = 'test-model-snake';

    // Use snake_case alias
    await engine.warmup_model({ model: modelId, localPath: TEST_MODEL_PATH });

    // Use snake_case get_cache_stats alias
    const stats = await engine.get_cache_stats();
    expect(stats.loadedModels).toBeGreaterThan(0);

    const cachedModel = stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    expect(cachedModel).toBeDefined();
  });

  it('should return cached model on repeated loads', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const modelId = 'test-model-cached';

    // First load
    const handle1 = await engine.loadModel({ model: modelId, localPath: TEST_MODEL_PATH });
    expect(handle1.descriptor.id).toBe(modelId);

    // Get initial access time
    const stats1 = await engine.getCacheStats();
    const cached1 = stats1.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    const accessTime1 = cached1?.lastAccess ?? 0;

    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));

    // Second load (should hit cache)
    const handle2 = await engine.loadModel({ model: modelId, localPath: TEST_MODEL_PATH });
    expect(handle2.descriptor.id).toBe(modelId);

    // Access time should be updated
    const stats2 = await engine.getCacheStats();
    const cached2 = stats2.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    const accessTime2 = cached2?.lastAccess ?? 0;
    expect(accessTime2).toBeGreaterThan(accessTime1);
  });

  it('should track access times for LRU', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    // Use fresh engine to avoid hitting cache limit from previous tests
    const testEngine = await createEngine();

    try {
      // Load 3 models with delays to create clear access order
      const model1 = 'test-model-lru-1';
      const model2 = 'test-model-lru-2';
      const model3 = 'test-model-lru-3';

      await testEngine.warmupModel({ model: model1, localPath: TEST_MODEL_PATH });
      await new Promise((r) => setTimeout(r, 10));

      await testEngine.warmupModel({ model: model2, localPath: TEST_MODEL_PATH });
      await new Promise((r) => setTimeout(r, 10));

      await testEngine.warmupModel({ model: model3, localPath: TEST_MODEL_PATH });

      // Get stats
      const stats = await testEngine.getCacheStats();

      // Find access times
      const cached1 = stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === model1);
      const cached2 = stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === model2);
      const cached3 = stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === model3);

      // model3 should have the most recent access (highest timestamp)
      expect(cached3?.lastAccess).toBeGreaterThan(cached2?.lastAccess ?? 0);
      expect(cached2?.lastAccess).toBeGreaterThan(cached1?.lastAccess ?? 0);
    } finally {
      await testEngine.dispose();
    }
  }, 30_000); // 30 second timeout for fresh engine + 3 model loads

  it('should update access time on cache hit', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const modelId = 'test-model-access-update';

    // Initial load
    await engine.loadModel({ model: modelId, localPath: TEST_MODEL_PATH });

    // Get initial access time
    const stats1 = await engine.getCacheStats();
    const cached1 = stats1.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    const accessTime1 = cached1?.lastAccess ?? 0;

    await new Promise((r) => setTimeout(r, 10));

    // Access again (cache hit)
    await engine.loadModel({ model: modelId, localPath: TEST_MODEL_PATH });

    // Access time should be updated
    const stats2 = await engine.getCacheStats();
    const cached2 = stats2.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId);
    const accessTime2 = cached2?.lastAccess ?? 0;

    expect(accessTime2).toBeGreaterThan(accessTime1);
  });

  it('should report accurate cache statistics', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    // Clear state by creating fresh engine instance
    const testEngine = await createEngine();

    try {
      // Initially empty
      let stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(0);
      expect(stats.cacheEnabled).toBe(true);
      expect(stats.maxModels).toBe(5);
      expect(stats.models).toEqual([]);

      // Load 2 models
      await testEngine.warmupModel({ model: 'model-1', localPath: TEST_MODEL_PATH });
      await testEngine.warmupModel({ model: 'model-2', localPath: TEST_MODEL_PATH });

      stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(2);
      expect(stats.models).toHaveLength(2);

      // Models should be sorted by most recently accessed first
      const modelIds = stats.models.map((m) => m.modelId);
      expect(modelIds).toContain('model-1');
      expect(modelIds).toContain('model-2');
    } finally {
      await testEngine.dispose();
    }
  }, 30_000); // 30 second timeout for fresh engine + 2 model loads

  it('should handle unload correctly', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const testEngine = await createEngine();

    try {
      const modelId = 'test-model-unload';

      // Load model
      await testEngine.warmupModel({ model: modelId, localPath: TEST_MODEL_PATH });

      let stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(1);
      expect(stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId)).toBeDefined();

      // Unload model
      await testEngine.unloadModel(modelId);

      stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(0);
      expect(stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId)).toBeUndefined();
    } finally {
      await testEngine.dispose();
    }
  });

  it('should maintain cache across multiple operations', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`⏭️  Skipped: ${skipReason}`);
      return;
    }

    const testEngine = await createEngine();

    try {
      // Load model
      const modelId = 'test-model-persist';
      await testEngine.warmupModel({ model: modelId, localPath: TEST_MODEL_PATH });

      // Perform multiple operations
      const tokens1 = await testEngine.tokenize({ model: modelId, text: 'Hello world' });
      expect(tokens1.tokens.length).toBeGreaterThan(0);

      // Model should still be cached
      let stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(1);
      expect(stats.models.find((m: { modelId: string; lastAccess: number }) => m.modelId === modelId)).toBeDefined();

      // Tokenize again
      const tokens2 = await testEngine.tokenize({ model: modelId, text: 'Another test' });
      expect(tokens2.tokens.length).toBeGreaterThan(0);

      // Still cached
      stats = await testEngine.getCacheStats();
      expect(stats.loadedModels).toBe(1);
    } finally {
      await testEngine.dispose();
    }
  });
});
