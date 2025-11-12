/**
 * Regression Detection Integration
 *
 * Integrates RegressionDetector with QosMonitor and StreamRegistry
 * for automated canary deployment monitoring.
 *
 * Phase 5 Week 2: Automated Regression Detection
 */

import type { Logger } from 'pino';
import {
  RegressionDetector,
  createDefaultDetectorConfig,
  type BaselineMetrics,
  type RegressionAlert,
  type RegressionDetectorConfig,
} from './regression-detector.js';
import type { QosMonitor } from '../streaming/qos/QosMonitor.js';
import type { MetricSample } from './metrics-aggregator.js';

/**
 * Integration configuration
 */
export interface RegressionIntegrationConfig {
  // Regression detector configuration
  detector: RegressionDetectorConfig;

  // Prometheus integration
  prometheus: {
    enabled: boolean;
    scrapeIntervalMs: number;
    exportUrl: string; // e.g., 'http://localhost:9464/metrics'
  };

  // Grafana dashboard integration
  grafana: {
    enabled: boolean;
    dashboardUrl?: string;
    apiKey?: string;
  };
}

/**
 * Integration events
 */
export interface RegressionIntegrationEvents {
  regressionDetected: (alerts: RegressionAlert[]) => void;
  rollbackTriggered: (reason: string) => void;
}

/**
 * Regression Detection Integration
 *
 * Bridges RegressionDetector with existing QoS monitoring infrastructure.
 * Collects metrics from QosMonitor, performs regression detection,
 * and triggers alerts/rollbacks.
 */
export class RegressionIntegration {
  private config: RegressionIntegrationConfig;
  private logger?: Logger;
  private detector: RegressionDetector;
  private qosMonitor?: QosMonitor;
  private prometheusExportTimer?: NodeJS.Timeout;

  constructor(config: RegressionIntegrationConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize detector
    this.detector = new RegressionDetector(config.detector, logger);

    // Setup detector event handlers
    this.setupDetectorEventHandlers();
  }

  /**
   * Start integration
   */
  public start(qosMonitor?: QosMonitor): void {
    this.qosMonitor = qosMonitor;

    // Start regression detector
    this.detector.start();

    // Setup QoS monitor integration
    if (this.qosMonitor) {
      this.setupQosIntegration();
    }

    // Start Prometheus metric export
    if (this.config.prometheus.enabled) {
      this.startPrometheusExport();
    }

    this.logger?.info('Started regression detection integration');
  }

  /**
   * Stop integration
   */
  public stop(): void {
    this.detector.stop();

    if (this.prometheusExportTimer) {
      clearInterval(this.prometheusExportTimer);
      this.prometheusExportTimer = undefined;
    }

    this.logger?.info('Stopped regression detection integration');
  }

  /**
   * Set baseline metrics for control group
   */
  public setBaseline(baseline: BaselineMetrics): void {
    this.detector.setBaseline(baseline);
  }

  /**
   * Record a custom metric sample
   */
  public recordMetric(sample: MetricSample): void {
    this.detector.recordMetric(sample);
  }

  /**
   * Get regression detector
   */
  public getDetector(): RegressionDetector {
    return this.detector;
  }

  /**
   * Setup QoS monitor integration
   */
  private setupQosIntegration(): void {
    if (!this.qosMonitor) {
      return;
    }

    // Forward QoS telemetry to regression detector
    this.qosMonitor.on('telemetry', (telemetry) => {
      // Extract throughput metrics
      const throughputStats = telemetry.metricStats.find((s) => s.metric === 'throughput');
      if (throughputStats) {
        this.detector.recordMetric({
          metric: 'throughput',
          value: throughputStats.mean,
          timestamp: telemetry.timestamp,
        });
      }

      // Extract TTFT metrics
      const ttftStats = telemetry.metricStats.find((s) => s.metric === 'ttft');
      if (ttftStats) {
        this.detector.recordMetric({
          metric: 'ttft',
          value: ttftStats.p95,
          timestamp: telemetry.timestamp,
        });
      }

      // Extract latency metrics
      const latencyStats = telemetry.metricStats.find((s) => s.metric === 'latency_p95');
      if (latencyStats) {
        this.detector.recordMetric({
          metric: 'latency_p95',
          value: latencyStats.p95,
          timestamp: telemetry.timestamp,
        });

        this.detector.recordMetric({
          metric: 'latency_p99',
          value: latencyStats.p99,
          timestamp: telemetry.timestamp,
        });
      }

      // Compute error rate from active violations
      const errorRate = telemetry.totalStreams > 0
        ? telemetry.activeViolations / telemetry.totalStreams
        : 0;

      this.detector.recordMetric({
        metric: 'error_rate',
        value: errorRate,
        timestamp: telemetry.timestamp,
      });
    });

    this.logger?.info('Setup QoS monitor integration');
  }

