/**
 * Canary Router - Hash-based percentage routing for canary deployments
 *
 * Features:
 * - MD5-based deterministic routing (same user → same variant)
 * - Configurable rollout percentage (0-100%)
 * - LRU cache for performance
 * - Zero-downtime configuration updates
 * - Metrics emission for monitoring
 *
 * @module canary/canary-router
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

/**
 * Configuration for canary router
 */
export interface CanaryRouterConfig {
  /** Enable/disable canary routing */
  enabled: boolean;

  /** Rollout percentage (0-100) */
  rolloutPercentage: number;

  /** Routing strategy: hash for stickiness, random for distribution */
  strategy: 'hash' | 'random';

  /** Hash key to use for routing decision */
  hashKey: 'user_id' | 'request_id' | 'session_id';

  /** Enable LRU cache for hash results (default: true) */
  enableCache?: boolean;

  /** Cache size (default: 10000 entries) */
  cacheSize?: number;
}

/**
 * Routing decision result
 */
export interface RoutingDecision {
  /** Variant to route to: baseline (99%) or canary (1%) */
  variant: 'baseline' | 'canary';

  /** Configured rollout percentage */
  percentage: number;

  /** MD5 hash value used for decision */
  hashValue: string;

  /** Timestamp of decision (ms) */
  timestamp: number;

  /** Whether decision was from cache */
  cached?: boolean;
}

/**
 * Routing statistics
 */
export interface RoutingStats {
  /** Total routing decisions made */
  totalRequests: number;

  /** Baseline variant count */
  baselineCount: number;

  /** Canary variant count */
  canaryCount: number;

  /** Actual canary percentage achieved */
  actualPercentage: number;

  /** Cache hit rate */
  cacheHitRate: number;

  /** Cache size (current) */
  cacheSize: number;
}

/**
 * LRU Cache entry
 */
interface CacheEntry {
  variant: 'baseline' | 'canary';
  timestamp: number;
}

/**
 * Canary Router - Deterministic hash-based routing
 */
export class CanaryRouter {
  private config: Required<CanaryRouterConfig>;
  private stats: {
    totalRequests: number;
    baselineCount: number;
    canaryCount: number;
    cacheHits: number;
    cacheMisses: number;
  };

  // LRU cache: Map preserves insertion order
  private cache: Map<string, CacheEntry>;
  private readonly logger?: Logger;

