/**
 * Common Zod schema primitives for mlx-serving
 *
 * Phase 1 Week 1: Core primitives used across all schemas
 */

import { z } from 'zod';

/**
 * Non-empty string validator
 */
export const NonEmptyString = z.string().min(1, 'Cannot be empty');

/**
 * Positive integer validator
 */
export const PositiveInteger = z
  .number()
  .int('Must be an integer')
  .positive('Must be a positive integer');

/**
 * Non-negative integer validator
 */
export const NonNegativeInteger = z
  .number()
  .int('Must be an integer')
  .min(0, 'Must be non-negative');

/**
 * Non-negative number validator
 */
export const NonNegativeNumber = z.number().min(0, 'Must be non-negative');

/**
 * Temperature parameter (0-2 range)
 */
export const ClampedTemperature = z
  .number()
  .min(0, 'Temperature must be at least 0')
  .max(2, 'Temperature cannot exceed 2');

/**
 * Top-p parameter (0-1 range)
 */
export const ClampedTopP = z
  .number()
  .min(0, 'Top-p must be at least 0')
  .max(1, 'Top-p cannot exceed 1');

/**
 * Penalty parameters (-2 to 2 range)
 */
export const ClampedPenalty = z
  .number()
  .min(-2, 'Penalty must be at least -2')
  .max(2, 'Penalty cannot exceed 2');

/**
 * Quantization mode enum
 */
export const QuantizationMode = z.enum(['none', 'int8', 'int4'], {
  errorMap: () => ({ message: 'Quantization must be one of: none, int8, int4' }),
});

/**
 * Structured output format enum
 */
export const StructuredFormat = z.enum(['json', 'yaml'], {
  errorMap: () => ({ message: 'Format must be either json or yaml' }),
});
