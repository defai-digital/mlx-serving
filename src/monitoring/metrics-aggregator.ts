/**
 * Metrics Aggregator
 *
 * Time-series metrics collection and statistical aggregation for regression detection.
 * Provides sliding window metrics, percentile calculation, and anomaly detection.
 *
 * Phase 5 Week 2: Automated Regression Detection
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { TDigest } from '../streaming/qos/TDigest.js';

/**
 * Raw metric sample with timestamp
 */
export interface MetricSample {
  metric: string;
  value: number;
  timestamp: number;
  labels?: Record<string, string>; // Optional labels (e.g., model, tenant, version)
}

/**
 * Statistical summary of metric values
 */
export interface MetricStatistics {
  metric: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p50: number;
  p95: number;
  p99: number;
  stddev: number;
  windowStartMs: number;
  windowEndMs: number;
  timestamp: number;
}

/**
 * Time-series data point
 */
export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

/**
 * Anomaly detection result
 */
export interface AnomalyResult {
  metric: string;
  isAnomaly: boolean;
  currentValue: number;
  expectedValue: number;
  deviation: number; // Number of standard deviations from expected
  severity: 'low' | 'medium' | 'high';
  timestamp: number;
}

/**
 * Configuration for metrics aggregator
 */
export interface MetricsAggregatorConfig {
  // Sliding window size (milliseconds)
  windowSizeMs: number;

  // How often to aggregate metrics (milliseconds)
  aggregationIntervalMs: number;

  // Maximum samples to keep in memory per metric
  maxSamplesPerMetric: number;

  // TDigest compression factor for percentile accuracy
  tdigestCompression: number;

  // Anomaly detection configuration
  anomalyDetection: {
    enabled: boolean;
    // Number of standard deviations for anomaly threshold
    stddevThreshold: number;
    // Minimum samples required before detecting anomalies
    minSamplesForDetection: number;
  };

  // Metrics to track
  trackedMetrics: string[];
}

/**
 * Internal metric tracker
 */
interface MetricTracker {
  metric: string;
  digest: TDigest;
  samples: MetricSample[];
  timeSeries: TimeSeriesPoint[];
  lastAggregation: number;
}

/**
 * Aggregator events
 */
export interface MetricsAggregatorEvents {
  aggregated: (stats: MetricStatistics) => void;
  anomaly: (anomaly: AnomalyResult) => void;
  sample: (sample: MetricSample) => void;
}

/**
 * Metrics Aggregator
 *
 * Collects metric samples, maintains sliding windows, computes statistics,
 * and detects anomalies for regression detection.
 */
export class MetricsAggregator extends EventEmitter<MetricsAggregatorEvents> {
  private config: MetricsAggregatorConfig;
  private logger?: Logger;
  private trackers = new Map<string, MetricTracker>();
  private aggregationTimer?: NodeJS.Timeout;
  private started = false;

  constructor(config: MetricsAggregatorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize trackers for configured metrics
    for (const metric of config.trackedMetrics) {
      this.initializeTracker(metric);
    }
  }

  /**
   * Start periodic aggregation
   */
  public start(): void {
    if (this.started) {
      this.logger?.warn('MetricsAggregator already started');
      return;
    }

    this.logger?.info(
      {
        windowSizeMs: this.config.windowSizeMs,
        aggregationIntervalMs: this.config.aggregationIntervalMs,
        metrics: this.config.trackedMetrics,
      },
      'Starting metrics aggregator'
    );

    this.aggregationTimer = setInterval(() => {
      this.aggregateAll();
    }, this.config.aggregationIntervalMs);

    this.started = true;
  }

  /**
   * Stop aggregation
   */
  public stop(): void {
    if (!this.started) {
      return;
    }

    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = undefined;
    }

