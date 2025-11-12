/**
 * Monitoring Module
 *
 * Automated regression detection and metrics aggregation for canary deployments.
 *
 * Phase 5 Week 2: Automated Regression Detection
 */

export {
  MetricsAggregator,
  createDefaultAggregatorConfig,
  type MetricsAggregatorConfig,
  type MetricsAggregatorEvents,
  type MetricSample,
  type MetricStatistics,
  type TimeSeriesPoint,
  type AnomalyResult,
} from './metrics-aggregator.js';

export {
  RegressionDetector,
  createDefaultDetectorConfig,
  type RegressionDetectorConfig,
  type RegressionDetectorEvents,
  type BaselineMetrics,
  type RegressionThresholds,
  type RegressionAlert,
  type RegressionDetectionResult,
} from './regression-detector.js';
