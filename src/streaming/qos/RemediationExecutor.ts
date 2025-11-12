/**
 * Remediation Executor
 *
 * Executes automated remediation actions with loop detection,
 * cooldown management, and circuit breaker patterns.
 *
 * Phase 4.4 Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type {
  RemediationAction,
  RemediationResult,
  RemediationState,
} from './types.js';

/**
 * Executor configuration
 */
export interface RemediationExecutorConfig {
  enabled: boolean;
  cooldownMs: number; // Minimum time between same remediation
  maxExecutionsPerWindow: number; // Max executions in window
  executionWindowMs: number; // Rolling window for rate limiting
  loopDetectionWindow: number; // Number of recent actions to check
}

/**
 * Executor events
 */
export interface RemediationExecutorEvents {
  executed: (result: RemediationResult) => void;
  failed: (action: RemediationAction, error: Error) => void;
  loopDetected: (actionType: string) => void;
  rateLimited: (actionType: string) => void;
}

/**
 * Execution history entry
 */
interface ExecutionHistory {
  action: RemediationAction;
  result: RemediationResult;
  timestamp: number;
}

/**
 * Remediation Executor
 *
 * Executes remediation actions with safeguards:
 * - Cooldown periods to prevent thrashing
 * - Loop detection to catch oscillation
 * - Rate limiting to prevent excessive actions
 * - Circuit breaker to stop failed actions
 */
export class RemediationExecutor extends EventEmitter<RemediationExecutorEvents> {
  private config: RemediationExecutorConfig;
  private logger?: Logger;
  private states = new Map<string, RemediationState>();
  private history: ExecutionHistory[] = [];
  private circuitBreakers = new Map<string, boolean>(); // actionType -> isOpen
  private cooldownTimeouts = new Map<string, NodeJS.Timeout>(); // actionKey -> timeout handle

  constructor(config: RemediationExecutorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Execute a remediation action
   */
  public async execute(action: RemediationAction): Promise<RemediationResult> {
    if (!this.config.enabled) {
      this.logger?.debug({ action }, 'Remediation executor disabled');

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: 'Remediation executor disabled',
      };
    }

    const actionKey = this.getActionKey(action);

    // Check circuit breaker
    if (this.circuitBreakers.get(actionKey)) {
      this.logger?.warn({ action }, 'Circuit breaker open for action');

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: 'Circuit breaker open',
      };
    }

