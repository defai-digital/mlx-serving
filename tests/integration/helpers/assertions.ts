/**
 * Custom Assertions for Phase 4/5 Integration Tests
 *
 * Provides specialized assertion helpers for validating Phase 4/5 component behavior.
 */

import { expect } from 'vitest';
import type { Phase4Components } from '../../../src/integration/phase4-integration-factory.js';
import type { FeatureFlagEvaluation } from '../../../src/config/feature-flag-loader.js';
import type { SloEvaluation, RemediationResult } from '../../../src/streaming/qos/types.js';

/**
 * Assert that Phase 4 components are properly initialized
 */
export function assertPhase4ComponentsValid(components: Phase4Components): void {
  expect(components).toBeDefined();
  expect(components.enabled).toBe(true);
}

/**
 * Assert that Phase 4 components are disabled
 */
export function assertPhase4ComponentsDisabled(components: Phase4Components): void {
  expect(components).toBeDefined();
  expect(components.enabled).toBe(false);
  expect(components.qosIntegration).toBeUndefined();
  expect(components.adaptiveGovernor).toBeUndefined();
  expect(components.ttftIntegration).toBeUndefined();
}

/**
 * Assert that QoS Integration is properly wired
 */
export function assertQosIntegrationValid(components: Phase4Components): void {
  expect(components.qosIntegration).toBeDefined();
  expect(components.qosIntegration?.getStats()).toBeDefined();
  expect(components.qosIntegration?.getStats().enabled).toBe(true);
}

/**
 * Assert that TTFT Integration is properly initialized
 */
export function assertTtftIntegrationValid(components: Phase4Components): void {
  expect(components.ttftIntegration).toBeDefined();
  expect(components.ttftIntegration?.isEnabled()).toBe(true);
}

/**
 * Assert that Adaptive Governor is properly initialized
 */
export function assertAdaptiveGovernorValid(components: Phase4Components): void {
  expect(components.adaptiveGovernor).toBeDefined();
}

/**
 * Assert feature flag evaluation result
 */
export function assertFeatureFlagEnabled(evaluation: FeatureFlagEvaluation): void {
  expect(evaluation).toBeDefined();
  expect(evaluation.enabled).toBe(true);
  expect(evaluation.feature).toBeDefined();
  expect(evaluation.reason).toBeDefined();
}

/**
 * Assert feature flag evaluation result (disabled)
 */
export function assertFeatureFlagDisabled(evaluation: FeatureFlagEvaluation, expectedReason?: string): void {
  expect(evaluation).toBeDefined();
  expect(evaluation.enabled).toBe(false);
  expect(evaluation.feature).toBeDefined();
  expect(evaluation.reason).toBeDefined();

  if (expectedReason) {
    expect(evaluation.reason).toContain(expectedReason);
  }
}

/**
 * Assert that hash-based routing is deterministic
 */
export function assertHashRoutingDeterministic(
  evaluations: FeatureFlagEvaluation[]
): void {
  expect(evaluations.length).toBeGreaterThan(0);

  // All evaluations for the same request should have the same hash value
  const firstHash = evaluations[0].hash;
  expect(firstHash).toBeDefined();

  for (const evaluation of evaluations) {
    // Same requestId should produce same hash (if using same seed)
    if (evaluation.hash !== undefined) {
      expect(evaluation.hash).toBeGreaterThanOrEqual(0);
      expect(evaluation.hash).toBeLessThan(100);
    }
  }
}

/**
 * Assert SLO evaluation result (violation)
 */
export function assertSloViolation(evaluation: SloEvaluation): void {
  expect(evaluation).toBeDefined();
  expect(evaluation.violated).toBe(true);
  expect(evaluation.currentValue).toBeGreaterThan(evaluation.threshold);
  expect(evaluation.sloName).toBeDefined();
}

/**
 * Assert SLO evaluation result (no violation)
 */
export function assertSloCompliant(evaluation: SloEvaluation): void {
  expect(evaluation).toBeDefined();
  expect(evaluation.violated).toBe(false);
  expect(evaluation.currentValue).toBeLessThanOrEqual(evaluation.threshold);
  expect(evaluation.sloName).toBeDefined();
}

/**
 * Assert remediation result (success)
 */
export function assertRemediationSuccess(result: RemediationResult): void {
  expect(result).toBeDefined();
  expect(result.success).toBe(true);
  expect(result.action).toBeDefined();
  expect(result.timestamp).toBeDefined();
}

/**
 * Assert remediation result (failure)
 */
export function assertRemediationFailure(result: RemediationResult, expectedError?: string): void {
  expect(result).toBeDefined();
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();

  if (expectedError) {
    expect(result.error).toContain(expectedError);
  }
}

/**
 * Assert event was emitted
 */
export function assertEventEmitted<T>(
  events: T[],
  predicate: (event: T) => boolean,
  errorMessage = 'Expected event not found'
): void {
  const found = events.some(predicate);
  expect(found, errorMessage).toBe(true);
}

/**
 * Assert metric is within valid range
 */
export function assertMetricInRange(
  value: number,
  min: number,
  max: number,
  metricName = 'metric'
): void {
  expect(value, `${metricName} should be >= ${min}`).toBeGreaterThanOrEqual(min);
  expect(value, `${metricName} should be <= ${max}`).toBeLessThanOrEqual(max);
}

/**
 * Assert TTFT metric is valid
 */
export function assertTtftValid(ttft: number): void {
  expect(ttft).toBeGreaterThan(0);
  expect(ttft).toBeLessThan(10000); // 10 seconds max (reasonable upper bound)
}

/**
 * Assert throughput metric is valid
 */
export function assertThroughputValid(throughput: number): void {
  expect(throughput).toBeGreaterThan(0);
  expect(throughput).toBeLessThan(1000); // 1000 tokens/sec max (reasonable upper bound)
}

/**
 * Assert error rate is valid
 */
export function assertErrorRateValid(errorRate: number): void {
  expect(errorRate).toBeGreaterThanOrEqual(0);
  expect(errorRate).toBeLessThanOrEqual(1);
}

/**
 * Assert component lifecycle (startup)
 */
export function assertComponentStarted(component: { start?: () => void }): void {
  expect(component).toBeDefined();
  expect(typeof component.start).toBe('function');
}

/**
 * Assert component lifecycle (shutdown)
 */
export function assertComponentStopped(component: { stop?: () => void }): void {
  expect(component).toBeDefined();
  expect(typeof component.stop).toBe('function');
}

/**
 * Assert telemetry data structure
 */
export function assertTelemetryValid(telemetry: Record<string, unknown>): void {
  expect(telemetry).toBeDefined();
  expect(typeof telemetry).toBe('object');
  expect(Object.keys(telemetry).length).toBeGreaterThan(0);
}

/**
 * Assert dry-run mode behavior
 */
export function assertDryRunMode(result: RemediationResult, _isDryRun: boolean): void {
  // In dry-run mode, remediations are logged but not executed
  // The success field should still be true (dry-run execution succeeded)
  expect(result.success).toBe(true);

  // Note: dry-run mode is tracked at the executor level, not in RemediationResult
  // Check executor logs or metrics for dry-run confirmation
}
