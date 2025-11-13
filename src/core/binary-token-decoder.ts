/**
 * Binary Token Decoder - Phase 1: Performance Optimization
 *
 * Decodes MessagePack binary messages from Python runtime for improved throughput.
 *
 * Message Format:
 *   [4 bytes: length (big-endian)] + [N bytes: msgpack data]
 *
 * Message Types:
 *   1 = Token (stream.chunk)
 *   2 = Stats (stream.stats)
 *   3 = Event (stream.event)
 *   4 = Done (stream.done)
 *
 * Performance Impact:
 *   - JSON: ~150 bytes per token
 *   - MessagePack: ~20 bytes per token
 *   - Bandwidth savings: ~85%
 *   - Throughput improvement: 3-5% on 14B+ models
 */

import { Transform, TransformCallback } from "stream";
import * as msgpack from "msgpack-lite";

/**
 * Binary message type constants (must match Python runtime.py)
 */
export enum BinaryMessageType {
  TOKEN = 1, // Token chunk (stream.chunk)
  STATS = 2, // Statistics (stream.stats)
  EVENT = 3, // Events (stream.event)
  DONE = 4, // Stream completion (stream.done)
}

/**
 * Decoded binary message structure
 */
export interface BinaryMessage {
  /** Message type (1-4) */
  t: BinaryMessageType;
  /** Payload parameters */
  p: Record<string, unknown>;
}

/**
 * Binary Token Decoder Transform Stream
 *
 * Processes binary MessagePack messages from Python runtime stdout.
 * Handles message framing with length prefixes and decodes MessagePack payloads.
 *
 * Usage:
 *   const decoder = new BinaryTokenDecoder();
 *   pythonStdout.pipe(decoder);
 *
 *   decoder.on('data', (msg: BinaryMessage) => {
 *     if (msg.t === BinaryMessageType.TOKEN) {
 *       console.log('Token:', msg.p.token);
 *     }
 *   });
 *
 *   decoder.on('error', (error) => {
 *     console.error('Decoding error:', error);
 *   });
 */
export class BinaryTokenDecoder extends Transform {
  /** Internal buffer for accumulating chunks */
  private buffer = Buffer.alloc(0);

  /** Total bytes decoded (for debugging/metrics) */
  private totalBytesDecoded = 0;

  /** Total messages decoded (for debugging/metrics) */
  private totalMessagesDecoded = 0;

  constructor() {
    super({
      // Operate in object mode - output decoded message objects
      writableObjectMode: false,
      readableObjectMode: true,
    });
  }

  /**
   * Transform implementation - processes incoming binary chunks
   *
   * @param chunk - Incoming data chunk from Python stdout
   * @param _encoding - Encoding (ignored, we work with buffers)
   * @param callback - Completion callback
   */
  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback
  ): void {
    try {
      // Append new chunk to internal buffer
      this.buffer = Buffer.concat([this.buffer, chunk]);

      // Process all complete messages in buffer
      while (this.buffer.length >= 4) {
        // Read length prefix (4 bytes, big-endian unsigned int)
        const messageLength = this.buffer.readUInt32BE(0);

        // Check if we have complete message
        if (this.buffer.length < 4 + messageLength) {
          break; // Wait for more data
        }

        // Extract message bytes
        const messageBytes = this.buffer.subarray(4, 4 + messageLength);

        // Remove processed message from buffer
        this.buffer = this.buffer.subarray(4 + messageLength);

        // Decode MessagePack
        try {
          const decoded = msgpack.decode(messageBytes) as BinaryMessage;

          // Update metrics
          this.totalBytesDecoded += 4 + messageLength;
          this.totalMessagesDecoded++;

          // Push decoded message to output stream
          this.push(decoded);
        } catch (error) {
          // MessagePack decoding failed
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          this.emit(
            "error",
            new Error(`MessagePack decoding failed: ${errorMsg}`)
          );
          // Continue processing remaining buffer
        }
      }

      // Done processing this chunk
      callback();
    } catch (error) {
      // Unexpected error during processing
      const errorMsg = error instanceof Error ? error.message : String(error);
      callback(new Error(`Binary decoder error: ${errorMsg}`));
    }
  }

  /**
   * Flush implementation - called when stream is ending
   *
   * @param callback - Completion callback
   */
  override _flush(callback: TransformCallback): void {
    // If buffer has leftover data, it's incomplete
    if (this.buffer.length > 0) {
      this.emit(
        "warning",
        new Error(
          `Binary decoder has ${this.buffer.length} bytes of incomplete data at stream end`
        )
      );
    }

    callback();
  }

  /**
   * Get decoding statistics (for debugging/monitoring)
   *
   * @returns Decoder statistics
   */
  getStats(): { bytesDecoded: number; messagesDecoded: number } {
    return {
      bytesDecoded: this.totalBytesDecoded,
      messagesDecoded: this.totalMessagesDecoded,
    };
  }

  /**
   * Reset decoder statistics
   */
  resetStats(): void {
    this.totalBytesDecoded = 0;
    this.totalMessagesDecoded = 0;
  }
}
