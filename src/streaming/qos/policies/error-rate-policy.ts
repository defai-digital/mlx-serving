/**
 * Error Rate Policy
 *
 * Enforces SLO for error rate with auto-remediation.
 * Triggers alerts and throttling when error rate exceeds threshold.
 *
 * Phase 5 Week 1 Day 3-4: Policy Definitions
 */

import type { QosPolicy } from '../types.js';

/**
 * Default Error Rate Policy
 *
 * SLO: Error rate < 1%
 * Remediation: Alert and throttle on violation
 */
export const defaultErrorRatePolicy: QosPolicy = {
  id: 'default-error-rate-policy',
  name: 'Default Error Rate Policy',
  description: 'Ensures error rate stays below 1%',
  enabled: true,
  priority: 90,
  slos: [
    {
      name: 'error-rate-1pct',
      metric: 'error_rate',
      threshold: 0.01, // 1%
      windowMs: 300000, // 5 minute window
      severity: 'warning',
    },
    {
      name: 'error-rate-5pct-critical',
      metric: 'error_rate',
      threshold: 0.05, // 5% - critical threshold
      windowMs: 300000,
      severity: 'critical',
    },
  ],
  remediations: [
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'ops',
        severity: 'warning',
      },
      reason: 'Error rate exceeded threshold',
    },
    {
      type: 'throttle',
      target: 'governor',
      params: {
        rate: 0.8, // Reduce to 80% of current rate
        duration_ms: 300000, // 5 minutes
      },
      reason: 'High error rate detected - throttling to reduce load',
    },
  ],
};

/**
 * Critical Error Rate Policy
 *
 * Triggers more aggressive remediation for very high error rates
 */
export const criticalErrorRatePolicy: QosPolicy = {
  id: 'critical-error-rate-policy',
  name: 'Critical Error Rate Policy',
  description: 'Handles extremely high error rates (>10%)',
  enabled: true,
  priority: 95, // Higher priority than default
  slos: [
    {
      name: 'error-rate-10pct-critical',
      metric: 'error_rate',
      threshold: 0.1, // 10%
      windowMs: 60000, // 1 minute window (shorter for critical)
      severity: 'critical',
    },
  ],
  remediations: [
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'ops',
        severity: 'critical',
        pagerDuty: true,
      },
      reason: 'Critical error rate exceeded 10%',
    },
    {
      type: 'restart',
      target: 'python_runtime',
      params: {
        graceful: true,
        timeout_ms: 30000,
      },
      reason: 'Restarting Python runtime due to critical error rate',
    },
  ],
};
