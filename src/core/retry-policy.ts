/**
 * RetryPolicy - Exponential backoff with jitter for retrying failed operations
 *
 * Part of Phase 2.3a: Multi-Worker Scaling
 * Component 2.6: RetryPolicy (TypeScript)
 *
 * Purpose:
 * - Implements exponential backoff with jitter for retrying failed Python worker requests
 * - Integrated with multi-worker architecture for fault tolerance
 * - Provides configurable retry logic with error classification
 * - Tracks detailed statistics for observability
 *
 * Algorithm:
 * - Base delay = initialDelay * (multiplier ^ attempt)
 * - Jittered delay = baseDelay * (1 + random(-jitter, +jitter))
 * - Final delay = min(maxDelay, jitteredDelay)
 *
 * Usage:
 * ```typescript
 * const retryPolicy = new RetryPolicy({
 *   enabled: true,
 *   maxAttempts: 3,
 *   initialDelayMs: 100,
 *   maxDelayMs: 5000,
 *   backoffMultiplier: 2.0,
 *   jitter: 0.25,
 *   retryableErrors: ['TIMEOUT', 'ECONNRESET', 'WORKER_RESTART'],
 *   logger: pinoLogger,
 * });
 *
 * const result = await retryPolicy.execute(
 *   async () => await pythonWorker.call('generate', params),
 *   'worker-rpc-call'
 * );
 * ```
 *
 * @module retry-policy
 */

import type { Logger } from 'pino';

/**
 * Retry policy configuration
 */
export interface RetryPolicyConfig {
  /** Enable/disable retry logic (default: true) */
  enabled: boolean;

  /** Maximum retry attempts (default: 3) */
  maxAttempts: number;

  /** Initial delay in milliseconds (default: 100ms) */
  initialDelayMs: number;

  /** Maximum delay in milliseconds (default: 5000ms) */
  maxDelayMs: number;

  /** Exponential backoff multiplier (default: 2.0) */
  backoffMultiplier: number;

  /** Jitter factor 0-1 for ±% variation (default: 0.25 = ±25%) */
  jitter: number;

  /** Error codes/types to retry (e.g., ['TIMEOUT', 'ECONNRESET', 'WORKER_RESTART']) */
  retryableErrors: string[];

  /** Optional logger instance */
  logger?: Logger;
}

/**
 * Retry policy statistics
 */
export interface RetryPolicyStats {
  /** Whether retry is enabled */
  enabled: boolean;

  /** Total operations attempted */
  totalOperations: number;

  /** Successfully completed operations */
  successfulOperations: number;

  /** Failed operations (after all retries) */
  failedOperations: number;

  /** Total retry attempts across all operations */
  totalRetries: number;

  /** Retry count distribution by attempt number */
  retriesByAttempt: Record<number, number>;

  /** Average retries per operation */
  averageRetries: number;

  /** Success rate (0-1) */
  successRate: number;
}

/**
 * RetryPolicy - Exponential backoff retry with jitter
 *
 * Implements exponential backoff with jitter for retrying failed operations.
 * Thread-safe for concurrent operations. Safe for idempotent operations only.
 *
 * Key Features:
 * - Exponential backoff with configurable multiplier
 * - Jitter to prevent thundering herd
 * - Error classification for retry decisions
 * - Detailed statistics tracking
 * - Optional abort signal support
 * - Structured logging
 *
 * @example
 * ```typescript
 * const policy = new RetryPolicy({
 *   enabled: true,
 *   maxAttempts: 3,
 *   initialDelayMs: 100,
 *   maxDelayMs: 5000,
 *   backoffMultiplier: 2.0,
 *   jitter: 0.25,
 *   retryableErrors: ['TIMEOUT', 'ECONNRESET'],
 *   logger: pinoLogger,
 * });
 *
 * try {
 *   const result = await policy.execute(
 *     async () => await unstableOperation(),
 *     'operation-context'
 *   );
 * } catch (error) {
 *   // All retries exhausted or non-retryable error
 * }
 * ```
 */
export class RetryPolicy {
  private readonly config: RetryPolicyConfig;
  private readonly logger?: Logger;

