/**
 * TTFT Accelerator Pipeline
 *
 * Coordinates warm queue, speculation, and KV prefetch for
 * optimal Time-To-First-Token performance.
 *
 * Phase 4.3 Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { TokenizerWarmQueue } from './TokenizerWarmQueue.js';
import { SpeculativeProvider } from './SpeculativeProvider.js';
import { hashPrompt, estimateTokenCount } from './HintHasher.js';
import type {
  TtftHint,
  PromptPayload,
  TtftPipelineResult,
  TtftStageMetrics,
  QueueStats,
  SpeculationStats,
} from './types.js';

/**
 * Pipeline configuration
 */
export interface TtftPipelineConfig {
  enabled: boolean;
  warmQueue: {
    maxSize: number;
    ttlMs: number;
    priorityByTokens: boolean;
  };
  speculation: {
    enabled: boolean;
    allowlistOnly: boolean;
    maxCandidates: number;
    minConfidence: number;
    decayFactor: number;
  };
  kvPrep: {
    enabled: boolean;
    coordinatorEndpoint?: string;
  };
}

/**
 * Pipeline events
 */
export interface TtftPipelineEvents {
  'stage:queued': (streamId: string, metrics: TtftStageMetrics) => void;
  'stage:warmed': (streamId: string, metrics: TtftStageMetrics) => void;
  'stage:speculated': (streamId: string, metrics: TtftStageMetrics) => void;
  'stage:firstToken': (streamId: string, metrics: TtftStageMetrics) => void;
  'speculation:hit': (promptHash: string, confidence: number) => void;
  'speculation:miss': (promptHash: string) => void;
  'speculation:accepted': (promptHash: string) => void;
  'speculation:rejected': (promptHash: string, actualToken: string) => void;
}

/**
 * TTFT Accelerator Pipeline
 *
 * Orchestrates the complete TTFT optimization flow:
 * 1. Queue prompts in priority order
 * 2. Check for speculative first tokens
 * 3. Coordinate KV cache prefetch with Python runtime
 * 4. Track stage durations for metrics
 */
export class TtftPipeline extends EventEmitter<TtftPipelineEvents> {
  private warmQueue: TokenizerWarmQueue;
  private speculativeProvider: SpeculativeProvider;
  private config: TtftPipelineConfig;
  private logger?: Logger;
  private stageTimings = new Map<string, Map<string, number>>();

  constructor(config: TtftPipelineConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize components
    this.warmQueue = new TokenizerWarmQueue(
      {
        maxSize: config.warmQueue.maxSize,
        ttlMs: config.warmQueue.ttlMs,
        priorityByTokens: config.warmQueue.priorityByTokens,
      },
      logger
    );

    this.speculativeProvider = new SpeculativeProvider(
      {
        enabled: config.speculation.enabled,
        allowlistOnly: config.speculation.allowlistOnly,
        maxCandidates: config.speculation.maxCandidates,
        minConfidence: config.speculation.minConfidence,
        decayFactor: config.speculation.decayFactor,
      },
      logger
    );

    // Forward speculation events
    this.speculativeProvider.on('hit', (promptHash, confidence) => {
      try {
        this.emit('speculation:hit', promptHash, confidence);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting speculation:hit event');
      }
    });

    this.speculativeProvider.on('miss', (promptHash) => {
      try {
        this.emit('speculation:miss', promptHash);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting speculation:miss event');
      }
    });
  }

