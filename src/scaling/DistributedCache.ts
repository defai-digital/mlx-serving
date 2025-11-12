/**
 * Distributed Cache (Week 3)
 *
 * Redis-backed distributed cache for sharing KV caches across multiple instances.
 *
 * Features:
 * - Redis backend for shared state
 * - Local cache fallback when Redis unavailable
 * - Cache coherence protocol
 * - Compression for large values
 * - Automatic TTL management
 * - Comprehensive metrics
 */

import type { RedisClientType } from 'redis';
import { createClient } from 'redis';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import type { CacheEntry, CacheMetrics, DistributedCacheConfig } from '@/types/scaling.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Distributed Cache
 *
 * Shares cache entries across multiple instances via Redis.
 */
export class DistributedCache<T = unknown> {
  private config: DistributedCacheConfig;
  private redis?: RedisClientType;
  private redisConnected = false;
  private localCache: Map<string, CacheEntry<T>> = new Map();
  private connectionAttempts = 0;
  private maxConnectionAttempts = 3;

  // Metrics
  private hits = 0;
  private misses = 0;
  private localFallbackCount = 0;

  constructor(config: DistributedCacheConfig) {
    this.config = config;

    if (config.enabled && config.redisUrl) {
      this.initRedis().catch((error) => {
        console.error('Failed to initialize Redis:', error);
      });
    }
  }

