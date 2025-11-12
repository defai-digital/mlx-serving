/**
 * OpsMultiplexer
 *
 * Aggregates high-frequency JSON-RPC requests into transport-level batches.
 * Groups operations by method + model, holds them briefly (1-4ms) and emits
 * batch_* envelopes to the Python runtime to minimize IPC chatter.
 *
 * Goals:
 *  - Achieve ~90% reduction in IPC calls under load
 *  - Preserve per-request semantics (error isolation, timeouts, aborts)
 *  - Provide instrumentation for batched vs solo dispatch statistics
 */

import type { Logger } from 'pino';
import { lazyLog } from '../utils/logger-helpers.js';
import type {
  TokenizeParams,
  TokenizeResponse,
  CheckDraftParams,
  CheckDraftResponse,
} from './serializers.js';

/**
 * Request priorities recognised by the multiplexer.
 * Matches the priority levels exposed by BatchQueue.
 */
export type RequestPriority = 'high' | 'normal' | 'low';

/**
 * Request options honoured by the multiplexer. Extends the transport request
 * options with a priority hint.
 */
export interface MultiplexerRequestOptions {
  timeout?: number;
  signal?: AbortSignal;
  priority?: RequestPriority;
}

/**
 * Result envelope returned by Python batch handlers.
 */
export interface BatchResult<T> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Dispatch signature used by the multiplexer to send RPC calls.
 */
export type MultiplexerDispatch = <T>(
  method: string,
  params?: unknown,
  options?: MultiplexerRequestOptions
) => Promise<T>;

/**
 * Statistics exposed for observability and testing.
 */
export interface MultiplexerStats {
  enqueued: number;
  batchesDispatched: number;
  batchedRequests: number;
  soloDispatches: number;
  soloRequests: number;
  flushReasons: {
    timer: number;
    maxSize: number;
    highPriority: number;
    manual: number;
  };
  averageBatchSize: number;
  averageQueueDelayMs: number;
}

/**
 * Configuration knobs for the multiplexer.
 */
export interface OpsMultiplexerConfig {
  enabled?: boolean;
  minHoldMs?: number;
  maxHoldMs?: number;
  minBatchSize?: number;
  maxBatchSize?: number;
  lowConcurrencyThreshold?: number;
  highConcurrencyThreshold?: number;
}

/**
 * Methods supported by the multiplexer and their batching behaviour.
 */
type MultiplexableMethod = 'tokenize' | 'check_draft';

interface BatchDefinition<P, R> {
  readonly method: MultiplexableMethod;
  readonly batchMethod: 'batch_tokenize' | 'batch_check_draft';
  readonly keyForParams: (params: P) => string;
  readonly buildEnvelope: (requests: P[]) => unknown;
  readonly extractResults: (response: unknown) => BatchResult<R>[];
}

/**
 * Queue entry tracked before dispatch.
 */
interface QueueEntry<P, R> {
  readonly method: MultiplexableMethod;
  readonly params: P;
  readonly resolve: (value: R) => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAt: number;
  readonly priority: RequestPriority;
  readonly options?: MultiplexerRequestOptions;
}

interface QueueBucket<P, R> {
  method: MultiplexableMethod;
  entries: QueueEntry<P, R>[];
}

const DEFAULT_CONFIG: Required<OpsMultiplexerConfig> = {
  enabled: true,
  minHoldMs: 1,
  maxHoldMs: 4,
  minBatchSize: 2,
  maxBatchSize: 24,
  lowConcurrencyThreshold: 1,
  highConcurrencyThreshold: 32,
};

// Union types for type-safe multiplexing without any
type AnyBatchDefinition =
  | BatchDefinition<TokenizeParams, TokenizeResponse>
  | BatchDefinition<CheckDraftParams, CheckDraftResponse>;

type AnyQueueEntry =
  | QueueEntry<TokenizeParams, TokenizeResponse>
  | QueueEntry<CheckDraftParams, CheckDraftResponse>;

