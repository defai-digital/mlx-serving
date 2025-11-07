import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { pino } from 'pino';
import type { EngineEvents } from './events.js';
import { PythonRunner, type RuntimeInfo as PythonRuntimeInfo } from '../bridge/python-runner.js';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';
import { ModelManager } from '../core/model-manager.js';
import { GeneratorFactory, type CreateGeneratorOptions } from '../core/generator-factory.js';
import { BatchQueue } from '../core/batch-queue.js';
import { GenerateBatcher } from '../core/generate-batcher.js';
import type {
  LoadModelOptions,
  GeneratorParams,
  TokenizeRequest,
  VisionModelHandle,
  LoadVisionModelOptions,
  VisionGeneratorParams,
  VisionGeneratorChunk,
  VisionModelDescriptor,
  CompatibilityReport,
  ModelCacheStats,
} from '../types/index.js';
import {
  normalizeGeneratorParams,
  normalizeLoadModelOptions,
  normalizeTokenizeRequest,
} from '../compat/config-normalizer.js';
import {
  batchEncodeImages,
} from '../utils/image-encoding.js';
import type {
  Engine as EngineContract,
  EngineOptions,
  ModelHandle,
  ModelIdentifier,
  GeneratorChunk,
  TokenizeResponse,
  TelemetryHooks,
  RuntimeInfo,
  HealthStatus,
} from '../types/index.js';
import {
  EngineClientError,
  createTransportError,
  toEngineError,
  type EngineErrorCode,
} from './errors.js';
import { initializeConfig } from '../config/loader.js';
import type {
  TokenizeParams,
  TokenizeResponse as TransportTokenizeResponse,
} from '../bridge/serializers.js';

interface EngineDependencies {
  runner?: PythonRunner;
  logger?: Logger;
}

interface EngineRuntime {
  transport: JsonRpcTransport;
  modelManager: ModelManager;
  generatorFactory: GeneratorFactory;
}

const DEFAULT_LOG_LEVEL = process.env.KR_MLX_LOG_LEVEL ?? 'info';

/**
 * High-level facade that exposes the kr-serve-mlx runtime via a TypeScript API.
 *
 * The engine hides JSON-RPC and Python bridge details, providing lifecycle
 * management (start/shutdown), model management, tokenization, and generation
 * streaming. Consumers interact with this class for all inference operations.
 *
 * Events:
 * - 'model:loaded' - Emitted when a model is loaded
 * - 'model:unloaded' - Emitted when a model is unloaded
 * - 'generation:started' - Emitted when generation starts
 * - 'generation:token' - Emitted for each generated token
 * - 'generation:completed' - Emitted when generation completes
 * - 'error' - Emitted when an error occurs
 * - 'runtime:status' - Emitted when runtime status changes
 */
export class Engine extends EventEmitter<EngineEvents> implements EngineContract {
  private readonly options: EngineOptions;
  private readonly logger: Logger;
  private readonly telemetry?: TelemetryHooks;
  private readonly runner: PythonRunner;

  private modelManager: ModelManager | null = null;
  private generatorFactory: GeneratorFactory | null = null;
  private batchQueue: BatchQueue | null = null; // Week 1: Request Batching
  private generateBatcher: GenerateBatcher | null = null; // v1.3.0: Generate Request Batching
  private started = false;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private lastTransport: JsonRpcTransport | null = null;

  // Bug Fix #61: Atomic state reconciliation protection
  // Prevents concurrent reconcileState() calls during transport change
  private reconcilePromise: Promise<void> | null = null;

  // Bug Fix #55 Phase 3: Circuit Breaker for State Reconciliation
  // Prevents cascading failures when Python runtime is unstable
  private circuitBreakerState: 'closed' | 'open' | 'half-open' = 'closed';
  private circuitBreakerFailures = 0;
  private circuitBreakerLastFailure = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 3; // Open after 3 consecutive failures
  private readonly CIRCUIT_BREAKER_TIMEOUT = 30000; // 30 seconds before attempting half-open

  // Python-style snake_case aliases (accept both camelCase and snake_case params)
  public readonly load_model: (options: LoadModelOptions | Record<string, unknown>) => Promise<ModelHandle>;
  public readonly unload_model: (id: ModelIdentifier) => Promise<void>;
  public readonly load_draft_model: (options: LoadModelOptions | Record<string, unknown>) => Promise<ModelHandle>;
  public readonly unload_draft_model: (id?: ModelIdentifier) => Promise<void>;
  public readonly is_draft_model_compatible: (primary: ModelIdentifier, draft: ModelIdentifier) => Promise<CompatibilityReport>;
  public readonly load_vision_model: (options: LoadVisionModelOptions) => Promise<VisionModelHandle>;
  public readonly create_vision_generator: (
    params: VisionGeneratorParams,
    options?: CreateGeneratorOptions
  ) => AsyncGenerator<VisionGeneratorChunk, void>;
  public readonly create_generator: (
    params: GeneratorParams | Record<string, unknown>,
    options?: CreateGeneratorOptions
  ) => AsyncGenerator<GeneratorChunk, void>;
  public readonly list_models: () => ModelHandle[];
  public readonly get_model_info: (id: ModelIdentifier) => ModelHandle | undefined;
  public readonly warmup_model: (options: LoadModelOptions | string) => Promise<void>;
  public readonly get_cache_stats: () => Promise<ModelCacheStats>;
  public readonly get_runtime_info: () => Promise<RuntimeInfo>;
  public readonly health_check: () => Promise<HealthStatus>;

  /**
   * Create a new engine instance.
   *
   * @param options - Runtime configuration (python path, telemetry, cache directory, etc.).
   * @param dependencies - Optional test hooks allowing a custom runner or logger.
   */
  constructor(options: EngineOptions = {}, dependencies: EngineDependencies = {}) {
    super();

    // OPTIMIZATION #3: Initialize config singleton upfront
    // This prevents repeated YAML reads in PythonRunner, ModelManager, etc.
    // Saves ~20-40ms on cold start by avoiding redundant getConfig() calls
    initializeConfig();

    this.options = options;
    this.logger = dependencies.logger ?? pino({ level: DEFAULT_LOG_LEVEL });
    this.telemetry = options.telemetry?.enabled ? options.telemetry.hooks : undefined;

    this.runner = dependencies.runner ?? new PythonRunner({
      pythonPath: options.pythonPath,
      runtimePath: options.runtimePath,
      logger: this.logger,
    });

    this.load_model = (loadOptions) => this.loadModel(loadOptions as LoadModelOptions);
    this.unload_model = (modelId) => this.unloadModel(modelId);
    this.load_draft_model = (loadOptions) => this.loadDraftModel(loadOptions as LoadModelOptions);
    this.unload_draft_model = (modelId) => this.unloadDraftModel(modelId);
    this.is_draft_model_compatible = (primary, draft) =>
      this.isDraftModelCompatible(primary, draft);
    this.load_vision_model = (loadOptions) => this.loadVisionModel(loadOptions);
    this.create_vision_generator = (params, opts) => this.createVisionGenerator(params, opts || {});
    this.create_generator = (params, opts) => this.createGenerator(params as GeneratorParams, opts || {});
    this.list_models = () => this.listModels();
    this.get_model_info = (id) => this.getModelInfo(id);
    this.warmup_model = (options) => this.warmupModel(options);
    this.get_cache_stats = async () => await this.getCacheStats();
    this.get_runtime_info = () => this.getRuntimeInfo();
    this.health_check = () => this.healthCheck();
  }

