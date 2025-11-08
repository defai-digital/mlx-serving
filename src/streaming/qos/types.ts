/**
 * QoS Telemetry Types
 *
 * Type definitions for Stream Quality of Service monitoring,
 * SLO evaluation, and automated remediation.
 *
 * Phase 4.4 Implementation
 */

/**
 * SLO (Service Level Objective) definition
 */
export interface SloDefinition {
  name: string;
  metric: 'ttft' | 'latency_p95' | 'error_rate' | 'throughput';
  threshold: number;
  windowMs: number;
  tenantId?: string; // Optional tenant-specific SLO
  modelId?: string; // Optional model-specific SLO
  severity: 'critical' | 'warning' | 'info';
}

/**
 * SLO evaluation result
 */
export interface SloEvaluation {
  sloName: string;
  metric: string;
  currentValue: number;
  threshold: number;
  violated: boolean;
  severity: 'critical' | 'warning' | 'info';
  timestamp: number;
  tenantId?: string;
  modelId?: string;
}

/**
 * Remediation action
 */
export interface RemediationAction {
  type: 'scale_up' | 'scale_down' | 'throttle' | 'alert' | 'restart';
  target: 'governor' | 'batch_queue' | 'stream_registry' | 'python_runtime';
  params: Record<string, unknown>;
  reason: string;
}

/**
 * Remediation result
 */
export interface RemediationResult {
  action: RemediationAction;
  success: boolean;
  timestamp: number;
  error?: string;
  previousValue?: number;
  newValue?: number;
}

/**
 * Metric sample for percentile calculation
 */
export interface MetricSample {
  metric: string;
  value: number;
  timestamp: number;
  streamId?: string; // Optional for aggregate metrics
  tenantId?: string;
  modelId?: string;
}

/**
 * Aggregated metric statistics
 */
export interface MetricStats {
  metric: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  windowMs: number;
  timestamp: number;
}

/**
 * QoS policy for SLO matching
 */
export interface QosPolicy {
  id: string;
  name: string;
  description: string;
  slos: SloDefinition[];
  remediations: RemediationAction[];
  enabled: boolean;
  priority: number;
}

/**
 * Remediation execution state
 */
export interface RemediationState {
  actionType: string;
  lastExecuted: number;
  executionCount: number;
  cooldownMs: number;
  inCooldown: boolean;
}

/**
 * QoS telemetry snapshot
 */
export interface QosTelemetry {
  timestamp: number;
  sloEvaluations: SloEvaluation[];
  metricStats: MetricStats[];
  remediations: RemediationResult[];
  activeViolations: number;
  totalStreams: number;
}
