/**
 * Circuit Breaker Pattern Implementation
 *
 * Implements the circuit breaker pattern to prevent cascading failures when
 * Python workers or other services become unhealthy. The circuit breaker acts
 * as a state machine that monitors failures and automatically opens to prevent
 * further damage when failure thresholds are exceeded.
 *
 * @module core/circuit-breaker
 */

import type { Logger } from 'pino';

/**
 * Circuit breaker state
 *
 * The circuit breaker operates in three distinct states:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Circuit is open due to failures, requests are rejected immediately
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */
export enum CircuitState {
  /** Normal operation - requests pass through */
  CLOSED = 'closed',

  /** Failing - requests rejected immediately */
  OPEN = 'open',

  /** Testing recovery - limited requests allowed */
  HALF_OPEN = 'half_open',
}

/**
 * Circuit breaker configuration
 *
 * Controls the behavior and thresholds of the circuit breaker.
 */
export interface CircuitBreakerConfig {
  /** Circuit breaker name (for logging and identification) */
  name: string;

  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;

  /** Time in milliseconds to wait before attempting recovery (default: 10000ms) */
  recoveryTimeoutMs: number;

  /** Maximum number of calls allowed in half-open state (default: 1) */
  halfOpenMaxCalls: number;

  /** Number of successes required to close from half-open state (default: 2) */
  halfOpenSuccessThreshold: number;

  /** Time window in milliseconds for counting failures (default: 60000ms) */
  failureWindowMs: number;

  /** State change event callback */
  onStateChange?: (event: CircuitBreakerEvent) => void;

  /** Logger instance for structured logging */
  logger?: Logger;
}

/**
 * Circuit breaker state change event
 *
 * Emitted whenever the circuit breaker transitions between states.
 */
export interface CircuitBreakerEvent {
  /** Name of the circuit breaker */
  name: string;

  /** Previous state */
  previous: CircuitState;

  /** New state */
  next: CircuitState;

  /** Reason for state transition */
  reason: string;

  /** Total failure count at time of transition */
  failureCount: number;

  /** Timestamp of the transition */
  timestamp: number;
}

/**
 * Circuit breaker statistics
 *
 * Provides insight into the current state and history of the circuit breaker.
 */
export interface CircuitBreakerStats {
  /** Name of the circuit breaker */
  name: string;

  /** Current state */
  state: CircuitState;

  /** Total number of failures recorded */
  failureCount: number;

  /** Total number of successful operations */
  successCount: number;

  /** Number of rejected calls (when circuit is open) */
  rejectedCount: number;

  /** Number of attempts in half-open state */
  halfOpenAttempts: number;

  /** Timestamp of last state change */
  lastStateChange: number;

  /** Timestamp when circuit opened (undefined if not open) */
  openedAt?: number;
}

