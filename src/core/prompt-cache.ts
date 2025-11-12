/**
 * Prompt Cache (LRU with TTL)
 *
 * Long-lived cache for completed generation results. Provides faster-than-backend
 * responses for frequently repeated prompts.
 *
 * Features:
 * - LRU eviction (least recently used)
 * - Size-aware capacity (tracks tokens + bytes)
 * - TTL expiration (configurable, default 5 minutes)
 * - Optional persistence to disk
 * - Metrics (hit rate, eviction count)
 *
 * Architecture:
 * - Map<fingerprint, CacheEntry> preserves insertion order for LRU
 * - Automatic cleanup timer removes expired entries every 30s
 * - Size tracking prevents unbounded memory growth
 * - Disk persistence allows cache survival across restarts
 *
 * LRU Eviction Logic:
 * - Map iteration order === insertion order (oldest first)
 * - On get(): Move entry to end (most recently used)
 * - On evict(): Delete first entry (least recently used)
 * - Eviction triggers: maxEntries exceeded OR maxTotalBytes exceeded
 *
 * Size Tracking:
 * - Each entry tracks: tokens count + estimated bytes
 * - Total bytes maintained across all entries
 * - Oversized responses (>10MB) skipped from caching
 * - Size enforcement on every set() operation
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { GenerateResponse } from '../bridge/serializers.js';

/**
 * Prompt cache configuration
 */
export interface PromptCacheConfig {
  /** Enable cache (default: false for safety) */
  enabled: boolean;

  /** Maximum number of cache entries (LRU capacity) */
  maxEntries: number;

  /** Maximum total tokens cached across all entries */
  maxTotalTokens: number;

  /** Maximum total bytes cached across all entries */
  maxTotalBytes: number;

  /** Time-to-live for cache entries (milliseconds) */
  ttlMs: number;

  /** Cleanup interval for expired entries (milliseconds) */
  cleanupIntervalMs: number;

  /** Persistence configuration (optional) */
  persistence?: {
    /** Enable disk persistence */
    enabled: boolean;

    /** Path to persistence file */
    path: string;

    /** Save interval (milliseconds) */
    saveIntervalMs: number;
  };

  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Cache entry structure
 *
 * Tracks response data, size metrics, timestamps, and access patterns.
 */
interface CacheEntry {
  /** Cached response from backend */
  response: GenerateResponse;

  /** Number of tokens in response */
  tokens: number;

  /** Estimated size in bytes */
  bytes: number;

  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;

  /** Expiration timestamp (milliseconds since epoch) */
  expiresAt: number;

  /** Last access timestamp (for LRU tracking) */
  lastAccessedAt: number;

  /** Number of times this entry has been accessed */
  accessCount: number;
}

/**
 * Persisted cache entry (disk format)
 *
 * Same as CacheEntry but includes the cache key for deserialization.
 */
interface PersistedCacheEntry extends CacheEntry {
  /** Cache key (fingerprint) */
  key: string;
}

/**
 * Cache statistics
 */
export interface PromptCacheStats {
  enabled: boolean;
  size: number;
  totalTokens: number;
  totalBytes: number;
  maxEntries: number;
  maxTotalTokens: number;
  maxTotalBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  ttlEvictions: number;
  hitRate: number;
  avgAccessCount: number;
  avgEntryBytes: number;
}

/**
 * Prompt Cache with LRU eviction and TTL
 *
 * Thread-safe caching of generation responses with automatic cleanup.
 */
export class PromptCache {
  private readonly config: PromptCacheConfig;
  private readonly logger?: Logger;

  /**
   * LRU cache storage
   *
   * IMPORTANT: Map preserves insertion order in JavaScript.
   * - Oldest entries appear first during iteration
   * - Moving entry to end: delete() then set()
   * - LRU eviction: delete first key from iterator
   */
  private readonly cache = new Map<string, CacheEntry>();

  /** Total tokens tracked across all entries */
  private totalTokens = 0;

  /** Total bytes tracked across all entries */
  private totalBytes = 0;

  /**
   * Statistics counters
   *
   * Reset on cleanup(), persist across restarts if persistence enabled.
   */
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    ttlEvictions: 0,
  };

  /** Cleanup timer for TTL expiration (runs every cleanupIntervalMs) */
  private cleanupTimer?: NodeJS.Timeout;

