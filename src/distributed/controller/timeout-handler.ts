/**
 * Timeout Handler
 *
 * Handles request timeouts for inference requests.
 * Provides different timeout values for buffered vs streaming requests.
 */

import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Timeout configuration
 */
export interface TimeoutConfig {
  /** Standard request timeout (ms) */
  standardTimeoutMs: number;
  /** Streaming request timeout (ms) */
  streamingTimeoutMs: number;
}

/**
 * Timeout error
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Timeout Handler
 *
 * Wraps promises with timeout enforcement.
 *
 * @example
 * ```typescript
 * const timeoutHandler = new TimeoutHandler({
 *   standardTimeoutMs: 30000,
 *   streamingTimeoutMs: 60000,
 * });
 *
 * const result = await timeoutHandler.withTimeout(
 *   fetchData(),
 *   30000,
 *   'Data fetch timeout'
 * );
 * ```
 */
export class TimeoutHandler {
  private logger: Logger;
  private config: TimeoutConfig;

  constructor(config: TimeoutConfig) {
    this.config = config;
    this.logger = createLogger('TimeoutHandler');
  }

  /**
   * Execute promise with timeout
   *
   * @param promise - Promise to execute
   * @param timeoutMs - Timeout in milliseconds
   * @param operation - Operation name for error message
   * @returns Promise result
   * @throws {TimeoutError} if timeout is reached
   */
  async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string = 'Operation'
  ): Promise<T> {
    const startTime = Date.now();

    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          const elapsed = Date.now() - startTime;
          const error = new TimeoutError(
            `${operation} timed out after ${elapsed}ms`,
            timeoutMs
          );

          this.logger.warn('Timeout exceeded', {
            operation,
            timeoutMs,
            elapsedMs: elapsed,
          });

          reject(error);
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Execute with standard timeout
   *
   * @param promise - Promise to execute
   * @param operation - Operation name
   * @returns Promise result
   */
  async withStandardTimeout<T>(promise: Promise<T>, operation: string = 'Request'): Promise<T> {
    return this.withTimeout(promise, this.config.standardTimeoutMs, operation);
  }

  /**
   * Execute with streaming timeout
   *
   * @param promise - Promise to execute
   * @param operation - Operation name
   * @returns Promise result
   */
  async withStreamingTimeout<T>(promise: Promise<T>, operation: string = 'Stream'): Promise<T> {
    return this.withTimeout(promise, this.config.streamingTimeoutMs, operation);
  }

  /**
   * Get timeout configuration
   */
  getConfig(): TimeoutConfig {
    return { ...this.config };
  }
}
