/**
 * Type definitions for msgpack-lite
 * Phase 1: Binary streaming support
 */

declare module 'msgpack-lite' {
  /**
   * Encode data to MessagePack format
   */
  export function encode(data: unknown, options?: { codec?: unknown }): Buffer;

  /**
   * Decode MessagePack data
   */
  export function decode(buffer: Buffer | Uint8Array): unknown;

  /**
   * Alias for encode (Python-style naming)
   */
  export function packb(data: unknown, options?: { use_bin_type?: boolean }): Buffer;

  /**
   * Alias for decode (Python-style naming)
   */
  export function unpackb(buffer: Buffer | Uint8Array): unknown;

  /**
   * Create a codec instance
   */
  export function createCodec(options?: unknown): unknown;
}
