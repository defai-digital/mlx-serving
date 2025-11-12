/**
 * GenerateBatcher
 *
 * Implements adaptive batching for `generate` requests with priority awareness,
 * StreamRegistry integration, and telemetry hooks. Mirrors the architecture
 * described in `generate-request-batching-architecture-v1-2-0.md`.
 *
 * Responsibilities:
 * - Queue requests by execution partition (model, draft, guidance mode)
 * - Honour per-request priority and AbortSignal
 * - Dispatch JSON-RPC `batch_generate` envelopes with adaptive sizing
 * - Coordinate with StreamRegistry backpressure signals
 * - Expose batching statistics for observability
 */

import { safeAverage } from '@/utils/math-helpers.js';
import type { Logger } from 'pino';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';
import type { StreamRegistry, AggregateMetrics } from '../bridge/stream-registry.js';
import type { GenerateParams, GenerateResponse } from '../bridge/serializers.js';
import type { TelemetryHooks } from '../types/engine.js';

export type GeneratePriority = 'urgent' | 'default' | 'background';

/**
 * Internal shape for batched generate requests.
 */
export type BatchedGenerateParams = GenerateParams & { stream_id: string };

/**
 * Telemetry payload emitted when a batch is dispatched.
 */
export interface GenerateBatchDispatchEvent {
  partitionKey: string;
  batchSize: number;
  durationMs: number;
  queueWaitAvgMs: number;
  queueWaitP95Ms: number;
  priorityMix: Record<GeneratePriority, number>;
  targetBatchSize: number;
  activeStreams: number;
}

/**
 * Additional telemetry hooks recognised by the generate batcher.
 */
export interface GenerateBatchTelemetryHooks extends TelemetryHooks {
  onBatchDispatched?: (event: GenerateBatchDispatchEvent) => void;
}

/**
 * Configuration knobs for the generate batcher.
 */
export interface GenerateBatcherConfig {
  enabled?: boolean;
  minBatchSize?: number;
  maxBatchSize?: number;
  minHoldMs?: number;
  maxHoldMs?: number;
  backgroundHoldExtensionMs?: number;
  targetBatchTimeMs?: number;
  pauseOnBackpressureMs?: number;
  logger?: Logger;
}

/**
 * Options for individual enqueue calls.
 */
export interface GenerateBatchOptions {
  priority?: GeneratePriority;
  signal?: AbortSignal;
  timeoutMs?: number;
  telemetry?: {
    requestId?: string;
  };
}

interface QueueEntry {
  params: BatchedGenerateParams;
  resolve: (value: GenerateResponse) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  priority: GeneratePriority;
  timeoutMs?: number;
  telemetry?: { requestId?: string };
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface PartitionMetrics {
  dispatchDurations: number[];
  batchSizes: number[];
  queueLatencies: number[];
  activeSnapshots: number[];
  lastDispatchDuration?: number;
  lastBatchSize?: number;
}

interface PartitionState {
  urgent: QueueEntry[];
  default: QueueEntry[];
  background: QueueEntry[];
  timer?: NodeJS.Timeout;
  holdStart?: number;
  pendingDispatch?: boolean;
  flushing?: boolean;
  targetBatchSize: number;
  metrics: PartitionMetrics;
}

interface EntryLookupValue {
  partitionKey: string;
  entry: QueueEntry;
  priority: GeneratePriority;
}

interface PartitionStatSnapshot {
  key: string;
  pending: number;
  pendingByPriority: Record<GeneratePriority, number>;
  targetBatchSize: number;
  timerActive: boolean;
  lastDispatchDuration?: number;
  lastBatchSize?: number;
  avgBatchSize: number;
  p95QueueLatency: number;
}

export interface GenerateBatcherStats {
  enabled: boolean;
  totalPartitions: number;
  totalQueued: number;
  totalBatches: number;
  totalRequests: number;
  enqueuedByPriority: Record<GeneratePriority, number>;
  urgentFlushes: number;
  promotedBackground: number;
  abortedRequests: number;
  transportErrors: number;
  backpressurePauses: number;
  partitions: PartitionStatSnapshot[];
}

const DEFAULT_CONFIG: Required<Omit<GenerateBatcherConfig, 'logger'>> = {
  enabled: true,
  minBatchSize: 2,
  maxBatchSize: 16,
  minHoldMs: 0.75,
  maxHoldMs: 3,
  backgroundHoldExtensionMs: 2,
  targetBatchTimeMs: 12,
  pauseOnBackpressureMs: 20,
};

const MAX_SAMPLE_WINDOW = 100;
const ABORT_ERROR_MESSAGE = 'Generate request aborted';

/**
 * Calculates a percentile from an array of numbers.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Compute a rolling average for instrumentation.
 */
function average(values: number[]): number {
  return safeAverage(values);
}

/**
 * Generate request batcher implementation.
 */
export class GenerateBatcher {
  private readonly transport: JsonRpcTransport;
  private readonly streamRegistry: StreamRegistry;
  private readonly logger?: Logger;
  private readonly telemetry?: GenerateBatchTelemetryHooks;
  private readonly config: Required<Omit<GenerateBatcherConfig, 'logger'>>;
  private readonly enabled: boolean;