  /**
   * Process a prompt through the TTFT pipeline
   */
  public async processTtftHint(
    hint: TtftHint,
    payload: PromptPayload
  ): Promise<TtftPipelineResult> {
    if (!this.config.enabled) {
      return {
        streamId: hint.streamId,
        promptHash: hint.promptHash,
        candidateTokens: null,
        kvPrepStatus: 'disabled',
        stageMetrics: null,
      };
    }

    const startTime = Date.now();
    this.recordStageStart(hint.streamId, 'queue');

    try {
      // Stage 1: Enqueue for warm-up
      await this.warmQueue.enqueue(hint, payload);
      const queuedAt = Date.now();
      this.recordStageEnd(hint.streamId, 'queue', queuedAt);

      try {
        this.emit('stage:queued', hint.streamId, {
          stage: 'queue',
          durationMs: queuedAt - startTime,
          timestamp: queuedAt,
        });
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting stage:queued event');
      }

      // Stage 2: Check for speculative tokens
      let candidateTokens: string[] | null = null;
      const speculationStart = Date.now();

      if (this.config.speculation.enabled && hint.speculationAllowed) {
        candidateTokens = await this.speculativeProvider.getCandidateTokens(hint.promptHash);

        if (candidateTokens) {
          this.logger?.debug(
            {
              streamId: hint.streamId,
              promptHash: hint.promptHash,
              candidateCount: candidateTokens.length,
            },
            'Speculation candidates found'
          );
        }
      }

      const speculationEnd = Date.now();
      this.recordStageEnd(hint.streamId, 'speculation', speculationEnd);

      if (candidateTokens) {
        try {
          this.emit('stage:speculated', hint.streamId, {
            stage: 'speculation',
            durationMs: speculationEnd - speculationStart,
            timestamp: speculationEnd,
          });
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting stage:speculated event');
        }
      }

      // Stage 3: Coordinate KV cache prefetch (if enabled)
      let kvPrepStatus: 'disabled' | 'pending' | 'ready' | 'failed' = 'disabled';

      if (this.config.kvPrep.enabled) {
        // In full implementation, this would send WarmupSignal to Python runtime
        // via gRPC metadata or shared memory
        kvPrepStatus = 'pending';

        this.logger?.debug(
          { streamId: hint.streamId, promptHash: hint.promptHash },
          'KV prep coordination initiated'
        );
      }

      const warmedAt = Date.now();
      this.recordStageEnd(hint.streamId, 'warm', warmedAt);

      try {
        this.emit('stage:warmed', hint.streamId, {
          stage: 'warm',
          durationMs: warmedAt - queuedAt,
          timestamp: warmedAt,
        });
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting stage:warmed event');
      }

      return {
        streamId: hint.streamId,
        promptHash: hint.promptHash,
        candidateTokens,
        kvPrepStatus,
        stageMetrics: this.getStageMetrics(hint.streamId),
      };
    } catch (error) {
      this.logger?.error(
        { err: error, streamId: hint.streamId },
        'Error processing TTFT hint'
      );

      return {
        streamId: hint.streamId,
        promptHash: hint.promptHash,
        candidateTokens: null,
        kvPrepStatus: 'failed',
        stageMetrics: null,
      };
    }
  }

  /**
   * Record actual first token for speculation learning
   */
  public recordFirstToken(
    streamId: string,
    promptHash: string,
    actualToken: string,
    candidateTokens: string[] | null
  ): void {
    const firstTokenAt = Date.now();

    // Save reference to current stage timings to prevent deleting a new stream's data
    // if streamId is reused between recordStageEnd and cleanup
    const currentStages = this.stageTimings.get(streamId);

    this.recordStageEnd(streamId, 'firstToken', firstTokenAt);

    try {
      this.emit('stage:firstToken', streamId, {
        stage: 'firstToken',
        durationMs: this.getStageMetrics(streamId)?.totalMs || 0,
        timestamp: firstTokenAt,
      });
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting stage:firstToken event');
    }

    // Update speculation learning
    if (candidateTokens && candidateTokens.length > 0) {
      const accepted = candidateTokens[0] === actualToken;

      this.speculativeProvider.recordOutcome(promptHash, accepted);

      if (accepted) {
        this.logger?.debug(
          { streamId, promptHash, actualToken },
          'Speculation accepted'
        );

        try {
          this.emit('speculation:accepted', promptHash);
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting speculation:accepted event');
        }
      } else {
        this.logger?.debug(
          {
            streamId,
            promptHash,
            expectedToken: candidateTokens[0],
            actualToken,
          },
          'Speculation rejected'
        );

        try {
          this.emit('speculation:rejected', promptHash, actualToken);
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting speculation:rejected event');
        }

        // Update candidate with actual token
        this.speculativeProvider.updateCandidate(promptHash, [actualToken]);
      }
    } else if (this.config.speculation.enabled && !this.config.speculation.allowlistOnly) {
      // No speculation, but learn from actual token
      this.speculativeProvider.updateCandidate(promptHash, [actualToken]);

      this.logger?.debug(
        { streamId, promptHash, actualToken },
        'Learned first token for future speculation'
      );
    }

    // Clean up stage timings - only if it's still the same reference
    // This prevents deleting timing data from a new stream if streamId was reused
    if (currentStages && this.stageTimings.get(streamId) === currentStages) {
      this.stageTimings.delete(streamId);
    }
  }

