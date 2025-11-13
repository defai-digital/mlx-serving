/**
 * Model Manager
 *
 * Tracks model handles, coordinates load/unload operations with the Python
 * runtime, and manages draft model pairing metadata.
 */

import type { Logger } from 'pino';
import { getConfig, getCacheConfig } from '../config/loader.js';
import type {
  LoadModelOptions,
  ModelDescriptor,
  ModelHandle,
  CompatibilityReport,
  ModelIdentifier,
  ModelCacheStats,
} from '../types/index.js';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';
import type {
  LoadModelParams,
  LoadModelResponse,
  UnloadModelParams,
  CheckDraftParams,
  CheckDraftResponse,
} from '../bridge/serializers.js';
import { toEngineError } from '../api/errors.js';
import { RequestQueue } from './request-queue.js';
import { ModelArtifactCache } from './model-artifact-cache.js';

export interface ModelManagerOptions {
  transport: JsonRpcTransport;
  logger?: Logger;
  cacheDir?: string; // Deprecated: use cacheConfig instead
  cacheConfig?: Partial<import('../types/cache.js').CacheConfig>; // Phase 2: Full cache configuration
}

interface LoadContext {
  descriptor: ModelDescriptor;
  draft: boolean;
}

/**
 * Manages currently loaded models and metadata.
 */
export class ModelManager {
  private readonly transport: JsonRpcTransport;
  private readonly logger?: Logger;
  private readonly defaultContextLength: number;
  private readonly maxLoadedModels: number;
  private readonly requestQueue: RequestQueue;
  private readonly artifactCache: ModelArtifactCache;

  // Phase 2: In-Memory Model Caching (v0.2.0)
  private readonly cacheEnabled: boolean;
  private readonly maxCachedModels: number;
  // @ts-expect-error - Reserved for future caching strategy implementation
  private readonly _evictionStrategy: string;
  private readonly warmupOnStart: string[];
  // @ts-expect-error - Reserved for future statistics tracking
  private readonly _trackStats: boolean;
  private readonly accessTimes = new Map<ModelIdentifier, number>();

  private readonly handles = new Map<ModelIdentifier, ModelHandle>();
  private readonly descriptorCache = new Map<ModelIdentifier, ModelDescriptor>();
  private readonly metadataCache = new Map<ModelIdentifier, Record<string, unknown>>();
  private readonly inflightLoads = new Map<ModelIdentifier, Promise<ModelHandle>>();
  private readonly draftPairs = new Map<ModelIdentifier, ModelIdentifier>();
  private readonly draftHandles = new Set<ModelIdentifier>();
  private lastDraftId: ModelIdentifier | null = null;

  constructor(options: ModelManagerOptions) {
    this.transport = options.transport;
    this.logger = options.logger;

    const config = getConfig();
    this.defaultContextLength = config.model.default_context_length;
    this.maxLoadedModels = config.model.max_loaded_models;

    // Phase 2: In-Memory Model Caching configuration
    this.cacheEnabled = config.model.memory_cache.enabled;
    this.maxCachedModels = config.model.memory_cache.max_cached_models;
    this._evictionStrategy = config.model.memory_cache.eviction_strategy;
    this.warmupOnStart = config.model.memory_cache.warmup_on_start;
    this._trackStats = config.model.memory_cache.track_stats;

    // Initialize request queue with model loading concurrency control
    // Use 5 minute timeout for model loading (much longer than JSON-RPC timeout)
    // to avoid interfering with normal error handling
    this.requestQueue = new RequestQueue({
      maxConcurrent: this.maxLoadedModels,
      requestTimeoutMs: 300000, // 5 minutes
      logger: this.logger,
    });

    // Initialize artifact cache
    // Merge runtime options with config file defaults
    const defaultCacheConfig = getCacheConfig();
    const cacheConfig = {
      ...defaultCacheConfig,
      // Override with cacheConfig if provided
      ...(options.cacheConfig || {}),
      // Support legacy cacheDir option
      ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    };
    this.artifactCache = new ModelArtifactCache(cacheConfig, this.logger);
  }

