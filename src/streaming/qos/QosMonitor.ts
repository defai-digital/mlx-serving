/**
 * QoS Monitor
 *
 * Main coordinator for Stream Quality of Service monitoring.
 * Integrates evaluator, executor, and policy store.
 *
 * Phase 4.4 Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { QosEvaluator } from './QosEvaluator.js';
import type { QosEvaluatorConfig, QosEvaluatorEvents } from './QosEvaluator.js';
import { RemediationExecutor } from './RemediationExecutor.js';
import type {
  RemediationExecutorConfig,
  RemediationExecutorEvents,
} from './RemediationExecutor.js';
import { SloPolicyStore } from './SloPolicyStore.js';
import type { PolicyStoreConfig } from './SloPolicyStore.js';
import { PolicyEngine } from './PolicyEngine.js';
import type { PolicyEngineConfig, PolicyEngineEvents } from './PolicyEngine.js';
import type {
  MetricSample,
  SloEvaluation,
  RemediationResult,
  QosTelemetry,
  QosPolicy,
} from './types.js';

/**
 * Monitor configuration
 */
export interface QosMonitorConfig {
  enabled: boolean;
  evaluator: QosEvaluatorConfig;
  executor: RemediationExecutorConfig;
  policyStore: PolicyStoreConfig;
  usePolicyEngine?: boolean; // Phase 5 Week 1 Day 3-4: Enable PolicyEngine integration
}

/**
 * Monitor events
 */
export interface QosMonitorEvents extends QosEvaluatorEvents, RemediationExecutorEvents, PolicyEngineEvents {
  telemetry: (snapshot: QosTelemetry) => void;
}

/**
 * QoS Monitor
 *
 * Orchestrates SLO monitoring and automated remediation:
 * 1. Collects metrics from streams
 * 2. Evaluates SLO violations
 * 3. Executes remediations when needed
 * 4. Emits telemetry snapshots
 */
export class QosMonitor extends EventEmitter<QosMonitorEvents> {
  private config: QosMonitorConfig;
  private logger?: Logger;
  private evaluator: QosEvaluator;
  private executor: RemediationExecutor;
  private policyStore: SloPolicyStore;
  private policyEngine?: PolicyEngine; // Phase 5 Week 1 Day 3-4: Optional PolicyEngine
  private lastEvaluations: SloEvaluation[] = [];
  private lastRemediations: RemediationResult[] = [];

  constructor(config: QosMonitorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Phase 5 Week 1 Day 3-4: Use PolicyEngine if enabled
    if (config.usePolicyEngine) {
      const policyEngineConfig: PolicyEngineConfig = {
        enabled: config.enabled,
        evaluationIntervalMs: config.evaluator.evaluationIntervalMs,
        dryRun: config.executor.enabled === false,
        evaluator: config.evaluator,
        executor: config.executor,
        policyStore: config.policyStore,
      };

      this.policyEngine = new PolicyEngine(policyEngineConfig, logger);

      // BUG FIX: Get component references FROM PolicyEngine instead of creating new instances
      // This prevents memory leaks and ensures we use the same instances that PolicyEngine uses
      this.policyStore = this.policyEngine.getPolicyStore();
      this.evaluator = this.policyEngine.getEvaluator();
      this.executor = this.policyEngine.getExecutor();

      // Forward PolicyEngine events
      this.setupPolicyEngineEventForwarding();

      this.logger?.info('QoS monitor initialized with PolicyEngine');
    } else {
      // Legacy mode: Direct component usage
      this.policyStore = new SloPolicyStore(config.policyStore, logger);
      this.evaluator = new QosEvaluator(config.evaluator, logger);
      this.executor = new RemediationExecutor(config.executor, logger);

      // Register SLOs from policies
      const slos = this.policyStore.getAllSlos();
      this.evaluator.registerSlos(slos);

      // Forward events
      this.setupEventForwarding();

      this.logger?.info('QoS monitor initialized (legacy mode)');
    }
  }

  /**
   * Start monitoring
   */
  public start(): void {
    if (!this.config.enabled) {
      this.logger?.info('QoS monitor disabled');
      return;
    }

    if (this.policyEngine) {
      this.policyEngine.start();
    } else {
      this.evaluator.start();
    }

    this.logger?.info('Started QoS monitor');
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    if (this.policyEngine) {
      this.policyEngine.stop();
    } else {
      this.evaluator.stop();
    }

    this.logger?.info('Stopped QoS monitor');
  }

  /**
   * Record a metric sample
   */
  public recordMetric(sample: MetricSample): void {
    if (this.policyEngine) {
      this.policyEngine.recordMetric(sample);
    } else {
      this.evaluator.recordMetric(sample);
    }
  }

  /**
   * Get telemetry snapshot
   */
  public getTelemetry(): QosTelemetry {
    const stats = this.evaluator.getAllStats();

    const snapshot: QosTelemetry = {
      timestamp: Date.now(),
      sloEvaluations: this.lastEvaluations,
      metricStats: stats,
      remediations: this.lastRemediations.slice(-10), // Last 10 remediations
      activeViolations: this.evaluator.getActiveViolationCount(),
      totalStreams: 0, // Would be populated from StreamRegistry
    };

    return snapshot;
  }

