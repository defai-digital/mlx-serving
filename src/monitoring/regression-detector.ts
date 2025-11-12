/**
 * Regression Detector
 *
 * Real-time performance regression detection with automated alerting.
 * Monitors key metrics (throughput, TTFT, error rate, P95/P99) and triggers
 * alerts when performance degrades beyond configurable thresholds.
 *
 * Phase 5 Week 2: Automated Regression Detection
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import {
  MetricsAggregator,
  type MetricsAggregatorConfig,
  type MetricSample,
} from './metrics-aggregator.js';

/**
 * Baseline metrics snapshot (control group)
 */
export interface BaselineMetrics {
  throughput: number; // tokens/second
  ttft: number; // milliseconds (P95)
  errorRate: number; // percentage (0-1)
  latencyP95: number; // milliseconds
  latencyP99: number; // milliseconds
  timestamp: number;
  version?: string; // Canary version identifier
}

/**
 * Regression threshold configuration
 */
export interface RegressionThresholds {
  // Maximum allowed throughput drop (percentage)
  throughputDropPercent: number; // Default: 5%

  // Maximum allowed TTFT increase (percentage)
  ttftIncreasePercent: number; // Default: 10%

  // Maximum allowed error rate (absolute percentage)
  errorRatePercent: number; // Default: 1%

  // Maximum allowed P99 latency increase (percentage)
  p99LatencyIncreasePercent: number; // Default: 20%

  // Minimum samples required before evaluation
  minSamplesForEvaluation: number; // Default: 30
}

/**
 * Regression alert
 */
export interface RegressionAlert {
  metric: string;
  severity: 'warning' | 'critical';
  currentValue: number;
  baselineValue: number;
  threshold: number;
  percentChange: number;
  timestamp: number;
  action: 'monitor' | 'rollback';
  message: string;
}

/**
 * Regression detection result
 */
export interface RegressionDetectionResult {
  hasRegression: boolean;
  alerts: RegressionAlert[];
  currentMetrics: BaselineMetrics;
  baselineMetrics: BaselineMetrics;
  timestamp: number;
}

/**
 * Configuration for regression detector
 */
export interface RegressionDetectorConfig {
  // Enable regression detection
  enabled: boolean;

  // How often to check for regressions (milliseconds)
  checkIntervalMs: number;

  // Regression thresholds
  thresholds: RegressionThresholds;

  // Metrics aggregator configuration
  aggregator: MetricsAggregatorConfig;

  // Alert configuration
  alerts: {
    // Enable Slack alerts
    slackEnabled: boolean;
    slackWebhookUrl?: string;

    // Enable PagerDuty alerts
    pagerDutyEnabled: boolean;
    pagerDutyApiKey?: string;

    // Enable webhook alerts
    webhookEnabled: boolean;
    webhookUrl?: string;
  };

  // Automatic rollback trigger
  autoRollback: {
    enabled: boolean;
    // Trigger rollback on critical alerts only
    onCriticalOnly: boolean;
  };
}

/**
 * Detector events
 */
export interface RegressionDetectorEvents {
  regression: (result: RegressionDetectionResult) => void;
  alert: (alert: RegressionAlert) => void;
  rollback: (reason: string) => void;
  baselineUpdated: (baseline: BaselineMetrics) => void;
}

/**
 * Regression Detector
 *
 * Monitors performance metrics in real-time, compares against baseline,
 * and triggers alerts/rollbacks when regressions are detected.
 */
export class RegressionDetector extends EventEmitter<RegressionDetectorEvents> {
  private config: RegressionDetectorConfig;
  private logger?: Logger;
  private aggregator: MetricsAggregator;
  private baselineMetrics?: BaselineMetrics;
  private checkTimer?: NodeJS.Timeout;
  private started = false;
  private alertHistory: RegressionAlert[] = [];
  private lastCheck = 0;

  constructor(config: RegressionDetectorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize metrics aggregator
    this.aggregator = new MetricsAggregator(config.aggregator, logger);

    // Forward aggregator events
    this.setupAggregatorEventForwarding();
  }

  /**
   * Start regression detection
   */
  public start(): void {
    if (!this.config.enabled) {
      this.logger?.info('Regression detector disabled');
      return;
    }

    if (this.started) {
      this.logger?.warn('Regression detector already started');
      return;
    }

    this.logger?.info(
      {
        checkIntervalMs: this.config.checkIntervalMs,
        thresholds: this.config.thresholds,
      },
      'Starting regression detector'
    );

    // Start aggregator
    this.aggregator.start();

    // Start periodic regression checks
    this.checkTimer = setInterval(() => {
      this.checkForRegressions();
    }, this.config.checkIntervalMs);

    this.started = true;
  }

