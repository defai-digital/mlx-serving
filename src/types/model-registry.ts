/**
 * Model Registry Types
 *
 * Type definitions for multi-model serving with LRU caching.
 * Week 3: Advanced Scaling - Multi-Model Serving
 */

import type { ModelDescriptor } from './models.js';
import type { ModelIdentifier, LoadModelOptions } from './engine.js';

/**
 * Memory footprint information for a loaded model
 */
export interface ModelMemoryFootprint {
  /** Total GPU memory used in bytes */
  gpuMemoryBytes: number;
  /** CPU memory used in bytes */
  cpuMemoryBytes: number;
  /** Model parameter count */
  parameterCount: number;
  /** Quantization type */
  quantization?: string;
  /** Data type (e.g., float16, int4) */
  dtype?: string;
}

/**
 * Model access pattern tracking
 */
export interface ModelAccessPattern {
  /** Model identifier */
  modelId: ModelIdentifier;
  /** Number of times this model was accessed */
  accessCount: number;
  /** Timestamp of last access (ms since epoch) */
  lastAccessTime: number;
  /** Timestamp when model was loaded (ms since epoch) */
  loadTime: number;
  /** Average time between accesses (ms) */
  avgAccessInterval?: number;
  /** Is this a frequently accessed model? */
  isFrequent: boolean;
}

/**
 * Information about a cached model
 */
export interface ModelInfo {
  /** Model identifier */
  modelId: ModelIdentifier;
  /** Model descriptor */
  descriptor: ModelDescriptor;
  /** Load options used for this model */
  loadOptions: LoadModelOptions;
  /** Model state */
  state: 'loading' | 'ready' | 'failed' | 'evicting';
  /** Memory footprint */
  memory: ModelMemoryFootprint;
  /** Access pattern */
  accessPattern: ModelAccessPattern;
  /** Timestamp when cached (ms since epoch) */
  cachedAt: number;
  /** Is this model pinned (cannot be evicted)? */
  pinned: boolean;
  /** Model metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Model cache configuration
 */
export interface ModelCacheConfig {
  /** Maximum number of models to cache */
  maxCachedModels: number;
  /** Eviction strategy (lru, lfu, access-time) */
  evictionStrategy: 'lru' | 'lfu' | 'access-time';
  /** Enable memory-aware eviction (evict based on GPU memory pressure) */
  memoryAwareEviction: boolean;
  /** GPU memory threshold for eviction (0.0-1.0, e.g., 0.9 = 90% full) */
  gpuMemoryThreshold: number;
  /** Track access patterns for optimization */
  trackAccessPatterns: boolean;
  /** Models to warmup on startup */
  warmupModels: string[];
  /** Models to pin (never evict) */
  pinnedModels: string[];
  /** Enable preloading of frequently used models */
  enablePreloading: boolean;
  /** Frequency threshold for preloading (accesses per hour) */
  preloadFrequencyThreshold: number;
}

/**
 * Model registry statistics
 */
export interface ModelRegistryStats {
  /** Number of models currently cached */
  cachedModels: number;
  /** Maximum cache capacity */
  maxCachedModels: number;
  /** Total GPU memory used (bytes) */
  totalGpuMemory: number;
  /** Total CPU memory used (bytes) */
  totalCpuMemory: number;
  /** Cache hit rate (0.0-1.0) */
  cacheHitRate: number;
  /** Cache miss rate (0.0-1.0) */
  cacheMissRate: number;
  /** Total cache hits */
  cacheHits: number;
  /** Total cache misses */
  cacheMisses: number;
  /** Number of evictions */
  evictions: number;
  /** Average model load time (ms) */
  avgLoadTime: number;
  /** Average model switch time (ms) */
  avgSwitchTime: number;
  /** Most frequently accessed models */
  topModels: Array<{ modelId: string; accessCount: number }>;
}

/**
 * Model switch request
 */
export interface ModelSwitchRequest {
  /** Model to switch from (optional, if currently no model loaded) */
  fromModelId?: ModelIdentifier;
  /** Model to switch to */
  toModelId: ModelIdentifier;
  /** Load options for target model */
  loadOptions?: LoadModelOptions;
  /** Preload target model before switching */
  preload?: boolean;
  /** Priority (higher = faster switching) */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

/**
 * Model switch result
 */
export interface ModelSwitchResult {
  /** Was the switch successful? */
  success: boolean;
  /** Model ID after switch */
  modelId: ModelIdentifier;
  /** Switch time in milliseconds */
  switchTimeMs: number;
  /** Was target model already cached? */
  cacheHit: boolean;
  /** Did eviction occur? */
  evictionOccurred: boolean;
  /** Evicted model ID (if eviction occurred) */
  evictedModelId?: ModelIdentifier;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Model preload request
 */
export interface ModelPreloadRequest {
  /** Model to preload */
  modelId: ModelIdentifier;
  /** Load options */
  loadOptions?: LoadModelOptions;
  /** Priority */
  priority?: 'low' | 'normal' | 'high';
}

/**
 * Model eviction event
 */
export interface ModelEvictionEvent {
  /** Evicted model ID */
  modelId: ModelIdentifier;
  /** Eviction reason */
  reason: 'lru' | 'lfu' | 'memory-pressure' | 'manual' | 'error';
  /** Timestamp */
  timestamp: number;
  /** Memory freed (bytes) */
  memoryFreed: number;
  /** Access count at eviction time */
  accessCount: number;
}

/**
 * GPU memory statistics
 */
export interface GpuMemoryStats {
  /** Total GPU memory (bytes) */
  totalMemory: number;
  /** Used GPU memory (bytes) */
  usedMemory: number;
  /** Free GPU memory (bytes) */
  freeMemory: number;
  /** Memory utilization (0.0-1.0) */
  utilization: number;
  /** Is memory under pressure? */
  underPressure: boolean;
}
