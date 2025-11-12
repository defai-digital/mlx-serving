/**
 * QoS Policy Definitions
 *
 * Exports all default policy configurations for SLO monitoring and remediation.
 *
 * Phase 5 Week 1 Day 3-4: Policy Definitions
 */

import type { QosPolicy } from '../types.js';

// Import policies for local use
import {
  defaultTtftPolicy,
  premiumTtftPolicy,
} from './default-ttft-policy.js';

import {
  defaultErrorRatePolicy,
  criticalErrorRatePolicy,
} from './error-rate-policy.js';

import {
  minThroughputPolicy,
  maxThroughputPolicy,
  largeModelThroughputPolicy,
} from './throughput-policy.js';

// Re-export for external use
export {
  defaultTtftPolicy,
  premiumTtftPolicy,
} from './default-ttft-policy.js';

export {
  defaultErrorRatePolicy,
  criticalErrorRatePolicy,
} from './error-rate-policy.js';

export {
  minThroughputPolicy,
  maxThroughputPolicy,
  largeModelThroughputPolicy,
} from './throughput-policy.js';

/**
 * Get all default policies (enabled only)
 */
export function getDefaultPolicies(): QosPolicy[] {
  return [
    defaultTtftPolicy,
    defaultErrorRatePolicy,
    criticalErrorRatePolicy,
    minThroughputPolicy,
    maxThroughputPolicy,
  ];
}

/**
 * Get all policies (including disabled ones)
 */
export function getAllPolicies(): QosPolicy[] {
  return [
    defaultTtftPolicy,
    premiumTtftPolicy,
    defaultErrorRatePolicy,
    criticalErrorRatePolicy,
    minThroughputPolicy,
    maxThroughputPolicy,
    largeModelThroughputPolicy,
  ];
}
