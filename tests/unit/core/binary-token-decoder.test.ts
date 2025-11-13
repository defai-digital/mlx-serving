/**
 * Unit tests for BinaryTokenDecoder (Phase 1: Binary Streaming)
 *
 * Tests MessagePack binary message decoding with length-prefixed framing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BinaryTokenDecoder, BinaryMessageType } from '../../../src/core/binary-token-decoder.js';
import * as msgpack from 'msgpack-lite';
import { Readable } from 'stream';

describe('BinaryTokenDecoder', () => {
  let decoder: BinaryTokenDecoder;

  beforeEach(() => {
    decoder = new BinaryTokenDecoder();
  });

  describe('Basic Decoding', () => {
    it('should decode a single length-prefixed MessagePack message', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Hello', logprob: -0.5 } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      const messages: any[] = [];
      decoder.on('data', (msg) => messages.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(messages).toHaveLength(1);
            expect(messages[0].t).toBe(BinaryMessageType.TOKEN);
            expect(messages[0].p.token).toBe('Hello');
            expect(messages[0].p.logprob).toBe(-0.5);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(framed);
        decoder.end();
      });
    });

    it('should decode multiple message types correctly', async () => {
      const messages = [
        { t: BinaryMessageType.TOKEN, p: { token: 'Hello' } },
        { t: BinaryMessageType.STATS, p: { tokens_per_sec: 45.2 } },
        { t: BinaryMessageType.EVENT, p: { event: 'start' } },
        { t: BinaryMessageType.DONE, p: { finish_reason: 'stop' } },
      ];

      const frames: Buffer[] = [];
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      const allFrames = Buffer.concat(frames);
      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(4);
            expect(decoded[0].t).toBe(BinaryMessageType.TOKEN);
            expect(decoded[1].t).toBe(BinaryMessageType.STATS);
            expect(decoded[2].t).toBe(BinaryMessageType.EVENT);
            expect(decoded[3].t).toBe(BinaryMessageType.DONE);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });

    it('should decode multiple messages in a single chunk', async () => {
      const messages = [
        { t: BinaryMessageType.TOKEN, p: { token: 'Hello' } },
        { t: BinaryMessageType.TOKEN, p: { token: ' ' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'World' } },
      ];

      const frames: Buffer[] = [];
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      const allFrames = Buffer.concat(frames);
      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(3);
            expect(decoded[0].p.token).toBe('Hello');
            expect(decoded[1].p.token).toBe(' ');
            expect(decoded[2].p.token).toBe('World');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });
  });

  describe('Partial Message Handling', () => {
    it('should handle message split across multiple chunks', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Hello' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      // Split the message in the middle
      const chunk1 = framed.subarray(0, 3);
      const chunk2 = framed.subarray(3);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].t).toBe(BinaryMessageType.TOKEN);
            expect(decoded[0].p.token).toBe('Hello');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(chunk1);
        decoder.write(chunk2);
        decoder.end();
      });
    });

    it('should handle length prefix split across chunks', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Test' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      // Split in the length prefix (2 bytes + 2 bytes)
      const chunk1 = framed.subarray(0, 2);
      const chunk2 = framed.subarray(2);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].p.token).toBe('Test');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(chunk1);
        decoder.write(chunk2);
        decoder.end();
      });
    });

    it('should handle very small chunks (byte by byte)', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'A' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].p.token).toBe('A');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        // Write byte by byte
        for (let i = 0; i < framed.length; i++) {
          decoder.write(framed.subarray(i, i + 1));
        }
        decoder.end();
      });
    });

    it('should handle multiple messages with varied chunk boundaries', async () => {
      const messages = [
        { t: BinaryMessageType.TOKEN, p: { token: 'Hello' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'World' } },
      ];

      const frames: Buffer[] = [];
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      const allFrames = Buffer.concat(frames);

      // Split at arbitrary point between messages
      const splitPoint = frames[0].length + 2; // 2 bytes into second message
      const chunk1 = allFrames.subarray(0, splitPoint);
      const chunk2 = allFrames.subarray(splitPoint);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(2);
            expect(decoded[0].p.token).toBe('Hello');
            expect(decoded[1].p.token).toBe('World');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(chunk1);
        decoder.write(chunk2);
        decoder.end();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle truncated MessagePack data gracefully', async () => {
      // Create a valid message but truncate the MessagePack data
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Test', extra: 'data' } };
      const packed = msgpack.encode(message);

      // Say we have 10 bytes but only provide 5 (truncated)
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(10, 0);
      const truncatedData = packed.subarray(0, 5);
      const framed = Buffer.concat([lengthPrefix, truncatedData]);

      const decoded: any[] = [];
      let errorEmitted = false;
      decoder.on('data', (msg) => decoded.push(msg));
      decoder.on('error', () => { errorEmitted = true; });

      return new Promise<void>((resolve) => {
        decoder.on('end', () => {
          // Decoder should not decode truncated message
          expect(decoded).toHaveLength(0);
          resolve();
        });

        decoder.write(framed);
        decoder.end();
      });
    });

    it('should decode valid messages successfully', async () => {
      // Test that valid messages always decode correctly
      const message1 = { t: BinaryMessageType.TOKEN, p: { token: 'First' } };
      const packed1 = msgpack.encode(message1);
      const lengthPrefix1 = Buffer.alloc(4);
      lengthPrefix1.writeUInt32BE(packed1.length, 0);
      const frame1 = Buffer.concat([lengthPrefix1, packed1]);

      const message2 = { t: BinaryMessageType.TOKEN, p: { token: 'Second' } };
      const packed2 = msgpack.encode(message2);
      const lengthPrefix2 = Buffer.alloc(4);
      lengthPrefix2.writeUInt32BE(packed2.length, 0);
      const frame2 = Buffer.concat([lengthPrefix2, packed2]);

      const allFrames = Buffer.concat([frame1, frame2]);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(2);
            expect(decoded[0].p.token).toBe('First');
            expect(decoded[1].p.token).toBe('Second');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });

    it('should emit warning on incomplete data at stream end', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Incomplete' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      // Write only partial data (missing last 2 bytes)
      const partial = framed.subarray(0, framed.length - 2);

      let warningEmitted = false;
      decoder.on('warning', () => {
        warningEmitted = true;
      });

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Ensure we don't hang
          expect(decoded).toHaveLength(0); // Incomplete message shouldn't be decoded
          resolve();
        }, 5000);

        decoder.on('end', () => {
          clearTimeout(timeout);
          expect(warningEmitted).toBe(true);
          expect(decoded).toHaveLength(0);
          resolve();
        });

        decoder.write(partial);
        decoder.end();
      });
    }, 10000);
  });

  describe('Statistics', () => {
    it('should track bytes decoded', async () => {
      const messages = [
        { t: BinaryMessageType.TOKEN, p: { token: 'Hello' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'World' } },
      ];

      const frames: Buffer[] = [];
      let totalBytes = 0;
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        const frame = Buffer.concat([lengthPrefix, packed]);
        frames.push(frame);
        totalBytes += frame.length;
      }

      const allFrames = Buffer.concat(frames);
      decoder.on('data', () => {}); // Consume data

      return new Promise<void>((resolve, reject) => {
        decoder.on('end', () => {
          try {
            const stats = decoder.getStats();
            expect(stats.bytesDecoded).toBe(totalBytes);
            expect(stats.messagesDecoded).toBe(2);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });

    it('should track messages decoded', async () => {
      const messages = [
        { t: BinaryMessageType.TOKEN, p: { token: 'A' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'B' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'C' } },
        { t: BinaryMessageType.DONE, p: {} },
      ];

      const frames: Buffer[] = [];
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      const allFrames = Buffer.concat(frames);
      decoder.on('data', () => {}); // Consume data

      return new Promise<void>((resolve, reject) => {
        decoder.on('end', () => {
          try {
            const stats = decoder.getStats();
            expect(stats.messagesDecoded).toBe(4);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });

    it('should reset statistics', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Test' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      decoder.on('data', () => {}); // Consume data

      return new Promise<void>((resolve, reject) => {
        decoder.on('end', () => {
          try {
            let stats = decoder.getStats();
            expect(stats.messagesDecoded).toBe(1);
            expect(stats.bytesDecoded).toBeGreaterThan(0);

            decoder.resetStats();
            stats = decoder.getStats();
            expect(stats.messagesDecoded).toBe(0);
            expect(stats.bytesDecoded).toBe(0);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(framed);
        decoder.end();
      });
    });
  });

  describe('Stream Integration', () => {
    it('should work as a pipe target', async () => {
      const message = { t: BinaryMessageType.TOKEN, p: { token: 'Piped' } };
      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      const source = Readable.from([framed]);
      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].p.token).toBe('Piped');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        source.pipe(decoder);
      });
    });

    it('should handle empty stream', async () => {
      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(0);
            const stats = decoder.getStats();
            expect(stats.messagesDecoded).toBe(0);
            expect(stats.bytesDecoded).toBe(0);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.end();
      });
    });

    it('should handle large payloads', async () => {
      const largePayload = {
        t: BinaryMessageType.STATS,
        p: {
          model: 'test-model',
          tokens: new Array(1000).fill('token'),
          metadata: {
            complex: new Array(100).fill({ nested: 'data' }),
          },
        },
      };

      const packed = msgpack.encode(largePayload);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].t).toBe(BinaryMessageType.STATS);
            expect(decoded[0].p.tokens).toHaveLength(1000);
            expect(decoded[0].p.metadata.complex).toHaveLength(100);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(framed);
        decoder.end();
      });
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle typical token streaming sequence', async () => {
      const sequence = [
        { t: BinaryMessageType.EVENT, p: { event: 'start', request_id: '123' } },
        { t: BinaryMessageType.TOKEN, p: { token: 'The', logprob: -0.1 } },
        { t: BinaryMessageType.TOKEN, p: { token: ' quick', logprob: -0.2 } },
        { t: BinaryMessageType.TOKEN, p: { token: ' brown', logprob: -0.3 } },
        { t: BinaryMessageType.STATS, p: { tokens_per_sec: 42.5, model_load_time: 123 } },
        { t: BinaryMessageType.TOKEN, p: { token: ' fox', logprob: -0.4 } },
        { t: BinaryMessageType.DONE, p: { finish_reason: 'stop', total_tokens: 4 } },
      ];

      const frames: Buffer[] = [];
      for (const msg of sequence) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      // Simulate realistic chunking (not aligned with message boundaries)
      const allData = Buffer.concat(frames);
      const chunks = [
        allData.subarray(0, 20),
        allData.subarray(20, 45),
        allData.subarray(45, 80),
        allData.subarray(80),
      ];

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(7);
            expect(decoded[0].t).toBe(BinaryMessageType.EVENT);
            expect(decoded[1].t).toBe(BinaryMessageType.TOKEN);
            expect(decoded[4].t).toBe(BinaryMessageType.STATS);
            expect(decoded[6].t).toBe(BinaryMessageType.DONE);
            expect(decoded[6].p.finish_reason).toBe('stop');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        for (const chunk of chunks) {
          decoder.write(chunk);
        }
        decoder.end();
      });
    });

    it('should infer batch_size for batched token payloads', async () => {
      const message = {
        t: BinaryMessageType.TOKEN,
        p: {
          stream_id: 'stream-1',
          tokens: [
            { token: 'Hello', token_id: 10 },
            { token: ' world', token_id: 11 },
          ],
        },
      };

      const packed = msgpack.encode(message);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(packed.length, 0);
      const framed = Buffer.concat([lengthPrefix, packed]);

      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      await new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            expect(decoded).toHaveLength(1);
            expect(decoded[0].p.batch_size).toBe(2);
            expect(decoded[0].p.tokens).toHaveLength(2);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(framed);
        decoder.end();
      });
    });

    it('should maintain performance with high message throughput', async () => {
      const messageCount = 1000;
      const messages: any[] = [];

      for (let i = 0; i < messageCount; i++) {
        messages.push({
          t: BinaryMessageType.TOKEN,
          p: { token: `token${i}`, logprob: -0.1 * i },
        });
      }

      const frames: Buffer[] = [];
      for (const msg of messages) {
        const packed = msgpack.encode(msg);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(packed.length, 0);
        frames.push(Buffer.concat([lengthPrefix, packed]));
      }

      const allFrames = Buffer.concat(frames);
      const decoded: any[] = [];
      decoder.on('data', (msg) => decoded.push(msg));

      const startTime = Date.now();

      return new Promise<void>((resolve, reject) => {
        decoder.on('error', reject);
        decoder.on('end', () => {
          try {
            const duration = Date.now() - startTime;
            expect(decoded).toHaveLength(messageCount);
            expect(duration).toBeLessThan(1000); // Should decode 1000 messages in < 1s
            const stats = decoder.getStats();
            expect(stats.messagesDecoded).toBe(messageCount);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        decoder.write(allFrames);
        decoder.end();
      });
    });
  });
});
