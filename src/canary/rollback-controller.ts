/**
 * Rollback Controller - Automated and manual rollback for canary deployments
 *
 * Features:
 * - Automated rollback triggers (error rate, latency, memory leaks)
 * - Manual rollback API
 * - Rollback history tracking
 * - Cooldown period to prevent flapping
 * - Gradual rollback support
 *
 * @module canary/rollback-controller
 */

import type { Logger } from 'pino';
import type { ComparisonResult } from './metrics-collector.js';
import type { CanaryRouter } from './canary-router.js';

/**
 * Rollback trigger definition
 */
export interface RollbackTrigger {
  /** Trigger name (e.g., 'high_error_rate') */
  name: string;

  /** Condition function - returns true if trigger activated */
  condition: (comparison: ComparisonResult) => boolean;

  /** Severity level */
  severity: 'warning' | 'critical';

  /** Human-readable message */
  message: string;
}

/**
 * Rollback configuration
 */
export interface RollbackConfig {
  /** Enable/disable automated rollback */
  enabled: boolean;

  /** Rollback triggers */
  triggers: RollbackTrigger[];

  /** Cooldown period (ms) to prevent flapping */
  cooldownMs: number;

  /** Enable gradual rollback (50% → 25% → 0%) */
  gradual: boolean;

  /** Gradual rollback step size (%) */
  gradualStepPercent?: number;

  /** Gradual rollback step duration (ms) */
  gradualStepDurationMs?: number;
}

/**
 * Rollback event record
 */
export interface RollbackEvent {
  /** Event timestamp (ms) */
  timestamp: number;

  /** Trigger that caused rollback */
  trigger: string;

  /** Severity level */
  severity: 'manual' | 'warning' | 'critical';

  /** Metrics at time of rollback */
  metrics: ComparisonResult;

  /** Rollback duration (ms) */
  rollbackDuration: number;

  /** Whether rollback succeeded */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Previous rollout percentage */
  previousPercentage: number;

  /** New rollout percentage (usually 0%) */
  newPercentage: number;
}

/**
 * Default rollback triggers based on Phase 5 specifications
 */
export const DEFAULT_TRIGGERS: RollbackTrigger[] = [
  {
    name: 'high_error_rate',
    condition: (c) => c.canary.errorRate > c.baseline.errorRate * 2 && c.canary.errorRate > 0.01,
    severity: 'critical',
    message: 'Canary error rate > 2x baseline',
  },
  {
    name: 'high_latency',
    condition: (c) => c.canary.latency.p95 > c.baseline.latency.p95 * 1.5,
    severity: 'critical',
    message: 'Canary P95 latency > 1.5x baseline',
  },
  {
    name: 'memory_leak',
    condition: (c) => c.canary.resources.memoryGrowthRate > 50, // 50 MB/hour
    severity: 'warning',
    message: 'Canary memory growth > 50 MB/hour',
  },
  {
    name: 'crash_rate',
    condition: (c) => c.deltas.errorRateDelta > 0.001, // 0.1% absolute increase
    severity: 'critical',
    message: 'Canary crash rate increased',
  },
];

/**
 * Rollback Controller - Automated rollback management
 */
export class RollbackController {
  private config: RollbackConfig;
  private router: CanaryRouter;
  private history: RollbackEvent[] = [];
  private lastRollbackTime: number = 0;
  private triggerViolationCounts: Map<string, number> = new Map();
  private readonly logger?: Logger;

  /**
   * Create a new RollbackController
   *
   * @param config - Rollback configuration
   * @param router - Canary router to control
   */
  constructor(config: RollbackConfig, router: CanaryRouter, logger?: Logger) {
    this.config = config;
    this.router = router;
    this.logger = logger;
  }

  /**
   * Evaluate triggers and determine if rollback is needed
   *
   * @param comparison - Latest metrics comparison
   * @returns Evaluation result
   */
  async evaluate(comparison: ComparisonResult): Promise<{
    shouldRollback: boolean;
    triggers: string[];
    severity: 'none' | 'warning' | 'critical';
  }> {
    if (!this.config.enabled) {
      return {
        shouldRollback: false,
        triggers: [],
        severity: 'none',
      };
    }

    // Check cooldown period
    if (this.isInCooldown()) {
      return {
        shouldRollback: false,
        triggers: ['In cooldown period'],
        severity: 'none',
      };
    }

    // Evaluate all triggers
    const activatedTriggers: RollbackTrigger[] = [];

    for (const trigger of this.config.triggers) {
      try {
        if (trigger.condition(comparison)) {
          activatedTriggers.push(trigger);

          // Increment violation count
          const count = (this.triggerViolationCounts.get(trigger.name) || 0) + 1;
          this.triggerViolationCounts.set(trigger.name, count);
        } else {
          // Reset violation count if not triggered
          this.triggerViolationCounts.set(trigger.name, 0);
        }
      } catch (error) {
        this.logger?.error(
          { trigger: trigger.name, error },
          'Error evaluating rollback trigger'
        );
      }
    }

    // Determine severity
    const hasCritical = activatedTriggers.some((t) => t.severity === 'critical');
    const severity = hasCritical ? 'critical' : activatedTriggers.length > 0 ? 'warning' : 'none';

    // Require 3 consecutive violations for warning triggers
    // Require 1 violation for critical triggers
    let shouldRollback = false;

    for (const trigger of activatedTriggers) {
      const count = this.triggerViolationCounts.get(trigger.name) || 0;

      if (trigger.severity === 'critical' && count >= 1) {
        shouldRollback = true;
        break;
      }

      if (trigger.severity === 'warning' && count >= 3) {
        shouldRollback = true;
        break;
      }
    }

    return {
      shouldRollback,
      triggers: activatedTriggers.map((t) => t.name),
      severity,
    };
  }

