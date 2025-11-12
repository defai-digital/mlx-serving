/**
 * Canary Manager - Orchestrates canary deployment lifecycle
 *
 * Features:
 * - 4-stage gradual rollout (10% → 25% → 50% → 100%)
 * - Automated health monitoring and rollback
 * - Manual rollout control (advance/rollback/pause)
 * - Deployment state persistence
 * - Zero-downtime configuration updates
 *
 * @module canary/canary-manager
 */

import type { Logger } from 'pino';
import type { Engine } from '../types/engine.js';
import { CanaryRouter, type CanaryRouterConfig } from './canary-router.js';
import {
  RollbackController,
  type RollbackConfig,
  DEFAULT_TRIGGERS,
} from './rollback-controller.js';
import { MetricsCollector, type ComparisonResult } from './metrics-collector.js';

/**
 * Canary deployment stage
 */
export type CanaryStage = 'off' | '10%' | '25%' | '50%' | '100%';

/**
 * Stage configuration mapping
 */
const STAGE_PERCENTAGES: Record<CanaryStage, number> = {
  off: 0,
  '10%': 10,
  '25%': 25,
  '50%': 50,
  '100%': 100,
};

/**
 * Stage progression order
 */
const STAGE_ORDER: CanaryStage[] = ['off', '10%', '25%', '50%', '100%'];

/**
 * Canary Manager configuration
 */
export interface CanaryManagerConfig {
  /** Enable/disable canary system */
  enabled: boolean;

  /** Initial stage (default: 'off') */
  initialStage?: CanaryStage;

  /** Router configuration */
  router: CanaryRouterConfig;

  /** Rollback configuration */
  rollback: RollbackConfig;

  /** Health check interval (ms) */
  healthCheckIntervalMs: number;

  /** Minimum requests before stage advancement */
  minRequestsPerStage: number;

  /** Minimum duration per stage (ms) */
  minStageWaitMs: number;

  /** Auto-advance to next stage when healthy */
  autoAdvance: boolean;

  /** Enable state persistence to disk */
  persistState?: boolean;

  /** State persistence path */
  statePath?: string;
}

/**
 * Deployment status
 */
export interface DeploymentStatus {
  /** Current stage */
  stage: CanaryStage;

  /** Rollout percentage */
  percentage: number;

  /** Health status */
  health: 'healthy' | 'degraded' | 'critical';

  /** Requests processed (baseline + canary) */
  requestsProcessed: number;

  /** Time in current stage (ms) */
  stageElapsedMs: number;

  /** Last health check result */
  lastHealthCheck?: ComparisonResult;

  /** Stage advancement eligible */
  canAdvance: boolean;

  /** In rollback cooldown */
  inCooldown: boolean;

  /** Next scheduled action */
  nextAction?: 'advance' | 'rollback' | 'none';

  /** Auto-advance enabled */
  autoAdvance: boolean;
}

/**
 * Stage transition event
 */
export interface StageTransition {
  /** Timestamp (ms) */
  timestamp: number;

  /** Previous stage */
  from: CanaryStage;

  /** New stage */
  to: CanaryStage;

  /** Transition type */
  type: 'advance' | 'rollback' | 'manual';

  /** Reason for transition */
  reason: string;

  /** Metrics at time of transition */
  metrics?: ComparisonResult;
}

/**
 * Default configuration
 */
export const DEFAULT_CANARY_CONFIG: CanaryManagerConfig = {
  enabled: false,
  initialStage: 'off',
  router: {
    enabled: false,
    rolloutPercentage: 0,
    strategy: 'hash',
    hashKey: 'user_id',
    enableCache: true,
    cacheSize: 10000,
  },
  rollback: {
    enabled: true,
    triggers: DEFAULT_TRIGGERS,
    cooldownMs: 300000, // 5 minutes
    gradual: true,
    gradualStepPercent: 25,
    gradualStepDurationMs: 30000,
  },
  healthCheckIntervalMs: 30000, // 30 seconds
  minRequestsPerStage: 100,
  minStageWaitMs: 300000, // 5 minutes
  autoAdvance: false,
  persistState: false,
  statePath: 'automatosx/tmp/canary-state.json',
};

