/**
 * Stream Registry
 *
 * Manages active streaming operations with full lifecycle control.
 * Replaces the temporary StreamingDispatcher with production-ready features.
 *
 * Responsibilities:
 * - Register and track active streams
 * - Route streaming notifications (chunk, stats, event) to handlers
 * - Support stream cancellation via AbortSignal
 * - Handle stream cleanup and timeout
 * - Emit TypeScript-friendly events
 * - Manage backpressure for high-throughput streams
 *
 * Architecture:
 * - StreamHandle: Per-stream state tracking
 * - Event-based notification routing
 * - Promise-based stream completion
 * - Graceful cleanup on errors/timeout
 */

import { safeAverage, safeDivide } from '@/utils/math-helpers.js';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { getConfig } from '../config/loader.js';
import type { Config } from '../config/loader.js';
import { AdaptiveGovernor } from '../streaming/governor/AdaptiveGovernor.js';
import { CleanupScheduler } from '../streaming/governor/CleanupScheduler.js';
import type { StreamCleanupEvent, StreamGovernorConfig } from '../streaming/governor/types.js';
import { ModelConcurrencyLimiter } from '../core/model-concurrency-limiter.js';
import type {
  StreamChunkNotification,
  StreamStatsNotification,
  StreamEventNotification,
} from './serializers.js';

type StreamChunkParams = StreamChunkNotification['params'];
type StreamStatsParams = StreamStatsNotification['params'];
type StreamEventParams = StreamEventNotification['params'];

/**
 * Stream chunk emitted to consumers
 */
export interface StreamChunk {
  streamId: string;
  token: string;
  tokenId: number;
  logprob?: number;
  isFinal: boolean;
  cumulativeText?: string; // P1-2: Full text generated so far (mlx-engine compat)
}

/**
 * Stream statistics (emitted once at end)
 */
export interface StreamStats {
  streamId: string;
  tokensGenerated: number;
  tokensPerSecond: number;
  timeToFirstToken: number;
  totalTime: number;
}

/**
 * Stream event (completion or error)
 */
export interface StreamEvent {
  streamId: string;
  event: 'completed' | 'error';
  finishReason?: string;
  error?: string;
  isFinal: boolean;
}

/**
 * Stream handle for tracking individual streams
 */
interface StreamHandle {
  streamId: string;
  startedAt: number;
  timeout: number; // Actual timeout value used for this stream
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeoutHandle?: NodeJS.Timeout;
  chunkCount: number;
  stats?: StreamStats;
  completed: boolean;
  resolve: (stats: StreamStats) => void;
  reject: (error: Error) => void;
  // Phase 4: Stream Optimization
  firstTokenAt?: number; // Timestamp of first token (for TTFT)
  lastChunkAt?: number; // Timestamp of last chunk (for throughput)
  unackedChunks: number; // Count of unacked chunks (for backpressure)
  blockedSince?: number; // Timestamp when stream was blocked
  metricsExported: boolean; // Whether metrics have been exported
  // Phase 5 Week 3: Concurrency limiting
  modelId?: string; // Model ID for concurrency slot release
}

/**
 * Events emitted by StreamRegistry
 */
export interface StreamRegistryEvents {
  chunk: (chunk: StreamChunk) => void;
  stats: (stats: StreamStats) => void;
  completed: (streamId: string, stats: StreamStats) => void;
  error: (streamId: string, error: string) => void;
  timeout: (streamId: string) => void;
  // Phase 4: Stream Optimization events
  backpressure: (streamId: string, unackedChunks: number) => void;
  slowConsumer: (streamId: string, blockedMs: number) => void;
  metricsExport: (metrics: AggregateMetrics) => void;
}

/**
 * Aggregate metrics for all streams (Phase 4)
 */
export interface AggregateMetrics {
  timestamp: number;
  activeStreams: number;
  totalStreams: number;
  completedStreams: number;
  cancelledStreams: number;
  averageTTFT: number;
  averageThroughput: number;
  currentLimit: number;
  utilizationRate: number;
}

/**
 * Stream Registry Options
 */
export interface StreamRegistryOptions {
  logger?: Logger;
  defaultTimeout?: number; // milliseconds (default: 300000 = 5 minutes)
  maxActiveStreams?: number; // default: 10
}

/**
 * Chunk Pool - Object pool for StreamChunk reuse (Phase 4)
 * Reduces GC pressure by reusing chunk objects
 */
