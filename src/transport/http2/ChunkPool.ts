/**
 * Chunk Pool for Zero-Copy Optimization
 *
 * Object pool for Uint8Array chunks to reduce GC pressure
 * during high-frequency SSE event streaming.
 *
 * Phase 4.2 Implementation
 */

import type { Logger } from 'pino';

/**
 * Chunk pool configuration
 */
export interface ChunkPoolConfig {
  maxPoolSize: number;
  chunkSize: number;
}

/**
 * Zero-copy chunk pool
 *
 * Reuses pre-allocated buffers to minimize allocations
 * during SSE event formatting.
 */
export class ChunkPool {
  private pool: Uint8Array[] = [];
  private config: ChunkPoolConfig;
  private logger?: Logger;
  private allocated = 0;
  private reused = 0;

  constructor(config: ChunkPoolConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Acquire a chunk from the pool or allocate new one
   */
  public acquire(size: number): Uint8Array {
    if (size > this.config.chunkSize) {
      // Size exceeds pool chunk size, allocate directly
      this.allocated++;
      return new Uint8Array(size);
    }

    // Try to reuse from pool
    const chunk = this.pool.pop();
    if (chunk) {
      this.reused++;
      return chunk;
    }

    // Pool empty, allocate new
    this.allocated++;
    return new Uint8Array(this.config.chunkSize);
  }

  /**
   * Release a chunk back to the pool
   */
  public release(chunk: Uint8Array): void {
    if (this.pool.length >= this.config.maxPoolSize) {
      // Pool full, let GC handle it
      return;
    }

    if (chunk.byteLength !== this.config.chunkSize) {
      // Non-standard size, let GC handle it
      return;
    }

    // Reset chunk and return to pool
    chunk.fill(0);
    this.pool.push(chunk);
  }

  /**
   * Clear the entire pool
   */
  public clear(): void {
    this.pool = [];
    this.logger?.debug('Chunk pool cleared');
  }

  /**
   * Get pool statistics
   */
  public getStats(): {
    poolSize: number;
    allocated: number;
    reused: number;
    reuseRate: number;
  } {
    const total = this.allocated + this.reused;
    const reuseRate = total > 0 ? this.reused / total : 0;

    return {
      poolSize: this.pool.length,
      allocated: this.allocated,
      reused: this.reused,
      reuseRate,
    };
  }
}