/**
 * CircuitBreaker
 *
 * Implements the circuit breaker pattern to prevent cascading failures.
 *
 * **State Machine:**
 *
 * ```
 * CLOSED ──(failures >= threshold)──> OPEN
 *   ^                                   │
 *   │                                   │
 *   │                        (after recoveryTimeout)
 *   │                                   │
 *   │                                   ▼
 *   └──(successes >= threshold)── HALF_OPEN
 *         ^                            │
 *         │                            │
 *         └────────(any failure)───────┘
 * ```
 *
 * **State Behaviors:**
 *
 * - **CLOSED**: Normal operation. Operations execute normally. Failures are tracked
 *   in a sliding time window. If failures exceed the threshold within the window,
 *   transitions to OPEN.
 *
 * - **OPEN**: Circuit is open. All operations are rejected immediately with
 *   CircuitBreakerOpenError. After recoveryTimeout, transitions to HALF_OPEN.
 *
 * - **HALF_OPEN**: Testing recovery. A limited number of operations are allowed
 *   (halfOpenMaxCalls). If enough succeed (halfOpenSuccessThreshold), transitions
 *   to CLOSED. Any failure immediately transitions back to OPEN.
 *
 * **Rolling Failure Window:**
 *
 * Failures are tracked with timestamps and only count if they occurred within
 * the failureWindowMs. This prevents a single burst of failures from permanently
 * opening the circuit.
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   name: 'python-worker',
 *   failureThreshold: 5,
 *   recoveryTimeoutMs: 10000,
 *   halfOpenMaxCalls: 1,
 *   halfOpenSuccessThreshold: 2,
 *   failureWindowMs: 60000,
 *   logger: myLogger,
 * });
 *
 * try {
 *   const result = await breaker.execute(async () => {
 *     return await riskyOperation();
 *   });
 * } catch (error) {
 *   if (error instanceof CircuitBreakerOpenError) {
 *     console.log('Circuit is open, retry after', error.retryAfterMs, 'ms');
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly logger?: Logger;

  // State tracking
  private state: CircuitState = CircuitState.CLOSED;
  private lastStateChange = Date.now();
  private openedAt?: number;

  // Statistics
  private failureCount = 0;
  private successCount = 0;
  private rejectedCount = 0;

  // Half-open state tracking
  private halfOpenAttempts = 0;
  private halfOpenSuccesses = 0;

  // Rolling failure window (stores failure timestamps)
  private readonly recentFailures: number[] = [];

  // Recovery timer
  private recoveryTimer?: NodeJS.Timeout;

  /**
   * Create a new CircuitBreaker
   *
   * @param config - Circuit breaker configuration
   */
  constructor(config: CircuitBreakerConfig) {
    this.config = config;
    this.logger = config.logger;

    this.logger?.info(
      {
        name: config.name,
        failureThreshold: config.failureThreshold,
        recoveryTimeoutMs: config.recoveryTimeoutMs,
        halfOpenMaxCalls: config.halfOpenMaxCalls,
        halfOpenSuccessThreshold: config.halfOpenSuccessThreshold,
        failureWindowMs: config.failureWindowMs,
      },
      'CircuitBreaker initialized'
    );
  }

  /**
   * Execute an operation through the circuit breaker
   *
   * The operation will be executed if the circuit is CLOSED or if the circuit
   * is HALF_OPEN and within the call limit. If the circuit is OPEN or the
   * half-open call limit is reached, a CircuitBreakerOpenError is thrown.
   *
   * @param operation - Async operation to execute
   * @returns Operation result
   * @throws CircuitBreakerOpenError if circuit is open or half-open limit reached
   * @throws Error if the operation itself fails
   */
  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Reject immediately if circuit is OPEN
    if (this.state === CircuitState.OPEN) {
      this.rejectedCount++;
      throw new CircuitBreakerOpenError(
        this.config.name,
        this.state,
        this.getRetryAfterMs()
      );
    }

    // Reject if HALF_OPEN and call limit reached
    if (
      this.state === CircuitState.HALF_OPEN &&
      this.halfOpenAttempts >= this.config.halfOpenMaxCalls
    ) {
      this.rejectedCount++;
      throw new CircuitBreakerOpenError(
        this.config.name,
        this.state,
        this.getRetryAfterMs()
      );
    }

    // Track half-open attempts
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++;
    }

    // Execute the operation
    try {
      const result = await operation();

      // Record success
      this.onSuccess();

      return result;
    } catch (error) {
      // Record failure
      this.onFailure();

      // Re-throw the original error
      throw error;
    }
  }

  /**
   * Handle successful operation
   *
   * Updates success statistics and handles state transitions based on
   * the current state.
   */
  private onSuccess(): void {
    this.successCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;

      // Check if we can transition to CLOSED
      if (this.halfOpenSuccesses >= this.config.halfOpenSuccessThreshold) {
        this.transitionTo(
          CircuitState.CLOSED,
          `Half-open success threshold reached (${this.halfOpenSuccesses}/${this.config.halfOpenSuccessThreshold})`
        );
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Success in CLOSED state resets failure count
      this.clearRecentFailures();
    }
  }

  /**
   * Handle failed operation
   *
   * Records the failure with timestamp and handles state transitions
   * based on failure thresholds.
   */
  private onFailure(): void {
    const now = Date.now();
    this.failureCount++;

    // Add failure to rolling window
    this.recentFailures.push(now);

    // Clean up old failures outside the time window
    this.cleanupRecentFailures();

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN immediately reopens circuit
      this.transitionTo(
        CircuitState.OPEN,
        'Failure during half-open recovery attempt'
      );
    } else if (this.state === CircuitState.CLOSED) {
      // Check if failure threshold exceeded in the rolling window
      const recentFailureCount = this.recentFailures.length;

      if (recentFailureCount >= this.config.failureThreshold) {
        this.transitionTo(
          CircuitState.OPEN,
          `Failure threshold reached (${recentFailureCount}/${this.config.failureThreshold} within ${this.config.failureWindowMs}ms)`
        );
      }
    }
  }

  /**
   * Transition to a new state
   *
   * Handles all state transition logic, cleanup, timers, and event emission.
   *
   * @param newState - Target state
   * @param reason - Human-readable reason for transition
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const previousState = this.state;

    // No-op if already in target state
    if (previousState === newState) {
      return;
    }

    // Update state
    this.state = newState;
    this.lastStateChange = Date.now();

    // State-specific setup
    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now();
      this.scheduleRecovery();
    } else if (newState === CircuitState.CLOSED) {
      this.clearRecentFailures();
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;
      this.openedAt = undefined;
      this.cancelRecovery();
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;
    }

    // Create state change event
    const event: CircuitBreakerEvent = {
      name: this.config.name,
      previous: previousState,
      next: newState,
      reason,
      failureCount: this.failureCount,
      timestamp: Date.now(),
    };

    // Log state change
    this.logger?.warn(
      {
        circuit: event.name,
        transition: `${event.previous} → ${event.next}`,
        reason: event.reason,
        failureCount: event.failureCount,
      },
      'Circuit breaker state changed'
    );

    // Emit event callback
    this.config.onStateChange?.(event);
  }

  /**
   * Schedule recovery attempt from OPEN to HALF_OPEN
   *
   * Sets a timer to transition to HALF_OPEN after recoveryTimeoutMs.
   */
  private scheduleRecovery(): void {
    // Cancel any existing timer
    this.cancelRecovery();

    // Schedule transition to HALF_OPEN
    this.recoveryTimer = setTimeout(() => {
      this.transitionTo(
        CircuitState.HALF_OPEN,
        `Recovery timeout elapsed (${this.config.recoveryTimeoutMs}ms)`
      );
    }, this.config.recoveryTimeoutMs);
  }

  /**
   * Cancel scheduled recovery timer
   */
  private cancelRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /**
   * Remove failures outside the rolling time window
   *
   * Keeps the recentFailures array clean by removing timestamps older
   * than failureWindowMs.
   */
  private cleanupRecentFailures(): void {
    const now = Date.now();
    const cutoff = now - this.config.failureWindowMs;

    // Remove failures older than the window (failures are ordered by time)
    while (
      this.recentFailures.length > 0 &&
      this.recentFailures[0] < cutoff
    ) {
      this.recentFailures.shift();
    }
  }

  /**
   * Clear all recent failures
   *
   * Used when transitioning to CLOSED state or on success.
   */
  private clearRecentFailures(): void {
    this.recentFailures.length = 0;
  }

  /**
   * Calculate how long to wait before retrying
   *
   * @returns Time in milliseconds until circuit may close
   */
  private getRetryAfterMs(): number {
    if (this.state === CircuitState.OPEN && this.openedAt) {
      const elapsed = Date.now() - this.openedAt;
      return Math.max(0, this.config.recoveryTimeoutMs - elapsed);
    }
    return this.config.recoveryTimeoutMs;
  }

  /**
   * Get current circuit state
   *
   * @returns Current state (CLOSED, OPEN, or HALF_OPEN)
   */
  public getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   *
   * Returns detailed statistics about the circuit breaker's current state
   * and historical performance.
   *
   * @returns Circuit breaker statistics
   */
  public getStats(): CircuitBreakerStats {
    return {
      name: this.config.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      rejectedCount: this.rejectedCount,
      halfOpenAttempts: this.halfOpenAttempts,
      lastStateChange: this.lastStateChange,
      openedAt: this.openedAt,
    };
  }

  /**
   * Manually reset the circuit breaker
   *
   * Forces the circuit to CLOSED state and clears all statistics.
   * This should be used carefully and typically only for administrative
   * or testing purposes.
   */
  public reset(): void {
    this.cancelRecovery();
    this.transitionTo(CircuitState.CLOSED, 'Manual reset');

    // Reset all counters
    this.failureCount = 0;
    this.successCount = 0;
    this.rejectedCount = 0;
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = undefined;
    this.clearRecentFailures();

    this.logger?.info({ circuit: this.config.name }, 'Circuit breaker reset');
  }

  /**
   * Force circuit to OPEN state
   *
   * Manually opens the circuit. Useful for maintenance or when external
   * monitoring detects issues.
   */
  public forceOpen(): void {
    this.transitionTo(CircuitState.OPEN, 'Forced open');
  }

  /**
   * Force circuit to CLOSED state
   *
   * Manually closes the circuit. Use with caution as this bypasses the
   * normal recovery process.
   */
  public forceClose(): void {
    this.transitionTo(CircuitState.CLOSED, 'Forced close');
  }

  /**
   * Cleanup resources
   *
   * Cancels timers and clears data structures. Should be called when
   * the circuit breaker is no longer needed.
   */
  public cleanup(): void {
    this.cancelRecovery();
    this.clearRecentFailures();

    this.logger?.info(
      { circuit: this.config.name },
      'Circuit breaker cleaned up'
    );
  }
}

/**
 * Error thrown when circuit breaker is open
 *
 * Indicates that the circuit breaker has opened due to excessive failures
 * and is rejecting requests to prevent cascading failures.
 */
export class CircuitBreakerOpenError extends Error {
  /**
   * Create a CircuitBreakerOpenError
   *
   * @param circuit - Name of the circuit breaker
   * @param state - Current state (OPEN or HALF_OPEN with limit reached)
   * @param retryAfterMs - Milliseconds to wait before retrying
   */
  constructor(
    public readonly circuit: string,
    public readonly state: CircuitState,
    public readonly retryAfterMs: number
  ) {
    super(
      `Circuit breaker '${circuit}' is ${state}, retry after ${retryAfterMs}ms`
    );
    this.name = 'CircuitBreakerOpenError';

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitBreakerOpenError);
    }
  }
}
