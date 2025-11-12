/**
 * Zod schema exports for mlx-serving API validation
 *
 * Phase 1 Week 1: Core API Schemas
 *
 * These schemas provide runtime validation for all API boundaries,
 * ensuring type safety and clear error messages for invalid inputs.
 *
 * @example
 * ```typescript
 * import { LoadModelOptionsSchema } from '@defai.digital/mlx-serving/schemas';
 *
 * const result = LoadModelOptionsSchema.safeParse({ model: 'llama-3-8b' });
 * if (!result.success) {
 *   console.error(result.error.issues);
 * }
 * ```
 */

// Common primitives
export * from './common.js';

// Model schemas
export * from './model.js';

// Generator schemas
export * from './generator.js';

// Tokenizer schemas
export * from './tokenizer.js';

// Config schemas
export * from './config.js';

// JSON-RPC schemas and validation helpers
export * from './jsonrpc.js';

// Telemetry schemas
export * from './telemetry.js';

// Event schemas
export * from './events.js';