const METHOD_DEFINITIONS: Record<MultiplexableMethod, AnyBatchDefinition> = {
  tokenize: {
    method: 'tokenize',
    batchMethod: 'batch_tokenize',
    keyForParams: (params: TokenizeParams) =>
      `${params.model_id ?? '__unknown__'}`,
    buildEnvelope: (requests: TokenizeParams[]) => ({ requests }),
    extractResults: (response: unknown): BatchResult<TokenizeResponse>[] => {
      const cast = response as { results?: BatchResult<TokenizeResponse>[] };
      if (!cast || !Array.isArray(cast.results)) {
        throw new Error('Invalid batch_tokenize response');
      }
      return cast.results;
    },
  },
  check_draft: {
    method: 'check_draft',
    batchMethod: 'batch_check_draft',
    keyForParams: (params: CheckDraftParams) =>
      `${params.primary_id ?? '__unknown__'}`,
    buildEnvelope: (requests: CheckDraftParams[]) => ({ requests }),
    extractResults: (response: unknown): BatchResult<CheckDraftResponse>[] => {
      const cast = response as { results?: BatchResult<CheckDraftResponse>[] };
      if (!cast || !Array.isArray(cast.results)) {
        throw new Error('Invalid batch_check_draft response');
      }
      return cast.results;
    },
  },
};

type AnyQueueBucket =
  | QueueBucket<TokenizeParams, TokenizeResponse>
  | QueueBucket<CheckDraftParams, CheckDraftResponse>;

/**
 * Transport-level operations multiplexer.
 */
export class OpsMultiplexer {
  private readonly dispatch: MultiplexerDispatch;
  private readonly logger?: Logger;
  private readonly config: Required<OpsMultiplexerConfig>;

  private readonly queues = new Map<string, AnyQueueBucket>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private inflightBatches = 0;
  private stats: MultiplexerStats = {
    enqueued: 0,
    batchesDispatched: 0,
    batchedRequests: 0,
    soloDispatches: 0,
    soloRequests: 0,
    flushReasons: {
      timer: 0,
      maxSize: 0,
      highPriority: 0,
      manual: 0,
    },
    averageBatchSize: 0,
    averageQueueDelayMs: 0,
  };

  constructor(options: { dispatch: MultiplexerDispatch; logger?: Logger } & OpsMultiplexerConfig) {
    this.dispatch = options.dispatch;
    this.logger = options.logger;
    this.config = {
      ...DEFAULT_CONFIG,
      enabled: options.enabled ?? DEFAULT_CONFIG.enabled,
      minHoldMs: options.minHoldMs ?? DEFAULT_CONFIG.minHoldMs,
      maxHoldMs: options.maxHoldMs ?? DEFAULT_CONFIG.maxHoldMs,
      minBatchSize: options.minBatchSize ?? DEFAULT_CONFIG.minBatchSize,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_CONFIG.maxBatchSize,
      lowConcurrencyThreshold:
        options.lowConcurrencyThreshold ?? DEFAULT_CONFIG.lowConcurrencyThreshold,
      highConcurrencyThreshold:
        options.highConcurrencyThreshold ?? DEFAULT_CONFIG.highConcurrencyThreshold,
    };
  }

