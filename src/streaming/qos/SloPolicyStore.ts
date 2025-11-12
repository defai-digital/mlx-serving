/**
 * SLO Policy Store
 *
 * Loads and manages SLO policies from YAML configuration.
 * Supports tenant-specific and model-specific policies.
 *
 * Phase 4.4 Implementation
 */

import type { Logger } from 'pino';
import type { QosPolicy, SloDefinition } from './types.js';

/**
 * Policy store configuration
 */
export interface PolicyStoreConfig {
  policies: QosPolicy[];
}

/**
 * SLO Policy Store
 *
 * Manages QoS policies and matches them to streams based on
 * tenant ID, model ID, and other criteria.
 */
export class SloPolicyStore {
  private policies: QosPolicy[] = [];
  private logger?: Logger;

  constructor(config: PolicyStoreConfig, logger?: Logger) {
    this.logger = logger;
    this.loadPolicies(config.policies);
  }

  /**
   * Load policies from configuration
   */
  public loadPolicies(policies: QosPolicy[]): void {
    this.policies = policies.filter((p) => p.enabled);

    // Sort by priority (higher priority first)
    this.policies.sort((a, b) => b.priority - a.priority);

    this.logger?.info(
      { policyCount: this.policies.length },
      'Loaded QoS policies'
    );
  }

  /**
   * Get all SLO definitions from all policies
   */
  public getAllSlos(): SloDefinition[] {
    const slos: SloDefinition[] = [];

    for (const policy of this.policies) {
      slos.push(...policy.slos);
    }

    return slos;
  }

  /**
   * Get policies matching a specific tenant/model
   */
  public getMatchingPolicies(
    tenantId?: string,
    modelId?: string
  ): QosPolicy[] {
    return this.policies.filter((policy) => {
      // Check if policy applies to this tenant/model
      const slos = policy.slos;

      const matches = slos.some((slo) => {
        if (slo.tenantId && tenantId && slo.tenantId !== tenantId) {
          return false;
        }
        if (slo.modelId && modelId && slo.modelId !== modelId) {
          return false;
        }
        return true;
      });

      return matches;
    });
  }

  /**
   * Get all policies
   */
  public getAllPolicies(): QosPolicy[] {
    return [...this.policies];
  }

  /**
   * Add a policy
   */
  public addPolicy(policy: QosPolicy): void {
    this.policies.push(policy);
    this.policies.sort((a, b) => b.priority - a.priority);

    this.logger?.info({ policy: policy.id }, 'Added QoS policy');
  }

  /**
   * Remove a policy
   */
  public removePolicy(policyId: string): boolean {
    const index = this.policies.findIndex((p) => p.id === policyId);

    if (index !== -1) {
      this.policies.splice(index, 1);
      this.logger?.info({ policyId }, 'Removed QoS policy');
      return true;
    }

    return false;
  }

  /**
   * Update a policy
   */
  public updatePolicy(policy: QosPolicy): boolean {
    const index = this.policies.findIndex((p) => p.id === policy.id);

    if (index !== -1) {
      this.policies[index] = policy;
      this.policies.sort((a, b) => b.priority - a.priority);
      this.logger?.info({ policyId: policy.id }, 'Updated QoS policy');
      return true;
    }

    return false;
  }
}
