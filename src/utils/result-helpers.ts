/**
 * Result Type Helpers
 *
 * ReScript-inspired Result types for explicit error handling.
 * Forces exhaustive error handling at compile time.
 *
 * Prevents bugs: BUG-019, BUG-020, BUG-022
 *
 * Usage:
 * ```typescript
 * function acquireQueue(): Result<Queue, ResourceExhausted> {
 *   const queue = pool.acquire();
 *   return queue ? Ok(queue) : Err(new ResourceExhausted('Pool exhausted'));
 * }
 *
 * const result = acquireQueue();
 * if (result.err) {
 *   // Handle error
 * } else {
 *   const queue = result.val; // Type-safe access
 * }
 * ```
 */

import { Result, Ok, Err } from 'ts-results';

/**
 * Result type for resource exhaustion
 *
 * Used when a resource pool (queue, connection, model) is exhausted.
 */
export class ResourceExhausted extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ResourceExhausted';
    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ResourceExhausted);
    }
  }
}

/**
 * Result type for invalid state
 *
 * Used when an operation is attempted in an invalid state.
 */
export class InvalidState extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'InvalidState';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidState);
    }
  }
}

/**
 * Result type for timeout
 *
 * Used when an operation times out.
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'TimeoutError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}

/**
 * Helper to convert Promise<T> to Promise<Result<T, Error>>
 *
 * Useful for wrapping existing async functions that throw exceptions.
 *
 * @example
 * ```typescript
 * const result = await resultify(fetchData());
 * if (result.ok) {
 *   console.log(result.val);
 * } else {
 *   console.error(result.val);
 * }
 * ```
 */
export async function resultify<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Helper to unwrap Result or throw
 *
 * Use when you want to convert Result back to exception-based flow.
 *
 * @example
 * ```typescript
 * const queue = unwrap(acquireQueue()); // Throws if Err
 * ```
 */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) {
    return result.val;
  }
  throw result.val;
}

/**
 * Helper to get value or default
 *
 * @example
 * ```typescript
 * const queue = getOrDefault(acquireQueue(), defaultQueue);
 * ```
 */
export function getOrDefault<T, E extends Error>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.val : defaultValue;
}

/**
 * Helper to map Result value
 *
 * @example
 * ```typescript
 * const queueSize = mapResult(acquireQueue(), q => q.size);
 * ```
 */
export function mapResult<T, U, E extends Error>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  return result.ok ? Ok(fn(result.val)) : result;
}

/**
 * Helper to chain Result operations
 *
 * @example
 * ```typescript
 * const result = chainResult(
 *   acquireQueue(),
 *   queue => processQueue(queue)
 * );
 * ```
 */
export function chainResult<T, U, E extends Error>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.val) : result;
}

// Re-export Result types for convenience
export { Result, Ok, Err };