class ChunkPool {
  private pool: StreamChunk[] = [];
  private readonly maxSize: number;
  private createdCount = 0;
  private reusedCount = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /**
   * Acquire a chunk from the pool (or create new)
   */
  acquire(
    streamId: string,
    token: string,
    tokenId: number,
    isFinal: boolean,
    logprob?: number,
    cumulativeText?: string
  ): StreamChunk {
    let chunk = this.pool.pop();

    if (chunk) {
      // Reuse existing chunk
      chunk.streamId = streamId;
      chunk.token = token;
      chunk.tokenId = tokenId;
      chunk.isFinal = isFinal;
      chunk.logprob = logprob;
      chunk.cumulativeText = cumulativeText;
      this.reusedCount++;
    } else {
      // Create new chunk
      chunk = {
        streamId,
        token,
        tokenId,
        isFinal,
        logprob,
        cumulativeText,
      };
      this.createdCount++;
    }

    return chunk;
  }

  /**
   * Release a chunk back to the pool
   */
  release(chunk: StreamChunk): void {
    if (this.pool.length < this.maxSize) {
      // Clear optional fields to avoid memory leaks
      chunk.logprob = undefined;
      chunk.cumulativeText = undefined;
      this.pool.push(chunk);
    }
  }

  /**
   * Clear the pool (for periodic cleanup)
   */
  clear(): void {
    this.pool = [];
  }

  /**
   * Get pool statistics
   */
  getStats(): { size: number; created: number; reused: number; reuseRate: number } {
    const total = this.createdCount + this.reusedCount;
    return {
      size: this.pool.length,
      created: this.createdCount,
      reused: this.reusedCount,
      reuseRate: total > 0 ? this.reusedCount / total : 0,
    };
  }
}

/**
 * StreamRegistry - Production stream coordination
 *
 * Manages the lifecycle of streaming operations from Python runtime.
 */
export class StreamRegistry extends EventEmitter<StreamRegistryEvents> {
  private streams = new Map<string, StreamHandle>();
  private logger?: Logger;
  private defaultTimeout: number;
  private maxActiveStreams: number;

  // Phase 4: Stream Optimization
  private chunkPool?: ChunkPool;
  private currentStreamLimit: number;
  private readonly minStreamLimit: number;
  private readonly maxStreamLimit: number;
  private readonly targetTTFT: number;
  private readonly targetLatency: number;
  private readonly scaleUpThreshold: number;
  private readonly scaleDownThreshold: number;
  private adjustmentInterval?: NodeJS.Timeout;
  private metricsExportInterval?: NodeJS.Timeout;
  private poolCleanupInterval?: NodeJS.Timeout;

  // Metrics tracking
  private totalStreamsCreated = 0;
  private totalStreamsCompleted = 0;
  private totalStreamsCancelled = 0;
  private ttftSamples: number[] = [];
  private throughputSamples: number[] = [];

  // Feature flags from config
  private readonly adaptiveLimitsEnabled: boolean;
  private readonly chunkPoolingEnabled: boolean;
  private readonly backpressureEnabled: boolean;
  private readonly metricsEnabled: boolean;
  private readonly maxUnackedChunks: number;
  private readonly ackTimeoutMs: number;
  private readonly slowConsumerThresholdMs: number;
  private readonly cleanupScheduler?: CleanupScheduler;
  private readonly adaptiveGovernor?: AdaptiveGovernor;
  private readonly concurrencyLimiter?: ModelConcurrencyLimiter;

  constructor(options: StreamRegistryOptions = {}) {
    super();

    // Load configuration from YAML
    const config = getConfig();

    this.logger = options.logger;
    this.defaultTimeout = options.defaultTimeout ?? config.stream_registry.default_timeout_ms;
    this.maxActiveStreams = options.maxActiveStreams ?? config.stream_registry.max_active_streams;

    // Phase 4: Load stream optimization config
    const adaptive = config.stream_registry.adaptive_limits;
    const pooling = config.stream_registry.chunk_pooling;
    const backpressure = config.stream_registry.backpressure;
    const metrics = config.stream_registry.metrics;

    this.adaptiveLimitsEnabled = adaptive.enabled;
    this.minStreamLimit = adaptive.min_streams;
    this.maxStreamLimit = adaptive.max_streams;
    this.currentStreamLimit = this.maxActiveStreams;
    this.targetTTFT = adaptive.target_ttft_ms;
    this.targetLatency = adaptive.target_latency_ms;
    this.scaleUpThreshold = adaptive.scale_up_threshold;
    this.scaleDownThreshold = adaptive.scale_down_threshold;

    this.chunkPoolingEnabled = pooling.enabled;
    if (this.chunkPoolingEnabled) {
      this.chunkPool = new ChunkPool(pooling.pool_size);
    }

    this.backpressureEnabled = backpressure.enabled;
    this.maxUnackedChunks = backpressure.max_unacked_chunks;
    this.ackTimeoutMs = backpressure.ack_timeout_ms;
    this.slowConsumerThresholdMs = backpressure.slow_consumer_threshold_ms;

    this.metricsEnabled = metrics.enabled;

    const governorConfig = buildStreamGovernorConfig(config);
    const governorEnabled = Boolean(
      this.adaptiveLimitsEnabled && governorConfig?.featureFlag
    );

    if (governorEnabled && governorConfig) {
      this.adaptiveGovernor = new AdaptiveGovernor(governorConfig, this.logger);
      this.cleanupScheduler = new CleanupScheduler(
        {
          sweepIntervalMs: governorConfig.cleanup.sweepIntervalMs,
          maxStaleLifetimeMs: governorConfig.cleanup.maxStaleLifetimeMs,
        },
        this.logger
      );
      this.cleanupScheduler.start();
      this.currentStreamLimit = Math.min(
        this.maxStreamLimit,
        governorConfig.maxConcurrentStreams
      );
    }

    // Phase 5 Week 3: Initialize model-size-aware concurrency limiter
    // Prevents Metal GPU crashes from concurrent command buffer submissions
    const concurrencyLimiterEnabled = config.model_concurrency_limiter?.enabled ?? true;
    if (concurrencyLimiterEnabled) {
      this.concurrencyLimiter = new ModelConcurrencyLimiter(this.logger);

      // Forward concurrency limiter events to stream registry events
      this.concurrencyLimiter.on('queued', (modelId, tier, queueDepth) => {
        this.logger?.info(
          { modelId, tier, queueDepth },
          'Request queued by concurrency limiter'
        );
      });

      this.concurrencyLimiter.on('rejected', (modelId, reason) => {
        this.logger?.error(
          { modelId, reason },
          'Request rejected by concurrency limiter'
        );
      });
    }

    // BUG-014 FIX: Extract timer initialization into separate method
    // so it can be called after cleanup during restarts
    this.initializeTimers();
  }

