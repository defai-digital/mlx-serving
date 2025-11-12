import type { EventEmitter } from 'eventemitter3';
import type { EngineEvents } from '../events.js';
import type {
  LoadModelOptions,
  GeneratorParams,
  GeneratorChunk,
  CreateGeneratorOptions,
  TokenizeRequest,
  TokenizeResponse,
  ModelHandle,
  ModelIdentifier,
  CompatibilityReport,
  RuntimeInfo,
  HealthStatus,
  VisionModelHandle,
  LoadVisionModelOptions,
  VisionGeneratorParams,
  VisionGeneratorChunk,
  ModelCacheStats,
} from '../../types/index.js';
import type { BatchQueue } from '../../core/batch-queue.js';

/**
 * Version marker for the Engine public API snapshot. Increment intentionally
 * whenever the public surface changes.
 */
export const ENGINE_API_SNAPSHOT_VERSION = 'phase-0';

/**
 * Snapshot of the Engine class' public surface. This intentionally mirrors the
 * methods that consumers rely on today so we can detect accidental changes
 * while the service extraction work is underway.
 */
export interface EnginePublicAPI extends EventEmitter<EngineEvents> {
  // CamelCase lifecycle + generation API
  loadModel(options: LoadModelOptions | string): Promise<ModelHandle>;
  loadDraftModel(options: LoadModelOptions | string): Promise<ModelHandle>;
  unloadModel(id: ModelIdentifier): Promise<void>;
  unloadDraftModel(id?: ModelIdentifier): Promise<void>;
  isDraftModelCompatible(primary: ModelIdentifier, draft: ModelIdentifier): Promise<CompatibilityReport>;
  createGenerator(params: GeneratorParams): AsyncGenerator<GeneratorChunk, void>;
  createGenerator(params: GeneratorParams, options: CreateGeneratorOptions): AsyncGenerator<GeneratorChunk, void>;
  generate(params: GeneratorParams, options?: CreateGeneratorOptions): Promise<string>;
  tokenize(request: TokenizeRequest): Promise<TokenizeResponse>;
  listModels(): ModelHandle[];
  getModelInfo(id: ModelIdentifier): ModelHandle | undefined;
  getRuntimeInfo(): Promise<RuntimeInfo>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;

  // Batch queue APIs
  getBatchStats(): ReturnType<BatchQueue['getStats']> | undefined;
  resetBatchStats(): void;
  flushBatches(): Promise<void>;

  // Model cache + warmup
  warmupModel(options: LoadModelOptions | string): Promise<void>;
  getCacheStats(): Promise<ModelCacheStats>;

  // Vision support
  loadVisionModel(options: LoadVisionModelOptions): Promise<VisionModelHandle>;
  createVisionGenerator(params: VisionGeneratorParams): AsyncGenerator<VisionGeneratorChunk, void>;
  createVisionGenerator(
    params: VisionGeneratorParams,
    options: CreateGeneratorOptions
  ): AsyncGenerator<VisionGeneratorChunk, void>;

  // Snake_case compatibility surface
  load_model(options: LoadModelOptions | Record<string, unknown>): Promise<ModelHandle>;
  unload_model(id: ModelIdentifier): Promise<void>;
  load_draft_model(options: LoadModelOptions | Record<string, unknown>): Promise<ModelHandle>;
  unload_draft_model(id?: ModelIdentifier): Promise<void>;
  is_draft_model_compatible(primary: ModelIdentifier, draft: ModelIdentifier): Promise<CompatibilityReport>;
  create_generator(
    params: GeneratorParams | Record<string, unknown>,
    options?: CreateGeneratorOptions
  ): AsyncGenerator<GeneratorChunk, void>;
  load_vision_model(options: LoadVisionModelOptions): Promise<VisionModelHandle>;
  create_vision_generator(
    params: VisionGeneratorParams,
    options?: CreateGeneratorOptions
  ): AsyncGenerator<VisionGeneratorChunk, void>;
  warmup_model(options: LoadModelOptions | string): Promise<void>;
  get_cache_stats(): Promise<ModelCacheStats>;
  list_models(): ModelHandle[];
  get_model_info(id: ModelIdentifier): ModelHandle | undefined;
  get_runtime_info(): Promise<RuntimeInfo>;
  health_check(): Promise<HealthStatus>;
}