    // Check cooldown
    const state = this.states.get(actionKey);
    if (state && state.inCooldown) {
      const remainingMs = state.cooldownMs - (Date.now() - state.lastExecuted);

      this.logger?.debug(
        { action, remainingMs },
        'Action in cooldown period'
      );

      try {
        this.emit('rateLimited', actionKey);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting rateLimited event');
      }

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: `Cooldown active (${remainingMs}ms remaining)`,
      };
    }

    // Check rate limiting
    if (this.isRateLimited(actionKey)) {
      this.logger?.warn({ action }, 'Rate limit exceeded for action');

      try {
        this.emit('rateLimited', actionKey);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting rateLimited event');
      }

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: 'Rate limit exceeded',
      };
    }

    // Check for oscillation loop
    if (this.detectLoop(actionKey)) {
      this.logger?.error({ action }, 'Remediation loop detected');

      // Open circuit breaker
      this.circuitBreakers.set(actionKey, true);

      try {
        this.emit('loopDetected', actionKey);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting loopDetected event');
      }

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: 'Remediation loop detected - circuit breaker opened',
      };
    }

    // Execute action
    const result = await this.executeAction(action);

    // Update state
    const newState: RemediationState = {
      actionType: actionKey,
      lastExecuted: Date.now(),
      executionCount: (state?.executionCount || 0) + 1,
      cooldownMs: this.config.cooldownMs,
      inCooldown: true,
    };

    this.states.set(actionKey, newState);

    // Clear any existing cooldown timeout for this action
    const existingTimeout = this.cooldownTimeouts.get(actionKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Reset cooldown after period
    const timeoutHandle = setTimeout(() => {
      const currentState = this.states.get(actionKey);
      if (currentState) {
        currentState.inCooldown = false;
      }
      // Remove timeout handle from map once it fires
      this.cooldownTimeouts.delete(actionKey);
    }, this.config.cooldownMs);

    // Store timeout handle for cleanup
    this.cooldownTimeouts.set(actionKey, timeoutHandle);

    // Add to history
    this.history.push({
      action,
      result,
      timestamp: Date.now(),
    });

    // Trim history to window
    this.trimHistory();

    // Emit result
    try {
      this.emit('executed', result);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting executed event');
    }

    return result;
  }

  /**
   * Execute the actual remediation action
   */
  private async executeAction(action: RemediationAction): Promise<RemediationResult> {
    this.logger?.info({ action }, 'Executing remediation action');

    const startTime = Date.now();

    try {
      // Simulate action execution - in real implementation, this would
      // call into the appropriate subsystem (governor, batch queue, etc.)

      switch (action.type) {
        case 'scale_up':
          await this.executeScaleUp(action);
          break;

        case 'scale_down':
          await this.executeScaleDown(action);
          break;

        case 'throttle':
          await this.executeThrottle(action);
          break;

        case 'alert':
          await this.executeAlert(action);
          break;

        case 'restart':
          await this.executeRestart(action);
          break;

        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }

      const duration = Date.now() - startTime;

      this.logger?.info(
        { action, durationMs: duration },
        'Remediation action succeeded'
      );

      return {
        action,
        success: true,
        timestamp: Date.now(),
      };
    } catch (error) {
      const err = error as Error;

      this.logger?.error(
        { err, action },
        'Remediation action failed'
      );

      try {
        this.emit('failed', action, err);
      } catch (emitErr) {
        this.logger?.error({ err: emitErr }, 'Error emitting failed event');
      }

      return {
        action,
        success: false,
        timestamp: Date.now(),
        error: err.message,
      };
    }
  }

  /**
   * Execute scale-up action
   */
  private async executeScaleUp(action: RemediationAction): Promise<void> {
    this.logger?.debug({ action }, 'Scaling up resource');

    // In real implementation, would call:
    // - AdaptiveGovernor.adjustLimits({ maxConcurrent: +10 })
    // - BatchQueue.setMaxBatchSize(newSize)
    // etc.

    // For now, log only
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Execute scale-down action
   */
  private async executeScaleDown(action: RemediationAction): Promise<void> {
    this.logger?.debug({ action }, 'Scaling down resource');

    // Similar to scale-up but with negative adjustments
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Execute throttle action
   */
  private async executeThrottle(action: RemediationAction): Promise<void> {
    this.logger?.debug({ action }, 'Throttling requests');

    // Would call tenant-specific rate limiter
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Execute alert action
   */
  private async executeAlert(action: RemediationAction): Promise<void> {
    this.logger?.warn({ action }, 'Sending alert');

    // Would integrate with alerting system (PagerDuty, Slack, etc.)
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Execute restart action
   */
  private async executeRestart(action: RemediationAction): Promise<void> {
    this.logger?.warn({ action }, 'Restarting component');

    // Would trigger graceful restart of Python runtime or other components
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Check if action is rate-limited
   */
  private isRateLimited(actionKey: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.executionWindowMs;

    const recentExecutions = this.history.filter(
      (entry) =>
        this.getActionKey(entry.action) === actionKey &&
        entry.timestamp >= cutoff
    );

    return recentExecutions.length >= this.config.maxExecutionsPerWindow;
  }

  /**
   * Detect remediation loop (oscillation)
   */
  private detectLoop(actionKey: string): boolean {
    const windowSize = Math.max(1, this.config.loopDetectionWindow);
    const historyCount = Math.max(0, windowSize - 1);
    const recentActions =
      historyCount > 0
        ? this.history
            .slice(-historyCount)
            .map((entry) => this.getActionKey(entry.action))
        : [];

    const actionWindow = [...recentActions, actionKey];

    if (actionWindow.length < windowSize) {
      return false;
    }

    // Check for alternating pattern (A-B-A-B...)
    const actionTypes = [...new Set(actionWindow)];

    if (actionTypes.length === 2) {
      // Check if actions are opposite (scale_up/scale_down)
      const isOpposite =
        (actionTypes.includes('scale_up') && actionTypes.includes('scale_down')) ||
        (actionTypes.includes('throttle') && actionTypes.includes('scale_up'));

      if (isOpposite) {
        // Check if pattern is alternating
        let isAlternating = true;
        for (let i = 0; i < actionWindow.length - 1; i++) {
          if (actionWindow[i] === actionWindow[i + 1]) {
            isAlternating = false;
            break;
          }
        }

        return isAlternating;
      }
    }

    return false;
  }

  /**
   * Get unique key for an action
   */
  private getActionKey(action: RemediationAction): string {
    return `${action.type}:${action.target}`;
  }

  /**
   * Trim history to prevent unbounded growth
   */
  private trimHistory(): void {
    const now = Date.now();
    const cutoff = now - this.config.executionWindowMs * 2; // Keep 2x window

    this.history = this.history.filter((entry) => entry.timestamp >= cutoff);
  }

  /**
   * Reset circuit breaker for an action
   */
  public resetCircuitBreaker(actionType: string): void {
    this.circuitBreakers.delete(actionType);
    this.logger?.info({ actionType }, 'Circuit breaker reset');
  }

  /**
   * Get execution history
   */
  public getHistory(limit?: number): ExecutionHistory[] {
    if (limit) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * Clear execution history
   */
  public clear(): void {
    this.history = [];
    this.states.clear();
    this.circuitBreakers.clear();

    // Clear all pending cooldown timeouts to prevent memory leaks
    for (const timeoutHandle of this.cooldownTimeouts.values()) {
      clearTimeout(timeoutHandle);
    }
    this.cooldownTimeouts.clear();

    this.logger?.info('Cleared remediation executor state');
  }
}
