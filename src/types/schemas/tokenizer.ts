/**
 * Tokenizer-related Zod schemas
 *
 * Phase 1 Week 1: Validation schemas for tokenization
 */

import { z } from 'zod';
import { NonEmptyString, NonNegativeInteger } from './common.js';

/**
 * Tokenize request schema
 * Mirrors: src/types/generators.ts:TokenizeRequest
 */
export const TokenizeRequestSchema = z.object({
  model: NonEmptyString,
  text: z.string(), // Allow empty string (valid tokenization case)
  addBos: z.boolean().optional(),
});

export type TokenizeRequest = z.infer<typeof TokenizeRequestSchema>;

/**
 * Tokenize response schema (for output validation)
 * Mirrors: src/types/generators.ts:TokenizeResponse
 */
export const TokenizeResponseSchema = z.object({
  tokens: z.array(NonNegativeInteger),
  tokenStrings: z.array(z.string()).optional(),
});

export type TokenizeResponse = z.infer<typeof TokenizeResponseSchema>;
