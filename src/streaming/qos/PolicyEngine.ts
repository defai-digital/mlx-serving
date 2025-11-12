/**
 * QoS Policy Engine
 *
 * Loads SLO policies from configuration and evaluates violations.
 * Triggers remediation actions based on policy rules with circuit breaker protection.
 *
 * Phase 5 Week 1 Day 3-4: QoS Policy Engine Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { QosEvaluator } from './QosEvaluator.js';
import type { QosEvaluatorConfig } from './QosEvaluator.js';
import { RemediationExecutor } from './RemediationExecutor.js';
import type { RemediationExecutorConfig } from './RemediationExecutor.js';
import { SloPolicyStore } from './SloPolicyStore.js';
import type { PolicyStoreConfig } from './SloPolicyStore.js';
import type {
  QosPolicy,
  MetricSample,
  RemediationAction,
  SloEvaluation,
  RemediationResult,
} from './types.js';

/**
 * Policy Engine Configuration
 */
export interface PolicyEngineConfig {
  enabled: boolean;
  evaluationIntervalMs: number;
  dryRun?: boolean;
  evaluator: QosEvaluatorConfig;
  executor: RemediationExecutorConfig;
  policyStore: PolicyStoreConfig;
}

/**
 * Policy Engine Events
 */
export interface PolicyEngineEvents {
  policyViolation: (policy: QosPolicy, evaluation: SloEvaluation) => void;
  policyRecovery: (policy: QosPolicy, evaluation: SloEvaluation) => void;
  remediationExecuted: (policy: QosPolicy, result: RemediationResult) => void;
  remediationFailed: (
    policy: QosPolicy,
    action: RemediationAction,
    error: Error
  ) => void;
  evaluation: (evaluations: SloEvaluation[]) => void;
}

/**
 * QoS Policy Engine
 *
 * Orchestrates policy-based SLO monitoring and automated remediation:
 * 1. Loads policies from configuration
 * 2. Evaluates SLO violations using QosEvaluator
 * 3. Triggers remediation actions via RemediationExecutor
 * 4. Tracks policy state and enforcement
 *
 * Features:
 * - Dry-run mode for testing policies without executing actions
 * - Circuit breaker protection against remediation loops
 * - Priority-based policy execution
 * - Tenant/model-specific policy matching
 */
export class PolicyEngine extends EventEmitter<PolicyEngineEvents> {
  private readonly evaluator: QosEvaluator;
  private readonly executor: RemediationExecutor;
  private readonly policyStore: SloPolicyStore;
  private readonly config: PolicyEngineConfig;
  private readonly logger?: Logger;
  private evaluationTimer?: NodeJS.Timeout;
  private activePolicyViolations = new Map<string, QosPolicy>();

  constructor(config: PolicyEngineConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize components
    this.policyStore = new SloPolicyStore(config.policyStore, logger);
    this.evaluator = new QosEvaluator(config.evaluator, logger);
    this.executor = new RemediationExecutor(config.executor, logger);

    // Register SLOs from policies
    const slos = this.policyStore.getAllSlos();
    this.evaluator.registerSlos(slos);

    // Setup event forwarding
    this.setupEventForwarding();

    this.logger?.info('[PolicyEngine] Initialized with %d policies', this.policyStore.getAllPolicies().length);
  }

