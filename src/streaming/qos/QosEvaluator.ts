/**
 * QoS Evaluator
 *
 * Monitors stream metrics, evaluates SLO violations,
 * and triggers remediations when thresholds are exceeded.
 *
 * Phase 4.4 Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { TDigest } from './TDigest.js';
import type {
  SloDefinition,
  SloEvaluation,
  MetricSample,
  MetricStats,
} from './types.js';

/**
 * Evaluator configuration
 */
export interface QosEvaluatorConfig {
  enabled: boolean;
  evaluationIntervalMs: number;
  windowMs: number;
  tdigestCompression: number;
}

/**
 * Evaluator events
 */
export interface QosEvaluatorEvents {
  violation: (evaluation: SloEvaluation) => void;
  recovery: (evaluation: SloEvaluation) => void;
  evaluation: (evaluations: SloEvaluation[]) => void;
}

/**
 * Metric tracker with TDigest
 */
interface MetricTracker {
  metric: string;
  digest: TDigest;
  samples: MetricSample[];
  lastEvaluation: number;
  windowMs: number;
}

/**
 * QoS Evaluator
 *
 * Tracks metrics using TDigest for accurate percentile calculation.
 * Evaluates SLO violations and emits events for remediation.
 */
export class QosEvaluator extends EventEmitter<QosEvaluatorEvents> {
  private config: QosEvaluatorConfig;
  private logger?: Logger;
  private trackers = new Map<string, MetricTracker>();
  private slos: SloDefinition[] = [];
  private evaluationTimer?: NodeJS.Timeout;
  private activeViolations = new Set<string>();

  constructor(config: QosEvaluatorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Start evaluation loop
   */
  public start(): void {
    if (!this.config.enabled) {
      this.logger?.info('QoS evaluator disabled');
      return;
    }

    this.logger?.info(
      { intervalMs: this.config.evaluationIntervalMs },
      'Starting QoS evaluator'
    );

    this.evaluationTimer = setInterval(() => {
      this.evaluateAllSlos();
    }, this.config.evaluationIntervalMs);
  }

  /**
   * Stop evaluation loop
   */
  public stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }

    this.logger?.info('Stopped QoS evaluator');
  }

  /**
   * Register SLO definitions
   */
  public registerSlos(slos: SloDefinition[]): void {
    this.slos = slos;

    // Initialize trackers for each unique metric
    const metrics = new Set(slos.map((slo) => slo.metric));

    for (const metric of metrics) {
      if (!this.trackers.has(metric)) {
        this.trackers.set(metric, {
          metric,
          digest: new TDigest(this.config.tdigestCompression),
          samples: [],
          lastEvaluation: Date.now(),
          windowMs: this.config.windowMs,
        });

        this.logger?.debug({ metric }, 'Initialized metric tracker');
      }
    }

    this.logger?.info({ sloCount: slos.length }, 'Registered SLOs');
  }

  /**
   * Record a metric sample
   */
  public recordMetric(sample: MetricSample): void {
    const tracker = this.trackers.get(sample.metric);
    if (!tracker) {
      // Create tracker on-the-fly if not exists
      this.trackers.set(sample.metric, {
        metric: sample.metric,
        digest: new TDigest(this.config.tdigestCompression),
        samples: [],
        lastEvaluation: Date.now(),
        windowMs: this.config.windowMs,
      });

      return this.recordMetric(sample);
    }

    // Add to TDigest
    tracker.digest.add(sample.value);

    // Store sample for windowing
    tracker.samples.push(sample);

    // Evict old samples outside window
    const now = Date.now();
    const cutoff = now - tracker.windowMs;
    tracker.samples = tracker.samples.filter((s) => s.timestamp >= cutoff);

    this.logger?.trace({ sample }, 'Recorded metric sample');
  }

  /**
   * Evaluate all SLOs
   */
  public evaluateAllSlos(): SloEvaluation[] {
    const now = Date.now();
    const evaluations: SloEvaluation[] = [];

    for (const slo of this.slos) {
      const evaluation = this.evaluateSlo(slo, now);
      if (evaluation) {
        evaluations.push(evaluation);

        // Check for violation state change
        const violationKey = `${slo.name}:${slo.tenantId || 'global'}:${slo.modelId || 'all'}`;

        if (evaluation.violated && !this.activeViolations.has(violationKey)) {
          // New violation
          this.activeViolations.add(violationKey);

          try {
            this.emit('violation', evaluation);
          } catch (err) {
            this.logger?.error({ err }, 'Error emitting violation event');
          }

          this.logger?.warn(
            {
              slo: slo.name,
              metric: evaluation.metric,
              current: evaluation.currentValue,
              threshold: evaluation.threshold,
            },
            'SLO violation detected'
          );
        } else if (!evaluation.violated && this.activeViolations.has(violationKey)) {
          // Recovery
          this.activeViolations.delete(violationKey);

          try {
            this.emit('recovery', evaluation);
          } catch (err) {
            this.logger?.error({ err }, 'Error emitting recovery event');
          }

          this.logger?.info(
            {
              slo: slo.name,
              metric: evaluation.metric,
              current: evaluation.currentValue,
            },
            'SLO recovered'
          );
        }
      }
    }

    try {
      this.emit('evaluation', evaluations);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting evaluation event');
    }

    return evaluations;
  }

  /**
   * Evaluate a single SLO
   */
  private evaluateSlo(slo: SloDefinition, now: number): SloEvaluation | null {
    const tracker = this.trackers.get(slo.metric);
    if (!tracker) {
      return null;
    }

    // Rebuild TDigest from windowed samples
    const cutoff = now - slo.windowMs;
    const windowedSamples = tracker.samples.filter((s) => s.timestamp >= cutoff);

    if (windowedSamples.length === 0) {
      return null;
    }

    // Apply tenant/model filters
    const filteredSamples = windowedSamples.filter((s) => {
      if (slo.tenantId && s.tenantId !== slo.tenantId) {
        return false;
      }
      if (slo.modelId && s.modelId !== slo.modelId) {
        return false;
      }
      return true;
    });

    if (filteredSamples.length === 0) {
      return null;
    }

    // Rebuild digest for this window
    const windowDigest = new TDigest(this.config.tdigestCompression);
    for (const sample of filteredSamples) {
      windowDigest.add(sample.value);
    }

    // Calculate metric value based on type
    let currentValue: number;

    switch (slo.metric) {
      case 'ttft':
      case 'latency_p95':
        currentValue = windowDigest.percentile(0.95);
        break;

      case 'error_rate':
        // Calculate error rate from samples (0-1)
        const errorCount = filteredSamples.filter((s) => s.value === 1).length;
        currentValue = errorCount / filteredSamples.length;
        break;

      case 'throughput':
        // Samples per second
        currentValue = filteredSamples.length / (slo.windowMs / 1000);
        break;

      default:
        currentValue = windowDigest.getMean();
    }

    const violated = currentValue > slo.threshold;

    return {
      sloName: slo.name,
      metric: slo.metric,
      currentValue,
      threshold: slo.threshold,
      violated,
      severity: slo.severity,
      timestamp: now,
      tenantId: slo.tenantId,
      modelId: slo.modelId,
    };
  }

  /**
   * Get statistics for a metric
   */
  public getMetricStats(metric: string): MetricStats | null {
    const tracker = this.trackers.get(metric);
    if (!tracker || tracker.samples.length === 0) {
      return null;
    }

    const now = Date.now();
    const cutoff = now - tracker.windowMs;
    const windowedSamples = tracker.samples.filter((s) => s.timestamp >= cutoff);

    if (windowedSamples.length === 0) {
      return null;
    }

    // Rebuild digest for accurate percentiles
    const digest = new TDigest(this.config.tdigestCompression);
    for (const sample of windowedSamples) {
      digest.add(sample.value);
    }

    return {
      metric,
      count: digest.getCount(),
      min: digest.getMin(),
      max: digest.getMax(),
      mean: digest.getMean(),
      p50: digest.percentile(0.5),
      p95: digest.percentile(0.95),
      p99: digest.percentile(0.99),
      windowMs: tracker.windowMs,
      timestamp: now,
    };
  }

  /**
   * Get all metric statistics
   */
  public getAllStats(): MetricStats[] {
    const stats: MetricStats[] = [];

    for (const [metric] of this.trackers) {
      const stat = this.getMetricStats(metric);
      if (stat) {
        stats.push(stat);
      }
    }

    return stats;
  }

  /**
   * Clear all metrics
   */
  public clear(): void {
    for (const tracker of this.trackers.values()) {
      tracker.digest.reset();
      tracker.samples = [];
    }

    this.activeViolations.clear();

    this.logger?.info('Cleared all metric trackers');
  }

  /**
   * Get active violation count
   */
  public getActiveViolationCount(): number {
    return this.activeViolations.size;
  }
}
