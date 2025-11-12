/**
 * Model Preloader
 *
 * Enhanced model preloading with per-model warmup configurations.
 * Eliminates first-request latency by preloading and warming up models during engine startup.
 *
 * Week 7 Phase 7.1.4: Model Preloading
 * Target: 0ms first-request latency for preloaded models (vs ~5s cold start)
 */

import type { Logger } from 'pino';
import type { ModelManager } from './model-manager.js';
import type { GeneratorFactory } from './generator-factory.js';
import type { LoadModelOptions } from '../types/index.js';

export interface ModelPreloadConfig {
  modelId: string;
  warmupRequests: number;
  options?: Partial<LoadModelOptions>;
  warmupPrompts?: string[];
  maxTokens?: number;
}

export interface PreloadConfig {
  enabled: boolean;
  models: ModelPreloadConfig[];
  parallel: boolean;
  maxParallel?: number;
  failFast?: boolean;
}

export interface PreloadResult {
  modelId: string;
  success: boolean;
  loadTimeMs: number;
  warmupTimeMs?: number;
  warmupCount?: number;
  error?: Error;
}

export interface PreloadReport {
  totalModels: number;
  successful: number;
  failed: number;
  totalTimeMs: number;
  results: PreloadResult[];
}

/**
 * ModelPreloader - Enhanced model preloading with warmup generations
 *
 * Features:
 * - Per-model warmup request counts
 * - Custom warmup prompts per model
 * - Parallel or sequential loading
 * - Fail-fast or continue-on-error modes
 * - Detailed preload reporting
 *
 * @example
 * ```typescript
 * const preloader = new ModelPreloader(modelManager, generatorFactory, config, logger);
 * const report = await preloader.preloadModels();
 * console.log(`Preloaded ${report.successful}/${report.totalModels} models`);
 * ```
 */
export class ModelPreloader {
  private readonly modelManager: ModelManager;
  private readonly generatorFactory: GeneratorFactory;
  private readonly config: PreloadConfig;
  private readonly logger?: Logger;

  constructor(
    modelManager: ModelManager,
    generatorFactory: GeneratorFactory,
    config: PreloadConfig,
    logger?: Logger
  ) {
    this.modelManager = modelManager;
    this.generatorFactory = generatorFactory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Preload and warmup all configured models.
   *
   * @returns Promise resolving to preload report with success/failure details
   */
  public async preloadModels(): Promise<PreloadReport> {
    if (!this.config.enabled || this.config.models.length === 0) {
      this.logger?.debug('Model preload skipped (disabled or no models configured)');
      return {
        totalModels: 0,
        successful: 0,
        failed: 0,
        totalTimeMs: 0,
        results: [],
      };
    }

    this.logger?.info(
      { modelCount: this.config.models.length, parallel: this.config.parallel },
      `Starting model preload: ${this.config.models.length} model(s)...`
    );

    const startTime = performance.now();

    const results: PreloadResult[] = this.config.parallel
      ? await this.preloadParallel()
      : await this.preloadSequential();

    const totalTimeMs = performance.now() - startTime;
    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    const report: PreloadReport = {
      totalModels: this.config.models.length,
      successful,
      failed,
      totalTimeMs,
      results,
    };

    this.logger?.info(
      {
        successful,
        failed,
        total: this.config.models.length,
        totalTimeMs: Math.round(totalTimeMs),
      },
      `Model preload complete: ${successful}/${this.config.models.length} successful (${Math.round(totalTimeMs)}ms)`
    );

    return report;
  }

  /**
   * Preload models in parallel (faster but higher memory pressure).
   */
  private async preloadParallel(): Promise<PreloadResult[]> {
    const maxParallel = this.config.maxParallel ?? this.config.models.length;
    const results: PreloadResult[] = [];

    // Process in batches if maxParallel is set
    for (let i = 0; i < this.config.models.length; i += maxParallel) {
      const batch = this.config.models.slice(i, i + maxParallel);
      const batchResults = await Promise.allSettled(
        batch.map((modelConfig) => this.preloadSingleModel(modelConfig))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Promise rejection should not happen as preloadSingleModel catches errors
          this.logger?.error({ error: result.reason }, 'Unexpected preload error');
        }
      }

      // Check fail-fast mode
      if (this.config.failFast && results.some((r) => !r.success)) {
        this.logger?.warn('Fail-fast mode enabled, stopping preload on first failure');
        break;
      }
    }

    return results;
  }

