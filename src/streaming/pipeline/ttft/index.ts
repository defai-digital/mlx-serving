/**
 * TTFT Accelerator Pipeline
 *
 * Exports all TTFT optimization components:
 * - TtftPipeline: Main coordinator
 * - TokenizerWarmQueue: Priority queue for prompts
 * - SpeculativeProvider: First-token speculation
 * - HintHasher utilities: Prompt fingerprinting
 *
 * Phase 4.3 Implementation
 */

export { TtftPipeline, createTtftHint } from './TtftPipeline.js';
export type { TtftPipelineConfig, TtftPipelineEvents } from './TtftPipeline.js';

export { TokenizerWarmQueue } from './TokenizerWarmQueue.js';
export type { WarmQueueConfig, WarmQueueEvents } from './TokenizerWarmQueue.js';

export { SpeculativeProvider } from './SpeculativeProvider.js';
export type { SpeculationConfig, SpeculationEvents } from './SpeculativeProvider.js';

export { hashPrompt, hashPromptShort, estimateTokenCount } from './HintHasher.js';

export type {
  TtftHint,
  PromptPayload,
  WarmQueueItem,
  SpeculationCandidate,
  SpeculationResult,
  QueueStats,
  SpeculationStats,
  WarmupSignal,
  KvPrepStatus,
  TtftStageMetrics,
  TtftPipelineResult,
} from './types.js';
