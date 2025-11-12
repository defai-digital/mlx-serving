/**
 * StreamingController
 *
 * Phase 3.2 module that aggregates tokens into fixed-size chunks, enforces
 * consumer-aware backpressure, and exports per-stream diagnostics. The design
 * follows the specification captured in `PHASE3-IMPLEMENTATION-GUIDE.md` and
 * mirrors the event-driven patterns used by the ConnectionPool and
 * StreamRegistry.
 *
 * Responsibilities:
 * - Buffer generated tokens until the configured byte boundary or timeout
 * - Dispatch chunks to consumers while tracking acknowledgements
 * - Apply flow control when the client falls behind (max unacked chunks)
 * - Detect slow consumers via ACK latency thresholds and emit warnings
 * - Maintain rolling statistics for latency, throughput, and cancellations
 * - Periodically export controller-wide metrics for observability
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * Streaming controller configuration knobs.
 */
export interface StreamingControllerConfig {
  /** Toggle chunk aggregation + backpressure (default: true) */
  enabled: boolean;
  /** Aggregation boundary in bytes (default: 65536 = 64KB) */
  chunkSizeBytes: number;
  /** Max time (ms) to hold tokens before flushing (default: 100) */
  chunkTimeoutMs: number;
  /** Maximum number of unacked chunks per stream (default: 100) */
  maxUnackedChunks: number;
  /** Deadline (ms) before an ACK is considered lost (default: 5000) */
  ackTimeoutMs: number;
  /** Threshold (ms) for slow consumer detection (default: 1000) */
  slowConsumerThresholdMs: number;
  /** Interval (ms) for metrics export events (default: 10000) */
  metricsExportIntervalMs: number;
  /** Optional logger */
  logger?: Logger;
}

const DEFAULT_CONFIG: Required<Omit<StreamingControllerConfig, 'logger'>> = {
  enabled: true,
  chunkSizeBytes: 64 * 1024,
  chunkTimeoutMs: 100,
  maxUnackedChunks: 100,
  ackTimeoutMs: 5000,
  slowConsumerThresholdMs: 1000,
  metricsExportIntervalMs: 10000,
};

const MAX_LATENCY_SAMPLES = 256;
const MAX_THROUGHPUT_SAMPLES = 128;
const MAX_CHUNK_HISTORY = 256;
const BACKPRESSURE_REJECTION_MESSAGE = 'Stream closed before backpressure cleared';

export type ChunkFlushReason = 'size' | 'timeout' | 'final' | 'manual';

/**
 * Token emitted by the Python worker.
 */
export interface Token {
  /** Monotonic token identifier */
  id: number;
  /** UTF-8 token text */
  text: string;
  /** Optional log probability */
  logprob?: number;
  /** Last token marker (flush immediately) */
  isFinal?: boolean;
  /** Source timestamp (optional, propagated into metrics) */
  timestamp?: number;
  /** Additional metadata (draft info, annotations, etc.) */
  metadata?: Record<string, unknown>;
  /** Optional pre-computed size in bytes (saves repeated Buffer.byteLength) */
  sizeBytes?: number;
}

/**
 * Chunk dispatched to downstream consumers.
 */
export interface Chunk {
  /** Chunk identifier used for ACK correlation */
  id: string;
  /** Owning stream identifier */
  streamId: string;
  /** Monotonic sequence per stream */
  sequence: number;
  /** Aggregated tokens contained within this chunk */
  tokens: Token[];
  /** Total payload size (bytes) */
  sizeBytes: number;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Time the chunk was handed to the consumer */
  sentAt?: number;
  /** Time the chunk was acknowledged by client */
  ackedAt?: number;
  /** Whether this chunk contains the terminal token */
  final: boolean;
  /** Why the chunk was flushed (size/timeout/final/manual) */
  reason: ChunkFlushReason;
}

/**
 * Backpressure notification payload passed to consumers (optional hook).
 */
export interface BackpressureInfo {
  streamId: string;
  unackedChunks: number;
  maxUnackedChunks: number;
}

/**
 * Slow consumer diagnostic payload.
 */
export interface SlowConsumerInfo {
  streamId: string;
  chunkId: string;
  latencyMs: number;
}

/**
 * Consumer implementation that receives aggregated chunks.
 */
