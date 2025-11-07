/**
 * Request Queue for Core Engine
 *
 * Manages concurrent request execution with configurable limits.
 * Provides FIFO fairness and prevents resource exhaustion.
 *
 * Bug Fix #67: Uses UUID v4 for request IDs to prevent integer overflow.
 * UUIDs provide 2^122 unique IDs with negligible collision probability,
 * eliminating the overflow risk that exists with sequential integer counters.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/**
 * Queued request internal structure
 */
interface QueuedRequest<T> {
  id: string; // Bug Fix #67: UUID string (not numeric counter) to prevent overflow
  executor: () => Promise<T>;
  timestamp: number;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Request queue configuration
 */
export interface RequestQueueConfig {
  /**
   * Maximum number of concurrent requests.
   *
   * @remarks
   * - **Positive integer**: Strict concurrency limit (e.g., `maxConcurrent: 2`)
   * - **0 or negative**: Unlimited concurrency (no queuing)
   * - **undefined**: Defaults to 0 (unlimited)
   *
   * @throws {Error} If maxConcurrent is not an integer
   *
   * @default 0 (unlimited)
   *
   * @example
   * ```typescript
   * // Limit to 2 concurrent requests
   * const queue = new RequestQueue({ maxConcurrent: 2 });
   *
   * // Unlimited concurrency (no queuing)
   * const queue = new RequestQueue({ maxConcurrent: 0 });
   * ```
   */
  maxConcurrent: number;

  /**
   * Request timeout in milliseconds
   * @default 30000 (30 seconds)
   */
  requestTimeoutMs?: number;

  /**
   * Logger instance (optional)
   */
  logger?: Logger;
}

/**
 * Request queue statistics
 */
export interface RequestQueueStats {
  /**
   * Number of pending requests (not yet started)
   */
  pending: number;

  /**
   * Number of active requests (currently executing)
   */
  active: number;

  /**
   * Number of requests in queue (same as pending)
   */
  queued: number;

  /**
   * Maximum concurrent requests allowed
   */
  maxConcurrent: number;
}

/**
 * Request queue with concurrency control
 *
 * Provides FIFO fairness guarantee and prevents resource exhaustion
 * by limiting the number of concurrent operations.
 *
 * @example
 * ```typescript
 * const queue = new RequestQueue({ maxConcurrent: 2 });
 *
 * // Execute with concurrency limit
 * const result = await queue.execute(async () => {
 *   const model = await loadModel('llama-3-8b');
 *   return model;
 * });
 * ```
 */
export class RequestQueue {
  private readonly maxConcurrent: number;
  private readonly requestTimeoutMs: number;
  private readonly logger?: Logger;

  private pending = new Map<string, QueuedRequest<unknown>>();
  private active = new Map<string, QueuedRequest<unknown>>();
  private queue: Array<QueuedRequest<unknown>> = [];

  constructor(config: RequestQueueConfig) {
    // Bug Fix #71: Validate and normalize maxConcurrent
    const configured = config.maxConcurrent ?? 0;

    // Validate: must be an integer
    if (!Number.isInteger(configured)) {
      throw new Error(
        `RequestQueue: maxConcurrent must be an integer, got ${configured}`
      );
    }

    // Convert 0 or negative to infinity (unlimited concurrency)
    // Positive values are used as-is for strict concurrency limit
    this.maxConcurrent = configured > 0 ? configured : Number.POSITIVE_INFINITY;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
    this.logger = config.logger;

    this.logger?.debug(
      {
        maxConcurrent: this.maxConcurrent,
        configured: config.maxConcurrent,
        unlimited: this.maxConcurrent === Number.POSITIVE_INFINITY,
        timeout: this.requestTimeoutMs
      },
      'RequestQueue initialized'
    );
  }

  /**
   * Execute a function with concurrency control
   *
   * The function will be queued if max concurrent limit is reached.
   * Provides FIFO fairness guarantee.
   *
   * Bug Fix #67: Uses UUID v4 for request IDs instead of sequential counters.
   * This prevents integer overflow after 2^53 requests (Number.MAX_SAFE_INTEGER).
   * UUIDs provide effectively unlimited unique IDs with no overflow risk.
   *
   * @param executor - Function to execute
   * @returns Promise that resolves with the executor result
   * @throws Error if request times out or is cancelled
   */
  public async execute<T>(executor: () => Promise<T>): Promise<T> {
    // Bug Fix #67: Generate UUID for request ID (prevents overflow)
    const requestId = randomUUID();

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id: requestId,
        executor: executor,
        timestamp: Date.now(),
        resolve: resolve,
        reject: reject,
      };

      this.pending.set(requestId, request as QueuedRequest<unknown>);
      this.queue.push(request as QueuedRequest<unknown>);

      this.logger?.debug(
        { requestId, queueLength: this.queue.length, activeCount: this.active.size },
        'Request enqueued'
      );

