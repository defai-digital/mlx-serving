/**
 * Model-related Zod schemas
 *
 * Phase 1 Week 1: Validation schemas for model loading and management
 */

import { z } from 'zod';
import { NonEmptyString, QuantizationModeSchema } from './common.js';

/**
 * Tokenizer configuration schema
 * Mirrors: src/types/models.ts:TokenizerConfig
 */
export const TokenizerConfigSchema = z.object({
  type: z.string(),
  vocabSize: z.number().int().positive('Vocabulary size must be positive'),
  specialTokens: z.record(z.string(), z.number()).optional(),
});

/**
 * Model descriptor schema
 * Mirrors: src/types/models.ts:ModelDescriptor
 */
export const ModelDescriptorSchema = z.object({
  id: NonEmptyString,
  variant: z.string().optional(),
  source: z.enum(['huggingface', 'local'], {
    errorMap: () => ({ message: 'Source must be either huggingface or local' }),
  }),
  path: z.string().optional(),
  tokenizer: TokenizerConfigSchema.optional(),
  modality: z.enum(['text', 'vision', 'multimodal'], {
    errorMap: () => ({ message: 'Modality must be one of: text, vision, multimodal' }),
  }),
  family: z.enum(['mlx-lm', 'mlx-vlm'], {
    errorMap: () => ({ message: 'Family must be either mlx-lm or mlx-vlm' }),
  }),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/**
 * Load model options schema
 * Mirrors: src/types/engine.ts:LoadModelOptions
 *
 * Validates parameters for loading models with comprehensive error messages.
 * Uses .passthrough() to allow extra kwargs for mlx-engine compatibility.
 */
export const LoadModelOptionsSchema = z
  .object({
    model: z.union(
      [NonEmptyString, ModelDescriptorSchema],
      {
        errorMap: () => ({
          message: 'Model must be a non-empty string or a ModelDescriptor object',
        }),
      }
    ),
    draft: z.boolean().optional(),
    revision: z.string().optional(),
    quantization: QuantizationModeSchema.optional(),
    parameters: z.record(z.unknown()).optional(),
    trustRemoteCode: z.boolean().optional(),
  })
  .passthrough(); // Allow extra kwargs for mlx-engine compatibility

export type LoadModelOptions = z.infer<typeof LoadModelOptionsSchema>;

/**
 * Model state enum
 */
export const ModelStateSchema = z.enum(['loading', 'ready', 'failed'], {
  errorMap: () => ({ message: 'Model state must be one of: loading, ready, failed' }),
});

/**
 * Model handle schema (for runtime validation)
 * Mirrors: src/types/models.ts:ModelHandle
 */
export const ModelHandleSchema = z.object({
  descriptor: ModelDescriptorSchema,
  state: ModelStateSchema,
  contextLength: z.number().int().positive('Context length must be positive'),
  metadata: z.record(z.string(), z.unknown()),
  draft: z.boolean().optional(),
});

export type ModelHandle = z.infer<typeof ModelHandleSchema>;

/**
 * Compatibility report schema (for draft model validation)
 * Mirrors: src/types/models.ts:CompatibilityReport
 */
export const CompatibilityReportSchema = z.object({
  compatible: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  details: z.object({
    primaryModel: z.object({
      id: z.string(),
      vocabSize: z.number().nullable(),
      parameterCount: z.number(),
      architecture: z.string(),
    }),
    draftModel: z.object({
      id: z.string(),
      vocabSize: z.number().nullable(),
      parameterCount: z.number(),
      architecture: z.string(),
    }),
    performanceEstimate: z.object({
      expectedSpeedup: z.string(),
      sizeRatio: z.string(),
      recommendation: z.string(),
    }),
  }),
});

export type CompatibilityReport = z.infer<typeof CompatibilityReportSchema>;