  /**
   * Attempt to multiplex a request. Returns null when the method is not supported
   * and the caller should execute the request directly.
   */
  public request<T>(
    method: string,
    params?: unknown,
    options?: MultiplexerRequestOptions
  ): Promise<T> | null {
    if (!this.config.enabled) {
      return null;
    }

    if (!isMultiplexableMethod(method)) {
      return null;
    }

    const definition = METHOD_DEFINITIONS[method];
    if (!params || typeof params !== 'object') {
      this.stats.soloRequests++;
      return null;
    }

    if (options?.signal?.aborted) {
      return Promise.reject(new Error(`Request aborted: ${method}`)) as Promise<T>;
    }

    // Custom timeouts / signals are currently not multiplexed (avoid mixing semantics).
    if (options?.timeout !== undefined || options?.signal) {
      this.stats.soloRequests++;
      return null;
    }

    const priority: RequestPriority = options?.priority ?? 'normal';
    const key = this.makeQueueKey(definition, params as Record<string, unknown>);
    const bucket = this.queues.get(key) ?? {
      method,
      entries: [],
    };

    this.queues.set(key, bucket);
    this.stats.enqueued++;

    return new Promise<T>((resolve, reject) => {
      const entry: AnyQueueEntry = {
        method,
        params,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        priority,
        options,
      } as AnyQueueEntry;

      try {
        // Type assertion needed due to union type limitations
        (bucket.entries as AnyQueueEntry[]).push(entry);

        if (priority === 'high') {
          this.flushBucket(key, 'highPriority').catch((error) => {
            this.logger?.error({ err: error, method }, 'High priority flush failed');
          });
          return;
        }

        const targetSize = this.computeAdaptiveBatchSize();
        if (bucket.entries.length >= targetSize) {
          this.flushBucket(key, 'maxSize').catch((error) => {
            this.logger?.error({ err: error, method }, 'Max size flush failed');
          });
          return;
        }

        if (!this.timers.has(key)) {
          const delay = this.computeHoldDelay(priority);
          const timer = setTimeout(() => {
            this.flushBucket(key, 'timer').catch((error) => {
              this.logger?.error({ err: error, method }, 'Timer flush failed');
            });
          }, delay);
          this.timers.set(key, timer);
        }
      } catch (error) {
        // Cleanup timer on error (defensive - timer might have been created before error)
        const timer = this.timers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
        throw error; // Re-throw to reject Promise
      }
    });
  }

  /**
   * Force flush all queues (used during shutdown/testing).
   */
  public async flushAll(reason: 'manual' | 'timer' | 'highPriority' | 'maxSize' = 'manual'): Promise<void> {
    const flushes = Array.from(this.queues.keys()).map((key) => this.flushBucket(key, reason));
    await Promise.all(flushes);
  }

  /**
   * Retrieve instrumentation snapshot.
   */
  public getStats(): MultiplexerStats {
    return {
      ...this.stats,
      flushReasons: { ...this.stats.flushReasons },
    };
  }

  private async flushBucket(
    key: string,
    reason: 'timer' | 'maxSize' | 'highPriority' | 'manual'
  ): Promise<void> {
    const bucket = this.queues.get(key);
    if (!bucket || bucket.entries.length === 0) {
      this.clearTimer(key);
      return;
    }

    this.queues.delete(key);
    this.clearTimer(key);

    this.stats.flushReasons[reason]++;

    const { method, entries } = bucket;
    const definition = METHOD_DEFINITIONS[method];

    const activeEntries = entries.filter((entry) => {
      if (entry.options?.signal?.aborted) {
        queueMicrotask(() => {
          entry.reject(new Error(`Request aborted: ${method}`));
        });
        return false;
      }
      return true;
    });

    if (activeEntries.length === 0) {
      return;
    }

    if (activeEntries.length === 1) {
      this.dispatchSolo(activeEntries[0]);
      return;
    }

    // Type assertion needed due to union type limitations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.dispatchBatch(definition as any, activeEntries as any);
  }

  private dispatchSolo(entry: AnyQueueEntry): void {
    this.stats.soloDispatches++;
    this.stats.soloRequests++;

    const { method, params, resolve, reject, options } = entry;

    this.dispatch(method, params, options)
      .then((result) => {
        // Type assertion needed due to union type limitations
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve(result as any);
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        queueMicrotask(() => reject(error));
      });
  }

