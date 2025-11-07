/**
 * Model Artifact Cache Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelArtifactCache } from '../../../src/core/model-artifact-cache.js';
import type { CacheConfig } from '../../../src/types/cache.js';
import type { ModelDescriptor, LoadModelOptions } from '../../../src/types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('ModelArtifactCache', () => {
  let cache: ModelArtifactCache;
  let testCacheDir: string;
  let config: CacheConfig;

  beforeEach(async () => {
    // Create temporary cache directory for testing
    testCacheDir = path.join(tmpdir(), `kr-mlx-test-cache-${Date.now()}`);

    config = {
      enabled: true,
      cacheDir: testCacheDir,
      maxSizeBytes: 1000000, // 1MB for testing
      maxAgeDays: 30,
      evictionPolicy: 'lru',
      preloadModels: [],
      validateOnStartup: false,
      enableCompression: false,
    };

    cache = new ModelArtifactCache(config);
  });

  afterEach(async () => {
    // Clean up test cache directory
    try {
      await fs.rm(testCacheDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize cache directory structure', async () => {
      await cache.initialize();

      // Verify cache directory exists
      const cacheExists = await fs.access(testCacheDir).then(() => true).catch(() => false);
      expect(cacheExists).toBe(true);

      // Verify artifacts directory exists
      const artifactsDir = path.join(testCacheDir, 'artifacts');
      const artifactsExists = await fs.access(artifactsDir).then(() => true).catch(() => false);
      expect(artifactsExists).toBe(true);

      // Verify index.json was created
      const indexPath = path.join(testCacheDir, 'index.json');
      const indexExists = await fs.access(indexPath).then(() => true).catch(() => false);
      expect(indexExists).toBe(true);
    });

    it('should skip initialization when cache is disabled', async () => {
      const disabledConfig: CacheConfig = { ...config, enabled: false };
      const disabledCache = new ModelArtifactCache(disabledConfig);

      await disabledCache.initialize();

      // Cache directory should not be created
      const cacheExists = await fs.access(testCacheDir).then(() => true).catch(() => false);
      expect(cacheExists).toBe(false);
    });
  });

  describe('generateCacheKey', () => {
    it('should generate consistent cache keys for same descriptor and options', () => {
      const descriptor: ModelDescriptor = {
        id: 'test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
        revision: 'main',
        quantization: 'int4',
      };

      const key1 = cache.generateCacheKey(descriptor, options);
      const key2 = cache.generateCacheKey(descriptor, options);

      expect(key1).toBe(key2);
    });

    it('should generate different cache keys for different revisions', () => {
      const descriptor: ModelDescriptor = {
        id: 'test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options1: LoadModelOptions = {
        model: descriptor,
        revision: 'main',
      };

      const options2: LoadModelOptions = {
        model: descriptor,
        revision: 'dev',
      };

      const key1 = cache.generateCacheKey(descriptor, options1);
      const key2 = cache.generateCacheKey(descriptor, options2);

      expect(key1).not.toBe(key2);
    });

    it('should generate different cache keys for different quantizations', () => {
      const descriptor: ModelDescriptor = {
        id: 'test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options1: LoadModelOptions = {
        model: descriptor,
        quantization: 'none',
      };

      const options2: LoadModelOptions = {
        model: descriptor,
        quantization: 'int4',
      };

      const key1 = cache.generateCacheKey(descriptor, options1);
      const key2 = cache.generateCacheKey(descriptor, options2);

      expect(key1).not.toBe(key2);
    });
  });

  describe('lookup', () => {
    beforeEach(async () => {
      await cache.initialize();
    });

    it('should return cache miss for non-existent entry', async () => {
      const descriptor: ModelDescriptor = {
        id: 'non-existent-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
      };

      const result = await cache.lookup(descriptor, options);

      expect(result.hit).toBe(false);
      expect(result.entry).toBeUndefined();
      expect(result.artifactPath).toBeUndefined();
      expect(result.lookupTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return hit=false when cache is disabled', async () => {
      const disabledConfig: CacheConfig = { ...config, enabled: false };
      const disabledCache = new ModelArtifactCache(disabledConfig);

      const descriptor: ModelDescriptor = {
        id: 'test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
      };

      const result = await disabledCache.lookup(descriptor, options);

      expect(result.hit).toBe(false);
      expect(result.lookupTimeMs).toBe(0);
    });
  });

  describe('store and lookup integration', () => {
    let tempSourceDir: string;

    beforeEach(async () => {
      await cache.initialize();

      // Create temporary source directory with mock artifacts
      tempSourceDir = path.join(tmpdir(), `kr-mlx-test-source-${Date.now()}`);
      await fs.mkdir(tempSourceDir, { recursive: true });

      // Create mock artifact files
      await fs.writeFile(path.join(tempSourceDir, 'model.safetensors'), 'mock model data');
      await fs.writeFile(path.join(tempSourceDir, 'config.json'), '{"model_type": "test"}');
      await fs.writeFile(path.join(tempSourceDir, 'tokenizer.json'), '{"type": "BPE"}');
    });

    afterEach(async () => {
      try {
        await fs.rm(tempSourceDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should store and retrieve model artifacts', async () => {
      const descriptor: ModelDescriptor = {
        id: 'test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
        revision: 'main',
      };

      // Store artifacts
      const storeResult = await cache.store(descriptor, options, tempSourceDir, {
        modelId: descriptor.id,
        parameterCount: 1000000,
        dtype: 'float16',
        contextLength: 2048,
        modality: 'text',
      });

      expect(storeResult.success).toBe(true);
      expect(storeResult.hash).toBeTruthy();
      expect(storeResult.sizeBytes).toBeGreaterThan(0);

      // Lookup artifacts
      const lookupResult = await cache.lookup(descriptor, options);

      expect(lookupResult.hit).toBe(true);
      expect(lookupResult.entry).toBeDefined();
      expect(lookupResult.artifactPath).toBeTruthy();
      expect(lookupResult.entry?.sizeBytes).toBe(storeResult.sizeBytes);
    });

    it('should skip duplicate stores', async () => {
      const descriptor: ModelDescriptor = {
        id: 'test-model-dup',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
      };

      // First store
      const firstStore = await cache.store(descriptor, options, tempSourceDir, {
        modelId: descriptor.id,
        parameterCount: 1000000,
        dtype: 'float16',
        contextLength: 2048,
        modality: 'text',
      });

      expect(firstStore.success).toBe(true);

      // Second store (should skip)
      const secondStore = await cache.store(descriptor, options, tempSourceDir, {
        modelId: descriptor.id,
        parameterCount: 1000000,
        dtype: 'float16',
        contextLength: 2048,
        modality: 'text',
      });

      expect(secondStore.success).toBe(true);
      expect(secondStore.hash).toBe(firstStore.hash);
    });
  });

  describe('getHealth', () => {
    beforeEach(async () => {
      await cache.initialize();
    });

    it('should return healthy status for empty cache', async () => {
      const health = await cache.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.sizeBytes).toBe(0);
      expect(health.entryCount).toBe(0);
      expect(health.hitRate).toBe(0);
      expect(health.nearLimit).toBe(false);
    });

    it('should return healthy:true and zeros when cache is disabled', async () => {
      const disabledConfig: CacheConfig = { ...config, enabled: false };
      const disabledCache = new ModelArtifactCache(disabledConfig);

      const health = await disabledCache.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.sizeBytes).toBe(0);
      expect(health.entryCount).toBe(0);
    });
  });

  describe('clear', () => {
    let tempSourceDir: string;

    beforeEach(async () => {
      await cache.initialize();

      // Create temporary source directory
      tempSourceDir = path.join(tmpdir(), `kr-mlx-test-source-${Date.now()}`);
      await fs.mkdir(tempSourceDir, { recursive: true });
      await fs.writeFile(path.join(tempSourceDir, 'model.safetensors'), 'test data');
    });

    afterEach(async () => {
      try {
        await fs.rm(tempSourceDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore
      }
    });

    it('should clear all cache entries', async () => {
      const descriptor: ModelDescriptor = {
        id: 'clear-test-model',
        source: 'huggingface',
        modality: 'text',
        family: 'mlx-lm',
      };

      const options: LoadModelOptions = {
        model: descriptor,
      };

      // Store artifact
      await cache.store(descriptor, options, tempSourceDir, {
        modelId: descriptor.id,
        parameterCount: 1000,
        dtype: 'float16',
        contextLength: 2048,
        modality: 'text',
      });

      // Verify stored
      let lookup = await cache.lookup(descriptor, options);
      expect(lookup.hit).toBe(true);

      // Clear cache
      await cache.clear();

      // Verify cleared
      lookup = await cache.lookup(descriptor, options);
      expect(lookup.hit).toBe(false);

      const health = await cache.getHealth();
      expect(health.entryCount).toBe(0);
      expect(health.sizeBytes).toBe(0);
    });
  });
});
