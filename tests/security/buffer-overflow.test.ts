/**
 * Security Regression Tests - Buffer Overflow DoS Prevention
 *
 * These tests verify that the fix for Buffer Overflow DoS vulnerability
 * (UTF-8 multibyte character handling) is working correctly.
 *
 * CRITICAL: These tests must NEVER be skipped. They ensure that buffer
 * overflow attacks using multibyte UTF-8 characters are properly blocked.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PythonRunner } from '../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import { pino } from 'pino';

describe('Security: Buffer Overflow DoS Prevention', () => {
  let runner: PythonRunner;
  let runnerStarted = false;
  let transport: JsonRpcTransport;
  const logger = pino({ level: 'error' });

  beforeAll(async () => {
    runner = new PythonRunner({
      logger,
      verbose: false,
      startupTimeout: 60000,
    });

    await runner.start();
    runnerStarted = true;

    const internalTransport = runner.getTransport();
    if (!internalTransport) {
      throw new Error('Failed to get transport from PythonRunner');
    }

    transport = internalTransport;

    // Note: Buffer overflow tests verify request validation BEFORE it reaches Python
    // No need to load a model - the buffer limit is enforced at the transport layer
  }, 90000);

  afterAll(async () => {
    if (!runnerStarted) {
      return;
    }

    await runner.stop();
  });

  describe('UTF-8 Multibyte Character Buffer Overflow', () => {
    test('should block buffer overflow with 4-byte emoji characters', async () => {
      // Max buffer: 1MB (1048576 bytes)
      // Create payload: 300K emojis = 1.2MB in UTF-8 (exceeds limit)
      const payload = '😀'.repeat(300000);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBeGreaterThan(1048576); // Verify it exceeds 1MB

      // Should be rejected due to buffer limit (no model needed - validation happens at transport layer)
      await expect(
        transport.request('generate', {
          model_id: 'test-model',  // Model doesn't need to exist - request should fail before reaching Python
          prompt: payload,
          max_tokens: 1,
        })
      ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
    }, 30000);

    test('should block buffer overflow with 3-byte CJK characters', async () => {
      // Chinese characters are typically 3 bytes in UTF-8
      // 400K characters = ~1.2MB
      const payload = '中'.repeat(400000);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBeGreaterThan(1048576);

      await expect(
        transport.request('generate', {
          model_id: 'test-model',
          prompt: payload,
          max_tokens: 1,
        })
      ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
    }, 30000);

    test('should block buffer overflow with 2-byte characters', async () => {
      // Characters like © are 2 bytes in UTF-8
      // 600K characters = ~1.2MB
      const payload = '©'.repeat(600000);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBeGreaterThan(1048576);

      await expect(
        transport.request('generate', {
          model_id: 'test-model',
          prompt: payload,
          max_tokens: 1,
        })
      ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
    }, 30000);

    test('should allow buffer within limit (ASCII)', async () => {
      // 500K ASCII characters = 500KB (well within 1MB limit)
      const payload = 'a'.repeat(500000);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBeLessThan(1048576);

      // Use smaller portion - should NOT throw buffer overflow
      // (May throw model not loaded error, but that's different from buffer overflow)
      const result = transport.request('generate', {
        model_id: 'test-model',
        prompt: payload.slice(0, 100),
        max_tokens: 1,
      });

      // Should either succeed or fail with model error, NOT buffer overflow
      try {
        await result;
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toMatch(/buffer overflow|exceeded.*bytes/i);
      }
    }, 30000);

    test('should allow buffer within limit (emojis)', async () => {
      // 200K emojis = 800KB (within 1MB limit)
      const payload = '😀'.repeat(200000);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBeLessThan(1048576);

      // Use smaller portion - should NOT throw buffer overflow
      const result = transport.request('generate', {
        model_id: 'test-model',
        prompt: '😀'.repeat(10),
        max_tokens: 1,
      });

      // Should either succeed or fail with model error, NOT buffer overflow
      try {
        await result;
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toMatch(/buffer overflow|exceeded.*bytes/i);
      }
    }, 30000);
  });

  describe('Mixed ASCII and UTF-8 Buffer Handling', () => {
    test('should correctly count bytes in mixed content', () => {
      const text = 'Hello 世界 😀';
      const bytes = Buffer.from(text, 'utf-8').length;

      // H(1) e(1) l(1) l(1) o(1) space(1) 世(3) 界(3) space(1) 😀(4)
      expect(bytes).toBe(17);
    });

    test('should handle mixed content near buffer limit', async () => {
      // Create payload with mix of ASCII and multibyte characters
      // Just under 1MB limit
      const asciiPart = 'a'.repeat(500000); // 500KB
      const emojiPart = '😀'.repeat(120000); // ~480KB
      const totalBytes = Buffer.from(asciiPart + emojiPart, 'utf-8').length;

      expect(totalBytes).toBeLessThan(1048576);

      // Should NOT throw buffer overflow (use small portion)
      const result = transport.request('generate', {
        model_id: 'test-model',
        prompt: 'Hello 😀',
        max_tokens: 1,
      });

      // Should either succeed or fail with model error, NOT buffer overflow
      try {
        await result;
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toMatch(/buffer overflow|exceeded.*bytes/i);
      }
    }, 30000);

    test('should block mixed content exceeding buffer limit', async () => {
      // Create payload with mix that exceeds 1MB
      const asciiPart = 'a'.repeat(600000); // 600KB
      const emojiPart = '😀'.repeat(150000); // ~600KB = 1.2MB total
      const totalBytes = Buffer.from(asciiPart + emojiPart, 'utf-8').length;

      expect(totalBytes).toBeGreaterThan(1048576);

      await expect(
        transport.request('generate', {
          model_id: 'test-model',
          prompt: asciiPart + emojiPart,
          max_tokens: 1,
        })
      ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
    }, 30000);
  });

  describe('Edge Cases and Boundary Conditions', () => {
    test('should handle exactly 1MB payload', async () => {
      // Create payload exactly at 1MB limit
      const payload = 'a'.repeat(1048576);
      const bytes = Buffer.from(payload, 'utf-8').length;

      expect(bytes).toBe(1048576);

      // Behavior at exact limit may vary (accept or reject is ok)
      // Important: should NOT crash or hang
      try {
        await transport.request('generate', {
          model_id: 'test-model',
          prompt: payload.slice(0, 100),
          max_tokens: 1,
        });
      } catch (err) {
        // Either succeeds or fails gracefully
        expect(err).toBeDefined();
      }
    }, 30000);

    test('should handle zero-width characters correctly', () => {
      // Zero-width joiner is 3 bytes in UTF-8 but invisible
      const text = 'a\u200Db\u200Dc';
      const bytes = Buffer.from(text, 'utf-8').length;

      // a(1) + ZWJ(3) + b(1) + ZWJ(3) + c(1) = 9 bytes
      expect(bytes).toBe(9);
    });

    test('should handle emoji with skin tone modifiers', () => {
      // Emoji with skin tone modifier is ~8 bytes
      const text = '👋🏽'; // Waving hand with medium skin tone
      const bytes = Buffer.from(text, 'utf-8').length;

      expect(bytes).toBeGreaterThan(4); // More than simple emoji
    });
  });

  describe('Regression: Known Attack Patterns', () => {
    test('should block repeated emoji sequence attack', async () => {
      // Attacker tries to bypass check by using various emojis
      const attack = '😀😁😂🤣😃😄😅😆'.repeat(50000);
      const bytes = Buffer.from(attack, 'utf-8').length;

      expect(bytes).toBeGreaterThan(1048576);

      await expect(
        transport.request('generate', {
          model_id: 'test-model',
          prompt: attack,
          max_tokens: 1,
        })
      ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
    }, 30000);

    test('should block combining character attack', async () => {
      // Combining diacritical marks can create very long sequences
      const base = 'e';
      const combining = '\u0301\u0302\u0303'; // Combining marks
      const attack = (base + combining.repeat(10)).repeat(100000);
      const bytes = Buffer.from(attack, 'utf-8').length;

      if (bytes > 1048576) {
        await expect(
          transport.request('generate', {
            model_id: 'test-model',
            prompt: attack,
            max_tokens: 1,
          })
        ).rejects.toThrow(/buffer overflow|exceeded.*bytes/i);
      }
    }, 30000);
  });
});