  /**
   * Setup detector event handlers
   */
  private setupDetectorEventHandlers(): void {
    // Handle regression alerts
    this.detector.on('alert', (alert) => {
      this.logger?.warn(
        {
          metric: alert.metric,
          severity: alert.severity,
          percentChange: alert.percentChange,
          action: alert.action,
        },
        'Regression alert triggered'
      );
    });

    // Handle rollback events
    this.detector.on('rollback', (reason) => {
      this.logger?.error({ reason }, 'Automatic rollback triggered by regression detector');
    });

    // Handle baseline updates
    this.detector.on('baselineUpdated', (baseline) => {
      this.logger?.info(
        {
          throughput: baseline.throughput,
          ttft: baseline.ttft,
          errorRate: baseline.errorRate,
          version: baseline.version,
        },
        'Baseline metrics updated'
      );
    });
  }

  /**
   * Start Prometheus metric export
   */
  private startPrometheusExport(): void {
    this.logger?.info(
      {
        scrapeIntervalMs: this.config.prometheus.scrapeIntervalMs,
        exportUrl: this.config.prometheus.exportUrl,
      },
      'Starting Prometheus metric export'
    );

    // Export metrics to Prometheus periodically
    this.prometheusExportTimer = setInterval(() => {
      this.exportPrometheusMetrics();
    }, this.config.prometheus.scrapeIntervalMs);
  }

  /**
   * Export metrics to Prometheus
   */
  private exportPrometheusMetrics(): void {
    // Get current metrics
    const currentMetrics = this.detector.getCurrentMetrics();
    if (!currentMetrics) {
      return;
    }

    // In a real implementation, this would push metrics to Prometheus Pushgateway
    // or expose them via an HTTP endpoint that Prometheus scrapes
    // For now, we just log them
    this.logger?.debug(
      {
        throughput: currentMetrics.throughput,
        ttft: currentMetrics.ttft,
        errorRate: currentMetrics.errorRate,
        latencyP95: currentMetrics.latencyP95,
        latencyP99: currentMetrics.latencyP99,
      },
      'Exported Prometheus metrics'
    );

    // Example Prometheus metrics format:
    // mlx_serving_canary_throughput{version="canary"} 85.5
    // mlx_serving_canary_ttft_p95{version="canary"} 520.3
    // mlx_serving_canary_error_rate{version="canary"} 0.005
    // mlx_serving_canary_latency_p95{version="canary"} 125.7
    // mlx_serving_canary_latency_p99{version="canary"} 180.2
  }

  /**
   * Create Grafana dashboard for regression monitoring
   */
  public async createGrafanaDashboard(): Promise<void> {
    if (!this.config.grafana.enabled || !this.config.grafana.apiKey) {
      this.logger?.warn('Grafana integration not configured');
      return;
    }

    // Dashboard JSON configuration
    const dashboard = {
      dashboard: {
        title: 'MLX Serving - Canary Regression Monitoring',
        tags: ['mlx-serving', 'canary', 'regression'],
        timezone: 'browser',
        panels: [
          {
            title: 'Throughput Comparison',
            type: 'graph',
            targets: [
              {
                expr: 'mlx_serving_canary_throughput{version="control"}',
                legendFormat: 'Control',
              },
              {
                expr: 'mlx_serving_canary_throughput{version="canary"}',
                legendFormat: 'Canary',
              },
            ],
          },
          {
            title: 'TTFT P95 Comparison',
            type: 'graph',
            targets: [
              {
                expr: 'mlx_serving_canary_ttft_p95{version="control"}',
                legendFormat: 'Control',
              },
              {
                expr: 'mlx_serving_canary_ttft_p95{version="canary"}',
                legendFormat: 'Canary',
              },
            ],
          },
          {
            title: 'Error Rate',
            type: 'graph',
            targets: [
              {
                expr: 'mlx_serving_canary_error_rate{version="control"}',
                legendFormat: 'Control',
              },
              {
                expr: 'mlx_serving_canary_error_rate{version="canary"}',
                legendFormat: 'Canary',
              },
            ],
          },
          {
            title: 'Regression Alerts',
            type: 'table',
            targets: [
              {
                expr: 'mlx_serving_regression_alerts_total',
                legendFormat: 'Alerts',
              },
            ],
          },
        ],
      },
      overwrite: true,
    };

    try {
      const response = await fetch(`${this.config.grafana.dashboardUrl}/api/dashboards/db`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.grafana.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dashboard),
      });

      if (!response.ok) {
        throw new Error(`Failed to create Grafana dashboard: ${response.statusText}`);
      }

      const result = await response.json();
      this.logger?.info(
        { dashboardUrl: result.url },
        'Created Grafana regression monitoring dashboard'
      );
    } catch (err) {
      this.logger?.error({ err }, 'Failed to create Grafana dashboard');
    }
  }
}

/**
 * Create default integration configuration
 */
export function createDefaultIntegrationConfig(): RegressionIntegrationConfig {
  return {
    detector: createDefaultDetectorConfig(),
    prometheus: {
      enabled: false,
      scrapeIntervalMs: 15000, // 15 seconds
      exportUrl: 'http://localhost:9464/metrics',
    },
    grafana: {
      enabled: false,
    },
  };
}
