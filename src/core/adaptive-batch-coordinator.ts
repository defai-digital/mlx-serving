/**
 * AdaptiveBatchCoordinator
 *
 * Coordinates adaptive batch sizing between Python workers and TypeScript GenerateBatcher.
 * Receives batch metrics from workers via JSON-RPC and dynamically adjusts batch sizes
 * based on latency feedback from the Python AdaptiveBatchController.
 *
 * Architecture:
 * - Collects batch completion metrics (latency, size) from GenerateBatcher
 * - Sends metrics to Python via JSON-RPC notification
 * - Receives batch size recommendations from Python via JSON-RPC notification
 * - Updates GenerateBatcher config dynamically
 * - Handles Python unavailability gracefully
 *
 * Integration:
 * - Python RPC method: 'adaptive_batch.update_metrics'
 * - Python notification: 'adaptive.batch_size_recommendation'
 * - GenerateBatcher calls recordBatchMetrics() after each batch
 * - Coordinator applies recommendations before next batch
 */

import type { Logger } from 'pino';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';

/**
 * Configuration for adaptive batch coordinator
 */
export interface AdaptiveBatchCoordinatorConfig {
  /**
   * Enable adaptive batching (default: false)
   */
  enabled: boolean;

  /**
   * JSON-RPC method for sending metrics to Python
   * @default 'adaptive_batch.update_metrics'
   */
  pythonRpcMethod?: string;

  /**
   * How often to send metrics to Python (milliseconds)
   * @default 1000
   */
  updateIntervalMs?: number;

  /**
   * Fallback batch size if Python is unavailable
   * @default 4
   */
  defaultBatchSize?: number;

  /**
   * Minimum batch size (must match GenerateBatcher config)
   * @default 2
   */
  minBatchSize?: number;

  /**
   * Maximum batch size (must match GenerateBatcher config)
   * @default 16
   */
  maxBatchSize?: number;

  /**
   * RPC call timeout (milliseconds)
   * @default 100
   */
  rpcTimeoutMs?: number;

  /**
   * Logger instance for structured logging
   */
  logger?: Logger;
}

/**
 * Batch metrics from GenerateBatcher
 */
export interface BatchMetrics {
  /**
   * Batch processing latency (milliseconds)
   */
  latencyMs: number;

  /**
   * Number of requests in the batch
   */
  batchSize: number;

  /**
   * Timestamp when batch completed
   */
  timestamp?: number;

  /**
   * Worker ID (for multi-worker setups)
   */
  workerId?: string;
}

/**
 * Batch size recommendation from Python
 */
export interface BatchSizeRecommendation {
  /**
   * Recommended batch size
   */
  recommendedSize: number;

  /**
   * Current batch size (for validation)
   */
  currentSize: number;

  /**
   * EMA latency (milliseconds)
   */
  emaLatency?: number;

  /**
   * Reason for adjustment
   */
  adjustmentReason?: string;
}

/**
 * Statistics for observability
 */
export interface AdaptiveBatchCoordinatorStats {
  /**
   * Whether adaptive batching is enabled
   */
  enabled: boolean;

  /**
   * Total metric update cycles
   */
  totalUpdates: number;

  /**
   * Total RPC calls made to Python
   */
  totalRpcCalls: number;

  /**
   * Successful RPC calls
   */
  rpcSuccesses: number;

  /**
   * Failed RPC calls
   */
  rpcFailures: number;

  /**
   * Current batch size
   */
  currentBatchSize: number;

  /**
   * Average latency over recent window (milliseconds)
   */
  averageLatencyMs: number;

  /**
   * Timestamp of last update to Python
   */
  lastUpdateTimestamp: number;

  /**
   * Number of batch size adjustments
   */
  adjustmentCount: number;

  /**
   * Metrics in current window (not yet sent)
   */
  pendingMetricsCount: number;
}

/**
 * AdaptiveBatchCoordinator
 *
 * Bridges TypeScript GenerateBatcher with Python AdaptiveBatchController
 * for dynamic batch sizing based on latency feedback.
 */
export class AdaptiveBatchCoordinator {
  private readonly config: Required<Omit<AdaptiveBatchCoordinatorConfig, 'logger'>>;
  private readonly logger?: Logger;
  private readonly transport: JsonRpcTransport;

  // Current recommended batch size
  private currentBatchSize: number;

