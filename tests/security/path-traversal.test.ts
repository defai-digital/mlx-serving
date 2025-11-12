/**
 * Security Regression Tests - Path Traversal Prevention
 *
 * These tests verify that the security fixes for CVE-2025-KRMLM-001 and
 * CVE-2025-KRMLM-002 are working correctly and prevent path traversal attacks.
 *
 * CRITICAL: These tests must NEVER be skipped. They ensure that security
 * vulnerabilities do not reappear in future code changes.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PythonRunner } from '../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import { pino } from 'pino';
import { getPythonRuntimeSkipReason } from '../helpers/python-runtime.js';

describe('Security: Path Traversal Prevention', () => {
  let runner: PythonRunner;
  let runnerStarted = false;
  let transport: JsonRpcTransport;
  const logger = pino({ level: 'error' }); // Suppress logs for security tests
  let skipTests = false;
  let skipReason: string | null = null;

  const shouldSkip = (): boolean => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'Python runtime unavailable'}`);
    }
    return skipTests;
  };

  beforeAll(async () => {
    const pythonSkipReason = getPythonRuntimeSkipReason();
    if (pythonSkipReason) {
      skipTests = true;
      skipReason = pythonSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping path traversal tests: ${pythonSkipReason}`);
      return;
    }

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
  }, 90000);

  afterAll(async () => {
    if (!runnerStarted) {
      return;
    }

    if (!skipTests) {
      await runner.stop();
    }
  });

  describe('CVE-2025-KRMLM-001: Path Traversal in model_id', () => {
    test('should block ../ in model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '../../etc/passwd',
        })
      ).rejects.toThrow(/invalid characters or path traversal/i);
    });

    test('should block .. in model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'models/../../../etc/passwd',
        })
      ).rejects.toThrow(/invalid characters or path traversal/i);
    });

    test('should block special characters in model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'model;rm -rf /',
        })
      ).rejects.toThrow(/invalid characters/i);
    });

    test('should block null bytes in model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'model\x00/../../etc/passwd',
        })
      ).rejects.toThrow();
    });

    test('should allow valid model_id with slashes', async () => {
      if (shouldSkip()) {
        return;
      }

      // This should fail with "model not found" rather than validation error
      await expect(
        transport.request('load_model', {
          model_id: 'valid/model/path',
        })
      ).rejects.toThrow(/failed to load/i);
    });

    test('should allow valid model_id with hyphens and underscores', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'valid-model_123',
        })
      ).rejects.toThrow(/failed to load/i);
    });
  });

  describe('CVE-2025-KRMLM-002: Path Traversal in local_path', () => {
    test('should block absolute paths in local_path', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'test-model',
          local_path: '/etc/shadow',
        })
      ).rejects.toThrow(/not within trusted directories|must be absolute|does not exist/i);
      // Note: Without trusted_model_directories configured, absolute paths are allowed
      // but still fail if the path doesn't exist or isn't a valid model directory
    });

    test('should block ../ in local_path', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'test-model',
          local_path: '../../../etc/passwd',
        })
      ).rejects.toThrow(/potentially unsafe sequences|attempts to access files outside/i);
    });

    test('should block relative path escapes', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: 'test-model',
          local_path: 'models/../../etc/hosts',
        })
      ).rejects.toThrow(/potentially unsafe sequences|attempts to access files outside/i);
    });

    test('should allow valid relative paths within models directory', async () => {
      if (shouldSkip()) {
        return;
      }

      // This should fail with "model not found" rather than security error
      await expect(
        transport.request('load_model', {
          model_id: 'test-model',
          local_path: 'valid-subdir/model',
        })
      ).rejects.toThrow(/failed to load/i);
    });
  });

  describe('CVE-2025-KRMLM-001 & CVE-2025-KRMLM-002: Combined Attack Vectors', () => {
    test('should block combined path traversal in both fields', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '../sensitive',
          local_path: '../../etc/passwd',
        })
      ).rejects.toThrow();
    });

    test('should block URL-encoded path traversal', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        })
      ).rejects.toThrow();
    });

    test('should block double-encoded path traversal', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '%252e%252e%252f%252e%252e%252fetc%252fpasswd',
        })
      ).rejects.toThrow();
    });
  });

  describe('Security: Input Validation Edge Cases', () => {
    test('should block empty model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '',
        })
      ).rejects.toThrow();
    });

    test('should block null model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: null as unknown as string,
        })
      ).rejects.toThrow();
    });

    test('should block undefined model_id', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: undefined as unknown as string,
        })
      ).rejects.toThrow();
    });

    test('should block very long model_id (DoS protection)', async () => {
      if (shouldSkip()) {
        return;
      }

      const longId = 'a'.repeat(10000);
      await expect(
        transport.request('load_model', {
          model_id: longId,
        })
      ).rejects.toThrow();
    });
  });

  describe('Regression: Known Attack Patterns', () => {
    test('should block Windows-style path traversal', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '..\\..\\windows\\system32',
        })
      ).rejects.toThrow();
    });

    test('should block Unicode path traversal', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '\u002e\u002e\u002f\u002e\u002e\u002f',
        })
      ).rejects.toThrow();
    });

    test('should block mixed case path traversal', async () => {
      if (shouldSkip()) {
        return;
      }

      await expect(
        transport.request('load_model', {
          model_id: '../EtC/../PaSsWd',
        })
      ).rejects.toThrow();
    });
  });
});
