/**
 * JSON-RPC 2.0 Transport Layer
 *
 * Handles communication with Python runtime via stdio:
 * - Line-delimited JSON framing
 * - Request/response correlation via IDs
 * - Notification routing
 * - Timeout and error handling
 */

import type { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { lazyLog } from '../utils/logger-helpers.js';
import {
  retryWithBackoff,
  type RetryConfig,
  RetryAbortedError,
} from '../utils/retry.js';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../utils/circuit-breaker.js';
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  JsonRpcMessageSchema,
  type JsonRpcErrorCode,
  type Codec,
  JsonCodec,
  FastJsonCodec,
  FAST_JSON_CODEC,
} from './serializers.js';
import { getConfig } from '../config/loader.js';
import { EngineClientError, createTimeoutError } from '../api/errors.js';
import {
  OpsMultiplexer,
  type MultiplexerRequestOptions,
  type MultiplexerStats,
} from './ops-multiplexer.js';

export interface RequestOptions extends MultiplexerRequestOptions {}

export type { RequestPriority } from './ops-multiplexer.js';

export type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeoutHandle?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface JsonRpcTransportEvents {
  error: (error: Error) => void;
  close: () => void;
  notification: (method: string, params: unknown) => void;
}

export interface JsonRpcTransportOptions {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  codec?: Codec;
  logger?: Logger;
  defaultTimeout?: number; // milliseconds (default: 30000)
}

/**
 * JSON-RPC 2.0 Transport over stdio
 *
 * Manages bidirectional communication with Python runtime.
 */
export class JsonRpcTransport extends EventEmitter<JsonRpcTransportEvents> {
  private stdin: Writable;
  private stdout: Readable;
  private stderr?: Readable;
  private codec: Codec;
  private logger?: Logger;
  private defaultTimeout: number;
  private maxPendingRequests: number;
  private maxLineBufferSize: number;
  private readonly retryDefaults: RetryConfig;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly idempotentMethods: Set<string>;
  private readonly unsafeMethods: Set<string>;
  private multiplexer: OpsMultiplexer;

  private pending = new Map<string | number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private nextId = 1;
  private closed = false;

  // Buffer for incomplete JSON lines
  private lineBuffer = '';

  // Write queue to ensure ordered writes
  private writeQueue: Promise<void> = Promise.resolve();

  // Event handlers (store references for cleanup)
  private stdoutDataHandler: ((chunk: string) => void) | null = null;
  private stdoutEndHandler: (() => void) | null = null;
  private stdoutErrorHandler: ((err: Error) => void) | null = null;
  private stderrDataHandler: ((chunk: string) => void) | null = null;
  private stdinErrorHandler: ((err: Error) => void) | null = null;