  /**
   * BUG-014 FIX: Initialize or reinitialize periodic timers
   * Called during construction and after cleanup to restore functionality
   */
  private initializeTimers(): void {
    const config = getConfig();
    const adaptive = config.stream_registry.adaptive_limits;
    const pooling = config.stream_registry.chunk_pooling;
    const metrics = config.stream_registry.metrics;

    // Clear old chunk pool cleanup interval (prevent leaks on reinitialize)
    if (this.poolCleanupInterval) {
      clearInterval(this.poolCleanupInterval);
      this.poolCleanupInterval = undefined;
    }

    // Initialize chunk pool cleanup interval
    if (this.chunkPoolingEnabled) {
      this.poolCleanupInterval = setInterval(() => {
        this.chunkPool?.clear();
        this.logger?.debug('Chunk pool cleaned');
      }, pooling.pool_cleanup_interval_ms);
    }

    // Clear old metrics export interval (prevent leaks on reinitialize)
    if (this.metricsExportInterval) {
      clearInterval(this.metricsExportInterval);
      this.metricsExportInterval = undefined;
    }

    // Initialize metrics export interval
    if (this.metricsEnabled) {
      this.metricsExportInterval = setInterval(() => {
        this.exportMetrics();
      }, metrics.export_interval_ms);
    }

    // Clear old adaptive limits adjustment interval (prevent leaks on reinitialize)
    if (this.adjustmentInterval) {
      clearInterval(this.adjustmentInterval);
      this.adjustmentInterval = undefined;
    }

    // Initialize adaptive limits adjustment interval
    if (this.adaptiveLimitsEnabled) {
      this.adjustmentInterval = setInterval(() => {
        this.adjustStreamLimits();
      }, adaptive.adjustment_interval_ms);
    }
  }

  /**
   * Register a new stream
   *
   * @param streamId - Unique stream identifier from Python runtime
   * @param signal - Optional AbortSignal for cancellation
   * @param timeout - Optional custom timeout (overrides default)
   * @param modelId - Optional model ID for concurrency limiting (Phase 5 Week 3)
   * @returns Promise that resolves with final stream stats
   */
  public async register(
    streamId: string,
    signal?: AbortSignal,
    timeout?: number,
    modelId?: string
  ): Promise<StreamStats> {
    if (this.streams.has(streamId)) {
      throw new Error(`Stream ${streamId} already registered`);
    }

    // Phase 5 Week 3: Acquire concurrency slot before checking stream limits
    // This prevents Metal GPU crashes from too many concurrent streams
    if (this.concurrencyLimiter && modelId) {
      await this.concurrencyLimiter.acquire(modelId, streamId);
    }

    // Phase 4: Use adaptive limit instead of fixed maxActiveStreams
    const effectiveLimit = this.adaptiveLimitsEnabled
      ? this.currentStreamLimit
      : this.maxActiveStreams;

    if (this.streams.size >= effectiveLimit) {
      // Release concurrency slot if stream limit check fails
      if (this.concurrencyLimiter && modelId) {
        this.concurrencyLimiter.release(modelId, streamId);
      }

      throw new Error(
        `Max active streams (${effectiveLimit}) exceeded. Consider increasing maxActiveStreams or waiting for streams to complete.`
      );
    }

    // Phase 4: Track total streams created
    this.totalStreamsCreated++;

    return new Promise<StreamStats>((resolve, reject) => {
      // Calculate actual timeout to use
      const timeoutMs = timeout ?? this.defaultTimeout;

      const handle: StreamHandle = {
        streamId,
        startedAt: Date.now(),
        timeout: timeoutMs, // Store actual timeout for accurate logging
        signal,
        chunkCount: 0,
        completed: false,
        resolve,
        reject,
        // Phase 4: Initialize optimization fields
        unackedChunks: 0,
        metricsExported: false,
        // Phase 5 Week 3: Store model ID for concurrency slot release
        modelId,
      };

      // Setup abort signal
      if (signal) {
        if (signal.aborted) {
          reject(new Error(`Stream ${streamId} aborted before registration`));
          return;
        }

        handle.abortHandler = () => {
          this.handleAbort(streamId);
        };
        signal.addEventListener('abort', handle.abortHandler);
      }

      // Setup timeout
      handle.timeoutHandle = setTimeout(() => {
        this.handleTimeout(streamId);
      }, timeoutMs);

      this.streams.set(streamId, handle);

      this.logger?.debug(
        { streamId, timeout: timeoutMs, hasAbortSignal: !!signal },
        'Stream registered'
      );
    });
  }

