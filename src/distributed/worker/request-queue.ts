/**
 * Request Queue
 *
 * Priority-based FIFO queue for inference requests.
 * Supports three priority levels: HIGH, MEDIUM, LOW
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { InferenceRequest } from '../types/messages.js';

/**
 * Request priority levels
 */
export enum RequestPriority {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

/**
 * Queued request
 */
interface QueuedRequest {
  request: InferenceRequest;
  priority: RequestPriority;
  enqueuedAt: number;
}

/**
 * Queue configuration
 */
export interface QueueConfig {
  /** Maximum queue depth */
  maxDepth: number;
  /** Backpressure strategy */
  backpressureStrategy: 'reject' | 'drop_low_priority';
}

/**
 * Queue statistics
 */
export interface QueueStats {
  totalEnqueued: number;
  totalDequeued: number;
  totalRejected: number;
  totalDropped: number;
  currentDepth: number;
  avgWaitTimeMs: number;
}

/**
 * Request Queue
 *
 * Priority queue with backpressure handling.
 *
 * @example
 * ```typescript
 * const queue = new RequestQueue({
 *   maxDepth: 100,
 *   backpressureStrategy: 'drop_low_priority',
 * });
 *
 * queue.enqueue(request, RequestPriority.HIGH);
 * const next = queue.dequeue();
 * ```
 */
export class RequestQueue {
  private queues: Map<RequestPriority, QueuedRequest[]> = new Map([
    [RequestPriority.HIGH, []],
    [RequestPriority.MEDIUM, []],
    [RequestPriority.LOW, []],
  ]);
  private logger: Logger;
  private stats: QueueStats = {
    totalEnqueued: 0,
    totalDequeued: 0,
    totalRejected: 0,
    totalDropped: 0,
    currentDepth: 0,
    avgWaitTimeMs: 0,
  };
  private totalWaitTime = 0;

  constructor(private config: QueueConfig) {
    this.logger = createLogger('RequestQueue');
  }

  /**
   * Enqueue request with priority
   */
  enqueue(request: InferenceRequest, priority: RequestPriority = RequestPriority.MEDIUM): boolean {
    // Check if queue is full
    if (this.isFull()) {
      if (this.config.backpressureStrategy === 'reject') {
        this.stats.totalRejected++;
        this.logger.warn('Queue full, rejecting request', {
          requestId: request.requestId,
          currentDepth: this.getDepth(),
        });
        return false;
      } else if (this.config.backpressureStrategy === 'drop_low_priority') {
        // Try to drop low priority request
        const dropped = this.dropLowPriorityRequest();
        if (!dropped) {
          this.stats.totalRejected++;
          this.logger.warn('Queue full, cannot drop, rejecting request', {
            requestId: request.requestId,
          });
          return false;
        }
      }
    }

    // Add to appropriate queue
    const queue = this.queues.get(priority)!;
    queue.push({
      request,
      priority,
      enqueuedAt: Date.now(),
    });

    this.stats.totalEnqueued++;
    this.stats.currentDepth = this.getDepth();

    this.logger.debug('Request enqueued', {
      requestId: request.requestId,
      priority,
      depth: this.getDepth(),
    });

    return true;
  }

  /**
   * Dequeue next request (highest priority first)
   */
  dequeue(): InferenceRequest | null {
    // Check HIGH priority first
    for (const priority of [RequestPriority.HIGH, RequestPriority.MEDIUM, RequestPriority.LOW]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        const item = queue.shift()!;

        // Update stats
        this.stats.totalDequeued++;
        this.stats.currentDepth = this.getDepth();

        const waitTime = Date.now() - item.enqueuedAt;
        this.totalWaitTime += waitTime;
        this.stats.avgWaitTimeMs = this.totalWaitTime / this.stats.totalDequeued;

        this.logger.debug('Request dequeued', {
          requestId: item.request.requestId,
          priority,
          waitTimeMs: waitTime,
          depth: this.getDepth(),
        });

        return item.request;
      }
    }

    return null;
  }

  /**
   * Drop lowest priority request to make room
   */
  private dropLowPriorityRequest(): boolean {
    const lowQueue = this.queues.get(RequestPriority.LOW)!;
    if (lowQueue.length > 0) {
      const dropped = lowQueue.shift()!;
      this.stats.totalDropped++;
      this.logger.warn('Dropped low priority request', {
        requestId: dropped.request.requestId,
      });
      return true;
    }
    return false;
  }

  /**
   * Get total queue depth
   */
  getDepth(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.getDepth() >= this.config.maxDepth;
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    return { ...this.stats, currentDepth: this.getDepth() };
  }

  /**
   * Clear all queues
   */
  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
    this.logger.info('Queue cleared');
  }
}