  private async dispatchBatch<P, R>(
    definition: BatchDefinition<P, R>,
    entries: QueueEntry<P, R>[]
  ): Promise<void> {
    const { batchMethod, buildEnvelope, extractResults, method } = definition;
    const batchStart = Date.now();
    const queueLatencies = entries.map((entry) => batchStart - entry.enqueuedAt);

    this.inflightBatches++;
    this.stats.batchesDispatched++;
    this.stats.batchedRequests += entries.length;

    lazyLog(this.logger, 'debug', () => ({
      method,
      batchMethod,
      size: entries.length,
    }), 'Dispatching transport batch');

    try {
      const payload = buildEnvelope(entries.map((entry) => entry.params));
      const options = withoutPriority(entries[0].options);
      const response = await this.dispatch(batchMethod, payload, options);
      const results = extractResults(response);

      if (results.length !== entries.length) {
        throw new Error(
          `Batch response length mismatch: expected ${entries.length}, received ${results.length}`
        );
      }

      results.forEach((result, index) => {
        const entry = entries[index];
        if (result.success && result.result !== undefined) {
          entry.resolve(result.result);
        } else {
          const error = new Error(result.error ?? `Unknown ${batchMethod} error`);
          queueMicrotask(() => entry.reject(error));
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger?.error({ err: error, method }, 'Batch dispatch failed');
      for (const entry of entries) {
        queueMicrotask(() => entry.reject(error));
      }
    } finally {
      const _latency = Date.now() - batchStart;
      this.updateAverages(entries.length, queueLatencies);
      this.inflightBatches = Math.max(0, this.inflightBatches - 1);
    }
  }

  private updateAverages(
    batchSize: number,
    queueLatencies: number[]
  ): void {
    const completedBatches = this.stats.batchesDispatched;
    const totalBatches = completedBatches === 0 ? 1 : completedBatches;

    this.stats.averageBatchSize =
      ((totalBatches - 1) * this.stats.averageBatchSize + batchSize) / totalBatches;

    // Defensive: Guard against empty queueLatencies array
    if (queueLatencies.length === 0) {
      return;
    }

    const queueDelay =
      queueLatencies.reduce((acc, latency) => acc + Math.max(latency, 0), 0) /
      queueLatencies.length;

    this.stats.averageQueueDelayMs =
      ((totalBatches - 1) * this.stats.averageQueueDelayMs + queueDelay) / totalBatches;
  }

  private computeHoldDelay(priority: RequestPriority): number {
    if (priority === 'low') {
      return this.config.maxHoldMs;
    }
    if (priority === 'high') {
      return this.config.minHoldMs;
    }

    if (this.inflightBatches >= this.config.highConcurrencyThreshold) {
      return this.config.minHoldMs;
    }

    if (this.inflightBatches <= this.config.lowConcurrencyThreshold) {
      return this.config.maxHoldMs;
    }

    const range = this.config.maxHoldMs - this.config.minHoldMs;
    const ratio =
      (this.inflightBatches - this.config.lowConcurrencyThreshold) /
      (this.config.highConcurrencyThreshold - this.config.lowConcurrencyThreshold);

    return Math.max(
      this.config.minHoldMs,
      Math.min(this.config.maxHoldMs, this.config.maxHoldMs - ratio * range)
    );
  }

  private computeAdaptiveBatchSize(): number {
    if (this.inflightBatches >= this.config.highConcurrencyThreshold) {
      return this.config.maxBatchSize;
    }

    if (this.inflightBatches <= this.config.lowConcurrencyThreshold) {
      return this.config.minBatchSize;
    }

    const range = this.config.maxBatchSize - this.config.minBatchSize;
    const ratio =
      (this.inflightBatches - this.config.lowConcurrencyThreshold) /
      (this.config.highConcurrencyThreshold - this.config.lowConcurrencyThreshold);

    return Math.max(
      this.config.minBatchSize,
      Math.min(
        this.config.maxBatchSize,
        Math.round(this.config.minBatchSize + ratio * range)
      )
    );
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private makeQueueKey(
    definition: AnyBatchDefinition,
    params: Record<string, unknown>
  ): string {
    // Type assertion needed due to union type limitations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelKey = definition.keyForParams(params as any);
    return `${definition.method}:${modelKey}`;
  }
}

function isMultiplexableMethod(method: string): method is MultiplexableMethod {
  return method === 'tokenize' || method === 'check_draft';
}

function withoutPriority(
  options?: MultiplexerRequestOptions
): MultiplexerRequestOptions | undefined {
  if (!options) {
    return undefined;
  }

  const { priority: _priority, ...rest } = options;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
