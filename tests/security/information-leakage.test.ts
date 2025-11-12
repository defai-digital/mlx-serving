/**
 * Security Regression Tests - Information Leakage Prevention
 *
 * These tests verify that error messages do not leak sensitive internal
 * information (file paths, stack traces, internal state) to clients.
 *
 * CRITICAL: These tests must NEVER be skipped. They ensure that error
 * handling does not expose sensitive system information to potential attackers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PythonRunner } from '../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import { pino } from 'pino';
import { getPythonRuntimeSkipReason } from '../helpers/python-runtime.js';

describe('Security: Information Leakage Prevention', () => {
  let runner: PythonRunner;
  let runnerStarted = false;
  let transport: JsonRpcTransport;
  const logger = pino({ level: 'error' });
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
      console.warn(`\n⚠️  Skipping information leakage tests: ${pythonSkipReason}`);
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

  describe('Generic Error Messages for Unexpected Exceptions', () => {
    test('should return generic error on unknown method', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('non_existent_method_xyz', {});
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message.toLowerCase();

        // Should mention method not found, but not leak internal details
        expect(message).toMatch(/method not found|unknown method/i);

        // Should NOT contain file paths
        expect(message).not.toContain('.py');
        expect(message).not.toContain('.ts');
        expect(message).not.toContain('/python/');
        expect(message).not.toContain('/src/');
        expect(message).not.toContain('runtime.py');
        expect(message).not.toContain('File');

        // Should NOT contain Python stack traces
        expect(message).not.toContain('Traceback');
        expect(message).not.toContain('line ');
        expect(message).not.toContain('in <module>');
      }
    });

    test('should not leak file paths on validation errors', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('load_model', {
          model_id: '../../../etc/passwd',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message.toLowerCase();

        // Should mention validation error
        expect(message).toMatch(/invalid|path traversal/i);

        // Should NOT leak absolute file paths
        expect(message).not.toMatch(/\/users\//i);
        expect(message).not.toMatch(/\/home\//i);
        expect(message).not.toMatch(/\/etc\//i);
        expect(message).not.toMatch(/c:\\/i);

        // Should NOT leak Python internals
        expect(message).not.toContain('validators.py');
        expect(message).not.toContain('__file__');
      }
    });

    test('should not leak internal state on invalid params', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('load_model', {
          // Missing required model_id
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message.toLowerCase();

        // Should mention parameter error
        expect(message).toMatch(/param|required|invalid/i);

        // Should NOT leak variable names or internal structure
        expect(message).not.toContain('locals()');
        expect(message).not.toContain('globals()');
        expect(message).not.toContain('__dict__');

        // Should NOT leak module paths
        expect(message).not.toContain('python/models');
        expect(message).not.toContain('python/runtime');
      }
    });
  });

  describe('Error Message Sanitization', () => {
    test('should sanitize error messages from model loading failures', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('load_model', {
          model_id: 'non-existent-model-xyz123',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message;

        // Should mention model not found
        expect(message).toMatch(/failed to load|not found/i);

        // Should NOT leak full filesystem paths
        expect(message).not.toMatch(/\/Users\/[^/]+\/Desktop/i);
        expect(message).not.toMatch(/\/home\/[^/]+\//i);

        // Should NOT leak project structure (local paths, not API URLs)
        expect(message).not.toContain('kr-mlx-lm/');
        expect(message).not.toContain('.kr-mlx-venv');

        // Should NOT leak local model directory paths
        // Allow API URLs (e.g. "https://huggingface.co/api/models/") but block local paths
        if (message.includes('models/') || message.includes('/models/')) {
          // If it contains "models/", verify it's only in an API URL context
          expect(message).toMatch(/https?:\/\/.*\/models\//);
        }

        // Should NOT leak Python exception details
        expect(message).not.toContain('Exception:');
        expect(message).not.toContain('Error:');
        expect(message).not.toContain('Traceback');
      }
    });

    test('should not expose internal configuration in errors', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        // Try to trigger an error that might expose config
        await transport.request('generate', {
          model_id: 'non-loaded-model',
          prompt: 'test',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message.toLowerCase();

        // Should mention model not loaded
        expect(message).toMatch(/not loaded|not found/i);

        // Should NOT leak configuration values
        expect(message).not.toContain('python_path');
        expect(message).not.toContain('runtime_path');
        expect(message).not.toContain('.kr-mlx-venv');
        expect(message).not.toContain('config.yaml');

        // Should NOT leak environment variables
        expect(message).not.toContain('PYTHONPATH');
        expect(message).not.toContain('HOME');
        expect(message).not.toContain('USER');
      }
    });
  });

  describe('Stack Trace Sanitization', () => {
    test('should not leak Python stack traces to client', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        // Trigger an error that would generate a Python stack trace
        await transport.request('load_model', {
          model_id: { invalid: 'object' } as unknown as string,
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const fullError = JSON.stringify(err);

        // Should NOT contain Python stack trace keywords
        expect(fullError).not.toContain('Traceback');
        expect(fullError).not.toContain('File "');
        expect(fullError).not.toContain(', line ');
        expect(fullError).not.toContain('in <module>');
        expect(fullError).not.toContain('raise ');
      }
    });

    test('should not leak function names or code structure', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('unknown_internal_method', {});
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message;

        // Should NOT leak internal function names
        expect(message).not.toContain('handle_request');
        expect(message).not.toContain('_serialize_error');
        expect(message).not.toContain('validate_');
        expect(message).not.toContain('__init__');
        expect(message).not.toContain('self.');
      }
    });
  });

  describe('System Information Protection', () => {
    test('should not leak system paths in any error', async () => {
      if (shouldSkip()) {
        return;
      }

      const testCases = [
        { model_id: '../system' },
        { model_id: 'test', local_path: '/etc/passwd' },
        { model_id: '\x00' },
      ];

      for (const testCase of testCases) {
        try {
          await transport.request('load_model', testCase);
          expect.fail('Should have thrown an error');
        } catch (err: unknown) {
          const error = err as Error;
          const message = error.message;

          // Should NOT leak system directories
          expect(message).not.toMatch(/\/(etc|usr|var|tmp|home|Users)\//);
          expect(message).not.toMatch(/C:\\(Windows|Program Files)/i);

          // Should NOT leak current working directory
          expect(message).not.toContain(process.cwd());
        }
      }
    });

    test('should not leak Python version or system info', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('invalid_method', {});
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const fullError = JSON.stringify(err);

        // Should NOT leak Python version
        expect(fullError).not.toMatch(/Python \d\.\d/i);
        expect(fullError).not.toContain('sys.version');

        // Should NOT leak OS information
        expect(fullError).not.toContain('darwin');
        expect(fullError).not.toContain('linux');
        expect(fullError).not.toContain('win32');
        expect(fullError).not.toContain('platform');
      }
    });

    test('should not leak username or home directory', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('load_model', {
          model_id: 'trigger/../error',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message;

        // Should NOT leak username (common in paths)
        const username = process.env.USER || process.env.USERNAME;
        if (username) {
          expect(message).not.toContain(username);
        }

        // Should NOT leak home directory
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home) {
          expect(message).not.toContain(home);
        }
      }
    });
  });

  describe('Regression: Known Information Leakage Patterns', () => {
    test('should use generic error codes, not internal codes', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        await transport.request('load_model', {
          model_id: 'test/../invalid',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        // Error should use JSON-RPC error codes, not Python exception names
        const errorObj = err as { code?: number };

        if (errorObj.code !== undefined) {
          // Should be standard JSON-RPC error code range
          expect(errorObj.code).toBeGreaterThanOrEqual(-32768);
          expect(errorObj.code).toBeLessThanOrEqual(-32000);
        }
      }
    });

    test('should not leak database or file structure', async () => {
      if (shouldSkip()) {
        return;
      }

      try {
        // Try various paths that might reveal structure
        await transport.request('load_model', {
          model_id: '../python/models',
        });
        expect.fail('Should have thrown an error');
      } catch (err: unknown) {
        const error = err as Error;
        const message = error.message;

        // Should NOT leak project structure
        expect(message).not.toContain('python/');
        expect(message).not.toContain('src/');
        expect(message).not.toContain('models/');
        expect(message).not.toContain('tests/');
        expect(message).not.toContain('.git/');
      }
    });

    test('should provide same error type for different invalid inputs', async () => {
      if (shouldSkip()) {
        return;
      }

      const invalidInputs = [
        '../etc/passwd',
        '../../var/log',
        '/absolute/path',
        'model;rm -rf /',
      ];

      const errorTypes = new Set<string>();

      for (const input of invalidInputs) {
        try {
          await transport.request('load_model', {
            model_id: input,
          });
        } catch (err: unknown) {
          const error = err as Error;
          // Extract error type (first word or general pattern)
          const errorType = error.message.split(':')[0]?.toLowerCase() || '';
          errorTypes.add(errorType);
        }
      }

      // All invalid inputs should produce same type of error
      // This prevents attackers from distinguishing between different issues
      expect(errorTypes.size).toBeLessThanOrEqual(2);
    });
  });
});
