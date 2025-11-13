/**
 * Fast Validators
 *
 * OPTIMIZATION #1: Skip full Zod validation in production for high-frequency paths
 * These validators use simple type guards instead of Zod schema validation
 *
 * Expected benefit: 100-150ms per generation (100 tokens)
 * - Each StreamChunk validation: ~1-2ms saved
 * - StreamStats validation: ~2-3ms saved
 * - StreamEvent validation: ~1-2ms saved
 *
 * Safety: Development environment still uses full Zod validation
 */

import type {
  StreamChunkNotification,
  StreamStatsNotification,
  StreamEventNotification,
} from './serializers.js';

// Extract params types from notification types
type StreamChunkParams = StreamChunkNotification['params'];
type StreamStatsParams = StreamStatsNotification['params'];
type StreamEventParams = StreamEventNotification['params'];

/**
 * Fast validator for stream chunk notifications
 * Called for EVERY token generated (highest frequency path)
 *
 * @param params - Raw notification params
 * @returns Typed params if valid
 * @throws Error if validation fails
 */
export function fastValidateStreamChunk(params: unknown): StreamChunkParams {
  // OPTIMIZATION with SAFETY: Minimal validation even in production
  // Bug Fix: Complete bypass in production was security/reliability risk
  // Balance: Check critical fields only, skip expensive validations
  const p = params as Record<string, unknown>;

  // ALWAYS validate critical fields (even in production)
  // Cost: ~3 type checks × 50ns = 150ns per token (acceptable)
  if (!p || typeof p !== 'object') {
    throw new Error('Invalid stream chunk: not an object');
  }
  if (typeof p.stream_id !== 'string' || !p.stream_id) {
    throw new Error('Invalid stream chunk: missing stream_id');
  }
  if (Array.isArray((p as { tokens?: unknown }).tokens)) {
    const tokens = (p as { tokens: unknown[] }).tokens;

    if (tokens.length === 0) {
      throw new Error('Invalid stream chunk: tokens array cannot be empty');
    }

    for (const token of tokens) {
      if (!token || typeof token !== 'object') {
        throw new Error('Invalid stream chunk: token entry must be object');
      }

      const entry = token as Record<string, unknown>;

      if (typeof entry.token !== 'string') {
        throw new Error('Invalid stream chunk: token entry missing token');
      }

      if (
        typeof entry.token_id !== 'number' ||
        !Number.isInteger(entry.token_id) ||
        entry.token_id < 0
      ) {
        throw new Error('Invalid stream chunk: token entry token_id invalid');
      }

      if (entry.logprob !== undefined && typeof entry.logprob !== 'number') {
        throw new Error('Invalid stream chunk: token entry logprob must be number');
      }

      if (entry.is_final !== undefined && typeof entry.is_final !== 'boolean') {
        throw new Error('Invalid stream chunk: token entry is_final must be boolean');
      }
    }

    return params as StreamChunkParams;
  }

  if (typeof p.token !== 'string') {
    throw new Error('Invalid stream chunk: missing token');
  }

  // Production: Skip expensive validations (is_final, token_id, logprob)
  // Development: Full validation for debugging
  if (process.env.NODE_ENV !== 'production') {
    // Bug Fix: Check token_id is integer and non-negative (matching Zod schema)
    if (typeof p.token_id !== 'number' || !Number.isInteger(p.token_id) || p.token_id < 0) {
      throw new Error('Invalid stream chunk: token_id must be non-negative integer');
    }

    if (typeof p.is_final !== 'boolean') {
      throw new Error('Invalid stream chunk: is_final must be boolean');
    }

    // logprob is optional, but if present must be number
    if (p.logprob !== undefined && typeof p.logprob !== 'number') {
      throw new Error('Invalid stream chunk: logprob must be number');
    }
  }

  // Type assertion - we've verified the structure
  return params as StreamChunkParams;
}

/**
 * Fast validator for stream stats notifications
 * Called once per generation completion
 *
 * @param params - Raw notification params
 * @returns Typed params if valid
 * @throws Error if validation fails
 */
export function fastValidateStreamStats(params: unknown): StreamStatsParams {
  const p = params as Record<string, unknown>;

  if (!p || typeof p !== 'object') {
    throw new Error('Invalid stream stats: not an object');
  }

  if (typeof p.stream_id !== 'string' || !p.stream_id) {
    throw new Error('Invalid stream stats: missing stream_id');
  }

  // Bug Fix: Check tokens_generated is integer and non-negative (matching Zod schema)
  if (typeof p.tokens_generated !== 'number' || !Number.isInteger(p.tokens_generated) || p.tokens_generated < 0) {
    throw new Error('Invalid stream stats: tokens_generated must be non-negative integer');
  }

  // Bug Fix: Check tokens_per_second is non-negative (matching Zod schema)
  if (typeof p.tokens_per_second !== 'number' || p.tokens_per_second < 0) {
    throw new Error('Invalid stream stats: tokens_per_second must be non-negative');
  }

  // Bug Fix: Check time_to_first_token is non-negative (matching Zod schema)
  if (typeof p.time_to_first_token !== 'number' || p.time_to_first_token < 0) {
    throw new Error('Invalid stream stats: time_to_first_token must be non-negative');
  }

  // Bug Fix: Check total_time is non-negative (matching Zod schema)
  if (typeof p.total_time !== 'number' || p.total_time < 0) {
    throw new Error('Invalid stream stats: total_time must be non-negative');
  }

  return params as StreamStatsParams;
}

/**
 * Fast validator for stream event notifications
 * Called for stream lifecycle events (start, end, error)
 *
 * @param params - Raw notification params
 * @returns Typed params if valid
 * @throws Error if validation fails
 */
export function fastValidateStreamEvent(params: unknown): StreamEventParams {
  const p = params as Record<string, unknown>;

  if (!p || typeof p !== 'object') {
    throw new Error('Invalid stream event: not an object');
  }

  if (typeof p.stream_id !== 'string' || !p.stream_id) {
    throw new Error('Invalid stream event: missing stream_id');
  }

  if (typeof p.event !== 'string') {
    throw new Error('Invalid stream event: missing event');
  }

  if (typeof p.is_final !== 'boolean') {
    throw new Error('Invalid stream event: is_final must be boolean');
  }

  // Validate event type (discriminated union: 'completed' or 'error')
  if (p.event === 'completed') {
    // finish_reason is optional for completed events
    if (p.finish_reason !== undefined && typeof p.finish_reason !== 'string') {
      throw new Error('Invalid stream event: finish_reason must be string');
    }
  } else if (p.event === 'error') {
    // error field is required for error events
    if (typeof p.error !== 'string') {
      throw new Error('Invalid stream event: error must be string');
    }
  } else {
    throw new Error(`Invalid stream event: unknown event type "${p.event}"`);
  }

  return params as StreamEventParams;
}

/**
 * Check if fast validation should be used
 * Uses NODE_ENV to determine environment
 *
 * @returns true if production (use fast validation), false if development (use Zod)
 */
export function shouldUseFastValidation(): boolean {
  return process.env.NODE_ENV === 'production';
}
