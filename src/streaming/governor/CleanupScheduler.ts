/**
 * Cleanup Scheduler
 *
 * Deterministic cleanup scheduler for stream resources.
 * Ensures streams are cleaned up in a predictable manner, preventing
 * the race condition bug where cleanup lagged behind stream termination.
 *
 * Features:
 * - Event-driven cleanup queue
 * - Monotonic cursor prevents reprocessing
 * - Configurable sweep interval and cleanup delay
 * - Idempotent cleanup operations
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';

/**
 * Stream cleanup event
 */
export interface StreamCleanupEvent {
  streamId: string;
  closedAt: number;
  reason: 'complete' | 'error' | 'timeout';
}

/**
 * Cleanup scheduler configuration
 */
export interface CleanupSchedulerConfig {
  /** Sweep interval in milliseconds */
  sweepIntervalMs: number;
  /** Maximum age of stale streams before cleanup (ms) */
  maxStaleLifetimeMs: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Cleanup scheduler events
 */
export interface CleanupSchedulerEvents {
  cleanup: (streamId: string, reason: string) => void;
  lag: (streamId: string, lagMs: number) => void;
}

/**
 * Cleanup Scheduler
 *
 * Manages deterministic cleanup of stream resources by maintaining
 * an ordered queue of cleanup events and processing them with
 * configurable delays and intervals.
 */
export class CleanupScheduler extends EventEmitter<CleanupSchedulerEvents> {
  private queue: StreamCleanupEvent[] = [];
  private cursor = 0; // Monotonic cursor for processed events
  private sweepInterval?: NodeJS.Timeout;
  private logger?: Logger;
  private config: CleanupSchedulerConfig;

  constructor(config: CleanupSchedulerConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Start the cleanup scheduler
   */
  public start(): void {
    if (this.sweepInterval) {
      this.logger?.warn('CleanupScheduler already started');
      return;
    }

    this.sweepInterval = setInterval(() => {
      this.sweep();
    }, this.config.sweepIntervalMs);

    this.logger?.debug(
      { sweepIntervalMs: this.config.sweepIntervalMs },
      'CleanupScheduler started'
    );
  }

  /**
   * Stop the cleanup scheduler
   */
  public stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = undefined;
    }

    this.logger?.debug('CleanupScheduler stopped');
  }

  /**
   * Schedule a stream for cleanup
   *
   * Events are inserted in order by closedAt timestamp
   * to maintain deterministic processing order.
   */
  public schedule(event: StreamCleanupEvent): void {
    // Insert in sorted order by closedAt
    const insertIndex = this.queue.findIndex(e => e.closedAt > event.closedAt);
    
    if (insertIndex === -1) {
      // Append to end
      this.queue.push(event);
    } else {
      // Insert at sorted position
      this.queue.splice(insertIndex, 0, event);
    }

    if (this.config.debug) {
      this.logger?.debug(
        { streamId: event.streamId, queueSize: this.queue.length, cursor: this.cursor },
        'Stream scheduled for cleanup'
      );
    }
  }

  /**
   * Sweep the cleanup queue and process eligible events
   *
   * Uses monotonic cursor to prevent reprocessing.
   * Only processes events older than maxStaleLifetimeMs.
   */
  private sweep(): void {
    const now = Date.now();
    let processed = 0;

    // Process events from cursor position onwards
    while (this.cursor < this.queue.length) {
      const event = this.queue[this.cursor];
      const age = now - event.closedAt;

      // Stop if event is too recent (not stale enough)
      if (age < this.config.maxStaleLifetimeMs) {
        break;
      }

      // Emit cleanup event
      try {
        this.emit('cleanup', event.streamId, event.reason);
      } catch (err) {
        this.logger?.error(
          { err, streamId: event.streamId },
          'Error in cleanup event handler'
        );
      }

      // Detect excessive lag
      if (age > this.config.maxStaleLifetimeMs * 2) {
        const lag = age - this.config.maxStaleLifetimeMs;
        this.logger?.warn(
          { streamId: event.streamId, lagMs: lag },
          'Cleanup lag detected'
        );

        try {
          this.emit('lag', event.streamId, lag);
        } catch (err) {
          this.logger?.error(
            { err, streamId: event.streamId },
            'Error in lag event handler'
          );
        }
      }

      // Advance cursor (monotonic)
      this.cursor++;
      processed++;
    }

    // Compact queue periodically (remove processed events)
    if (this.cursor > 100 && this.cursor > this.queue.length / 2) {
      this.queue = this.queue.slice(this.cursor);
      this.cursor = 0;

      if (this.config.debug) {
        this.logger?.debug(
          { queueSize: this.queue.length },
          'Compacted cleanup queue'
        );
      }
    }

    if (processed > 0 && this.config.debug) {
      this.logger?.debug(
        { processed, queueSize: this.queue.length, cursor: this.cursor },
        'Cleanup sweep completed'
      );
    }
  }

  /**
   * Get queue statistics
   */
  public getStats(): {
    queueSize: number;
    cursor: number;
    pendingCleanups: number;
  } {
    return {
      queueSize: this.queue.length,
      cursor: this.cursor,
      pendingCleanups: this.queue.length - this.cursor,
    };
  }

  /**
   * Clear all queued events (for testing/reset)
   */
  public clear(): void {
    this.queue = [];
    this.cursor = 0;
    this.logger?.debug('Cleanup queue cleared');
  }
}
