/**
 * Object Pool
 *
 * Generic object pooling to reduce GC pressure through object reuse.
 * Week 7 Phase 7.1.2: Object Pooling
 * Target: 20% reduction in GC pressure, 5-10% throughput improvement
 */

export interface ObjectPoolOptions {
  maxSize?: number;
  preallocate?: number;
  trackStats?: boolean;
}

export interface ObjectPoolStats {
  size: number;
  maxSize: number;
  acquireCount: number;
  releaseCount: number;
  createCount: number;
  discardCount: number;
  reuseRate: number;
}

/**
 * Generic object pool for reusing objects to reduce GC pressure.
 *
 * @template T - Type of objects to pool
 *
 * @example
 * ```typescript
 * // Create pool for generator state objects
 * const statePool = new ObjectPool<GeneratorState>(
 *   () => ({ modelId: '', status: 'idle', lastUsed: 0 }),
 *   (state) => { state.modelId = ''; state.status = 'idle'; state.lastUsed = 0; },
 *   { maxSize: 100, preallocate: 10 }
 * );
 *
 * // Acquire object from pool
 * const state = statePool.acquire();
 * state.modelId = 'model-123';
 *
 * // Release object back to pool
 * statePool.release(state);
 * ```
 */
export class ObjectPool<T> {
  private readonly pool: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;
  private readonly maxSize: number;
  private readonly trackStats: boolean;

  // Statistics
  private acquireCount = 0;
  private releaseCount = 0;
  private createCount = 0;
  private discardCount = 0;

  /**
   * Create a new object pool.
   *
   * @param factory - Function to create new objects
   * @param reset - Function to reset object state before reuse
   * @param options - Pool configuration options
   */
  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    options: ObjectPoolOptions = {}
  ) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = options.maxSize ?? 100;
    this.trackStats = options.trackStats ?? false;

    // Preallocate objects if requested
    if (options.preallocate && options.preallocate > 0) {
      const count = Math.min(options.preallocate, this.maxSize);
      for (let i = 0; i < count; i++) {
        const obj = this.factory();
        this.pool.push(obj);
        this.createCount++;
      }
    }
  }

  /**
   * Acquire an object from the pool.
   * If pool is empty, creates a new object.
   *
   * @returns Object from pool or newly created
   */
  public acquire(): T {
    if (this.trackStats) {
      this.acquireCount++;
    }

    const obj = this.pool.pop();
    if (obj !== undefined) {
      return obj;
    }

    // Pool empty, create new object
    if (this.trackStats) {
      this.createCount++;
    }
    return this.factory();
  }

  /**
   * Release an object back to the pool.
   * Object is reset and added to pool if not at capacity.
   *
   * @param obj - Object to return to pool
   */
  public release(obj: T): void {
    if (this.trackStats) {
      this.releaseCount++;
    }

    if (this.pool.length < this.maxSize) {
      // Reset object state and return to pool
      this.reset(obj);
      this.pool.push(obj);
    } else {
      // Pool at capacity, discard object
      if (this.trackStats) {
        this.discardCount++;
      }
    }
  }

  /**
   * Clear all objects from the pool.
   * Useful for cleanup or resetting pool state.
   */
  public clear(): void {
    this.pool.length = 0;
  }

  /**
   * Get current pool size.
   *
   * @returns Number of objects currently in pool
   */
  public size(): number {
    return this.pool.length;
  }

  /**
   * Get maximum pool capacity.
   *
   * @returns Maximum number of objects pool can hold
   */
  public capacity(): number {
    return this.maxSize;
  }

  /**
   * Get pool statistics.
   *
   * @returns Pool usage statistics
   */
  public getStats(): ObjectPoolStats {
    const reuseRate =
      this.acquireCount > 0
        ? (this.acquireCount - this.createCount) / this.acquireCount
        : 0;

    return {
      size: this.pool.length,
      maxSize: this.maxSize,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      createCount: this.createCount,
      discardCount: this.discardCount,
      reuseRate: Math.max(0, Math.min(1, reuseRate)), // Clamp to [0, 1]
    };
  }

  /**
   * Reset statistics counters.
   */
  public resetStats(): void {
    this.acquireCount = 0;
    this.releaseCount = 0;
    this.createCount = 0;
    this.discardCount = 0;
  }

  /**
   * Check if pool is at capacity.
   *
   * @returns True if pool is full
   */
  public isFull(): boolean {
    return this.pool.length >= this.maxSize;
  }

  /**
   * Check if pool is empty.
   *
   * @returns True if pool has no objects
   */
  public isEmpty(): boolean {
    return this.pool.length === 0;
  }
}

/**
 * Create a pool for simple objects (plain objects, arrays, etc.)
 *
 * @template T - Type of object to pool
 * @param factory - Function to create new objects
 * @param options - Pool configuration options
 * @returns Object pool instance
 *
 * @example
 * ```typescript
 * const bufferPool = createSimplePool<Buffer>(
 *   () => Buffer.allocUnsafe(1024),
 *   { maxSize: 50, preallocate: 10 }
 * );
 * ```
 */
export function createSimplePool<T>(
  factory: () => T,
  options: ObjectPoolOptions = {}
): ObjectPool<T> {
  // For simple objects, reset is a no-op (rely on explicit reinitialization)
  const reset = (_obj: T) => {
    // No-op: caller responsible for reinitializing object after acquire
  };

  return new ObjectPool<T>(factory, reset, options);
}

/**
 * Create a pool for objects with a reset() method.
 *
 * @template T - Type of object to pool (must have reset method)
 * @param factory - Function to create new objects
 * @param options - Pool configuration options
 * @returns Object pool instance
 *
 * @example
 * ```typescript
 * interface Resettable {
 *   reset(): void;
 * }
 *
 * class Counter implements Resettable {
 *   count = 0;
 *   reset() { this.count = 0; }
 * }
 *
 * const counterPool = createResettablePool(
 *   () => new Counter(),
 *   { maxSize: 20 }
 * );
 * ```
 */
export function createResettablePool<T extends { reset(): void }>(
  factory: () => T,
  options: ObjectPoolOptions = {}
): ObjectPool<T> {
  const reset = (obj: T) => obj.reset();
  return new ObjectPool<T>(factory, reset, options);
}