  /**
   * Stop regression detection
   */
  public stop(): void {
    if (!this.started) {
      return;
    }

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }

    this.aggregator.stop();
    this.started = false;
    this.logger?.info('Stopped regression detector');
  }

  /**
   * Set baseline metrics (from stable/control version)
   */
  public setBaseline(baseline: BaselineMetrics): void {
    this.baselineMetrics = baseline;
    this.logger?.info(
      {
        throughput: baseline.throughput,
        ttft: baseline.ttft,
        errorRate: baseline.errorRate,
        version: baseline.version,
      },
      'Updated baseline metrics'
    );

    try {
      this.emit('baselineUpdated', baseline);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting baselineUpdated event');
    }
  }

  /**
   * Record a metric sample
   */
  public recordMetric(sample: MetricSample): void {
    this.aggregator.record(sample);
  }

  /**
   * Get current metrics snapshot
   */
  public getCurrentMetrics(): BaselineMetrics | null {
    const stats = this.aggregator.getAllStatistics();
    if (stats.length === 0) {
      return null;
    }

    const throughputStats = stats.find((s) => s.metric === 'throughput');
    const ttftStats = stats.find((s) => s.metric === 'ttft');
    const errorRateStats = stats.find((s) => s.metric === 'error_rate');
    const latencyP95Stats = stats.find((s) => s.metric === 'latency_p95');
    const latencyP99Stats = stats.find((s) => s.metric === 'latency_p99');

    if (!throughputStats || !ttftStats || !errorRateStats) {
      return null;
    }

    return {
      throughput: throughputStats.mean,
      ttft: ttftStats.p95,
      errorRate: errorRateStats.mean,
      latencyP95: latencyP95Stats?.p95 ?? 0,
      latencyP99: latencyP99Stats?.p99 ?? 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Check for performance regressions
   */
  public async checkForRegressions(): Promise<RegressionDetectionResult | null> {
    if (!this.baselineMetrics) {
      this.logger?.debug('No baseline metrics set, skipping regression check');
      return null;
    }

    const currentMetrics = this.getCurrentMetrics();
    if (!currentMetrics) {
      this.logger?.debug('Insufficient current metrics, skipping regression check');
      return null;
    }

    // Check if we have enough samples
    const status = this.aggregator.getStatus();
    const minSamples = this.config.thresholds.minSamplesForEvaluation;
    const hasSufficientSamples = Object.values(status.sampleCounts).some(
      (count) => count >= minSamples
    );

    if (!hasSufficientSamples) {
      this.logger?.debug(
        { sampleCounts: status.sampleCounts, minSamples },
        'Insufficient samples for regression detection'
      );
      return null;
    }

    const alerts: RegressionAlert[] = [];

    // Check throughput regression
    const throughputDrop =
      (this.baselineMetrics.throughput - currentMetrics.throughput) /
      this.baselineMetrics.throughput;

    if (throughputDrop > this.config.thresholds.throughputDropPercent / 100) {
      const alert: RegressionAlert = {
        metric: 'throughput',
        severity: 'critical',
        currentValue: currentMetrics.throughput,
        baselineValue: this.baselineMetrics.throughput,
        threshold: this.config.thresholds.throughputDropPercent,
        percentChange: throughputDrop * 100,
        timestamp: Date.now(),
        action: 'rollback',
        message: `Throughput dropped by ${(throughputDrop * 100).toFixed(2)}% (${currentMetrics.throughput.toFixed(2)} tok/s → ${this.baselineMetrics.throughput.toFixed(2)} tok/s)`,
      };

      alerts.push(alert);
      this.logger?.warn(alert, 'Throughput regression detected');
    }

    // Check TTFT regression
    const ttftIncrease =
      (currentMetrics.ttft - this.baselineMetrics.ttft) / this.baselineMetrics.ttft;

    if (ttftIncrease > this.config.thresholds.ttftIncreasePercent / 100) {
      const alert: RegressionAlert = {
        metric: 'ttft',
        severity: 'critical',
        currentValue: currentMetrics.ttft,
        baselineValue: this.baselineMetrics.ttft,
        threshold: this.config.thresholds.ttftIncreasePercent,
        percentChange: ttftIncrease * 100,
        timestamp: Date.now(),
        action: 'rollback',
        message: `TTFT increased by ${(ttftIncrease * 100).toFixed(2)}% (${this.baselineMetrics.ttft.toFixed(2)}ms → ${currentMetrics.ttft.toFixed(2)}ms)`,
      };

      alerts.push(alert);
      this.logger?.warn(alert, 'TTFT regression detected');
    }

    // Check error rate regression
    if (currentMetrics.errorRate > this.config.thresholds.errorRatePercent / 100) {
      const alert: RegressionAlert = {
        metric: 'error_rate',
        severity: 'critical',
        currentValue: currentMetrics.errorRate,
        baselineValue: this.baselineMetrics.errorRate,
        threshold: this.config.thresholds.errorRatePercent,
        percentChange: (currentMetrics.errorRate - this.baselineMetrics.errorRate) * 100,
        timestamp: Date.now(),
        action: 'rollback',
        message: `Error rate at ${(currentMetrics.errorRate * 100).toFixed(2)}% (threshold: ${this.config.thresholds.errorRatePercent}%)`,
      };

      alerts.push(alert);
      this.logger?.warn(alert, 'Error rate regression detected');
    }

    // Check P99 latency regression
    if (this.baselineMetrics.latencyP99 > 0 && currentMetrics.latencyP99 > 0) {
      const p99Increase =
        (currentMetrics.latencyP99 - this.baselineMetrics.latencyP99) /
        this.baselineMetrics.latencyP99;

      if (p99Increase > this.config.thresholds.p99LatencyIncreasePercent / 100) {
        const alert: RegressionAlert = {
          metric: 'latency_p99',
          severity: 'warning',
          currentValue: currentMetrics.latencyP99,
          baselineValue: this.baselineMetrics.latencyP99,
          threshold: this.config.thresholds.p99LatencyIncreasePercent,
          percentChange: p99Increase * 100,
          timestamp: Date.now(),
          action: 'monitor',
          message: `P99 latency increased by ${(p99Increase * 100).toFixed(2)}% (${this.baselineMetrics.latencyP99.toFixed(2)}ms → ${currentMetrics.latencyP99.toFixed(2)}ms)`,
        };

        alerts.push(alert);
        this.logger?.warn(alert, 'P99 latency regression detected');
      }
    }

    const hasRegression = alerts.length > 0;
    const result: RegressionDetectionResult = {
      hasRegression,
      alerts,
      currentMetrics,
      baselineMetrics: this.baselineMetrics,
      timestamp: Date.now(),
    };

    if (hasRegression) {
      // Store alerts in history
      this.alertHistory.push(...alerts);

      // Trim alert history (keep last 100)
      if (this.alertHistory.length > 100) {
        this.alertHistory = this.alertHistory.slice(-100);
      }

      // Emit regression event
      try {
        this.emit('regression', result);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting regression event');
      }

      // Emit individual alert events
      for (const alert of alerts) {
        try {
          this.emit('alert', alert);
        } catch (err) {
          this.logger?.error({ err, metric: alert.metric }, 'Error emitting alert event');
        }

        // Send external alerts
        await this.sendExternalAlert(alert);
      }

      // Trigger automatic rollback if configured
      if (this.config.autoRollback.enabled) {
        const shouldRollback = this.config.autoRollback.onCriticalOnly
          ? alerts.some((a) => a.severity === 'critical')
          : true;

        if (shouldRollback) {
          const reason = alerts.map((a) => a.message).join('; ');
          this.logger?.error({ reason }, 'Triggering automatic rollback');

          try {
            this.emit('rollback', reason);
          } catch (err) {
            this.logger?.error({ err }, 'Error emitting rollback event');
          }
        }
      }
    }

    this.lastCheck = Date.now();
    return result;
  }

  /**
   * Get alert history
   */
  public getAlertHistory(limit = 100): RegressionAlert[] {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Clear alert history
   */
  public clearAlertHistory(): void {
    this.alertHistory = [];
    this.logger?.info('Cleared alert history');
  }

  /**
   * Get detector status
   */
  public getStatus(): {
    started: boolean;
    hasBaseline: boolean;
    lastCheckMs: number;
    alertCount: number;
    aggregatorStatus: ReturnType<MetricsAggregator['getStatus']>;
  } {
    return {
      started: this.started,
      hasBaseline: this.baselineMetrics !== undefined,
      lastCheckMs: this.lastCheck,
      alertCount: this.alertHistory.length,
      aggregatorStatus: this.aggregator.getStatus(),
    };
  }

  /**
   * Clear all data
   */
  public clear(): void {
    this.aggregator.clear();
    this.alertHistory = [];
    this.lastCheck = 0;
    this.logger?.info('Cleared regression detector data');
  }

  /**
   * Setup event forwarding from aggregator
   */
  private setupAggregatorEventForwarding(): void {
    // Could forward aggregator events if needed
    // For now, we just use the aggregator's data directly
  }

  /**
   * Send alert to external systems (Slack, PagerDuty, etc.)
   */
  private async sendExternalAlert(alert: RegressionAlert): Promise<void> {
    // Slack webhook
    if (this.config.alerts.slackEnabled && this.config.alerts.slackWebhookUrl) {
      try {
        await this.sendSlackAlert(alert);
      } catch (err) {
        this.logger?.error({ err, metric: alert.metric }, 'Failed to send Slack alert');
      }
    }

    // PagerDuty
    if (this.config.alerts.pagerDutyEnabled && this.config.alerts.pagerDutyApiKey) {
      try {
        await this.sendPagerDutyAlert(alert);
      } catch (err) {
        this.logger?.error({ err, metric: alert.metric }, 'Failed to send PagerDuty alert');
      }
    }

    // Generic webhook
    if (this.config.alerts.webhookEnabled && this.config.alerts.webhookUrl) {
      try {
        await this.sendWebhookAlert(alert);
      } catch (err) {
        this.logger?.error({ err, metric: alert.metric }, 'Failed to send webhook alert');
      }
    }
  }

  /**
   * Send Slack alert
   */
  private async sendSlackAlert(alert: RegressionAlert): Promise<void> {
    const payload = {
      text: `🚨 Performance Regression Detected`,
      attachments: [
        {
          color: alert.severity === 'critical' ? 'danger' : 'warning',
          fields: [
            {
              title: 'Metric',
              value: alert.metric,
              short: true,
            },
            {
              title: 'Severity',
              value: alert.severity,
              short: true,
            },
            {
              title: 'Change',
              value: `${alert.percentChange > 0 ? '+' : ''}${alert.percentChange.toFixed(2)}%`,
              short: true,
            },
            {
              title: 'Action',
              value: alert.action,
              short: true,
            },
            {
              title: 'Details',
              value: alert.message,
              short: false,
            },
          ],
          footer: 'MLX Serving Regression Detector',
          ts: Math.floor(alert.timestamp / 1000),
        },
      ],
    };

    const response = await fetch(this.config.alerts.slackWebhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.statusText}`);
    }
  }

  /**
   * Send PagerDuty alert
   */
  private async sendPagerDutyAlert(alert: RegressionAlert): Promise<void> {
    const payload = {
      routing_key: this.config.alerts.pagerDutyApiKey,
      event_action: 'trigger',
      payload: {
        summary: `Performance regression: ${alert.metric}`,
        severity: alert.severity,
        source: 'mlx-serving-regression-detector',
        custom_details: {
          metric: alert.metric,
          current_value: alert.currentValue,
          baseline_value: alert.baselineValue,
          percent_change: alert.percentChange,
          threshold: alert.threshold,
          action: alert.action,
          message: alert.message,
        },
      },
    };

    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`PagerDuty alert failed: ${response.statusText}`);
    }
  }

  /**
   * Send generic webhook alert
   */
  private async sendWebhookAlert(alert: RegressionAlert): Promise<void> {
    const response = await fetch(this.config.alerts.webhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'regression_alert',
        alert,
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook alert failed: ${response.statusText}`);
    }
  }
}

