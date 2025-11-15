/**
 * Regression Detector Integration Tests
 *
 * Tests for automated regression detection system.
 *
 * Phase 5 Week 2: Automated Regression Detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RegressionDetector,
  createDefaultDetectorConfig,
  type RegressionAlert,
  type BaselineMetrics,
} from '../../src/monitoring/regression-detector.js';
import {
  MetricsAggregator,
} from '../../src/monitoring/metrics-aggregator.js';

describe('RegressionDetector', () => {
  let detector: RegressionDetector;

  beforeEach(() => {
    const config = createDefaultDetectorConfig();
    config.enabled = true;
    config.checkIntervalMs = 100; // Fast checks for testing
    config.aggregator.windowSizeMs = 1000; // 1 second window
    config.aggregator.aggregationIntervalMs = 50;
    config.thresholds.minSamplesForEvaluation = 5; // Reduced for testing

    detector = new RegressionDetector(config);
  });

  afterEach(() => {
    detector.stop();
  });

  describe('Baseline Management', () => {
    it('should set and retrieve baseline metrics', () => {
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
        version: 'v1.0.0',
      };

      detector.setBaseline(baseline);

      const status = detector.getStatus();
      expect(status.hasBaseline).toBe(true);
    });

    it('should emit baselineUpdated event', async () => {
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };

      const eventPromise = new Promise<BaselineMetrics>((resolve) => {
        detector.once('baselineUpdated', resolve);
      });

      detector.setBaseline(baseline);

      const emittedBaseline = await eventPromise;
      expect(emittedBaseline).toEqual(baseline);
    });
  });

  describe('Metric Recording', () => {
    /**
     * Helper to record all required metrics for getCurrentMetrics().
     *
     * getCurrentMetrics() requires throughput, ttft, AND error_rate to be present,
     * otherwise it returns null. This helper ensures all three are recorded.
     */
    const recordAllMetrics = (
      count: number,
      baseValues: { throughput: number; ttft: number; errorRate: number }
    ): void => {
      const timestamp = Date.now();
      for (let i = 0; i < count; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: baseValues.throughput + i,
          timestamp,
        });
        detector.recordMetric({
          metric: 'ttft',
          value: baseValues.ttft + i,
          timestamp,
        });
        detector.recordMetric({
          metric: 'error_rate',
          value: baseValues.errorRate,
          timestamp,
        });
      }
    };

    it('should record metric samples', () => {
      detector.start();

      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 100 + i,
          timestamp: Date.now(),
        });
      }

      const status = detector.getStatus();
      expect(status.aggregatorStatus.sampleCounts.throughput).toBeGreaterThan(0);
    });

    it('should aggregate metrics correctly', async () => {
      detector.start();

      // Record all required metrics (getCurrentMetrics needs throughput, ttft, and error_rate)
      recordAllMetrics(20, { throughput: 95, ttft: 500, errorRate: 0.001 });

      // Wait for aggregation (configured as 50ms in beforeEach)
      // Add extra buffer for test stability (4x interval)
      const AGGREGATION_WAIT_MS = 200;
      await new Promise((resolve) => setTimeout(resolve, AGGREGATION_WAIT_MS));

      const metrics = detector.getCurrentMetrics();
      expect(metrics).not.toBeNull();
      expect(metrics!.throughput).toBeGreaterThan(90);
      expect(metrics!.throughput).toBeLessThan(120);
    });
  });

  describe('Throughput Regression Detection', () => {
    it('should detect throughput regression', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record degraded throughput (10% drop)
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 90, // 10% below baseline
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await detector.checkForRegressions();
      expect(result).not.toBeNull();
      expect(result!.hasRegression).toBe(true);
      expect(result!.alerts.length).toBeGreaterThan(0);

      const throughputAlert = result!.alerts.find((a) => a.metric === 'throughput');
      expect(throughputAlert).toBeDefined();
      expect(throughputAlert!.severity).toBe('critical');
      expect(throughputAlert!.action).toBe('rollback');
    });

    it('should not trigger false positives', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record acceptable metrics (within threshold)
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 98, // Only 2% below baseline (threshold: 5%)
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 510, // Only 2% above baseline (threshold: 10%)
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.005, // 0.5% error rate (threshold: 1%)
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await detector.checkForRegressions();
      expect(result).not.toBeNull();
      expect(result!.hasRegression).toBe(false);
      expect(result!.alerts.length).toBe(0);
    });
  });

  describe('TTFT Regression Detection', () => {
    it('should detect TTFT regression', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record degraded TTFT (15% increase)
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 100,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 575, // 15% above baseline (threshold: 10%)
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await detector.checkForRegressions();
      expect(result).not.toBeNull();
      expect(result!.hasRegression).toBe(true);

      const ttftAlert = result!.alerts.find((a) => a.metric === 'ttft');
      expect(ttftAlert).toBeDefined();
      expect(ttftAlert!.severity).toBe('critical');
    });
  });

  describe('Error Rate Regression Detection', () => {
    it('should detect error rate regression', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record high error rate (2% > 1% threshold)
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 100,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.02, // 2% error rate (threshold: 1%)
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await detector.checkForRegressions();
      expect(result).not.toBeNull();
      expect(result!.hasRegression).toBe(true);

      const errorAlert = result!.alerts.find((a) => a.metric === 'error_rate');
      expect(errorAlert).toBeDefined();
      expect(errorAlert!.severity).toBe('critical');
    });
  });

  describe('Alert Events', () => {
    it('should emit alert events', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      const alertPromise = new Promise<RegressionAlert>((resolve) => {
        detector.once('alert', resolve);
      });

      detector.start();

      // Record regression
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 90, // 10% drop
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));
      await detector.checkForRegressions();

      const alert = await alertPromise;
      expect(alert).toBeDefined();
      expect(alert.metric).toBe('throughput');
      expect(alert.severity).toBe('critical');
    });

    it('should emit rollback event on critical regression', async () => {
      const config = createDefaultDetectorConfig();
      config.enabled = true;
      config.autoRollback.enabled = true;
      config.autoRollback.onCriticalOnly = true;
      config.checkIntervalMs = 100;
      config.aggregator.windowSizeMs = 1000;
      config.thresholds.minSamplesForEvaluation = 5;

      const detectorWithRollback = new RegressionDetector(config);

      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detectorWithRollback.setBaseline(baseline);

      const rollbackPromise = new Promise<string>((resolve) => {
        detectorWithRollback.once('rollback', resolve);
      });

      detectorWithRollback.start();

      // Record critical regression
      for (let i = 0; i < 10; i++) {
        detectorWithRollback.recordMetric({
          metric: 'throughput',
          value: 90, // 10% drop
          timestamp: Date.now(),
        });

        detectorWithRollback.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detectorWithRollback.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait for detection
      await new Promise((resolve) => setTimeout(resolve, 300));
      await detectorWithRollback.checkForRegressions();

      const reason = await rollbackPromise;
      expect(reason).toBeDefined();
      expect(reason).toContain('Throughput');

      detectorWithRollback.stop();
    });
  });

  describe('Alert History', () => {
    it('should maintain alert history', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record regression
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 90,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait and check
      await new Promise((resolve) => setTimeout(resolve, 300));
      await detector.checkForRegressions();

      const history = detector.getAlertHistory();
      expect(history.length).toBeGreaterThan(0);
    });

    it('should clear alert history', async () => {
      // Set baseline
      const baseline: BaselineMetrics = {
        throughput: 100,
        ttft: 500,
        errorRate: 0.001,
        latencyP95: 200,
        latencyP99: 300,
        timestamp: Date.now(),
      };
      detector.setBaseline(baseline);

      detector.start();

      // Record regression
      for (let i = 0; i < 10; i++) {
        detector.recordMetric({
          metric: 'throughput',
          value: 90,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'ttft',
          value: 500,
          timestamp: Date.now(),
        });

        detector.recordMetric({
          metric: 'error_rate',
          value: 0.001,
          timestamp: Date.now(),
        });
      }

      // Wait and check
      await new Promise((resolve) => setTimeout(resolve, 300));
      await detector.checkForRegressions();

      detector.clearAlertHistory();

      const history = detector.getAlertHistory();
      expect(history.length).toBe(0);
    });
  });
});

