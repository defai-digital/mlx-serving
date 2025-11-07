/**
 * Generator and tokenization types
 */

export interface GeneratorParams {
  model: string;
  prompt: string | PromptTemplate | { tokens: number[] };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  stopSequences?: string[];
  stopTokenIds?: number[];
  seed?: number;
  streaming?: boolean;
  structured?: StructuredOutputConfig;
  multimodal?: VisionPromptConfig;

  /**
   * Draft model for speculative decoding (Week 2 Day 1)
   *
   * Enables faster inference by using a smaller draft model to generate
   * candidate tokens that are validated by the primary model.
   *
   * Requirements:
   * - Draft model must be loaded via loadDraftModel()
   * - Draft model must be compatible with primary model (same vocabulary)
   * - Draft model should be significantly smaller for performance gains
   *
   * Expected performance: 20-30% latency reduction with compatible models
   *
   * @see isDraftModelCompatible() to verify compatibility
   * @example
   * ```typescript
   * // Load models
   * await engine.loadModel({ model: 'llama-3-8b' });
   * await engine.loadDraftModel({ model: 'llama-3.2-3b' });
   *
   * // Generate with draft model
   * const generator = engine.createGenerator({
   *   model: 'llama-3-8b',
   *   prompt: 'Hello',
   *   draftModel: 'llama-3.2-3b'
   * });
   * ```
   */
  draftModel?: string;

  // P2-2: Extra kwargs for mlx-engine compatibility
  promptTokens?: number[];        // Pre-tokenized prompt for reuse
  [key: string]: unknown;          // Allow passthrough of additional kwargs
}

export interface PromptTemplate {
  template: string;
  variables: Record<string, string>;
}

export interface StructuredOutputConfig {
  schema: Record<string, unknown>;
  format: 'json' | 'yaml';
}

export interface VisionPromptConfig {
  images: string[];
  imageFormat?: 'base64' | 'url' | 'path';
}

export type GeneratorChunk =
  | {
      type: 'token';
      token: string;
      tokenId?: number;           // P1-2: Token ID from tokenizer
      logprob?: number;
      isFinal?: boolean;          // P1-2: True if this is the last token
      cumulativeText?: string;    // P1-2: Full text generated so far (mlx-engine compat)
    }
  | { type: 'metadata'; stats: GenerationStats }
  | { type: 'error'; error: EngineError };

export interface TokenizeRequest {
  model: string;
  text: string;
  addBos?: boolean;
}

export interface TokenizeResponse {
  tokens: number[];
  tokenStrings?: string[];
}

export interface GenerationStats {
  tokensGenerated: number;
  tokensPerSecond: number;
  timeToFirstToken: number;
  totalTime?: number; // Optional for defensive programming
  draftTokensAccepted?: number;
  modelId?: string;
}

export interface EngineError {
  code?: string; // Optional for defensive programming (defaults to 'UNKNOWN')
  message: string;
  details?: Record<string, unknown>;
}
