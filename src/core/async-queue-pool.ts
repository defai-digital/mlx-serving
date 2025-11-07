/**
 * AsyncQueue Object Pool
 *
 * OPTIMIZATION #4: Reuse AsyncQueue instances to reduce GC pressure
 * and allocation overhead during streaming generation.
 *
 * Expected benefit: 30-50ms per generation request by avoiding
 * repeated queue allocation and deallocation.
 */

/**
 * Minimal async queue with backpressure for streaming chunks.
 * Extracted from generator-factory.ts to enable pooling.
 */
export class AsyncQueue<T> {
  private readonly maxSize: number;
  private values: T[] = [];
  private readonly pendingResolvers: Array<
    (value: IteratorResult<T, void>) => void
  > = [];
  private readonly waitingWriters: Array<{
    value: T;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  public async push(value: T): Promise<void> {
    if (this.closed || this.failure) {
      return;
    }

    if (this.pendingResolvers.length > 0) {
      const resolve = this.pendingResolvers.shift()!;
      resolve({ value, done: false });
      return;
    }

    if (this.values.length < this.maxSize) {
      this.values.push(value);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.waitingWriters.push({ value, resolve, reject });
    });
  }

  public async shift(): Promise<IteratorResult<T, void>> {
    if (this.failure) {
      throw this.failure;
    }

    if (this.values.length > 0) {
      const value = this.values.shift()!;
      this.flushWriters();
      return { value, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    // Bug Fix #8: Use Promise<> with both resolve and reject to prevent unhandled rejection
    // Previous code used .then() which could throw uncaught errors if queue failed after Promise creation
    return new Promise<IteratorResult<T, void>>((resolve, reject) => {
      // Double-check state before registering resolver (prevent race condition)
      if (this.closed) {
        resolve({ value: undefined, done: true });
        return;
      }
      if (this.failure) {
        reject(this.failure);
        return;
      }

      // Register a wrapped resolver that checks failure state
      this.pendingResolvers.push((result) => {
        // Check failure at resolution time (in case fail() was called concurrently)
        if (this.failure) {
          reject(this.failure);
        } else {
          resolve(result);
        }
      });
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const resolve of this.pendingResolvers.splice(0)) {
      resolve({ value: undefined, done: true });
    }

    for (const writer of this.waitingWriters.splice(0)) {
      writer.reject(new Error('Queue closed'));
    }
  }

  public fail(error: Error): void {
    if (this.failure) {
      return;
    }

    this.failure = error;

    for (const resolve of this.pendingResolvers.splice(0)) {
      resolve({ value: undefined, done: true });
    }

    for (const writer of this.waitingWriters.splice(0)) {
      writer.reject(error);
    }
  }

  /**
   * Reset queue state for reuse in object pool
   * Clears all internal state to prepare for next usage
   *
   * IMPORTANT: This method assumes the queue is already closed/failed
   * and all pending operations have been resolved. If called on an active
   * queue, it will properly clean up any remaining operations.
   *
   * Bug Fix #41: Prevent race condition with concurrent push() operations
   * by closing the queue FIRST, then cleaning up, then resetting flags LAST.
   */
  public reset(): void {
    // Step 1: Prevent new operations FIRST (critical for preventing race)
    // Set closed=true to make any concurrent push() fail at line 34 check
    this.closed = true;

    // Step 2: Clean up pending resolvers (wrap in try-catch for safety)
    // Bug Fix #56: Add error boundaries to prevent user code errors from
    // breaking reset() and polluting the pool
    if (this.pendingResolvers.length > 0) {
      for (const resolve of this.pendingResolvers.splice(0)) {
        try {
          resolve({ value: undefined, done: true });
        } catch (err) {
          // Swallow user code errors during cleanup
          // Queue reset must complete regardless of user handler failures
        }
      }
    }

    // Step 3: Clean up waiting writers (with error boundaries)
    if (this.waitingWriters.length > 0) {
      const resetError = new Error('Queue reset during pool release');
      for (const writer of this.waitingWriters.splice(0)) {
        try {
          writer.reject(resetError);
        } catch (err) {
          // Swallow rejection handler errors
          // Must continue cleanup even if one handler throws
        }
      }
    }

    // Step 4: Clear values array
    this.values = [];

    // Step 5: Reset state flags LAST (after all cleanup is complete)
    // This ensures that if any operation is still in-flight, it sees closed=true
    this.closed = false;
    this.failure = null;
  }

  private flushWriters(): void {
    if (this.waitingWriters.length === 0) {
      return;
    }

    if (this.values.length >= this.maxSize) {
      return;
    }

    const { value, resolve } = this.waitingWriters.shift()!;
    this.values.push(value);
    resolve();
  }
}

/**
 * Object pool for AsyncQueue instances
 * Reduces GC pressure and allocation overhead during streaming
 */
export class AsyncQueuePool<T> {
  private readonly pool: Array<AsyncQueue<T>> = [];
  private readonly maxSize: number;
  private readonly highWaterMark: number;
  private acquireCount = 0;
  private releaseCount = 0;
  private releaseFailCount = 0;
  private poolFullCount = 0;

  /**
   * @param maxSize - Maximum number of queues to keep in pool (default: 5)
   * @param highWaterMark - Queue capacity (default: 64)
   */
  constructor(maxSize = 5, highWaterMark = 64) {
    this.maxSize = maxSize;
    this.highWaterMark = highWaterMark;
  }

  /**
   * Acquire a queue from pool or create new one
   */
  public acquire(): AsyncQueue<T> {
    this.acquireCount++;
    const queue = this.pool.pop();
    if (queue) {
      return queue;
    }

    // Pool exhausted, create new queue
    return new AsyncQueue<T>(this.highWaterMark);
  }

  /**
   * Release queue back to pool after use
   * Resets queue state before returning to pool
   *
   * Bug Fix #57: Wrap reset() in try-catch to prevent pool pollution
   * If reset() throws (due to unforeseen bugs), we discard the queue
   * instead of adding a polluted queue to the pool.
   */
  public release(queue: AsyncQueue<T>): void {
    this.releaseCount++;

    if (this.pool.length >= this.maxSize) {
      // Pool full, let queue be garbage collected
      this.poolFullCount++;
      return;
    }

    // Bug Fix #57: Reset queue state with error boundary
    // If reset() fails for any reason, don't add polluted queue to pool
    try {
      queue.reset();
      // Only add to pool if reset succeeded
      this.pool.push(queue);
    } catch (err) {
      // Don't add to pool if reset fails (let it be GC'd)
      // Better to create a new queue next time than reuse a polluted one
      this.releaseFailCount++;
      // Queue will be garbage collected instead of reused
    }
  }

  /**
   * Get current pool statistics
   */
  public getStats(): {
    available: number;
    maxSize: number;
    acquireCount: number;
    releaseCount: number;
    releaseFailCount: number;
    poolFullCount: number;
  } {
    return {
      available: this.pool.length,
      maxSize: this.maxSize,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      releaseFailCount: this.releaseFailCount,
      poolFullCount: this.poolFullCount,
    };
  }

  /**
   * Clear all queues from pool
   */
  public clear(): void {
    this.pool.splice(0);
  }
}