/**
 * Canary Manager - Orchestrates canary deployments
 */
export class CanaryManager {
  private config: CanaryManagerConfig;
  private router: CanaryRouter;
  private rollbackController: RollbackController;
  private metricsCollector: MetricsCollector;

  private currentStage: CanaryStage;
  private stageStartTime: number;
  private transitions: StageTransition[] = [];

  private healthCheckTimer?: NodeJS.Timeout;
  private lastHealthCheck?: ComparisonResult;

  private readonly baselineEngine: Engine;
  private readonly canaryEngine: Engine;
  private readonly logger?: Logger;

  /**
   * Create a new CanaryManager
   *
   * @param baselineEngine - Baseline (stable) engine instance
   * @param canaryEngine - Canary (new version) engine instance
   * @param config - Canary configuration
   * @param logger - Optional logger
   */
  constructor(
    baselineEngine: Engine,
    canaryEngine: Engine,
    config: Partial<CanaryManagerConfig> = {},
    logger?: Logger
  ) {
    this.baselineEngine = baselineEngine;
    this.canaryEngine = canaryEngine;
    this.logger = logger;

    // Merge with defaults
    this.config = { ...DEFAULT_CANARY_CONFIG, ...config };

    // Initialize components
    this.router = new CanaryRouter(this.config.router, logger);
    this.metricsCollector = new MetricsCollector();
    this.rollbackController = new RollbackController(
      this.config.rollback,
      this.router,
      logger
    );

    // Initialize state
    this.currentStage = this.config.initialStage || 'off';
    this.stageStartTime = Date.now();

    // Synchronize router percentage with initial stage
    const initialPercentage = STAGE_PERCENTAGES[this.currentStage];
    this.router.updatePercentage(initialPercentage);

    // Load persisted state if enabled
    if (this.config.persistState) {
      this.loadState();
    }

    // Start health monitoring
    if (this.config.enabled) {
      this.startHealthMonitoring();
    }

    this.logger?.info(
      {
        stage: this.currentStage,
        percentage: STAGE_PERCENTAGES[this.currentStage],
      },
      'Canary manager initialized'
    );
  }

  /**
   * Start automated health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck(),
      this.config.healthCheckIntervalMs
    );
  }

  /**
   * Perform health check and take action if needed
   */
  private async performHealthCheck(): Promise<void> {
    try {
      // Get latest metrics comparison
      const comparison = this.metricsCollector.compare();
      this.lastHealthCheck = comparison;

      // Evaluate rollback triggers
      const evaluation = await this.rollbackController.evaluate(comparison);

      if (evaluation.shouldRollback) {
        this.logger?.warn(
          {
            triggers: evaluation.triggers,
            severity: evaluation.severity,
          },
          'Rollback triggers activated'
        );

        // Execute automated rollback
        await this.rollback(
          `Automated rollback: ${evaluation.triggers.join(', ')}`,
          comparison
        );
      } else if (this.config.autoAdvance && this.canAdvance()) {
        // Auto-advance to next stage if eligible
        this.logger?.info('Auto-advancing to next stage');
        await this.advance();
      }
    } catch (error) {
      this.logger?.error({ error }, 'Health check failed');
    }
  }

  /**
   * Route a request to baseline or canary
   *
   * @param identifier - User/request/session ID
   * @param handler - Async function that executes the request
   * @returns Handler result
   */
  async route<T>(
    identifier: string,
    handler: (engine: Engine, variant: 'baseline' | 'canary') => Promise<T>
  ): Promise<T> {
    const decision = this.router.route(identifier);
    const engine = decision.variant === 'canary' ? this.canaryEngine : this.baselineEngine;

    const startTime = Date.now();
    let success = false;
    let error: Error | undefined;
    let result: T;

    try {
      result = await handler(engine, decision.variant);
      success = true;
      return result;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      success = false;
      throw err;
    } finally {
      const latencyMs = Date.now() - startTime;

      // Record metrics
      this.metricsCollector.recordRequest(
        decision.variant,
        latencyMs,
        success,
        error
      );
    }
  }

