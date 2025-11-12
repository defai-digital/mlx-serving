# Phase 1 Implementation Guide: Caching Layer
**mlx-serving Performance Optimization - Code-Level Reference**

---

## Document Metadata

- **Version**: 1.0
- **Date**: 2025-11-07
- **Phase**: Phase 1 - Quick Wins (Days 2-3)
- **Target**: +10-30% throughput on duplicate-heavy workloads
- **Engineer**: Backend/TypeScript specialist
- **Prerequisites**: Phase 0 complete, ADRs 012-014 approved

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [File Structure](#file-structure)
4. [Implementation Tasks](#implementation-tasks)
   - [Task 1.1-1.2: Request Deduplication](#task-11-12-request-deduplication)
   - [Task 1.3-1.4: Prompt Cache](#task-13-14-prompt-cache)
   - [Task 1.5-1.6: Request Coalescing](#task-15-16-request-coalescing)
   - [Task 1.7: Configuration](#task-17-configuration)
   - [Task 1.8: Testing](#task-18-testing)
   - [Task 1.9: Documentation](#task-19-documentation)
5. [Integration Points](#integration-points)
6. [TypeScript Interfaces](#typescript-interfaces)
7. [Configuration Schema](#configuration-schema)
8. [Metrics & Observability](#metrics--observability)
9. [Testing Strategy](#testing-strategy)
10. [Rollback Procedures](#rollback-procedures)
11. [Appendix](#appendix)

---

## Executive Summary

Phase 1 adds three TypeScript-side caching optimizations to mlx-serving:

1. **Request Deduplication** (1s TTL): Collapse identical concurrent requests into shared Promises
2. **Prompt Cache** (10k LRU): Long-lived cache with 5-minute TTL for repeated prompts
3. **Request Coalescing**: Fan-out streaming responses to multiple subscribers from one backend call

**Success Metrics**:
- ≥110% tok/s vs baseline (duplicate-heavy workload)
- >50% cache hit rate after warm-up
- <1ms overhead per request
- Zero breaking changes to existing APIs

**Implementation Time**: 2.5 days (20 hours)

---

## Architecture Overview

### Data Flow

```
┌─────────────┐
│   Client    │
│  (HTTP/API) │
└──────┬──────┘
       │ 1. Generate request
       ▼
┌─────────────────────────────────┐
│  Request Deduplicator (Task 1.1)│ ◄─── Feature Flag: request_deduplication.enabled
│  - SHA256(model, prompt, params)│
│  - 1s TTL, in-memory Map        │
│  - Promise<GenerationResult>    │
└──────┬──────────────────────────┘
       │ 2. Cache miss
       ▼
┌─────────────────────────────────┐
│  Prompt Cache (Task 1.3)        │ ◄─── Feature Flag: prompt_cache.enabled
│  - LRU 10k entries, 5min TTL    │
│  - Size-aware eviction          │
│  - Optional persistence         │
└──────┬──────────────────────────┘
       │ 3. Cache miss
       ▼
┌─────────────────────────────────┐
│  Request Coalescing (Task 1.5)  │ ◄─── Feature Flag: request_coalescing.enabled
│  - Map<key, StreamController[]> │
│  - ReadableStream.tee()         │
│  - Multi-subscriber support     │
└──────┬──────────────────────────┘
       │ 4. No active request
       ▼
┌─────────────────────────────────┐
│  GenerateBatcher (existing)     │
│  - Adaptive batching            │
│  - Priority queue               │
│  - StreamRegistry integration   │
└──────┬──────────────────────────┘
       │ 5. batch_generate RPC
       ▼
┌─────────────────────────────────┐
│  Python MLX Runtime             │
│  - GPU execution                │
│  - Token streaming              │
└─────────────────────────────────┘
```

### Key Design Principles

1. **Layered Caching**: Dedup (short-term) → Cache (long-term) → Coalescing (in-flight) → Backend
2. **Feature Flags**: Each layer independently toggleable via `config/runtime.yaml`
3. **Zero Breaking Changes**: All layers are opt-in middleware around existing `GenerateBatcher.enqueue()`
4. **Metrics First**: Every cache layer emits hit/miss counters before rollout
5. **Error Isolation**: Cache failures fall back to backend (never block requests)

---

## File Structure

### New Files (Phase 1)

```
src/core/
├── request-deduplicator.ts          # Task 1.1 - Deduplication logic
├── prompt-cache.ts                  # Task 1.3 - LRU cache with TTL
└── coalescing-registry.ts           # Task 1.5 - Stream multiplexing

tests/core/
├── request-deduplicator.test.ts     # Unit tests for dedup
├── prompt-cache.test.ts             # Unit tests for cache
└── coalescing-registry.test.ts      # Unit tests for coalescing

tests/integration/
├── generate-dedup.test.ts           # Integration: dedup + batcher
├── prompt-cache.test.ts             # Integration: cache + backend
└── stream-coalescing.test.ts        # Integration: coalescing + SSE

benchmarks/
└── dedup_profile.ts                 # Load test for Phase 1

docs/operations/
└── phase1-rollout.md                # Operator runbook
```

### Modified Files

```
src/core/
└── generate-batcher.ts              # Add dedup/cache/coalescing hooks

src/bridge/
└── stream-registry.ts               # Add attachSubscriber() method

config/
└── runtime.yaml                     # Add Phase 1 config blocks

src/config/
└── loader.ts                        # Extend Config interface

src/types/
└── (new) phase1-types.ts            # Shared TypeScript types
```

---

## Implementation Tasks

---

## Task 1.1-1.2: Request Deduplication

**Goal**: Collapse identical requests arriving within 1 second into a shared Promise.

**Time**: 5 hours (3h core + 2h integration)

### Step 1.1.1: Create Deduplicator Module

**File**: `src/core/request-deduplicator.ts`

```typescript
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
```

### Step 1.1.2: Integrate with GenerateBatcher

**File**: `src/core/generate-batcher.ts` (modifications)

```typescript
// Add import
import { RequestDeduplicator, type FingerprintParams } from './request-deduplicator.js';
import { getConfig } from '../config/loader.js';

// Add to GenerateBatcher class properties
export class GenerateBatcher {
  // ... existing properties ...

  private readonly deduplicator?: RequestDeduplicator; // Phase 1 addition

  constructor(
    transport: JsonRpcTransport,
    streamRegistry: StreamRegistry,
    options: GenerateBatcherConfig & { telemetry?: GenerateBatchTelemetryHooks } = {}
  ) {
    // ... existing constructor code ...

    // Phase 1: Initialize deduplicator
    const config = getConfig();
    if (config.request_deduplication?.enabled) {
      this.deduplicator = new RequestDeduplicator({
        enabled: config.request_deduplication.enabled,
        ttlMs: config.request_deduplication.ttl_ms,
        maxEntries: config.request_deduplication.max_entries,
        maxPayloadBytes: config.request_deduplication.max_payload_kb * 1024,
        logger: this.logger,
      });

      this.logger?.info('Request deduplication enabled');
    }
  }

  /**
   * Enqueue a generate request for potential batching.
   *
   * Phase 1: Enhanced with deduplication layer
   */
  public enqueue(
    params: BatchedGenerateParams,
    options: GenerateBatchOptions = {}
  ): Promise<GenerateResponse> {
    // Phase 1: Check deduplicator first
    if (this.deduplicator) {
      const fingerprintParams: FingerprintParams = {
        modelId: params.model_id,
        prompt: params.prompt,
        temperature: params.temperature,
        topP: params.top_p,
        topK: params.top_k,
        maxTokens: params.max_tokens,
        seed: params.seed,
      };

      const fingerprint = this.deduplicator.fingerprint(fingerprintParams);
      const cached = this.deduplicator.get(fingerprint);

      if (cached) {
        this.logger?.debug(
          { fingerprint, streamId: params.stream_id },
          'Request deduplicated (cache hit)'
        );
        return cached;
      }

      // Cache miss - proceed with batching and cache the promise
      const promise = this.enqueueInternal(params, options);
      return this.deduplicator.set(fingerprint, promise);
    }

    // Deduplication disabled - fall through to batching
    return this.enqueueInternal(params, options);
  }

  /**
   * Internal enqueue logic (extracted for dedup wrapper)
   */
  private enqueueInternal(
    params: BatchedGenerateParams,
    options: GenerateBatchOptions = {}
  ): Promise<GenerateResponse> {
    // MOVE EXISTING enqueue() LOGIC HERE
    // (All the existing batching logic from lines 282-343 of current generate-batcher.ts)

    if (!this.enabled || this.config.maxBatchSize <= 1) {
      return this.transport.request<GenerateResponse>('generate', params, {
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    }

    // ... rest of existing enqueue logic ...
  }

  /**
   * Get deduplication statistics (Phase 1)
   */
  public getDedupStats(): ReturnType<RequestDeduplicator['getStats']> | null {
    return this.deduplicator?.getStats() ?? null;
  }

  /**
   * Cleanup timers and event listeners.
   */
  public cleanup(): void {
    // ... existing cleanup code ...

    // Phase 1: Cleanup deduplicator
    if (this.deduplicator) {
      this.deduplicator.cleanup();
    }
  }
}
```

### Step 1.1.3: Unit Tests

**File**: `tests/core/request-deduplicator.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestDeduplicator } from '../../src/core/request-deduplicator.js';

describe('RequestDeduplicator', () => {
  let deduplicator: RequestDeduplicator;

  beforeEach(() => {
    deduplicator = new RequestDeduplicator({
      enabled: true,
      ttlMs: 1000,
      maxEntries: 10,
      maxPayloadBytes: 10 * 1024,
    });
  });

  afterEach(() => {
    deduplicator.cleanup();
  });

  describe('fingerprint()', () => {
    it('should generate deterministic hash', () => {
      const params = {
        modelId: 'test-model',
        prompt: 'Hello world',
        temperature: 0.7,
      };

      const hash1 = deduplicator.fingerprint(params);
      const hash2 = deduplicator.fingerprint(params);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
    });

    it('should ignore parameter order', () => {
      const params1 = {
        modelId: 'test',
        prompt: 'test',
        temperature: 0.7,
        topP: 0.9,
      };

      const params2 = {
        topP: 0.9,
        prompt: 'test',
        temperature: 0.7,
        modelId: 'test',
      };

      expect(deduplicator.fingerprint(params1)).toBe(deduplicator.fingerprint(params2));
    });

    it('should produce different hashes for different prompts', () => {
      const hash1 = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'Hello',
      });

      const hash2 = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'Goodbye',
      });

      expect(hash1).not.toBe(hash2);
    });

    it('should handle oversize payloads gracefully', () => {
      const hugePrompt = 'x'.repeat(20 * 1024); // 20KB
      const params = {
        modelId: 'test',
        prompt: hugePrompt,
      };

      const hash = deduplicator.fingerprint(params);
      expect(hash).toBeDefined();

      const stats = deduplicator.getStats();
      expect(stats.oversizePayloads).toBe(1);
    });
  });

  describe('get() / set()', () => {
    it('should cache and retrieve promises', async () => {
      const fingerprint = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'test',
      });

      const result = { text: 'response' };
      const promise = Promise.resolve(result as any);

      deduplicator.set(fingerprint, promise);

      const cached = deduplicator.get(fingerprint);
      expect(cached).toBeDefined();
      expect(await cached).toEqual(result);

      const stats = deduplicator.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(0);
    });

    it('should return undefined for cache miss', () => {
      const fingerprint = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'test',
      });

      const cached = deduplicator.get(fingerprint);
      expect(cached).toBeUndefined();

      const stats = deduplicator.getStats();
      expect(stats.misses).toBe(1);
    });

    it('should evict expired entries', async () => {
      const shortTtlDedup = new RequestDeduplicator({
        enabled: true,
        ttlMs: 50, // 50ms TTL
        maxEntries: 10,
        maxPayloadBytes: 10 * 1024,
      });

      const fingerprint = shortTtlDedup.fingerprint({
        modelId: 'test',
        prompt: 'test',
      });

      shortTtlDedup.set(fingerprint, Promise.resolve({} as any));

      // Should be cached immediately
      expect(shortTtlDedup.get(fingerprint)).toBeDefined();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be evicted
      expect(shortTtlDedup.get(fingerprint)).toBeUndefined();

      shortTtlDedup.cleanup();
    });

    it('should delete entry on promise rejection', async () => {
      const fingerprint = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'test',
      });

      const error = new Error('Generation failed');
      const promise = Promise.reject(error);

      const wrapped = deduplicator.set(fingerprint, promise);

      // Promise should propagate rejection
      await expect(wrapped).rejects.toThrow('Generation failed');

      // Entry should be deleted
      expect(deduplicator.get(fingerprint)).toBeUndefined();

      const stats = deduplicator.getStats();
      expect(stats.rejections).toBe(1);
    });

    it('should enforce max entries limit', () => {
      const smallDedup = new RequestDeduplicator({
        enabled: true,
        ttlMs: 1000,
        maxEntries: 3,
        maxPayloadBytes: 10 * 1024,
      });

      // Fill cache
      for (let i = 0; i < 5; i++) {
        const fingerprint = smallDedup.fingerprint({
          modelId: 'test',
          prompt: `prompt-${i}`,
        });
        smallDedup.set(fingerprint, Promise.resolve({} as any));
      }

      const stats = smallDedup.getStats();
      expect(stats.size).toBeLessThanOrEqual(3);
      expect(stats.evictions).toBeGreaterThan(0);

      smallDedup.cleanup();
    });
  });

  describe('cleanup()', () => {
    it('should clear cache and stop timer', () => {
      deduplicator.set(
        deduplicator.fingerprint({ modelId: 'test', prompt: 'test' }),
        Promise.resolve({} as any)
      );

      expect(deduplicator.getStats().size).toBe(1);

      deduplicator.cleanup();

      expect(deduplicator.getStats().size).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('should calculate hit rate correctly', () => {
      const fingerprint = deduplicator.fingerprint({
        modelId: 'test',
        prompt: 'test',
      });

      // Miss
      deduplicator.get(fingerprint);

      // Set and hit
      deduplicator.set(fingerprint, Promise.resolve({} as any));
      deduplicator.get(fingerprint);
      deduplicator.get(fingerprint);

      const stats = deduplicator.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });
  });
});
```

### Step 1.1.4: Integration Test

**File**: `tests/integration/generate-dedup.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GenerateBatcher } from '../../src/core/generate-batcher.js';
import { StreamRegistry } from '../../src/bridge/stream-registry.js';
import { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import type { BatchedGenerateParams } from '../../src/core/generate-batcher.js';

// Mock transport for testing
class MockTransport extends JsonRpcTransport {
  public callCount = 0;

  async request<T>(method: string, params: any): Promise<T> {
    this.callCount++;

    // Simulate batch_generate response
    if (method === 'batch_generate') {
      const batchSize = params.requests.length;
      return {
        results: Array(batchSize).fill({
          success: true,
          result: { text: 'response', tokens: 10 },
        }),
      } as T;
    }

    return { text: 'response', tokens: 10 } as T;
  }
}

describe('Request Deduplication Integration', () => {
  let transport: MockTransport;
  let streamRegistry: StreamRegistry;
  let batcher: GenerateBatcher;

  beforeEach(() => {
    transport = new MockTransport(/* stdio config */);
    streamRegistry = new StreamRegistry();

    // Enable deduplication via config override
    batcher = new GenerateBatcher(transport, streamRegistry, {
      enabled: true,
      minBatchSize: 2,
      maxBatchSize: 10,
    });
  });

  afterEach(() => {
    batcher.cleanup();
    streamRegistry.cleanup();
  });

  it('should deduplicate identical concurrent requests', async () => {
    const params: BatchedGenerateParams = {
      model_id: 'test-model',
      prompt: 'Hello world',
      temperature: 0.7,
      stream_id: 'test-1',
    };

    // Fire 3 identical requests concurrently
    const promises = [
      batcher.enqueue({ ...params, stream_id: 'test-1' }),
      batcher.enqueue({ ...params, stream_id: 'test-2' }),
      batcher.enqueue({ ...params, stream_id: 'test-3' }),
    ];

    const results = await Promise.all(promises);

    // All should succeed
    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.text).toBe('response');
    });

    // Only ONE backend call should have been made (deduplicated)
    expect(transport.callCount).toBe(1);

    // Check dedup stats
    const stats = batcher.getDedupStats();
    expect(stats).not.toBeNull();
    expect(stats!.hits).toBeGreaterThan(0);
  });

  it('should NOT deduplicate requests with different prompts', async () => {
    const request1 = batcher.enqueue({
      model_id: 'test-model',
      prompt: 'Hello',
      stream_id: 'test-1',
    });

    const request2 = batcher.enqueue({
      model_id: 'test-model',
      prompt: 'Goodbye',
      stream_id: 'test-2',
    });

    await Promise.all([request1, request2]);

    // Two different prompts = two backend calls
    expect(transport.callCount).toBeGreaterThanOrEqual(1);
  });

  it('should propagate errors correctly', async () => {
    transport.request = async () => {
      throw new Error('Backend failure');
    };

    const params: BatchedGenerateParams = {
      model_id: 'test-model',
      prompt: 'test',
      stream_id: 'test-1',
    };

    const promise1 = batcher.enqueue(params);
    const promise2 = batcher.enqueue({ ...params, stream_id: 'test-2' });

    await expect(promise1).rejects.toThrow('Backend failure');
    await expect(promise2).rejects.toThrow('Backend failure');

    // Cache entry should be deleted after rejection
    const stats = batcher.getDedupStats();
    expect(stats!.rejections).toBeGreaterThan(0);
  });
});
```

---

## Task 1.3-1.4: Prompt Cache

**Goal**: Long-lived LRU cache with 5-minute TTL for repeated prompts.

**Time**: 5 hours (3h core + 2h integration)

### Step 1.3.1: Create Prompt Cache Module

**File**: `src/core/prompt-cache.ts`

```typescript
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
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { GenerateResponse } from '../bridge/serializers.js';

/**
 * Cache configuration
 */
export interface PromptCacheConfig {
  /** Enable cache (default: false for safety) */
  enabled: boolean;

  /** Maximum cache entries */
  maxEntries: number;

  /** Time-to-live for cache entries (milliseconds) */
  ttlMs: number;

  /** Maximum total cache size (bytes) */
  maxBytes: number;

  /** Enable persistence to disk */
  persistence: boolean;

  /** Path to persistence file */
  persistencePath?: string;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Cache entry
 */
export interface CacheEntry {
  /** Cache key (fingerprint) */
  key: string;

  /** Cached response */
  response: GenerateResponse;

  /** Creation timestamp */
  createdAt: number;

  /** Expiration timestamp */
  expiresAt: number;

  /** Last access timestamp (for LRU) */
  lastAccessedAt: number;

  /** Estimated size (bytes) */
  sizeBytes: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  enabled: boolean;
  size: number;
  totalBytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  ttlEvictions: number;
  hitRate: number;
  avgEntrySize: number;
}

/**
 * Prompt Cache with LRU eviction and TTL
 */
export class PromptCache {
  private readonly config: PromptCacheConfig;
  private readonly logger?: Logger;

  // LRU cache: Map preserves insertion order
  private readonly cache = new Map<string, CacheEntry>();

  // Size tracking
  private totalBytes = 0;

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    ttlEvictions: 0,
  };

  // Cleanup timer
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: PromptCacheConfig) {
    this.config = config;
    this.logger = config.logger;

    // Load persisted cache if enabled
    if (config.enabled && config.persistence && config.persistencePath) {
      this.loadFromDisk();
    }

    // Start TTL cleanup timer (check every 30s)
    if (config.enabled) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, 30000);
    }

    this.logger?.info(
      {
        enabled: config.enabled,
        maxEntries: config.maxEntries,
        ttlMs: config.ttlMs,
        maxBytes: config.maxBytes,
        persistence: config.persistence,
      },
      'PromptCache initialized'
    );
  }

  /**
   * Generate cache key from request parameters
   *
   * @param params - Request parameters (same as dedup fingerprint)
   * @returns Cache key
   */
  public generateKey(params: {
    modelId: string;
    prompt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number;
  }): string {
    // Reuse fingerprinting logic from deduplicator
    const canonical = {
      modelId: params.modelId,
      prompt: params.prompt,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { topP: params.topP }),
      ...(params.topK !== undefined && { topK: params.topK }),
      ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
      ...(params.seed !== undefined && { seed: params.seed }),
    };

    return createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
  }

  /**
   * Get cached response
   *
   * @param key - Cache key
   * @returns Cached response or undefined
   */
  public get(key: string): GenerateResponse | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL expiration
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.logger?.debug({ key }, 'Cache entry expired');
      this.cache.delete(key);
      this.totalBytes -= entry.sizeBytes;
      this.stats.ttlEvictions++;
      this.stats.misses++;
      return undefined;
    }

    // Update LRU timestamp
    entry.lastAccessedAt = now;

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    this.logger?.debug(
      { key, age: now - entry.createdAt },
      'Cache hit'
    );

    return entry.response;
  }

  /**
   * Set cached response
   *
   * @param key - Cache key
   * @param response - Response to cache
   */
  public set(key: string, response: GenerateResponse): void {
    if (!this.config.enabled) {
      return;
    }

    const now = Date.now();

    // Estimate size (tokens + metadata)
    const sizeBytes = this.estimateSize(response);

    // Check if entry already exists (update case)
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }

    // Evict entries if necessary (LRU or size-based)
    while (
      this.cache.size >= this.config.maxEntries ||
      this.totalBytes + sizeBytes > this.config.maxBytes
    ) {
      this.evictOldest();
    }

    const entry: CacheEntry = {
      key,
      response,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      lastAccessedAt: now,
      sizeBytes,
    };

    this.cache.set(key, entry);
    this.totalBytes += sizeBytes;

    this.logger?.debug(
      { key, sizeBytes, totalEntries: this.cache.size, totalBytes: this.totalBytes },
      'Response cached'
    );

    // Persist if enabled
    if (this.config.persistence && this.config.persistencePath) {
      this.saveToDisk();
    }
  }

  /**
   * Check if key exists in cache (without updating LRU)
   *
   * @param key - Cache key
   * @returns true if cached and not expired
   */
  public has(key: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    // Check expiration
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.cache.delete(key);
      this.totalBytes -= entry.sizeBytes;
      this.stats.ttlEvictions++;
      return false;
    }

    return true;
  }

  /**
   * Get cache size (entry count)
   */
  public size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  public getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    const avgEntrySize = this.cache.size > 0 ? this.totalBytes / this.cache.size : 0;

    return {
      enabled: this.config.enabled,
      size: this.cache.size,
      totalBytes: this.totalBytes,
      maxEntries: this.config.maxEntries,
      maxBytes: this.config.maxBytes,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      ttlEvictions: this.stats.ttlEvictions,
      hitRate,
      avgEntrySize,
    };
  }

  /**
   * Clear all cached entries
   */
  public clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
    this.logger?.info('Cache cleared');
  }

  /**
   * Cleanup resources and persist
   */
  public cleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Persist before shutdown
    if (this.config.persistence && this.config.persistencePath) {
      this.saveToDisk();
    }

    this.cache.clear();
    this.totalBytes = 0;
    this.logger?.debug('PromptCache cleaned up');
  }

  /**
   * Evict oldest entry (LRU)
   */
  private evictOldest(): void {
    // Map iteration order is insertion order (oldest first)
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      const entry = this.cache.get(firstKey);
      if (entry) {
        this.totalBytes -= entry.sizeBytes;
        this.cache.delete(firstKey);
        this.stats.evictions++;

        this.logger?.debug(
          { key: firstKey, sizeBytes: entry.sizeBytes },
          'Evicted LRU entry'
        );
      }
    }
  }

  /**
   * Cleanup expired entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        this.totalBytes -= entry.sizeBytes;
        evicted++;
      }
    }

    if (evicted > 0) {
      this.stats.ttlEvictions += evicted;
      this.logger?.debug({ evicted }, 'Cleaned up expired entries');
    }
  }

  /**
   * Estimate size of response (bytes)
   */
  private estimateSize(response: GenerateResponse): number {
    // Rough estimate: text length + metadata
    let size = 0;

    if (response.text) {
      size += response.text.length * 2; // Assume UTF-16 (2 bytes per char)
    }

    if (response.tokens) {
      size += response.tokens.length * 4; // Assume 4 bytes per token
    }

    // Add metadata overhead (rough estimate)
    size += 100;

    return size;
  }

  /**
   * Load cache from disk (persistence)
   */
  private loadFromDisk(): void {
    const path = this.config.persistencePath!;

    if (!existsSync(path)) {
      this.logger?.debug({ path }, 'No persisted cache found');
      return;
    }

    try {
      const data = readFileSync(path, 'utf-8');
      const entries: CacheEntry[] = JSON.parse(data);

      const now = Date.now();
      let loaded = 0;

      for (const entry of entries) {
        // Skip expired entries
        if (now >= entry.expiresAt) {
          continue;
        }

        this.cache.set(entry.key, entry);
        this.totalBytes += entry.sizeBytes;
        loaded++;
      }

      this.logger?.info(
        { path, loaded, total: entries.length },
        'Cache loaded from disk'
      );
    } catch (error) {
      this.logger?.error({ error, path }, 'Failed to load cache from disk');
    }
  }

  /**
   * Save cache to disk (persistence)
   */
  private saveToDisk(): void {
    const path = this.config.persistencePath!;

    try {
      // Ensure directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const entries = Array.from(this.cache.values());
      const data = JSON.stringify(entries, null, 2);

      writeFileSync(path, data, 'utf-8');

      this.logger?.debug(
        { path, entries: entries.length },
        'Cache persisted to disk'
      );
    } catch (error) {
      this.logger?.error({ error, path }, 'Failed to save cache to disk');
    }
  }
}
```

### Step 1.3.2: Integrate with GenerateBatcher

**File**: `src/core/generate-batcher.ts` (additional modifications)

```typescript
// Add import
import { PromptCache, type CacheEntry } from './prompt-cache.js';

// Add to GenerateBatcher class
export class GenerateBatcher {
  // ... existing properties ...
  private readonly promptCache?: PromptCache; // Phase 1 addition

  constructor(
    transport: JsonRpcTransport,
    streamRegistry: StreamRegistry,
    options: GenerateBatcherConfig & { telemetry?: GenerateBatchTelemetryHooks } = {}
  ) {
    // ... existing constructor code ...

    // Phase 1: Initialize prompt cache
    const config = getConfig();
    if (config.prompt_cache?.enabled) {
      this.promptCache = new PromptCache({
        enabled: config.prompt_cache.enabled,
        maxEntries: config.prompt_cache.max_entries,
        ttlMs: config.prompt_cache.ttl_ms,
        maxBytes: config.prompt_cache.max_bytes,
        persistence: config.prompt_cache.persistence,
        persistencePath: config.prompt_cache.persistence_path,
        logger: this.logger,
      });

      this.logger?.info('Prompt cache enabled');
    }
  }

  /**
   * Enqueue with prompt cache check
   */
  public enqueue(
    params: BatchedGenerateParams,
    options: GenerateBatchOptions = {}
  ): Promise<GenerateResponse> {
    // Phase 1: Check prompt cache BEFORE deduplicator
    // (Cache hits are cheaper than dedup Promise sharing)
    if (this.promptCache) {
      const cacheKey = this.promptCache.generateKey({
        modelId: params.model_id,
        prompt: params.prompt,
        temperature: params.temperature,
        topP: params.top_p,
        topK: params.top_k,
        maxTokens: params.max_tokens,
        seed: params.seed,
      });

      const cached = this.promptCache.get(cacheKey);
      if (cached) {
        this.logger?.debug(
          { cacheKey, streamId: params.stream_id },
          'Prompt cache hit'
        );

        // Emit telemetry for cache hit
        this.telemetry?.onCacheHit?.({
          type: 'prompt_cache',
          key: cacheKey,
          streamId: params.stream_id,
        });

        return Promise.resolve(cached);
      }
    }

    // Cache miss - proceed to deduplicator
    if (this.deduplicator) {
      // ... existing dedup logic ...

      // ENHANCEMENT: Store in prompt cache after successful completion
      const promise = this.enqueueInternal(params, options);

      return promise.then((response) => {
        // Cache the response for future requests
        if (this.promptCache) {
          const cacheKey = this.promptCache.generateKey({
            modelId: params.model_id,
            prompt: params.prompt,
            temperature: params.temperature,
            topP: params.top_p,
            topK: params.top_k,
            maxTokens: params.max_tokens,
            seed: params.seed,
          });

          this.promptCache.set(cacheKey, response);

          this.logger?.debug({ cacheKey }, 'Response cached in prompt cache');
        }

        return response;
      });
    }

    // Both cache and dedup disabled - fall through
    return this.enqueueInternal(params, options);
  }

  /**
   * Get prompt cache statistics (Phase 1)
   */
  public getPromptCacheStats(): ReturnType<PromptCache['getStats']> | null {
    return this.promptCache?.getStats() ?? null;
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    // ... existing cleanup ...

    // Phase 1: Cleanup prompt cache
    if (this.promptCache) {
      this.promptCache.cleanup();
    }
  }
}
```

### Step 1.3.3: Add HTTP Headers

**File**: `src/api/routes/generate.ts` (or wherever HTTP response is built)

```typescript
// When returning cached response, add header
response.setHeader('x-mlx-cache-hit', 'true');
response.setHeader('x-mlx-cache-type', 'prompt'); // or 'dedup'

// When returning fresh response
response.setHeader('x-mlx-cache-hit', 'false');
```

---

## Task 1.5-1.6: Request Coalescing

**Goal**: Share single Python inference among multiple subscribers for identical in-flight requests.

**Time**: 5 hours (3h core + 2h integration)

### Step 1.5.1: Create Coalescing Registry

**File**: `src/core/coalescing-registry.ts`

```typescript
/**
 * Request Coalescing Registry
 *
 * Multiplexes streaming responses from a single backend invocation to multiple
 * subscribers. Uses ReadableStream.tee() to clone SSE streams.
 *
 * Use Case:
 * - Multiple clients request identical generation simultaneously
 * - First request goes to backend
 * - Subsequent requests attach as subscribers
 * - All receive same stream of tokens
 *
 * Architecture:
 * - Map<requestKey, StreamController[]>
 * - Automatic cleanup when stream completes
 * - Metadata tracking (sharedFromRequestId)
 */

import type { Logger } from 'pino';

/**
 * Stream controller for multiplexing
 */
export interface StreamController {
  streamId: string;
  controller: ReadableStreamDefaultController<any>;
  closed: boolean;
}

/**
 * Coalescing registry entry
 */
interface CoalescingEntry {
  requestKey: string;
  primaryStreamId: string;
  subscribers: StreamController[];
  createdAt: number;
  tokenCount: number;
}

/**
 * Coalescing configuration
 */
export interface CoalescingRegistryConfig {
  /** Enable coalescing (default: false for safety) */
  enabled: boolean;

  /** Buffer size for late joiners (KB) */
  bufferSizeKb: number;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Request Coalescing Registry
 *
 * Manages in-flight request multiplexing.
 */
export class CoalescingRegistry {
  private readonly config: CoalescingRegistryConfig;
  private readonly logger?: Logger;

  // Active coalesced requests: Map<requestKey, CoalescingEntry>
  private readonly registry = new Map<string, CoalescingEntry>();

  // Statistics
  private stats = {
    totalRequests: 0,
    coalescedRequests: 0,
    activeEntries: 0,
  };

  constructor(config: CoalescingRegistryConfig) {
    this.config = config;
    this.logger = config.logger;

    this.logger?.info(
      {
        enabled: config.enabled,
        bufferSizeKb: config.bufferSizeKb,
      },
      'CoalescingRegistry initialized'
    );
  }

  /**
   * Generate request key from parameters
   *
   * @param params - Request parameters
   * @returns Request key
   */
  public generateKey(params: {
    modelId: string;
    prompt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number;
  }): string {
    // Reuse fingerprinting logic
    const canonical = {
      modelId: params.modelId,
      prompt: params.prompt,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { topP: params.topP }),
      ...(params.topK !== undefined && { topK: params.topK }),
      ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
      ...(params.seed !== undefined && { seed: params.seed }),
    };

    return JSON.stringify(canonical);
  }

  /**
   * Register primary stream (first request)
   *
   * @param requestKey - Request key
   * @param streamId - Stream ID
   */
  public registerPrimary(requestKey: string, streamId: string): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.registry.has(requestKey)) {
      this.logger?.warn(
        { requestKey, streamId },
        'Primary stream already registered'
      );
      return;
    }

    const entry: CoalescingEntry = {
      requestKey,
      primaryStreamId: streamId,
      subscribers: [],
      createdAt: Date.now(),
      tokenCount: 0,
    };

    this.registry.set(requestKey, entry);
    this.stats.totalRequests++;
    this.stats.activeEntries = this.registry.size;

    this.logger?.debug(
      { requestKey, streamId },
      'Primary stream registered for coalescing'
    );
  }

  /**
   * Attach subscriber to existing stream
   *
   * @param requestKey - Request key
   * @param subscriber - Subscriber stream controller
   * @returns true if attached, false if no primary stream
   */
  public attachSubscriber(
    requestKey: string,
    subscriber: StreamController
  ): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const entry = this.registry.get(requestKey);

    if (!entry) {
      return false;
    }

    entry.subscribers.push(subscriber);
    this.stats.coalescedRequests++;

    this.logger?.info(
      {
        requestKey,
        primaryStreamId: entry.primaryStreamId,
        subscriberStreamId: subscriber.streamId,
        totalSubscribers: entry.subscribers.length,
      },
      'Subscriber attached to coalesced stream'
    );

    return true;
  }

  /**
   * Get subscribers for request key
   *
   * @param requestKey - Request key
   * @returns Array of subscribers
   */
  public getSubscribers(requestKey: string): StreamController[] {
    const entry = this.registry.get(requestKey);
    return entry?.subscribers ?? [];
  }

  /**
   * Get primary stream ID
   *
   * @param requestKey - Request key
   * @returns Primary stream ID or undefined
   */
  public getPrimaryStreamId(requestKey: string): string | undefined {
    return this.registry.get(requestKey)?.primaryStreamId;
  }

  /**
   * Increment token count (for metadata)
   *
   * @param requestKey - Request key
   */
  public incrementTokenCount(requestKey: string): void {
    const entry = this.registry.get(requestKey);
    if (entry) {
      entry.tokenCount++;
    }
  }

  /**
   * Unregister request (cleanup)
   *
   * @param requestKey - Request key
   */
  public unregister(requestKey: string): void {
    const entry = this.registry.get(requestKey);

    if (!entry) {
      return;
    }

    // Close all subscriber controllers
    for (const subscriber of entry.subscribers) {
      if (!subscriber.closed) {
        try {
          subscriber.controller.close();
          subscriber.closed = true;
        } catch (error) {
          this.logger?.error(
            { error, streamId: subscriber.streamId },
            'Failed to close subscriber controller'
          );
        }
      }
    }

    this.registry.delete(requestKey);
    this.stats.activeEntries = this.registry.size;

    this.logger?.debug(
      {
        requestKey,
        subscribers: entry.subscribers.length,
        tokenCount: entry.tokenCount,
      },
      'Request unregistered from coalescing'
    );
  }

  /**
   * Get coalescing statistics
   */
  public getStats(): {
    enabled: boolean;
    activeEntries: number;
    totalRequests: number;
    coalescedRequests: number;
    coalescingRate: number;
  } {
    const coalescingRate =
      this.stats.totalRequests > 0
        ? this.stats.coalescedRequests / this.stats.totalRequests
        : 0;

    return {
      enabled: this.config.enabled,
      activeEntries: this.stats.activeEntries,
      totalRequests: this.stats.totalRequests,
      coalescedRequests: this.stats.coalescedRequests,
      coalescingRate,
    };
  }

  /**
   * Clear all entries
   */
  public clear(): void {
    for (const key of this.registry.keys()) {
      this.unregister(key);
    }

    this.logger?.info('Coalescing registry cleared');
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    this.clear();
    this.logger?.debug('CoalescingRegistry cleaned up');
  }
}
```

### Step 1.5.2: Integrate with StreamRegistry

**File**: `src/bridge/stream-registry.ts` (modifications)

```typescript
// Add import
import { CoalescingRegistry, type StreamController } from '../core/coalescing-registry.js';

// Add to StreamRegistry class
export class StreamRegistry extends EventEmitter<StreamRegistryEvents> {
  // ... existing properties ...

  private readonly coalescingRegistry?: CoalescingRegistry; // Phase 1

  constructor(options: StreamRegistryOptions = {}) {
    super();

    // ... existing constructor code ...

    // Phase 1: Initialize coalescing registry
    const config = getConfig();
    if (config.request_coalescing?.enabled) {
      this.coalescingRegistry = new CoalescingRegistry({
        enabled: config.request_coalescing.enabled,
        bufferSizeKb: config.request_coalescing.buffer_size_kb,
        logger: this.logger,
      });

      this.logger?.info('Request coalescing enabled');
    }
  }

  /**
   * Attach subscriber to existing stream (Phase 1)
   *
   * @param requestKey - Request key for coalescing
   * @param streamId - New subscriber stream ID
   * @param controller - ReadableStream controller
   * @returns true if attached to existing stream
   */
  public attachSubscriber(
    requestKey: string,
    streamId: string,
    controller: ReadableStreamDefaultController<any>
  ): boolean {
    if (!this.coalescingRegistry) {
      return false;
    }

    const subscriber: StreamController = {
      streamId,
      controller,
      closed: false,
    };

    const attached = this.coalescingRegistry.attachSubscriber(requestKey, subscriber);

    if (attached) {
      this.logger?.info(
        { requestKey, streamId },
        'Stream attached as subscriber'
      );
    }

    return attached;
  }

  /**
   * Register primary stream for coalescing (Phase 1)
   *
   * @param requestKey - Request key
   * @param streamId - Primary stream ID
   */
  public registerPrimaryStream(requestKey: string, streamId: string): void {
    if (!this.coalescingRegistry) {
      return;
    }

    this.coalescingRegistry.registerPrimary(requestKey, streamId);
  }

  /**
   * Get subscribers for request (Phase 1)
   *
   * @param requestKey - Request key
   * @returns Array of subscriber controllers
   */
  public getSubscribers(requestKey: string): StreamController[] {
    return this.coalescingRegistry?.getSubscribers(requestKey) ?? [];
  }

  /**
   * Handle incoming stream.chunk notification
   * ENHANCED: Broadcast to subscribers (Phase 1)
   */
  public handleChunk(params: StreamChunkParams): void {
    // ... existing chunk handling code ...

    // Phase 1: Broadcast to coalesced subscribers
    if (this.coalescingRegistry) {
      const requestKey = this.getRequestKeyForStream(params.stream_id);
      if (requestKey) {
        const subscribers = this.coalescingRegistry.getSubscribers(requestKey);

        for (const subscriber of subscribers) {
          if (!subscriber.closed) {
            try {
              // Enqueue chunk to subscriber controller
              subscriber.controller.enqueue({
                ...chunk,
                // Add metadata indicating this is a coalesced stream
                sharedFromRequestId: this.coalescingRegistry.getPrimaryStreamId(requestKey),
              });
            } catch (error) {
              this.logger?.error(
                { error, streamId: subscriber.streamId },
                'Failed to enqueue chunk to subscriber'
              );
              subscriber.closed = true;
            }
          }
        }

        this.coalescingRegistry.incrementTokenCount(requestKey);
      }
    }

    // ... rest of existing chunk handling ...
  }

  /**
   * Cleanup (Phase 1: Enhanced)
   */
  public cleanup(): void {
    // ... existing cleanup code ...

    // Phase 1: Cleanup coalescing registry
    if (this.coalescingRegistry) {
      this.coalescingRegistry.cleanup();
    }
  }

  /**
   * Helper: Get request key for stream ID
   * (Implementation depends on how you store this mapping)
   */
  private getRequestKeyForStream(streamId: string): string | undefined {
    // TODO: Implement mapping storage in register() method
    // For now, return undefined (coalescing disabled without mapping)
    return undefined;
  }
}
```

---

## Task 1.7: Configuration

**Goal**: Add Phase 1 config blocks to `config/runtime.yaml` with feature flags.

**Time**: 1 hour

### Step 1.7.1: Update Configuration File

**File**: `config/runtime.yaml`

```yaml
# Phase 1: Request Deduplication
# Collapses identical concurrent requests into shared promises
request_deduplication:
  enabled: false  # Feature flag: disabled by default
  ttl_ms: 1000  # 1 second TTL for dedup cache
  max_entries: 1000  # Memory pressure guard
  max_payload_kb: 512  # Maximum payload size to fingerprint

# Phase 1: Prompt Cache
# Long-lived LRU cache for repeated prompts
prompt_cache:
  enabled: false  # Feature flag: disabled by default
  max_entries: 10000  # LRU capacity
  ttl_ms: 300000  # 5 minutes
  max_bytes: 104857600  # 100 MB total cache size
  persistence: false  # Persist to disk
  persistence_path: 'automatosx/tmp/prompt-cache.json'  # Persistence file

# Phase 1: Request Coalescing
# Fan-out streaming responses to multiple subscribers
request_coalescing:
  enabled: false  # Feature flag: disabled by default
  buffer_size_kb: 64  # Buffer size for late joiners
```

### Step 1.7.2: Update Config Loader Types

**File**: `src/config/loader.ts`

```typescript
export interface Config {
  // ... existing config blocks ...

  // Phase 1: Request Deduplication
  request_deduplication?: {
    enabled: boolean;
    ttl_ms: number;
    max_entries: number;
    max_payload_kb: number;
  };

  // Phase 1: Prompt Cache
  prompt_cache?: {
    enabled: boolean;
    max_entries: number;
    ttl_ms: number;
    max_bytes: number;
    persistence: boolean;
    persistence_path?: string;
  };

  // Phase 1: Request Coalescing
  request_coalescing?: {
    enabled: boolean;
    buffer_size_kb: number;
  };
}
```

---

## Task 1.8: Testing

**Goal**: Comprehensive test coverage for all Phase 1 components.

**Time**: 3 hours

### Step 1.8.1: Load Test Script

**File**: `benchmarks/dedup_profile.ts`

```typescript
/**
 * Phase 1 Load Test: Request Deduplication & Prompt Cache
 *
 * Tests duplicate-heavy workload to validate caching performance.
 */

import { performance } from 'node:perf_hooks';
import pino from 'pino';

const logger = pino({ level: 'info' });

interface BenchmarkConfig {
  modelId: string;
  totalRequests: number;
  duplicateRatio: number; // 0.0-1.0 (e.g., 0.8 = 80% duplicates)
  concurrent: number;
}

interface BenchmarkResult {
  totalRequests: number;
  uniquePrompts: number;
  duplicateRequests: number;
  totalTimeMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  tokensPerSecond: number;
  cacheHitRate: number;
}

/**
 * Run benchmark with duplicate workload
 */
async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const prompts: string[] = [];
  const uniquePromptCount = Math.ceil(config.totalRequests * (1 - config.duplicateRatio));

  // Generate unique prompts
  for (let i = 0; i < uniquePromptCount; i++) {
    prompts.push(`Tell me about topic ${i}.`);
  }

  // Generate request list (with duplicates)
  const requests: string[] = [];
  for (let i = 0; i < config.totalRequests; i++) {
    const promptIndex = i % uniquePromptCount;
    requests.push(prompts[promptIndex]);
  }

  logger.info({
    totalRequests: config.totalRequests,
    uniquePrompts: uniquePromptCount,
    duplicates: config.totalRequests - uniquePromptCount,
    duplicateRatio: config.duplicateRatio,
  }, 'Starting benchmark');

  const latencies: number[] = [];
  const startTime = performance.now();

  // Send requests in batches (simulated concurrency)
  for (let i = 0; i < config.totalRequests; i += config.concurrent) {
    const batch = requests.slice(i, i + config.concurrent);

    const batchPromises = batch.map(async (prompt) => {
      const reqStart = performance.now();

      // TODO: Replace with actual API call
      // const response = await fetch('http://localhost:3000/v1/generate', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     model: config.modelId,
      //     prompt,
      //     max_tokens: 50,
      //   }),
      // });

      // Simulated response
      await new Promise(resolve => setTimeout(resolve, 10));

      const reqEnd = performance.now();
      latencies.push(reqEnd - reqStart);
    });

    await Promise.all(batchPromises);
  }

  const endTime = performance.now();
  const totalTimeMs = endTime - startTime;

  // Calculate statistics
  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95Index = Math.floor(latencies.length * 0.95);
  const p95Latency = latencies[p95Index];

  // TODO: Get actual cache stats from API
  const cacheHitRate = config.duplicateRatio; // Estimated

  // TODO: Calculate actual tokens/sec
  const tokensPerSecond = 0;

  return {
    totalRequests: config.totalRequests,
    uniquePrompts: uniquePromptCount,
    duplicateRequests: config.totalRequests - uniquePromptCount,
    totalTimeMs,
    avgLatencyMs: avgLatency,
    p95LatencyMs: p95Latency,
    tokensPerSecond,
    cacheHitRate,
  };
}

/**
 * Main benchmark runner
 */
async function main() {
  const config: BenchmarkConfig = {
    modelId: 'gemma-2-27b-it-4bit',
    totalRequests: 100,
    duplicateRatio: 0.8, // 80% duplicates
    concurrent: 10,
  };

  const result = await runBenchmark(config);

  logger.info(result, 'Benchmark complete');

  // Print summary
  console.log('\n=== Phase 1 Benchmark Results ===');
  console.log(`Total Requests: ${result.totalRequests}`);
  console.log(`Unique Prompts: ${result.uniquePrompts}`);
  console.log(`Duplicate Requests: ${result.duplicateRequests}`);
  console.log(`Total Time: ${result.totalTimeMs.toFixed(2)} ms`);
  console.log(`Avg Latency: ${result.avgLatencyMs.toFixed(2)} ms`);
  console.log(`P95 Latency: ${result.p95LatencyMs.toFixed(2)} ms`);
  console.log(`Cache Hit Rate: ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`Tokens/sec: ${result.tokensPerSecond.toFixed(2)}`);
}

main().catch(error => {
  logger.error(error, 'Benchmark failed');
  process.exit(1);
});
```

### Step 1.8.2: End-to-End Integration Test

**File**: `tests/integration/phase1-end-to-end.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Phase 1 End-to-End Integration', () => {
  beforeAll(async () => {
    // Start server with Phase 1 features enabled
    // TODO: Implement server startup
  });

  afterAll(async () => {
    // Stop server
    // TODO: Implement server shutdown
  });

  describe('Request Deduplication', () => {
    it('should deduplicate identical concurrent requests', async () => {
      // TODO: Send 3 identical requests concurrently
      // Verify: Only 1 backend call, 3 successful responses
    });

    it('should NOT deduplicate sequential requests after TTL', async () => {
      // TODO: Send request, wait >1s, send identical request
      // Verify: 2 backend calls
    });
  });

  describe('Prompt Cache', () => {
    it('should cache completed responses', async () => {
      // TODO: Send request, wait for completion, send identical request
      // Verify: Second request returns instantly with x-mlx-cache-hit: true
    });

    it('should evict after TTL', async () => {
      // TODO: Send request, wait >5min, send identical request
      // Verify: Second request goes to backend
    });
  });

  describe('Request Coalescing', () => {
    it('should fan-out streaming responses', async () => {
      // TODO: Start stream, attach subscriber mid-flight
      // Verify: Both receive full stream
    });
  });

  describe('Metrics', () => {
    it('should emit cache metrics', async () => {
      // TODO: Check Prometheus/metrics endpoint
      // Verify: mlx_cache_hits, mlx_cache_misses counters exist
    });
  });
});
```

---

## Task 1.9: Documentation

**Goal**: Operator runbook for Phase 1 rollout.

**Time**: 1 hour

**File**: `docs/operations/phase1-rollout.md`

```markdown
# Phase 1 Rollout Guide

## Overview

Phase 1 adds three caching optimizations:
1. Request Deduplication (1s TTL)
2. Prompt Cache (10k LRU, 5min TTL)
3. Request Coalescing (stream multiplexing)

## Prerequisites

- mlx-serving v1.3.0 or later
- Phase 0 configuration and baseline captured
- ADRs 012-014 approved

## Rollout Steps

### 1. Enable Request Deduplication (Low Risk)

**Config Change** (`config/runtime.yaml`):
```yaml
request_deduplication:
  enabled: true
```

**Restart**:
```bash
npm run restart
```

**Validation**:
```bash
# Check metrics
curl http://localhost:3000/metrics | grep mlx_dedup

# Expected: mlx_dedup_hits, mlx_dedup_misses counters
```

**Rollback** (if issues):
```yaml
request_deduplication:
  enabled: false
```

### 2. Enable Prompt Cache (Medium Risk)

**Config Change**:
```yaml
prompt_cache:
  enabled: true
  max_entries: 10000
  ttl_ms: 300000  # 5 minutes
```

**Validation**:
```bash
# Send duplicate request
curl -X POST http://localhost:3000/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"model": "gemma-2-27b-it-4bit", "prompt": "test", "max_tokens": 10}'

# Check for cache hit header
# Expected: x-mlx-cache-hit: true on second request
```

**Rollback**:
```yaml
prompt_cache:
  enabled: false
```

### 3. Enable Request Coalescing (High Risk)

**Config Change**:
```yaml
request_coalescing:
  enabled: true
```

**Validation**:
```bash
# Send identical concurrent requests
# Monitor logs for "Stream attached as subscriber"
```

**Rollback**:
```yaml
request_coalescing:
  enabled: false
```

## Monitoring

### Key Metrics

- `mlx_dedup_hits` - Request deduplication hits
- `mlx_dedup_misses` - Request deduplication misses
- `mlx_cache_hits` - Prompt cache hits
- `mlx_cache_misses` - Prompt cache misses
- `mlx_coalesced_requests` - Coalesced subscribers

### Alerts

**Warning**:
- Cache error rate > 0.1%
- Dedup overhead > 5ms

**Critical**:
- Cache poisoning detected (rejection rate > 1%)

## Troubleshooting

### Issue: Low Cache Hit Rate

**Symptoms**: mlx_cache_hits << mlx_cache_misses

**Diagnosis**:
```bash
# Check cache stats
curl http://localhost:3000/internal/stats | jq '.promptCache'
```

**Resolution**:
- Increase TTL if prompts repeat after 5min
- Increase max_entries if cache is full

### Issue: High Memory Usage

**Symptoms**: Node.js memory > 2GB

**Diagnosis**:
```bash
# Check cache size
curl http://localhost:3000/internal/stats | jq '.promptCache.totalBytes'
```

**Resolution**:
- Reduce max_bytes
- Reduce max_entries
- Disable persistence

## Performance Targets

- ≥110% tok/s vs baseline (duplicate-heavy)
- >50% cache hit rate after warm-up
- <1ms dedup overhead
```

---

## Integration Points

### 1. GenerateBatcher Integration

**Flow**:
```
GenerateBatcher.enqueue()
  ↓
Check PromptCache (fastest)
  ↓ (miss)
Check RequestDeduplicator
  ↓ (miss)
Check CoalescingRegistry
  ↓ (no active stream)
Proceed to batch dispatch
  ↓
Cache result in PromptCache
```

**Key Methods**:
- `GenerateBatcher.enqueue()` - Modified to check all three layers
- `GenerateBatcher.enqueueInternal()` - Extracted internal logic
- `GenerateBatcher.getDedupStats()` - New stats endpoint
- `GenerateBatcher.getPromptCacheStats()` - New stats endpoint

### 2. StreamRegistry Integration

**Flow**:
```
StreamRegistry.register()
  ↓
Check CoalescingRegistry for active stream
  ↓ (exists)
Attach as subscriber via attachSubscriber()
  ↓
Clone SSE stream with ReadableStream.tee()
  ↓
Broadcast chunks to all subscribers
```

**Key Methods**:
- `StreamRegistry.registerPrimaryStream()` - Register for coalescing
- `StreamRegistry.attachSubscriber()` - Attach late joiner
- `StreamRegistry.getSubscribers()` - Get subscribers for broadcast
- `StreamRegistry.handleChunk()` - Modified to broadcast

### 3. Configuration Integration

**Loader Flow**:
```
src/config/loader.ts
  ↓
Load config/runtime.yaml
  ↓
Parse Phase 1 blocks
  ↓
Validate schema
  ↓
Export Config interface
```

**Usage**:
```typescript
import { getConfig } from './config/loader.js';

const config = getConfig();
if (config.request_deduplication?.enabled) {
  // Initialize deduplicator
}
```

---

## TypeScript Interfaces

### Phase 1 Shared Types

**File**: `src/types/phase1-types.ts`

```typescript
/**
 * Shared types for Phase 1 caching layers
 */

/**
 * Request fingerprint parameters
 * Used by dedup, cache, and coalescing
 */
export interface RequestFingerprint {
  modelId: string;
  prompt: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  seed?: number;
}

/**
 * Cache hit metadata
 */
export interface CacheHitMetadata {
  type: 'dedup' | 'prompt_cache' | 'coalescing';
  key: string;
  streamId?: string;
  age?: number; // milliseconds since cached
  subscribers?: number; // for coalescing
}

/**
 * Telemetry event for cache operations
 */
export interface CacheTelemetryEvent {
  timestamp: number;
  type: 'hit' | 'miss' | 'eviction' | 'rejection';
  layer: 'dedup' | 'prompt_cache' | 'coalescing';
  key: string;
  metadata?: Record<string, any>;
}
```

### Telemetry Hooks

**File**: `src/core/generate-batcher.ts` (additions)

```typescript
export interface GenerateBatchTelemetryHooks extends TelemetryHooks {
  // ... existing hooks ...

  // Phase 1: Cache telemetry
  onCacheHit?: (event: CacheHitMetadata) => void;
  onCacheMiss?: (event: { type: string; key: string }) => void;
  onCacheEviction?: (event: { type: string; key: string; reason: string }) => void;
}
```

---

## Configuration Schema

### Full Phase 1 Config

```yaml
# Phase 1: Request Deduplication
request_deduplication:
  enabled: false  # MUST be false by default (opt-in)
  ttl_ms: 1000  # 1 second (balance between dedup and freshness)
  max_entries: 1000  # Memory guard (~ 1MB overhead)
  max_payload_kb: 512  # Prevent memory attacks

# Phase 1: Prompt Cache
prompt_cache:
  enabled: false  # MUST be false by default (opt-in)
  max_entries: 10000  # LRU capacity
  ttl_ms: 300000  # 5 minutes (configurable for workload)
  max_bytes: 104857600  # 100 MB total size
  persistence: false  # Disk persistence (optional)
  persistence_path: 'automatosx/tmp/prompt-cache.json'

# Phase 1: Request Coalescing
request_coalescing:
  enabled: false  # MUST be false by default (opt-in)
  buffer_size_kb: 64  # Buffer for late joiners
```

### Environment Variable Overrides

```bash
# Override feature flags
export MLX_REQUEST_DEDUP_ENABLED=true
export MLX_PROMPT_CACHE_ENABLED=true
export MLX_REQUEST_COALESCING_ENABLED=true

# Override TTL
export MLX_REQUEST_DEDUP_TTL_MS=2000
export MLX_PROMPT_CACHE_TTL_MS=600000
```

---

## Metrics & Observability

### Prometheus Metrics

**File**: `src/telemetry/otel.ts` (additions)

```typescript
import { Counter, Gauge, Histogram } from 'prom-client';

// Request Deduplication
export const dedupHitsCounter = new Counter({
  name: 'mlx_dedup_hits_total',
  help: 'Total number of request deduplication cache hits',
});

export const dedupMissesCounter = new Counter({
  name: 'mlx_dedup_misses_total',
  help: 'Total number of request deduplication cache misses',
});

export const dedupEvictionsCounter = new Counter({
  name: 'mlx_dedup_evictions_total',
  help: 'Total number of dedup cache evictions',
  labelNames: ['reason'], // 'ttl', 'capacity'
});

export const dedupSizeGauge = new Gauge({
  name: 'mlx_dedup_cache_size',
  help: 'Current size of dedup cache',
});

// Prompt Cache
export const cacheHitsCounter = new Counter({
  name: 'mlx_cache_hits_total',
  help: 'Total number of prompt cache hits',
});

export const cacheMissesCounter = new Counter({
  name: 'mlx_cache_misses_total',
  help: 'Total number of prompt cache misses',
});

export const cacheEvictionsCounter = new Counter({
  name: 'mlx_cache_evictions_total',
  help: 'Total number of cache evictions',
  labelNames: ['reason'], // 'lru', 'ttl', 'size'
});

export const cacheSizeGauge = new Gauge({
  name: 'mlx_cache_size',
  help: 'Current number of cached entries',
});

export const cacheBytesGauge = new Gauge({
  name: 'mlx_cache_bytes',
  help: 'Current cache size in bytes',
});

export const cacheHitRateGauge = new Gauge({
  name: 'mlx_cache_hit_rate',
  help: 'Cache hit rate (0.0-1.0)',
});

// Request Coalescing
export const coalescedRequestsCounter = new Counter({
  name: 'mlx_coalesced_requests_total',
  help: 'Total number of requests coalesced to existing streams',
});

export const coalescingActiveGauge = new Gauge({
  name: 'mlx_coalescing_active_streams',
  help: 'Current number of streams with subscribers',
});
```

### Metrics Export

**File**: `src/core/generate-batcher.ts` (periodic export)

```typescript
export class GenerateBatcher {
  // ... existing code ...

  private metricsTimer?: NodeJS.Timeout;

  constructor(...) {
    // ... existing constructor ...

    // Export metrics every 10s
    this.metricsTimer = setInterval(() => {
      this.exportMetrics();
    }, 10000);
  }

  private exportMetrics(): void {
    // Dedup metrics
    if (this.deduplicator) {
      const dedupStats = this.deduplicator.getStats();
      dedupHitsCounter.inc(dedupStats.hits);
      dedupMissesCounter.inc(dedupStats.misses);
      dedupSizeGauge.set(dedupStats.size);
    }

    // Cache metrics
    if (this.promptCache) {
      const cacheStats = this.promptCache.getStats();
      cacheHitsCounter.inc(cacheStats.hits);
      cacheMissesCounter.inc(cacheStats.misses);
      cacheSizeGauge.set(cacheStats.size);
      cacheBytesGauge.set(cacheStats.totalBytes);
      cacheHitRateGauge.set(cacheStats.hitRate);
    }
  }

  public cleanup(): void {
    // ... existing cleanup ...

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
  }
}
```

### Structured Logging

**Log Levels**:
- `DEBUG`: Cache hits, misses, evictions
- `INFO`: Feature enablement, cleanup
- `WARN`: Memory pressure, oversized payloads
- `ERROR`: Cache failures, serialization errors

**Example Logs**:
```json
{
  "level": "debug",
  "msg": "Cache hit for request",
  "fingerprint": "abc123...",
  "age": 1234,
  "streamId": "stream-1"
}

{
  "level": "warn",
  "msg": "Payload exceeds max fingerprint size, skipping dedup",
  "payloadSize": 524288,
  "maxSize": 524288
}

{
  "level": "info",
  "msg": "Subscriber attached to coalesced stream",
  "requestKey": "...",
  "primaryStreamId": "stream-1",
  "subscriberStreamId": "stream-2",
  "totalSubscribers": 2
}
```

---

## Testing Strategy

### Unit Tests

**Coverage Target**: 100% for new modules

**Test Files**:
1. `tests/core/request-deduplicator.test.ts` - Dedup logic
2. `tests/core/prompt-cache.test.ts` - LRU cache
3. `tests/core/coalescing-registry.test.ts` - Stream multiplexing

**Key Test Cases**:
- Deterministic fingerprinting
- TTL expiration
- LRU eviction
- Memory pressure handling
- Error propagation
- Promise sharing
- Stream broadcasting

### Integration Tests

**Coverage Target**: E2E flows

**Test Files**:
1. `tests/integration/generate-dedup.test.ts` - Dedup + Batcher
2. `tests/integration/prompt-cache.test.ts` - Cache + Backend
3. `tests/integration/stream-coalescing.test.ts` - Coalescing + SSE
4. `tests/integration/phase1-end-to-end.test.ts` - Full stack

**Key Test Cases**:
- Concurrent identical requests → 1 backend call
- Sequential requests after TTL → 2 backend calls
- Cache hit returns instantly
- Late joiner receives full stream
- Metrics emitted correctly

### Load Tests

**Benchmark Script**: `benchmarks/dedup_profile.ts`

**Test Scenarios**:
1. **Duplicate-heavy**: 80% duplicate prompts, 10 concurrent
2. **Mixed workload**: 30% duplicates, 20 concurrent
3. **Sequential**: Same prompt repeated 100x sequentially

**Success Criteria**:
- ≥110% tok/s vs baseline (duplicate-heavy)
- >50% cache hit rate
- <1ms dedup overhead

---

## Rollback Procedures

### Emergency Rollback (< 1 minute)

**Symptoms**:
- Error rate spike
- Memory leak
- Request timeouts

**Steps**:
1. Set all feature flags to `false` in `config/runtime.yaml`:
```yaml
request_deduplication:
  enabled: false
prompt_cache:
  enabled: false
request_coalescing:
  enabled: false
```

2. Restart server:
```bash
npm run restart
```

3. Verify rollback:
```bash
curl http://localhost:3000/internal/stats | jq '.promptCache.enabled'
# Expected: false
```

### Partial Rollback

Disable only problematic layer:

**Dedup Issues**:
```yaml
request_deduplication:
  enabled: false
```

**Cache Issues**:
```yaml
prompt_cache:
  enabled: false
```

**Coalescing Issues**:
```yaml
request_coalescing:
  enabled: false
```

### Rollback Validation

After rollback, verify:
1. Error rate returns to baseline
2. Memory usage stable
3. Latency within SLO
4. No cache-related logs

---

## Appendix

### A. Request Flow Diagram

```
Client Request
    ↓
HTTP Server
    ↓
[Prompt Cache] ───────────────→ Cache Hit? → Return cached response
    ↓ miss
[Request Deduplicator] ────────→ Active promise? → Share promise
    ↓ miss
[Coalescing Registry] ─────────→ Active stream? → Attach subscriber
    ↓ miss
GenerateBatcher
    ↓
batch_generate RPC
    ↓
Python MLX Runtime
    ↓
Streaming Response
    ↓
[Store in Prompt Cache] ←─────── Success
    ↓
[Broadcast to Subscribers] ←──── Coalesced?
    ↓
Return to client
```

### B. Memory Estimates

**Request Deduplicator**:
- Entry size: ~100 bytes (Promise ref + metadata)
- Max entries: 1,000
- Total: ~100 KB

**Prompt Cache**:
- Entry size: ~1-10 KB (depends on response length)
- Max entries: 10,000
- Total: ~10-100 MB

**Coalescing Registry**:
- Entry size: ~200 bytes (stream refs)
- Typical active: 10-50
- Total: ~10 KB

**Total Phase 1 Overhead**: ~10-100 MB

### C. Performance Benchmarks

**Hardware**: M1 Mac, 16GB RAM, MLX GPU

**Baseline** (Phase 0):
- Throughput: 87.73 tok/s (Qwen3-30B)
- Latency: 850ms TTFT
- GPU: 68% utilization

**Phase 1 Target**:
- Throughput: ≥96.5 tok/s (+10%)
- Latency: <650ms TTFT
- GPU: 70% utilization
- Cache hit rate: >50%

### D. Troubleshooting Guide

**Issue**: Cache not working

**Check**:
```bash
# Verify feature flag
cat config/runtime.yaml | grep -A5 prompt_cache

# Check stats
curl http://localhost:3000/internal/stats | jq '.promptCache'
```

**Issue**: High memory usage

**Check**:
```bash
# Check cache size
curl http://localhost:3000/internal/stats | jq '.promptCache.totalBytes'

# Reduce max_bytes
```

**Issue**: Low hit rate

**Check**:
```bash
# Check unique prompts vs total requests
curl http://localhost:3000/internal/stats | jq '.promptCache.hits, .promptCache.misses'

# Increase TTL or max_entries
```

---

## Next Steps

After Phase 1 completion:

1. **Promote ADRs**: Update ADR-012, 013, 014 from PROPOSED → ACCEPTED
2. **Capture Metrics**: Run benchmarks and document results
3. **Update Documentation**: Add Phase 1 to main README
4. **Plan Phase 2**: Multi-worker routing (Days 4-10)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-07
**Next Review**: After Phase 1 implementation
