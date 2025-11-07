/**
 * Engine Event Payload Schemas
 *
 * Zod schemas for validating all Engine event payloads.
 *
 * @module schemas/events
 */

import { z } from 'zod';

/**
 * Model Loaded Event Schema
 *
 * Emitted when a model is successfully loaded into memory.
 */
export const ModelLoadedEventSchema = z.object({
  modelId: z.string().min(1, 'Model ID cannot be empty'),
  handle: z.object({
    id: z.string(),
    descriptor: z.any(), // ModelDescriptor is complex, allow any for now
  }),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Model Unloaded Event Schema
 *
 * Emitted when a model is unloaded from memory.
 */
export const ModelUnloadedEventSchema = z.object({
  modelId: z.string().min(1, 'Model ID cannot be empty'),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Model Invalidated Event Schema
 *
 * Emitted when a model handle becomes invalid (Python restart, unload, error).
 */
export const ModelInvalidatedEventSchema = z.object({
  modelId: z.string().min(1, 'Model ID cannot be empty'),
  reason: z.enum(['python_restart', 'unload', 'error'], {
    errorMap: () => ({ message: 'Reason must be one of: python_restart, unload, error' }),
  }),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Generation Started Event Schema
 *
 * Emitted when text generation begins.
 */
export const GenerationStartedEventSchema = z.object({
  streamId: z.string().min(1, 'Stream ID cannot be empty'),
  modelId: z.string().min(1, 'Model ID cannot be empty'),
  prompt: z.string(), // Allow empty string
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Token Generated Event Schema
 *
 * Emitted for each generated token during streaming.
 *
 * Note: Empty token is allowed (EOS marker).
 */
export const TokenGeneratedEventSchema = z.object({
  streamId: z.string().min(1, 'Stream ID cannot be empty'),
  token: z.string(), // Allow empty string (EOS marker)
  logprob: z.number().optional(),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Generation Completed Event Schema
 *
 * Emitted when text generation completes.
 */
export const GenerationCompletedEventSchema = z.object({
  streamId: z.string().min(1, 'Stream ID cannot be empty'),
  stats: z.object({
    tokensGenerated: z.number().int().min(0, 'Tokens generated must be >= 0'),
    totalTimeMs: z.number().min(0, 'Total time must be >= 0').optional(),
    tokensPerSecond: z.number().min(0, 'Tokens per second must be >= 0').optional(),
  }),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Error Event Schema
 *
 * Emitted when an error occurs in the engine.
 */
export const ErrorEventSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional(),
  }),
  context: z.string().optional(),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Runtime Status Event Schema
 *
 * Emitted when the runtime status changes.
 */
export const RuntimeStatusEventSchema = z.object({
  status: z.enum(['starting', 'ready', 'error', 'stopped'], {
    errorMap: () => ({ message: 'Status must be one of: starting, ready, error, stopped' }),
  }),
  previousStatus: z.string().optional(),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Type inference for event schemas
 */
export type ModelLoadedEvent = z.infer<typeof ModelLoadedEventSchema>;
export type ModelUnloadedEvent = z.infer<typeof ModelUnloadedEventSchema>;
export type ModelInvalidatedEvent = z.infer<typeof ModelInvalidatedEventSchema>;
export type GenerationStartedEvent = z.infer<typeof GenerationStartedEventSchema>;
export type TokenGeneratedEvent = z.infer<typeof TokenGeneratedEventSchema>;
export type GenerationCompletedEvent = z.infer<typeof GenerationCompletedEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type RuntimeStatusEvent = z.infer<typeof RuntimeStatusEventSchema>;