  // Statistics tracking
  private stats = {
    totalOperations: 0,
    successfulOperations: 0,
    failedOperations: 0,
    totalRetries: 0,
    retriesByAttempt: {} as Record<number, number>,
  };

  /**
   * Create a new RetryPolicy
   *
   * @param config - Retry policy configuration
   */
  constructor(config: RetryPolicyConfig) {
    this.config = config;
    this.logger = config.logger;

    // Validate configuration
    if (config.maxAttempts < 1) {
      throw new Error('maxAttempts must be >= 1');
    }
    if (config.initialDelayMs < 0) {
      throw new Error('initialDelayMs must be >= 0');
    }
    if (config.maxDelayMs < config.initialDelayMs) {
      throw new Error('maxDelayMs must be >= initialDelayMs');
    }
    if (config.backoffMultiplier <= 0) {
      throw new Error('backoffMultiplier must be > 0');
    }
    if (config.jitter < 0 || config.jitter > 1) {
      throw new Error('jitter must be in range [0, 1]');
    }
  }

  /**
   * Execute operation with retry logic
   *
   * Attempts the operation up to maxAttempts times with exponential backoff.
   * Only retries errors that match retryableErrors configuration.
   *
   * @param operation - Async operation to execute
   * @param context - Optional context string for logging
   * @returns Operation result
   * @throws Last error if all retries exhausted or error is non-retryable
   */
  public async execute<T>(
    operation: () => Promise<T>,
    context?: string
  ): Promise<T> {
    this.stats.totalOperations++;

    // Fast path: retry disabled
    if (!this.config.enabled) {
      try {
        const result = await operation();
        this.stats.successfulOperations++;
        return result;
      } catch (error) {
        this.stats.failedOperations++;
        throw error;
      }
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        // Attempt operation
        const result = await operation();

        // Success!
        if (attempt > 1) {
          this.logger?.info(
            {
              context,
              attempt,
              maxAttempts: this.config.maxAttempts,
              elapsedMs: Date.now() - startTime,
            },
            'Operation succeeded after retry'
          );
        }

        this.stats.successfulOperations++;
        if (attempt > 1) {
          this.stats.totalRetries += attempt - 1;
          this.stats.retriesByAttempt[attempt] =
            (this.stats.retriesByAttempt[attempt] || 0) + 1;
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        if (!this.shouldRetry(lastError, attempt)) {
          this.logger?.debug(
            {
              context,
              error: lastError.message,
              errorName: lastError.name,
              attempt,
            },
            'Error not retryable or max attempts reached'
          );

          this.stats.failedOperations++;
          throw lastError;
        }

        // Calculate delay with exponential backoff + jitter
        const delayMs = this.calculateDelay(attempt);
        const totalElapsedMs = Date.now() - startTime;

        this.logger?.warn(
          {
            context,
            attempt,
            maxAttempts: this.config.maxAttempts,
            delayMs,
            totalElapsedMs,
            error: lastError.message,
            errorName: lastError.name,
          },
          'Retrying operation after delay'
        );

        // Wait before retry
        await this.delay(delayMs);
      }
    }

    // All retries exhausted
    this.stats.failedOperations++;
    this.stats.totalRetries += this.config.maxAttempts - 1;
    this.stats.retriesByAttempt[this.config.maxAttempts] =
      (this.stats.retriesByAttempt[this.config.maxAttempts] || 0) + 1;

    throw lastError || new Error('Retry failed');
  }

  /**
   * Check if operation should be retried
   *
   * Returns true if:
   * 1. Attempt number is less than maxAttempts
   * 2. Error matches retryableErrors configuration
   *
   * @param error - Error that occurred
   * @param attempt - Current attempt number (1-indexed)
   * @returns True if should retry
   */
  public shouldRetry(error: Error, attempt: number): boolean {
    // Check attempt limit
    if (attempt >= this.config.maxAttempts) {
      return false;
    }

    // Check if error is retryable
    return this.isRetryable(error);
  }

