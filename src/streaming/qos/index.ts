/**
 * QoS Telemetry Module
 *
 * Exports all Stream Quality of Service components:
 * - QosMonitor: Main coordinator
 * - QosEvaluator: SLO monitoring with TDigest percentiles
 * - RemediationExecutor: Auto-remediation with loop detection
 * - SloPolicyStore: YAML-driven policy management
 * - TDigest: Streaming percentile calculation
 *
 * Phase 4.4 Implementation
 */

export { QosMonitor } from './QosMonitor.js';
export type { QosMonitorConfig, QosMonitorEvents } from './QosMonitor.js';

export { QosEvaluator } from './QosEvaluator.js';
export type { QosEvaluatorConfig, QosEvaluatorEvents } from './QosEvaluator.js';

export { RemediationExecutor } from './RemediationExecutor.js';
export type { RemediationExecutorConfig, RemediationExecutorEvents } from './RemediationExecutor.js';

export { SloPolicyStore } from './SloPolicyStore.js';
export type { PolicyStoreConfig } from './SloPolicyStore.js';

export { TDigest } from './TDigest.js';

export type {
  SloDefinition,
  SloEvaluation,
  RemediationAction,
  RemediationResult,
  RemediationState,
  MetricSample,
  MetricStats,
  QosPolicy,
  QosTelemetry,
} from './types.js';