  /**
   * Handle incoming stream.chunk notification
   */
  public handleChunk(params: StreamChunkParams): void {
    const streamId = params.stream_id;
    const handle = this.streams.get(streamId);

    if (!handle) {
      this.logger?.warn({ streamId }, 'Received chunk for unregistered stream');
      return;
    }

    if (handle.completed) {
      this.logger?.warn({ streamId }, 'Received chunk for completed stream');
      return;
    }

    const now = Date.now();
    handle.chunkCount++;

    // Phase 4: Track TTFT (Time To First Token)
    if (handle.chunkCount === 1 && !handle.firstTokenAt) {
      handle.firstTokenAt = now;
      const ttft = now - handle.startedAt;

      if (this.metricsEnabled) {
        this.ttftSamples.push(ttft);
        // Keep last 100 samples for rolling average
        if (this.ttftSamples.length > 100) {
          this.ttftSamples.shift();
        }
      }
    }

    // Phase 4: Track last chunk timestamp for throughput calculation
    handle.lastChunkAt = now;

    // Phase 4: Backpressure control - check unacked chunks
    if (this.backpressureEnabled) {
      handle.unackedChunks++;

      // Emit backpressure warning if threshold exceeded
      if (handle.unackedChunks >= this.maxUnackedChunks) {
        try {
          this.emit('backpressure', streamId, handle.unackedChunks);
        } catch (err) {
          this.logger?.error({ err, streamId }, 'Error emitting backpressure event');
        }

        // Mark stream as blocked if not already
        if (!handle.blockedSince) {
          handle.blockedSince = now;
        }

        // Check if consumer is slow
        const blockedMs = now - handle.blockedSince;
        if (blockedMs > this.slowConsumerThresholdMs) {
          try {
            this.emit('slowConsumer', streamId, blockedMs);
          } catch (err) {
            this.logger?.error({ err, streamId }, 'Error emitting slowConsumer event');
          }

          this.logger?.warn(
            { streamId, blockedMs, unackedChunks: handle.unackedChunks },
            'Slow consumer detected'
          );
        }

        // In production, we might want to pause the stream here
        // For now, we just emit events and continue
      }
    }

    // Phase 4: Use chunk pooling if enabled
    let chunk: StreamChunk;
    if (this.chunkPoolingEnabled && this.chunkPool) {
      chunk = this.chunkPool.acquire(
        streamId,
        params.token,
        params.token_id,
        params.is_final,
        params.logprob,
        params.cumulative_text
      );
    } else {
      // Fallback to direct allocation
      chunk = {
        streamId,
        token: params.token,
        tokenId: params.token_id,
        logprob: params.logprob,
        isFinal: params.is_final,
        ...(params.cumulative_text !== undefined && { cumulativeText: params.cumulative_text }),
      };
    }

    // Emit with error boundary to prevent user code exceptions from breaking stream
    try {
      this.emit('chunk', chunk);
    } catch (err) {
      this.logger?.error(
        { err, streamId, chunk },
        'User listener threw error on chunk event'
      );
      // Continue processing - don't let user code break the stream
    }

    // Phase 4: Release chunk back to pool after emission
    if (this.chunkPoolingEnabled && this.chunkPool) {
      this.chunkPool.release(chunk);
    }

    this.logger?.debug({ streamId, chunkCount: handle.chunkCount }, 'Stream chunk received');
  }

