/**
 * Hint Hasher for Prompt Fingerprinting
 *
 * Generates stable hashes for prompts to enable speculation
 * and cache lookups.
 *
 * Phase 4.3 Implementation
 */

import crypto from 'crypto';
import type { PromptPayload } from './types.js';

/**
 * Generate a stable hash for a prompt payload
 */
export function hashPrompt(payload: PromptPayload): string {
  // Normalize the payload to ensure consistent hashing
  const normalized = {
    messages: payload.messages.map((m) => ({
      role: m.role.toLowerCase().trim(),
      content: m.content.trim(),
    })),
    systemPrompt: payload.systemPrompt?.trim() || '',
    // Exclude temperature and maxTokens from hash for better cache hits
  };

  const json = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(json).digest('hex').substring(0, 16);
}

/**
 * Generate a shorter hash for fast lookups
 */
export function hashPromptShort(payload: PromptPayload): string {
  return hashPrompt(payload).substring(0, 8);
}

/**
 * Estimate token count from prompt
 * Simple heuristic: ~4 characters per token on average
 */
export function estimateTokenCount(payload: PromptPayload): number {
  let totalChars = 0;

  for (const message of payload.messages) {
    totalChars += message.content.length;
  }

  if (payload.systemPrompt) {
    totalChars += payload.systemPrompt.length;
  }

  // Average 4 characters per token
  return Math.ceil(totalChars / 4);
}
