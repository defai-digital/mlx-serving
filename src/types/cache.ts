/**
 * Model Artifact Cache Types
 *
 * Type definitions for the persistent model artifact cache system.
 * Implements content-addressed storage for model weights, tokenizers, and configs.
 *
 * @module types/cache
 */

/**
 * Cache entry metadata stored in the cache index
 */
export interface CacheEntry {
  /** Content-addressed hash of the model artifacts */
  hash: string;

  /** ISO timestamp when entry was created */
  created: string;

  /** ISO timestamp when entry was last accessed */
  lastAccessed: string;

  /** Number of times this entry has been accessed */
  accessCount: number;

  /** Total size of cached artifacts in bytes */
  sizeBytes: number;

  /** Average load time from cache in milliseconds */
  loadTimeMs?: number;

  /** Model metadata from when it was cached */
  metadata: CacheEntryMetadata;
}

/**
 * Model metadata stored with cache entry
 */
export interface CacheEntryMetadata {
  /** Model identifier */
  modelId: string;

  /** Model parameter count */
  parameterCount: number;

  /** Model data type (e.g., "float16", "bfloat16") */
  dtype: string;

  /** Maximum context length in tokens */
  contextLength: number;

  /** Modality (text, vision, etc.) */
  modality: string;

  /** Quantization mode if any */
  quantization?: string;

  /** Model revision/branch */
  revision?: string;

  /** ISO timestamp when cached */
  cachedAt: string;
}

/**
 * Cache index structure stored in index.json
 */
export interface CacheIndex {
  /** Index format version for future compatibility */
  version: string;

  /** ISO timestamp when index was created */
  created: string;

  /** ISO timestamp when index was last updated */
  lastUpdated: string;

  /** Map of cache keys to cache entries */
  entries: Record<string, CacheEntry>;

  /** Aggregate cache statistics */
  stats: CacheStats;
}

/**
 * Cache statistics for monitoring and metrics
 */
export interface CacheStats {
  /** Total number of cached entries */
  totalEntries: number;

  /** Total size of all cached artifacts in bytes */
  totalSizeBytes: number;

  /** Total number of cache hits (successful lookups) */
  cacheHits: number;

  /** Total number of cache misses (failed lookups) */
  cacheMisses: number;

  /** Cache hit rate (cacheHits / (cacheHits + cacheMisses)) */
  hitRate: number;

  /** Total number of entries evicted */
  evictionsTotal: number;

  /** Last eviction timestamp */
  lastEviction?: string;
}

/**
 * Options for cache eviction policy
 */
export interface EvictionPolicy {
  /** Eviction strategy */
  strategy: 'lru' | 'lfu' | 'fifo';

  /** Maximum cache size in bytes before eviction */
  maxSizeBytes: number;

  /** Maximum age of entries in days before eviction */
  maxAgeDays: number;

  /** Minimum access count to protect from eviction */
  minAccessCount?: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Enable persistent artifact cache */
  enabled: boolean;

  /** Directory to store cache artifacts */
  cacheDir: string;

  /** Maximum cache size in bytes (default: 100GB) */
  maxSizeBytes: number;

  /** Maximum age of cache entries in days */
  maxAgeDays: number;

  /** Eviction policy */
  evictionPolicy: 'lru' | 'lfu' | 'fifo';

  /** Models to preload on startup */
  preloadModels: string[];

  /** Enable cache compression (future feature) */
  enableCompression?: boolean;

  /** Enable cache validation on startup */
  validateOnStartup?: boolean;
}

/**
 * Result of a cache lookup operation
 */
export interface CacheLookupResult {
  /** Whether the entry was found in cache */
  hit: boolean;

  /** Cache entry if hit=true */
  entry?: CacheEntry;

  /** Path to cached artifacts if hit=true */
  artifactPath?: string;

  /** Lookup time in milliseconds */
  lookupTimeMs: number;
}

/**
 * Result of a cache store operation
 */
export interface CacheStoreResult {
  /** Whether the store operation succeeded */
  success: boolean;

  /** Content-addressed hash of stored artifacts */
  hash: string;

  /** Path to stored artifacts */
  artifactPath: string;

  /** Size of stored artifacts in bytes */
  sizeBytes: number;

  /** Store time in milliseconds */
  storeTimeMs: number;
}

/**
 * Cache health status for monitoring
 */
export interface CacheHealth {
  /** Whether cache is healthy */
  healthy: boolean;

  /** Total size in bytes */
  sizeBytes: number;

  /** Number of entries */
  entryCount: number;

  /** Hit rate percentage */
  hitRate: number;

  /** Whether cache is approaching size limit */
  nearLimit: boolean;

  /** List of corrupted entries if any */
  corruptedEntries: string[];

  /** Last validation timestamp */
  lastValidated?: string;
}

/**
 * Phase 2: In-Memory Model Cache Statistics (v0.2.0)
 *
 * Statistics for the LRU model cache that keeps loaded models in memory
 * for instant reuse. This is separate from the artifact cache (disk cache).
 */
export interface ModelCacheStats {
  /** Number of currently loaded models */
  loadedModels: number;

  /** Maximum number of models that can be cached */
  maxModels: number;

  /** Whether in-memory caching is enabled */
  cacheEnabled: boolean;

  /** List of loaded models with access times */
  models: Array<{
    /** Model identifier */
    modelId: string;
    /** Last access timestamp (milliseconds since epoch) */
    lastAccess: number;
  }>;
}