  /**
   * Add prompt to speculation allowlist
   */
  public allowSpeculation(
    promptHash: string,
    tokens: string[],
    confidence = 0.8
  ): void {
    this.speculativeProvider.allowPrompt(promptHash, tokens, confidence);

    this.logger?.info(
      { promptHash, tokens, confidence },
      'Prompt added to speculation allowlist'
    );
  }

  /**
   * Remove prompt from speculation allowlist
   */
  public disallowSpeculation(promptHash: string): void {
    this.speculativeProvider.disallowPrompt(promptHash);

    this.logger?.info({ promptHash }, 'Prompt removed from speculation allowlist');
  }

  /**
   * Get pipeline statistics
   */
  public getStats(): {
    warmQueue: QueueStats;
    speculation: SpeculationStats;
    activeStreams: number;
  } {
    return {
      warmQueue: this.warmQueue.getStats(),
      speculation: this.speculativeProvider.getStats(),
      activeStreams: this.stageTimings.size,
    };
  }

  /**
   * Clear all caches and queues
   */
  public clear(): void {
    this.warmQueue.clear();
    this.speculativeProvider.clear();
    this.stageTimings.clear();

    this.logger?.info('TTFT pipeline cleared');
  }

  /**
   * Record stage start time
   */
  private recordStageStart(streamId: string, stage: string): void {
    let stages = this.stageTimings.get(streamId);
    if (!stages) {
      stages = new Map<string, number>();
      this.stageTimings.set(streamId, stages);
    }

    stages.set(`${stage}_start`, Date.now());
  }

  /**
   * Record stage end time
   */
  private recordStageEnd(streamId: string, stage: string, endTime: number): void {
    const stages = this.stageTimings.get(streamId);
    if (!stages) return;

    stages.set(`${stage}_end`, endTime);
  }

  /**
   * Get stage metrics for a stream
   */
  private getStageMetrics(streamId: string): TtftStageMetrics | null {
    const stages = this.stageTimings.get(streamId);
    if (!stages) return null;

    const queueStart = stages.get('queue_start') || 0;
    const queueEnd = stages.get('queue_end') || 0;
    const speculationEnd = stages.get('speculation_end') || 0;
    const warmEnd = stages.get('warm_end') || 0;
    const firstTokenEnd = stages.get('firstToken_end') || 0;

    return {
      stage: 'complete',
      durationMs: firstTokenEnd - queueStart,
      timestamp: firstTokenEnd,
      queueMs: queueEnd - queueStart,
      speculationMs: speculationEnd - queueEnd,
      warmMs: warmEnd - queueEnd,
      totalMs: firstTokenEnd - queueStart,
    };
  }
}

/**
 * Create TTFT hint from prompt payload
 */
export function createTtftHint(
  streamId: string,
  modelId: string,
  tenantId: string,
  payload: PromptPayload,
  speculationAllowed = false
): TtftHint {
  return {
    streamId,
    modelId,
    tenantId,
    promptHash: hashPrompt(payload),
    estimatedTokens: estimateTokenCount(payload),
    speculationAllowed,
  };
}
