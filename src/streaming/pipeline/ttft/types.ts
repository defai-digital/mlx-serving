/**
 * TTFT Accelerator Pipeline Types
 *
 * Type definitions for Time-To-First-Token optimization pipeline.
 * Includes warm queue, speculation, and KV cache coordination.
 *
 * Phase 4.3 Implementation
 */

/**
 * TTFT hint for warm queue prioritization
 */
export interface TtftHint {
  streamId: string;
  modelId: string;
  promptHash: string;
  estimatedTokens: number;
  tenantId: string;
  speculationAllowed: boolean;
  priority?: number; // Optional priority override
}

/**
 * Prompt payload for tokenization
 */
export interface PromptPayload {
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Warm queue item with TTL
 */
export interface WarmQueueItem {
  hint: TtftHint;
  payload: PromptPayload;
  enqueuedAt: number;
  expiresAt: number;
}

/**
 * Speculation candidate
 */
export interface SpeculationCandidate {
  promptHash: string;
  candidateTokens: string[];
  confidence: number;
  lastUpdated: number;
  successCount: number;
  failureCount: number;
}

/**
 * Speculation result
 */
export interface SpeculationResult {
  promptHash: string;
  tokens: string[] | null;
  fromCache: boolean;
  confidence: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  size: number;
  evicted: number;
  processed: number;
  avgWaitTimeMs: number;
  p95WaitTimeMs: number;
}

/**
 * Speculation statistics
 */
export interface SpeculationStats {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  accuracyRate: number;
  avgConfidence: number;
}

/**
 * Warmup signal for Python runtime
 */
export interface WarmupSignal {
  streamId: string;
  modelId: string;
  promptHash: string;
  estimatedTokens: number;
  speculationAllowed: boolean;
  speculatedTokens?: string[];
}

/**
 * KV prep status from Python
 */
export interface KvPrepStatus {
  streamId: string;
  status: 'pending' | 'ready' | 'failed';
  cachedTokens?: number;
  errorMessage?: string;
}

/**
 * TTFT stage metrics
 */
export interface TtftStageMetrics {
  stage: string;
  durationMs: number;
  timestamp: number;
  queueMs?: number;
  speculationMs?: number;
  warmMs?: number;
  totalMs?: number;
}

/**
 * TTFT pipeline result
 */
export interface TtftPipelineResult {
  streamId: string;
  promptHash: string;
  candidateTokens: string[] | null;
  kvPrepStatus: 'disabled' | 'pending' | 'ready' | 'failed';
  stageMetrics: TtftStageMetrics | null;
}
