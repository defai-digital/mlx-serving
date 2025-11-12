/**
 * Continuous Batcher
 *
 * Micro-batching for inference requests to improve throughput.
 * Batches requests together with configurable size and timeout.
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { InferenceRequest } from '../types/messages.js';

/**
 * Batcher configuration
 */
export interface BatcherConfig {
  /** Minimum batch size (1 = no batching) */
  minBatchSize: number;
  /** Maximum batch size */
  maxBatchSize: number;
  /** Maximum wait time for batch formation (ms) */
  batchTimeoutMs: number;
  /** Enable adaptive timeout based on queue depth */
  adaptiveTimeout: boolean;
}

/**
 * Batch statistics
 */
export interface BatchStats {
  totalBatches: number;
  totalRequests: number;
  avgBatchSize: number;
  minBatchSize: number;
  maxBatchSize: number;
}

/**
 * Continuous Batcher
 *
 * Collects requests into micro-batches for efficient processing.
 *
 * @example
 * ```typescript
 * const batcher = new ContinuousBatcher({
 *   minBatchSize: 1,
 *   maxBatchSize: 8,
 *   batchTimeoutMs: 50,
 *   adaptiveTimeout: true,
 * });
 *
 * const result = await batcher.enqueue(request);
 * ```
 */
export class ContinuousBatcher {
  private queue: Array<{
    request: InferenceRequest;
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }> = [];
  private batchTimer?: NodeJS.Timeout;
  private processing = false;
  private logger: Logger;
  private stats: BatchStats = {
    totalBatches: 0,
    totalRequests: 0,
    avgBatchSize: 0,
    minBatchSize: Infinity,
    maxBatchSize: 0,
  };

  constructor(
    private config: BatcherConfig,
    private executor: (requests: InferenceRequest[]) => Promise<any[]>
  ) {
    this.logger = createLogger('ContinuousBatcher');
    this.logger.info('Continuous batcher initialized', {
      minBatchSize: config.minBatchSize,
      maxBatchSize: config.maxBatchSize,
      batchTimeoutMs: config.batchTimeoutMs,
    });
  }

  /**
   * Enqueue request for batching
   */
  async enqueue(request: InferenceRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });

      this.logger.debug('Request enqueued', {
        requestId: request.requestId,
        queueDepth: this.queue.length,
      });

      // Try to form batch immediately if at max size
      if (this.queue.length >= this.config.maxBatchSize) {
        this.processBatch();
      } else if (!this.batchTimer) {
        // Start batch timer
        const timeout = this.calculateTimeout();
        this.batchTimer = setTimeout(() => {
          this.processBatch();
        }, timeout);
      }
    });
  }

  /**
   * Process current batch
   */
  private async processBatch(): Promise<void> {
    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Skip if already processing or queue empty
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    // Form batch
    const batchSize = Math.min(this.queue.length, this.config.maxBatchSize);
    const batch = this.queue.splice(0, batchSize);

    const requests = batch.map((item) => item.request);

    this.logger.info('Processing batch', {
      size: batchSize,
      remainingQueue: this.queue.length,
    });

    try {
      // Execute batch
      const results = await this.executor(requests);

      // Resolve individual promises
      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve(results[i]);
      }

      // Update stats
      this.updateStats(batchSize);

      this.logger.debug('Batch processed successfully', {
        size: batchSize,
      });
    } catch (error) {
      this.logger.error('Batch processing failed', error as Error);

      // Reject all promises in batch
      for (const item of batch) {
        item.reject(error as Error);
      }
    } finally {
      this.processing = false;

      // Process next batch if queue not empty
      if (this.queue.length > 0) {
        setImmediate(() => this.processBatch());
      }
    }
  }

  /**
   * Calculate adaptive timeout based on queue depth
   */
  private calculateTimeout(): number {
    if (!this.config.adaptiveTimeout) {
      return this.config.batchTimeoutMs;
    }

    // Reduce timeout as queue grows
    const queueDepth = this.queue.length;
    const factor = Math.max(0.5, 1 - queueDepth / (this.config.maxBatchSize * 2));
    return Math.round(this.config.batchTimeoutMs * factor);
  }

  /**
   * Update batch statistics
   */
  private updateStats(batchSize: number): void {
    this.stats.totalBatches++;
    this.stats.totalRequests += batchSize;
    this.stats.avgBatchSize = this.stats.totalRequests / this.stats.totalBatches;
    this.stats.minBatchSize = Math.min(this.stats.minBatchSize, batchSize);
    this.stats.maxBatchSize = Math.max(this.stats.maxBatchSize, batchSize);
  }

  /**
   * Get batcher statistics
   */
  getStats(): BatchStats {
    return { ...this.stats };
  }

  /**
   * Get current queue depth
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Clear queue (for shutdown)
   */
  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Reject all pending requests
    for (const item of this.queue) {
      item.reject(new Error('Batcher shutting down'));
    }

    this.queue = [];
    this.logger.info('Batcher cleared');
  }
}
