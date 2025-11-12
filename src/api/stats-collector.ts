/**
 * GenerationStatsCollector
 *
 * Utility class for collecting generation statistics while iterating over tokens.
 * Mirrors mlx-engine's GenerationStatsCollector for API compatibility.
 *
 * @example
 * ```typescript
 * import { createEngine, GenerationStatsCollector } from '@defai.digital/mlx-serving';
 *
 * const engine = await createEngine();
 * await engine.loadModel({ model: 'llama-3.2-3b' });
 *
 * const stats = new GenerationStatsCollector();
 * const generator = engine.createGenerator({
 *   model: 'llama-3.2-3b',
 *   prompt: 'Hello world',
 *   maxTokens: 100
 * });
 *
 * for await (const chunk of generator) {
 *   if (chunk.type === 'token') {
 *     stats.update(chunk.token);
 *     console.log('Current speed:', stats.tokensPerSecond, 'tok/s');
 *   }
 * }
 *
 * console.log('Final stats:', stats.getStats());
 * ```
 */

import { performance } from 'node:perf_hooks';
import type { GenerationStats } from '../types/index.js';

export interface StatsCollectorOptions {
  /**
   * Whether to automatically start timing on first token.
   * Default: true
   */
  autoStart?: boolean;
}

/**
 * GenerationStatsCollector accumulates token generation metrics.
 *
 * P2-1: Implements mlx-engine's GenerationStatsCollector API for compatibility.
 *
 * Features:
 * - Tracks tokens generated, tokens/sec, TTFT, total time
 * - update() method for incremental token collection
 * - getStats() for final metrics
 * - reset() to reuse for multiple generations
 *
 * Compatibility Notes:
 * - Synchronous API matches mlx-engine's imperative style
 * - All timing in seconds to match Python behavior
 * - Exposes same metric fields as mlx-engine stats dicts
 */
export class GenerationStatsCollector {
  private startTime: number | null = null;
  private firstTokenTime: number | null = null;
  private tokenCount: number = 0;
  private lastUpdateTime: number | null = null;
  private readonly autoStart: boolean;

  constructor(options: StatsCollectorOptions = {}) {
    this.autoStart = options.autoStart !== undefined ? options.autoStart : true;
  }

  /**
   * Update statistics with a new token.
   *
   * P2-1: Matches mlx-engine's stats.update(token) signature.
   *
   * @param _token - The token text (can be string or object with token field)
   */
  public update(_token: string | { token: string }): void {
    const now = performance.now();

    // Auto-start timing on first token
    if (this.autoStart && this.startTime === null) {
      this.start();
    }

    // Record first token time (TTFT)
    if (this.firstTokenTime === null) {
      this.firstTokenTime = now;
    }

    this.tokenCount += 1;
    this.lastUpdateTime = now;
  }

  /**
   * Manually start timing (if autoStart is false).
   *
   * P2-1: Allows manual control of timing for benchmarking scenarios.
   */
  public start(): void {
    if (this.startTime === null) {
      this.startTime = performance.now();
    }
  }

  /**
   * Stop timing and finalize stats.
   *
   * P2-1: Optional - stats are always available via getStats().
   */
  public stop(): void {
    if (this.lastUpdateTime === null) {
      this.lastUpdateTime = performance.now();
    }
  }

  /**
   * Reset all counters for reuse.
   *
   * P2-1: Allows reusing the same collector instance across multiple generations.
   */
  public reset(): void {
    this.startTime = null;
    this.firstTokenTime = null;
    this.tokenCount = 0;
    this.lastUpdateTime = null;
  }

  /**
   * Get current statistics.
   *
   * P2-1: Returns stats in mlx-engine-compatible format.
   *
   * @returns GenerationStats object with current metrics
   */
  public getStats(): GenerationStats {
    const now = performance.now();
    const endTime = this.lastUpdateTime ?? now;

    // Calculate elapsed time in seconds
    const totalSeconds = this.startTime
      ? Math.max((endTime - this.startTime) / 1000, 0.0001)
      : 0;

    // Calculate TTFT in seconds
    const ttftSeconds =
      this.startTime && this.firstTokenTime
        ? Math.max((this.firstTokenTime - this.startTime) / 1000, 0)
        : 0;

    // Calculate tokens per second
    const tokensPerSecond = totalSeconds > 0 ? this.tokenCount / totalSeconds : 0;

    return {
      tokensGenerated: this.tokenCount,
      tokensPerSecond,
      timeToFirstToken: ttftSeconds,
      totalTime: totalSeconds,
    };
  }

  /**
   * Get tokens per second (convenience getter).
   *
   * P2-1: Matches mlx-engine's stats.tokens_per_second property.
   */
  public get tokensPerSecond(): number {
    return this.getStats().tokensPerSecond;
  }

  /**
   * Get time to first token in seconds (convenience getter).
   *
   * P2-1: Matches mlx-engine's stats.time_to_first_token property.
   */
  public get timeToFirstToken(): number {
    return this.getStats().timeToFirstToken;
  }

  /**
   * Get total time in seconds (convenience getter).
   *
   * P2-1: Matches mlx-engine's stats.total_time property.
   */
  public get totalTime(): number {
    return this.getStats().totalTime ?? 0;
  }

  /**
   * Get total tokens generated (convenience getter).
   *
   * P2-1: Matches mlx-engine's stats.tokens_generated property.
   */
  public get tokensGenerated(): number {
    return this.tokenCount;
  }

  /**
   * Check if timing has started.
   */
  public get isStarted(): boolean {
    return this.startTime !== null;
  }

  /**
   * Check if any tokens have been collected.
   */
  public get hasTokens(): boolean {
    return this.tokenCount > 0;
  }
}