  private readonly partitions = new Map<string, PartitionState>();
  private readonly entryLookup = new Map<string, EntryLookupValue>();

  private stats = {
    totalBatches: 0,
    totalRequests: 0,
    enqueuedByPriority: {
      urgent: 0,
      default: 0,
      background: 0,
    } as Record<GeneratePriority, number>,
    urgentFlushes: 0,
    promotedBackground: 0,
    aborted: 0,
    transportErrors: 0,
    backpressurePauses: 0,
  };

  private backpressureUntil = 0;
  private readonly backpressureHandler: (streamId: string) => void;
  private readonly slowConsumerHandler: (streamId: string, blockedMs: number) => void;

  constructor(
    transport: JsonRpcTransport,
    streamRegistry: StreamRegistry,
    options: GenerateBatcherConfig & { telemetry?: GenerateBatchTelemetryHooks } = {}
  ) {
    this.transport = transport;
    this.streamRegistry = streamRegistry;
    this.logger = options.logger;
    this.telemetry = options.telemetry;

    const merged = {
      ...DEFAULT_CONFIG,
      ...options,
    };

    this.config = {
      enabled: merged.enabled,
      minBatchSize: Math.max(1, Math.floor(merged.minBatchSize)),
      maxBatchSize: Math.max(2, Math.floor(merged.maxBatchSize)),
      minHoldMs: merged.minHoldMs,
      maxHoldMs: merged.maxHoldMs,
      backgroundHoldExtensionMs: merged.backgroundHoldExtensionMs,
      targetBatchTimeMs: merged.targetBatchTimeMs,
      pauseOnBackpressureMs: merged.pauseOnBackpressureMs,
    };

    const disabledEnv = process.env.KR_MLX_DISABLE_GENERATE_BATCHING;
    const disabledViaEnv =
      disabledEnv === '1' || disabledEnv === 'true' || disabledEnv === 'TRUE';
    this.enabled = this.config.enabled && !disabledViaEnv;

    this.logger?.info(
      {
        enabled: this.enabled,
        minBatchSize: this.config.minBatchSize,
        maxBatchSize: this.config.maxBatchSize,
        minHoldMs: this.config.minHoldMs,
        maxHoldMs: this.config.maxHoldMs,
        backgroundHoldExtensionMs: this.config.backgroundHoldExtensionMs,
        targetBatchTimeMs: this.config.targetBatchTimeMs,
        pauseOnBackpressureMs: this.config.pauseOnBackpressureMs,
        disabledEnv: disabledViaEnv,
      },
      'GenerateBatcher initialized'
    );

    this.backpressureHandler = () => {
      this.handleBackpressure();
    };
    this.slowConsumerHandler = () => {
      this.handleBackpressure();
    };

    this.streamRegistry.on('backpressure', this.backpressureHandler);
    this.streamRegistry.on('slowConsumer', this.slowConsumerHandler);
  }