describe('MetricsAggregator', () => {
  let aggregator: MetricsAggregator;

  beforeEach(() => {
    aggregator = new MetricsAggregator({
      windowSizeMs: 1000, // 1 second window
      aggregationIntervalMs: 50,
      maxSamplesPerMetric: 1000,
      tdigestCompression: 100,
      anomalyDetection: {
        enabled: true,
        stddevThreshold: 3,
        minSamplesForDetection: 10,
      },
      trackedMetrics: ['throughput', 'ttft'],
    });
  });

  afterEach(() => {
    aggregator.stop();
  });

  describe('Metric Recording', () => {
    it('should record and aggregate metrics', async () => {
      aggregator.start();

      // Record samples
      for (let i = 0; i < 20; i++) {
        aggregator.record({
          metric: 'throughput',
          value: 100 + Math.random() * 10,
          timestamp: Date.now(),
        });
      }

      // Wait for aggregation
      await new Promise((resolve) => setTimeout(resolve, 200));

      const stats = aggregator.getStatistics('throughput');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(20);
      expect(stats!.mean).toBeGreaterThan(95);
      expect(stats!.mean).toBeLessThan(115);
    });

    it('should calculate percentiles correctly', async () => {
      aggregator.start();

      // Record samples with known distribution
      for (let i = 1; i <= 100; i++) {
        aggregator.record({
          metric: 'ttft',
          value: i,
          timestamp: Date.now(),
        });
      }

      // Wait for aggregation
      await new Promise((resolve) => setTimeout(resolve, 200));

      const stats = aggregator.getStatistics('ttft');
      expect(stats).not.toBeNull();
      expect(stats!.p50).toBeGreaterThan(45);
      expect(stats!.p50).toBeLessThan(55);
      expect(stats!.p95).toBeGreaterThan(90);
      expect(stats!.p99).toBeGreaterThan(95);
    });
  });

  describe('Anomaly Detection', () => {
    it('should detect anomalies', async () => {
      aggregator.start();

      // Record normal samples
      for (let i = 0; i < 20; i++) {
        aggregator.record({
          metric: 'throughput',
          value: 100 + Math.random() * 2, // Small variance
          timestamp: Date.now(),
        });
      }

      // Wait for aggregation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Record anomaly
      const anomaly = aggregator.detectAnomaly('throughput', 200); // Way above normal

      expect(anomaly).not.toBeNull();
      expect(anomaly!.isAnomaly).toBe(true);
      expect(anomaly!.severity).toBe('high');
    });

    it('should emit anomaly events', async () => {
      aggregator.start();

      const anomalyPromise = new Promise((resolve) => {
        aggregator.once('anomaly', resolve);
      });

      // Record normal samples
      for (let i = 0; i < 20; i++) {
        aggregator.record({
          metric: 'throughput',
          value: 100,
          timestamp: Date.now(),
        });
      }

      // Wait for aggregation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Record anomaly
      aggregator.detectAnomaly('throughput', 200);

      const result = await anomalyPromise;
      expect(result).toBeDefined();
    });
  });

  describe('Time Series', () => {
    it('should maintain time series data', () => {
      aggregator.start();

      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        aggregator.record({
          metric: 'throughput',
          value: 100 + i,
          timestamp: now + i * 100,
        });
      }

      const timeSeries = aggregator.getTimeSeries('throughput');
      expect(timeSeries.length).toBe(10);
      expect(timeSeries[0].value).toBe(100);
      expect(timeSeries[9].value).toBe(109);
    });

    it('should filter time series by window', () => {
      aggregator.start();

      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        aggregator.record({
          metric: 'throughput',
          value: 100 + i,
          timestamp: now - (10 - i) * 100, // Spread over 1 second
        });
      }

      const timeSeries = aggregator.getTimeSeries('throughput', 500);
      expect(timeSeries.length).toBeLessThan(10); // Only last 500ms
    });
  });
});