  /**
   * Load a primary model into the runtime and return its handle.
   *
   * Supports both object and positional string parameter (mlx-engine style):
   * - `engine.loadModel({ model: 'llama' })`
   * - `engine.loadModel('llama')`
   *
   * @param options - Model loading options or model identifier string
   * @returns Promise<ModelHandle> - Handle to the loaded model with metadata
   * @throws {EngineClientError} when the runtime rejects the request.
   *
   * @example
   * ```typescript
   * // Load with object options
   * const model = await engine.loadModel({
   *   model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
   *   maxTokens: 2048,
   *   quantization: { bits: 4 }
   * });
   * console.log('Loaded model:', model.descriptor.id);
   *
   * // Load with string (mlx-engine style)
   * const model2 = await engine.loadModel('mlx-community/Mistral-7B-v0.1-4bit');
   * ```
   */
  public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
    try {
      const normalizedOptions = normalizeLoadModelOptions(options)!;
      const runtime = await this.ensureRuntime();
      const handle = await runtime.modelManager.loadModel(normalizedOptions);

      this.telemetry?.onModelLoaded?.(handle);
      this.emit('model:loaded', {
        modelId: handle.descriptor.id,
        handle,
        timestamp: Date.now(),
      });

      return handle;
    } catch (error) {
      throw this.mapError(error, 'ModelLoadError');
    }
  }

  /**
   * Load a draft (speculative decoding) model variant.
   *
   * Draft models enable speculative decoding for faster inference by using a
   * smaller, faster model to generate candidate tokens that are verified by
   * the primary model.
   *
   * @param options - Draft model loading options
   * @returns Promise<ModelHandle> - Handle to the loaded draft model
   * @throws {EngineClientError} when the runtime rejects the request.
   *
   * @example
   * ```typescript
   * // Load primary model
   * await engine.loadModel('mlx-community/Llama-3.2-8B-Instruct-4bit');
   *
   * // Load compatible draft model for speculative decoding
   * const draftModel = await engine.loadDraftModel({
   *   model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
   * });
   *
   * // Check compatibility
   * const report = await engine.isDraftModelCompatible(
   *   'Llama-3.2-8B-Instruct-4bit',
   *   'Llama-3.2-3B-Instruct-4bit'
   * );
   * console.log('Expected speedup:', report.details.performanceEstimate.expectedSpeedup);
   * ```
   */
  public async loadDraftModel(options: LoadModelOptions): Promise<ModelHandle> {
    try {
      const normalizedOptions = normalizeLoadModelOptions({
        ...options,
        draft: true,
      })!;
      const runtime = await this.ensureRuntime();
      const handle = await runtime.modelManager.loadDraftModel(normalizedOptions);

      this.telemetry?.onModelLoaded?.(handle);
      this.emit('model:loaded', {
        modelId: handle.descriptor.id,
        handle,
        timestamp: Date.now(),
      });

      return handle;
    } catch (error) {
      throw this.mapError(error, 'ModelLoadError');
    }
  }

  /**
   * Unload a previously loaded model.
   *
   * Frees memory and GPU resources associated with the model. Call this when
   * switching between models or when done with inference.
   *
   * @param id - Model identifier to unload
   * @throws {EngineClientError} when the runtime rejects the request.
   *
   * @example
   * ```typescript
   * // Load model
   * const model = await engine.loadModel('mlx-community/Llama-3.2-3B-Instruct-4bit');
   *
   * // ... perform inference ...
   *
   * // Unload when done
   * await engine.unloadModel(model.descriptor.id);
   * ```
   */
  public async unloadModel(id: ModelIdentifier): Promise<void> {
    try {
      const runtime = await this.ensureRuntime();
      await runtime.modelManager.unloadModel(id);

      this.emit('model:unloaded', {
        modelId: id,
        timestamp: Date.now(),
      });
    } catch (error) {
      throw this.mapError(error, 'RuntimeError');
    }
  }

  /**
   * Unload the given draft model (or last loaded draft when omitted).
   *
   * @throws {EngineClientError} when the runtime rejects the request.
   */
  public async unloadDraftModel(id?: ModelIdentifier): Promise<void> {
    try {
      const runtime = await this.ensureRuntime();
      await runtime.modelManager.unloadDraftModel(id);

      if (id) {
        this.emit('model:unloaded', {
          modelId: id,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      throw this.mapError(error, 'RuntimeError');
    }
  }

  /**
   * Check if a draft model is compatible with a primary model (Week 2 Day 1: Enhanced).
   *
   * Returns comprehensive compatibility report with:
   * - Vocabulary compatibility (critical)
   * - Architecture family validation
   * - Model size validation
   * - Performance estimation (expected speedup)
   * - Special tokens compatibility
   *
   * @param primary - Primary model identifier
   * @param draft - Draft model identifier
   * @returns Promise<CompatibilityReport> - Detailed compatibility report
   *
   * @throws {EngineClientError} when the compatibility check fails.
   *
   * @example
   * ```typescript
   * const report = await engine.isDraftModelCompatible('llama-3-8b', 'llama-3.2-3b');
   * if (report.compatible) {
   *   console.log('Expected speedup:', report.details.performanceEstimate.expectedSpeedup);
   * } else {
   *   console.error('Errors:', report.errors);
   * }
   * ```
   */
  public async isDraftModelCompatible(
    primary: ModelIdentifier,
    draft: ModelIdentifier
  ): Promise<CompatibilityReport> {
    try {
      const runtime = await this.ensureRuntime();
      return await runtime.modelManager.isDraftCompatible(primary, draft);
    } catch (error) {
      throw this.mapError(error, 'RuntimeError');
    }
  }

  /**
   * Load a vision-language model (LLaVA, Qwen-VL, Phi-3-Vision)
   *
   * @param options - Vision model loading options
   * @returns Promise<VisionModelHandle> - Vision model handle with metadata
   * @throws {EngineClientError} when model loading fails
   *
   * @example
   * ```typescript
   * const visionModel = await engine.loadVisionModel({
   *   model: 'llava-hf/llava-1.5-7b-hf',
   *   revision: 'main'
   * });
   * console.log('Loaded vision model:', visionModel.descriptor.id);
   * ```
   */
  public async loadVisionModel(options: LoadVisionModelOptions): Promise<VisionModelHandle> {
    try {
      const runtime = await this.ensureRuntime();

      // Convert quantization object to string format expected by Python
      let quantizationString: string | null = null;
      if (options.quantization) {
        const bits = options.quantization.bits;
        quantizationString = `int${bits}`; // {bits: 4} → "int4", {bits: 8} → "int8"
      }

      // Call JSON-RPC load_vision_model
      const response = await runtime.transport.request<{
        model_id: string;
        state: string;
        context_length: number;
        processor_type: string;
        image_size?: number;
        revision?: string;
        quantization?: string | null;
        dtype?: string;
        is_vision_model: boolean;
      }>('load_vision_model', {
        model_id: options.model,
        revision: options.revision || 'main',
        quantization: quantizationString,
        local_path: null,
      });

      // Convert to VisionModelHandle
      const handle: VisionModelHandle = {
        descriptor: {
          id: response.model_id,
          variant: undefined,
          source: options.model.startsWith('/') ? 'local' : 'huggingface',
          path: options.model,
          modality: 'vision',
          family: 'mlx-vlm',
          imageEncoder: 'clip', // Default, would need to detect from processor_type
          maxImageSize: response.image_size || 224,
          imagePreprocessing: options.preprocessing as VisionModelDescriptor['imagePreprocessing'],
        },
        state: response.state as 'ready' | 'loading' | 'failed',
        contextLength: response.context_length,
        metadata: {
          supportedFormats: ['png', 'jpg', 'jpeg', 'webp'],
          maxBatchSize: 1, // Default for now
          processorType: response.processor_type,
          quantization: response.quantization,
          dtype: response.dtype,
        },
      };

      this.telemetry?.onModelLoaded?.(handle as unknown as ModelHandle);
      this.emit('model:loaded', {
        modelId: handle.descriptor.id,
        handle: handle as unknown as ModelHandle,
        timestamp: Date.now(),
      });

      return handle;
    } catch (error) {
      throw this.mapError(error, 'ModelLoadError');
    }
  }

  public createGenerator(params: GeneratorParams): AsyncGenerator<GeneratorChunk, void>;
  public createGenerator(
    params: GeneratorParams,
    options: CreateGeneratorOptions
  ): AsyncGenerator<GeneratorChunk, void>;
  /**
   * Create an async generator that yields streaming tokens and metadata.
   *
   * @param params - Generation inputs (model, prompt, decoding config).
   * @param options - Advanced stream options (AbortSignal, timeout, stream id).
   */
  public async *createGenerator(
    params: GeneratorParams,
    options: CreateGeneratorOptions = {}
  ): AsyncGenerator<GeneratorChunk, void> {
    const normalizedParams = normalizeGeneratorParams(params)! as GeneratorParams;
    const runtime = await this.ensureRuntime();

    // BUG-011 FIX: Ensure we have a streamId for acknowledgment
    // GeneratorFactory will use this streamId for stream registration
    const streamId = options.streamId ?? randomUUID();
    const generatorOptions = { ...options, streamId };

    const generator = runtime.generatorFactory.createGenerator(normalizedParams, generatorOptions);

    try {
      for await (const chunk of generator) {
        yield chunk;
        // BUG-011 FIX: Acknowledge chunk to clear backpressure counter
        // Only acknowledge token chunks (not metadata/error chunks)
        if (chunk.type === 'token' && this.runner?.streamRegistry?.acknowledgeChunk) {
          this.runner.streamRegistry.acknowledgeChunk(streamId);
        }
      }
    } finally {
      // Ensure generator cleanup on early return/throw
      if (typeof generator.return === 'function') {
        await generator.return(undefined).catch(() => {/* ignore cleanup errors */});
      }
    }
  }

  /**
   * Generate complete text from a prompt (convenience method).
   *
   * P2-3: Matches mlx-engine's engine.generate() API for synchronous-style generation.
   *
   * This is a convenience wrapper around createGenerator that accumulates all tokens
   * and returns the complete generated text as a string.
   *
   * @param params - Generation parameters (same as createGenerator)
   * @param options - Advanced options (AbortSignal, timeout)
   * @returns Complete generated text
   *
   * @example
   * ```typescript
   * const engine = await createEngine();
   * await engine.loadModel({ model: 'llama-3.2-3b' });
   *
   * // Simple text generation (mlx-engine style)
   * const text = await engine.generate({
   *   model: 'llama-3.2-3b',
   *   prompt: 'Write a haiku about TypeScript',
   *   maxTokens: 50
   * });
   * console.log(text);
   * ```
   */
  public async generate(
    params: GeneratorParams,
    options: CreateGeneratorOptions = {}
  ): Promise<string> {
    let fullText = '';

    for await (const chunk of this.createGenerator(params, options)) {
      if (chunk.type === 'token') {
        fullText += chunk.token;
      }
    }

    return fullText;
  }

  public createVisionGenerator(params: VisionGeneratorParams): AsyncGenerator<VisionGeneratorChunk, void>;
  public createVisionGenerator(
    params: VisionGeneratorParams,
    options: CreateGeneratorOptions
  ): AsyncGenerator<VisionGeneratorChunk, void>;
  /**
   * Create a vision generator for image + text generation
   *
   * @param params - Vision generation parameters (prompt + image)
   * @param options - Generator options (signal, timeout)
   * @returns AsyncGenerator yielding vision tokens and metadata
   *
   * @example
   * ```typescript
   * for await (const chunk of engine.createVisionGenerator({
   *   model: 'llava-hf/llava-1.5-7b-hf',
   *   prompt: 'Describe this image.',
   *   image: { source: './cat.jpg' },
   *   maxTokens: 200
   * })) {
   *   if (chunk.type === 'token') {
   *     process.stdout.write(chunk.token);
   *   }
   * }
   * ```
   */
  public createVisionGenerator(
    params: VisionGeneratorParams,
    options: CreateGeneratorOptions = {}
  ): AsyncGenerator<VisionGeneratorChunk, void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;

    async function* generator(): AsyncGenerator<VisionGeneratorChunk, void> {
      try {
        // 1. Encode image(s) to base64
        const images = Array.isArray(params.image) ? params.image : [params.image];

        // Fix Bug #29 (Medium): Validate non-empty image array before encoding
        if (images.length === 0) {
          throw new EngineClientError(
            'RuntimeError',
            'At least one image is required for vision generation'
          );
        }

        const base64Images = await batchEncodeImages(images);

        // For now, support single image only (multi-image in future)
        if (base64Images.length > 1) {
          throw new EngineClientError(
            'RuntimeError',
            'Multi-image generation not yet supported. Use single image.'
          );
        }

        const imageBase64 = base64Images[0];

        // 2. Prepare JSON-RPC params
        const streamId = options.streamId || `vision-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Fix Bug #28 (Medium): maxTokens=0 should be preserved, not coerced to 100
        // Use ?? instead of || to allow 0 as valid value
        const rpcParams = {
          model_id: params.model,
          prompt: params.prompt,
          image: imageBase64,
          max_tokens: params.maxTokens ?? 100,
          temperature: params.temperature ?? 0.0,
          top_p: params.topP ?? 1.0,
          stream_id: streamId,
        };

        // 3. Start generation
        const runtime = await engine.ensureRuntime();
        const streamRegistry = engine.runner.streamRegistry;

        // Register stream with StreamRegistry
        let streamPromise: Promise<unknown> | null = null;

        // Set up event listeners for streaming chunks
        const chunks: Array<{ type: 'token' | 'stats'; data: unknown }> = [];
        let streamError: string | null = null;
        let streamCompleted = false;

        const chunkHandler = (chunk: { streamId: string; token: string; logprob?: number }): void => {
          if (chunk.streamId === streamId) {
            chunks.push({ type: 'token', data: chunk });
          }
        };

        const statsHandler = (stats: { streamId: string; tokensGenerated: number; tokensPerSecond: number; timeToFirstToken: number; totalTime: number }): void => {
          if (stats.streamId === streamId) {
            chunks.push({ type: 'stats', data: stats });
          }
        };

        const errorHandler = (sid: string, error: string): void => {
          if (sid === streamId) {
            streamError = error;
            streamCompleted = true;
          }
        };

        const completedHandler = (sid: string): void => {
          if (sid === streamId) {
            streamCompleted = true;
          }
        };

        streamRegistry.on('chunk', chunkHandler);
        streamRegistry.on('stats', statsHandler);
        streamRegistry.on('error', errorHandler);
        streamRegistry.on('completed', completedHandler);

        try {
          // Register stream AFTER setting up listeners
          streamPromise = streamRegistry.register(streamId, options.signal, options.timeoutMs);

          // Call JSON-RPC generate_with_image (starts streaming)
          // If this fails, we cancel the stream immediately to avoid timeout hang
          try {
            await runtime.transport.request('generate_with_image', rpcParams);
          } catch (rpcError) {
            // Bug Fix #62: Wait for streamPromise before throwing
            // RPC call failed before stream started - cancel immediately to avoid timeout
            streamRegistry.cancel(streamId);
            // Must await streamPromise to prevent UnhandledPromiseRejection
            await streamPromise.catch(() => {/* ignore cleanup rejection */});
            throw rpcError;
          }

          // Yield chunks as they arrive
          while (!streamCompleted && !streamError) {
            // Check for abortion BEFORE waiting
            if (options.signal?.aborted) {
              streamRegistry.cancel(streamId);
              await streamPromise.catch(() => undefined);
              throw new EngineClientError('Cancelled', 'Vision generation cancelled');
            }

            // Wait a bit for chunks to arrive
            await new Promise(resolve => setTimeout(resolve, 10));

            // Yield all accumulated chunks
            while (chunks.length > 0) {
              const item = chunks.shift()!;

              if (item.type === 'token') {
                const chunk = item.data as { token: string; logprob?: number };
                const visionChunk: VisionGeneratorChunk = {
                  type: 'token',
                  token: chunk.token,
                  logprob: chunk.logprob,
                };
                yield visionChunk;
                // BUG-011 FIX: Acknowledge chunk to clear backpressure counter
                if (streamRegistry?.acknowledgeChunk) {
                  streamRegistry.acknowledgeChunk(streamId);
                }
              } else if (item.type === 'stats') {
                const stats = item.data as { tokensGenerated: number; tokensPerSecond: number; timeToFirstToken: number; totalTime: number };
                const visionChunk: VisionGeneratorChunk = {
                  type: 'metadata',
                  stats: {
                    tokensGenerated: stats.tokensGenerated,
                    tokensPerSecond: stats.tokensPerSecond,
                    timeToFirstToken: stats.timeToFirstToken,
                    totalTime: stats.totalTime,
                  },
                };
                yield visionChunk;
              }
            }
          }

          if (streamError) {
            throw new EngineClientError('GenerationError', streamError);
          }

          // Wait for stream to complete
          await streamPromise;

        } finally {
          // Bug Fix #5: Always await streamPromise to prevent unhandled rejection
          // If RPC failed, streamRegistry.cancel() was called (line 519), causing streamPromise to reject
          // We must await it to handle the rejection, otherwise Node.js emits UnhandledPromiseRejectionWarning
          if (streamPromise) {
            await streamPromise.catch(() => undefined);
          }
          // Remove event listeners
          streamRegistry.off('chunk', chunkHandler);
          streamRegistry.off('stats', statsHandler);
          streamRegistry.off('error', errorHandler);
          streamRegistry.off('completed', completedHandler);
        }

      } catch (error) {
        throw engine.mapError(error, 'GenerationError');
      }
    }

    return generator();
  }

  /**
   * Tokenize text with a loaded model, returning token IDs and optional strings.
   *
   * Converts input text into token IDs using the model's tokenizer. Useful for
   * understanding token counts, debugging prompts, or implementing custom
   * token-level logic.
   *
   * @param request - Tokenization request with model and text
   * @returns Promise<TokenizeResponse> - Token IDs and optional token strings
   * @throws {EngineClientError} when tokenization fails or model not loaded.
   *
   * @example
   * ```typescript
   * // Load model first
   * await engine.loadModel('mlx-community/Llama-3.2-3B-Instruct-4bit');
   *
   * // Tokenize text
   * const result = await engine.tokenize({
   *   model: 'Llama-3.2-3B-Instruct-4bit',
   *   text: 'Hello, how are you today?',
   *   addBos: true
   * });
   *
   * console.log('Token IDs:', result.tokens);
   * console.log('Token count:', result.tokens.length);
   * if (result.tokenStrings) {
   *   console.log('Tokens:', result.tokenStrings);
   * }
   * ```
   */
  public async tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
    const normalizedRequest = normalizeTokenizeRequest(request)!;
    const runtime = await this.ensureRuntime();

    if (!runtime.modelManager.isLoaded(normalizedRequest.model)) {
      throw new EngineClientError(
        'ModelNotLoaded',
        `Model ${normalizedRequest.model} must be loaded before tokenization`
      );
    }

    const params: TokenizeParams = {
      model_id: normalizedRequest.model,
      text: normalizedRequest.text,
    };

    if (normalizedRequest.addBos !== undefined) {
      params.add_special_tokens = normalizedRequest.addBos;
    }

    try {
      // Week 1: Use BatchQueue if available, otherwise fallback to direct transport
      const response = this.batchQueue
        ? await this.batchQueue.tokenize(params)
        : await runtime.transport.request<TransportTokenizeResponse>('tokenize', params);

      const tokenStrings =
        'token_strings' in response ? response.token_strings : undefined;

      return {
        tokens: response.tokens,
        tokenStrings,
      } satisfies TokenizeResponse;
    } catch (error) {
      throw this.mapError(error, 'TokenizerError');
    }
  }

  /**
   * Gracefully stop the underlying Python runtime and release resources.
   */
  public async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      try {
        // Bug Fix #69: Wait for in-flight state reconciliation before shutdown
        // If transport changed and reconciliation is in progress, wait for it to complete
        // to prevent incomplete state synchronization on shutdown
        if (this.reconcilePromise) {
          this.logger?.info('Waiting for state reconciliation to complete before shutdown');
          try {
            await this.reconcilePromise;
          } catch (error) {
            // Log reconciliation error but continue shutdown
            this.logger?.error(
              { error },
              'State reconciliation failed during shutdown, continuing anyway'
            );
          }
        }

        if (this.started) {
          await this.runner.stop();
        }
      } catch (error) {
        throw this.mapError(error, 'RuntimeError');
      } finally {
        this.started = false;
        this.startPromise = null;
        this.modelManager = null;
        this.generatorFactory = null;
        this.shuttingDown = false;
        this.shutdownPromise = null;
        // Bug Fix #69: Clear reconcilePromise on shutdown
        this.reconcilePromise = null;
      }
    })();

    return this.shutdownPromise;
  }

  /**
   * Alias for {@link shutdown} to match disposable interfaces.
   */
  public async dispose(): Promise<void> {
    await this.shutdown();
  }

  /**
   * List all currently loaded models.
   *
   * @returns An array of model handles for all loaded models.
   */
  public listModels(): ModelHandle[] {
    if (!this.modelManager) {
      return [];
    }
    return this.modelManager.listModels();
  }

  /**
   * Get detailed information about a specific loaded model.
   *
   * @param id - The model identifier.
   * @returns The model handle if found, undefined otherwise.
   */
  public getModelInfo(id: ModelIdentifier): ModelHandle | undefined {
    if (!this.modelManager) {
      return undefined;
    }
    return this.modelManager.getHandle(id);
  }

  /**
   * Phase 2: Preload a model into memory cache for faster subsequent access.
   *
   * This method loads a model into memory and keeps it cached, so future
   * requests for the same model will be much faster (50-70% reduction in load time).
   * The cache uses LRU (Least Recently Used) eviction when the cache limit is reached.
   *
   * @param options - Model loading options (same as loadModel)
   * @throws {EngineClientError} when the runtime rejects the request.
   *
   * @example
   * ```typescript
   * // Warmup model during initialization
   * await engine.warmupModel({ model: 'mlx-community/Llama-3.2-3B-Instruct-4bit' });
   *
   * // Later usage will be much faster (cache hit)
   * const generator = engine.createGenerator({
   *   model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
   *   prompt: 'Hello'
   * });
   * ```
   */
  public async warmupModel(options: LoadModelOptions | string): Promise<void> {
    try {
      const normalizedOptions = normalizeLoadModelOptions(options)!;
      const runtime = await this.ensureRuntime();
      await runtime.modelManager.loadModel(normalizedOptions);
      // Model is now cached, future loads will be instant
    } catch (error) {
      throw this.mapError(error, 'ModelLoadError');
    }
  }

  /**
   * Phase 2: Get model cache statistics.
   *
   * Returns information about the in-memory model cache, including which models
   * are loaded, their access times, and cache capacity.
   *
   * @returns Cache statistics object
   *
   * @example
   * ```typescript
   * const stats = engine.getCacheStats();
   * console.log('Loaded models:', stats.loadedModels);
   * console.log('Cache capacity:', stats.maxModels);
   * console.log('Models:', stats.models);
   * ```
   */
  public async getCacheStats(): Promise<ModelCacheStats> {
    const runtime = await this.ensureRuntime();
    return runtime.modelManager.getCacheStats();
  }

  /**
   * Get information about the Python runtime.
   *
   * Returns version information, supported capabilities, and current memory
   * usage of the Python MLX runtime.
   *
   * @returns Runtime version, capabilities, and memory usage.
   * @throws {EngineClientError} when the runtime is not available.
   *
   * @example
   * ```typescript
   * const info = await engine.getRuntimeInfo();
   * console.log('MLX Version:', info.mlxVersion);
   * console.log('Protocol:', info.protocol);
   * console.log('Capabilities:', info.capabilities);
   * console.log('Memory (RSS):', info.memory?.rss, 'bytes');
   * ```
   */
  public async getRuntimeInfo(): Promise<RuntimeInfo> {
    try {
      const runtime = await this.ensureRuntime();
      const response = await runtime.transport.request<{
        version: string;
        mlx_version: string;
        protocol: string;
        capabilities: string[];
        mlx_supported?: boolean;
        memory?: { rss: number; vms: number };
      }>('runtime/info');

      return {
        version: response.version,
        mlxVersion: response.mlx_version,
        protocol: response.protocol,
        capabilities: response.capabilities,
        mlxSupported: response.mlx_supported,
        memory: response.memory,
      };
    } catch (error) {
      throw this.mapError(error, 'RuntimeError');
    }
  }

  /**
   * Check the health status of the engine and runtime.
   *
   * Returns detailed status information useful for monitoring, health checks,
   * and diagnostics. Includes runtime status, uptime, active streams, and
   * loaded model count.
   *
   * @returns Health status including uptime, active streams, and loaded models.
   *
   * @example
   * ```typescript
   * const health = await engine.healthCheck();
   * console.log('Status:', health.status);
   * console.log('Runtime:', health.runtime.status);
   * console.log('Uptime:', health.uptime, 'ms');
   * console.log('Active streams:', health.activeStreams);
   * console.log('Loaded models:', health.loadedModels);
   *
   * if (health.status === 'healthy') {
   *   console.log('✓ Engine is healthy');
   * }
   * ```
   */
  public async healthCheck(): Promise<HealthStatus> {
    try {
      const info = this.runner.getInfo();
      const activeStreams = this.runner.streamRegistry.getActiveCount();
      const loadedModels = this.modelManager?.listModels().length ?? 0;

      // Bug Fix #72: Type-safe runtime status mapping with explicit fallback
      // Using PythonRuntimeInfo['status'] type ensures TypeScript detects missing states
      const runtimeStatusMap: Record<PythonRuntimeInfo['status'], 'running' | 'stopped' | 'crashed'> = {
        'starting': 'running',
        'ready': 'running',
        'error': 'crashed',
        'stopped': 'stopped',
      };

      // Type-safe lookup with defensive fallback
      let healthRuntimeStatus: 'running' | 'stopped' | 'crashed';
      if (info.status in runtimeStatusMap) {
        healthRuntimeStatus = runtimeStatusMap[info.status];
      } else {
        // Unknown status - treat as crashed to be safe
        this.logger?.warn(
          { pythonStatus: info.status, knownStatuses: Object.keys(runtimeStatusMap) },
          'Unknown Python runtime status, treating as "crashed" for safety'
        );
        healthRuntimeStatus = 'crashed';
      }

      const runtimeStatus: HealthStatus['runtime'] = {
        pid: info.pid > 0 ? info.pid : undefined,
        status: healthRuntimeStatus,
      };

      let status: HealthStatus['status'] = 'healthy';
      if (info.status === 'stopped' || info.status === 'error') {
        status = 'unhealthy';
      } else if (activeStreams > 10 || info.status === 'starting') {
        status = 'degraded';
      }

      // Bug Fix #55 Phase 4: Check state consistency between TypeScript and Python
      let stateConsistent: boolean | undefined = undefined;
      let stateErrors: string[] | undefined = undefined;

      // Only check state consistency if Python runtime is ready
      if (info.status === 'ready') {
        const transport = this.runner.getTransport();
        if (transport) {
          try {
            const response = await transport.request<{
              loaded_models?: Array<{ model_id: string; state: string; type: string }>;
              active_streams?: number;
              restart_count?: number;
            }>('runtime/state', undefined, { timeout: 5000 });

            if (response && response.loaded_models) {
              const pythonModels = new Set<string>(response.loaded_models.map(m => m.model_id));
              const typescriptModels: Set<string> = this.modelManager
                ? new Set(this.modelManager.listModels().map(h => h.descriptor.id))
                : new Set<string>();

              const orphanedInPython: string[] = Array.from(pythonModels).filter(id => !typescriptModels.has(id));
              const orphanedInTS: string[] = Array.from(typescriptModels).filter(id => !pythonModels.has(id));

              stateErrors = [];
              if (orphanedInPython.length > 0) {
                stateErrors.push(`${orphanedInPython.length} orphaned models in Python: ${orphanedInPython.join(', ')}`);
              }
              if (orphanedInTS.length > 0) {
                stateErrors.push(`${orphanedInTS.length} orphaned models in TypeScript: ${orphanedInTS.join(', ')}`);
              }

              stateConsistent = stateErrors.length === 0;

              // If state is inconsistent, mark as degraded
              if (!stateConsistent && status === 'healthy') {
                status = 'degraded';
              }
            } else {
              // runtime/state not supported - skip state check
              stateConsistent = undefined;
            }
          } catch (err) {
            // State check failed - mark as degraded
            stateErrors = ['Failed to query Python runtime state'];
            stateConsistent = false;
            if (status === 'healthy') {
              status = 'degraded';
            }
          }
        }
      }

      // Bug Fix #55 Phase 4: Include circuit breaker state in health check
      // If circuit breaker is open, mark as degraded
      if (this.circuitBreakerState === 'open') {
        status = 'degraded';
        stateErrors = stateErrors || [];
        stateErrors.push(`Circuit breaker is open (${this.circuitBreakerFailures} failures)`);
        stateConsistent = false;
      } else if (this.circuitBreakerState === 'half-open') {
        stateErrors = stateErrors || [];
        stateErrors.push('Circuit breaker is half-open (recovery in progress)');
      }

      return {
        status,
        uptime: info.uptime,
        activeStreams,
        loadedModels,
        runtime: runtimeStatus,
        stateConsistent,
        stateErrors: stateErrors && stateErrors.length > 0 ? stateErrors : undefined,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        uptime: 0,
        activeStreams: 0,
        loadedModels: 0,
        runtime: {
          status: 'crashed',
        },
        stateConsistent: false,
        stateErrors: ['Health check failed with exception'],
      };
    }
  }

  /**
   * Get batch queue statistics (Phase 1: Request Batching).
   *
   * Returns statistics about request batching including number of batches,
   * requests, efficiency metrics, and queue sizes.
   *
   * @returns Batch queue statistics or undefined if batching is disabled.
   *
   * @example
   * ```typescript
   * const stats = engine.getBatchStats();
   * if (stats) {
   *   console.log('Tokenize batches:', stats.tokenizeBatches);
   *   console.log('Tokenize requests:', stats.tokenizeRequests);
   *   console.log('Efficiency:', stats.tokenizeEfficiency);
   * }
   * ```
   */
  public getBatchStats(): ReturnType<BatchQueue['getStats']> | undefined {
    return this.batchQueue?.getStats();
  }

  /**
   * Reset batch queue statistics (Phase 1: Request Batching).
   *
   * Resets all counters to zero. Useful for measuring batching performance
   * over a specific time period.
   *
   * @example
   * ```typescript
   * engine.resetBatchStats();
   * // ... perform operations ...
   * const stats = engine.getBatchStats();
   * console.log('Operations since reset:', stats.tokenizeRequests);
   * ```
   */
  public resetBatchStats(): void {
    this.batchQueue?.resetStats();
  }

  /**
   * Manually flush all pending batch queues (Phase 1: Request Batching).
   *
   * Normally batches flush automatically based on size or timeout.
   * This method forces immediate flushing, useful for ensuring
   * requests complete before a shutdown or checkpoint.
   *
   * @returns Promise that resolves when all queues are flushed.
   *
   * @example
   * ```typescript
   * // Queue some requests
   * const promise1 = engine.tokenize({ model_id: 'model-1', text: 'Hello' });
   * const promise2 = engine.tokenize({ model_id: 'model-1', text: 'World' });
   *
   * // Force flush before shutdown
   * await engine.flushBatches();
   * await Promise.all([promise1, promise2]);
   * ```
   */
  public async flushBatches(): Promise<void> {
    if (this.batchQueue) {
      await this.batchQueue.flush();
    }
  }

  /**
   * Reset circuit breaker to closed state after successful operation
   * Bug Fix #55 Phase 3: Circuit Breaker State Management
   */
  private resetCircuitBreaker(): void {
    if (this.circuitBreakerState !== 'closed' || this.circuitBreakerFailures > 0) {
      this.logger?.info(
        {
          previousState: this.circuitBreakerState,
          previousFailures: this.circuitBreakerFailures,
        },
        'Circuit breaker reset to closed state after successful operation'
      );
    }
    this.circuitBreakerState = 'closed';
    this.circuitBreakerFailures = 0;
    this.circuitBreakerLastFailure = 0;
  }

  /**
   * Record a circuit breaker failure and potentially open the circuit
   * Bug Fix #55 Phase 3: Circuit Breaker State Management
   * Bug Fix #60: Add special handling for half-open state
   */
  private recordCircuitBreakerFailure(): void {
    this.circuitBreakerFailures += 1;
    this.circuitBreakerLastFailure = Date.now();

    // Bug Fix #60: Special handling for half-open state
    // If we fail during half-open, immediately go back to open
    // This prevents infinite retry loops
    if (this.circuitBreakerState === 'half-open') {
      this.logger?.error(
        {
          failures: this.circuitBreakerFailures,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD,
        },
        'Circuit breaker reopened due to failure during half-open state'
      );
      this.circuitBreakerState = 'open';

      this.emit('error', {
        error: {
          code: 'RuntimeError',
          message: 'Circuit breaker reopened after failed recovery attempt',
          details: {
            failures: this.circuitBreakerFailures,
            threshold: this.CIRCUIT_BREAKER_THRESHOLD,
            previousState: 'half-open',
          },
        },
        context: 'circuit_breaker',
        timestamp: Date.now(),
      });

      return; // Exit early - don't check threshold again
    }

    // Normal closed state behavior
    if (this.circuitBreakerFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      if (this.circuitBreakerState !== 'open') {
        this.logger?.error(
          {
            failures: this.circuitBreakerFailures,
            threshold: this.CIRCUIT_BREAKER_THRESHOLD,
          },
          'Circuit breaker opened due to repeated failures'
        );
        this.circuitBreakerState = 'open';

        // Emit error event to notify users
        this.emit('error', {
          error: {
            code: 'RuntimeError',
            message: 'Circuit breaker opened due to repeated state reconciliation failures',
            details: {
              failures: this.circuitBreakerFailures,
              threshold: this.CIRCUIT_BREAKER_THRESHOLD,
            },
          },
          context: 'circuit_breaker',
          timestamp: Date.now(),
        });
      }
    } else {
      this.logger?.warn(
        {
          failures: this.circuitBreakerFailures,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD,
        },
        'Circuit breaker failure recorded'
      );
    }
  }

  /**
   * Check if circuit breaker allows operation
   * Bug Fix #55 Phase 3: Circuit Breaker State Management
   *
   * @returns true if operation is allowed, false if circuit is open
   */
  private canAttemptOperation(): boolean {
    if (this.circuitBreakerState === 'closed') {
      return true;
    }

    if (this.circuitBreakerState === 'open') {
      // Check if timeout has elapsed to attempt half-open
      const timeSinceLastFailure = Date.now() - this.circuitBreakerLastFailure;
      if (timeSinceLastFailure >= this.CIRCUIT_BREAKER_TIMEOUT) {
        this.logger?.info(
          { timeSinceLastFailure, timeout: this.CIRCUIT_BREAKER_TIMEOUT },
          'Circuit breaker transitioning to half-open state'
        );
        this.circuitBreakerState = 'half-open';
        return true;
      }

      this.logger?.warn(
        {
          timeSinceLastFailure,
          timeout: this.CIRCUIT_BREAKER_TIMEOUT,
          remainingTime: this.CIRCUIT_BREAKER_TIMEOUT - timeSinceLastFailure,
        },
        'Circuit breaker is open - operation blocked'
      );
      return false;
    }

    // half-open state: allow attempt
    return true;
  }

  /**
   * Reconcile TypeScript and Python states after Python restart
   * Bug Fix #55 Phase 2: State Synchronization Protocol
   * Bug Fix #55 Phase 3: Circuit Breaker Integration
   *
   * This method verifies that TypeScript and Python have consistent state
   * and cleans up any orphaned models or stale references.
   *
   * @param transport - Active JSON-RPC transport to Python runtime
   */
  private async reconcileState(transport: JsonRpcTransport): Promise<void> {
    this.logger?.info('Starting state reconciliation after Python restart');

    try {
      // Step 1: Query Python for loaded models
      const response = await transport.request<{
        loaded_models?: Array<{ model_id: string; state: string; type: string }>;
        active_streams?: number;
        restart_count?: number;
      }>('runtime/state', undefined, { timeout: 5000 });

      // Handle case where runtime/state is not supported (older Python runtime)
      if (!response || !response.loaded_models) {
        this.logger?.debug('runtime/state not supported or returned empty - skipping reconciliation');
        // Bug Fix #55 Phase 3: Reset circuit breaker on successful response (even if empty)
        this.resetCircuitBreaker();
        return;
      }

      const pythonModels = new Set<string>(response.loaded_models.map(m => m.model_id));

      // Step 2: Compare with TypeScript state
      const typescriptModels: Set<string> = this.modelManager
        ? new Set(this.modelManager.listModels().map(h => h.descriptor.id))
        : new Set<string>();

      // Step 3: Detect inconsistencies
      const orphanedInPython: string[] = Array.from(pythonModels).filter(id => !typescriptModels.has(id));
      const orphanedInTS: string[] = Array.from(typescriptModels).filter(id => !pythonModels.has(id));

      // Step 4: Clean up orphaned models in Python
      if (orphanedInPython.length > 0) {
        this.logger?.warn(
          { orphanedModels: orphanedInPython },
          'Cleaning up orphaned models in Python after restart'
        );

        for (const modelId of orphanedInPython) {
          try {
            await transport.request('unload_model', { model_id: modelId }, { timeout: 5000 });
          } catch (err) {
            this.logger?.error({ modelId, err }, 'Failed to unload orphaned model');
            // Continue with other models even if one fails
          }
        }
      }

      // Step 5: Invalidate TypeScript handles for orphaned models
      if (orphanedInTS.length > 0) {
        this.logger?.warn(
          { orphanedModels: orphanedInTS },
          'Invalidating orphaned TypeScript handles after restart'
        );

        // Clear local state (already done in ensureRuntime, but explicit here)
        this.modelManager = null;
      }

      this.logger?.info(
        {
          pythonModels: pythonModels.size,
          typescriptModels: typescriptModels.size,
          orphanedInPython: orphanedInPython.length,
          orphanedInTS: orphanedInTS.length,
        },
        'State reconciliation complete'
      );

      // Bug Fix #55 Phase 3: Reset circuit breaker on successful reconciliation
      this.resetCircuitBreaker();
    } catch (err) {
      // Bug Fix #55 Phase 3: Record failure and update circuit breaker state
      this.recordCircuitBreakerFailure();

      // Log error but don't throw - allow engine to continue with best-effort
      // This allows the system to work even if reconciliation fails
      this.logger?.warn(
        {
          err,
          circuitBreakerState: this.circuitBreakerState,
          failures: this.circuitBreakerFailures,
        },
        'State reconciliation failed - circuit breaker updated'
      );
      // Note: Don't throw here - we want the engine to remain operational
    }
  }

  private async ensureRuntime(): Promise<EngineRuntime> {
    await this.ensureStarted();

    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    // Retry loop protects against transport restarts that occur while we're awaiting
    // runtime capability probes. If the transport flips mid-await, we retry with the
    // fresh transport instead of throwing a spurious race-condition error.
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;

      const transport = this.runner.getTransport();
      if (!transport) {
        throw createTransportError('Python runtime transport unavailable');
      }

      // Fix Bug #26 (Critical): Engine state desync after Python restart
      // Fix Bug #31 (Critical): Clear model state and log lost models after restart
      // Bug Fix #55 Phase 2: State Synchronization Protocol
      // Bug Fix #61: Add atomic protection for state reconciliation
      // If transport changed (Python process restarted), recreate all dependent objects
      // to prevent stale references to the old transport
      if (this.lastTransport !== transport) {
        this.logger.warn(
          { oldTransport: !!this.lastTransport, newTransport: !!transport },
          'Transport changed, starting state reconciliation'
        );

        // Bug Fix #61: Check if reconciliation is already in progress
        // If yes, wait for it to complete instead of starting a new one
        // Bug Fix #73: Don't return early - continue to ensure initialization below
        if (this.reconcilePromise) {
          this.logger?.debug('State reconciliation already in progress, waiting for completion');
          await this.reconcilePromise;
          // Continue to initialization checks below instead of returning early
        } else {
          // Bug Fix #61: Update lastTransport BEFORE starting reconciliation
          // This prevents concurrent calls from entering this block
          this.lastTransport = transport;

          // Create the reconciliation promise
          this.reconcilePromise = (async () => {
            try {
              // Bug Fix #31 & #55 Phase 2: Log and emit invalidation events for all lost models
              // This helps users understand why their model handles suddenly stopped working
              if (this.modelManager) {
                const loadedModels = this.modelManager.listModels();
                if (loadedModels.length > 0) {
                  this.logger.warn(
                    {
                      lostModels: loadedModels.map(h => ({
                        id: h.descriptor.id,
                        state: h.state,
                        draft: h.draft,
                      })),
                      reason: 'python_restart',
                    },
                    'Clearing TypeScript model state - emitting invalidation events'
                  );

                  // Bug Fix #55 Phase 2: Emit invalidation events for user handles
                  for (const handle of loadedModels) {
                    this.emit('model:invalidated', {
                      modelId: handle.descriptor.id,
                      reason: 'python_restart',
                      timestamp: Date.now(),
                    });
                  }
                }
              }

              // Clean up StreamRegistry to remove any stale stream references
              // The registry itself persists, but active streams are invalid after restart
              this.runner.streamRegistry.cleanup();

              // Week 1: Clean up BatchQueue on transport change
              if (this.batchQueue) {
                this.batchQueue.cleanup();
                this.batchQueue = null;
              }

              // Clear TypeScript state
              this.modelManager = null;
              this.generatorFactory = null;

              // Bug Fix #55 Phase 2 & 3: Reconcile state with Python (with circuit breaker)
              // Check circuit breaker before attempting reconciliation
              if (this.canAttemptOperation()) {
                await this.reconcileState(transport);
              } else {
                this.logger?.warn(
                  {
                    circuitBreakerState: this.circuitBreakerState,
                    failures: this.circuitBreakerFailures,
                    lastFailure: this.circuitBreakerLastFailure,
                  },
                  'Skipping state reconciliation - circuit breaker is open'
                );
              }
            } finally {
              // Bug Fix #61: Clear the promise after completion
              this.reconcilePromise = null;
            }
          })();

          // Wait for reconciliation to complete
          await this.reconcilePromise;
        }
      } else if (this.reconcilePromise) {
        // Transport is stable but another caller already initiated reconciliation.
        // Wait for it to finish so we don't race against their cleanup.
        this.logger?.debug('Waiting for in-flight state reconciliation to finish');
        await this.reconcilePromise;
      }

      if (!this.modelManager) {
        this.modelManager = new ModelManager({
          transport,
          cacheDir: this.options.cacheDir,
          logger: this.logger,
        });
        // Phase 2: Initialize artifact cache
        await this.modelManager.initialize();

        // Auto-warmup models configured in warmup_on_start
        // This preloads frequently-used models for instant first-request performance
        await this.modelManager.warmupModels();
      }

      if (!this.generatorFactory) {
        this.generatorFactory = new GeneratorFactory(transport, this.runner.streamRegistry, {
          logger: this.logger,
          telemetry: this.telemetry,
        });
      }

      // Week 1: Initialize BatchQueue if not already initialized
      // Check Python runtime capabilities to determine if batching is supported
      if (!this.batchQueue) {
        try {
          // Query runtime capabilities
          const info = await transport.request<{ capabilities: string[] }>('runtime/info');
          const supportsBatching =
            info.capabilities?.includes('batch_tokenize') &&
            info.capabilities?.includes('batch_check_draft');

          if (supportsBatching) {
            this.batchQueue = new BatchQueue(transport, {
              logger: this.logger,
            });
            this.logger?.info('BatchQueue initialized - automatic request batching enabled');
          } else {
            this.logger?.debug(
              'BatchQueue disabled - Python runtime does not support batching capabilities'
            );
          }
        } catch (error) {
          // If capability detection fails, disable batching
          this.logger?.warn(
            { error },
            'Failed to detect batching capabilities - batching disabled'
          );
        }
      }

      // v1.3.0: Initialize GenerateBatcher if not already initialized
      // Check for batch_generate capability
      if (!this.generateBatcher) {
        try {
          // Query runtime capabilities
          const info = await transport.request<{ capabilities: string[] }>('runtime/info');
          const supportsGenerateBatching = info.capabilities?.includes('batch_generate');

          if (supportsGenerateBatching) {
            // TODO: Load config from runtime.yaml generate_batcher section
            // For now, use defaults from GenerateBatcher
            this.generateBatcher = new GenerateBatcher(
              transport,
              this.runner.streamRegistry,
              {
                enabled: true,
                minBatchSize: 2,
                maxBatchSize: 16,
                minHoldMs: 0.75,
                maxHoldMs: 3,
                backgroundHoldExtensionMs: 2,
                targetBatchTimeMs: 12,
                pauseOnBackpressureMs: 20,
                logger: this.logger,
                telemetry: this.telemetry,
              }
            );

            // Wire batcher into GeneratorFactory
            if (this.generatorFactory) {
              // Recreate GeneratorFactory with batcher
              this.generatorFactory = new GeneratorFactory(transport, this.runner.streamRegistry, {
                logger: this.logger,
                telemetry: this.telemetry,
                generateBatcher: this.generateBatcher,
              });
            }

            this.logger?.info('GenerateBatcher initialized - generate request batching enabled');
          } else {
            this.logger?.debug(
              'GenerateBatcher disabled - Python runtime does not support batch_generate capability'
            );
          }
        } catch (error) {
          // If capability detection fails, disable generate batching
          this.logger?.warn(
            { error },
            'Failed to detect generate batching capability - batching disabled'
          );
        }
      }

      const modelManager = this.modelManager;
      const generatorFactory = this.generatorFactory;

      if (modelManager && generatorFactory && this.lastTransport === transport) {
        return {
          transport,
          modelManager,
          generatorFactory,
        };
      }

      this.logger?.warn(
        {
          attempts,
          transportChanged: this.lastTransport !== transport,
          hasGeneratorFactory: !!this.generatorFactory,
        },
        'GeneratorFactory not ready after initialization attempt - retrying ensureRuntime'
      );
    }

    // If we've exhausted all attempts, throw an error
    throw new EngineClientError(
      'RuntimeError',
      'GeneratorFactory not initialized after repeated attempts - Python runtime may be unstable'
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.shuttingDown) {
      throw new EngineClientError('RuntimeError', 'Engine shutdown in progress');
    }

    if (!this.startPromise) {
      this.startPromise = this.runner
        .start()
        .then(() => {
          this.started = true;
        })
        .catch((error) => {
          this.startPromise = null;
          throw toEngineError(error, 'RuntimeError');
        });
    }

    try {
      await this.startPromise;
    } catch (error) {
      throw this.mapError(error, 'RuntimeError');
    }
  }

  private mapError(error: unknown, fallback: EngineErrorCode): EngineClientError {
    const mapped = toEngineError(error, fallback);
    const errorObj = mapped.toObject();

    this.telemetry?.onError?.(errorObj);
    this.emit('error', {
      error: errorObj,
      timestamp: Date.now(),
    });

    return mapped;
  }
}

export type { EngineOptions };

/**
 * Create and start a new engine instance.
 *
 * This is a convenience factory that constructs an Engine and automatically
 * starts the Python runtime. Prefer this over `new Engine()` for most use cases.
 *
 * @param options - Runtime configuration (python path, telemetry, cache directory, etc.).
 * @returns A ready-to-use Engine instance.
 *
 * @example
 * ```typescript
 * import { createEngine } from '@knowrag/kr-serve-mlx';
 *
 * const engine = await createEngine();
 * await engine.loadModel({ model: 'llama-3.1-8b' });
 * ```
 */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  const engine = new Engine(options);
  await engine['ensureStarted']();
  return engine;
}