export interface StreamConsumer {
  /** Send a chunk to the downstream client */
  sendChunk(chunk: Chunk): Promise<void> | void;
  /** Optional hook triggered when backpressure engages */
  onBackpressure?: (info: BackpressureInfo) => void;
  /** Optional hook triggered when backpressure clears */
  onResume?: (info: BackpressureInfo) => void;
  /** Optional hook triggered when slow consumer detected */
  onSlowConsumer?: (info: SlowConsumerInfo) => void;
  /** Close notification for cleanup */
  close?: (reason?: string) => void;
  /** Report whether the consumer connection is already closed */
  isClosed?: () => boolean;
}

/**
 * Per-stream diagnostic snapshot.
 */
export interface StreamStatus {
  streamId: string;
  queuedTokens: number;
  queuedBytes: number;
  pendingChunks: number;
  ackedChunks: number;
  latencyP95: number;
  throughputTokensPerSecond: number;
  averageChunkSize: number;
  backpressureEvents: number;
  slowConsumerEvents: number;
  cancellationRate: number;
  lastActivityAt?: number;
}

/**
 * Controller-wide metrics snapshot.
 */
export interface ControllerMetrics {
  timestamp: number;
  enabled: boolean;
  activeStreams: number;
  pendingChunks: number;
  blockedStreams: number;
  avgChunkSize: number;
  totalChunksSent: number;
  backpressureEvents: number;
  slowConsumers: number;
  ackTimeouts: number;
  droppedChunks: number;
}

/**
 * Events emitted by the StreamingController lifecycle.
 */
export interface StreamingControllerEvents {
  streamRegistered: (streamId: string) => void;
  streamUnregistered: (streamId: string) => void;
  chunkSent: (chunk: Chunk) => void;
  chunkAcked: (chunk: Chunk, latencyMs: number) => void;
  chunkTimeout: (streamId: string, chunkId: string, latencyMs: number) => void;
  backpressureApplied: (streamId: string, unackedChunks: number) => void;
  backpressureReleased: (streamId: string) => void;
  slowConsumer: (info: SlowConsumerInfo) => void;
  metricsExport: (metrics: ControllerMetrics) => void;
  error: (streamId: string, error: Error) => void;
}

interface PendingChunk {
  chunk: Chunk;
  sentAt?: number;
  ackTimer?: NodeJS.Timeout;
}

interface ThroughputSample {
  timestamp: number;
  tokens: number;
}

interface BackpressureWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface StreamStatsInternal {
  tokensProcessed: number;
  chunksSent: number;
  ackedChunks: number;
  bytesSent: number;
  latencySamples: number[];
  throughputSamples: ThroughputSample[];
  chunkSizes: number[];
  cancellations: number;
  droppedChunks: number;
  backpressureEvents: number;
  slowConsumerEvents: number;
  ackTimeouts: number;
  lastActivityAt?: number;
}

interface StreamState {
  streamId: string;
  consumer: StreamConsumer;
  tokenBuffer: Token[];
  bufferBytes: number;
  flushTimer?: NodeJS.Timeout;
  flushInFlight?: Promise<void>;
  pendingChunks: Map<string, PendingChunk>;
  backpressureWaiters: BackpressureWaiter[];
  unackedChunks: number;
  sequence: number;
  registeredAt: number;
  closing: boolean;
  markedForRemoval: boolean;
  stats: StreamStatsInternal;
  isPaused: boolean;
}

/**
 * Compute percentile with linear interpolation (same helper used elsewhere).
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
 * Sum helper for readability.
 */
function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

/**
 * StreamingController implementation.
 */
export class StreamingController extends EventEmitter<StreamingControllerEvents> {
  private readonly config: Required<Omit<StreamingControllerConfig, 'logger'>>;
  private readonly logger?: Logger;
  private readonly streams = new Map<string, StreamState>();
  private metricsTimer?: NodeJS.Timeout;

  private totalChunksSent = 0;
  private totalBackpressureEvents = 0;
  private totalSlowConsumers = 0;
  private totalAckTimeouts = 0;
  private totalDroppedChunks = 0;