  /**
   * Start policy evaluation loop
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger?.info('[PolicyEngine] Disabled via configuration');
      return;
    }

    if (this.evaluationTimer) {
      this.logger?.warn('[PolicyEngine] Already started');
      return;
    }

    this.logger?.info(
      '[PolicyEngine] Starting policy evaluation loop (interval: %dms, dry-run: %s)',
      this.config.evaluationIntervalMs,
      this.config.dryRun ? 'enabled' : 'disabled'
    );

    // Start evaluator
    this.evaluator.start();

    // Start policy evaluation timer
    this.evaluationTimer = setInterval(() => {
      this.evaluatePolicies();
    }, this.config.evaluationIntervalMs);
  }

  /**
   * Stop policy evaluation loop
   */
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }

    this.evaluator.stop();

    this.logger?.info('[PolicyEngine] Stopped policy evaluation loop');
  }

  /**
   * Record a metric sample for evaluation
   */
  recordMetric(sample: MetricSample): void {
    this.evaluator.recordMetric(sample);
  }

  /**
   * Add a policy at runtime
   */
  addPolicy(policy: QosPolicy): void {
    this.policyStore.addPolicy(policy);

    // Re-register SLOs
    const slos = this.policyStore.getAllSlos();
    this.evaluator.registerSlos(slos);

    this.logger?.info('[PolicyEngine] Added policy: %s', policy.id);
  }

  /**
   * Remove a policy at runtime
   */
  removePolicy(policyId: string): boolean {
    const removed = this.policyStore.removePolicy(policyId);

    if (removed) {
      // Re-register SLOs
      const slos = this.policyStore.getAllSlos();
      this.evaluator.registerSlos(slos);

      // Clear violation state
      this.activePolicyViolations.delete(policyId);

      this.logger?.info('[PolicyEngine] Removed policy: %s', policyId);
    }

    return removed;
  }

  /**
   * Get all policies
   */
  getPolicies(): QosPolicy[] {
    return this.policyStore.getAllPolicies();
  }

  /**
   * Get the evaluator instance (for QosMonitor access)
   */
  getEvaluator(): QosEvaluator {
    return this.evaluator;
  }

  /**
   * Get the executor instance (for QosMonitor access)
   */
  getExecutor(): RemediationExecutor {
    return this.executor;
  }

  /**
   * Get the policy store instance (for QosMonitor access)
   */
  getPolicyStore(): SloPolicyStore {
    return this.policyStore;
  }

  /**
   * Get active violations
   */
  getActiveViolations(): Array<{ policy: QosPolicy; evaluation: SloEvaluation }> {
    const violations: Array<{ policy: QosPolicy; evaluation: SloEvaluation }> = [];

    for (const [_policyId, policy] of this.activePolicyViolations) {
      // Get latest evaluation for this policy's SLOs
      const evaluations = this.evaluator.evaluateAllSlos();
      const policyEval = evaluations.find((e) =>
        policy.slos.some((slo) => slo.name === e.sloName)
      );

      if (policyEval && policyEval.violated) {
        violations.push({ policy, evaluation: policyEval });
      }
    }

    return violations;
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.evaluator.clear();
    this.executor.clear();
    this.activePolicyViolations.clear();

    this.logger?.info('[PolicyEngine] Cleared all state');
  }

  /**
   * Setup event forwarding from components
   */
  private setupEventForwarding(): void {
    // Forward evaluator events
    this.evaluator.on('violation', (evaluation) => {
      this.handleViolation(evaluation);
    });

    this.evaluator.on('recovery', (evaluation) => {
      this.handleRecovery(evaluation);
    });

    this.evaluator.on('evaluation', (evaluations) => {
      try {
        this.emit('evaluation', evaluations);
      } catch (err) {
        this.logger?.error({ err }, '[PolicyEngine] Error emitting evaluation event');
      }
    });

    // Forward executor events
    this.executor.on('failed', (action, error) => {
      const policy = this.findPolicyForAction(action);
      if (policy) {
        try {
          this.emit('remediationFailed', policy, action, error);
        } catch (err) {
          this.logger?.error({ err }, '[PolicyEngine] Error emitting remediationFailed event');
        }
      }
    });
  }

  /**
   * Evaluate all active policies
   */
  private evaluatePolicies(): void {
    const policies = this.policyStore.getAllPolicies().filter((p) => p.enabled);

    this.logger?.trace('[PolicyEngine] Evaluating %d policies', policies.length);

    // Evaluator already runs its own evaluation loop,
    // so we just need to handle violations through event listeners
  }

  /**
   * Handle SLO violation
   */
  private handleViolation(evaluation: SloEvaluation): void {
    // Find matching policies
    const policies = this.policyStore.getMatchingPolicies(
      evaluation.tenantId,
      evaluation.modelId
    );

    for (const policy of policies) {
      // Check if this evaluation matches any SLO in the policy
      const matchingSlo = policy.slos.find((slo) => slo.name === evaluation.sloName);

      if (!matchingSlo) {
        continue;
      }

      // Track violation
      const violationKey = this.getPolicyViolationKey(policy, evaluation);
      if (!this.activePolicyViolations.has(violationKey)) {
        this.activePolicyViolations.set(violationKey, policy);

        try {
          this.emit('policyViolation', policy, evaluation);
        } catch (err) {
          this.logger?.error({ err }, '[PolicyEngine] Error emitting policyViolation event');
        }

        this.logger?.warn(
          '[PolicyEngine] Policy violation: %s (SLO: %s, value: %d > threshold: %d)',
          policy.name,
          evaluation.sloName,
          evaluation.currentValue,
          evaluation.threshold
        );
      }

      // Execute remediation actions
      for (const action of policy.remediations) {
        this.executeRemediation(policy, action, evaluation);
      }

      // Only execute first matching policy (highest priority)
      break;
    }
  }

  /**
   * Handle SLO recovery
   */
  private handleRecovery(evaluation: SloEvaluation): void {
    // Find policies that were previously violated
    const policies = this.policyStore.getMatchingPolicies(
      evaluation.tenantId,
      evaluation.modelId
    );

    for (const policy of policies) {
      const matchingSlo = policy.slos.find((slo) => slo.name === evaluation.sloName);

      if (!matchingSlo) {
        continue;
      }

      const violationKey = this.getPolicyViolationKey(policy, evaluation);
      if (this.activePolicyViolations.has(violationKey)) {
        this.activePolicyViolations.delete(violationKey);

        try {
          this.emit('policyRecovery', policy, evaluation);
        } catch (err) {
          this.logger?.error({ err }, '[PolicyEngine] Error emitting policyRecovery event');
        }

        this.logger?.info(
          '[PolicyEngine] Policy recovered: %s (SLO: %s, value: %d <= threshold: %d)',
          policy.name,
          evaluation.sloName,
          evaluation.currentValue,
          evaluation.threshold
        );
      }
    }
  }

  /**
   * Execute remediation action
   */
  private async executeRemediation(
    policy: QosPolicy,
    action: RemediationAction,
    evaluation: SloEvaluation
  ): Promise<void> {
    if (this.config.dryRun) {
      this.logger?.info(
        '[PolicyEngine] DRY-RUN: Would execute remediation %s for policy %s',
        action.type,
        policy.id
      );
      return;
    }

    try {
      const result = await this.executor.execute(action);

      if (result.success) {
        try {
          this.emit('remediationExecuted', policy, result);
        } catch (err) {
          this.logger?.error({ err }, '[PolicyEngine] Error emitting remediationExecuted event');
        }

        this.logger?.info(
          '[PolicyEngine] Executed remediation %s for policy %s (SLO: %s)',
          action.type,
          policy.id,
          evaluation.sloName
        );
      }
    } catch (error) {
      this.logger?.error(
        '[PolicyEngine] Failed to execute remediation %s for policy %s: %s',
        action.type,
        policy.id,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Get unique key for policy violation tracking
   */
  private getPolicyViolationKey(policy: QosPolicy, evaluation: SloEvaluation): string {
    return `${policy.id}:${evaluation.sloName}:${evaluation.tenantId || 'global'}:${evaluation.modelId || 'all'}`;
  }

  /**
   * Find policy associated with a remediation action
   */
  private findPolicyForAction(action: RemediationAction): QosPolicy | undefined {
    const policies = this.policyStore.getAllPolicies();

    for (const policy of policies) {
      const hasAction = policy.remediations.some(
        (a) => a.type === action.type && a.target === action.target
      );

      if (hasAction) {
        return policy;
      }
    }

    return undefined;
  }

  /**
   * Get remediation execution history
   */
  public getRemediationHistory(limit?: number): ReturnType<RemediationExecutor['getHistory']> {
    return this.executor.getHistory(limit);
  }

  /**
   * Reset circuit breaker for a remediation action
   */
  public resetCircuitBreaker(actionType: string): void {
    this.executor.resetCircuitBreaker(actionType);
    this.logger?.info('[PolicyEngine] Reset circuit breaker for: %s', actionType);
  }
}

/**
 * Factory function to create PolicyEngine
 */
export function createPolicyEngine(
  config: PolicyEngineConfig,
  logger?: Logger
): PolicyEngine {
  return new PolicyEngine(config, logger);
}
