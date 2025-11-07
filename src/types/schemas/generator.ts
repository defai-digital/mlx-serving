/**
 * Generator and generation parameter Zod schemas
 *
 * Phase 1 Week 1: Validation schemas for text generation
 */

import { z } from 'zod';
import {
  NonEmptyString,
  PositiveInteger,
  NonNegativeInteger,
  NonNegativeNumber,
  ClampedTemperature,
  ClampedTopP,
  ClampedPenalty,
  StructuredFormat,
} from './common.js';

/**
 * Prompt template schema
 * Mirrors: src/types/generators.ts:PromptTemplate
 */
export const PromptTemplateSchema = z.object({
  template: z.string(),
  variables: z.record(z.string(), z.string()),
});

/**
 * Tokenized prompt schema
 */
export const TokenizedPromptSchema = z.object({
  tokens: z.array(NonNegativeInteger),
});

/**
 * Structured output configuration schema
 * Mirrors: src/types/generators.ts:StructuredOutputConfig
 */
export const StructuredOutputConfigSchema = z.object({
  schema: z.record(z.unknown()),
  format: StructuredFormat,
});

/**
 * Vision prompt configuration schema
 * Mirrors: src/types/generators.ts:VisionPromptConfig
 */
export const VisionPromptConfigSchema = z.object({
  images: z.array(z.string()),
  imageFormat: z
    .enum(['base64', 'url', 'path'], {
      errorMap: () => ({ message: 'Image format must be one of: base64, url, path' }),
    })
    .optional(),
});

/**
 * Generator parameters schema
 * Mirrors: src/types/generators.ts:GeneratorParams
 *
 * Comprehensive validation for all generation parameters.
 * Uses .passthrough() to allow extra kwargs for mlx-engine compatibility.
 */
export const GeneratorParamsSchema = z
  .object({
    model: NonEmptyString,
    prompt: z.union([z.string(), PromptTemplateSchema, TokenizedPromptSchema], {
      errorMap: () => ({
        message: 'Prompt must be a string, PromptTemplate, or TokenizedPrompt object',
      }),
    }),
    maxTokens: PositiveInteger.max(100000, 'maxTokens cannot exceed 100000').optional(),
    temperature: ClampedTemperature.optional(),
    topP: ClampedTopP.optional(),
    presencePenalty: ClampedPenalty.optional(),
    frequencyPenalty: ClampedPenalty.optional(),
    repetitionPenalty: NonNegativeNumber.optional(),
    stopSequences: z.array(z.string()).optional(),
    stopTokenIds: z.array(NonNegativeInteger).optional(),
    seed: NonNegativeInteger.optional(),
    streaming: z.boolean().optional(),
    structured: StructuredOutputConfigSchema.optional(),
    multimodal: VisionPromptConfigSchema.optional(),
    draftModel: z.string().optional(),
    promptTokens: z.array(NonNegativeInteger).optional(),
  })
  .passthrough(); // Allow extra kwargs

export type GeneratorParams = z.infer<typeof GeneratorParamsSchema>;

/**
 * Refined schema with structured output validation
 * Ensures both schema and format are present when structured output is used
 */
export const GeneratorParamsWithStructuredSchema = GeneratorParamsSchema.refine(
  (data) => {
    if (data.structured) {
      return data.structured.schema !== undefined && data.structured.format !== undefined;
    }
    return true;
  },
  {
    message:
      'structured.schema and structured.format are both required when using structured output',
    path: ['structured'],
  }
);

/**
 * Generation statistics schema
 * Mirrors: src/types/generators.ts:GenerationStats
 */
export const GenerationStatsSchema = z.object({
  tokensGenerated: z.number().int().nonnegative(),
  tokensPerSecond: z.number().nonnegative(),
  timeToFirstToken: z.number().nonnegative(),
  totalTime: z.number().nonnegative().optional(),
  draftTokensAccepted: z.number().int().nonnegative().optional(),
  modelId: z.string().optional(),
});

export type GenerationStats = z.infer<typeof GenerationStatsSchema>;

/**
 * Engine error schema
 * Mirrors: src/types/generators.ts:EngineError
 */
export const EngineErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

/**
 * Generator chunk schema (discriminated union)
 * Mirrors: src/types/generators.ts:GeneratorChunk
 */
export const GeneratorChunkSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('token'),
    token: z.string(),
    tokenId: z.number().int().optional(),
    logprob: z.number().optional(),
    isFinal: z.boolean().optional(),
    cumulativeText: z.string().optional(),
  }),
  z.object({
    type: z.literal('metadata'),
    stats: GenerationStatsSchema,
  }),
  z.object({
    type: z.literal('error'),
    error: EngineErrorSchema,
  }),
]);

export type GeneratorChunk = z.infer<typeof GeneratorChunkSchema>;
