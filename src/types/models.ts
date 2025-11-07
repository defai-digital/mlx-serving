/**
 * Model-related type definitions
 */

export interface ModelDescriptor {
  /** Canonical model identifier */
  id: string;
  /** Model variant (e.g., "instruct") */
  variant?: string;
  /** Model source */
  source: 'huggingface' | 'local';
  /** Resolved local path */
  path?: string;
  /** Tokenizer configuration */
  tokenizer?: TokenizerConfig;
  /** Model modality */
  modality: 'text' | 'vision' | 'multimodal';
  /** Model family */
  family: 'mlx-lm' | 'mlx-vlm';
}

export interface TokenizerConfig {
  type: string;
  vocabSize: number;
  specialTokens?: Record<string, number>;
}

export type ModelState = 'loading' | 'ready' | 'failed';

export interface ModelHandle {
  descriptor: ModelDescriptor;
  state: ModelState;
  contextLength: number;
  metadata: Record<string, unknown>;
  draft?: boolean;
}

/**
 * Draft model compatibility report (Week 2 Day 1: Enhanced)
 */
export interface CompatibilityReport {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  details: {
    primaryModel: {
      id: string;
      vocabSize: number | null;
      parameterCount: number;
      architecture: string;
    };
    draftModel: {
      id: string;
      vocabSize: number | null;
      parameterCount: number;
      architecture: string;
    };
    performanceEstimate: {
      expectedSpeedup: string;
      sizeRatio: string;
      recommendation: string;
    };
  };
}
