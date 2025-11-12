/**
 * Throughput Policy
 *
 * Enforces SLO for token generation throughput with auto-remediation.
 * Triggers scaling actions when throughput is too low or too high.
 *
 * Phase 5 Week 1 Day 3-4: Policy Definitions
 */

import type { QosPolicy } from '../types.js';

/**
 * Minimum Throughput Policy
 *
 * SLO: Minimum throughput > 50 tokens/sec
 * Remediation: Scale up to improve throughput
 */
export const minThroughputPolicy: QosPolicy = {
  id: 'min-throughput-policy',
  name: 'Minimum Throughput Policy',
  description: 'Ensures minimum throughput of 50 tokens/sec',
  enabled: true,
  priority: 80,
  slos: [
    {
      name: 'throughput-min-50',
      metric: 'throughput',
      threshold: 50, // 50 tokens/sec minimum
      windowMs: 120000, // 2 minute window
      severity: 'warning',
    },
  ],
  remediations: [
    {
      type: 'scale_up',
      target: 'batch_queue',
      params: {
        increment: 4,
        maxBatchSize: 64,
      },
      reason: 'Throughput below minimum - scaling up batch processing',
    },
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'ops',
        severity: 'info',
      },
      reason: 'Low throughput detected',
    },
  ],
};

/**
 * Maximum Throughput Policy
 *
 * SLO: Maximum throughput < 1000 tokens/sec (to prevent overload)
 * Remediation: Throttle to prevent resource exhaustion
 */
export const maxThroughputPolicy: QosPolicy = {
  id: 'max-throughput-policy',
  name: 'Maximum Throughput Policy',
  description: 'Prevents throughput from exceeding safe limits',
  enabled: true,
  priority: 85,
  slos: [
    {
      name: 'throughput-max-1000',
      metric: 'throughput',
      threshold: 1000, // 1000 tokens/sec maximum
      windowMs: 60000, // 1 minute window
      severity: 'warning',
    },
  ],
  remediations: [
    {
      type: 'throttle',
      target: 'governor',
      params: {
        rate: 0.9, // Reduce to 90% of current rate
        duration_ms: 60000, // 1 minute
      },
      reason: 'Throughput exceeding safe limits - applying throttle',
    },
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'ops',
        severity: 'warning',
      },
      reason: 'High throughput detected - potential overload',
    },
  ],
};

/**
 * Model-specific Throughput Policy (example for large models)
 */
export const largeModelThroughputPolicy: QosPolicy = {
  id: 'large-model-throughput-policy',
  name: 'Large Model Throughput Policy',
  description: 'Adjusted throughput targets for large language models',
  enabled: false, // Disabled by default
  priority: 150,
  slos: [
    {
      name: 'large-model-throughput',
      metric: 'throughput',
      threshold: 20, // Lower minimum for large models (20 tokens/sec)
      windowMs: 120000,
      modelId: 'llama-70b', // Only applies to specific large model
      severity: 'info',
    },
  ],
  remediations: [
    {
      type: 'scale_up',
      target: 'batch_queue',
      params: {
        increment: 2,
        maxBatchSize: 16, // Smaller batches for large models
      },
      reason: 'Large model throughput below target',
    },
  ],
};