  constructor(config?: Partial<StreamingControllerConfig>) {
    super();

    const merged: StreamingControllerConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.config = {
      enabled: merged.enabled,
      chunkSizeBytes: merged.chunkSizeBytes,
      chunkTimeoutMs: merged.chunkTimeoutMs,
      maxUnackedChunks: merged.maxUnackedChunks,
      ackTimeoutMs: merged.ackTimeoutMs,
      slowConsumerThresholdMs: merged.slowConsumerThresholdMs,
      metricsExportIntervalMs: merged.metricsExportIntervalMs,
    };

    this.logger = config?.logger ?? merged.logger;

    if (this.config.metricsExportIntervalMs > 0) {
      this.metricsTimer = setInterval(() => {
        try {
          const snapshot = this.getControllerMetrics();
          this.emit('metricsExport', snapshot);
        } catch (error) {
          this.logger?.error({ err: error }, 'Failed to export streaming metrics');
        }
      }, this.config.metricsExportIntervalMs);
      this.metricsTimer.unref?.();
    }
  }

  /**
   * Register a new stream consumer.
   */
  registerStream(streamId: string, consumer: StreamConsumer): void {
    if (this.streams.has(streamId)) {
      throw new Error(`StreamingController: stream ${streamId} already registered`);
    }

    const state: StreamState = {
      streamId,
      consumer,
      tokenBuffer: [],
      bufferBytes: 0,
      pendingChunks: new Map(),
      backpressureWaiters: [],
      unackedChunks: 0,
      sequence: 0,
      registeredAt: Date.now(),
      closing: false,
      markedForRemoval: false,
      stats: {
        tokensProcessed: 0,
        chunksSent: 0,
        ackedChunks: 0,
        bytesSent: 0,
        latencySamples: [],
        throughputSamples: [],
        chunkSizes: [],
        cancellations: 0,
        droppedChunks: 0,
        backpressureEvents: 0,
        slowConsumerEvents: 0,
        ackTimeouts: 0,
      },
      isPaused: false,
    };

    this.streams.set(streamId, state);
    this.emit('streamRegistered', streamId);
  }

  /**
   * Enqueue a single token for aggregation. May block if backpressure is active.
   */
  async enqueueToken(streamId: string, token: Token): Promise<void> {
    const state = this.streams.get(streamId);
    if (!state) {
      throw new Error(`StreamingController: stream ${streamId} is not registered`);
    }
    if (state.closing) {
      throw new Error(`StreamingController: stream ${streamId} is closing`);
    }
    if (state.consumer.isClosed?.()) {
      throw new Error(`StreamingController: consumer for ${streamId} is closed`);
    }

    await this.waitForCapacity(state);

    if (!this.config.enabled) {
      await this.dispatchChunk(state, this.buildChunk(state, [token], 'manual'));
      return;
    }

    await this.bufferToken(state, token);
  }

  /**
   * Record acknowledgement for the given chunk.
   */
  ackChunk(streamId: string, chunkId: string): void {
    const state = this.streams.get(streamId);
    if (!state) {
      this.logger?.debug({ streamId, chunkId }, 'Ack received for unknown stream');
      return;
    }

    const pending = state.pendingChunks.get(chunkId);
    if (!pending) {
      this.logger?.debug({ streamId, chunkId }, 'Ack received for unknown chunk');
      return;
    }

    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
    }

    const ackedAt = Date.now();
    pending.chunk.ackedAt = ackedAt;
    const latency = ackedAt - (pending.chunk.sentAt ?? pending.sentAt ?? pending.chunk.createdAt);

    state.pendingChunks.delete(chunkId);
    state.unackedChunks = state.pendingChunks.size;
    state.stats.ackedChunks += 1;
    state.stats.latencySamples.push(latency);
    if (state.stats.latencySamples.length > MAX_LATENCY_SAMPLES) {
      state.stats.latencySamples.shift();
    }

    state.stats.throughputSamples.push({ timestamp: ackedAt, tokens: pending.chunk.tokens.length });
    if (state.stats.throughputSamples.length > MAX_THROUGHPUT_SAMPLES) {
      state.stats.throughputSamples.shift();
    }

    if (latency >= this.config.slowConsumerThresholdMs) {
      this.handleSlowConsumer(state, latency, pending.chunk.id);
    }

