/**
 * Circuit breaker implementation for guarding calls to unstable dependencies.
 *
 * The breaker tracks consecutive failures, opens after a configurable threshold,
 * and offers a half-open probe state to verify recovery before resuming normal
 * operation. Designed to be concurrency safe for Node.js event loop workloads.
 */

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreakerTransitionReason =
  | 'FAILURE_THRESHOLD_EXCEEDED'
  | 'HALF_OPEN_FAILURE'
  | 'HALF_OPEN_SUCCESS'
  | 'RECOVERY_TIMEOUT_EXPIRED'
  | 'MANUAL_RESET';

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures required to open the breaker.
   */
  failureThreshold: number;
  /**
   * How long to remain open before allowing half-open probes (milliseconds).
   */
  recoveryTimeoutMs: number;
  /**
   * Maximum concurrent calls allowed while half-open.
   */
  halfOpenMaxCalls: number;
  /**
   * Number of successful half-open calls required before closing.
   */
  halfOpenSuccessThreshold: number;
  /**
   * Optional rolling window to reset failure counter after inactivity.
   */
  failureWindowMs?: number;
  /**
   * Optional callback invoked on state transitions.
   */
  onStateChange?: (event: CircuitBreakerStateChangeEvent) => void;
  /**
   * Optional logical clock; defaults to Date.now().
   */
  now?: () => number;
  /**
   * Optional circuit name for diagnostics.
   */
  name?: string;
}

export interface CircuitBreakerStateChangeEvent {
  name?: string;
  previous: CircuitBreakerState;
  next: CircuitBreakerState;
  reason: CircuitBreakerTransitionReason;
  at: number;
  failureCount: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  halfOpenSuccesses: number;
  halfOpenActiveCalls: number;
}

/**
 * Error thrown when the breaker is open and invocation is rejected.
 */
export class CircuitBreakerOpenError extends Error {
  public readonly code: number = -32000; // JSON-RPC ServerError code
  public readonly retryAfterMs: number;
  public readonly state: CircuitBreakerState;
  public readonly circuit?: string;

  constructor(message: string, options: { retryAfterMs: number; state: CircuitBreakerState; name?: string }) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.retryAfterMs = Math.max(options.retryAfterMs, 0);
    this.state = options.state;
    this.circuit = options.name;
  }
}