  /**
   * Handle incoming stream.stats notification
   */
  public handleStats(params: StreamStatsParams): void {
    const streamId = params.stream_id;
    const handle = this.streams.get(streamId);

    if (!handle) {
      this.logger?.warn({ streamId }, 'Received stats for unregistered stream');
      return;
    }

    const stats: StreamStats = {
      streamId,
      tokensGenerated: params.tokens_generated,
      tokensPerSecond: params.tokens_per_second,
      timeToFirstToken: params.time_to_first_token,
      totalTime: params.total_time,
    };

    handle.stats = stats;

    // Emit with error boundary
    try {
      this.emit('stats', stats);
    } catch (err) {
      this.logger?.error(
        { err, streamId, stats },
        'User listener threw error on stats event'
      );
    }

    this.logger?.debug({ streamId, stats }, 'Stream stats received');
  }

  /**
   * Handle incoming stream.event notification
   */
  public handleEvent(params: StreamEventParams): void {
    const streamId = params.stream_id;
    const handle = this.streams.get(streamId);

    if (!handle) {
      this.logger?.warn({ streamId }, 'Received event for unregistered stream');
      return;
    }

    if (handle.completed) {
      this.logger?.warn({ streamId }, 'Received event for completed stream');
      return;
    }

    const event = params.event;
    const processEvent = (): void => {
      if (event === 'completed') {
        this.completeStream(streamId, params.finish_reason);
      } else if (event === 'error') {
        const error = params.error || 'Unknown error';
        this.failStream(streamId, error);
      }
    };

    if (this.cleanupScheduler) {
      const cleanupEvent: StreamCleanupEvent = {
        streamId,
        closedAt: Date.now(),
        reason: event === 'completed' ? 'complete' : 'error',
      };

      this.cleanupScheduler.schedule(cleanupEvent);
    }

    // Handle stream completion/error with error boundary around emits
    try {
      processEvent();
    } catch (err) {
      // If completeStream/failStream throws (unlikely), log and force fail
      this.logger?.error(
        { err, streamId, event },
        'Error during stream completion/failure handling'
      );
      // Force fail the stream to prevent it hanging
      // Wrap failStream in try-catch to prevent nested exceptions
      if (!handle.completed) {
        try {
          this.failStream(streamId, `Internal error: ${err}`);
        } catch (nestedErr) {
          // Last resort - log and manually clean up to prevent hanging
          this.logger?.error(
            { nestedErr, streamId, originalErr: err },
            'Nested error in failStream - forcing manual cleanup'
          );
          // Manual cleanup to prevent stream hanging
          handle.completed = true;
          if (handle.timeoutHandle) {
            clearTimeout(handle.timeoutHandle);
          }
          if (handle.abortHandler && handle.signal) {
            handle.signal.removeEventListener('abort', handle.abortHandler);
          }
          handle.reject(new Error(`Fatal error: ${err}`));
          this.streams.delete(streamId);
        }
      }
    }
  }

  /**
   * Check if stream is active
   */
  public isActive(streamId: string): boolean {
    const handle = this.streams.get(streamId);
    return handle !== undefined && !handle.completed;
  }