  /**
   * Execute rollback (automated or manual)
   *
   * @param reason - Rollback reason
   * @param metrics - Current metrics comparison (optional for manual rollback)
   * @returns Rollback event
   */
  async rollback(
    reason: string,
    metrics?: ComparisonResult
  ): Promise<RollbackEvent> {
    const startTime = Date.now();

    const routerConfig = this.router.getConfig();
    const previousPercentage = routerConfig.rolloutPercentage;

    const event: RollbackEvent = {
      timestamp: startTime,
      trigger: reason,
      severity: metrics ? 'critical' : 'manual',
      metrics: metrics || ({} as ComparisonResult), // Manual rollback may not have metrics
      rollbackDuration: 0,
      success: false,
      previousPercentage,
      newPercentage: 0,
    };

    try {
      if (this.config.gradual && previousPercentage > 0) {
        // Gradual rollback: 50% → 25% → 0%
        await this.executeGradualRollback(previousPercentage, event);
      } else {
        // Immediate rollback to 0%
        this.router.updatePercentage(0);
        event.newPercentage = 0;
      }

      event.success = true;
      event.rollbackDuration = Date.now() - startTime;

      // Update cooldown
      this.lastRollbackTime = Date.now();

      // Reset violation counts
      this.triggerViolationCounts.clear();

      // Log event
      this.logger?.info(
        {
          reason,
          previousPercentage,
          newPercentage: event.newPercentage,
          durationMs: event.rollbackDuration,
        },
        'Rollback executed'
      );

      // Emit notification (placeholder for Slack/email integration)
      this.emitRollbackNotification(event);
    } catch (error) {
      event.success = false;
      event.error = error instanceof Error ? error.message : String(error);
      this.logger?.error({ error }, 'Rollback failed');
    } finally {
      this.history.push(event);
    }

    return event;
  }

  /**
   * Execute gradual rollback
   *
   * @param startPercentage - Starting percentage
   * @param event - Rollback event to update
   */
  private async executeGradualRollback(
    startPercentage: number,
    event: RollbackEvent
  ): Promise<void> {
    const stepSize = this.config.gradualStepPercent || 25;
    const stepDuration = this.config.gradualStepDurationMs || 30000; // 30 seconds

    let currentPercentage = startPercentage;

    while (currentPercentage > 0) {
      currentPercentage = Math.max(0, currentPercentage - stepSize);
      this.router.updatePercentage(currentPercentage);

      this.logger?.info(
        { currentPercentage },
        'Gradual rollback step executed'
      );

      if (currentPercentage > 0) {
        await this.sleep(stepDuration);
      }
    }

    event.newPercentage = 0;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Emit rollback notification (Slack, email, etc.)
   *
   * @param event - Rollback event
   */
  private emitRollbackNotification(event: RollbackEvent): void {
    // Placeholder for notification integration
    // In production, send to Slack, PagerDuty, email, etc.

    const notification = {
      type: 'rollback',
      severity: event.severity,
      trigger: event.trigger,
      previousPercentage: event.previousPercentage,
      newPercentage: event.newPercentage,
      duration: event.rollbackDuration,
      timestamp: new Date(event.timestamp).toISOString(),
    };

    this.logger?.info({ notification }, 'Rollback notification emitted');

    // TODO: Integrate with Slack API
    // await sendSlackNotification(notification);

    // TODO: Integrate with email
    // await sendEmailNotification(notification);
  }

  /**
   * Get rollback history
   *
   * @param limit - Maximum number of events to return (default: all)
   * @returns Rollback events
   */
  getHistory(limit?: number): RollbackEvent[] {
    const sorted = [...this.history].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Check if in cooldown period
   *
   * @returns True if in cooldown
   */
  isInCooldown(): boolean {
    if (this.lastRollbackTime === 0) {
      return false;
    }

    const elapsed = Date.now() - this.lastRollbackTime;
    return elapsed < this.config.cooldownMs;
  }

  /**
   * Get cooldown remaining time (ms)
   *
   * @returns Remaining cooldown time (ms), or 0 if not in cooldown
   */
  getCooldownRemaining(): number {
    if (!this.isInCooldown()) {
      return 0;
    }

    const elapsed = Date.now() - this.lastRollbackTime;
    return Math.max(0, this.config.cooldownMs - elapsed);
  }

  /**
   * Update rollback configuration
   *
   * @param newConfig - New configuration
   */
  updateConfig(newConfig: Partial<RollbackConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<RollbackConfig> {
    return { ...this.config };
  }

  /**
   * Get trigger violation counts
   *
   * @returns Map of trigger name to violation count
   */
  getTriggerViolationCounts(): Map<string, number> {
    return new Map(this.triggerViolationCounts);
  }

  /**
   * Reset controller state (useful for testing)
   */
  reset(): void {
    this.history = [];
    this.lastRollbackTime = 0;
    this.triggerViolationCounts.clear();
  }
}
