/**
 * Retry Handler
 *
 * Handles automatic retry logic for failed inference requests.
 * Implements exponential backoff and excludes failed workers from retries.
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { WorkerInfo } from './worker-registry.js';
import type { InferenceRequest } from '../types/messages.js';

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  /** Initial retry delay in milliseconds */
  retryDelayMs: number;
  /** Use exponential backoff */
  exponentialBackoff: boolean;
  /** Maximum delay for exponential backoff (ms) */
  maxDelayMs: number;
}

/**
 * Retryable error codes
 */
export const RETRYABLE_ERRORS = new Set([
  'WORKER_TIMEOUT',
  'WORKER_UNAVAILABLE',
  'WORKER_OVERLOADED',
  'CONNECTION_ERROR',
  'NATS_ERROR',
]);

/**
 * Retry context for tracking attempts
 */
export interface RetryContext {
  requestId: string;
  attempts: number;
  excludedWorkers: Set<string>;
  lastError?: Error;
}

/**
 * Retry Handler
 *
 * Provides automatic retry with failover for inference requests.
 *
 * Features:
 * - Configurable retry count
 * - Exponential backoff
 * - Worker exclusion (don't retry on same failed worker)
 * - Retryable error detection
 *
 * @example
 * ```typescript
 * const retryHandler = new RetryHandler({
 *   maxRetries: 2,
 *   retryDelayMs: 100,
 *   exponentialBackoff: true,
 *   maxDelayMs: 1000,
 * });
 *
 * const result = await retryHandler.executeWithRetry(
 *   request,
 *   async (req, excludedWorkers) => {
 *     // Your request execution logic
 *     return await sendRequest(req, excludedWorkers);
 *   }
 * );
 * ```
 */
export class RetryHandler {
  private logger: Logger;
  private config: RetryConfig;

  constructor(config: RetryConfig) {
    this.config = config;
    this.logger = createLogger('RetryHandler');

    this.logger.info('Retry handler initialized', {
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      exponentialBackoff: config.exponentialBackoff,
    });
  }

  /**
   * Execute request with automatic retry
   *
   * @param request - Inference request
   * @param executor - Function that executes the request
   * @returns Result from executor
   * @throws Last error if all retries exhausted
   */
  async executeWithRetry<T>(
    request: InferenceRequest,
    executor: (request: InferenceRequest, excludedWorkers: Set<string>) => Promise<T>
  ): Promise<T> {
    const context: RetryContext = {
      requestId: request.requestId,
      attempts: 0,
      excludedWorkers: new Set(),
    };

    while (context.attempts <= this.config.maxRetries) {
      try {
        // Execute request
        const result = await executor(request, context.excludedWorkers);

        if (context.attempts > 0) {
          this.logger.info('Request succeeded after retry', {
            requestId: request.requestId,
            attempts: context.attempts,
          });
        }

        return result;
      } catch (error) {
        const err = error as Error & { code?: string; workerId?: string };
        context.lastError = err;
        context.attempts++;

        // Check if error is retryable
        if (!this.isRetryable(err)) {
          this.logger.warn('Non-retryable error encountered', {
            requestId: request.requestId,
            error: err.message,
            code: err.code,
          });
          throw err;
        }

        // Exclude failed worker from future attempts
        if (err.workerId) {
          context.excludedWorkers.add(err.workerId);
          this.logger.debug('Worker excluded from retries', {
            requestId: request.requestId,
            workerId: err.workerId,
            excludedCount: context.excludedWorkers.size,
          });
        }

        // Check if we've exhausted retries
        if (context.attempts > this.config.maxRetries) {
          this.logger.error('All retries exhausted', {
            requestId: request.requestId,
            attempts: context.attempts,
            lastError: err.message,
          });
          throw err;
        }

        // Calculate retry delay
        const delay = this.calculateDelay(context.attempts);

        this.logger.warn('Request failed, retrying', {
          requestId: request.requestId,
          attempt: context.attempts,
          maxRetries: this.config.maxRetries,
          delayMs: delay,
          error: err.message,
          code: err.code,
        });

        // Wait before retry
        await this.delay(delay);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw context.lastError || new Error('Unknown error');
  }

  /**
   * Check if error is retryable
   *
   * @param error - Error to check
   * @returns true if error is retryable
   */
  private isRetryable(error: Error & { code?: string }): boolean {
    if (!error.code) {
      // No error code - assume not retryable
      return false;
    }

    return RETRYABLE_ERRORS.has(error.code);
  }

  /**
   * Calculate retry delay with optional exponential backoff
   *
   * @param attempt - Current attempt number (1-based)
   * @returns Delay in milliseconds
   */
  private calculateDelay(attempt: number): number {
    if (!this.config.exponentialBackoff) {
      return this.config.retryDelayMs;
    }

    // Exponential backoff: delay * (2 ^ (attempt - 1))
    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
    return Math.min(delay, this.config.maxDelayMs);
  }

  /**
   * Delay helper
   *
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get retry configuration
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }
}
