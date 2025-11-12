/**
 * Integration Tests - Model Switching
 *
 * End-to-end tests for multi-model serving with ModelRegistry and ModelSwitcher.
 * Week 3: Advanced Scaling - Multi-Model Serving
 *
 * These tests require a real Python runtime and actual model loading.
 * Use small models for testing (e.g., Qwen2.5-0.5B-Instruct).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Engine } from '../../src/api/engine.js';
import { ModelRegistry } from '../../src/models/ModelRegistry.js';
import { ModelSwitcher } from '../../src/models/ModelSwitcher.js';
import type { ModelCacheConfig } from '../../src/types/index.js';

// Test models (small models for fast testing)
const TEST_MODELS = {
  // Use small models that load quickly
  model1: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit',
  model2: 'mlx-community/Qwen2.5-1.5B-Instruct-4bit',
  model3: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
};

describe('ModelRegistry Integration', () => {
  let engine: Engine;
  let registry: ModelRegistry;

  beforeAll(async () => {
    engine = new Engine();
    // Engine initializes automatically on construction

    // Create registry with small cache for testing
    const config: ModelCacheConfig = {
      maxCachedModels: 2,
      evictionStrategy: 'lru',
      memoryAwareEviction: false,
      gpuMemoryThreshold: 0.9,
      trackAccessPatterns: true,
      warmupModels: [],
      pinnedModels: [],
      enablePreloading: true,
      preloadFrequencyThreshold: 10,
    };

    // Access internal model manager (this is test-only)
    const modelManager = (engine as any).modelManager;
    registry = new ModelRegistry({ modelManager, config });
    await registry.initialize();
  }, 60000); // 60s timeout for engine init

  afterAll(async () => {
    await engine.dispose();
  });

  describe('model loading and caching', () => {
    it('should load and cache a model', async () => {
      const handle = await registry.getOrLoad(TEST_MODELS.model1);

      expect(handle).toBeDefined();
      expect(handle.state).toBe('ready');
      expect(registry.isCached(TEST_MODELS.model1)).toBe(true);

      const stats = registry.getStats();
      expect(stats.cachedModels).toBe(1);
      expect(stats.cacheMisses).toBe(1);
    }, 30000); // 30s timeout for model load

    it('should return cached model on second access', async () => {
      const startTime = performance.now();
      const handle = await registry.getOrLoad(TEST_MODELS.model1);
      const cacheTime = performance.now() - startTime;

      expect(handle).toBeDefined();
      expect(cacheTime).toBeLessThan(100); // Cache hit should be fast (<100ms)

      const stats = registry.getStats();
      expect(stats.cacheHits).toBeGreaterThan(0);
    });

    it('should track access patterns', async () => {
      await registry.getOrLoad(TEST_MODELS.model1);
      await registry.getOrLoad(TEST_MODELS.model1);

      const info = registry.getModelInfo(TEST_MODELS.model1);
      expect(info).toBeDefined();
      expect(info!.accessPattern.accessCount).toBeGreaterThan(2);
      expect(info!.accessPattern.lastAccessTime).toBeGreaterThan(0);
    });
  });

  describe('cache eviction', () => {
    it('should evict LRU model when cache full', async () => {
      // Load 2 models (at capacity)
      await registry.getOrLoad(TEST_MODELS.model1);
      await registry.getOrLoad(TEST_MODELS.model2);

      expect(registry.listCachedModels()).toHaveLength(2);

      // Load 3rd model - should evict model1 (LRU)
      await registry.getOrLoad(TEST_MODELS.model3);

      expect(registry.listCachedModels()).toHaveLength(2);
      expect(registry.isCached(TEST_MODELS.model1)).toBe(false);
      expect(registry.isCached(TEST_MODELS.model3)).toBe(true);

      const stats = registry.getStats();
      expect(stats.evictions).toBeGreaterThan(0);
    }, 90000); // 90s for loading 3 models
  });

  describe('model pinning', () => {
    it('should not evict pinned models', async () => {
      // Clear cache first
      const models = registry.listCachedModels();
      for (const model of models) {
        if (!model.pinned) {
          await registry.evictModel(model.modelId);
        }
      }

      // Load and pin model1
      await registry.getOrLoad(TEST_MODELS.model1);
      await registry.pinModel(TEST_MODELS.model1);

      // Load model2
      await registry.getOrLoad(TEST_MODELS.model2);

      // Load model3 - should evict model2, not pinned model1
      await registry.getOrLoad(TEST_MODELS.model3);

      expect(registry.isCached(TEST_MODELS.model1)).toBe(true); // Pinned
      expect(registry.isCached(TEST_MODELS.model2)).toBe(false); // Evicted
      expect(registry.isCached(TEST_MODELS.model3)).toBe(true);

      // Cleanup: unpin model1
      registry.unpinModel(TEST_MODELS.model1);
    }, 90000);
  });

  describe('statistics', () => {
    it('should provide accurate cache statistics', async () => {
      const stats = registry.getStats();

      expect(stats.cachedModels).toBeGreaterThanOrEqual(0);
      expect(stats.maxCachedModels).toBe(2);
      expect(stats.totalGpuMemory).toBeGreaterThanOrEqual(0);
      expect(stats.cacheHitRate).toBeGreaterThanOrEqual(0);
      expect(stats.cacheHitRate).toBeLessThanOrEqual(1);
    });

    it('should track GPU memory usage', async () => {
      await registry.getOrLoad(TEST_MODELS.model1);

      const stats = registry.getStats();
      expect(stats.totalGpuMemory).toBeGreaterThan(0);
    }, 30000);
  });
});

describe('ModelSwitcher Integration', () => {
  let engine: Engine;
  let registry: ModelRegistry;
  let switcher: ModelSwitcher;

  beforeAll(async () => {
    engine = new Engine();
    // Engine initializes automatically on construction

    const config: ModelCacheConfig = {
      maxCachedModels: 2,
      evictionStrategy: 'lru',
      memoryAwareEviction: false,
      gpuMemoryThreshold: 0.9,
      trackAccessPatterns: true,
      warmupModels: [],
      pinnedModels: [],
      enablePreloading: true,
      preloadFrequencyThreshold: 10,
    };

    const modelManager = (engine as any).modelManager;
    registry = new ModelRegistry({ modelManager, config });
    await registry.initialize();

    switcher = new ModelSwitcher({
      registry,
      enableParallelPreload: true,
      maxParallelPreload: 2,
    });
  }, 60000);

  afterAll(async () => {
    await engine.dispose();
  });

  describe('fast model switching', () => {
    it('should switch to a new model', async () => {
      const result = await switcher.switchModel({
        toModelId: TEST_MODELS.model1,
      });

      expect(result.success).toBe(true);
      expect(result.modelId).toBe(TEST_MODELS.model1);
      expect(result.switchTimeMs).toBeGreaterThan(0);
      expect(result.cacheHit).toBe(false); // First load
    }, 30000);

    it('should switch to cached model quickly', async () => {
      // First switch to load model
      await switcher.switchModel({ toModelId: TEST_MODELS.model1 });

      // Second switch should be fast (cache hit)
      const result = await switcher.switchModel({
        fromModelId: TEST_MODELS.model1,
        toModelId: TEST_MODELS.model1,
      });

      expect(result.success).toBe(true);
      expect(result.cacheHit).toBe(true);
      expect(result.switchTimeMs).toBeLessThan(100); // <100ms for cached
    });

    it('should switch between different models', async () => {
      // Load model1
      await switcher.switchModel({ toModelId: TEST_MODELS.model1 });

      // Switch to model2
      const result = await switcher.switchModel({
        fromModelId: TEST_MODELS.model1,
        toModelId: TEST_MODELS.model2,
      });

      expect(result.success).toBe(true);
      expect(result.modelId).toBe(TEST_MODELS.model2);
      expect(switcher.getCurrentModel()).toBe(TEST_MODELS.model2);
    }, 60000);

    it('should detect eviction during switch', async () => {
      // Fill cache
      await switcher.switchModel({ toModelId: TEST_MODELS.model1 });
      await switcher.switchModel({ toModelId: TEST_MODELS.model2 });

      // Switch to 3rd model - should evict model1
      const result = await switcher.switchModel({
        fromModelId: TEST_MODELS.model2,
        toModelId: TEST_MODELS.model3,
      });

      expect(result.success).toBe(true);
      expect(result.evictionOccurred).toBe(true);
      expect(result.evictedModelId).toBeDefined();
    }, 90000);
  });

  describe('model preloading', () => {
    it('should preload a model in background', async () => {
      await switcher.preloadModel(TEST_MODELS.model1);

      expect(registry.isCached(TEST_MODELS.model1)).toBe(true);
    }, 30000);

    it('should skip preload if already cached', async () => {
      // Load model first
      await registry.getOrLoad(TEST_MODELS.model1);
      const cachedModels = registry.listCachedModels().length;

      // Preload same model
      await switcher.preloadModel(TEST_MODELS.model1);

      // Should not load again
      expect(registry.listCachedModels().length).toBe(cachedModels);
    });

    it('should preload multiple models', async () => {
      // Clear cache first
      const models = registry.listCachedModels();
      for (const model of models) {
        await registry.evictModel(model.modelId);
      }

      // Preload 2 models
      await switcher.preloadModels([TEST_MODELS.model1, TEST_MODELS.model2]);

      expect(registry.isCached(TEST_MODELS.model1)).toBe(true);
      expect(registry.isCached(TEST_MODELS.model2)).toBe(true);
    }, 60000);
  });

  describe('switch statistics', () => {
    it('should track switch statistics', async () => {
      await switcher.switchModel({ toModelId: TEST_MODELS.model1 });
      await switcher.switchModel({ toModelId: TEST_MODELS.model2 });

      const stats = switcher.getSwitchStats();
      expect(stats.totalSwitches).toBeGreaterThan(0);
      expect(stats.avgSwitchTime).toBeGreaterThan(0);
      expect(stats.minSwitchTime).toBeGreaterThan(0);
    }, 60000);

    it('should calculate percentiles', async () => {
      // Generate multiple switches
      for (let i = 0; i < 5; i++) {
        await switcher.switchModel({
          toModelId: i % 2 === 0 ? TEST_MODELS.model1 : TEST_MODELS.model2,
        });
      }

      const stats = switcher.getSwitchStats();
      expect(stats.p50SwitchTime).toBeGreaterThan(0);
      expect(stats.p95SwitchTime).toBeGreaterThan(0);
      expect(stats.p99SwitchTime).toBeGreaterThan(0);
    }, 60000);

    it('should reset statistics', async () => {
      await switcher.switchModel({ toModelId: TEST_MODELS.model1 });

      switcher.resetStats();

      const stats = switcher.getSwitchStats();
      expect(stats.totalSwitches).toBe(0);
      expect(stats.avgSwitchTime).toBe(0);
    });
  });

  describe('end-to-end workflow', () => {
    it('should support typical multi-model serving workflow', async () => {
      // Step 1: Load first model
      const switch1 = await switcher.switchModel({
        toModelId: TEST_MODELS.model1,
      });
      expect(switch1.success).toBe(true);

      // Step 2: Preload second model in background
      await switcher.preloadModel(TEST_MODELS.model2);

      // Step 3: Fast switch to preloaded model
      const switch2 = await switcher.switchModel({
        fromModelId: TEST_MODELS.model1,
        toModelId: TEST_MODELS.model2,
      });
      expect(switch2.success).toBe(true);
      expect(switch2.cacheHit).toBe(true);
      expect(switch2.switchTimeMs).toBeLessThan(100); // Fast switch

      // Step 4: Verify cache statistics
      const stats = registry.getStats();
      expect(stats.cacheHitRate).toBeGreaterThan(0);
      expect(stats.cachedModels).toBeGreaterThan(0);

      // Step 5: Verify switch statistics
      const switchStats = switcher.getSwitchStats();
      expect(switchStats.totalSwitches).toBeGreaterThanOrEqual(2);
    }, 90000);
  });
});