  constructor(options: JsonRpcTransportOptions) {
    super();

    // Load configuration
    const config = getConfig();

    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    // OPTIMIZATION: Use singleton FastJsonCodec to amortize JIT warmup cost
    // Bob's fix: Avoids per-transport instantiation overhead
    this.codec = options.codec ?? FAST_JSON_CODEC;
    this.logger = options.logger;
    this.defaultTimeout = options.defaultTimeout ?? config.json_rpc.default_timeout_ms;
    this.maxPendingRequests = config.json_rpc.max_pending_requests;
    this.maxLineBufferSize = config.json_rpc.max_line_buffer_size;
    this.retryDefaults = {
      maxAttempts: config.json_rpc.retry.max_attempts,
      initialDelayMs: config.json_rpc.retry.initial_delay_ms,
      maxDelayMs: config.json_rpc.retry.max_delay_ms,
      backoffMultiplier: config.json_rpc.retry.backoff_multiplier,
      retryableErrors: [...config.json_rpc.retry.retryable_errors],
      jitter: config.json_rpc.retry.jitter,
    };
    this.circuitBreaker = new CircuitBreaker({
      name: 'python-runtime',
      failureThreshold: config.json_rpc.circuit_breaker.failure_threshold,
      recoveryTimeoutMs: config.json_rpc.circuit_breaker.recovery_timeout_ms,
      halfOpenMaxCalls: config.json_rpc.circuit_breaker.half_open_max_calls,
      halfOpenSuccessThreshold: config.json_rpc.circuit_breaker.half_open_success_threshold,
      failureWindowMs: config.json_rpc.circuit_breaker.failure_window_ms,
      onStateChange: (event) => {
        this.logger?.warn(
          {
            circuit: event.name,
            previous_state: event.previous,
            next_state: event.next,
            reason: event.reason,
            failure_count: event.failureCount,
          },
          'Python runtime circuit breaker state change'
        );
      },
    });

    // Idempotent RPC methods that can be safely retried without side effects.
    // Bug fix: Add 'runtime/info' (slash form) to match actual caller usage
    this.idempotentMethods = new Set([
      'tokenize',
      'check_draft',
      'runtime_info',
      'runtime/info',  // Slash form used by Engine.ensureRuntime() and health checks
    ]);

    // Mutating or stateful methods that must never be retried automatically.
    this.unsafeMethods = new Set(['generate']);

    const configuredMaxBatchSize = Math.max(
      2,
      config.batch_queue?.max_batch_size ?? 20
    );
    this.multiplexer = new OpsMultiplexer({
      dispatch: <T>(rpcMethod: string, rpcParams?: unknown, rpcOptions?: MultiplexerRequestOptions) =>
        this.executeWithRetry<T>(rpcMethod, rpcParams, rpcOptions),
      logger: this.logger,
      enabled: config.batch_queue?.enabled ?? true,
      maxBatchSize: configuredMaxBatchSize,
      minBatchSize: Math.max(2, Math.floor(configuredMaxBatchSize / 2)),
      minHoldMs: 1,
      maxHoldMs: 4,
      lowConcurrencyThreshold: 1,
      highConcurrencyThreshold: Math.max(16, configuredMaxBatchSize * 2),
    });

    this.setupStreams();
  }

