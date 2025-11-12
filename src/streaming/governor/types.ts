export interface TenantBudget {
  tenantId: string;
  hardLimit: number;
  burstLimit: number;
  decayMs: number;
}

export interface StreamGovernorConfig {
  featureFlag: boolean;
  targetTtftMs: number;
  maxConcurrentStreams: number;
  minConcurrentStreams: number;
  tenantBudgets: Record<string, TenantBudget>;
  pid: {
    kp: number;
    ki: number;
    kd: number;
    integralSaturation: number;
    sampleIntervalMs: number;
  };
  cleanup: {
    sweepIntervalMs: number;
    maxStaleLifetimeMs: number;
  };
}

export type AdaptiveRecommendation = 'admit' | 'queue' | 'reject' | 'safe-mode';

export interface AdaptiveControlSignal {
  streamId: string;
  tenantId: string;
  measuredTtftMs: number;
  utilization: number;
  recommendation: AdaptiveRecommendation;
  reason: string;
  sampleWindowMs: number;
}

export interface StreamCleanupEvent {
  streamId: string;
  closedAt: number;
  reason: 'complete' | 'error' | 'timeout';
}

export interface GovernorEvaluateHints {
  streamId?: string;
  measuredTtftMs?: number;
  utilization?: number;
  sampleWindowMs?: number;
}
