/**
 * Core engine types for mlx-serving
 * Mirrors mlx-engine Python API for seamless migration
 */

import type {
  GeneratorParams,
  GeneratorChunk,
  TokenizeRequest,
  TokenizeResponse,
  GenerationStats,
  EngineError,
} from './generators.js';
import type { ModelDescriptor, ModelHandle, CompatibilityReport } from './models.js';
import type {
  VisionModelHandle,
  LoadVisionModelOptions,
  VisionGeneratorParams,
  VisionGeneratorChunk,
} from './vision.js';
import type { BatchQueue } from '../core/batch-queue.js';
import type { ModelCacheStats } from './cache.js';

export type { GenerationStats, EngineError };

/**
 * Options for createGenerator method (Week 2 Day 2)
 */
export interface CreateGeneratorOptions {
  signal?: AbortSignal;
  streamId?: string;
  timeoutMs?: number;
  /**
   * Priority for request batching (v1.3.0)
   * @default 'default'
   */
  priority?: 'urgent' | 'default' | 'background';
}

export interface RuntimeInfo {
  version: string;
  mlxVersion: string;
  protocol: string;
  capabilities: string[];
  mlxSupported?: boolean;
  memory?: {
    rss: number;
    vms: number;
  };
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  activeStreams: number;
  loadedModels: number;
  runtime?: {
    pid?: number;
    status: 'running' | 'stopped' | 'crashed';
  };
  // Bug Fix #55 Phase 2: State Synchronization Protocol
  stateConsistent?: boolean; // True if TypeScript and Python states match
  stateErrors?: string[]; // List of state inconsistency errors
}

export interface EngineOptions {
  /** Optional custom python executable path */
  pythonPath?: string;
  /** Optional override for python runtime script */
  runtimePath?: string;
  /** Model/tokenizer cache location */
  cacheDir?: string;
  /** Telemetry configuration */
  telemetry?: TelemetryOptions;
}

export interface TelemetryOptions {
  enabled: boolean;
  hooks?: TelemetryHooks;
}

export interface TelemetryHooks {
  onModelLoaded?: (model: ModelHandle) => void;
  onTokenGenerated?: (token: string, stats: GenerationStats) => void;
  onGenerationCompleted?: (stats: GenerationStats) => void;
  onError?: (error: EngineError) => void;
}

export type ModelIdentifier = string;

export interface LoadModelOptions {
  model: string | ModelDescriptor;
  draft?: boolean;
  revision?: string;
  quantization?: QuantizationMode;
  parameters?: Partial<GeneratorParams>;
  // P2-2: Extra kwargs for mlx-engine compatibility
  trustRemoteCode?: boolean;      // Allow loading models with custom code
  [key: string]: unknown;         // Allow passthrough of additional kwargs
}

export type QuantizationMode = 'none' | 'int8' | 'int4';

export interface Engine {
  // TypeScript-style camelCase API (supports both object and positional string)
  loadModel(options: LoadModelOptions | string): Promise<ModelHandle>;
  loadDraftModel(options: LoadModelOptions | string): Promise<ModelHandle>;
  unloadModel(id: ModelIdentifier): Promise<void>;
  unloadDraftModel(id?: ModelIdentifier): Promise<void>;
  isDraftModelCompatible(
    primary: ModelIdentifier,
    draft: ModelIdentifier
  ): Promise<CompatibilityReport>;
  createGenerator(params: GeneratorParams): AsyncGenerator<GeneratorChunk, void>;
  createGenerator(params: GeneratorParams, options: CreateGeneratorOptions): AsyncGenerator<GeneratorChunk, void>;
  // P2-3: Convenience method for complete text generation (mlx-engine compat)
  generate(params: GeneratorParams, options?: CreateGeneratorOptions): Promise<string>;
  tokenize(request: TokenizeRequest): Promise<TokenizeResponse>;
  listModels(): ModelHandle[];
  getModelInfo(id: ModelIdentifier): ModelHandle | undefined;
  getRuntimeInfo(): Promise<RuntimeInfo>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;

  // Batch Queue Management (Phase 1: Request Batching)
  getBatchStats(): ReturnType<BatchQueue['getStats']> | undefined;
  resetBatchStats(): void;
  flushBatches(): Promise<void>;

  // Model Caching (Phase 2: v0.2.0)
  warmupModel(options: LoadModelOptions | string): Promise<void>;
  getCacheStats(): Promise<ModelCacheStats>;

  // Vision Model Support
  loadVisionModel(options: LoadVisionModelOptions): Promise<VisionModelHandle>;
  createVisionGenerator(params: VisionGeneratorParams): AsyncGenerator<VisionGeneratorChunk, void>;
  createVisionGenerator(params: VisionGeneratorParams, options: CreateGeneratorOptions): AsyncGenerator<VisionGeneratorChunk, void>;

  // Python-style snake_case aliases
  // Note: These accept both camelCase and snake_case parameters via config-normalizer
  load_model(options: LoadModelOptions | Record<string, unknown>): Promise<ModelHandle>;
  load_draft_model(options: LoadModelOptions | Record<string, unknown>): Promise<ModelHandle>;
  unload_model(id: ModelIdentifier): Promise<void>;
  unload_draft_model(id?: ModelIdentifier): Promise<void>;
  is_draft_model_compatible(primary: ModelIdentifier, draft: ModelIdentifier): Promise<CompatibilityReport>;
  create_generator(params: GeneratorParams | Record<string, unknown>): AsyncGenerator<GeneratorChunk, void>;
  load_vision_model(options: LoadVisionModelOptions): Promise<VisionModelHandle>;
  create_vision_generator(
    params: VisionGeneratorParams
  ): AsyncGenerator<VisionGeneratorChunk, void>;
  warmup_model(options: LoadModelOptions | string): Promise<void>;
  get_cache_stats(): Promise<ModelCacheStats>;
}