  // Metrics accumulation window
  private readonly metricsWindow: BatchMetrics[] = [];
  private updateTimer?: NodeJS.Timeout;
  private lastUpdateTimestamp = 0;

  // Statistics tracking
  private stats = {
    totalUpdates: 0,
    totalRpcCalls: 0,
    rpcSuccesses: 0,
    rpcFailures: 0,
    adjustmentCount: 0,
  };

  // State tracking
  private started = false;
  private pythonAvailable = true;

  constructor(transport: JsonRpcTransport, config: AdaptiveBatchCoordinatorConfig) {
    this.transport = transport;
    this.logger = config.logger;

    // Merge with defaults
    this.config = {
      enabled: config.enabled,
      pythonRpcMethod: config.pythonRpcMethod ?? 'adaptive_batch.update_metrics',
      updateIntervalMs: config.updateIntervalMs ?? 1000,
      defaultBatchSize: config.defaultBatchSize ?? 4,
      minBatchSize: config.minBatchSize ?? 2,
      maxBatchSize: config.maxBatchSize ?? 16,
      rpcTimeoutMs: config.rpcTimeoutMs ?? 100,
    };

    this.currentBatchSize = this.config.defaultBatchSize;

    // Setup notification listener for batch size recommendations
    this.transport.onNotification(
      'adaptive.batch_size_recommendation',
      this.handleBatchSizeRecommendation.bind(this)
    );

    this.logger?.info(
      {
        enabled: this.config.enabled,
        pythonRpcMethod: this.config.pythonRpcMethod,
        updateIntervalMs: this.config.updateIntervalMs,
        defaultBatchSize: this.config.defaultBatchSize,
        minBatchSize: this.config.minBatchSize,
        maxBatchSize: this.config.maxBatchSize,
        rpcTimeoutMs: this.config.rpcTimeoutMs,
      },
      'AdaptiveBatchCoordinator initialized'
    );
  }

  /**
   * Start the coordinator (begins periodic metric updates)
   */
  public start(): void {
    if (!this.config.enabled || this.started) {
      return;
    }

    this.started = true;
    this.scheduleUpdate();

    this.logger?.info('AdaptiveBatchCoordinator started');
  }