      // Try to process immediately
      void this.processQueue();
    });
  }

  /**
   * Process queued requests up to max concurrent limit
   */
  private async processQueue(): Promise<void> {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) {
        break;
      }

      // Check if request was cancelled
      if (!this.pending.has(request.id)) {
        continue;
      }

      // Move from pending to active
      this.pending.delete(request.id);
      this.active.set(request.id, request);

      // Set timeout
      request.timeoutHandle = setTimeout(() => {
        this.handleTimeout(request.id);
      }, this.requestTimeoutMs);

      this.logger?.debug(
        { requestId: request.id, activeCount: this.active.size },
        'Request started'
      );

      // Execute request (don't await - run in parallel)
      void this.executeRequest(request);
    }
  }

  /**
   * Execute a single request
   */
  private async executeRequest(request: QueuedRequest<unknown>): Promise<void> {
    try {
      const result = await request.executor();

      // Check if still active (not cancelled/timed out)
      if (this.active.has(request.id)) {
        if (request.timeoutHandle) {
          clearTimeout(request.timeoutHandle);
        }
        this.active.delete(request.id);
        request.resolve(result);

        this.logger?.debug({ requestId: request.id }, 'Request completed successfully');

        // Process next queued request
        void this.processQueue();
      }
    } catch (error) {
      // Check if still active (not cancelled/timed out)
      if (this.active.has(request.id)) {
        if (request.timeoutHandle) {
          clearTimeout(request.timeoutHandle);
        }
        this.active.delete(request.id);
        request.reject(error instanceof Error ? error : new Error(String(error)));

        this.logger?.error({ requestId: request.id, error }, 'Request failed');

        // Process next queued request
        void this.processQueue();
      }
    }
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(requestId: string): void {
    const request = this.active.get(requestId);
    if (request) {
      this.active.delete(requestId);
      request.reject(
        new Error(`Request ${requestId} timed out after ${this.requestTimeoutMs}ms`)
      );

      this.logger?.warn(
        { requestId, timeout: this.requestTimeoutMs },
        'Request timed out'
      );

      // Process next queued request
      void this.processQueue();
    }
  }

  /**
   * Cancel a pending or active request
   *
   * @param requestId - ID of the request to cancel
   * @returns true if request was cancelled, false if not found
   */
  public cancel(requestId: string): boolean {
    // Check pending queue
    if (this.pending.has(requestId)) {
      const request = this.pending.get(requestId)!;
      this.pending.delete(requestId);

      // Remove from queue
      const index = this.queue.findIndex(r => r.id === requestId);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }

      request.reject(new Error('Request cancelled'));
      this.logger?.debug({ requestId }, 'Request cancelled (pending)');
      return true;
    }

    // Check active requests
    if (this.active.has(requestId)) {
      const request = this.active.get(requestId)!;
      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }
      this.active.delete(requestId);
      request.reject(new Error('Request cancelled'));

      this.logger?.debug({ requestId }, 'Request cancelled (active)');

      // Process next queued request
      void this.processQueue();
      return true;
    }

    return false;
  }

  /**
   * Wait for all active and pending requests to complete
   *
   * Useful for graceful shutdown.
   *
   * @param timeoutMs - Maximum time to wait for drain (default: 30000ms = 30 seconds)
   * @throws Error if drain times out with active requests still pending
   */
  public async drain(timeoutMs = 30000): Promise<void> {
    const startTime = Date.now();
    const initialActive = this.active.size;
    const initialQueued = this.queue.length;

    this.logger?.info(
      { activeCount: initialActive, queuedCount: initialQueued, timeoutMs },
      'Draining request queue'
    );

    // Bug Fix #9: Add timeout to prevent permanent hang
    // Use setInterval for more reliable checking than while loop
    return new Promise<void>((resolve, reject) => {
      // Immediately check if already empty (avoid waiting for first interval)
      if (this.active.size === 0 && this.queue.length === 0) {
        this.logger?.info({ initialActive, initialQueued }, 'Request queue already empty');
        resolve();
        return;
      }

      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const isEmpty = this.active.size === 0 && this.queue.length === 0;

        if (isEmpty) {
          clearInterval(checkInterval);
          this.logger?.info(
            { duration: elapsed, initialActive, initialQueued },
            'Request queue drained successfully'
          );
          resolve();
        } else if (elapsed > timeoutMs) {
          clearInterval(checkInterval);
          const error = new Error(
            `Request queue drain timeout after ${timeoutMs}ms: ` +
            `${this.active.size} active, ${this.queue.length} queued (started with ${initialActive} active, ${initialQueued} queued)`
          );
          this.logger?.error(
            {
              elapsed,
              activeCount: this.active.size,
              queuedCount: this.queue.length,
              initialActive,
              initialQueued,
            },
            'Request queue drain failed'
          );
          reject(error);
        }
      }, 100);
    });
  }

  /**
   * Get current queue statistics
   *
   * @returns Queue statistics object
   */
  public getStats(): RequestQueueStats {
    return {
      pending: this.pending.size,
      active: this.active.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * Check if queue is empty (no pending or active requests)
   */
  public isEmpty(): boolean {
    return this.pending.size === 0 && this.active.size === 0;
  }

  /**
   * Clear all pending requests (does not affect active requests)
   *
   * All pending requests will be rejected with a cancellation error.
   */
  public clearPending(): void {
    const pendingIds = Array.from(this.pending.keys());

    for (const id of pendingIds) {
      this.cancel(id);
    }

    this.logger?.info({ clearedCount: pendingIds.length }, 'Cleared pending requests');
  }
}