  /**
   * Get count of active streams
   */
  public getActiveCount(): number {
    let count = 0;
    for (const handle of this.streams.values()) {
      if (!handle.completed) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get stream statistics (if available)
   */
  public getStats(streamId: string): StreamStats | undefined {
    return this.streams.get(streamId)?.stats;
  }

  /**
   * Phase 4: Acknowledge chunk consumption (for backpressure control)
   * Reduces unacked chunk count, allowing stream to continue if blocked
   */
  public acknowledgeChunk(streamId: string, count = 1): void {
    if (!this.backpressureEnabled) {
      return;
    }

    const handle = this.streams.get(streamId);
    if (!handle || handle.completed) {
      return;
    }

    handle.unackedChunks = Math.max(0, handle.unackedChunks - count);

    // Clear blocked state if under threshold
    if (handle.unackedChunks < this.maxUnackedChunks && handle.blockedSince) {
      const blockedMs = Date.now() - handle.blockedSince;
      this.logger?.debug(
        { streamId, blockedMs, unackedChunks: handle.unackedChunks },
        'Stream unblocked'
      );
      handle.blockedSince = undefined;
    }
  }

  /**
   * Phase 4: Get aggregate metrics for all streams
   */
  public getAggregateMetrics(): AggregateMetrics {
    const activeStreams = this.getActiveCount();
    const utilizationRate = this.currentStreamLimit > 0
      ? activeStreams / this.currentStreamLimit
      : 0;

    // Bug #79 FIX: Snapshot arrays to prevent race conditions during reduce()
    // Arrays can be modified by handleChunk() or completeStream() during iteration
    const ttftSnapshot = [...this.ttftSamples];
    const throughputSnapshot = [...this.throughputSamples];

    // Calculate averages
    const avgTTFT = safeAverage(ttftSnapshot);

    const avgThroughput = safeAverage(throughputSnapshot);

    return {
      timestamp: Date.now(),
      activeStreams,
      totalStreams: this.totalStreamsCreated,
      completedStreams: this.totalStreamsCompleted,
      cancelledStreams: this.totalStreamsCancelled,
      averageTTFT: avgTTFT,
      averageThroughput: avgThroughput,
      currentLimit: this.currentStreamLimit,
      utilizationRate,
    };
  }

  /**
   * Phase 4: Get chunk pool statistics (if enabled)
   */
  public getPoolStats(): { size: number; created: number; reused: number; reuseRate: number } | null {
    if (!this.chunkPoolingEnabled || !this.chunkPool) {
      return null;
    }
    return this.chunkPool.getStats();
  }

  /**
   * Cancel a stream (if still active)
   */
  public cancel(streamId: string): void {
    const handle = this.streams.get(streamId);
    if (!handle || handle.completed) {
      return;
    }

    this.logger?.info({ streamId }, 'Stream cancelled');
    this.failStream(streamId, 'Stream cancelled by user');
  }

  /**
   * BUG-014 FIX: Reinitialize timers after cleanup
   * Call this after cleanup() to restore adaptive limits, metrics export, and pool cleanup
   */
  public reinitialize(): void {
    this.logger?.debug('Reinitializing StreamRegistry timers after cleanup');
    this.initializeTimers();
  }

  /**
   * Clean up all active streams (called on restart/shutdown)
   *
   * StreamRegistry Bug Fix: Preserve user-registered event listeners during cleanup.
   * Only clear stream handles, not event handlers. This allows streaming to work
   * correctly after PythonRunner restarts.
   *
   * Bug Fix #63: Ensure all streams are properly cleaned up
   * Clean up ALL streams (both active and completed) to prevent memory leaks
   * and clear all timeout handles to prevent orphaned timers.
   */
  public cleanup(): void {
    // Phase 4: Clear intervals first
    if (this.adjustmentInterval) {
      clearInterval(this.adjustmentInterval);
      this.adjustmentInterval = undefined;
    }

    if (this.metricsExportInterval) {
      clearInterval(this.metricsExportInterval);
      this.metricsExportInterval = undefined;
    }

    if (this.poolCleanupInterval) {
      clearInterval(this.poolCleanupInterval);
      this.poolCleanupInterval = undefined;
    }

    this.cleanupScheduler?.stop();

    // Bug Fix #63: Clean up ALL streams, not just active ones
    // This ensures we don't leak completed but not-yet-deleted streams
    const allStreamIds = Array.from(this.streams.keys());

    if (allStreamIds.length > 0) {
      this.logger?.warn(
        { totalStreams: allStreamIds.length },
        'Cleaning up all streams on shutdown'
      );

      // Clean up each stream properly
      for (const streamId of allStreamIds) {
        const handle = this.streams.get(streamId);
        if (!handle) continue;

        // Clear timeout to prevent orphaned timers
        if (handle.timeoutHandle) {
          clearTimeout(handle.timeoutHandle);
        }

        // Remove abort listener to prevent memory leaks
        if (handle.abortHandler && handle.signal) {
          handle.signal.removeEventListener('abort', handle.abortHandler);
        }

        // Only fail active streams (reject promise)
        // Completed streams are already resolved/rejected
        if (!handle.completed) {
          handle.completed = true;
          handle.reject(new Error('StreamRegistry shutdown'));
        }
      }
    }

    // Clear stream handles but preserve EventEmitter listeners for restart
    this.streams.clear();

    // Phase 4: Clear chunk pool
    if (this.chunkPool) {
      this.chunkPool.clear();
    }

    // REMOVED: this.removeAllListeners(); - Preserves user-registered handlers
    this.logger?.debug('StreamRegistry cleaned up (listeners preserved)');
  }

  /**
   * Complete a stream successfully
   */
  private completeStream(streamId: string, finishReason?: string): void {
    const handle = this.streams.get(streamId);
    if (!handle || handle.completed) {
      return;
    }

    handle.completed = true;

    // Cleanup timeout
    if (handle.timeoutHandle) {
      clearTimeout(handle.timeoutHandle);
    }

    // Cleanup abort listener
    if (handle.abortHandler && handle.signal) {
      handle.signal.removeEventListener('abort', handle.abortHandler);
    }

    // Phase 4: Collect metrics before completion
    const now = Date.now();
    const totalTimeMs = now - handle.startedAt;

    // Calculate throughput if we have timing data
    let throughput = 0;
    if (handle.firstTokenAt && handle.lastChunkAt && handle.chunkCount > 0) {
      const generationTimeMs = handle.lastChunkAt - handle.firstTokenAt;
      if (generationTimeMs > 0) {
        throughput = (handle.chunkCount / generationTimeMs) * 1000; // tokens/sec
      }
    }

    // Store metrics for aggregation
    if (this.metricsEnabled) {
      this.totalStreamsCompleted++;

      // Add throughput sample
      if (throughput > 0) {
        this.throughputSamples.push(throughput);
        // Keep last 100 samples
        if (this.throughputSamples.length > 100) {
          this.throughputSamples.shift();
        }
      }

      handle.metricsExported = true;
    }

    // Create default stats if not received
    const stats =
      handle.stats ??
      ({
        streamId,
        tokensGenerated: handle.chunkCount,
        tokensPerSecond: throughput,
        timeToFirstToken: handle.firstTokenAt ? (handle.firstTokenAt - handle.startedAt) : 0,
        totalTime: totalTimeMs / 1000,
      } satisfies StreamStats);

    // Emit completion event with error boundary
    // Bug Fix #4: Protect emit() to ensure cleanup always executes
    // If user's 'completed' handler throws, we must still resolve promise and delete stream
    try {
      this.emit('completed', streamId, stats);
    } catch (err) {
      this.logger?.error(
        { err, streamId, stats },
        'User listener threw error on completed event'
      );
      // Continue with cleanup despite user code error
    }

    this.logger?.info(
      { streamId, finishReason, stats },
      'Stream completed'
    );

    // Resolve promise
    handle.resolve(stats);

    // Phase 5 Week 3: Release concurrency slot
    if (this.concurrencyLimiter && handle.modelId) {
      this.concurrencyLimiter.release(handle.modelId, streamId);
    }

    // Remove from registry immediately
    this.streams.delete(streamId);
  }

  /**
   * Fail a stream with error
   */
  private failStream(streamId: string, error: string): void {
    const handle = this.streams.get(streamId);
    if (!handle || handle.completed) {
      return;
    }

    handle.completed = true;

    // Cleanup timeout
    if (handle.timeoutHandle) {
      clearTimeout(handle.timeoutHandle);
    }

    // Cleanup abort listener
    if (handle.abortHandler && handle.signal) {
      handle.signal.removeEventListener('abort', handle.abortHandler);
    }

    // Phase 4: Track cancellations for metrics
    if (this.metricsEnabled && (error.includes('cancelled') || error.includes('aborted'))) {
      this.totalStreamsCancelled++;
    }

    // Emit error event with error boundary
    // Bug Fix #4: Protect emit() to ensure cleanup always executes
    // If user's 'error' handler throws, we must still reject promise and delete stream
    try {
      this.emit('error', streamId, error);
    } catch (err) {
      this.logger?.error(
        { err, streamId, originalError: error },
        'User listener threw error on error event'
      );
      // Continue with cleanup despite user code error
    }

    this.logger?.error({ streamId, error }, 'Stream failed');

    // Reject promise
    handle.reject(new Error(error));

    // Phase 5 Week 3: Release concurrency slot
    if (this.concurrencyLimiter && handle.modelId) {
      this.concurrencyLimiter.release(handle.modelId, streamId);
    }

    // Remove from registry
    this.streams.delete(streamId);
  }

  /**
   * Handle stream abort via AbortSignal
   */
  private handleAbort(streamId: string): void {
    this.logger?.info({ streamId }, 'Stream aborted via signal');
    this.failStream(streamId, 'Stream aborted');
  }

  /**
   * Handle stream timeout
   *
   * Bug Fix #43: Add atomic check-and-set to prevent race with completeStream()
   * If timeout fires simultaneously with stream completion, we must ensure
   * only ONE of them executes cleanup to prevent double Promise resolution.
   *
   * We perform cleanup inline instead of calling failStream() because
   * failStream() has its own check-and-set logic that would return early
   * if we've already set handle.completed = true.
   */
  private handleTimeout(streamId: string): void {
    const handle = this.streams.get(streamId);

    // Atomic check-and-set: Check handle exists AND not completed in single expression
    // This prevents race condition with completeStream()
    if (!handle || handle.completed) {
      return;
    }

    // Set completed IMMEDIATELY before any other operations
    handle.completed = true;

    this.logger?.warn(
      { streamId, timeout: handle.timeout },
      'Stream timed out'
    );

    // Cleanup timeout (already fired, but clear for consistency)
    if (handle.timeoutHandle) {
      clearTimeout(handle.timeoutHandle);
    }

    // Cleanup abort listener
    if (handle.abortHandler && handle.signal) {
      handle.signal.removeEventListener('abort', handle.abortHandler);
    }

    // Bug Fix #4: Protect emit() to prevent user errors from blocking cleanup
    try {
      this.emit('timeout', streamId);
    } catch (err) {
      this.logger?.error(
        { err, streamId },
        'User listener threw error on timeout event'
      );
      // Continue with cleanup despite user code error
    }

    // Emit error event with error boundary
    const errorMsg = `Stream timed out after ${handle.timeout}ms`;
    try {
      this.emit('error', streamId, errorMsg);
    } catch (err) {
      this.logger?.error(
        { err, streamId },
        'User listener threw error on error event during timeout'
      );
    }

    this.logger?.error({ streamId, timeout: handle.timeout }, 'Stream timed out');

    // Reject promise
    handle.reject(new Error(errorMsg));

    // Phase 5 Week 3: Release concurrency slot
    if (this.concurrencyLimiter && handle.modelId) {
      this.concurrencyLimiter.release(handle.modelId, streamId);
    }

    // Remove from registry
    this.streams.delete(streamId);
  }

  /**
   * Phase 4: Adjust stream limits based on current metrics (adaptive limits)
   */
  private adjustStreamLimits(): void {
    if (!this.adaptiveLimitsEnabled) {
      return;
    }

    const metrics = this.getAggregateMetrics();

    if (this.adaptiveGovernor) {
      // Update PID controller with measured TTFT
      this.adaptiveGovernor.updateControl(
        metrics.averageTTFT || 0,
        this.streams.size
      );

      // Get the new limit from governor
      const newLimit = this.adaptiveGovernor.getCurrentLimit();
      const bounded = Math.min(
        Math.max(newLimit, this.minStreamLimit),
        this.maxStreamLimit
      );
      this.currentStreamLimit = bounded;
      return;
    }

    // Decision logic for scaling
    let newLimit = this.currentStreamLimit;

    // Scale up if utilization is high and TTFT is acceptable
    if (metrics.utilizationRate > this.scaleUpThreshold) {
      if (metrics.averageTTFT < this.targetTTFT || metrics.averageTTFT === 0) {
        // TTFT is good, we can handle more streams
        newLimit = Math.min(this.maxStreamLimit, this.currentStreamLimit + 5);
      } else {
        // TTFT is degrading, don't scale up
        this.logger?.debug(
          { currentLimit: this.currentStreamLimit, avgTTFT: metrics.averageTTFT, targetTTFT: this.targetTTFT },
          'Not scaling up: TTFT exceeds target'
        );
      }
    }

    // Scale down if utilization is low
    if (metrics.utilizationRate < this.scaleDownThreshold) {
      newLimit = Math.max(this.minStreamLimit, this.currentStreamLimit - 2);
    }

    // Apply limit change if different
    if (newLimit !== this.currentStreamLimit) {
      const oldLimit = this.currentStreamLimit;
      this.currentStreamLimit = newLimit;

      this.logger?.info(
        {
          oldLimit,
          newLimit,
          utilization: metrics.utilizationRate,
          avgTTFT: metrics.averageTTFT,
          activeStreams: metrics.activeStreams,
        },
        'Adjusted stream limit'
      );
    }
  }

  /**
   * Phase 4: Export aggregate metrics periodically
   */
  private exportMetrics(): void {
    if (!this.metricsEnabled) {
      return;
    }

    const metrics = this.getAggregateMetrics();

    try {
      this.emit('metricsExport', metrics);
    } catch (err) {
      this.logger?.error({ err, metrics }, 'Error emitting metricsExport event');
    }

    this.logger?.debug(
      {
        activeStreams: metrics.activeStreams,
        totalStreams: metrics.totalStreams,
        avgTTFT: metrics.averageTTFT,
        avgThroughput: metrics.averageThroughput,
        currentLimit: metrics.currentLimit,
        utilization: metrics.utilizationRate,
      },
      'Metrics exported'
    );
  }
}

function buildStreamGovernorConfig(config: Config): StreamGovernorConfig | null {
  const raw = config.streaming?.phase4?.adaptive_governor;
  if (!raw) {
    return null;
  }

  const tenantBudgets: StreamGovernorConfig['tenantBudgets'] = {};
  const rawBudgets = raw.tenant_budgets ?? {};

  for (const [key, budget] of Object.entries(rawBudgets)) {
    tenantBudgets[key] = {
      tenantId: budget.tenant_id ?? key,
      hardLimit: budget.hard_limit,
      burstLimit: budget.burst_limit,
      decayMs: budget.decay_ms,
    };
  }

  if (!tenantBudgets.default) {
    tenantBudgets.default = {
      tenantId: 'default',
      hardLimit: raw.max_concurrent,
      burstLimit: raw.max_concurrent,
      decayMs: 60000,
    };
  }

  return {
    featureFlag: raw.enabled,
    targetTtftMs: raw.target_ttft_ms,
    maxConcurrentStreams: raw.max_concurrent,
    minConcurrentStreams: raw.min_concurrent,
    tenantBudgets,
    pid: {
      kp: raw.pid.kp,
      ki: raw.pid.ki,
      kd: raw.pid.kd,
      integralSaturation: raw.pid.integral_saturation,
      sampleIntervalMs: raw.pid.sample_interval_ms,
    },
    cleanup: {
      sweepIntervalMs: raw.cleanup.sweep_interval_ms,
      maxStaleLifetimeMs: raw.cleanup.max_stale_lifetime_ms,
    },
  };
}