  /**
   * Add a policy
   */
  public addPolicy(policy: QosPolicy): void {
    // BUG FIX: Use PolicyEngine's addPolicy if available
    if (this.policyEngine) {
      this.policyEngine.addPolicy(policy);
    } else {
      this.policyStore.addPolicy(policy);

      // Re-register SLOs
      const slos = this.policyStore.getAllSlos();
      this.evaluator.registerSlos(slos);
    }

    this.logger?.info({ policyId: policy.id }, 'Added QoS policy');
  }

  /**
   * Remove a policy
   */
  public removePolicy(policyId: string): boolean {
    let removed: boolean;

    // BUG FIX: Use PolicyEngine's removePolicy if available
    if (this.policyEngine) {
      removed = this.policyEngine.removePolicy(policyId);
    } else {
      removed = this.policyStore.removePolicy(policyId);

      if (removed) {
        // Re-register SLOs
        const slos = this.policyStore.getAllSlos();
        this.evaluator.registerSlos(slos);
      }
    }

    if (removed) {
      this.logger?.info({ policyId }, 'Removed QoS policy');
    }

    return removed;
  }

  /**
   * Get all policies
   */
  public getPolicies(): QosPolicy[] {
    return this.policyStore.getAllPolicies();
  }

  /**
   * Clear all state
   */
  public clear(): void {
    if (this.policyEngine) {
      this.policyEngine.clear();
    } else {
      this.evaluator.clear();
      this.executor.clear();
    }

    this.lastEvaluations = [];
    this.lastRemediations = [];

    this.logger?.info('Cleared QoS monitor state');
  }

  /**
   * Setup event forwarding from components
   */
  private setupEventForwarding(): void {
    // Forward evaluator events
    this.evaluator.on('violation', (evaluation) => {
      this.handleViolation(evaluation);

      try {
        this.emit('violation', evaluation);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting violation event');
      }
    });

    this.evaluator.on('recovery', (evaluation) => {
      try {
        this.emit('recovery', evaluation);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting recovery event');
      }
    });

    this.evaluator.on('evaluation', (evaluations) => {
      this.lastEvaluations = evaluations;

      try {
        this.emit('evaluation', evaluations);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting evaluation event');
      }

      // Emit telemetry snapshot
      try {
        this.emit('telemetry', this.getTelemetry());
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting telemetry event');
      }
    });

    // Forward executor events
    this.executor.on('executed', (result) => {
      this.lastRemediations.push(result);

      try {
        this.emit('executed', result);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting executed event');
      }
    });

    this.executor.on('failed', (action, error) => {
      try {
        this.emit('failed', action, error);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting failed event');
      }
    });

    this.executor.on('loopDetected', (actionType) => {
      try {
        this.emit('loopDetected', actionType);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting loopDetected event');
      }
    });

    this.executor.on('rateLimited', (actionType) => {
      try {
        this.emit('rateLimited', actionType);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting rateLimited event');
      }
    });
  }

  /**
   * Setup event forwarding from PolicyEngine (Phase 5 Week 1 Day 3-4)
   */
  private setupPolicyEngineEventForwarding(): void {
    if (!this.policyEngine) {
      return;
    }

    // Forward policy violation events
    this.policyEngine.on('policyViolation', (policy, evaluation) => {
      try {
        this.emit('violation', evaluation);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting violation event from PolicyEngine');
      }
    });

    // Forward policy recovery events
    this.policyEngine.on('policyRecovery', (policy, evaluation) => {
      try {
        this.emit('recovery', evaluation);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting recovery event from PolicyEngine');
      }
    });

    // Forward remediation executed events
    this.policyEngine.on('remediationExecuted', (policy, result) => {
      this.lastRemediations.push(result);

      try {
        this.emit('executed', result);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting executed event from PolicyEngine');
      }
    });

    // Forward remediation failed events
    this.policyEngine.on('remediationFailed', (policy, action, error) => {
      try {
        this.emit('failed', action, error);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting failed event from PolicyEngine');
      }
    });

    // Forward evaluation events
    this.policyEngine.on('evaluation', (evaluations) => {
      this.lastEvaluations = evaluations;

      try {
        this.emit('evaluation', evaluations);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting evaluation event from PolicyEngine');
      }

      // Emit telemetry snapshot
      try {
        this.emit('telemetry', this.getTelemetry());
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting telemetry event');
      }
    });
  }

  /**
   * Handle SLO violation
   */
  private handleViolation(evaluation: SloEvaluation): void {
    if (!this.config.executor.enabled) {
      return;
    }

    // Find matching policies
    const policies = this.policyStore.getMatchingPolicies(
      evaluation.tenantId,
      evaluation.modelId
    );

    // Execute remediations from matching policies
    for (const policy of policies) {
      // Find SLO in policy
      const slo = policy.slos.find((s) => s.name === evaluation.sloName);
      if (!slo) {
        continue;
      }

      // Execute remediations
      for (const action of policy.remediations) {
        this.executor.execute(action).catch((err) => {
          this.logger?.error(
            { err, action, policy: policy.id },
            'Failed to execute remediation'
          );
        });
      }

      // Only execute first matching policy
      break;
    }
  }
}
