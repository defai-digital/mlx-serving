/**
 * Adaptive Stream Governor
 *
 * PID-based admission control for streaming concurrency.
 * Dynamically adjusts stream limits based on measured TTFT and GPU utilization,
 * with per-tenant budgeting and safe-mode fallback.
 *
 * Phase 4.1 Implementation - Replaces simple heuristic-based adaptive limits
 * in StreamRegistry with deterministic PID control.
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { updatePid, resetPid } from './pid/pidController.js';
import { createPidState, clamp, type PidConfig, type PidState } from './pid/pidTypes.js';

/**
 * Tenant budget for rate limiting
 */
export interface TenantBudget {
  tenantId: string;
  hardLimit: number;      // Maximum concurrent streams
  burstLimit: number;     // Temporary burst allowance
  decayMs: number;        // Decay period for burst allowance
}

/**
 * Adaptive control signal output
 */
export interface AdaptiveControlSignal {
  streamId: string;
  tenantId: string;
  measuredTtftMs: number;
  utilization: number;
  recommendation: 'admit' | 'queue' | 'reject' | 'safe-mode';
  reason: string;
  sampleWindowMs: number;
}

/**
 * Stream governor configuration
 */
export interface StreamGovernorConfig {
  featureFlag: boolean;
  targetTtftMs: number;
  maxConcurrentStreams: number;
  minConcurrentStreams: number;
  tenantBudgets: Record<string, TenantBudget>;
  pid: PidConfig;
  cleanup: {
    sweepIntervalMs: number;
    maxStaleLifetimeMs: number;
  };
}

/**
 * Governor events
 */
export interface GovernorEvents {
  admission: (signal: AdaptiveControlSignal) => void;
  limitAdjusted: (oldLimit: number, newLimit: number, reason: string) => void;
  tenantRejected: (tenantId: string, reason: string) => void;
  safeModeEntered: (reason: string) => void;
  pidUnstable: (output: number) => void;
}

/**
 * Adaptive Stream Governor
 *
 * Core admission control component using PID controller for
 * dynamic concurrency management with tenant budgeting.
 */
export class AdaptiveGovernor extends EventEmitter<GovernorEvents> {
  private config: StreamGovernorConfig;
  private logger?: Logger;
  private pidState: PidState;
  private currentLimit: number;
  private safeModeActive = false;
  private tenantUsage = new Map<string, number>();
  private tenantBurstUsage = new Map<string, { count: number; resetAt: number }>();

  constructor(config: StreamGovernorConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.pidState = createPidState();
    this.currentLimit = config.maxConcurrentStreams;
  }

  /**
   * Evaluate admission request
   */
  public evaluate(
    tenantId: string,
    activeStreams: number,
    measuredTtftMs: number,
    utilization: number,
    streamId?: string
  ): AdaptiveControlSignal {
    const signal: AdaptiveControlSignal = {
      streamId: streamId || 'unknown',
      tenantId,
      measuredTtftMs,
      utilization,
      recommendation: 'admit',
      reason: '',
      sampleWindowMs: this.config.pid.sampleIntervalMs,
    };

    if (!this.config.featureFlag) {
      signal.recommendation = 'admit';
      signal.reason = 'governor_disabled';
      return signal;
    }

    if (this.safeModeActive) {
      signal.recommendation = 'safe-mode';
      signal.reason = 'safe_mode_active';
      return signal;
    }

    const tenantCheck = this.checkTenantBudget(tenantId);
    if (!tenantCheck.allowed) {
      signal.recommendation = 'reject';
      signal.reason = tenantCheck.reason;
      try {
        this.emit('tenantRejected', tenantId, tenantCheck.reason);
      } catch (err) {
        this.logger?.error({ err, tenantId }, 'Error emitting tenantRejected event');
      }
      return signal;
    }

    if (activeStreams >= this.currentLimit) {
      signal.recommendation = 'queue';
      signal.reason = 'at_capacity_' + this.currentLimit;
      return signal;
    }

    signal.recommendation = 'admit';
    signal.reason = 'capacity_available';
    this.tenantUsage.set(tenantId, (this.tenantUsage.get(tenantId) || 0) + 1);

    try {
      this.emit('admission', signal);
    } catch (err) {
      this.logger?.error({ err, signal }, 'Error emitting admission event');
    }

    return signal;
  }

