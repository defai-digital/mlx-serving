/**
 * Concurrency types for model tier-based limiting
 */

export type ModelTier = '30B+' | '13-27B' | '7-13B' | '3-7B' | '<3B';

export interface TierLimit {
  maxConcurrent: number;
  queueDepth: number;
  queueTimeoutMs?: number;
}

export type TierLimitOverrides = Record<ModelTier, TierLimit>;