  /**
   * Preload models sequentially (safer, lower memory pressure).
   */
  private async preloadSequential(): Promise<PreloadResult[]> {
    const results: PreloadResult[] = [];

    for (const modelConfig of this.config.models) {
      const result = await this.preloadSingleModel(modelConfig);
      results.push(result);

      // Check fail-fast mode
      if (this.config.failFast && !result.success) {
        this.logger?.warn('Fail-fast mode enabled, stopping preload on first failure');
        break;
      }
    }

    return results;
  }

  /**
   * Preload and warmup a single model.
   */
  private async preloadSingleModel(
    modelConfig: ModelPreloadConfig
  ): Promise<PreloadResult> {
    const { modelId, warmupRequests, options, warmupPrompts, maxTokens } = modelConfig;

    this.logger?.debug({ modelId, warmupRequests }, `Preloading model: ${modelId}`);

    const loadStartTime = performance.now();

    try {
      // Step 1: Load model
      await this.modelManager.loadModel({
        model: modelId,
        ...options,
      });

      const loadTimeMs = performance.now() - loadStartTime;

      // Step 2: Warmup with generations
      const warmupStartTime = performance.now();
      const warmupCount = await this.warmupModel(
        modelId,
        warmupRequests,
        warmupPrompts,
        maxTokens
      );
      const warmupTimeMs = performance.now() - warmupStartTime;

      this.logger?.info(
        {
          modelId,
          loadTimeMs: Math.round(loadTimeMs),
          warmupTimeMs: Math.round(warmupTimeMs),
          warmupCount,
        },
        `✅ Preloaded: ${modelId} (load: ${Math.round(loadTimeMs)}ms, warmup: ${Math.round(warmupTimeMs)}ms, ${warmupCount} requests)`
      );

      return {
        modelId,
        success: true,
        loadTimeMs,
        warmupTimeMs,
        warmupCount,
      };
    } catch (error) {
      const loadTimeMs = performance.now() - loadStartTime;
      this.logger?.error(
        { modelId, error, loadTimeMs: Math.round(loadTimeMs) },
        `❌ Failed to preload model: ${modelId}`
      );

      return {
        modelId,
        success: false,
        loadTimeMs,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Warmup a model with generation requests.
   *
   * @param modelId - Model identifier
   * @param requestCount - Number of warmup requests to perform
   * @param customPrompts - Optional custom prompts (cycles through if provided)
   * @param maxTokens - Maximum tokens per warmup request
   * @returns Number of successful warmup requests
   */
  private async warmupModel(
    modelId: string,
    requestCount: number,
    customPrompts?: string[],
    maxTokens?: number
  ): Promise<number> {
    if (requestCount <= 0) {
      return 0;
    }

    const defaultPrompts = [
      'Hello, world!',
      'Test generation',
      'Warmup request',
      'Model initialization',
      'Quick test',
    ];

    const prompts = customPrompts && customPrompts.length > 0 ? customPrompts : defaultPrompts;
    const tokensPerRequest = maxTokens ?? 10;

    let successfulWarmups = 0;

    for (let i = 0; i < requestCount; i++) {
      try {
        const prompt = prompts[i % prompts.length];
        if (!prompt) {
          continue; // Skip if prompt is missing
        }

        // Use GeneratorFactory to perform actual generation (non-streaming for warmup)
        const generator = this.generatorFactory.createGenerator({
          model: modelId,
          prompt,
          maxTokens: tokensPerRequest,
          temperature: 0.1, // Low temperature for consistent warmup
          stream: false,
        });

        // Execute generation (collect all chunks for non-streaming)
        const chunks = [];
        for await (const chunk of generator) {
          chunks.push(chunk);
        }
        successfulWarmups++;
      } catch (error) {
        this.logger?.warn(
          { modelId, warmupIndex: i, error },
          `Warmup request ${i + 1}/${requestCount} failed`
        );
        // Continue with remaining warmup requests
      }
    }

    return successfulWarmups;
  }

  /**
   * Get preload configuration.
   */
  public getConfig(): PreloadConfig {
    return { ...this.config };
  }

  /**
   * Check if preloading is enabled.
   */
  public isEnabled(): boolean {
    return this.config.enabled && this.config.models.length > 0;
  }
}
