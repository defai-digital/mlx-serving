/**
 * Circuit Breaker
 *
 * Implements circuit breaker pattern for worker health management.
 * Prevents requests to unhealthy workers and allows recovery.
 *
 * States:
 * - CLOSED: Normal operation (requests allowed)
 * - OPEN: Circuit tripped (requests blocked)
 * - HALF_OPEN: Testing recovery (limited requests allowed)
 */

import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Number of successes to close circuit from half-open */
  successThreshold: number;
  /** Time to wait before trying half-open (ms) */
  timeoutMs: number;
}

/**
 * Circuit breaker statistics
 */
export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  openedAt: number | null;
}

/**
 * Circuit Breaker
 *
 * Per-worker circuit breaker to prevent cascading failures.
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker('worker-123', {
 *   failureThreshold: 5,
 *   successThreshold: 2,
 *   timeoutMs: 30000,
 * });
 *
 * if (breaker.canMakeRequest()) {
 *   try {
 *     await sendRequest(worker);
 *     breaker.recordSuccess();
 *   } catch (error) {
 *     breaker.recordFailure();
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private openedAt: number | null = null;
  private logger: Logger;

  constructor(
    private workerId: string,
    private config: CircuitBreakerConfig
  ) {
    this.logger = createLogger(`CircuitBreaker:${workerId.slice(0, 8)}`);
  }

  /**
   * Check if request can be made
   *
   * @returns true if requests are allowed
   */
  canMakeRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if timeout has passed
      if (this.shouldAttemptReset()) {
        this.transitionToHalfOpen();
        return true;
      }
      return false;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // Allow limited requests in half-open state
      return true;
    }

    return false;
  }

  /**
   * Record successful request
   */
  recordSuccess(): void {
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      this.logger.debug('Success recorded in half-open state', {
        successes: this.successes,
        threshold: this.config.successThreshold,
      });

      if (this.successes >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success
      if (this.failures > 0) {
        this.failures = 0;
        this.logger.debug('Failure count reset after success');
      }
    }
  }

  /**
   * Record failed request
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      this.failures++;
      this.logger.debug('Failure recorded', {
        failures: this.failures,
        threshold: this.config.failureThreshold,
      });

      if (this.failures >= this.config.failureThreshold) {
        this.transitionToOpen();
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state reopens circuit
      this.transitionToOpen();
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN && this.shouldAttemptReset()) {
      this.transitionToHalfOpen();
    }

    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      openedAt: this.openedAt,
    };
  }

  /**
   * Force reset circuit to closed state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.logger.info('Circuit breaker manually reset');
  }

  /**
   * Check if we should attempt reset from OPEN to HALF_OPEN
   */
  private shouldAttemptReset(): boolean {
    if (this.state !== CircuitState.OPEN || this.openedAt === null) {
      return false;
    }

    const elapsed = Date.now() - this.openedAt;
    return elapsed >= this.config.timeoutMs;
  }

  /**
   * Transition to CLOSED state
   */
  private transitionToClosed(): void {
    this.logger.info('Circuit breaker closed (healthy)', {
      previousState: this.state,
      successes: this.successes,
    });

    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
  }

  /**
   * Transition to OPEN state
   */
  private transitionToOpen(): void {
    this.logger.warn('Circuit breaker opened (unhealthy)', {
      previousState: this.state,
      failures: this.failures,
      timeoutMs: this.config.timeoutMs,
    });

    this.state = CircuitState.OPEN;
    this.openedAt = Date.now();
    this.successes = 0;
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(): void {
    this.logger.info('Circuit breaker half-open (testing recovery)', {
      previousState: this.state,
      timeoutElapsed: this.openedAt ? Date.now() - this.openedAt : 0,
    });

    this.state = CircuitState.HALF_OPEN;
    this.successes = 0;
    this.failures = 0;
  }
}

/**
 * Circuit Breaker Manager
 *
 * Manages circuit breakers for multiple workers.
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private logger: Logger;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
    this.logger = createLogger('CircuitBreakerManager');
  }

  /**
   * Get or create circuit breaker for worker
   */
  getBreaker(workerId: string): CircuitBreaker {
    let breaker = this.breakers.get(workerId);

    if (!breaker) {
      breaker = new CircuitBreaker(workerId, this.config);
      this.breakers.set(workerId, breaker);

      this.logger.debug('Circuit breaker created', { workerId });
    }

    return breaker;
  }

  /**
   * Remove circuit breaker for worker
   */
  removeBreaker(workerId: string): void {
    this.breakers.delete(workerId);
    this.logger.debug('Circuit breaker removed', { workerId });
  }

  /**
   * Get all circuit breaker stats
   */
  getAllStats(): Map<string, CircuitBreakerStats> {
    const stats = new Map<string, CircuitBreakerStats>();

    for (const [workerId, breaker] of this.breakers.entries()) {
      stats.set(workerId, breaker.getStats());
    }

    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
    this.logger.info('All circuit breakers reset');
  }
}