  /**
   * Send a JSON-RPC request and await response
   */
  private async performRequest<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Transport is closed');
    }

    if (this.pending.size >= this.maxPendingRequests) {
      const error = new Error(
        `Too many pending JSON-RPC requests (${this.pending.size} >= ${this.maxPendingRequests})`
      );
      this.logger?.error({ pending: this.pending.size, limit: this.maxPendingRequests }, 'Pending request limit exceeded');
      throw error;
    }

    const id = this.nextId++;
    const timeout = options?.timeout ?? this.defaultTimeout;
    const startTime = Date.now(); // Week 2 Day 2: Track request start time for duration

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      // Setup abort signal first (before timeout) so timeout handler can clean it up
      let abortHandler: (() => void) | undefined;
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new Error(`Request aborted: ${method}`));
          return;
        }

        abortHandler = () => {
          this.pending.delete(id);
          clearTimeout(timeoutHandle);
          reject(new Error(`Request aborted: ${method}`));
        };
        options.signal.addEventListener('abort', abortHandler);
      }

      // Setup timeout (after abort handler setup so it can reference abortHandler)
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        // Bug Fix #7: Clean up abort handler on timeout to prevent memory leak
        // If request times out, the abort handler must be removed from the signal
        // Otherwise, long-lived AbortControllers will accumulate leaked handlers
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        // Week 2 Day 2: Use enhanced TimeoutError with duration tracking
        const duration = Date.now() - startTime;
        reject(createTimeoutError(method, timeout, id.toString(), duration));
      }, timeout);

      // Register pending request
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutHandle);
          if (abortHandler && options?.signal) {
            options.signal.removeEventListener('abort', abortHandler);
          }
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          if (abortHandler && options?.signal) {
            options.signal.removeEventListener('abort', abortHandler);
          }
          reject(error);
        },
        method,
        timeoutHandle,
        signal: options?.signal,
        abortHandler,
      });

      // Send request
      this.write(request).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timeoutHandle);
        // Clean up abort handler on write error
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        reject(err);
      });

      // OPTIMIZATION #5: Lazy log evaluation - only build context if debug enabled
      lazyLog(this.logger, 'debug', () => ({ request, id }), 'Sent JSON-RPC request');
    });
  }

  private async executeWithRetry<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const shouldRetry = this.isRetryableMethod(method);
    let attempts = 0;

    const invoke = (): Promise<T> => {
      attempts += 1;
      return this.circuitBreaker.execute(() =>
        this.performRequest<T>(method, params, options)
      );
    };

    try {
      if (!shouldRetry) {
        return await invoke();
      }

      const retryConfig = this.createRetryConfig(method, options?.signal);
      return await retryWithBackoff(invoke, retryConfig);
    } catch (error) {
      if (error instanceof RetryAbortedError) {
        throw new Error(`Request aborted: ${method}`);
      }

      const enriched = this.enrichError(error, method, attempts);
      if (enriched instanceof Error) {
        this.logger?.error(
          {
            method,
            attempts,
            error: {
              name: enriched.name,
              message: enriched.message,
            },
          },
          'JSON-RPC request failed'
        );
      } else {
        this.logger?.error(
          { method, attempts, error: enriched },
          'JSON-RPC request failed'
        );
      }
      throw enriched;
    }
  }

  /**
   * Public request entry point with transport-level multiplexing.
   */
  public async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Transport is closed');
    }

    const maybeMultiplexed = this.multiplexer.request<T>(method, params, options);
    if (maybeMultiplexed) {
      return maybeMultiplexed;
    }

    return this.executeWithRetry<T>(method, params, options);
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  public notify(method: string, params?: unknown): void {
    if (this.closed) {
      this.logger?.warn('Attempted to notify on closed transport');
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.write(notification).catch((err) => {
      this.logger?.error({ err, method }, 'Failed to send notification');
      this.emit('error', err);
    });

    // OPTIMIZATION #5: Lazy log evaluation
    lazyLog(this.logger, 'debug', () => ({ notification }), 'Sent JSON-RPC notification');
  }

  /**
   * Register handler for incoming notifications
   */
  public onNotification(method: string, handler: NotificationHandler): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }

    const handlers = this.notificationHandlers.get(method)!;
    handlers.add(handler);

    // Bug #2 P1: Return unsubscribe closure so callers can cleanup handlers.
    return () => {
      const registered = this.notificationHandlers.get(method);
      if (!registered) {
        return;
      }

      registered.delete(handler);
      if (registered.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  /**
   * Unregister notification handler
   */
  public offNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      return;
    }

    handlers.delete(handler);
    if (handlers.size === 0) {
      this.notificationHandlers.delete(method);
    }
  }

  /**
   * Close the transport
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      await this.multiplexer.flushAll('manual');
    } catch (err) {
      this.logger?.debug(
        { err },
        'Failed to flush multiplexer during transport close'
      );
    }

    // Remove all stream event listeners to prevent memory leaks
    if (this.stdoutDataHandler) {
      this.stdout.off('data', this.stdoutDataHandler);
      this.stdoutDataHandler = null;
    }
    if (this.stdoutEndHandler) {
      this.stdout.off('end', this.stdoutEndHandler);
      this.stdoutEndHandler = null;
    }
    if (this.stdoutErrorHandler) {
      this.stdout.off('error', this.stdoutErrorHandler);
      this.stdoutErrorHandler = null;
    }
    if (this.stderrDataHandler && this.stderr) {
      this.stderr.off('data', this.stderrDataHandler);
      this.stderrDataHandler = null;
    }
    if (this.stdinErrorHandler) {
      this.stdin.off('error', this.stdinErrorHandler);
      this.stdinErrorHandler = null;
    }

    // Reject all pending requests
    const error = new Error('Transport closed');
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
      if (pending.abortHandler && pending.signal) {
        pending.signal.removeEventListener('abort', pending.abortHandler);
      }
      pending.reject(error);
      this.pending.delete(id);
    }

    // Clear notification handlers
    this.notificationHandlers.clear();

    this.emit('close');
  }

  /**
   * Check if transport is ready
   */
  public isReady(): boolean {
    return !this.closed && this.stdin.writable;
  }

  /**
   * Expose multiplexer instrumentation for observability/tests.
   */
  public getMultiplexerStats(): MultiplexerStats {
    return this.multiplexer.getStats();
  }

  /**
   * Setup stream event handlers
   */
  private setupStreams(): void {
    // Handle stdout (JSON-RPC responses/notifications)
    this.stdout.setEncoding('utf-8');

    this.stdoutDataHandler = (chunk: string) => {
      this.handleStdoutData(chunk);
    };
    this.stdout.on('data', this.stdoutDataHandler);

    this.stdoutEndHandler = () => {
      this.logger?.warn('Stdout ended');
      this.close().catch(() => {
        // Ignore errors during close
      });
    };
    this.stdout.on('end', this.stdoutEndHandler);

    this.stdoutErrorHandler = (err: Error) => {
      this.logger?.error({ err }, 'Stdout error');
      this.emit('error', err);
    };
    this.stdout.on('error', this.stdoutErrorHandler);

    // Handle stderr (logs/warnings)
    if (this.stderr) {
      this.stderr.setEncoding('utf-8');
      this.stderrDataHandler = (chunk: string) => {
        this.logger?.warn({ stderr: chunk.trim() }, 'Python stderr');
      };
      this.stderr.on('data', this.stderrDataHandler);
    }

    // Handle stdin errors
    this.stdinErrorHandler = (err: Error) => {
      this.logger?.error({ err }, 'Stdin error');
      this.emit('error', err);
    };
    this.stdin.on('error', this.stdinErrorHandler);
  }

  /**
   * Handle incoming stdout data
   */
  private handleStdoutData(chunk: string): void {
    this.lineBuffer += chunk;

    const bufferSize = Buffer.byteLength(this.lineBuffer, 'utf-8');
    if (bufferSize > this.maxLineBufferSize) {
      // Bug #3 P1: Guard against unbounded stdout growth (DoS risk).
      const error = new Error(
        `JSON-RPC stdout line buffer exceeded limit (${bufferSize} > ${this.maxLineBufferSize})`
      );
      this.logger?.error({ size: bufferSize, limit: this.maxLineBufferSize }, 'Stdout buffer overflow');
      this.emit('error', error);
      this.lineBuffer = '';
      // Close transport to shed malicious peer; ignore close errors.
      this.close().catch(() => {});
      return;
    }

    // Process complete lines
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const message = this.codec.decode(Buffer.from(line, 'utf-8'));
        this.handleMessage(message);
      } catch (err) {
        this.logger?.error({ err, line }, 'Failed to parse JSON-RPC message');
        this.emit('error', err as Error);
      }
    }
  }

  /**
   * Handle parsed JSON-RPC message
   */
  private handleMessage(raw: unknown): void {
    // OPTIMIZATION #2: Skip full Zod validation in production for high-frequency path
    // This is called for every JSON-RPC message (responses, notifications, errors)
    // Saves ~5-10ms per message by using fast type guards instead of Zod
    let message: JsonRpcMessage;

    if (process.env.NODE_ENV === 'production') {
      // Fast path: Basic runtime check for JSON-RPC structure
      const msg = raw as Record<string, unknown>;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        this.logger?.error({ raw }, 'Invalid JSON-RPC message (fast check)');
        return;
      }
      message = msg as JsonRpcMessage;
    } else {
      // Development: Full Zod validation for safety
      const parseResult = JsonRpcMessageSchema.safeParse(raw);
      if (!parseResult.success) {
        this.logger?.error({ raw, error: parseResult.error }, 'Invalid message');
        return;
      }
      message = parseResult.data as JsonRpcMessage;
    }

    // Check if it's a response
    if ('result' in message || 'error' in message) {
      this.handleResponse(message);
    } else if ('method' in message && !('id' in message)) {
      // Notification
      this.handleNotification(message);
    } else {
      // Debug: log more details about unexpected message
      this.logger?.warn(
        {
          message,
          hasResult: 'result' in message,
          hasError: 'error' in message,
          hasMethod: 'method' in message,
          hasId: 'id' in message,
          messageKeys: Object.keys(message),
        },
        'Unexpected message type'
      );
    }
  }

  /**
   * Handle JSON-RPC response
   */
  private handleResponse(message: JsonRpcMessage): void {
    if (!('id' in message) || message.id === null || message.id === undefined) {
      this.logger?.warn({ message }, 'Response without valid ID');
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger?.warn(
        { id: message.id },
        'Received response for unknown request'
      );
      return;
    }

    this.pending.delete(message.id);

    if ('error' in message && message.error) {
      const { code, message: msg, data } = message.error;
      const error = new JsonRpcError(code, msg, data);
      this.logger?.error(
        { error, method: pending.method },
        'JSON-RPC error response'
      );
      pending.reject(error);
    } else if ('result' in message) {
      this.logger?.debug(
        { id: message.id, method: pending.method },
        'JSON-RPC success response'
      );
      pending.resolve(message.result);
    }
  }

  /**
   * Handle JSON-RPC notification
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;

    // OPTIMIZATION #5: Lazy log evaluation
    lazyLog(this.logger, 'debug', () => ({ method, params }), 'Received notification');
    this.emit('notification', method, params);

    // Call registered handlers
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params);
        } catch (err) {
          this.logger?.error(
            { err, method },
            'Notification handler threw error'
          );
        }
      }
    }
  }

  private isRetryableMethod(method: string): boolean {
    const normalized = method.toLowerCase();
    if (this.unsafeMethods.has(normalized)) {
      return false;
    }
    return this.idempotentMethods.has(normalized);
  }

  private createRetryConfig(
    originalMethod: string,
    signal?: AbortSignal
  ): RetryConfig {
    const base = this.retryDefaults;
    const retryableErrors = [...base.retryableErrors];

    return {
      maxAttempts: base.maxAttempts,
      initialDelayMs: base.initialDelayMs,
      maxDelayMs: base.maxDelayMs,
      backoffMultiplier: base.backoffMultiplier,
      retryableErrors,
      jitter: base.jitter,
      signal,
      onRetry: ({ attempt, delayMs, error }) => {
        this.logger?.warn(
          {
            method: originalMethod,
            attempt,
            delay_ms: delayMs,
            error: error instanceof Error
              ? { name: error.name, message: error.message }
              : error,
          },
          'Retrying idempotent JSON-RPC call with backoff'
        );
      },
    };
  }

  private enrichError(
    error: unknown,
    method: string,
    attempts: number
  ): unknown {
    if (error instanceof CircuitBreakerOpenError) {
      const message = `Python runtime circuit open (method: ${method}, attempts: ${attempts}, state: ${error.state}, retryAfterMs: ${error.retryAfterMs})`;
      return new EngineClientError('TransportError', message, {
        method,
        attempts,
        retryAfterMs: error.retryAfterMs,
        circuitState: error.state,
        circuit: error.circuit,
      });
    }

    if (error instanceof Error) {
      error.message = `${error.message} (method: ${method}, attempts: ${attempts})`;
    }

    return error;
  }

  /**
   * Write message to stdin (with queuing for ordering)
   */
  private async write(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    // Chain writes to ensure order, with error propagation
    // Bug Fix #42: Use .then(success, failure) instead of .catch().then()
    // This ensures that if a write fails, all subsequent writes also fail,
    // preserving FIFO ordering guarantees and preventing message corruption.
    this.writeQueue = this.writeQueue.then(
      // Success path - previous write succeeded, proceed with current write
      async () => {
        if (this.closed) {
          throw new Error('Transport is closed');
        }

        const encoded = this.codec.encode(message);
        const line = encoded.toString('utf-8') + '\n';

      return new Promise<void>((resolve, reject) => {
        // We must wait for both the write callback and the `drain` event
        // when backpressure occurs. Resolving early allows subsequent writes
        // to overrun the buffer and drop data.
        let drainHandler: (() => void) | null = null;
        let errorHandler: ((err: Error) => void) | null = null;
        let closeHandler: (() => void) | null = null;
        let completed = false;
        let callbackDone = false;
        let drainSatisfied = false;
        let needsDrain = false;

        const cleanup = (): void => {
          if (drainHandler) {
            this.stdin.off('drain', drainHandler);
            drainHandler = null;
          }
          // Bug Fix #10: Clean up error and close handlers to prevent memory leak
          if (errorHandler) {
            this.stdin.off('error', errorHandler);
            errorHandler = null;
          }
          if (closeHandler) {
            this.stdin.off('close', closeHandler);
            closeHandler = null;
          }
        };

        const finish = (err?: Error | null): void => {
          if (completed) {
            return;
          }

          if (err) {
            completed = true;
            cleanup();
            const error = err instanceof Error ? err : new Error(String(err));
            reject(error);
            return;
          }

          if (callbackDone && (!needsDrain || drainSatisfied)) {
            completed = true;
            cleanup();
            resolve();
          }
        };

        const writeCallback = (err?: Error | null): void => {
          callbackDone = true;
          finish(err ?? undefined);
        };

        let canWrite: boolean;
        try {
          canWrite = this.stdin.write(line, 'utf-8', writeCallback);
        } catch (err) {
          cleanup();
          completed = true;
          const error = err instanceof Error ? err : new Error(String(err));
          reject(error);
          return;
        }

        needsDrain = !canWrite;
        if (!needsDrain) {
          drainSatisfied = true;
          finish();
          return;
        }

        this.logger?.debug('Stdin backpressure detected, waiting for drain');

        drainHandler = () => {
          this.logger?.debug('Stdin drained, ready for more writes');
          drainSatisfied = true;
          finish();
        };

        // Bug Fix #10: Handle stdin error/close during backpressure to prevent Promise hang
        // If stdin closes or errors while waiting for drain, we need to reject the Promise
        errorHandler = (err: Error) => {
          this.logger?.error({ err }, 'Stdin error during backpressure');
          finish(err);
        };

        closeHandler = () => {
          this.logger?.warn('Stdin closed during backpressure');
          finish(new Error('Stdin closed while waiting for drain'));
        };

        this.stdin.once('drain', drainHandler);
        this.stdin.once('error', errorHandler);
        this.stdin.once('close', closeHandler);
      });
      },
      // Failure path - previous write failed, propagate error to break chain
      // This prevents subsequent writes from executing, maintaining ordering
      async (err: Error) => {
        // Log the error for debugging
        try {
          this.logger?.error({ error: err }, 'Previous write failed, breaking write chain');
        } catch (logError) {
          // Fallback if logger throws - write to stderr directly
          console.error('[JsonRpcTransport] Logger error:', logError);
          console.error('[JsonRpcTransport] Original error:', err);
        }

        // Re-throw to break the chain - this is CRITICAL for ordering
        // Without this rethrow, subsequent writes would proceed even though
        // earlier writes failed, violating JSON-RPC ordering guarantees
        throw err;
      }
    );

    return this.writeQueue;
  }
}

/**
 * JSON-RPC Error
 */
export class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }

  /**
   * Check if error is a specific code
   */
  public is(code: JsonRpcErrorCode): boolean {
    return this.code === code;
  }
}
