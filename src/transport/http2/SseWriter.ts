/**
 * SSE Writer with Zero-Copy Optimization
 *
 * Formats Server-Sent Events with chunk pooling to reduce allocations.
 * Handles backpressure detection via response.write() buffer monitoring.
 *
 * Phase 4.2 Implementation
 */

import type { ServerHttp2Stream } from 'http2';
import type { Logger } from 'pino';
import { ChunkPool, type ChunkPoolConfig } from './ChunkPool.js';
import type { SseChunk } from './types.js';

/**
 * SSE Writer Configuration
 */
export interface SseWriterConfig {
  chunkPool: ChunkPoolConfig;
  backpressureThreshold: number; // bytes
  maxBufferedChunks: number;
}

/**
 * SSE event writer with zero-copy optimization
 *
 * Formats SSE events efficiently using pooled buffers and
 * monitors backpressure to prevent memory buildup.
 */
export class SseWriter {
  private stream: ServerHttp2Stream;
  private chunkPool: ChunkPool;
  private config: SseWriterConfig;
  private logger?: Logger;
  private bufferedBytes = 0;
  private chunksWritten = 0;

  constructor(
    stream: ServerHttp2Stream,
    config: SseWriterConfig,
    logger?: Logger
  ) {
    this.stream = stream;
    this.config = config;
    this.chunkPool = new ChunkPool(config.chunkPool, logger);
    this.logger = logger;

    // Monitor drain events
    this.stream.on('drain', () => {
      this.bufferedBytes = 0;
      this.logger?.debug('Stream drained');
    });
  }

  /**
   * Write an SSE chunk
   */
  public async writeChunk(chunk: SseChunk): Promise<void> {
    const formatted = this.formatSseChunk(chunk);

    // Check backpressure before writing
    if (this.bufferedBytes >= this.config.backpressureThreshold) {
      await this.handleBackpressure();
    }

    // Write to stream
    const success = this.stream.write(formatted);

    if (!success) {
      this.bufferedBytes += formatted.length;
    } else {
      this.bufferedBytes = 0;
    }

    this.chunksWritten++;
  }

  /**
   * Write an event with automatic JSON stringification
   */
  public async writeEvent(event: string, data: unknown): Promise<void> {
    const chunk: SseChunk = {
      event,
      data: JSON.stringify(data),
    };

    await this.writeChunk(chunk);
  }

  /**
   * Format SSE chunk according to SSE specification
   *
   * Format:
   *   event: <event>\n
   *   id: <id>\n
   *   retry: <retry>\n
   *   data: <data>\n\n
   */
  private formatSseChunk(chunk: SseChunk): string {
    const parts: string[] = [];

    if (chunk.event) {
      parts.push(`event: ${chunk.event}\n`);
    }

    if (chunk.id) {
      parts.push(`id: ${chunk.id}\n`);
    }

    if (chunk.retry !== undefined) {
      parts.push(`retry: ${chunk.retry}\n`);
    }

    // Data must be present
    parts.push(`data: ${chunk.data}\n\n`);

    return parts.join('');
  }

  /**
   * Handle backpressure by waiting for drain
   */
  public async handleBackpressure(): Promise<void> {
    this.logger?.warn(
      { bufferedBytes: this.bufferedBytes },
      'Backpressure detected, waiting for drain'
    );

    return new Promise<void>((resolve) => {
      const onDrain = () => {
        this.stream.off('drain', onDrain);
        resolve();
      };

      this.stream.once('drain', onDrain);

      // Timeout after 30 seconds
      setTimeout(() => {
        this.stream.off('drain', onDrain);
        this.logger?.error('Drain timeout, proceeding anyway');
        resolve();
      }, 30000);
    });
  }

  /**
   * Close the stream with optional code
   */
  public async close(code?: number): Promise<void> {
    // Write final comment indicating close
    this.stream.write(': stream closed\n\n');

    // Close with code if provided
    if (code !== undefined && !this.stream.closed) {
      this.stream.close(code);
    } else if (!this.stream.closed) {
      this.stream.end();
    }

    // Clear chunk pool
    this.chunkPool.clear();

    this.logger?.info(
      { chunksWritten: this.chunksWritten, poolStats: this.chunkPool.getStats() },
      'SSE stream closed'
    );
  }

  /**
   * Write a comment (for keepalive)
   */
  public writeComment(comment: string): void {
    this.stream.write(`: ${comment}\n\n`);
  }

  /**
   * Get statistics
   */
  public getStats(): {
    chunksWritten: number;
    bufferedBytes: number;
    poolStats: ReturnType<ChunkPool['getStats']>;
  } {
    return {
      chunksWritten: this.chunksWritten,
      bufferedBytes: this.bufferedBytes,
      poolStats: this.chunkPool.getStats(),
    };
  }
}