    this.started = false;
    this.logger?.info('Stopped metrics aggregator');
  }

  /**
   * Record a metric sample
   */
  public record(sample: MetricSample): void {
    let tracker = this.trackers.get(sample.metric);

    // Auto-initialize tracker for new metrics
    if (!tracker) {
      this.logger?.debug({ metric: sample.metric }, 'Auto-initializing metric tracker');
      this.initializeTracker(sample.metric);
      tracker = this.trackers.get(sample.metric)!;
    }

    // Add to TDigest for percentile calculation
    tracker.digest.add(sample.value);

    // Add to samples array
    tracker.samples.push(sample);

    // Add to time series
    tracker.timeSeries.push({
      timestamp: sample.timestamp,
      value: sample.value,
    });

    // Enforce max samples limit
    if (tracker.samples.length > this.config.maxSamplesPerMetric) {
      tracker.samples.shift();
    }

    if (tracker.timeSeries.length > this.config.maxSamplesPerMetric) {
      tracker.timeSeries.shift();
    }

    // Emit sample event
    try {
      this.emit('sample', sample);
    } catch (err) {
      this.logger?.error({ err, metric: sample.metric }, 'Error emitting sample event');
    }
  }

  /**
   * Get statistics for a metric over the sliding window
   */
  public getStatistics(metric: string): MetricStatistics | null {
    const tracker = this.trackers.get(metric);
    if (!tracker) {
      return null;
    }

    return this.computeStatistics(tracker);
  }

  /**
   * Get all current statistics
   */
  public getAllStatistics(): MetricStatistics[] {
    const stats: MetricStatistics[] = [];

    for (const tracker of this.trackers.values()) {
      const stat = this.computeStatistics(tracker);
      if (stat) {
        stats.push(stat);
      }
    }

    return stats;
  }

  /**
   * Detect anomalies for a metric
   */
  public detectAnomaly(metric: string, currentValue: number): AnomalyResult | null {
    if (!this.config.anomalyDetection.enabled) {
      return null;
    }

    const tracker = this.trackers.get(metric);
    if (!tracker) {
      return null;
    }

    // Need minimum samples for reliable detection
    if (tracker.samples.length < this.config.anomalyDetection.minSamplesForDetection) {
      return null;
    }

    // Clean old samples outside window
    this.cleanOldSamples(tracker);

    // Compute mean and stddev from window
    const stats = this.computeStatistics(tracker);
    if (!stats) {
      return null;
    }

    const deviation = Math.abs(currentValue - stats.mean) / stats.stddev;
    const isAnomaly = deviation > this.config.anomalyDetection.stddevThreshold;

    let severity: 'low' | 'medium' | 'high';
    if (deviation > 4) {
      severity = 'high';
    } else if (deviation > 3) {
      severity = 'medium';
    } else {
      severity = 'low';
    }

    const result: AnomalyResult = {
      metric,
      isAnomaly,
      currentValue,
      expectedValue: stats.mean,
      deviation,
      severity,
      timestamp: Date.now(),
    };

    if (isAnomaly) {
      try {
        this.emit('anomaly', result);
      } catch (err) {
        this.logger?.error({ err, metric }, 'Error emitting anomaly event');
      }
    }

    return result;
  }

  /**
   * Get time series data for a metric
   */
  public getTimeSeries(metric: string, windowMs?: number): TimeSeriesPoint[] {
    const tracker = this.trackers.get(metric);
    if (!tracker) {
      return [];
    }

    const now = Date.now();
    const window = windowMs ?? this.config.windowSizeMs;
    const cutoff = now - window;

    return tracker.timeSeries.filter((point) => point.timestamp >= cutoff);
  }

  /**
   * Clear all data for a metric
   */
  public clearMetric(metric: string): void {
    const tracker = this.trackers.get(metric);
    if (!tracker) {
      return;
    }

    tracker.samples = [];
    tracker.timeSeries = [];
    tracker.digest = new TDigest(this.config.tdigestCompression);
    tracker.lastAggregation = Date.now();

    this.logger?.debug({ metric }, 'Cleared metric data');
  }

  /**
   * Clear all metrics
   */
  public clear(): void {
    for (const metric of this.trackers.keys()) {
      this.clearMetric(metric);
    }

    this.logger?.info('Cleared all metrics');
  }

  /**
   * Get aggregator status
   */
  public getStatus(): {
    started: boolean;
    trackedMetrics: string[];
    sampleCounts: Record<string, number>;
  } {
    const sampleCounts: Record<string, number> = {};

    for (const [metric, tracker] of this.trackers.entries()) {
      sampleCounts[metric] = tracker.samples.length;
    }

    return {
      started: this.started,
      trackedMetrics: Array.from(this.trackers.keys()),
      sampleCounts,
    };
  }

  /**
   * Initialize tracker for a metric
   */
  private initializeTracker(metric: string): void {
    if (this.trackers.has(metric)) {
      return;
    }

    const tracker: MetricTracker = {
      metric,
      digest: new TDigest(this.config.tdigestCompression),
      samples: [],
      timeSeries: [],
      lastAggregation: Date.now(),
    };

    this.trackers.set(metric, tracker);
    this.logger?.debug({ metric }, 'Initialized metric tracker');
  }

  /**
   * Aggregate all metrics
   */
  private aggregateAll(): void {
    for (const tracker of this.trackers.values()) {
      const stats = this.computeStatistics(tracker);
      if (stats) {
        try {
          this.emit('aggregated', stats);
        } catch (err) {
          this.logger?.error(
            { err, metric: tracker.metric },
            'Error emitting aggregated event'
          );
        }
      }

      tracker.lastAggregation = Date.now();
    }
  }

  /**
   * Compute statistics from tracker
   */
  private computeStatistics(tracker: MetricTracker): MetricStatistics | null {
    // Clean old samples
    this.cleanOldSamples(tracker);

    if (tracker.samples.length === 0) {
      return null;
    }

    const values = tracker.samples.map((s) => s.value);
    const count = values.length;

    // Basic stats
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / count;

    // Standard deviation
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
    const stddev = Math.sqrt(variance);

    // Percentiles from TDigest
    const p50 = tracker.digest.percentile(0.5);
    const p95 = tracker.digest.percentile(0.95);
    const p99 = tracker.digest.percentile(0.99);
    const median = p50;

    // Window boundaries
    const timestamps = tracker.samples.map((s) => s.timestamp);
    const windowStartMs = Math.min(...timestamps);
    const windowEndMs = Math.max(...timestamps);

    return {
      metric: tracker.metric,
      count,
      min,
      max,
      mean,
      median,
      p50,
      p95,
      p99,
      stddev,
      windowStartMs,
      windowEndMs,
      timestamp: Date.now(),
    };
  }

  /**
   * Remove samples outside the sliding window
   */
  private cleanOldSamples(tracker: MetricTracker): void {
    const now = Date.now();
    const cutoff = now - this.config.windowSizeMs;

    // Filter samples
    const oldCount = tracker.samples.length;
    tracker.samples = tracker.samples.filter((sample) => sample.timestamp >= cutoff);
    tracker.timeSeries = tracker.timeSeries.filter((point) => point.timestamp >= cutoff);

    // Rebuild TDigest if samples were removed
    if (tracker.samples.length < oldCount) {
      tracker.digest = new TDigest(this.config.tdigestCompression);
      for (const sample of tracker.samples) {
        tracker.digest.add(sample.value);
      }
    }
  }
}

/**
 * Create default metrics aggregator configuration
 */
export function createDefaultAggregatorConfig(): MetricsAggregatorConfig {
  return {
    windowSizeMs: 60000, // 1 minute
    aggregationIntervalMs: 10000, // 10 seconds
    maxSamplesPerMetric: 10000,
    tdigestCompression: 100,
    anomalyDetection: {
      enabled: true,
      stddevThreshold: 3, // 3 sigma
      minSamplesForDetection: 30,
    },
    trackedMetrics: ['throughput', 'ttft', 'error_rate', 'latency_p95', 'latency_p99'],
  };
}
