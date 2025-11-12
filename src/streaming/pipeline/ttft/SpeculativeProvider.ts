/**
 * Speculative Token Provider
 *
 * Manages first-token speculation with confidence tracking,
 * rollback on mismatch, and allowlist-based enablement.
 *
 * Phase 4.3 Implementation
 */

import { safeAverage, safeDivide } from '@/utils/math-helpers.js';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type {
  SpeculationCandidate,
  SpeculationStats,
} from './types.js';

/**
 * Speculative provider configuration
 */
export interface SpeculationConfig {
  enabled: boolean;
  allowlistOnly: boolean;
  maxCandidates: number;
  minConfidence: number;
  decayFactor: number; // Decay factor for confidence on failure
}

/**
 * Provider events
 */
export interface SpeculationEvents {
  hit: (promptHash: string, confidence: number) => void;
  miss: (promptHash: string) => void;
  success: (promptHash: string) => void;
  failure: (promptHash: string) => void;
}

/**
 * Speculative Token Provider
 *
 * Provides first-token speculation based on prompt history.
 * Tracks success/failure rates and adjusts confidence accordingly.
 */
export class SpeculativeProvider extends EventEmitter<SpeculationEvents> {
  private candidates = new Map<string, SpeculationCandidate>();
  private allowlist = new Set<string>();
  private config: SpeculationConfig;
  private logger?: Logger;
  private totalAttempts = 0;
  private successCount = 0;
  private failureCount = 0;

  constructor(config: SpeculationConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Get candidate tokens for a prompt hash
   */
  public async getCandidateTokens(promptHash: string): Promise<string[] | null> {
    if (!this.config.enabled) {
      return null;
    }

    // Check allowlist if required
    if (this.config.allowlistOnly && !this.allowlist.has(promptHash)) {
      try {
        this.emit('miss', promptHash);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting miss event');
      }
      return null;
    }

    const candidate = this.candidates.get(promptHash);
    if (!candidate) {
      try {
        this.emit('miss', promptHash);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting miss event');
      }
      return null;
    }

    // Check confidence threshold
    if (candidate.confidence < this.config.minConfidence) {
      this.logger?.debug(
        { promptHash, confidence: candidate.confidence, threshold: this.config.minConfidence },
        'Candidate below confidence threshold'
      );
      return null;
    }

    this.totalAttempts++;

    this.logger?.debug(
      { promptHash, tokens: candidate.candidateTokens, confidence: candidate.confidence },
      'Returning speculative tokens'
    );

    try {
      this.emit('hit', promptHash, candidate.confidence);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting hit event');
    }

    return candidate.candidateTokens;
  }

  /**
   * Record speculation outcome
   */
  public recordOutcome(promptHash: string, accepted: boolean): void {
    const candidate = this.candidates.get(promptHash);
    if (!candidate) {
      return;
    }

    if (accepted) {
      candidate.successCount++;
      this.successCount++;

      // Increase confidence on success
      candidate.confidence = Math.min(1.0, candidate.confidence * 1.1);

      this.logger?.debug(
        { promptHash, successCount: candidate.successCount, confidence: candidate.confidence },
        'Speculation success'
      );

      try {
        this.emit('success', promptHash);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting success event');
      }
    } else {
      candidate.failureCount++;
      this.failureCount++;

      // Decrease confidence on failure
      candidate.confidence = Math.max(0.1, candidate.confidence * this.config.decayFactor);

      this.logger?.debug(
        { promptHash, failureCount: candidate.failureCount, confidence: candidate.confidence },
        'Speculation failure'
      );

      try {
        this.emit('failure', promptHash);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting failure event');
      }
    }

    candidate.lastUpdated = Date.now();
  }

  /**
   * Add a prompt to the allowlist with initial tokens
   */
  public allowPrompt(promptHash: string, tokens: string[], confidence = 0.8): void {
    this.allowlist.add(promptHash);

    const candidate: SpeculationCandidate = {
      promptHash,
      candidateTokens: tokens,
      confidence,
      lastUpdated: Date.now(),
      successCount: 0,
      failureCount: 0,
    };

    this.candidates.set(promptHash, candidate);

    this.logger?.info(
      { promptHash, tokens, confidence },
      'Prompt added to speculation allowlist'
    );
  }

  /**
   * Remove a prompt from the allowlist
   */
  public disallowPrompt(promptHash: string): void {
    this.allowlist.delete(promptHash);
    this.candidates.delete(promptHash);

    this.logger?.info({ promptHash }, 'Prompt removed from speculation allowlist');
  }

  /**
   * Update candidate tokens (e.g., after observing actual first tokens)
   */
  public updateCandidate(promptHash: string, tokens: string[]): void {
    const candidate = this.candidates.get(promptHash);
    if (candidate) {
      candidate.candidateTokens = tokens;
      candidate.lastUpdated = Date.now();
    } else {
      // Create new candidate if not in allowlist-only mode
      if (!this.config.allowlistOnly) {
        this.candidates.set(promptHash, {
          promptHash,
          candidateTokens: tokens,
          confidence: 0.5, // Medium initial confidence
          lastUpdated: Date.now(),
          successCount: 0,
          failureCount: 0,
        });
      }
    }

    // Enforce max candidates limit
    if (this.candidates.size > this.config.maxCandidates) {
      this.evictLowestConfidence();
    }
  }

  /**
   * Evict the candidate with lowest confidence
   */
  private evictLowestConfidence(): void {
    let lowestConfidence = 1.0;
    let lowestHash: string | null = null;

    for (const [hash, candidate] of this.candidates.entries()) {
      if (candidate.confidence < lowestConfidence) {
        lowestConfidence = candidate.confidence;
        lowestHash = hash;
      }
    }

    if (lowestHash) {
      this.candidates.delete(lowestHash);
      this.logger?.debug({ promptHash: lowestHash, confidence: lowestConfidence }, 'Evicted low-confidence candidate');
    }
  }

  /**
   * Get accuracy rate
   */
  public getAccuracyRate(): number {
    return safeDivide(this.successCount, this.totalAttempts);
  }

  /**
   * Get statistics
   */
  public getStats(): SpeculationStats {
    const confidences = Array.from(this.candidates.values()).map((c) => c.confidence);
    const avgConfidence = safeAverage(confidences);

    return {
      totalAttempts: this.totalAttempts,
      successCount: this.successCount,
      failureCount: this.failureCount,
      accuracyRate: this.getAccuracyRate(),
      avgConfidence,
    };
  }

  /**
   * Clear all candidates and allowlist
   */
  public clear(): void {
    this.candidates.clear();
    this.allowlist.clear();
    this.logger?.info('Speculation cache cleared');
  }
}
