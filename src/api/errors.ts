/**
 * Engine error utilities.
 *
 * Provides a consistent error type for all public API surfaces and
 * helpers to convert lower-level transport errors into EngineError
 * instances that callers can reason about.
 */

import { JsonRpcError } from '../bridge/jsonrpc-transport.js';
import { JsonRpcErrorCode } from '../bridge/serializers.js';
import type { EngineError as EngineErrorShape } from '../types/index.js';
import type { ZodError } from 'zod';

/**
 * Engine error codes surfaced to API consumers.
 *
 * Codes mirror JSON-RPC errors as well as application specific failures
 * raised by the Python runtime. Additional client-side error codes cover
 * transport and cancellation scenarios.
 */
export type EngineErrorCode =
  | 'ParseError'
  | 'InvalidRequest'
  | 'MethodNotFound'
  | 'InvalidParams'
  | 'ValidationError' // Phase 1 Week 1: Zod validation errors
  | 'InternalError'
  | 'ServerError'
  | 'ModelLoadError'
  | 'GenerationError'
  | 'TokenizerError'
  | 'GuidanceError'
  | 'ModelNotLoaded'
  | 'RuntimeError'
  | 'TransportError'
  | 'Timeout'
  | 'Cancelled'
  | 'UnknownError';

/**
 * Error implementation returned by the engine.
 *
 * Implements the `EngineError` interface exported from the public types
 * module so it can be consumed as a plain object or as an Error instance.
 */
export class EngineClientError extends Error implements EngineErrorShape {
  public readonly code: EngineErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: EngineErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }

  /**
   * Serialize error into plain shape (for JSON responses/telemetry).
   */
  public toObject(): EngineErrorShape {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

const JSON_RPC_CODE_MAP: ReadonlyMap<number, EngineErrorCode> = new Map<number, EngineErrorCode>([
  [JsonRpcErrorCode.ParseError, 'ParseError'],
  [JsonRpcErrorCode.InvalidRequest, 'InvalidRequest'],
  [JsonRpcErrorCode.MethodNotFound, 'MethodNotFound'],
  [JsonRpcErrorCode.InvalidParams, 'InvalidParams'],
  [JsonRpcErrorCode.InternalError, 'InternalError'],
  [JsonRpcErrorCode.ServerError, 'ServerError'],
  [JsonRpcErrorCode.ModelLoadError, 'ModelLoadError'],
  [JsonRpcErrorCode.GenerationError, 'GenerationError'],
  [JsonRpcErrorCode.TokenizerError, 'TokenizerError'],
  [JsonRpcErrorCode.GuidanceError, 'GuidanceError'],
  [JsonRpcErrorCode.ModelNotLoaded, 'ModelNotLoaded'],
  [JsonRpcErrorCode.RuntimeError, 'RuntimeError'],
]);

/**
 * Map unknown errors into EngineClientError instances.
 *
 * @param error - Error thrown by transport or runtime
 * @param fallbackCode - Code to use when we cannot infer a specific one
 */
export function toEngineError(
  error: unknown,
  fallbackCode: EngineErrorCode = 'RuntimeError'
): EngineClientError {
  if (error instanceof EngineClientError) {
    return error;
  }

  if (error instanceof JsonRpcError) {
    const mappedCode =
      JSON_RPC_CODE_MAP.get(error.code) ?? fallbackCode;

    const details =
      typeof error.data === 'object' && error.data !== null
        ? (error.data as Record<string, unknown>)
        : undefined;

    return new EngineClientError(mappedCode, error.message, details);
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new EngineClientError('Cancelled', error.message || 'Operation aborted by caller');
    }

    if (/timeout/i.test(error.message)) {
      return new EngineClientError('Timeout', error.message);
    }

    return new EngineClientError(fallbackCode, error.message);
  }

  return new EngineClientError(fallbackCode, 'Unknown engine error');
}

/**
 * Convenience helper to create transport level errors.
 */
export function createTransportError(message: string): EngineClientError {
  return new EngineClientError('TransportError', message);
}

/**
 * Timeout error with additional context
 * Week 2 Day 2: Request Timeout Management
 */
export class TimeoutError extends EngineClientError {
  public readonly method: string;
  public readonly timeout: number;
  public readonly requestId?: string;
  public readonly duration?: number;

  constructor(
    message: string,
    details: {
      method: string;
      timeout: number;
      requestId?: string;
      duration?: number;
    }
  ) {
    super('Timeout', message, details);
    this.name = 'TimeoutError';
    this.method = details.method;
    this.timeout = details.timeout;
    this.requestId = details.requestId;
    this.duration = details.duration;
  }
}

/**
 * Convenience helper to create timeout errors
 */
export function createTimeoutError(
  method: string,
  timeout: number,
  requestId?: string,
  duration?: number
): TimeoutError {
  // Bug #5 P2: Restore legacy phrasing so monitors detect "timed out" events.
  const message = `Request timed out after ${timeout}ms: ${method}${requestId ? ` (id: ${requestId})` : ''}`;
  return new TimeoutError(message, { method, timeout, requestId, duration });
}

/**
 * Convert Zod validation error to EngineClientError
 *
 * Phase 1 Week 1: Zod Integration
 *
 * Extracts validation issues from Zod and formats them as clear,
 * actionable error messages with field-level details.
 *
 * @param error - Zod validation error
 * @returns EngineClientError with ValidationError code
 *
 * @example
 * ```typescript
 * const result = LoadModelOptionsSchema.safeParse({ model: '' });
 * if (!result.success) {
 *   throw zodErrorToEngineError(result.error);
 * }
 * // Throws: "Validation error on field 'model': Cannot be empty"
 * ```
 */
export function zodErrorToEngineError(error: ZodError): EngineClientError {
  const firstIssue = error.issues[0];
  const field = firstIssue.path.length > 0 ? firstIssue.path.join('.') : 'root';
  const message = `Validation error on field '${field}': ${firstIssue.message}`;

  return new EngineClientError('InvalidParams', message, {
    field,
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
    })),
  });
}