  /**
   * Enqueue a generate request for potential batching.
   */
  public enqueue(
    params: BatchedGenerateParams,
    options: GenerateBatchOptions = {}
  ): Promise<GenerateResponse> {
    if (!this.enabled || this.config.maxBatchSize <= 1) {
      return this.transport.request<GenerateResponse>('generate', params, {
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    }

    if (!params.stream_id) {
      return Promise.reject(new Error('GenerateBatcher requires stream_id on params'));
    }

    const priority = options.priority ?? 'default';
    const now = Date.now();
    const entry: QueueEntry = {
      params,
      resolve: () => {},
      reject: () => {},
      enqueuedAt: now,
      priority,
      timeoutMs: options.timeoutMs,
      telemetry: options.telemetry,
      signal: options.signal,
    };

    if (options.signal?.aborted) {
      const abortError = new Error(ABORT_ERROR_MESSAGE);
      abortError.name = 'AbortError';
      this.streamRegistry.cancel(params.stream_id);
      return Promise.reject(abortError);
    }

    const partitionKey = this.buildPartitionKey(params);
    const state = this.getOrCreatePartition(partitionKey);

    return new Promise<GenerateResponse>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;

      const abortHandler = (): void => {
        this.handleAbort(partitionKey, entry);
      };
      entry.abortHandler = abortHandler;

      if (entry.signal) {
        entry.signal.addEventListener('abort', abortHandler);
      }

      this.pushToQueue(partitionKey, state, entry);
      this.entryLookup.set(params.stream_id, {
        partitionKey,
        entry,
        priority,
      });
      this.stats.enqueuedByPriority[priority] += 1;

      this.scheduleDispatch(partitionKey, state);
    });
  }

  /**
   * Flush queued requests across all partitions.
   */
  public async flush(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const [key, state] of this.partitions.entries()) {
      if (this.getQueueSize(state) === 0) {
        continue;
      }
      tasks.push(this.dispatchPartition(key, state));
    }
    await Promise.all(tasks);
  }

  /**
   * Cleanup timers and event listeners.
   */
  public cleanup(): void {
    for (const state of this.partitions.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
    this.partitions.clear();
    this.entryLookup.clear();
    this.streamRegistry.off('backpressure', this.backpressureHandler);
    this.streamRegistry.off('slowConsumer', this.slowConsumerHandler);
  }

  /**
   * Retrieve batching statistics for observability.
   */
  public getStats(): GenerateBatcherStats {
    const partitions: PartitionStatSnapshot[] = [];
    let totalQueued = 0;

    for (const [key, state] of this.partitions.entries()) {
      const urgent = state.urgent.length;
      const normal = state.default.length;
      const background = state.background.length;
      const queued = urgent + normal + background;
      totalQueued += queued;

      partitions.push({
        key,
        pending: queued,
        pendingByPriority: {
          urgent,
          default: normal,
          background,
        },
        targetBatchSize: state.targetBatchSize,
        timerActive: Boolean(state.timer),
        lastDispatchDuration: state.metrics.lastDispatchDuration,
        lastBatchSize: state.metrics.lastBatchSize,
        avgBatchSize: average(state.metrics.batchSizes),
        p95QueueLatency: percentile(state.metrics.queueLatencies, 95),
      });
    }

    return {
      enabled: this.enabled,
      totalPartitions: this.partitions.size,
      totalQueued,
      totalBatches: this.stats.totalBatches,
      totalRequests: this.stats.totalRequests,
      enqueuedByPriority: { ...this.stats.enqueuedByPriority },
      urgentFlushes: this.stats.urgentFlushes,
      promotedBackground: this.stats.promotedBackground,
      abortedRequests: this.stats.aborted,
      transportErrors: this.stats.transportErrors,
      backpressurePauses: this.stats.backpressurePauses,
      partitions,
    };
  }

  /**
   * Push a queue entry to its priority bucket.
   */
  private pushToQueue(
    partitionKey: string,
    state: PartitionState,
    entry: QueueEntry
  ): void {
    if (entry.priority === 'urgent') {
      state.urgent.push(entry);
    } else if (entry.priority === 'default') {
      state.default.push(entry);
    } else {
      state.background.push(entry);
    }

    if (!state.holdStart) {
      state.holdStart = entry.enqueuedAt;
    }

    this.logger?.debug(
      {
        streamId: entry.params.stream_id,
        partitionKey,
        priority: entry.priority,
        partitionSize: this.getQueueSize(state),
      },
      'Generate request enqueued'
    );
  }

  /**
   * Handle AbortSignal before dispatch occurs.
   */
  private handleAbort(partitionKey: string, entry: QueueEntry): void {
    const streamId = entry.params.stream_id;
    const lookup = this.entryLookup.get(streamId);
    if (!lookup) {
      return;
    }

    const state = this.partitions.get(lookup.partitionKey);
    if (!state) {
      return;
    }

    const removed = this.removeEntryFromQueue(state, entry);
    if (!removed) {
      return;
    }

    this.entryLookup.delete(streamId);
    if (entry.abortHandler && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }

    const abortError = new Error(ABORT_ERROR_MESSAGE);
    abortError.name = 'AbortError';
    queueMicrotask(() => entry.reject(abortError));
    this.streamRegistry.cancel(streamId);
    this.stats.aborted += 1;

    this.logger?.warn(
      {
        streamId,
        partitionKey,
        priority: entry.priority,
      },
      'Generate request aborted before dispatch'
    );

    if (this.getQueueSize(state) === 0) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.holdStart = undefined;
    }
  }

