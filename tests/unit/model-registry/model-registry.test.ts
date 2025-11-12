/**
 * Unit Tests - ModelRegistry
 *
 * Tests for multi-model serving with LRU caching.
 * Week 3: Advanced Scaling - Multi-Model Serving
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ModelRegistry } from '../../../src/models/ModelRegistry.js';
import type { ModelManager } from '../../../src/core/model-manager.js';
import type {
  ModelHandle,
  ModelDescriptor,
  ModelIdentifier,
  LoadModelOptions,
  ModelCacheConfig,
} from '../../../src/types/index.js';

// Mock ModelManager
const createMockModelManager = (): ModelManager => {
  const handles = new Map<ModelIdentifier, ModelHandle>();

  const mockManager = {
    loadModel: vi.fn(async (options: LoadModelOptions) => {
      const modelId = typeof options.model === 'string' ? options.model : options.model.id;

      const descriptor: ModelDescriptor = {
        id: modelId,
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const handle: ModelHandle = {
        descriptor,
        state: 'ready' as const,
        contextLength: 2048,
        metadata: {
          parameterCount: 7_000_000_000,
          dtype: 'float16',
          quantization: 'none',
          memoryUsage: {
            gpu_memory_bytes: 14 * 1024 * 1024 * 1024, // 14GB
            cpu_memory_bytes: 1 * 1024 * 1024 * 1024, // 1GB
          },
        },
        draft: false,
      };

      handles.set(modelId, handle);
      return handle;
    }),

    unloadModel: vi.fn(async (id: ModelIdentifier) => {
      handles.delete(id);
    }),

    getHandle: vi.fn((id: ModelIdentifier) => {
      return handles.get(id);
    }),

    isLoaded: vi.fn((id: ModelIdentifier) => {
      return handles.has(id);
    }),
  } as unknown as ModelManager;

  return mockManager;
};

describe('ModelRegistry', () => {
  let mockManager: ModelManager;
  let config: ModelCacheConfig;

  beforeEach(() => {
    mockManager = createMockModelManager();
    config = {
      maxCachedModels: 3,
      evictionStrategy: 'lru' as const,
      memoryAwareEviction: false,
      gpuMemoryThreshold: 0.9,
      trackAccessPatterns: true,
      warmupModels: [],
      pinnedModels: [],
      enablePreloading: true,
      preloadFrequencyThreshold: 10,
    };
  });

  describe('initialization', () => {
    it('should initialize with empty cache', () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      const stats = registry.getStats();
      expect(stats.cachedModels).toBe(0);
      expect(stats.maxCachedModels).toBe(3);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
    });

    it('should warmup configured models on initialize', async () => {
      config.warmupModels = ['model-a', 'model-b'];

      const registry = new ModelRegistry({ modelManager: mockManager, config });
      await registry.initialize();

      expect(mockManager.loadModel).toHaveBeenCalledTimes(2);
      expect(registry.isCached('model-a')).toBe(true);
      expect(registry.isCached('model-b')).toBe(true);
    });

    it('should pin configured models on initialize', async () => {
      config.pinnedModels = ['model-a'];

      const registry = new ModelRegistry({ modelManager: mockManager, config });
      await registry.initialize();

      const info = registry.getModelInfo('model-a');
      expect(info?.pinned).toBe(true);
    });
  });

  describe('getOrLoad', () => {
    it('should load model on cache miss', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      const handle = await registry.getOrLoad('model-a');

      expect(handle).toBeDefined();
      expect(handle.descriptor.id).toBe('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1);

      const stats = registry.getStats();
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cachedModels).toBe(1);
    });

    it('should return cached model on cache hit', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // First load
      const handle1 = await registry.getOrLoad('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1);

      // Second load - should hit cache
      const handle2 = await registry.getOrLoad('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1); // Not called again

      expect(handle1.descriptor.id).toBe(handle2.descriptor.id);

      const stats = registry.getStats();
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheHitRate).toBeCloseTo(0.5);
    });

    it('should track access patterns', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-a');

      const info = registry.getModelInfo('model-a');
      expect(info?.accessPattern.accessCount).toBe(3);
      expect(info?.accessPattern.lastAccessTime).toBeGreaterThan(0);
    });

    it('should respect max cache size', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load 3 models (at capacity)
      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');

      expect(registry.listCachedModels()).toHaveLength(3);

      // Load 4th model - should evict oldest
      await registry.getOrLoad('model-d');

      expect(registry.listCachedModels()).toHaveLength(3);
      expect(registry.isCached('model-a')).toBe(false); // LRU evicted
      expect(registry.isCached('model-d')).toBe(true);

      const stats = registry.getStats();
      expect(stats.evictions).toBe(1);
    });
  });

  describe('eviction strategies', () => {
    it('should evict LRU model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load 3 models
      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');

      // Access model-b and model-c (model-a is now LRU)
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');

      // Load 4th model - should evict model-a (LRU)
      await registry.getOrLoad('model-d');

      expect(registry.isCached('model-a')).toBe(false);
      expect(registry.isCached('model-b')).toBe(true);
      expect(registry.isCached('model-c')).toBe(true);
      expect(registry.isCached('model-d')).toBe(true);
    });

    it('should evict LFU model', async () => {
      config.evictionStrategy = 'lfu';
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load 3 models
      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');

      // Access model-b and model-c multiple times (model-a is LFU)
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');
      await registry.getOrLoad('model-c');

      // Load 4th model - should evict model-a (LFU)
      await registry.getOrLoad('model-d');

      expect(registry.isCached('model-a')).toBe(false);
      expect(registry.isCached('model-b')).toBe(true);
      expect(registry.isCached('model-c')).toBe(true);
    });

    it('should not evict pinned models', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load and pin model-a
      await registry.getOrLoad('model-a');
      await registry.pinModel('model-a');

      // Load 2 more models
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');

      // Load 4th model - should evict model-b (oldest unpinned)
      await registry.getOrLoad('model-d');

      expect(registry.isCached('model-a')).toBe(true); // Pinned, not evicted
      expect(registry.isCached('model-b')).toBe(false); // Evicted
      expect(registry.isCached('model-c')).toBe(true);
      expect(registry.isCached('model-d')).toBe(true);
    });
  });

  describe('model pinning', () => {
    it('should pin a model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.pinModel('model-a');

      const info = registry.getModelInfo('model-a');
      expect(info?.pinned).toBe(true);
    });

    it('should unpin a model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.pinModel('model-a');
      registry.unpinModel('model-a');

      const info = registry.getModelInfo('model-a');
      expect(info?.pinned).toBe(false);
    });

    it('should prevent eviction of pinned models', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.pinModel('model-a');

      await expect(registry.evictModel('model-a')).rejects.toThrow(
        'Cannot evict pinned model'
      );
    });
  });

  describe('manual eviction', () => {
    it('should evict a specific model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      expect(registry.isCached('model-a')).toBe(true);

      await registry.evictModel('model-a');
      expect(registry.isCached('model-a')).toBe(false);
      expect(mockManager.unloadModel).toHaveBeenCalledWith('model-a');
    });

    it('should do nothing when evicting non-existent model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.evictModel('non-existent');
      // Should not throw
    });
  });

  describe('cache information', () => {
    it('should check if model is cached', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      expect(registry.isCached('model-a')).toBe(false);

      await registry.getOrLoad('model-a');
      expect(registry.isCached('model-a')).toBe(true);
    });

    it('should get model info', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');

      const info = registry.getModelInfo('model-a');
      expect(info).toBeDefined();
      expect(info?.modelId).toBe('model-a');
      expect(info?.state).toBe('ready');
      expect(info?.memory.parameterCount).toBe(7_000_000_000);
    });

    it('should list cached models', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');

      const models = registry.listCachedModels();
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.modelId).sort()).toEqual(['model-a', 'model-b']);
    });
  });

  describe('statistics', () => {
    it('should track cache hit rate', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // 1 miss
      await registry.getOrLoad('model-a');

      // 2 hits
      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-a');

      const stats = registry.getStats();
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHits).toBe(2);
      expect(stats.cacheHitRate).toBeCloseTo(2 / 3);
    });

    it('should track evictions', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');
      await registry.getOrLoad('model-d'); // Evicts model-a

      const stats = registry.getStats();
      expect(stats.evictions).toBe(1);
    });

    it('should track top models', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');

      // Access model-b more
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-b');

      const stats = registry.getStats();
      expect(stats.topModels[0]?.modelId).toBe('model-b');
      expect(stats.topModels[0]?.accessCount).toBe(3);
    });

    it('should track average load time', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');

      const stats = registry.getStats();
      expect(stats.avgLoadTime).toBeGreaterThan(0);
    });

    it('should reset statistics', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-a');

      registry.resetStats();

      const stats = registry.getStats();
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.evictions).toBe(0);
    });
  });

  describe('GPU memory tracking', () => {
    it('should track total GPU memory', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');

      const stats = registry.getStats();
      expect(stats.totalGpuMemory).toBe(28 * 1024 * 1024 * 1024); // 14GB * 2
    });

    it('should get GPU memory stats', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');

      const gpuStats = await registry.getGpuMemoryStats();
      expect(gpuStats.usedMemory).toBeGreaterThan(0);
      expect(gpuStats.utilization).toBeGreaterThan(0);
      expect(gpuStats.utilization).toBeLessThanOrEqual(1);
    });
  });

  describe('eviction history', () => {
    it('should track eviction events', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      await registry.getOrLoad('model-b');
      await registry.getOrLoad('model-c');
      await registry.getOrLoad('model-d'); // Evicts model-a

      const history = registry.getEvictionHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.modelId).toBe('model-a');
      expect(history[0]?.reason).toBe('lru');
    });

    it('should bound eviction history', async () => {
      config.maxCachedModels = 1;
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load 101 models to generate 100 evictions
      for (let i = 0; i < 101; i++) {
        await registry.getOrLoad(`model-${i}`);
      }

      const history = registry.getEvictionHistory();
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('preloading', () => {
    it('should preload a model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.preloadModel('model-a');

      expect(registry.isCached('model-a')).toBe(true);
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1);
    });

    it('should skip preload if already cached', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1);

      await registry.preloadModel('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent loads of same model', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Load same model concurrently
      const [handle1, handle2, handle3] = await Promise.all([
        registry.getOrLoad('model-a'),
        registry.getOrLoad('model-a'),
        registry.getOrLoad('model-a'),
      ]);

      // Should only load once (deduplication handled by model manager)
      expect(handle1.descriptor.id).toBe('model-a');
      expect(handle2.descriptor.id).toBe('model-a');
      expect(handle3.descriptor.id).toBe('model-a');
    });

    it('should handle zero max cached models', async () => {
      config.maxCachedModels = 0;
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      // Should still work but evict immediately
      await expect(registry.getOrLoad('model-a')).rejects.toThrow();
    });

    it('should handle missing handle from manager', async () => {
      const registry = new ModelRegistry({ modelManager: mockManager, config });

      await registry.getOrLoad('model-a');

      // Simulate handle disappearing from manager
      (mockManager.getHandle as Mock).mockReturnValue(undefined);

      // Should reload
      await registry.getOrLoad('model-a');
      expect(mockManager.loadModel).toHaveBeenCalledTimes(2);
    });
  });
});