  /**
   * Create a new CanaryRouter
   *
   * @param config - Router configuration
   */
  constructor(config: CanaryRouterConfig, logger?: Logger) {
    // Validate config
    this.validateConfig(config);

    this.config = {
      ...config,
      enableCache: config.enableCache !== false, // default: true
      cacheSize: config.cacheSize || 10000,
    };
    this.logger = logger;

    this.stats = {
      totalRequests: 0,
      baselineCount: 0,
      canaryCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    this.cache = new Map<string, CacheEntry>();
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: CanaryRouterConfig): void {
    if (config.rolloutPercentage < 0 || config.rolloutPercentage > 100) {
      throw new Error(
        `Invalid rolloutPercentage: ${config.rolloutPercentage}. Must be 0-100.`
      );
    }

    if (!['hash', 'random'].includes(config.strategy)) {
      throw new Error(
        `Invalid strategy: ${config.strategy}. Must be 'hash' or 'random'.`
      );
    }

    if (
      !['user_id', 'request_id', 'session_id'].includes(config.hashKey)
    ) {
      throw new Error(
        `Invalid hashKey: ${config.hashKey}. Must be 'user_id', 'request_id', or 'session_id'.`
      );
    }
  }

  /**
   * Compute MD5 hash of identifier
   *
   * @param identifier - User/request/session ID
   * @returns Hash value (hex string)
   */
  private computeHash(identifier: string): string {
    return createHash('md5').update(identifier).digest('hex');
  }

  /**
   * Get routing decision from cache
   *
   * @param identifier - User/request/session ID
   * @returns Cached decision or undefined
   */
  private getCached(identifier: string): CacheEntry | undefined {
    if (!this.config.enableCache) {
      return undefined;
    }

    const cached = this.cache.get(identifier);

    if (cached) {
      // Move to end (most recently used)
      this.cache.delete(identifier);
      this.cache.set(identifier, cached);
      this.stats.cacheHits++;
      return cached;
    }

    this.stats.cacheMisses++;
    return undefined;
  }

  /**
   * Store routing decision in cache
   *
   * @param identifier - User/request/session ID
   * @param variant - Routing variant
   */
  private setCached(
    identifier: string,
    variant: 'baseline' | 'canary'
  ): void {
    if (!this.config.enableCache) {
      return;
    }

    // Evict oldest entry if cache is full
    if (this.cache.size >= this.config.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(identifier, {
      variant,
      timestamp: Date.now(),
    });
  }

  /**
   * Route a request to baseline or canary
   *
   * @param identifier - User/request/session ID (e.g., user123, req-abc-def)
   * @returns Routing decision
   *
   * @example
   * ```typescript
   * const router = new CanaryRouter({ rolloutPercentage: 1, ... });
   * const decision = router.route('user123');
   *
   * if (decision.variant === 'canary') {
   *   // Use Phase 5 features
   * } else {
   *   // Use baseline
   * }
   * ```
   */
  route(identifier: string): RoutingDecision {
    if (!this.config.enabled) {
      // Canary disabled → always baseline
      this.stats.totalRequests++;
      this.stats.baselineCount++;

      return {
        variant: 'baseline',
        percentage: 0,
        hashValue: '',
        timestamp: Date.now(),
      };
    }

    // Check cache
    const cached = this.getCached(identifier);
    if (cached) {
      this.stats.totalRequests++;
      if (cached.variant === 'canary') {
        this.stats.canaryCount++;
      } else {
        this.stats.baselineCount++;
      }

      return {
        variant: cached.variant,
        percentage: this.config.rolloutPercentage,
        hashValue: this.computeHash(identifier),
        timestamp: Date.now(),
        cached: true,
      };
    }

    // Compute hash
    const hashValue = this.computeHash(identifier);

    // Determine variant based on strategy
    let variant: 'baseline' | 'canary';

    if (this.config.strategy === 'random') {
      // Random routing (not recommended for production)
      variant =
        Math.random() * 100 < this.config.rolloutPercentage
          ? 'canary'
          : 'baseline';
    } else {
      // Hash-based routing (deterministic)
      // Convert first 8 hex chars to number (0-4294967295)
      const hashNum = parseInt(hashValue.substring(0, 8), 16);

      // Map to 0-100 range
      const percentage = (hashNum % 10000) / 100; // 0.00 - 99.99

      variant =
        percentage < this.config.rolloutPercentage ? 'canary' : 'baseline';
    }

    // Update stats
    this.stats.totalRequests++;
    if (variant === 'canary') {
      this.stats.canaryCount++;
    } else {
      this.stats.baselineCount++;
    }

    // Cache decision
    this.setCached(identifier, variant);

    return {
      variant,
      percentage: this.config.rolloutPercentage,
      hashValue,
      timestamp: Date.now(),
      cached: false,
    };
  }

  /**
   * Update rollout percentage (zero-downtime)
   *
   * Invalidates cache to ensure new percentage is applied immediately.
   *
   * @param newPercentage - New rollout percentage (0-100)
   *
   * @example
   * ```typescript
   * router.updatePercentage(10); // Increase to 10%
   * ```
   */
  updatePercentage(newPercentage: number): void {
    if (newPercentage < 0 || newPercentage > 100) {
      throw new Error(
        `Invalid percentage: ${newPercentage}. Must be 0-100.`
      );
    }

    const oldPercentage = this.config.rolloutPercentage;
    this.config.rolloutPercentage = newPercentage;

    // Invalidate cache since percentage changed
    // This ensures all users are re-evaluated with new percentage
    this.cache.clear();

    this.logger?.info(
      {
        oldPercentage,
        newPercentage,
      },
      'Canary rollout percentage updated'
    );
  }

  /**
   * Get current routing statistics
   *
   * @returns Routing stats
   */
  getStats(): RoutingStats {
    const totalCacheRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const cacheHitRate =
      totalCacheRequests > 0
        ? this.stats.cacheHits / totalCacheRequests
        : 0;

    const actualPercentage =
      this.stats.totalRequests > 0
        ? (this.stats.canaryCount / this.stats.totalRequests) * 100
        : 0;

    return {
      totalRequests: this.stats.totalRequests,
      baselineCount: this.stats.baselineCount,
      canaryCount: this.stats.canaryCount,
      actualPercentage,
      cacheHitRate,
      cacheSize: this.cache.size,
    };
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      baselineCount: 0,
      canaryCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  /**
   * Clear cache (useful for forcing re-evaluation)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<Required<CanaryRouterConfig>> {
    return { ...this.config };
  }
}