  /**
   * Initialize Redis connection
   */
  private async initRedis(): Promise<void> {
    if (!this.config.redisUrl) {
      return;
    }

    try {
      this.redis = createClient({
        url: this.config.redisUrl,
        socket: {
          connectTimeout: this.config.connectionTimeoutMs,
          commandTimeout: this.config.commandTimeoutMs,
        },
      });

      // Setup error handlers
      this.redis.on('error', (error) => {
        console.error('Redis error:', error);
        this.redisConnected = false;
      });

      this.redis.on('connect', () => {
        console.log('Redis connected');
        this.redisConnected = true;
        this.connectionAttempts = 0;
      });

      this.redis.on('disconnect', () => {
        console.log('Redis disconnected');
        this.redisConnected = false;
      });

      // Connect
      await this.redis.connect();
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      this.connectionAttempts++;

      // Retry with backoff
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 10000);
        setTimeout(() => {
          this.initRedis().catch((error) => {
            console.error('Redis reconnection failed:', error);
          });
        }, delay);
      }
    }
  }

  /**
   * Get value from cache
   */
  async get(key: string): Promise<T | null> {
    const fullKey = `${this.config.keyPrefix}:${key}`;

    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        const value = await this.redis.get(fullKey);

        if (value) {
          this.hits++;
          return await this.deserializeValue(value);
        }
      } catch (error) {
        console.error('Redis get error:', error);
        this.redisConnected = false;

        // Fall through to local cache
        if (this.config.enableLocalFallback) {
          this.localFallbackCount++;
        }
      }
    }

    // Try local cache if fallback enabled
    if (this.config.enableLocalFallback) {
      const entry = this.localCache.get(fullKey);

      if (entry) {
        // Check if expired
        const now = Date.now();
        const age = (now - entry.createdAt) / 1000;

        if (age < entry.ttl) {
          this.hits++;
          return entry.value;
        } else {
          // Expired, remove
          this.localCache.delete(fullKey);
        }
      }
    }

    this.misses++;
    return null;
  }

  /**
   * Set value in cache
   */
  async set(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const fullKey = `${this.config.keyPrefix}:${key}`;
    const ttl = ttlSeconds || this.config.defaultTtlSeconds;

    // Serialize value
    const serialized = await this.serializeValue(value);

    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        await this.redis.setEx(fullKey, ttl, serialized);
      } catch (error) {
        console.error('Redis set error:', error);
        this.redisConnected = false;

        // Fall through to local cache
        if (this.config.enableLocalFallback) {
          this.localFallbackCount++;
        }
      }
    }

    // Update local cache if fallback enabled
    if (this.config.enableLocalFallback) {
      const entry: CacheEntry<T> = {
        key: fullKey,
        value,
        ttl,
        createdAt: Date.now(),
        sizeBytes: serialized.length,
        compressed: false,
      };

      this.localCache.set(fullKey, entry);

      // Evict if over capacity
      this.evictLocalCacheIfNeeded();
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<void> {
    const fullKey = `${this.config.keyPrefix}:${key}`;

    // Delete from Redis
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        await this.redis.del(fullKey);
      } catch (error) {
        console.error('Redis delete error:', error);
      }
    }

    // Delete from local cache
    if (this.config.enableLocalFallback) {
      this.localCache.delete(fullKey);
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    // Clear Redis keys with prefix
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        const pattern = `${this.config.keyPrefix}:*`;
        const keys = await this.redis.keys(pattern);

        if (keys.length > 0) {
          await this.redis.del(keys);
        }
      } catch (error) {
        console.error('Redis clear error:', error);
      }
    }

    // Clear local cache
    if (this.config.enableLocalFallback) {
      this.localCache.clear();
    }
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    const fullKey = `${this.config.keyPrefix}:${key}`;

    // Check Redis first
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        const exists = await this.redis.exists(fullKey);
        return exists === 1;
      } catch (error) {
        console.error('Redis exists error:', error);
      }
    }

    // Check local cache
    if (this.config.enableLocalFallback) {
      const entry = this.localCache.get(fullKey);

      if (entry) {
        // Check if expired
        const now = Date.now();
        const age = (now - entry.createdAt) / 1000;

        if (age < entry.ttl) {
          return true;
        } else {
          this.localCache.delete(fullKey);
        }
      }
    }

    return false;
  }

  /**
   * Get multiple values at once
   */
  async mget(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();

    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis && keys.length > 0) {
      try {
        const fullKeys = keys.map((key) => `${this.config.keyPrefix}:${key}`);
        const values = await this.redis.mGet(fullKeys);

        for (let i = 0; i < keys.length; i++) {
          const value = values[i];
          if (value) {
            const deserialized = await this.deserializeValue(value);
            result.set(keys[i], deserialized);
          }
        }

        return result;
      } catch (error) {
        console.error('Redis mget error:', error);
      }
    }

    // Fallback to local cache
    if (this.config.enableLocalFallback) {
      for (const key of keys) {
        const value = await this.get(key);
        if (value !== null) {
          result.set(key, value);
        }
      }
    }

    return result;
  }

  /**
   * Set multiple values at once
   */
  async mset(entries: Map<string, T>, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds || this.config.defaultTtlSeconds;

    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis && entries.size > 0) {
      try {
        // Redis doesn't support mset with TTL, so we use pipeline
        const pipeline = this.redis.multi();

        for (const [key, value] of entries) {
          const fullKey = `${this.config.keyPrefix}:${key}`;
          const serialized = await this.serializeValue(value);
          pipeline.setEx(fullKey, ttl, serialized);
        }

        await pipeline.exec();
      } catch (error) {
        console.error('Redis mset error:', error);
      }
    }

    // Update local cache if fallback enabled
    if (this.config.enableLocalFallback) {
      for (const [key, value] of entries) {
        await this.set(key, value, ttl);
      }
    }
  }

  /**
   * Serialize value to string
   */
  private async serializeValue(value: T): Promise<string> {
    const json = JSON.stringify(value);

    // Compress if enabled and value is large
    if (this.config.enableCompression && json.length > this.config.compressionThresholdBytes) {
      const compressed = await gzipAsync(Buffer.from(json, 'utf-8'));
      return `gz:${compressed.toString('base64')}`;
    }

    return json;
  }

  /**
   * Deserialize value from string
   */
  private async deserializeValue(serialized: string): Promise<T> {
    // Check if compressed
    if (serialized.startsWith('gz:')) {
      const base64 = serialized.substring(3);
      const compressed = Buffer.from(base64, 'base64');
      const decompressed = await gunzipAsync(compressed);
      return JSON.parse(decompressed.toString('utf-8'));
    }

    return JSON.parse(serialized);
  }

  /**
   * Evict local cache entries if over capacity
   */
  private evictLocalCacheIfNeeded(): void {
    if (this.localCache.size <= this.config.localCacheSize) {
      return;
    }

    // Evict oldest entries (LRU)
    const entries = Array.from(this.localCache.entries());

    // Sort by creation time
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);

    // Remove oldest 20%
    const toRemove = Math.ceil(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.localCache.delete(entries[i][0]);
    }
  }

  /**
   * Get cache metrics
   */
  getMetrics(): CacheMetrics {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? this.hits / total : 0;

    let entries = 0;
    let sizeBytes = 0;

    if (this.config.enableLocalFallback) {
      entries = this.localCache.size;
      for (const entry of this.localCache.values()) {
        sizeBytes += entry.sizeBytes;
      }
    }

    const avgEntrySizeBytes = entries > 0 ? sizeBytes / entries : 0;

    // Determine cache type
    let type: 'distributed' | 'local' | 'hybrid' = 'local';
    if (this.config.enabled && this.redisConnected) {
      type = this.config.enableLocalFallback ? 'hybrid' : 'distributed';
    }

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate,
      entries,
      sizeBytes,
      avgEntrySizeBytes,
      type,
      redisConnected: this.redisConnected,
      localFallbackCount: this.localFallbackCount,
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.localFallbackCount = 0;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redisConnected = false;
    }
  }

  /**
   * Ping Redis to check connection
   */
  async ping(): Promise<boolean> {
    if (!this.redis || !this.redisConnected) {
      return false;
    }

    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('Redis ping error:', error);
      return false;
    }
  }

  /**
   * Get cache size (number of entries)
   */
  async size(): Promise<number> {
    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        const pattern = `${this.config.keyPrefix}:*`;
        const keys = await this.redis.keys(pattern);
        return keys.length;
      } catch (error) {
        console.error('Redis size error:', error);
      }
    }

    // Fallback to local cache
    if (this.config.enableLocalFallback) {
      return this.localCache.size;
    }

    return 0;
  }

  /**
   * Get all keys
   */
  async keys(pattern?: string): Promise<string[]> {
    const searchPattern = pattern
      ? `${this.config.keyPrefix}:${pattern}`
      : `${this.config.keyPrefix}:*`;

    // Try Redis first
    if (this.config.enabled && this.redisConnected && this.redis) {
      try {
        const keys = await this.redis.keys(searchPattern);
        return keys.map((key) => key.replace(`${this.config.keyPrefix}:`, ''));
      } catch (error) {
        console.error('Redis keys error:', error);
      }
    }

    // Fallback to local cache
    if (this.config.enableLocalFallback) {
      const allKeys = Array.from(this.localCache.keys());
      const filtered = allKeys.filter((key) => {
        const shortKey = key.replace(`${this.config.keyPrefix}:`, '');
        return pattern ? shortKey.includes(pattern) : true;
      });
      return filtered.map((key) => key.replace(`${this.config.keyPrefix}:`, ''));
    }

    return [];
  }
}

/**
 * Default distributed cache configuration
 */
export const DEFAULT_DISTRIBUTED_CACHE_CONFIG: DistributedCacheConfig = {
  enabled: false, // Disabled by default for safety
  redisUrl: undefined,
  keyPrefix: 'mlx-serving',
  defaultTtlSeconds: 300, // 5 minutes
  maxSizeBytes: 1073741824, // 1 GB
  enableCompression: true,
  compressionThresholdBytes: 10240, // 10 KB
  enableLocalFallback: true,
  localCacheSize: 1000,
  connectionTimeoutMs: 5000,
  commandTimeoutMs: 3000,
};