    this.emit('chunkAcked', pending.chunk, latency);
    this.releaseBackpressure(state);
    this.maybeCleanupStream(state);
  }

  /**
   * Remove a stream and flush pending chunks if necessary.
   */
  unregisterStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (!state) {
      return;
    }

    state.closing = true;
    state.markedForRemoval = true;
    this.clearFlushTimer(state);

    const flushPromise = state.tokenBuffer.length > 0 ? this.flushBuffer(state, 'manual') : Promise.resolve();

    flushPromise
      .catch((error) => {
        this.logger?.error({ streamId, err: error }, 'Failed flushing buffer during unregister');
        this.emit('error', streamId, error as Error);
      })
      .finally(() => {
        this.maybeCleanupStream(state);
      });
  }

  /**
   * Retrieve stream diagnostics.
   */
  getStreamStatus(streamId: string): StreamStatus {
    const state = this.streams.get(streamId);
    if (!state) {
      throw new Error(`StreamingController: stream ${streamId} is not registered`);
    }

    const latencyP95 = percentile(state.stats.latencySamples, 95);
    const throughput = this.computeThroughput(state);
    const avgChunkSize = state.stats.chunksSent === 0 ? 0 : state.stats.bytesSent / state.stats.chunksSent;
    const cancellationRate = state.stats.chunksSent === 0 ? 0 : state.stats.cancellations / state.stats.chunksSent;

    return {
      streamId,
      queuedTokens: state.tokenBuffer.length,
      queuedBytes: state.bufferBytes,
      pendingChunks: state.pendingChunks.size,
      ackedChunks: state.stats.ackedChunks,
      latencyP95,
      throughputTokensPerSecond: throughput,
      averageChunkSize: avgChunkSize,
      backpressureEvents: state.stats.backpressureEvents,
      slowConsumerEvents: state.stats.slowConsumerEvents,
      cancellationRate,
      lastActivityAt: state.stats.lastActivityAt,
    };
  }

  /**
   * Return controller-wide metrics.
   */
  getControllerMetrics(): ControllerMetrics {
    const activeStreams = this.streams.size;
    let pendingChunks = 0;
    let totalBytes = 0;
    let totalChunks = 0;
    let blockedStreams = 0;
    let droppedChunks = 0;

    for (const state of this.streams.values()) {
      pendingChunks += state.pendingChunks.size;
      totalBytes += state.stats.bytesSent;
      totalChunks += state.stats.chunksSent;
      droppedChunks += state.stats.droppedChunks;
      if (state.isPaused) {
        blockedStreams += 1;
      }
    }

    const avgChunkSize = totalChunks === 0 ? 0 : totalBytes / totalChunks;

    return {
      timestamp: Date.now(),
      enabled: this.config.enabled,
      activeStreams,
      pendingChunks,
      blockedStreams,
      avgChunkSize,
      totalChunksSent: this.totalChunksSent,
      backpressureEvents: this.totalBackpressureEvents,
      slowConsumers: this.totalSlowConsumers,
      ackTimeouts: this.totalAckTimeouts,
      droppedChunks: this.totalDroppedChunks + droppedChunks,
    };
  }

  /**
   * Dispose controller and cleanup resources.
   */
  destroy(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }

    for (const state of [...this.streams.values()]) {
      state.markedForRemoval = true;
      this.forceCleanup(state, 'destroy');
    }
    this.streams.clear();
  }

  private async bufferToken(state: StreamState, token: Token): Promise<void> {
    state.tokenBuffer.push(token);
    state.bufferBytes += this.measureTokenBytes(token);

    if (!state.flushTimer && this.config.chunkTimeoutMs > 0) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined;
        this.flushBuffer(state, 'timeout').catch((error) => {
          this.logger?.error({ streamId: state.streamId, err: error }, 'Failed to flush buffer on timeout');
          this.emit('error', state.streamId, error as Error);
        });
      }, this.config.chunkTimeoutMs);
      state.flushTimer.unref?.();
    }

    const reachedChunkSize = state.bufferBytes >= this.config.chunkSizeBytes;
    const finalToken = token.isFinal === true;

    if (reachedChunkSize || finalToken) {
      await this.flushBuffer(state, finalToken ? 'final' : 'size');
    }
  }

  private async flushBuffer(state: StreamState, reason: ChunkFlushReason): Promise<void> {
    if (state.tokenBuffer.length === 0) {
      return;
    }

    if (state.flushInFlight) {
      await state.flushInFlight;
      if (state.tokenBuffer.length === 0) {
        return;
      }
    }

    this.clearFlushTimer(state);

    const tokens = state.tokenBuffer;
    state.tokenBuffer = [];
    state.bufferBytes = 0;
    const chunk = this.buildChunk(state, tokens, reason);
    const sendPromise = this.dispatchChunk(state, chunk);

    state.flushInFlight = sendPromise.finally(() => {
      if (state.flushInFlight === sendPromise) {
        state.flushInFlight = undefined;
      }
    });

    await state.flushInFlight;
  }

  private buildChunk(state: StreamState, tokens: Token[], reason: ChunkFlushReason): Chunk {
    const sizeBytes = tokens.reduce((acc, t) => acc + this.measureTokenBytes(t), 0);
    const containsFinal = tokens.some((t) => t.isFinal);

    const chunk: Chunk = {
      id: randomUUID(),
      streamId: state.streamId,
      sequence: ++state.sequence,
      tokens: [...tokens],
      sizeBytes,
      createdAt: Date.now(),
      final: containsFinal || (state.markedForRemoval && state.tokenBuffer.length === 0),
      reason,
    };

    return chunk;
  }

  private async dispatchChunk(state: StreamState, chunk: Chunk): Promise<void> {
    if (state.consumer.isClosed?.()) {
      throw new Error(`StreamingController: consumer closed for ${state.streamId}`);
    }

    state.stats.tokensProcessed += chunk.tokens.length;
    state.stats.chunksSent += 1;
    state.stats.bytesSent += chunk.sizeBytes;
    state.stats.chunkSizes.push(chunk.sizeBytes);
    if (state.stats.chunkSizes.length > MAX_CHUNK_HISTORY) {
      state.stats.chunkSizes.shift();
    }

    const pending: PendingChunk = { chunk };
    state.pendingChunks.set(chunk.id, pending);
    state.unackedChunks = state.pendingChunks.size;
    state.stats.lastActivityAt = chunk.createdAt;
    this.totalChunksSent += 1;

    try {
      await Promise.resolve(state.consumer.sendChunk(chunk));
      chunk.sentAt = Date.now();
      pending.sentAt = chunk.sentAt;
    } catch (error) {
      state.pendingChunks.delete(chunk.id);
      state.unackedChunks = state.pendingChunks.size;
      state.stats.droppedChunks += 1;
      this.totalDroppedChunks += 1;
      this.logger?.error({ streamId: state.streamId, chunkId: chunk.id, err: error }, 'Failed to send chunk');
      this.emit('error', state.streamId, error as Error);
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.emit('chunkSent', chunk);
    this.trackAckTimeout(state, pending);
    this.applyBackpressureIfNeeded(state);
  }

  private trackAckTimeout(state: StreamState, pending: PendingChunk): void {
    if (this.config.ackTimeoutMs <= 0) {
      return;
    }

    pending.ackTimer = setTimeout(() => {
      pending.ackTimer = undefined;
      this.handleAckTimeout(state, pending.chunk);
    }, this.config.ackTimeoutMs);
    pending.ackTimer.unref?.();
  }

  private handleAckTimeout(state: StreamState, chunk: Chunk): void {
    if (!state.pendingChunks.has(chunk.id)) {
      return;
    }

    state.pendingChunks.delete(chunk.id);
    state.unackedChunks = state.pendingChunks.size;
    state.stats.ackTimeouts += 1;
    state.stats.cancellations += 1;
    state.stats.droppedChunks += 1;
    this.totalAckTimeouts += 1;
    this.totalDroppedChunks += 1;

    const latency = Date.now() - (chunk.sentAt ?? chunk.createdAt);
    this.emit('chunkTimeout', state.streamId, chunk.id, latency);
    this.logger?.warn({ streamId: state.streamId, chunkId: chunk.id, latency }, 'Chunk ACK timed out');

    if (latency >= this.config.slowConsumerThresholdMs) {
      this.handleSlowConsumer(state, latency, chunk.id);
    }

    this.releaseBackpressure(state);
    this.maybeCleanupStream(state);
  }

  private handleSlowConsumer(state: StreamState, latencyMs: number, chunkId: string): void {
    state.stats.slowConsumerEvents += 1;
    this.totalSlowConsumers += 1;

    const info: SlowConsumerInfo = {
      streamId: state.streamId,
      chunkId,
      latencyMs,
    };

    this.logger?.warn({ streamId: state.streamId, chunkId, latencyMs }, 'Slow consumer detected');
    state.consumer.onSlowConsumer?.(info);
    this.emit('slowConsumer', info);
  }

  private waitForCapacity(state: StreamState): Promise<void> | void {
    if (state.unackedChunks < this.config.maxUnackedChunks) {
      return undefined;
    }

    if (!state.isPaused) {
      state.isPaused = true;
      state.stats.backpressureEvents += 1;
      this.totalBackpressureEvents += 1;
      this.emit('backpressureApplied', state.streamId, state.unackedChunks);
      state.consumer.onBackpressure?.({
        streamId: state.streamId,
        unackedChunks: state.unackedChunks,
        maxUnackedChunks: this.config.maxUnackedChunks,
      });
    }

    return new Promise<void>((resolve, reject) => {
      state.backpressureWaiters.push({ resolve, reject });
    });
  }

  private applyBackpressureIfNeeded(state: StreamState): void {
    if (state.unackedChunks >= this.config.maxUnackedChunks) {
      if (!state.isPaused) {
        state.isPaused = true;
        state.stats.backpressureEvents += 1;
        this.totalBackpressureEvents += 1;
        this.emit('backpressureApplied', state.streamId, state.unackedChunks);
        state.consumer.onBackpressure?.({
          streamId: state.streamId,
          unackedChunks: state.unackedChunks,
          maxUnackedChunks: this.config.maxUnackedChunks,
        });
      }
      return;
    }

    this.releaseBackpressure(state);
  }

  private releaseBackpressure(state: StreamState): void {
    if (state.unackedChunks < this.config.maxUnackedChunks && state.isPaused) {
      state.isPaused = false;
      this.emit('backpressureReleased', state.streamId);
      state.consumer.onResume?.({
        streamId: state.streamId,
        unackedChunks: state.unackedChunks,
        maxUnackedChunks: this.config.maxUnackedChunks,
      });
    }

    while (state.backpressureWaiters.length > 0 && state.unackedChunks < this.config.maxUnackedChunks) {
      const waiter = state.backpressureWaiters.shift();
      waiter?.resolve();
    }
  }

  private maybeCleanupStream(state: StreamState): void {
    if (!state.markedForRemoval) {
      return;
    }

    if (state.flushInFlight) {
      state.flushInFlight.finally(() => {
        const current = this.streams.get(state.streamId);
        if (current) {
          this.maybeCleanupStream(current);
        }
      });
      return;
    }

    if (state.pendingChunks.size > 0 || state.tokenBuffer.length > 0) {
      return;
    }

    this.forceCleanup(state, 'unregister');
  }

  private forceCleanup(state: StreamState, reason: string): void {
    this.clearFlushTimer(state);
    const rejectionError = new Error(BACKPRESSURE_REJECTION_MESSAGE);

    while (state.backpressureWaiters.length > 0) {
      const waiter = state.backpressureWaiters.shift();
      waiter?.reject(rejectionError);
    }

    for (const pending of state.pendingChunks.values()) {
      if (pending.ackTimer) {
        clearTimeout(pending.ackTimer);
      }
    }

    const dropped = state.pendingChunks.size;
    state.stats.cancellations += dropped;
    state.stats.droppedChunks += dropped;
    this.totalDroppedChunks += dropped;
    state.pendingChunks.clear();
    state.unackedChunks = 0;
    state.tokenBuffer = [];
    state.bufferBytes = 0;

    if (reason !== 'destroy') {
      state.consumer.close?.(`stream-${reason}`);
    }

    this.streams.delete(state.streamId);
    this.emit('streamUnregistered', state.streamId);
  }

  private clearFlushTimer(state: StreamState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
  }

  private measureTokenBytes(token: Token): number {
    if (typeof token.sizeBytes === 'number') {
      return token.sizeBytes;
    }
    return Buffer.byteLength(token.text, 'utf8');
  }

  private computeThroughput(state: StreamState): number {
    const samples = state.stats.throughputSamples;
    if (samples.length >= 2) {
      const durationMs = samples[samples.length - 1].timestamp - samples[0].timestamp;
      if (durationMs > 0) {
        const tokens = sum(samples.map((sample) => sample.tokens));
        return (tokens / durationMs) * 1000;
      }
    }

    const elapsedMs = Date.now() - state.registeredAt;
    if (elapsedMs <= 0) {
      return 0;
    }
    return (state.stats.tokensProcessed / elapsedMs) * 1000;
  }
}
