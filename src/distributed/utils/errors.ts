/**
 * Custom error types for distributed inference system
 */

/**
 * Base error class for distributed system errors
 */
export class DistributedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'DistributedError';
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * NATS connection and communication errors
 */
export class NatsError extends DistributedError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = 'NatsError';
  }
}

/**
 * Connection-specific errors
 */
export class ConnectionError extends NatsError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'ConnectionError';
  }
}

/**
 * Timeout errors for requests
 */
export class TimeoutError extends NatsError {
  constructor(message: string, public readonly timeoutMs: number, cause?: Error) {
    super(message, 'TIMEOUT_ERROR', cause);
    this.name = 'TimeoutError';
  }
}

/**
 * Configuration errors
 */
export class ConfigurationError extends DistributedError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIGURATION_ERROR', cause);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validation errors for message payloads
 */
export class ValidationError extends DistributedError {
  constructor(
    message: string,
    public readonly errors: Array<{ path: string; message: string }>,
    cause?: Error
  ) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

/**
 * Worker-related errors
 */
export class WorkerError extends DistributedError {
  constructor(
    message: string,
    public readonly workerId?: string,
    cause?: Error
  ) {
    super(message, 'WORKER_ERROR', cause);
    this.name = 'WorkerError';
  }
}

/**
 * Controller error codes
 */
export enum ControllerErrorCode {
  // Worker availability errors
  NO_WORKERS_AVAILABLE = 'NO_WORKERS_AVAILABLE',
  NO_HEALTHY_WORKERS = 'NO_HEALTHY_WORKERS',
  WORKER_OFFLINE = 'WORKER_OFFLINE',
  WORKER_OVERLOADED = 'WORKER_OVERLOADED',

  // Request execution errors
  WORKER_TIMEOUT = 'WORKER_TIMEOUT',
  WORKER_UNAVAILABLE = 'WORKER_UNAVAILABLE',
  ALL_RETRIES_EXHAUSTED = 'ALL_RETRIES_EXHAUSTED',

  // Circuit breaker errors
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',

  // Validation errors
  REQUEST_VALIDATION_FAILED = 'REQUEST_VALIDATION_FAILED',
  INVALID_SESSION_ID = 'INVALID_SESSION_ID',

  // Model errors
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  MODEL_LOAD_FAILED = 'MODEL_LOAD_FAILED',

  // Internal errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NATS_ERROR = 'NATS_ERROR',
  CONTROLLER_ERROR = 'CONTROLLER_ERROR',
}

/**
 * Controller-related errors with enhanced context
 */
export class ControllerError extends DistributedError {
  public readonly errorCode: ControllerErrorCode;
  public readonly context: Record<string, unknown>;
  public readonly timestamp: number;
  public readonly retryable: boolean;

  constructor(
    message: string,
    errorCode: ControllerErrorCode = ControllerErrorCode.CONTROLLER_ERROR,
    context?: Record<string, unknown>,
    retryable: boolean = false,
    cause?: Error
  ) {
    super(message, errorCode, cause);
    this.name = 'ControllerError';
    this.errorCode = errorCode;
    this.context = context || {};
    this.timestamp = Date.now();
    this.retryable = retryable;
  }

  /**
   * Convert to JSON for logging/API responses
   */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.errorCode,
        message: this.message,
        context: this.context,
        timestamp: this.timestamp,
        retryable: this.retryable,
      },
    };
  }

  /**
   * Check if error code is retryable
   */
  static isRetryable(code: ControllerErrorCode): boolean {
    return [
      ControllerErrorCode.WORKER_TIMEOUT,
      ControllerErrorCode.WORKER_UNAVAILABLE,
      ControllerErrorCode.WORKER_OFFLINE,
      ControllerErrorCode.WORKER_OVERLOADED,
    ].includes(code);
  }
}

/**
 * Embedded server errors
 */
export class EmbeddedServerError extends DistributedError {
  constructor(message: string, cause?: Error) {
    super(message, 'EMBEDDED_SERVER_ERROR', cause);
    this.name = 'EmbeddedServerError';
  }
}

/**
 * Check if error is a distributed error
 */
export function isDistributedError(error: unknown): error is DistributedError {
  return error instanceof DistributedError;
}

/**
 * Check if error is a NATS error
 */
export function isNatsError(error: unknown): error is NatsError {
  return error instanceof NatsError;
}

/**
 * Wrap unknown error as DistributedError
 */
export function wrapError(error: unknown, message?: string): DistributedError {
  if (isDistributedError(error)) {
    return error;
  }

  const errorMessage = message || (error instanceof Error ? error.message : String(error));
  const cause = error instanceof Error ? error : undefined;

  return new DistributedError(errorMessage, 'UNKNOWN_ERROR', cause);
}