  /**
   * Initialize the model manager and artifact cache.
   * Should be called once during engine startup.
   */
  public async initialize(): Promise<void> {
    await this.artifactCache.initialize();
    this.logger?.info('ModelManager initialized with artifact cache');
  }

  /**
   * Warmup models configured in warmup_on_start.
   * Called automatically during engine initialization.
   * Failures are logged but don't prevent engine startup.
   *
   * @returns Promise that resolves when warmup is complete
   *
   * @example
   * ```typescript
   * // Configured in runtime.yaml:
   * // warmup_on_start: ['mlx-community/Llama-3.2-3B-Instruct-4bit']
   *
   * await modelManager.warmupModels();
   * // Models are now cached and ready for instant access
   * ```
   */
  public async warmupModels(): Promise<void> {
    if (!this.cacheEnabled || this.warmupOnStart.length === 0) {
      this.logger?.debug('Model warmup skipped (cache disabled or no models configured)');
      return;
    }

    this.logger?.info(
      { models: this.warmupOnStart },
      `Warming up ${this.warmupOnStart.length} model(s)...`
    );

    const results = await Promise.allSettled(
      this.warmupOnStart.map(async (modelId) => {
        try {
          const startTime = Date.now();
          await this.loadModel({ model: modelId });
          const duration = Date.now() - startTime;

          this.logger?.info({ model: modelId, duration }, `Model warmed up: ${modelId} (${duration}ms)`);

          return { modelId, success: true, duration };
        } catch (error) {
          this.logger?.warn({ model: modelId, error }, `Failed to warmup model: ${modelId}`);

          return { modelId, success: false, error };
        }
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - successful;

    this.logger?.info(
      { successful, failed, total: results.length },
      `Model warmup complete: ${successful}/${results.length} successful`
    );
  }

  /**
   * Load a model (primary or draft) into the runtime.
   */
  public async loadModel(options: LoadModelOptions): Promise<ModelHandle> {
    const { descriptor, draft } = this.prepareDescriptor(options);
    // Bug Fix #65: Use buildCacheKey() for inflight deduplication to include all variant parameters
    // Previously used descriptor.id which caused concurrent loads with different options
    // (e.g., revision="main" vs revision="dev") to share the same Promise incorrectly
    const cacheKey = this.buildCacheKey(descriptor, draft, options);

    // Check if model is already loaded with matching options
    // Note: handles uses descriptor.id as key (one model per ID)
    // but we validate that the loaded variant matches the requested options
    const existing = this.handles.get(descriptor.id);
    if (
      existing &&
      existing.state === 'ready' &&
      existing.draft === draft &&
      (existing.metadata.revision ?? null) === (options.revision ?? null) &&
      (existing.metadata.quantization ?? 'none') === (options.quantization ?? 'none')
    ) {
      this.logger?.debug(
        { modelId: descriptor.id, draft, revision: options.revision, quantization: options.quantization },
        'Returning cached model handle with matching options'
      );
      // Phase 2: Update access time for LRU cache
      this.updateAccessTime(descriptor.id);
      return existing;
    }

    // Bug Fix #65: Check if this exact variant is already being loaded
    // cacheKey includes model_id + draft + revision + quantization to prevent
    // concurrent loads with different options from sharing the same Promise
    const inflight = this.inflightLoads.get(cacheKey);
    if (inflight) {
      this.logger?.debug(
        { modelId: descriptor.id, draft, cacheKey },
        'Returning in-flight load promise for exact variant'
      );

      // Bug Fix #59: Wrap inflight promise to isolate error handling per caller
      // Problem: If the shared promise rejects, all callers receive the same error.
      // If one caller doesn't catch, it causes unhandled rejection.
      // Solution: Each caller gets their own promise that handles errors independently.
      return inflight.then(
        (handle) => handle, // Success: pass through
        (error) => {
          // Failure: Remove from inflight and let caller decide to retry or fail
          this.logger?.debug(
            { modelId: descriptor.id, error: error.message },
            'Shared inflight load failed, propagating error to caller'
          );
          // Note: inflightLoads.delete() is already called in performLoad's finally block
          // Just propagate the error to this specific caller
          throw error;
        }
      );
    }

    const loadPromise = this.performLoad(descriptor, draft, options).finally(() => {
      // Bug Fix #65: Clean up inflight entry using the same cacheKey
      // This ensures each variant is tracked separately
      this.inflightLoads.delete(cacheKey);
    });

    // Bug Fix #65: Store inflight promise with full variant key
    this.inflightLoads.set(cacheKey, loadPromise);
    return loadPromise;
  }

  /**
   * Convenience helper for loading draft models.
   */
  public async loadDraftModel(options: LoadModelOptions): Promise<ModelHandle> {
    return this.loadModel({ ...options, draft: true });
  }

  /**
   * Unload a model from the runtime.
   *
   * **Cache Retention Strategy:**
   * - Model handles and draft handles are removed immediately
   * - Descriptor and metadata caches are intentionally preserved for performance
   * - Cache entries are small (<1KB each) and bounded by typical usage (1-3 models)
   * - Future loads of the same model ID will reuse cached descriptors
   *
   * This design assumes workloads with a small, stable set of models that are
   * loaded/unloaded repeatedly. For workloads with many distinct models, consider
   * implementing cache eviction or clearing caches manually after unload if needed.
   */
  public async unloadModel(id: ModelIdentifier): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) {
      return;
    }

    // Fix Bug #27 (Critical): Only delete local state after successful RPC call
    // Otherwise Python still holds the model in memory (GPU/CPU memory leak)
    try {
      const params: UnloadModelParams = { model_id: id };
      await this.transport.request('unload_model', params);

      // Only delete local state after successful unload
      this.handles.delete(id);
      this.draftHandles.delete(id);
      this.unpairDraft(id);
    } catch (error) {
      // Keep local state intact if unload failed
      throw toEngineError(error, 'RuntimeError');
    }
  }

  /**
   * Unload the last loaded (or specified) draft model.
   */
  public async unloadDraftModel(id?: ModelIdentifier): Promise<void> {
    const targetId = id ?? this.lastDraftId;
    if (!targetId) {
      return;
    }
    await this.unloadModel(targetId);
    if (this.lastDraftId === targetId) {
      this.lastDraftId = null;
    }
  }

  /**
   * Get a handle for a loaded model.
   */
  public getHandle(id: ModelIdentifier): ModelHandle | undefined {
    return this.handles.get(id);
  }

  /**
   * Determine if a given model is currently loaded.
   */
  public isLoaded(id: ModelIdentifier): boolean {
    return this.handles.has(id);
  }

  /**
   * Associate a draft model with a primary.
   */
  public pairDraft(primaryId: ModelIdentifier, draftId: ModelIdentifier): void {
    this.logger?.debug({ primaryId, draftId }, 'Pairing draft model with primary');
    this.draftPairs.set(primaryId, draftId);
  }

  /**
   * Retrieve draft pairing for a primary model.
   */
  public getDraftFor(primaryId: ModelIdentifier): ModelIdentifier | undefined {
    return this.draftPairs.get(primaryId);
  }

  /**
   * Check draft compatibility via Python runtime (Week 2 Day 1: Enhanced).
   *
   * Validates draft-primary model pairing for speculative decoding with:
   * - Vocabulary compatibility (critical: must match)
   * - Architecture family check (warning if different)
   * - Model size validation (draft should be smaller)
   * - Performance estimation (expected speedup)
   * - Special tokens check (BOS/EOS compatibility)
   */
  public async isDraftCompatible(
    primaryId: ModelIdentifier,
    draftId: ModelIdentifier
  ): Promise<CompatibilityReport> {
    try {
      const params: CheckDraftParams = {
        primary_id: primaryId,
        draft_id: draftId,
      };

      const response = await this.transport.request<CheckDraftResponse>(
        'check_draft',
        params
      );

      // Validate response structure
      if (!response || !response.details) {
        throw new Error(
          `Invalid response from check_draft: missing details field. Response: ${JSON.stringify(response)}`
        );
      }

      if (!response.details.primary_model || !response.details.draft_model) {
        throw new Error(
          `Invalid response from check_draft: missing model details. Details: ${JSON.stringify(response.details)}`
        );
      }

      // Auto-pair models if compatible (no errors)
      if (response.compatible) {
        this.pairDraft(primaryId, draftId);
      }

      // Map snake_case Python response to camelCase TypeScript interface
      return {
        compatible: response.compatible,
        errors: response.errors,
        warnings: response.warnings,
        details: {
          primaryModel: {
            id: response.details.primary_model.id,
            vocabSize: response.details.primary_model.vocab_size,
            parameterCount: response.details.primary_model.parameter_count,
            architecture: response.details.primary_model.architecture,
          },
          draftModel: {
            id: response.details.draft_model.id,
            vocabSize: response.details.draft_model.vocab_size,
            parameterCount: response.details.draft_model.parameter_count,
            architecture: response.details.draft_model.architecture,
          },
          performanceEstimate: {
            expectedSpeedup: response.details.performance_estimate.expected_speedup,
            sizeRatio: response.details.performance_estimate.size_ratio,
            recommendation: response.details.performance_estimate.recommendation,
          },
        },
      };
    } catch (error) {
      throw toEngineError(error, 'RuntimeError');
    }
  }

  /**
   * List all loaded models.
   */
  public listModels(): ModelHandle[] {
    return Array.from(this.handles.values());
  }

  private async performLoad(
    descriptor: ModelDescriptor,
    draft: boolean,
    options: LoadModelOptions
  ): Promise<ModelHandle> {
    // Bug Fix #64: Prevent unbounded model loading (DoS vulnerability)
    // Defense-in-Depth Strategy:
    // 1. Pre-load check: Block new loads when total (loaded + in-flight) reaches limit
    // 2. RequestQueue: Serialize concurrent loads via FIFO queue (maxConcurrent = maxLoadedModels)
    // 3. Post-load verification: Ensure we don't exceed limit after async load completes
    //
    // This protects against:
    // - Simultaneous load requests overwhelming memory
    // - Race conditions between multiple concurrent loads
    // - Resource exhaustion attacks via unlimited model loading

    // Phase 2: Check if we need to evict LRU model
    // If cache is enabled and we're at capacity, evict the least-recently-used model
    if (this.cacheEnabled && this.handles.size >= this.maxCachedModels) {
      await this.evictLRU();
    }

    // Pre-load check: Reject if at capacity
    // IMPORTANT: Count both loaded models AND in-flight loads to prevent race condition
    const totalModels = this.handles.size + this.inflightLoads.size;
    if (this.maxLoadedModels > 0 && totalModels >= this.maxLoadedModels) {
      const error = new Error(
        `Cannot load model ${descriptor.id}: maximum number of loaded models (${this.maxLoadedModels}) reached. ` +
        `Please unload unused models before loading new ones.`
      );
      this.logger?.error(
        {
          modelId: descriptor.id,
          loadedCount: this.handles.size,
          inflightCount: this.inflightLoads.size,
          totalCount: totalModels,
          maxModels: this.maxLoadedModels
        },
        'Model load rejected: limit reached'
      );
      throw toEngineError(error, 'ModelLoadError');
    }

    // Phase 2: Check artifact cache before loading
    const cacheResult = await this.artifactCache.lookup(descriptor, options);
    const params = this.buildLoadParams(descriptor, draft, options);

    if (cacheResult.hit && cacheResult.artifactPath) {
      // Cache hit: Use cached artifacts (90%+ faster)
      params.local_path = cacheResult.artifactPath;
      this.logger?.info(
        {
          modelId: descriptor.id,
          draft,
          cacheHit: true,
          lookupTimeMs: cacheResult.lookupTimeMs,
          artifactPath: cacheResult.artifactPath
        },
        'Loading model from artifact cache'
      );
    } else {
      // Cache miss: Will load from HuggingFace/local path
      this.logger?.info(
        {
          modelId: descriptor.id,
          draft,
          cacheHit: false,
          lookupTimeMs: cacheResult.lookupTimeMs
        },
        'Loading model (cache miss)'
      );
    }

    // Queue the actual model loading operation to prevent resource exhaustion
    // This ensures FIFO fairness and limits concurrent model loads
    let response: LoadModelResponse;
    const loadStartTime = performance.now();
    try {
      response = await this.requestQueue.execute(async () => {
        return await this.transport.request<LoadModelResponse>(
          'load_model',
          params
        );
      });
    } catch (error) {
      throw toEngineError(error, draft ? 'GenerationError' : 'ModelLoadError');
    }

    // @ts-expect-error - Reserved for future performance metrics
    const _loadTimeMs = performance.now() - loadStartTime;

    const handle = this.createHandle(descriptor, draft, response, options);
    this.handles.set(descriptor.id, handle);

    // Phase 2: Update access time for newly loaded model
    this.updateAccessTime(descriptor.id);

    if (draft) {
      this.draftHandles.add(descriptor.id);
      this.lastDraftId = descriptor.id;
    }

    this.descriptorCache.set(descriptor.id, descriptor);
    this.metadataCache.set(descriptor.id, { ...handle.metadata });

    // Phase 2: Store artifacts in cache for future loads (only if cache miss)
    // Python now returns cached_path showing where the model was loaded from
    // Store these artifacts in our mlx-serving cache for future loads
    if (!cacheResult.hit && response.cached_path) {
      // Don't block on cache storage - do it asynchronously
      this.logger?.debug(
        { modelId: descriptor.id, sourcePath: response.cached_path },
        'Storing model artifacts in mlx-serving cache'
      );
      void this.artifactCache.store(
        descriptor,
        options,
        response.cached_path,
        {
          modelId: descriptor.id,
          parameterCount: response.parameter_count || 0,
          dtype: response.dtype || 'unknown',
          contextLength: response.context_length ?? this.defaultContextLength,
          modality: descriptor.modality || 'text',
          quantization: options.quantization,
          revision: options.revision,
        }
      ).catch((error) => {
        // Log but don't fail the load if cache storage fails
        this.logger?.warn(
          { error, modelId: descriptor.id },
          'Failed to store model artifacts in cache'
        );
      });
    }

    return handle;
  }

  private prepareDescriptor(options: LoadModelOptions): LoadContext {
    const draft = options.draft ?? false;
    const descriptor =
      typeof options.model === 'string'
        ? this.resolveDescriptor(options.model)
        : options.model;

    return { descriptor, draft };
  }

  private resolveDescriptor(id: string): ModelDescriptor {
    const cached = this.descriptorCache.get(id);
    if (cached) {
      return cached;
    }

    const descriptor: ModelDescriptor = {
      id,
      source: 'huggingface',
      modality: 'text',
      family: 'mlx-lm',
    };

    return descriptor;
  }

  /**
   * Build a unique cache key that includes all model variant parameters.
   * Critical: Must include revision and quantization to prevent wrong model reuse.
   * Uses null byte prefix for undefined values to prevent collision with explicit "default".
   */
  private buildCacheKey(
    descriptor: ModelDescriptor,
    draft: boolean,
    options: LoadModelOptions
  ): string {
    // Use '\u0000' prefix for undefined values to prevent collision with explicit "default" revision
    const revisionKey = options.revision !== undefined ? options.revision : '\u0000none';
    const quantizationKey = options.quantization ?? 'none';

    return [
      descriptor.id,
      draft ? 'draft' : 'primary',
      revisionKey,
      quantizationKey,
    ].join('|');
  }

  private buildLoadParams(
    descriptor: ModelDescriptor,
    draft: boolean,
    options: LoadModelOptions
  ): LoadModelParams {
    const params: LoadModelParams = {
      model_id: descriptor.id,
      draft,
    };

    if (options.revision) {
      params.revision = options.revision;
    }

    if (options.quantization && options.quantization !== 'none') {
      params.quantization = options.quantization;
    }

    // Priority: options.localPath > descriptor.path
    // If neither is set, MLX will auto-download to HuggingFace cache (~/.cache/huggingface/hub/)
    const optionsAsRecord = options as LoadModelOptions & Record<string, unknown>;
    if (optionsAsRecord.localPath) {
      params.local_path = optionsAsRecord.localPath as string;
    } else if (descriptor.path) {
      params.local_path = descriptor.path;
    }
    // Note: Removed cacheDir fallback that created invalid paths
    // MLX libraries handle auto-download to HuggingFace cache when local_path is undefined

    return params;
  }

  private createHandle(
    descriptor: ModelDescriptor,
    draft: boolean,
    response: LoadModelResponse,
    options: LoadModelOptions
  ): ModelHandle {
    const contextLength =
      response.context_length ?? this.defaultContextLength;

    const metadata: Record<string, unknown> = {
      ...this.metadataCache.get(descriptor.id),
      parameterCount: response.parameter_count,
      dtype: response.dtype,
      isVisionModel: response.is_vision_model,
      tokenizerType: response.tokenizer_type,
      memoryUsage: response.memory_usage,
      quantization: options.quantization ?? 'none',
      revision: options.revision,
      draft,
    };

    const handle: ModelHandle = {
      descriptor,
      state:
        response.state === 'ready'
          ? 'ready'
          : response.state === 'loading'
          ? 'loading'
          : 'failed',
      contextLength,
      metadata,
      draft,
    };

    return handle;
  }

  private unpairDraft(modelId: ModelIdentifier): void {
    // Remove direct pairings
    if (this.draftPairs.has(modelId)) {
      this.draftPairs.delete(modelId);
    }

    // Remove reverse pairs
    for (const [primary, draft] of this.draftPairs.entries()) {
      if (draft === modelId) {
        this.draftPairs.delete(primary);
      }
    }
  }

  /**
   * Phase 2: In-Memory Model Caching - LRU Methods
   */

  /**
   * Update access time for LRU tracking.
   * Bug fix: Always update access time for eviction, regardless of trackStats setting.
   * LRU eviction must work even when statistics collection is disabled.
   * @param modelId - Model identifier
   */
  private updateAccessTime(modelId: ModelIdentifier): void {
    // Bug fix: Removed trackStats guard - access time is needed for eviction
    // even when statistics collection is disabled
    this.accessTimes.set(modelId, Date.now());
  }

  /**
   * Evict the least-recently-used model from the cache.
   * Only evicts if cache is enabled and at capacity.
   */
  private async evictLRU(): Promise<void> {
    if (!this.cacheEnabled || this.handles.size < this.maxCachedModels) {
      return;
    }

    // Find least-recently-used model
    let oldestId: ModelIdentifier | null = null;
    let oldestTime = Infinity;

    for (const [modelId, accessTime] of this.accessTimes) {
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestId = modelId;
      }
    }

    if (oldestId) {
      this.logger?.info(
        { modelId: oldestId, accessTime: oldestTime },
        'Evicting LRU model from cache'
      );
      await this.unloadModel(oldestId);
      this.accessTimes.delete(oldestId);
    }
  }

  /**
   * Get cache statistics.
   * @returns Cache statistics object
   */
  public getCacheStats(): ModelCacheStats {
    const models = Array.from(this.handles.keys()).map((modelId) => ({
      modelId,
      lastAccess: this.accessTimes.get(modelId) ?? 0,
    }));

    // Sort by most recently accessed first
    models.sort((a, b) => b.lastAccess - a.lastAccess);

    return {
      loadedModels: this.handles.size,
      maxModels: this.maxCachedModels,
      cacheEnabled: this.cacheEnabled,
      models,
    };
  }

  /**
   * Get artifact cache health and statistics.
   * Phase 2: Persistent disk cache stats
   * @returns Artifact cache health status
   */
  public async getArtifactCacheHealth(): Promise<import('../types/cache.js').CacheHealth> {
    return this.artifactCache.getHealth();
  }
}