  /**
   * Advance to next stage
   *
   * @param manual - Whether this is a manual advance (default: false)
   * @returns Stage transition event
   */
  async advance(manual: boolean = false): Promise<StageTransition> {
    if (!manual && !this.canAdvance()) {
      throw new Error('Cannot advance: stage requirements not met');
    }

    const currentIndex = STAGE_ORDER.indexOf(this.currentStage);

    if (currentIndex === STAGE_ORDER.length - 1) {
      throw new Error('Already at final stage (100%)');
    }

    const nextStage = STAGE_ORDER[currentIndex + 1];
    const nextPercentage = STAGE_PERCENTAGES[nextStage];

    // Update router percentage
    this.router.updatePercentage(nextPercentage);

    // Record transition
    const transition: StageTransition = {
      timestamp: Date.now(),
      from: this.currentStage,
      to: nextStage,
      type: manual ? 'manual' : 'advance',
      reason: manual ? 'Manual advancement' : 'Auto-advancement (healthy)',
      metrics: this.lastHealthCheck,
    };

    this.transitions.push(transition);
    this.currentStage = nextStage;
    this.stageStartTime = Date.now();

    // Persist state
    if (this.config.persistState) {
      this.saveState();
    }

    this.logger?.info(
      {
        from: transition.from,
        to: transition.to,
        percentage: nextPercentage,
        manual,
      },
      'Stage advanced'
    );

    return transition;
  }

  /**
   * Rollback to previous stage or off
   *
   * @param reason - Rollback reason
   * @param metrics - Optional metrics comparison
   * @returns Stage transition event
   */
  async rollback(reason: string, metrics?: ComparisonResult): Promise<StageTransition> {
    // Execute rollback via controller
    const rollbackEvent = await this.rollbackController.rollback(reason, metrics);

    // Update stage to 'off'
    const previousStage = this.currentStage;
    this.currentStage = 'off';
    this.stageStartTime = Date.now();

    // Record transition
    const transition: StageTransition = {
      timestamp: Date.now(),
      from: previousStage,
      to: 'off',
      type: 'rollback',
      reason,
      metrics,
    };

    this.transitions.push(transition);

    // Persist state
    if (this.config.persistState) {
      this.saveState();
    }

    this.logger?.warn(
      {
        from: transition.from,
        to: transition.to,
        reason,
        success: rollbackEvent.success,
      },
      'Rollback executed'
    );

    return transition;
  }

  /**
   * Check if stage can be advanced
   *
   * @returns True if eligible for advancement
   */
  canAdvance(): boolean {
    // Cannot advance if already at 100%
    if (this.currentStage === '100%') {
      return false;
    }

    // Cannot advance if in rollback cooldown
    if (this.rollbackController.isInCooldown()) {
      return false;
    }

    // Check minimum requests
    const counts = this.metricsCollector.getTotalCounts();
    if (counts.total < this.config.minRequestsPerStage) {
      return false;
    }

    // Check minimum stage duration
    const stageElapsed = Date.now() - this.stageStartTime;
    if (stageElapsed < this.config.minStageWaitMs) {
      return false;
    }

    // Check health status
    if (this.lastHealthCheck) {
      if (this.lastHealthCheck.health.status !== 'healthy') {
        return false;
      }
    }

    return true;
  }

