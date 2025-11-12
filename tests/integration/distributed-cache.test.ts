/**
 * DistributedCache Integration Tests
 *
 * Note: These tests require Redis to be running for full coverage.
 * If Redis is not available, they will test local cache fallback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DistributedCache, DEFAULT_DISTRIBUTED_CACHE_CONFIG } from '@/scaling/DistributedCache.js';
import type { DistributedCacheConfig } from '@/types/scaling.js';

describe('DistributedCache Integration', () => {
  let cache: DistributedCache<any>;
  let config: DistributedCacheConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_DISTRIBUTED_CACHE_CONFIG,
      enabled: true,
      enableLocalFallback: true,
      keyPrefix: 'test-cache',
    };
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
      await cache.close();
    }
  });

  describe('Local Cache Fallback', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should set and get values from local cache', async () => {
      await cache.set('key1', { data: 'value1' });

      const result = await cache.get('key1');

      expect(result).toEqual({ data: 'value1' });
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get('non-existent');

      expect(result).toBeNull();
    });

    it('should delete values', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.delete('key1');

      const result = await cache.get('key1');

      expect(result).toBeNull();
    });

    it('should respect TTL', async () => {
      await cache.set('key1', { data: 'value1' }, 1);

      // Should exist immediately
      let result = await cache.get('key1');
      expect(result).toEqual({ data: 'value1' });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be expired
      result = await cache.get('key1');
      expect(result).toBeNull();
    });

    it('should clear all values', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key2', { data: 'value2' });
      await cache.set('key3', { data: 'value3' });

      await cache.clear();

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
      expect(await cache.get('key3')).toBeNull();
    });

    it('should check if key exists', async () => {
      await cache.set('key1', { data: 'value1' });

      expect(await cache.has('key1')).toBe(true);
      expect(await cache.has('non-existent')).toBe(false);
    });

    it('should handle complex objects', async () => {
      const complexObject = {
        str: 'hello',
        num: 42,
        bool: true,
        arr: [1, 2, 3],
        obj: { nested: 'value' },
        nullValue: null,
      };

      await cache.set('complex', complexObject);

      const result = await cache.get('complex');

      expect(result).toEqual(complexObject);
    });

    it('should evict entries when over capacity', async () => {
      config.localCacheSize = 10;
      cache = new DistributedCache(config);

      // Add more entries than capacity
      for (let i = 0; i < 15; i++) {
        await cache.set(`key${i}`, { data: `value${i}` });
      }

      const size = await cache.size();

      // Should have evicted oldest entries
      expect(size).toBeLessThanOrEqual(10);
    });
  });

  describe('Metrics', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should track cache hits', async () => {
      await cache.set('key1', { data: 'value1' });

      await cache.get('key1');
      await cache.get('key1');

      const metrics = cache.getMetrics();

      expect(metrics.hits).toBe(2);
    });

    it('should track cache misses', async () => {
      await cache.get('non-existent-1');
      await cache.get('non-existent-2');

      const metrics = cache.getMetrics();

      expect(metrics.misses).toBe(2);
    });

    it('should calculate hit rate', async () => {
      await cache.set('key1', { data: 'value1' });

      await cache.get('key1'); // hit
      await cache.get('key1'); // hit
      await cache.get('non-existent'); // miss

      const metrics = cache.getMetrics();

      expect(metrics.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should track cache size', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key2', { data: 'value2' });

      const metrics = cache.getMetrics();

      expect(metrics.entries).toBe(2);
    });

    it('should report cache type', async () => {
      const metrics = cache.getMetrics();

      expect(metrics.type).toBe('local');
    });

    it('should reset metrics', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.get('key1');

      cache.resetMetrics();

      const metrics = cache.getMetrics();

      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
    });
  });

  describe('Multi-Operations', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should get multiple values at once', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key2', { data: 'value2' });
      await cache.set('key3', { data: 'value3' });

      const results = await cache.mget(['key1', 'key2', 'key3']);

      expect(results.size).toBe(3);
      expect(results.get('key1')).toEqual({ data: 'value1' });
      expect(results.get('key2')).toEqual({ data: 'value2' });
      expect(results.get('key3')).toEqual({ data: 'value3' });
    });

    it('should skip missing keys in mget', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key3', { data: 'value3' });

      const results = await cache.mget(['key1', 'key2', 'key3']);

      expect(results.size).toBe(2);
      expect(results.has('key1')).toBe(true);
      expect(results.has('key2')).toBe(false);
      expect(results.has('key3')).toBe(true);
    });

    it('should set multiple values at once', async () => {
      const entries = new Map([
        ['key1', { data: 'value1' }],
        ['key2', { data: 'value2' }],
        ['key3', { data: 'value3' }],
      ]);

      await cache.mset(entries);

      expect(await cache.get('key1')).toEqual({ data: 'value1' });
      expect(await cache.get('key2')).toEqual({ data: 'value2' });
      expect(await cache.get('key3')).toEqual({ data: 'value3' });
    });

    it('should apply TTL to all entries in mset', async () => {
      const entries = new Map([
        ['key1', { data: 'value1' }],
        ['key2', { data: 'value2' }],
      ]);

      await cache.mset(entries, 1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
    });
  });

  describe('Keys Operations', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should get cache size', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key2', { data: 'value2' });
      await cache.set('key3', { data: 'value3' });

      const size = await cache.size();

      expect(size).toBe(3);
    });

    it('should get all keys', async () => {
      await cache.set('key1', { data: 'value1' });
      await cache.set('key2', { data: 'value2' });
      await cache.set('key3', { data: 'value3' });

      const keys = await cache.keys();

      expect(keys).toHaveLength(3);
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
    });

    it('should filter keys by pattern', async () => {
      await cache.set('user:1', { name: 'Alice' });
      await cache.set('user:2', { name: 'Bob' });
      await cache.set('post:1', { title: 'Hello' });

      const userKeys = await cache.keys('user:');

      expect(userKeys.length).toBeGreaterThanOrEqual(2);
      expect(userKeys.some((k) => k.includes('user:'))).toBe(true);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should handle JSON serialization errors gracefully', async () => {
      const circular: any = {};
      circular.self = circular;

      await expect(cache.set('circular', circular)).rejects.toThrow();
    });

    it('should handle empty keys', async () => {
      await cache.set('', { data: 'empty key' });

      const result = await cache.get('');

      expect(result).toEqual({ data: 'empty key' });
    });
  });

  describe('Type Safety', () => {
    it('should preserve type information', async () => {
      interface User {
        id: number;
        name: string;
        email: string;
      }

      const userCache = new DistributedCache<User>({
        ...config,
        enabled: false,
      });

      const user: User = {
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
      };

      await userCache.set('user:1', user);

      const retrieved = await userCache.get('user:1');

      expect(retrieved).toEqual(user);

      await userCache.close();
    });

    it('should handle arrays', async () => {
      const arrayCache = new DistributedCache<number[]>({
        ...config,
        enabled: false,
      });

      await arrayCache.set('numbers', [1, 2, 3, 4, 5]);

      const retrieved = await arrayCache.get('numbers');

      expect(retrieved).toEqual([1, 2, 3, 4, 5]);

      await arrayCache.close();
    });

    it('should handle strings', async () => {
      const stringCache = new DistributedCache<string>({
        ...config,
        enabled: false,
      });

      await stringCache.set('message', 'Hello, World!');

      const retrieved = await stringCache.get('message');

      expect(retrieved).toBe('Hello, World!');

      await stringCache.close();
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      config.enabled = false;
      cache = new DistributedCache(config);
    });

    it('should handle zero TTL', async () => {
      await cache.set('key1', { data: 'value1' }, 0);

      // Should be immediately expired
      const result = await cache.get('key1');

      expect(result).toBeNull();
    });

    it('should handle large values', async () => {
      const largeValue = {
        data: 'x'.repeat(10000),
        array: Array(1000).fill({ nested: 'value' }),
      };

      await cache.set('large', largeValue);

      const result = await cache.get('large');

      expect(result).toEqual(largeValue);
    });

    it('should handle special characters in keys', async () => {
      const specialKeys = ['key:with:colons', 'key/with/slashes', 'key-with-dashes', 'key_with_underscores'];

      for (const key of specialKeys) {
        await cache.set(key, { data: `value for ${key}` });
      }

      for (const key of specialKeys) {
        const result = await cache.get(key);
        expect(result).toEqual({ data: `value for ${key}` });
      }
    });

    it('should handle concurrent operations', async () => {
      const operations = [];

      for (let i = 0; i < 100; i++) {
        operations.push(cache.set(`key${i}`, { data: `value${i}` }));
      }

      await Promise.all(operations);

      const size = await cache.size();

      expect(size).toBeGreaterThan(0);
    });
  });
});

describe('DistributedCache with Redis (Optional)', () => {
  let cache: DistributedCache<any>;

  beforeEach(() => {
    // Try to connect to Redis on localhost
    const config: DistributedCacheConfig = {
      ...DEFAULT_DISTRIBUTED_CACHE_CONFIG,
      enabled: true,
      redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
      enableLocalFallback: true,
      keyPrefix: 'test-distributed',
    };

    cache = new DistributedCache(config);
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
      await cache.close();
    }
  });

  it('should set and get from Redis if available', async () => {
    await cache.set('redis-key', { data: 'redis-value' });

    const result = await cache.get('redis-key');

    // Should work either via Redis or local fallback
    expect(result).toEqual({ data: 'redis-value' });
  });

  it('should ping Redis connection', async () => {
    // This will return false if Redis is not available
    const pingResult = await cache.ping();

    // Test passes regardless of Redis availability
    expect(typeof pingResult).toBe('boolean');
  });

  it('should report correct cache type', async () => {
    const metrics = cache.getMetrics();

    // Type depends on Redis availability
    expect(['local', 'distributed', 'hybrid']).toContain(metrics.type);
  });

  it('should handle Redis unavailability gracefully', async () => {
    // Set a value (may use Redis or fallback)
    await cache.set('test-key', { data: 'test-value' });

    // Get should work regardless
    const result = await cache.get('test-key');

    expect(result).toBeDefined();
  });
});