  /**
   * Calculate retry delay with exponential backoff + jitter
   *
   * Formula:
   * 1. baseDelay = initialDelay * (multiplier ^ attempt)
   * 2. jitteredDelay = baseDelay * (1 + random(-jitter, +jitter))
   * 3. finalDelay = min(maxDelay, jitteredDelay)
   *
   * Example with initialDelay=100ms, multiplier=2.0, jitter=0.25:
   * - Attempt 1: ~100ms ± 25% = 75-125ms
   * - Attempt 2: ~200ms ± 25% = 150-250ms
   * - Attempt 3: ~400ms ± 25% = 300-500ms
   *
   * @param attempt - Current attempt number (1-indexed)
   * @returns Delay in milliseconds
   */
  public calculateDelay(attempt: number): number {
    // Exponential backoff: initialDelay * multiplier^(attempt-1)
    const exponentialDelay =
      this.config.initialDelayMs *
      Math.pow(this.config.backoffMultiplier, attempt - 1);

    // Cap at max delay
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);

    // Add jitter: random in range [1 - jitter, 1 + jitter]
    const jitterRange = cappedDelay * this.config.jitter;
    const jitter = (Math.random() * 2 - 1) * jitterRange; // [-jitterRange, +jitterRange]

    const finalDelay = Math.max(0, cappedDelay + jitter);

    return Math.round(finalDelay);
  }

  /**
   * Get retry policy statistics
   *
   * @returns Current statistics
   */
  public getStats(): RetryPolicyStats {
    const averageRetries =
      this.stats.totalOperations > 0
        ? this.stats.totalRetries / this.stats.totalOperations
        : 0;

    const successRate =
      this.stats.totalOperations > 0
        ? this.stats.successfulOperations / this.stats.totalOperations
        : 0;

    return {
      enabled: this.config.enabled,
      totalOperations: this.stats.totalOperations,
      successfulOperations: this.stats.successfulOperations,
      failedOperations: this.stats.failedOperations,
      totalRetries: this.stats.totalRetries,
      retriesByAttempt: { ...this.stats.retriesByAttempt },
      averageRetries,
      successRate,
    };
  }

  /**
   * Reset statistics
   *
   * Useful for testing or periodic stats collection.
   */
  public reset(): void {
    this.stats = {
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      totalRetries: 0,
      retriesByAttempt: {},
    };
  }

  /**
   * Check if error is retryable
   *
   * Matches error against retryableErrors configuration by:
   * 1. Exact match on error.name (e.g., 'TimeoutError')
   * 2. Exact match on error.code (e.g., 'ECONNRESET')
   * 3. Case-insensitive substring match on error.message
   *
   * @param error - Error to check
   * @returns True if error is retryable
   */
  private isRetryable(error: Error): boolean {
    // Check error name (e.g., 'TimeoutError', 'NetworkError')
    if (this.config.retryableErrors.includes(error.name)) {
      return true;
    }

    // Check error code (e.g., 'ECONNRESET', 'EPIPE', 'TIMEOUT')
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode && this.config.retryableErrors.includes(errorCode)) {
      return true;
    }

    // Check error message for pattern match (case-insensitive)
    const message = error.message.toLowerCase();
    for (const pattern of this.config.retryableErrors) {
      if (message.includes(pattern.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Delay for specified milliseconds
   *
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after delay
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/**
 * Create a default RetryPolicy with common settings
 *
 * Default configuration:
 * - enabled: true
 * - maxAttempts: 3
 * - initialDelayMs: 100ms
 * - maxDelayMs: 5000ms
 * - backoffMultiplier: 2.0
 * - jitter: 0.25 (±25%)
 * - retryableErrors: ['TIMEOUT', 'ECONNRESET', 'EPIPE', 'WORKER_RESTART']
 *
 * @param overrides - Optional configuration overrides
 * @returns Configured RetryPolicy instance
 */
export function createDefaultRetryPolicy(
  overrides?: Partial<RetryPolicyConfig>
): RetryPolicy {
  const defaultConfig: RetryPolicyConfig = {
    enabled: true,
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 2.0,
    jitter: 0.25,
    retryableErrors: ['TIMEOUT', 'ECONNRESET', 'EPIPE', 'WORKER_RESTART'],
    ...overrides,
  };

  return new RetryPolicy(defaultConfig);
}