  /**
   * Update PID controller with new measurements
   */
  public updateControl(measuredTtftMs: number, activeStreams: number): void {
    if (!this.config.featureFlag) {
      return;
    }

    const error = measuredTtftMs - this.config.targetTtftMs;
    const pidOutput = updatePid(this.pidState, this.config.pid, error);
    this.pidState = pidOutput.state;

    if (!Number.isFinite(pidOutput.output)) {
      this.logger?.warn({ pidOutput }, 'PID output is NaN/Inf');
      try {
        this.emit('pidUnstable', pidOutput.output);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting pidUnstable event');
      }
      this.pidState = resetPid(this.pidState);
      this.currentLimit = this.config.maxConcurrentStreams;
      return;
    }

    const adjustment = Math.round(-pidOutput.output);
    const newLimit = clamp(
      this.currentLimit + adjustment,
      this.config.minConcurrentStreams,
      this.config.maxConcurrentStreams
    );

    if (newLimit !== this.currentLimit) {
      const oldLimit = this.currentLimit;
      this.currentLimit = newLimit;

      this.logger?.info(
        { oldLimit, newLimit, error, pidOutput: pidOutput.output, measuredTtftMs, targetTtftMs: this.config.targetTtftMs, activeStreams },
        'Governor adjusted stream limit'
      );

      try {
        this.emit('limitAdjusted', oldLimit, newLimit, 'ttft_error_' + error.toFixed(1) + 'ms');
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting limitAdjusted event');
      }
    }

    if (pidOutput.debug) {
      this.logger?.debug({ pidDebug: pidOutput.debug }, 'PID controller state');
    }
  }

  /**
   * Manually adjust limits (for QoS policy engine)
   */
  public adjustLimits(delta: number, min?: number, max?: number): void {
    const oldLimit = this.currentLimit;
    const minLimit = min ?? this.config.minConcurrentStreams;
    const maxLimit = max ?? this.config.maxConcurrentStreams;

    this.currentLimit = clamp(this.currentLimit + delta, minLimit, maxLimit);

    if (this.currentLimit !== oldLimit) {
      this.logger?.info({ oldLimit, newLimit: this.currentLimit, delta }, 'Governor limit manually adjusted');
      try {
        this.emit('limitAdjusted', oldLimit, this.currentLimit, 'manual_adjustment_' + delta);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting limitAdjusted event');
      }
    }
  }

  /**
   * Enter safe mode (disable adaptive control)
   */
  public enterSafeMode(reason: string): void {
    if (this.safeModeActive) {
      return;
    }

    this.safeModeActive = true;
    this.currentLimit = this.config.maxConcurrentStreams;
    this.pidState = resetPid(this.pidState);

    this.logger?.warn({ reason }, 'Governor entered safe mode');

    try {
      this.emit('safeModeEntered', reason);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting safeModeEntered event');
    }
  }

  public exitSafeMode(): void {
    this.safeModeActive = false;
    this.logger?.info('Governor exited safe mode');
  }

  public releaseTenant(tenantId: string): void {
    const current = this.tenantUsage.get(tenantId) || 0;
    if (current > 0) {
      this.tenantUsage.set(tenantId, current - 1);
    }
  }

  public getCurrentLimit(): number {
    return this.currentLimit;
  }

  public getStats(): {
    currentLimit: number;
    safeModeActive: boolean;
    tenantCount: number;
    pidState: PidState;
  } {
    return {
      currentLimit: this.currentLimit,
      safeModeActive: this.safeModeActive,
      tenantCount: this.tenantUsage.size,
      pidState: { ...this.pidState },
    };
  }

  private checkTenantBudget(tenantId: string): { allowed: boolean; reason: string } {
    const budget = this.config.tenantBudgets[tenantId] ?? this.config.tenantBudgets['default'];
    
    if (!budget) {
      return { allowed: true, reason: 'no_budget_configured' };
    }

    const currentUsage = this.tenantUsage.get(tenantId) || 0;

    if (currentUsage >= budget.hardLimit) {
      return { allowed: false, reason: 'hard_limit_' + budget.hardLimit };
    }

    const now = Date.now();
    const burstUsage = this.tenantBurstUsage.get(tenantId);

    if (burstUsage) {
      if (now >= burstUsage.resetAt) {
        this.tenantBurstUsage.delete(tenantId);
      } else if (burstUsage.count >= budget.burstLimit) {
        return { allowed: false, reason: 'burst_limit_' + budget.burstLimit };
      }
    }

    if (burstUsage) {
      burstUsage.count++;
    } else {
      this.tenantBurstUsage.set(tenantId, {
        count: 1,
        resetAt: now + budget.decayMs,
      });
    }

    return { allowed: true, reason: 'within_budget' };
  }
}