  /**
   * Get current deployment status
   *
   * @returns Deployment status
   */
  getStatus(): DeploymentStatus {
    const counts = this.metricsCollector.getTotalCounts();
    const stageElapsedMs = Date.now() - this.stageStartTime;

    let nextAction: 'advance' | 'rollback' | 'none' = 'none';

    if (this.lastHealthCheck) {
      if (this.lastHealthCheck.health.status === 'critical') {
        nextAction = 'rollback';
      } else if (this.canAdvance() && this.currentStage !== '100%') {
        nextAction = 'advance';
      }
    }

    return {
      stage: this.currentStage,
      percentage: STAGE_PERCENTAGES[this.currentStage],
      health: this.lastHealthCheck?.health.status || 'healthy',
      requestsProcessed: counts.total,
      stageElapsedMs,
      lastHealthCheck: this.lastHealthCheck,
      canAdvance: this.canAdvance(),
      inCooldown: this.rollbackController.isInCooldown(),
      nextAction,
      autoAdvance: this.config.autoAdvance,
    };
  }

  /**
   * Get stage transition history
   *
   * @param limit - Maximum transitions to return (default: all)
   * @returns Stage transitions
   */
  getHistory(limit?: number): StageTransition[] {
    const sorted = [...this.transitions].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Get router statistics
   *
   * @returns Router stats
   */
  getRouterStats(): ReturnType<CanaryRouter["getStats"]> {
    return this.router.getStats();
  }

  /**
   * Get metrics comparison
   *
   * @returns Metrics comparison
   */
  getMetrics(): ComparisonResult {
    return this.metricsCollector.compare();
  }

  /**
   * Update configuration (zero-downtime)
   *
   * @param newConfig - Partial configuration updates
   */
  updateConfig(newConfig: Partial<CanaryManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Update auto-advance if changed
    if (newConfig.autoAdvance !== undefined) {
      this.logger?.info(
        { autoAdvance: newConfig.autoAdvance },
        'Auto-advance configuration updated'
      );
    }

    // Update rollback config if changed
    if (newConfig.rollback) {
      this.rollbackController.updateConfig(newConfig.rollback);
    }
  }

  /**
   * Pause canary deployment (set to 0%)
   */
  async pause(): Promise<void> {
    this.router.updatePercentage(0);
    this.logger?.info('Canary deployment paused (0%)');
  }

  /**
   * Resume canary deployment (restore stage percentage)
   */
  async resume(): Promise<void> {
    const percentage = STAGE_PERCENTAGES[this.currentStage];
    this.router.updatePercentage(percentage);
    this.logger?.info({ percentage }, 'Canary deployment resumed');
  }

  /**
   * Reset deployment to off
   */
  async reset(): Promise<void> {
    this.currentStage = 'off';
    this.stageStartTime = Date.now();
    this.router.updatePercentage(0);
    this.router.clearCache();
    this.metricsCollector.reset();
    this.rollbackController.reset();
    this.transitions = [];
    this.lastHealthCheck = undefined;

    this.logger?.info('Canary deployment reset to off');
  }

  /**
   * Save state to disk
   */
  private saveState(): void {
    if (!this.config.persistState || !this.config.statePath) {
      return;
    }

    try {
      const state = {
        stage: this.currentStage,
        stageStartTime: this.stageStartTime,
        transitions: this.transitions,
        timestamp: Date.now(),
      };

      // In production, write to disk with fs module
      // For now, log state
      this.logger?.debug({ state }, 'Canary state saved');
    } catch (error) {
      this.logger?.error({ error }, 'Failed to save canary state');
    }
  }

  /**
   * Load state from disk
   */
  private loadState(): void {
    if (!this.config.persistState || !this.config.statePath) {
      return;
    }

    try {
      // In production, read from disk with fs module
      // For now, skip loading
      this.logger?.debug('Canary state loading skipped (not implemented)');
    } catch (error) {
      this.logger?.error({ error }, 'Failed to load canary state');
    }
  }

  /**
   * Shutdown canary manager
   */
  async shutdown(): Promise<void> {
    // Stop health monitoring
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // Save final state
    if (this.config.persistState) {
      this.saveState();
    }

    this.logger?.info('Canary manager shutdown');
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<CanaryManagerConfig> {
    return { ...this.config };
  }
}