/**
 * Create default regression detector configuration
 */
export function createDefaultDetectorConfig(): RegressionDetectorConfig {
  return {
    enabled: false,
    checkIntervalMs: 30000, // Check every 30 seconds
    thresholds: {
      throughputDropPercent: 5, // Alert on >5% throughput drop
      ttftIncreasePercent: 10, // Alert on >10% TTFT increase
      errorRatePercent: 1, // Alert on >1% error rate
      p99LatencyIncreasePercent: 20, // Alert on >20% P99 increase
      minSamplesForEvaluation: 30, // Require 30 samples minimum
    },
    aggregator: {
      windowSizeMs: 60000, // 1-minute window
      aggregationIntervalMs: 10000, // Aggregate every 10 seconds
      maxSamplesPerMetric: 10000,
      tdigestCompression: 100,
      anomalyDetection: {
        enabled: true,
        stddevThreshold: 3,
        minSamplesForDetection: 30,
      },
      trackedMetrics: ['throughput', 'ttft', 'error_rate', 'latency_p95', 'latency_p99'],
    },
    alerts: {
      slackEnabled: false,
      pagerDutyEnabled: false,
      webhookEnabled: false,
    },
    autoRollback: {
      enabled: false,
      onCriticalOnly: true,
    },
  };
}
