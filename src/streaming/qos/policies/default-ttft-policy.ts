/**
 * Default TTFT (Time To First Token) Policy
 *
 * Enforces SLO for time to first token with auto-remediation.
 * Triggers scale-up when TTFT exceeds threshold.
 *
 * Phase 5 Week 1 Day 3-4: Policy Definitions
 */

import type { QosPolicy } from '../types.js';

/**
 * Default TTFT Policy
 *
 * SLO: P95 TTFT < 200ms
 * Remediation: Scale up batch queue on violation
 */
export const defaultTtftPolicy: QosPolicy = {
  id: 'default-ttft-policy',
  name: 'Default TTFT Policy',
  description: 'Ensures P95 time-to-first-token stays below 200ms',
  enabled: true,
  priority: 100,
  slos: [
    {
      name: 'ttft-p95',
      metric: 'ttft',
      threshold: 200, // 200ms
      windowMs: 60000, // 1 minute window
      severity: 'warning',
    },
    {
      name: 'ttft-p95-critical',
      metric: 'ttft',
      threshold: 500, // 500ms - critical threshold
      windowMs: 60000,
      severity: 'critical',
    },
  ],
  remediations: [
    {
      type: 'scale_up',
      target: 'batch_queue',
      params: {
        increment: 2,
        maxBatchSize: 32,
      },
      reason: 'TTFT exceeded threshold - scaling up batch queue',
    },
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'ops',
        severity: 'warning',
      },
      reason: 'TTFT SLO violation detected',
    },
  ],
};

/**
 * Tenant-specific TTFT policy (example)
 */
export const premiumTtftPolicy: QosPolicy = {
  id: 'premium-ttft-policy',
  name: 'Premium Tier TTFT Policy',
  description: 'Stricter TTFT requirements for premium customers',
  enabled: false, // Disabled by default
  priority: 200, // Higher priority than default
  slos: [
    {
      name: 'premium-ttft-p95',
      metric: 'ttft',
      threshold: 100, // 100ms - stricter for premium
      windowMs: 60000,
      tenantId: 'premium', // Only applies to premium tenant
      severity: 'critical',
    },
  ],
  remediations: [
    {
      type: 'scale_up',
      target: 'batch_queue',
      params: {
        increment: 4, // More aggressive scaling
        maxBatchSize: 64,
      },
      reason: 'Premium TTFT SLO violation - priority scaling',
    },
    {
      type: 'alert',
      target: 'governor',
      params: {
        channel: 'premium-ops',
        severity: 'critical',
        pagerDuty: true,
      },
      reason: 'Premium customer TTFT SLO violation',
    },
  ],
};
