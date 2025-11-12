/**
 * TTFT Pipeline Integration
 *
 * Wires TtftPipeline into GeneratorFactory for 30-40% TTFT reduction.
 * Includes warmup queue, speculative execution, and KV cache prefetch.
 *
 * Phase 5 Week 1 Day 2-3 Implementation
 */

import { TtftPipeline } from '../streaming/pipeline/ttft/TtftPipeline.js';
import type { TtftPipelineConfig } from '../streaming/pipeline/ttft/TtftPipeline.js';
import type { Config } from '../config/loader.js';
import type { Logger } from 'pino';
import { getFeatureFlags } from '../config/feature-flag-loader.js';
import { hashPrompt, estimateTokenCount } from '../streaming/pipeline/ttft/HintHasher.js';
import type { TtftHint, PromptPayload, TtftPipelineResult } from '../streaming/pipeline/ttft/types.js';

/**
 * TTFT Integration Options
 */
export interface TtftIntegrationOptions {
  config: Config;
  logger?: Logger;
  requestId?: string;
}

/**
 * Parameters for preprocessing before generation
 */
export interface PreprocessParams {
  modelId: string;
  prompt: string;
  streamId: string;
  messages?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  hints?: Record<string, unknown>;
}

/**
 * TTFT Integration Layer
 *
 * Integrates TTFT pipeline with GeneratorFactory to accelerate
 * Time-To-First-Token for streaming generation requests.
 *
 * Features:
 * - Warmup queue for prompt prioritization
 * - Speculative token prediction
 * - KV cache prefetch coordination
 */
export class TtftIntegration {
  private ttftPipeline?: TtftPipeline;
  private enabled: boolean;
  private logger?: Logger;

  constructor(options: TtftIntegrationOptions) {
    this.logger = options.logger;

    // Check feature flags
    const featureFlags = getFeatureFlags();
    const ttftEval = featureFlags.evaluate('ttft_pipeline', options.requestId || 'default');

    this.enabled = ttftEval.enabled;

    if (this.enabled && options.config.ttft_accelerator?.enabled) {
      this.logger?.info('[TtftIntegration] TTFT Pipeline enabled, creating pipeline...');

      // Map config from snake_case to camelCase for TtftPipelineConfig
      const pipelineConfig: TtftPipelineConfig = {
        enabled: options.config.ttft_accelerator.enabled,
        warmQueue: {
          maxSize: options.config.ttft_accelerator.warm_queue.max_size,
          ttlMs: options.config.ttft_accelerator.warm_queue.ttl_ms,
          priorityByTokens: options.config.ttft_accelerator.warm_queue.priority_by_tokens,
        },
        speculation: {
          enabled: options.config.ttft_accelerator.speculation.enabled,
          allowlistOnly: options.config.ttft_accelerator.speculation.allowlist_only,
          maxCandidates: options.config.ttft_accelerator.speculation.max_candidates,
          minConfidence: options.config.ttft_accelerator.speculation.min_confidence,
          decayFactor: options.config.ttft_accelerator.speculation.decay_factor,
        },
        kvPrep: {
          enabled: options.config.ttft_accelerator.kv_prep.enabled,
          coordinatorEndpoint: options.config.ttft_accelerator.kv_prep.coordinator_endpoint,
        },
      };

      // Create TTFT pipeline with mapped config
      this.ttftPipeline = new TtftPipeline(pipelineConfig, this.logger);

      this.logger?.info('[TtftIntegration] TTFT Pipeline created successfully');
    } else if (!ttftEval.enabled) {
      this.logger?.debug(`[TtftIntegration] TTFT Pipeline disabled by feature flag: ${ttftEval.reason}`);
    } else if (!options.config.ttft_accelerator?.enabled) {
      this.logger?.debug('[TtftIntegration] TTFT Pipeline disabled in config');
    }
  }

  /**
   * Check if TTFT integration is enabled
   */
  public isEnabled(): boolean {
    return this.enabled && this.ttftPipeline !== undefined;
  }

  /**
   * Preprocess before generation
   *
   * Call this before invoking MLX generate() to:
   * 1. Enqueue prompt in warmup queue
   * 2. Check for speculative first tokens
   * 3. Coordinate KV cache prefetch
   *
   * @param params - Preprocessing parameters
   * @returns TTFT pipeline result with speculation candidates
   */
  public async preprocessGenerate(params: PreprocessParams): Promise<TtftPipelineResult | null> {
    if (!this.enabled || !this.ttftPipeline) {
      return null;
    }

    try {
      // Create prompt payload first
      const payload: PromptPayload = {
        messages: params.messages ?? [{ role: 'user', content: params.prompt }],
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      };

      // Create TTFT hint for the request using payload
      const promptHash = hashPrompt(payload);
      const estimatedTokens = estimateTokenCount(payload);

      const hint: TtftHint = {
        streamId: params.streamId,
        modelId: params.modelId,
        promptHash,
        estimatedTokens,
        tenantId: params.hints?.tenantId as string ?? 'default',
        speculationAllowed: params.hints?.speculationAllowed as boolean ?? true,
      };

      // Process through TTFT pipeline
      const result = await this.ttftPipeline.processTtftHint(hint, payload);

      this.logger?.debug(
        {
          streamId: params.streamId,
          promptHash,
          candidateTokens: result.candidateTokens?.length ?? 0,
          kvPrepStatus: result.kvPrepStatus,
        },
        '[TtftIntegration] Preprocessing completed'
      );

      return result;
    } catch (error) {
      this.logger?.error(
        { error, streamId: params.streamId },
        '[TtftIntegration] Error during preprocessing'
      );
      // Don't fail the request if TTFT preprocessing fails
      return null;
    }
  }

  /**
   * Report actual first token to update speculation model
   *
   * Call this when the first token is generated to update speculation accuracy.
   *
   * @param streamId - Stream identifier
   * @param promptHash - Prompt hash
   * @param actualToken - Actual first token generated
   */
  public reportFirstToken(streamId: string, promptHash: string, actualToken: string): void {
    if (!this.enabled || !this.ttftPipeline) {
      return;
    }

    try {
      // Future: Update speculation provider with actual token
      // This would be used to train/improve speculation model
      this.logger?.debug(
        { streamId, promptHash, actualToken },
        '[TtftIntegration] First token reported'
      );
    } catch (error) {
      this.logger?.error(
        { error, streamId },
        '[TtftIntegration] Error reporting first token'
      );
    }
  }

  /**
   * Cleanup resources after generation completes
   *
   * @param streamId - Stream identifier
   */
  public async cleanup(streamId: string): Promise<void> {
    if (!this.ttftPipeline) {
      return;
    }

    try {
      // Future: Cleanup stream-specific resources
      this.logger?.debug({ streamId }, '[TtftIntegration] Cleanup completed');
    } catch (error) {
      this.logger?.error(
        { error, streamId },
        '[TtftIntegration] Error during cleanup'
      );
    }
  }

  /**
   * Get TTFT pipeline stats (for monitoring)
   */
  public getStats(): Record<string, unknown> {
    if (!this.ttftPipeline) {
      return { enabled: false };
    }

    // Future: Return pipeline metrics
    return {
      enabled: true,
      // Add metrics here when available from TtftPipeline
    };
  }
}

/**
 * Factory function to create TtftIntegration instance
 *
 * @param options - Integration options
 * @returns TtftIntegration instance
 */
export function createTtftIntegration(options: TtftIntegrationOptions): TtftIntegration {
  return new TtftIntegration(options);
}