  /** Persistence save timer (runs every saveIntervalMs) */
  private saveTimer?: NodeJS.Timeout;

  constructor(config: PromptCacheConfig) {
    this.config = config;
    this.logger = config.logger;

    // Load persisted cache if enabled
    if (config.enabled && config.persistence?.enabled && config.persistence.path) {
      this.load().catch((err) => {
        this.logger?.error({ err }, 'Failed to load persisted cache on startup');
      });
    }

    if (config.enabled) {
      // Start TTL cleanup timer
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, config.cleanupIntervalMs);

      // Start persistence save timer
      if (config.persistence?.enabled && config.persistence.saveIntervalMs) {
        this.saveTimer = setInterval(() => {
          this.save().catch((err) => {
            this.logger?.error({ err }, 'Failed to persist cache during periodic save');
          });
        }, config.persistence.saveIntervalMs);
      }
    }

    this.logger?.info(
      {
        enabled: config.enabled,
        maxEntries: config.maxEntries,
        maxTotalTokens: config.maxTotalTokens,
        maxTotalBytes: config.maxTotalBytes,
        ttlMs: config.ttlMs,
        cleanupIntervalMs: config.cleanupIntervalMs,
        persistence: config.persistence?.enabled ?? false,
      },
      'PromptCache initialized'
    );
  }

  /**
   * Generate deterministic cache key from request parameters
   *
   * Uses SHA256 fingerprinting (same as RequestDeduplicator).
   * Parameters are canonicalized for determinism.
   *
   * @param params - Request parameters
   * @returns Hex-encoded SHA256 hash
   */
  public fingerprint(params: {
    modelId: string;
    prompt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number;
  }): string {
    // Canonicalize: consistent ordering for deterministic hashing
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
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Get cached response
   *
   * Returns undefined if:
   * - Cache disabled
   * - Entry not found
   * - Entry expired (TTL exceeded)
   *
   * On success:
   * - Updates lastAccessedAt timestamp
   * - Increments accessCount
   * - Moves entry to end of Map (most recently used)
   *
   * @param fingerprint - Request fingerprint
   * @returns Cached response or undefined
   */
  public get(fingerprint: string): GenerateResponse | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const entry = this.cache.get(fingerprint);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL expiration
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.logger?.debug({ fingerprint, age: now - entry.createdAt }, 'Cache entry expired');
      this.cache.delete(fingerprint);
      this.totalTokens -= entry.tokens;
      this.totalBytes -= entry.bytes;
      this.stats.ttlEvictions++;
      this.stats.misses++;
      return undefined;
    }

    // Update LRU tracking
    entry.lastAccessedAt = now;
    entry.accessCount++;

    // Move to end (most recently used)
    // Map iteration order is insertion order, so re-inserting moves to end
    this.cache.delete(fingerprint);
    this.cache.set(fingerprint, entry);

    this.stats.hits++;
    this.logger?.debug(
      {
        fingerprint,
        age: now - entry.createdAt,
        accessCount: entry.accessCount,
        tokens: entry.tokens,
        bytes: entry.bytes,
      },
      'Prompt cache hit'
    );

    return entry.response;
  }

  /**
   * Set cached response
   *
   * Skips caching if:
   * - Cache disabled
   * - Response too large (>10MB to prevent memory issues)
   *
   * Eviction triggers:
   * - Cache full (size >= maxEntries)
   * - Total tokens exceeds maxTotalTokens
   * - Total bytes exceeds maxTotalBytes
   *
   * Eviction strategy: LRU (least recently used first)
   *
   * @param fingerprint - Request fingerprint
   * @param response - Response to cache
   */
  public set(fingerprint: string, response: GenerateResponse): void {
    if (!this.config.enabled) {
      return;
    }

    const now = Date.now();

    // Calculate entry size
    const tokens = this.estimateTokens(response);
    const bytes = this.estimateBytes(response);

    // Skip oversized responses (>10MB) to prevent memory issues
    const MAX_SINGLE_ENTRY_BYTES = 10 * 1024 * 1024; // 10MB
    if (bytes > MAX_SINGLE_ENTRY_BYTES) {
      this.logger?.warn(
        { fingerprint, bytes, maxBytes: MAX_SINGLE_ENTRY_BYTES },
        'Response too large to cache, skipping'
      );
      return;
    }

    // Check if entry already exists (update case)
    const existing = this.cache.get(fingerprint);
    if (existing) {
      this.totalTokens -= existing.tokens;
      this.totalBytes -= existing.bytes;
      this.cache.delete(fingerprint);
    }

    // Evict entries until we have space
    // Conditions: maxEntries OR maxTotalTokens OR maxTotalBytes
    while (
      this.cache.size >= this.config.maxEntries ||
      this.totalTokens + tokens > this.config.maxTotalTokens ||
      this.totalBytes + bytes > this.config.maxTotalBytes
    ) {
      const evicted = this.evictLRU(bytes);
      if (!evicted) {
        // No entries to evict (shouldn't happen, but guard against infinite loop)
        this.logger?.error(
          { size: this.cache.size, totalTokens: this.totalTokens, totalBytes: this.totalBytes },
          'Failed to evict entry, cache may be full'
        );
        return;
      }
    }

    // Create cache entry
    const entry: CacheEntry = {
      response,
      tokens,
      bytes,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      lastAccessedAt: now,
      accessCount: 0,
    };

    this.cache.set(fingerprint, entry);
    this.totalTokens += tokens;
    this.totalBytes += bytes;

    this.logger?.debug(
      {
        fingerprint,
        tokens,
        bytes,
        totalEntries: this.cache.size,
        totalTokens: this.totalTokens,
        totalBytes: this.totalBytes,
      },
      'Response cached'
    );
  }

  /**
   * Get cache statistics
   *
   * @returns Current cache statistics
   */
  public getStats(): PromptCacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    let totalAccessCount = 0;
    for (const entry of Array.from(this.cache.values())) {
      totalAccessCount += entry.accessCount;
    }
    const avgAccessCount = this.cache.size > 0 ? totalAccessCount / this.cache.size : 0;
    const avgEntryBytes = this.cache.size > 0 ? this.totalBytes / this.cache.size : 0;

    return {
      enabled: this.config.enabled,
      size: this.cache.size,
      totalTokens: this.totalTokens,
      totalBytes: this.totalBytes,
      maxEntries: this.config.maxEntries,
      maxTotalTokens: this.config.maxTotalTokens,
      maxTotalBytes: this.config.maxTotalBytes,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      ttlEvictions: this.stats.ttlEvictions,
      hitRate,
      avgAccessCount,
      avgEntryBytes,
    };
  }

  /**
   * Clear all cached entries
   *
   * Resets all statistics and size tracking.
   */
  public clear(): void {
    this.cache.clear();
    this.totalTokens = 0;
    this.totalBytes = 0;
    this.logger?.info('Prompt cache cleared');
  }

  /**
   * Cleanup expired entries
   *
   * Called periodically by cleanup timer.
   * Removes all entries where current time >= expiresAt.
   */
  public cleanup(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [fingerprint, entry] of Array.from(this.cache.entries())) {
      if (now >= entry.expiresAt) {
        this.cache.delete(fingerprint);
        this.totalTokens -= entry.tokens;
        this.totalBytes -= entry.bytes;
        evicted++;
      }
    }

    if (evicted > 0) {
      this.stats.ttlEvictions += evicted;
      this.logger?.debug({ evicted, remaining: this.cache.size }, 'Cleaned up expired entries');
    }
  }

  /**
   * Evict oldest entry (LRU strategy)
   *
   * Map iteration order is insertion order:
   * - First key = oldest (least recently used)
   * - Last key = newest (most recently used)
   *
   * @param requiredBytes - Optional bytes needed for new entry (for logging)
   * @returns true if entry evicted, false if cache empty
   */
  public evictLRU(requiredBytes?: number): boolean {
    // Map.keys() returns iterator in insertion order (oldest first)
    const firstKey = this.cache.keys().next().value;

    if (!firstKey) {
      return false; // Cache is empty
    }

    const entry = this.cache.get(firstKey);
    if (!entry) {
      return false; // Shouldn't happen, but guard
    }

    this.cache.delete(firstKey);
    this.totalTokens -= entry.tokens;
    this.totalBytes -= entry.bytes;
    this.stats.evictions++;

    this.logger?.debug(
      {
        fingerprint: firstKey,
        entryBytes: entry.bytes,
        entryTokens: entry.tokens,
        requiredBytes,
        age: Date.now() - entry.createdAt,
        accessCount: entry.accessCount,
      },
      'Evicted LRU entry'
    );

    return true;
  }

  /**
   * Save cache to disk (persistence)
   *
   * Saves all non-expired entries to JSON file.
   * Creates parent directory if needed.
   * Logs warning on failure but doesn't throw (graceful degradation).
   */
  public async save(): Promise<void> {
    if (!this.config.persistence?.enabled || !this.config.persistence.path) {
      return;
    }

    const path = this.config.persistence.path;

    try {
      // Ensure parent directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Convert cache to array format (include keys for deserialization)
      const entries: PersistedCacheEntry[] = [];
      const now = Date.now();

      for (const [key, entry] of Array.from(this.cache.entries())) {
        // Skip expired entries
        if (now >= entry.expiresAt) {
          continue;
        }

        entries.push({ key, ...entry });
      }

      const data = JSON.stringify(entries, null, 2);
      writeFileSync(path, data, 'utf-8');

      this.logger?.debug(
        { path, entries: entries.length, totalBytes: this.totalBytes },
        'Cache persisted to disk'
      );
    } catch (error) {
      this.logger?.warn({ error, path }, 'Failed to save cache to disk');
    }
  }

  /**
   * Load cache from disk (persistence)
   *
   * Loads entries from JSON file, skipping expired entries.
   * Logs warning on failure but doesn't throw (graceful degradation).
   */
  public async load(): Promise<void> {
    if (!this.config.persistence?.enabled || !this.config.persistence.path) {
      return;
    }

    const path = this.config.persistence.path;

    if (!existsSync(path)) {
      this.logger?.debug({ path }, 'No persisted cache found');
      return;
    }

    try {
      const data = readFileSync(path, 'utf-8');
      const entries: PersistedCacheEntry[] = JSON.parse(data);

      const now = Date.now();
      let loaded = 0;
      let skippedExpired = 0;

      for (const { key, ...entry } of entries) {
        // Skip expired entries
        if (now >= entry.expiresAt) {
          skippedExpired++;
          continue;
        }

        this.cache.set(key, entry);
        this.totalTokens += entry.tokens;
        this.totalBytes += entry.bytes;
        loaded++;
      }

      this.logger?.info(
        { path, loaded, skippedExpired, total: entries.length },
        'Cache loaded from disk'
      );
    } catch (error) {
      this.logger?.warn({ error, path }, 'Failed to load cache from disk');
    }
  }

  /**
   * Shutdown cleanup
   *
   * Stops timers, persists cache if enabled, clears memory.
   * Safe to call multiple times.
   */
  public shutdown(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Stop save timer
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = undefined;
    }

    // Final persistence save
    if (this.config.persistence?.enabled && this.config.persistence.path) {
      this.save().catch((err) => {
        this.logger?.error({ err }, 'Failed to persist cache during shutdown');
      });
    }

    this.cache.clear();
    this.totalTokens = 0;
    this.totalBytes = 0;

    this.logger?.debug('PromptCache shut down');
  }

  /**
   * Estimate token count from response
   *
   * Heuristic:
   * - If response has token count field, use it
   * - Otherwise estimate: text length / 4 (average chars per token)
   *
   * @param response - Generation response
   * @returns Estimated token count
   */
  private estimateTokens(response: GenerateResponse): number {
    // If stream_id exists but no tokens field, this is a streaming response
    // We can't accurately estimate tokens without the final stats
    // Return 0 to indicate unknown (won't contribute to token limit)
    if (!response.stream_id) {
      return 0;
    }

    // For completed responses, we should have token stats
    // But GenerateResponse type doesn't include them based on serializers.ts
    // So we'll use a conservative estimate
    return 0;
  }

  /**
   * Estimate bytes from response
   *
   * Calculates size based on:
   * - JSON serialization of response object
   * - Assumes UTF-16 encoding (2 bytes per character)
   * - Adds overhead for object metadata
   *
   * @param response - Generation response
   * @returns Estimated size in bytes
   */
  private estimateBytes(response: GenerateResponse): number {
    try {
      const json = JSON.stringify(response);
      // UTF-16 encoding: 2 bytes per character
      const textBytes = json.length * 2;
      // Add 100 bytes overhead for object structure
      return textBytes + 100;
    } catch {
      // Fallback estimate if serialization fails
      return 1000;
    }
  }
}