  /**
   * Attempt to remove an entry from its priority queue.
   */
  private removeEntryFromQueue(state: PartitionState, entry: QueueEntry): boolean {
    const queues: Array<{ items: QueueEntry[] }> = [
      { items: state.urgent },
      { items: state.default },
      { items: state.background },
    ];

    for (const queue of queues) {
      const index = queue.items.indexOf(entry);
      if (index !== -1) {
        queue.items.splice(index, 1);
        return true;
      }
    }

    return false;
  }

  /**
   * Schedule dispatch for a partition based on timers and thresholds.
   */
  private scheduleDispatch(partitionKey: string, state: PartitionState): void {
    if (state.pendingDispatch || state.flushing) {
      return;
    }

    const totalQueued = this.getQueueSize(state);
    if (totalQueued === 0) {
      return;
    }

    if (state.urgent.length > 0) {
      state.pendingDispatch = true;
      this.stats.urgentFlushes += 1;
      queueMicrotask(() => {
        void this.dispatchPartition(partitionKey, state);
      });
      return;
    }

    const now = Date.now();
    state.holdStart = state.holdStart ?? now;
    const elapsed = now - state.holdStart;
    const targetSize = this.calculateTargetSize(state);

    if (totalQueued >= targetSize) {
      state.pendingDispatch = true;
      queueMicrotask(() => {
        void this.dispatchPartition(partitionKey, state);
      });
      return;
    }

    const hasDefault = state.default.length > 0;
    const minHold = hasDefault ? this.config.minHoldMs : this.config.minHoldMs;
    const maxHold = hasDefault
      ? this.config.maxHoldMs
      : this.config.maxHoldMs + this.config.backgroundHoldExtensionMs;

    if (elapsed >= maxHold) {
      state.pendingDispatch = true;
      queueMicrotask(() => {
        void this.dispatchPartition(partitionKey, state);
      });
      return;
    }

    const waitUntil =
      elapsed < minHold ? minHold - elapsed : Math.max(0, maxHold - elapsed);

    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.scheduleDispatch(partitionKey, state);
    }, Math.max(0, Math.ceil(waitUntil)));
  }

  /**
   * Dispatch a partition queue respecting priority and adaptive sizing.
   */
  private async dispatchPartition(
    partitionKey: string,
    state: PartitionState
  ): Promise<void> {
    if (state.flushing) {
      return;
    }

    state.pendingDispatch = false;

    const totalQueued = this.getQueueSize(state);
    if (totalQueued === 0) {
      state.holdStart = undefined;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      return;
    }

    const now = Date.now();
    const targetSize = this.calculateTargetSize(state);
    const batchLimit = Math.min(targetSize, this.config.maxBatchSize, totalQueued);

    const aggregateMetrics = this.safeGetAggregateMetrics();
    const streamLimit = aggregateMetrics?.currentLimit ?? Infinity;
    const activeStreams = aggregateMetrics?.activeStreams ?? this.streamRegistry.getActiveCount();
    const availableCapacity = Number.isFinite(streamLimit)
      ? Math.max(streamLimit - activeStreams, 1)
      : batchLimit;

    const effectiveBatchSize = Math.max(1, Math.min(batchLimit, availableCapacity));
    const entries = this.collectEntries(state, effectiveBatchSize);

    if (entries.length === 0) {
      state.holdStart = undefined;
      return;
    }

    state.flushing = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.holdStart = undefined;

    const pausedDuration = this.backpressureUntil - Date.now();
    if (pausedDuration > 0) {
      this.logger?.debug(
        {
          partitionKey,
          delayMs: pausedDuration,
        },
        'Delaying batch dispatch due to backpressure'
      );
      this.stats.backpressurePauses += 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pausedDuration);
      });
    }

    const queueLatencies = entries.map((entry) => now - entry.enqueuedAt);
    const priorityMix: Record<GeneratePriority, number> = {
      urgent: 0,
      default: 0,
      background: 0,
    };
    for (const entry of entries) {
      if (entry.abortHandler && entry.signal) {
        entry.signal.removeEventListener('abort', entry.abortHandler);
      }
      priorityMix[entry.priority] += 1;
      this.entryLookup.delete(entry.params.stream_id);
    }

    const batchEnvelope = {
      requests: entries.map((entry) => entry.params),
    };

    const batchStart = Date.now();
    try {
      const timeout = entries.reduce<number | undefined>((acc, entry) => {
        if (entry.timeoutMs === undefined) {
          return acc;
        }
        return acc === undefined ? entry.timeoutMs : Math.max(acc, entry.timeoutMs);
      }, undefined);

      const response = await this.transport.request<{
        results: Array<{
          success: boolean;
          result?: GenerateResponse | null;
          error?: string | null;
        }>;
      }>('batch_generate', batchEnvelope, {
        timeout,
      });

      const duration = Date.now() - batchStart;
      state.metrics.lastDispatchDuration = duration;
      state.metrics.lastBatchSize = entries.length;
      this.recordMetrics(state, duration, entries.length, queueLatencies, activeStreams);

      if (response.results.length !== entries.length) {
        throw new Error(
          `Batch response length mismatch: expected ${entries.length}, received ${response.results.length}`
        );
      }

      for (let i = 0; i < entries.length; i += 1) {
        const result = response.results[i];
        const entry = entries[i];
        if (result.success && result.result) {
          queueMicrotask(() => entry.resolve(result.result as GenerateResponse));
        } else {
          const error = new Error(result.error || 'Batch generate request failed');
          queueMicrotask(() => entry.reject(error));
        }
      }

      this.stats.totalBatches += 1;
      this.stats.totalRequests += entries.length;

      this.telemetry?.onBatchDispatched?.({
        partitionKey,
        batchSize: entries.length,
        durationMs: duration,
        queueWaitAvgMs: average(queueLatencies),
        queueWaitP95Ms: percentile(queueLatencies, 95),
        priorityMix,
        targetBatchSize: state.targetBatchSize,
        activeStreams,
      });

      this.logger?.debug(
        {
          partitionKey,
          batchSize: entries.length,
          duration,
          priorityMix,
          activeStreams,
          targetSize: state.targetBatchSize,
        },
        'batch_generate dispatched'
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.stats.transportErrors += 1;

      this.logger?.error(
        {
          partitionKey,
          batchSize: entries.length,
          error: error.message,
        },
        'batch_generate dispatch failed'
      );

      for (const entry of entries) {
        queueMicrotask(() => entry.reject(error));
      }
    } finally {
      state.flushing = false;

      if (this.getQueueSize(state) > 0) {
        state.holdStart = Date.now();
        this.scheduleDispatch(partitionKey, state);
      }
    }
  }

  /**
   * Collect entries from queues based on priority order.
   */
  private collectEntries(state: PartitionState, maxEntries: number): QueueEntry[] {
    const selected: QueueEntry[] = [];

    const consume = (queue: QueueEntry[]): void => {
      while (queue.length > 0 && selected.length < maxEntries) {
        const entry = queue.shift();
        if (entry) {
          selected.push(entry);
        }
      }
    };

    consume(state.urgent);
    const beforeDefault = selected.length;
    consume(state.default);
    const afterDefault = selected.length;
    if (state.urgent.length > 0 || afterDefault > beforeDefault) {
      const backgroundBefore = selected.length;
      consume(state.background);
      if (selected.length > backgroundBefore) {
        this.stats.promotedBackground += selected.length - backgroundBefore;
      }
    } else {
      consume(state.background);
    }

    return selected;
  }

  /**
   * Record batch metrics and maintain rolling window.
   */
  private recordMetrics(
    state: PartitionState,
    dispatchDuration: number,
    batchSize: number,
    queueLatencies: number[],
    activeStreams: number
  ): void {
    const metrics = state.metrics;

    metrics.dispatchDurations.push(dispatchDuration);
    metrics.batchSizes.push(batchSize);
    metrics.queueLatencies.push(...queueLatencies);
    metrics.activeSnapshots.push(activeStreams);

    if (metrics.dispatchDurations.length > MAX_SAMPLE_WINDOW) {
      metrics.dispatchDurations.splice(0, metrics.dispatchDurations.length - MAX_SAMPLE_WINDOW);
    }
    if (metrics.batchSizes.length > MAX_SAMPLE_WINDOW) {
      metrics.batchSizes.splice(0, metrics.batchSizes.length - MAX_SAMPLE_WINDOW);
    }
    const maxQueueSamples = MAX_SAMPLE_WINDOW * this.config.maxBatchSize;
    if (metrics.queueLatencies.length > maxQueueSamples) {
      metrics.queueLatencies.splice(0, metrics.queueLatencies.length - maxQueueSamples);
    }
    if (metrics.activeSnapshots.length > MAX_SAMPLE_WINDOW) {
      metrics.activeSnapshots.splice(0, metrics.activeSnapshots.length - MAX_SAMPLE_WINDOW);
    }

    this.adjustTargetSize(state);
  }

  /**
   * Adaptive target size computation following architecture spec.
   */
  private adjustTargetSize(state: PartitionState): void {
    const metrics = state.metrics;
    if (metrics.dispatchDurations.length === 0) {
      return;
    }

    const p50Dispatch = percentile(metrics.dispatchDurations, 50);
    const p95Queue = percentile(metrics.queueLatencies, 95);
    const avgActive =
      metrics.activeSnapshots.length > 0 ? average(metrics.activeSnapshots) : 0;

    const aggregateMetrics = this.safeGetAggregateMetrics();
    const streamLimit = aggregateMetrics?.currentLimit ?? Infinity;
    const threshold = Number.isFinite(streamLimit) ? streamLimit * 0.8 : Infinity;

    let newTarget = state.targetBatchSize;

    if (
      p95Queue < 1.5 &&
      p50Dispatch < this.config.targetBatchTimeMs &&
      avgActive < threshold
    ) {
      newTarget = Math.min(
        this.config.maxBatchSize,
        state.targetBatchSize + 2
      );
    } else if (
      p95Queue > 4 ||
      p50Dispatch > this.config.targetBatchTimeMs * 1.3
    ) {
      newTarget = Math.max(this.config.minBatchSize, Math.floor(state.targetBatchSize / 2));
    }

    if (newTarget !== state.targetBatchSize) {
      this.logger?.debug(
        {
          previous: state.targetBatchSize,
          next: newTarget,
          p95Queue,
          p50Dispatch,
          avgActive,
        },
        'Adjusting generate batch target size'
      );
      state.targetBatchSize = newTarget;
    }
  }

  /**
   * Return the current target size for scheduling.
   */
  private calculateTargetSize(state: PartitionState): number {
    return Math.max(this.config.minBatchSize, Math.min(state.targetBatchSize, this.config.maxBatchSize));
  }

  /**
   * Build partition key using model, draft, and guidance mode.
   */
  private buildPartitionKey(params: BatchedGenerateParams): string {
    const guidanceMode = params.guidance?.mode ?? 'none';
    const draftModel = params.draft_model ?? 'none';
    return `${params.model_id}::${draftModel}::${guidanceMode}`;
  }

  /**
   * Retrieve or initialise partition state.
   */
  private getOrCreatePartition(partitionKey: string): PartitionState {
    let state = this.partitions.get(partitionKey);
    if (state) {
      return state;
    }

    state = {
      urgent: [],
      default: [],
      background: [],
      targetBatchSize: this.config.minBatchSize,
      metrics: {
        dispatchDurations: [],
        batchSizes: [],
        queueLatencies: [],
        activeSnapshots: [],
      },
    };

    this.partitions.set(partitionKey, state);
    return state;
  }

  /**
   * Compute total queue size for partition.
   */
  private getQueueSize(state: PartitionState): number {
    return state.urgent.length + state.default.length + state.background.length;
  }

  /**
   * Handle backpressure notifications by pausing dispatch briefly.
   */
  private handleBackpressure(): void {
    this.backpressureUntil = Date.now() + this.config.pauseOnBackpressureMs;
  }

  /**
   * Safely fetch aggregate metrics when available.
   */
  private safeGetAggregateMetrics(): AggregateMetrics | undefined {
    try {
      return this.streamRegistry.getAggregateMetrics?.();
    } catch (error) {
      this.logger?.trace(
        { error },
        'Failed to obtain aggregate metrics from StreamRegistry'
      );
      return undefined;
    }
  }
}