  /**
   * Stop the coordinator (stops metric updates)
   */
  public stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }

    this.logger?.info('AdaptiveBatchCoordinator stopped');
  }

  /**
   * Record batch metrics from GenerateBatcher
   *
   * Called after each batch completion. Metrics are accumulated
   * and sent to Python at the configured update interval.
   *
   * @param latencyMs - Batch processing latency in milliseconds
   * @param batchSize - Number of requests in the batch
   */
  public recordBatchMetrics(latencyMs: number, batchSize: number): void {
    if (!this.config.enabled || !this.started) {
      return;
    }

    const metrics: BatchMetrics = {
      latencyMs,
      batchSize,
      timestamp: Date.now(),
    };

    this.metricsWindow.push(metrics);

    this.logger?.trace(
      {
        latencyMs,
        batchSize,
        windowSize: this.metricsWindow.length,
      },
      'Batch metrics recorded'
    );
  }

  /**
   * Get current recommended batch size
   *
   * @returns Current batch size recommendation
   */
  public getRecommendedSize(): number {
    return this.currentBatchSize;
  }

  /**
   * Get coordinator statistics
   *
   * @returns Current statistics for observability
   */
  public getStats(): AdaptiveBatchCoordinatorStats {
    const avgLatency =
      this.metricsWindow.length > 0
        ? this.metricsWindow.reduce((sum, m) => sum + m.latencyMs, 0) /
          this.metricsWindow.length
        : 0;

    return {
      enabled: this.config.enabled,
      totalUpdates: this.stats.totalUpdates,
      totalRpcCalls: this.stats.totalRpcCalls,
      rpcSuccesses: this.stats.rpcSuccesses,
      rpcFailures: this.stats.rpcFailures,
      currentBatchSize: this.currentBatchSize,
      averageLatencyMs: avgLatency,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      adjustmentCount: this.stats.adjustmentCount,
      pendingMetricsCount: this.metricsWindow.length,
    };
  }

  /**
   * Reset coordinator state
   */
  public reset(): void {
    this.currentBatchSize = this.config.defaultBatchSize;
    this.metricsWindow.length = 0;
    this.pythonAvailable = true;

    this.stats = {
      totalUpdates: 0,
      totalRpcCalls: 0,
      rpcSuccesses: 0,
      rpcFailures: 0,
      adjustmentCount: 0,
    };

    this.logger?.info('AdaptiveBatchCoordinator reset');
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    this.stop();
    this.metricsWindow.length = 0;
    this.logger?.debug('AdaptiveBatchCoordinator cleaned up');
  }

  /**
   * Schedule next metric update to Python
   */
  private scheduleUpdate(): void {
    if (!this.started) {
      return;
    }

    this.updateTimer = setTimeout(() => {
      void this.sendMetricsUpdate();
      this.scheduleUpdate();
    }, this.config.updateIntervalMs);
  }

  /**
   * Send accumulated metrics to Python
   */
  private async sendMetricsUpdate(): Promise<void> {
    if (this.metricsWindow.length === 0) {
      return;
    }

    // Calculate average metrics over the window
    const avgLatency =
      this.metricsWindow.reduce((sum, m) => sum + m.latencyMs, 0) /
      this.metricsWindow.length;
    const avgBatchSize =
      this.metricsWindow.reduce((sum, m) => sum + m.batchSize, 0) /
      this.metricsWindow.length;

    const payload = {
      latency_ms: avgLatency,
      batch_size: Math.round(avgBatchSize),
      sample_count: this.metricsWindow.length,
    };

    // Clear window
    this.metricsWindow.length = 0;
    this.stats.totalUpdates += 1;
    this.lastUpdateTimestamp = Date.now();

    // Send to Python via RPC notification
    // Note: Using notification instead of request since we don't need a response
    // Python will send a recommendation via 'adaptive.batch_size_recommendation' notification
    try {
      this.stats.totalRpcCalls += 1;

      // Attempt to notify Python (non-blocking)
      this.transport.notify(this.config.pythonRpcMethod, payload);

      this.stats.rpcSuccesses += 1;
      this.pythonAvailable = true;

      this.logger?.debug(
        {
          avgLatency,
          avgBatchSize: Math.round(avgBatchSize),
          sampleCount: this.metricsWindow.length,
        },
        'Metrics sent to Python adaptive controller'
      );
    } catch (error) {
      this.stats.rpcFailures += 1;
      this.pythonAvailable = false;

      this.logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          avgLatency,
          avgBatchSize: Math.round(avgBatchSize),
        },
        'Failed to send metrics to Python (using default batch size)'
      );

      // Fallback to default batch size
      if (this.currentBatchSize !== this.config.defaultBatchSize) {
        this.currentBatchSize = this.config.defaultBatchSize;
        this.stats.adjustmentCount += 1;
      }
    }
  }

  /**
   * Handle batch size recommendation from Python
   *
   * @param params - Recommendation parameters
   */
  private handleBatchSizeRecommendation(params: unknown): void {
    if (!this.config.enabled || !this.started) {
      return;
    }

    const recommendation = params as BatchSizeRecommendation;

    // Validate recommendation
    if (!recommendation || typeof recommendation.recommendedSize !== 'number') {
      this.logger?.warn(
        { recommendation },
        'Invalid batch size recommendation from Python, ignoring'
      );
      return;
    }

    const { recommendedSize, currentSize, emaLatency, adjustmentReason } = recommendation;

    // Clamp to configured bounds
    const clampedSize = Math.max(
      this.config.minBatchSize,
      Math.min(this.config.maxBatchSize, recommendedSize)
    );

    if (clampedSize !== recommendedSize) {
      this.logger?.warn(
        {
          recommendedSize,
          clampedSize,
          minBatchSize: this.config.minBatchSize,
          maxBatchSize: this.config.maxBatchSize,
        },
        'Batch size recommendation out of bounds, clamping'
      );
    }

    // Check if adjustment is needed
    if (clampedSize === this.currentBatchSize) {
      this.logger?.trace(
        { batchSize: clampedSize },
        'Batch size unchanged by recommendation'
      );
      return;
    }

    // Apply recommendation
    const previousSize = this.currentBatchSize;
    this.currentBatchSize = clampedSize;
    this.stats.adjustmentCount += 1;

    this.logger?.info(
      {
        previousSize,
        newSize: clampedSize,
        emaLatency,
        reason: adjustmentReason ?? 'adaptive',
        currentSize,
      },
      'Batch size adjusted by Python adaptive controller'
    );
  }
}
