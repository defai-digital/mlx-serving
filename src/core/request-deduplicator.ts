/**
 * Request Deduplicator
 *
 * Collapses identical concurrent requests into a shared Promise to avoid
 * redundant Python invocations. Uses SHA256 fingerprinting for deterministic
 * cache keys.
 *
 * Architecture:
 * - TTL-based Map<fingerprint, Promise<GenerationResult>>
 * - Automatic eviction after TTL expires
 * - Rejection propagation (cache poisoning prevention)
 * - Memory pressure guard (max entries)
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { GenerateResponse } from '../bridge/serializers.js';

/**
 * Deduplication configuration
 */
export interface RequestDeduplicatorConfig {
  /** Enable deduplication (default: false for safety) */
  enabled: boolean;

  /** Time-to-live for cached promises (milliseconds) */
  ttlMs: number;

  /** Maximum cache entries (memory pressure guard) */
  maxEntries: number;

  /** Maximum payload size to fingerprint (bytes) */
  maxPayloadBytes: number;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Cache entry with expiration tracking
 */
interface CacheEntry {
  promise: Promise<GenerateResponse>;
  expiresAt: number;
  fingerprint: string;
  createdAt: number;
}

/**
 * Request fingerprint parameters
 * MUST be canonicalized for deterministic hashing
 */
export interface FingerprintParams {
  modelId: string;
  prompt: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  seed?: number;
  // Exclude stream_id, requestId, signal (non-deterministic)
}

/**
 * Request Deduplicator
 *
 * Thread-safe deduplication of concurrent generation requests.
 */
export class RequestDeduplicator {
  private readonly config: RequestDeduplicatorConfig;
  private readonly logger?: Logger;

  // Cache storage: Map<fingerprint, CacheEntry>
  private readonly cache = new Map<string, CacheEntry>();

  // Cleanup timer for TTL expiration
  private cleanupTimer?: NodeJS.Timeout;

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    rejections: 0,
    oversizePayloads: 0,
  };

  constructor(config: RequestDeduplicatorConfig) {
    this.config = config;
    this.logger = config.logger;

    // Start cleanup timer (check every 1s for expired entries)
    if (config.enabled) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, 1000);
    }

    this.logger?.info(
      {
        enabled: config.enabled,
        ttlMs: config.ttlMs,
        maxEntries: config.maxEntries,
      },
      'RequestDeduplicator initialized'
    );
  }

  /**
   * Generate deterministic fingerprint for request
   *
   * Uses SHA256 hash of canonicalized parameters.
   *
   * @param params - Request parameters to fingerprint
   * @returns Hex-encoded SHA256 hash
   */
  public fingerprint(params: FingerprintParams): string {
    // Canonicalize: sort object keys for determinism
    const canonical = {
      modelId: params.modelId,
      prompt: params.prompt,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { topP: params.topP }),
      ...(params.topK !== undefined && { topK: params.topK }),
      ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
      ...(params.seed !== undefined && { seed: params.seed }),
    };

    const payload = JSON.stringify(canonical);

    // Guard against memory attacks (huge payloads)
    if (payload.length > this.config.maxPayloadBytes) {
      this.stats.oversizePayloads++;
      this.logger?.warn(
        { payloadSize: payload.length, maxSize: this.config.maxPayloadBytes },
        'Payload exceeds max fingerprint size, skipping dedup'
      );
      // Return unique hash to avoid dedup (but don't throw)
      return createHash('sha256')
        .update(payload + Date.now() + Math.random())
        .digest('hex');
    }

    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Get cached promise for request (if exists and not expired)
   *
   * @param fingerprint - Request fingerprint
   * @returns Cached promise or undefined
   */
  public get(fingerprint: string): Promise<GenerateResponse> | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const entry = this.cache.get(fingerprint);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check expiration
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.logger?.debug({ fingerprint }, 'Cache entry expired, removing');
      this.cache.delete(fingerprint);
      this.stats.evictions++;
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;
    this.logger?.debug(
      { fingerprint, age: now - entry.createdAt },
      'Cache hit for request'
    );

    return entry.promise;
  }

  /**
   * Set cached promise for request
   *
   * Automatically wraps promise to handle rejections (cache poisoning prevention).
   *
   * @param fingerprint - Request fingerprint
   * @param promise - Promise to cache
   * @returns Wrapped promise (same as input but with rejection handler)
   */
  public set(
    fingerprint: string,
    promise: Promise<GenerateResponse>
  ): Promise<GenerateResponse> {
    if (!this.config.enabled) {
      return promise;
    }

    // Memory pressure guard
    if (this.cache.size >= this.config.maxEntries) {
      this.logger?.warn(
        { size: this.cache.size, maxEntries: this.config.maxEntries },
        'Cache full, evicting oldest entry'
      );
      this.evictOldest();
    }

    const now = Date.now();
    const entry: CacheEntry = {
      promise,
      expiresAt: now + this.config.ttlMs,
      fingerprint,
      createdAt: now,
    };

    this.cache.set(fingerprint, entry);

    // Wrap promise to delete on rejection (prevent cache poisoning)
    const wrapped = promise.catch((error) => {
      this.logger?.debug({ fingerprint, error }, 'Request failed, removing from cache');
      this.cache.delete(fingerprint);
      this.stats.rejections++;
      throw error; // Re-throw to propagate to caller
    });

    this.logger?.debug(
      { fingerprint, ttlMs: this.config.ttlMs },
      'Request cached'
    );

    return wrapped;
  }

  /**
   * Cleanup expired entries
   * Called periodically by timer
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [fingerprint, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(fingerprint);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.stats.evictions += evicted;
      this.logger?.debug({ evicted }, 'Cleaned up expired cache entries');
    }
  }

  /**
   * Evict oldest entry (FIFO)
   */
  private evictOldest(): void {
    // Map iteration order is insertion order
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }
  }

  /**
   * Get deduplication statistics
   */
  public getStats(): {
    enabled: boolean;
    size: number;
    hits: number;
    misses: number;
    evictions: number;
    rejections: number;
    oversizePayloads: number;
    hitRate: number;
  } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    return {
      enabled: this.config.enabled,
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      rejections: this.stats.rejections,
      oversizePayloads: this.stats.oversizePayloads,
      hitRate,
    };
  }

  /**
   * Clear all cached promises
   */
  public clear(): void {
    this.cache.clear();
    this.logger?.info('Cache cleared');
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
    this.logger?.debug('RequestDeduplicator cleaned up');
  }
}