interface NormalizedCircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxCalls: number;
  halfOpenSuccessThreshold: number;
  failureWindowMs: number;
  onStateChange?: (event: CircuitBreakerStateChangeEvent) => void;
  now: () => number;
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private halfOpenSuccesses = 0;
  private halfOpenActiveCalls = 0;

  private readonly options: NormalizedCircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions) {
    this.options = this.normalizeOptions(options);
  }

  /**
   * Execute an async function guarded by the breaker.
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.options.now();
    const circuitName = this.options.name ?? 'unnamed-circuit';

    if (this.state === 'OPEN') {
      if (
        this.openedAt !== null &&
        now - this.openedAt >= this.options.recoveryTimeoutMs
      ) {
        this.transition('HALF_OPEN', 'RECOVERY_TIMEOUT_EXPIRED', now);
      } else {
        const retryAfter =
          this.openedAt !== null
            ? Math.max(
                0,
                this.options.recoveryTimeoutMs - (now - this.openedAt)
              )
            : this.options.recoveryTimeoutMs;

        throw new CircuitBreakerOpenError(
          `Circuit "${circuitName}" is open`,
          {
            retryAfterMs: retryAfter,
            state: this.state,
            name: this.options.name,
          }
        );
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenActiveCalls >= this.options.halfOpenMaxCalls) {
      throw new CircuitBreakerOpenError(
        `Circuit "${circuitName}" is half-open and probe concurrency is exhausted`,
        {
          retryAfterMs: this.options.recoveryTimeoutMs,
          state: this.state,
          name: this.options.name,
        }
      );
    }

    if (this.state === 'CLOSED' && this.shouldResetFailures(now)) {
      this.resetFailureCounters();
    }

    const enteredHalfOpen = this.state === 'HALF_OPEN';
    if (enteredHalfOpen) {
      this.halfOpenActiveCalls += 1;
    }

    try {
      const result = await fn();
      this.handleSuccess(now);
      return result;
    } catch (error) {
      // Don't count client errors (validation failures) as circuit breaker failures
      // These are -32600 to -32602 in JSON-RPC spec (InvalidRequest, MethodNotFound, InvalidParams)
      const isClientError = this.isClientError(error);
      if (!isClientError) {
        this.handleFailure(now);
      }
      throw error;
    } finally {
      if (enteredHalfOpen && this.halfOpenActiveCalls > 0) {
        this.halfOpenActiveCalls -= 1;
      }
    }
  }

  /**
   * Check if error is a client error that shouldn't count as circuit breaker failure
   */
  private isClientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    // Check for EngineClientError with validation-related codes
    const errorObj = error as { code?: number | string; name?: string };

    // JSON-RPC client error codes (standard spec)
    if (typeof errorObj.code === 'number') {
      // -32600 (InvalidRequest), -32601 (MethodNotFound), -32602 (InvalidParams)
      if (errorObj.code >= -32602 && errorObj.code <= -32600) {
        return true;
      }
    }

    // Check error name for validation errors
    if (errorObj.name === 'ValidationError' || errorObj.name === 'InvalidParamsError') {
      return true;
    }

    return false;
  }

  /**
   * Force-close the breaker (e.g., manual reset after maintenance).
   */
  public reset(): void {
    const now = this.options.now();
    this.transition('CLOSED', 'MANUAL_RESET', now);
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public getSnapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      halfOpenSuccesses: this.halfOpenSuccesses,
      halfOpenActiveCalls: this.halfOpenActiveCalls,
    };
  }

  private handleSuccess(now: number): void {
    this.failureCount = 0;
    this.lastFailureAt = null;

    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.options.halfOpenSuccessThreshold) {
        this.transition('CLOSED', 'HALF_OPEN_SUCCESS', now);
      }
    } else {
      this.halfOpenSuccesses = 0;
    }
  }

  private handleFailure(now: number): void {
    this.failureCount += 1;
    this.lastFailureAt = now;

    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN', 'HALF_OPEN_FAILURE', now);
      return;
    }

    if (this.failureCount >= this.options.failureThreshold) {
      this.transition('OPEN', 'FAILURE_THRESHOLD_EXCEEDED', now);
    }
  }

  private shouldResetFailures(now: number): boolean {
    if (!this.options.failureWindowMs) {
      return false;
    }
    if (!this.lastFailureAt) {
      return false;
    }
    return now - this.lastFailureAt >= this.options.failureWindowMs;
  }

  private transition(
    next: CircuitBreakerState,
    reason: CircuitBreakerTransitionReason,
    timestamp: number
  ): void {
    if (this.state === next) {
      if (next === 'CLOSED') {
        this.resetCountersForClosed();
      }
      return;
    }

    const previous = this.state;
    this.state = next;

    if (next === 'CLOSED') {
      this.resetCountersForClosed();
    } else if (next === 'OPEN') {
      this.openedAt = timestamp;
      this.halfOpenSuccesses = 0;
      this.halfOpenActiveCalls = 0;
    } else if (next === 'HALF_OPEN') {
      this.halfOpenSuccesses = 0;
      this.halfOpenActiveCalls = 0;
    }

    this.options.onStateChange?.({
      name: this.options.name,
      previous,
      next,
      reason,
      at: timestamp,
      failureCount: this.failureCount,
    });
  }

  private resetCountersForClosed(): void {
    this.failureCount = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    this.halfOpenSuccesses = 0;
    this.halfOpenActiveCalls = 0;
  }

  private resetFailureCounters(): void {
    this.failureCount = 0;
    this.lastFailureAt = null;
  }

  private normalizeOptions(options: CircuitBreakerOptions): NormalizedCircuitBreakerOptions {
    if (options.failureThreshold < 1) {
      throw new Error('failureThreshold must be >= 1');
    }
    if (options.recoveryTimeoutMs < 0) {
      throw new Error('recoveryTimeoutMs must be >= 0');
    }
    if (options.halfOpenMaxCalls < 1) {
      throw new Error('halfOpenMaxCalls must be >= 1');
    }
    if (options.halfOpenSuccessThreshold < 1) {
      throw new Error('halfOpenSuccessThreshold must be >= 1');
    }

    const normalized: NormalizedCircuitBreakerOptions = {
      failureThreshold: options.failureThreshold,
      recoveryTimeoutMs: options.recoveryTimeoutMs,
      halfOpenMaxCalls: options.halfOpenMaxCalls,
      halfOpenSuccessThreshold: options.halfOpenSuccessThreshold,
      failureWindowMs: options.failureWindowMs ?? 0,
      now: options.now ?? (() => Date.now()),
    };

    if (options.onStateChange) {
      normalized.onStateChange = options.onStateChange;
    }
    if (options.name) {
      normalized.name = options.name;
    }

    return normalized;
  }
}
