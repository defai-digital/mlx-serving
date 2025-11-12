/**
 * Tokenizer Warm Queue
 *
 * Priority queue for prompt warm-up with TTL-based expiry.
 * Sorts by estimated token count to prioritize smaller prompts
 * for faster TTFT.
 *
 * Phase 4.3 Implementation
 */

import { safeAverage } from '@/utils/math-helpers.js';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type { TtftHint, PromptPayload, WarmQueueItem, QueueStats } from './types.js';

/**
 * Warm queue configuration
 */
export interface WarmQueueConfig {
  maxSize: number;
  ttlMs: number;
  priorityByTokens: boolean;
}

/**
 * Queue events
 */
export interface WarmQueueEvents {
  enqueued: (streamId: string, priority: number) => void;
  dequeued: (streamId: string, waitTimeMs: number) => void;
  evicted: (streamId: string, reason: 'ttl' | 'overflow') => void;
  overflow: (streamId: string) => void;
}

/**
 * Tokenizer Warm Queue
 *
 * Maintains a priority queue of prompts awaiting tokenization.
 * Automatically expires stale entries and enforces size limits.
 */
export class TokenizerWarmQueue extends EventEmitter<WarmQueueEvents> {
  private queue: WarmQueueItem[] = [];
  private config: WarmQueueConfig;
  private logger?: Logger;
  private evictedCount = 0;
  private processedCount = 0;
  private waitTimes: number[] = [];

  constructor(config: WarmQueueConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Enqueue a prompt for warm-up
   */
  public async enqueue(hint: TtftHint, payload: PromptPayload): Promise<void> {
    // Check for overflow
    if (this.queue.length >= this.config.maxSize) {
      this.logger?.warn(
        { streamId: hint.streamId, queueSize: this.queue.length },
        'Warm queue overflow'
      );

      try {
        this.emit('overflow', hint.streamId);
        this.emit('evicted', hint.streamId, 'overflow');
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting overflow event');
      }

      this.evictedCount++;
      return;
    }

    const now = Date.now();
    const item: WarmQueueItem = {
      hint,
      payload,
      enqueuedAt: now,
      expiresAt: now + this.config.ttlMs,
    };

    // Insert in priority order
    if (this.config.priorityByTokens) {
      const priority = hint.priority || hint.estimatedTokens;
      const insertIndex = this.queue.findIndex((qi) => {
        const qiPriority = qi.hint.priority || qi.hint.estimatedTokens;
        return qiPriority > priority;
      });

      if (insertIndex === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIndex, 0, item);
      }

      this.logger?.debug(
        { streamId: hint.streamId, priority, queueSize: this.queue.length },
        'Prompt enqueued in warm queue'
      );

      try {
        this.emit('enqueued', hint.streamId, priority);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting enqueued event');
      }
    } else {
      // FIFO
      this.queue.push(item);

      try {
        this.emit('enqueued', hint.streamId, 0);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting enqueued event');
      }
    }
  }

  /**
   * Dequeue the highest priority prompt
   */
  public async dequeue(streamId: string): Promise<WarmQueueItem | undefined> {
    // Evict expired entries first
    this.evictExpired();

    // Find the item by streamId
    const index = this.queue.findIndex((item) => item.hint.streamId === streamId);
    if (index === -1) {
      return undefined;
    }

    const item = this.queue.splice(index, 1)[0];
    const waitTimeMs = Date.now() - item.enqueuedAt;

    this.processedCount++;
    this.waitTimes.push(waitTimeMs);

    // Keep only last 1000 wait times for stats
    if (this.waitTimes.length > 1000) {
      this.waitTimes.shift();
    }

    this.logger?.debug(
      { streamId, waitTimeMs, queueSize: this.queue.length },
      'Prompt dequeued from warm queue'
    );

    try {
      this.emit('dequeued', streamId, waitTimeMs);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting dequeued event');
    }

    return item;
  }

  /**
   * Evict expired entries
   */
  public evictExpired(): number {
    const now = Date.now();
    let evicted = 0;

    // Remove all expired items
    this.queue = this.queue.filter((item) => {
      if (item.expiresAt <= now) {
        try {
          this.emit('evicted', item.hint.streamId, 'ttl');
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting evicted event');
        }
        evicted++;
        return false;
      }
      return true;
    });

    if (evicted > 0) {
      this.evictedCount += evicted;
      this.logger?.debug({ evicted, queueSize: this.queue.length }, 'Evicted expired items');
    }

    return evicted;
  }

  /**
   * Get queue statistics
   */
  public getStats(): QueueStats {
    const avgWaitTimeMs = safeAverage(this.waitTimes);

    // Calculate P95 wait time
    const sortedWaitTimes = [...this.waitTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedWaitTimes.length * 0.95);
    const p95WaitTimeMs = sortedWaitTimes[p95Index] || 0;

    return {
      size: this.queue.length,
      evicted: this.evictedCount,
      processed: this.processedCount,
      avgWaitTimeMs,
      p95WaitTimeMs,
    };
  }

  /**
   * Clear the queue
   */
  public clear(): void {
    this.queue = [];
    this.logger?.debug('Warm queue cleared');
  }

  /**
   * Get current queue size
   */
  public get size(): number {
    return this.queue.length;
  }
}
