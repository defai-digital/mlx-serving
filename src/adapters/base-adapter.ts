/**
 * Base adapter interface for inference providers
 *
 * This design allows switching between:
 * - Phase 1: Python MLX-LM (current)
 * - Phase 2: C++ Native Provider (future)
 * - Phase 3: Hybrid or custom providers
 */

import type {
  ModelDescriptor,
  ModelHandle,
  CompatibilityReport,
} from '../types/models.js';
import type {
  GeneratorParams,
  GeneratorChunk,
  TokenizeRequest,
  TokenizeResponse,
  LoadModelOptions,
} from '../types/index.js';

/**
 * Adapter context provided by the engine
 */
export interface AdapterContext {
  /** Provider-specific configuration */
  config: Record<string, unknown>;
  /** Cache directory for models/tokenizers */
  cacheDir: string;
  /** Telemetry hooks */
  telemetry?: {
    onEvent: (event: string, data: unknown) => void;
  };
}

/**
 * Provider types supported by the system
 */
export type ProviderType =
  | 'python-mlx-lm'    // Phase 1: Python bridge to mlx-lm
  | 'cpp-native'       // Phase 2: C++ native provider
  | 'hybrid'           // Phase 3: Hybrid approach
  | 'custom';          // User-defined providers

/**
 * Provider metadata
 */
export interface ProviderInfo {
  type: ProviderType;
  name: string;
  version: string;
  capabilities: string[];
}

/**
 * Base interface all adapters must implement
 *
 * This abstraction allows seamless provider switching
 */
export interface ModelAdapter {
  /**
   * Get provider information
   */
  getProviderInfo(): ProviderInfo;

  /**
   * Check if this adapter can handle the given model
   */
  supports(descriptor: ModelDescriptor): boolean;

  /**
   * Initialize the adapter with context
   */
  initialize(context: AdapterContext): Promise<void>;

  /**
   * Load a model into memory
   */
  load(
    descriptor: ModelDescriptor,
    options: LoadModelOptions
  ): Promise<ModelHandle>;

  /**
   * Unload a model from memory
   */
  unload(handle: ModelHandle): Promise<void>;

  /**
   * Create a token generator
   */
  createGenerator(
    handle: ModelHandle,
    params: GeneratorParams
  ): AsyncGenerator<GeneratorChunk, void>;

  /**
   * Tokenize text
   */
  tokenize(
    handle: ModelHandle,
    request: TokenizeRequest
  ): Promise<TokenizeResponse>;

  /**
   * Check if draft model is compatible with primary
   */
  isDraftCompatible(
    primary: ModelHandle,
    draft: ModelHandle
  ): Promise<CompatibilityReport>;

  /**
   * Cleanup resources
   */
  dispose(): Promise<void>;
}

/**
 * Abstract base class with common functionality
 */
export abstract class BaseAdapter implements ModelAdapter {
  protected context?: AdapterContext;
  protected initialized = false;

  abstract getProviderInfo(): ProviderInfo;
  abstract supports(descriptor: ModelDescriptor): boolean;
  abstract load(
    descriptor: ModelDescriptor,
    options: LoadModelOptions
  ): Promise<ModelHandle>;
  abstract unload(handle: ModelHandle): Promise<void>;
  abstract createGenerator(
    handle: ModelHandle,
    params: GeneratorParams
  ): AsyncGenerator<GeneratorChunk, void>;
  abstract tokenize(
    handle: ModelHandle,
    request: TokenizeRequest
  ): Promise<TokenizeResponse>;

  async initialize(context: AdapterContext): Promise<void> {
    this.context = context;
    this.initialized = true;
  }

  async isDraftCompatible(
    primary: ModelHandle,
    draft: ModelHandle
  ): Promise<CompatibilityReport> {
    // Default implementation: basic tokenizer compatibility check
    // Week 2 Day 1: Updated to match enhanced CompatibilityReport interface
    const primaryTokenizer = primary.descriptor.tokenizer;
    const draftTokenizer = draft.descriptor.tokenizer;

    const errors: string[] = [];
    const _warnings: string[] = [];

    if (!primaryTokenizer || !draftTokenizer) {
      errors.push('Missing tokenizer information');
    } else if (primaryTokenizer.type !== draftTokenizer.type) {
      errors.push('Tokenizer types do not match');
    }

    // Build details structure (use default values for unknown fields)
    const primaryParams = (primary.metadata.parameterCount as number) ?? 0;
    const draftParams = (draft.metadata.parameterCount as number) ?? 0;

    return {
      compatible: errors.length === 0,
      errors,
      warnings:
        errors.length === 0
          ? ['Compatibility verified based on tokenizer type only']
          : [],
      details: {
        primaryModel: {
          id: primary.descriptor.id,
          vocabSize: primaryTokenizer?.vocabSize ?? null,
          parameterCount: primaryParams,
          architecture: (primary.metadata.architecture as string) ?? 'unknown',
        },
        draftModel: {
          id: draft.descriptor.id,
          vocabSize: draftTokenizer?.vocabSize ?? null,
          parameterCount: draftParams,
          architecture: (draft.metadata.architecture as string) ?? 'unknown',
        },
        performanceEstimate: {
          expectedSpeedup: '1.00x',
          sizeRatio: 'N/A',
          recommendation: 'Basic compatibility check only',
        },
      },
    };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.context = undefined;
  }

  protected ensureInitialized(): void {
    if (!this.initialized || !this.context) {
      throw new Error('Adapter not initialized. Call initialize() first.');
    }
  }

  protected emitTelemetry(event: string, data: unknown): void {
    this.context?.telemetry?.onEvent(event, data);
  }
}
