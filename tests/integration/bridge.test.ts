/**
 * Integration Tests for Python Bridge
 *
 * Tests the full TypeScript-Python IPC layer including:
 * - PythonRunner process lifecycle
 * - JsonRpcTransport communication
 * - StreamRegistry coordination
 * - End-to-end JSON-RPC request/response flow
 *
 * NOTE: These tests require a working Python environment with mlx-lm installed.
 * They are marked as integration tests and may be skipped in CI environments
 * without Apple Silicon.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { PythonRunner } from '../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import { pino } from 'pino';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';

describe('Python Bridge Integration', () => {
  let runner: PythonRunner;
  let runnerStarted = false;
  let transport: JsonRpcTransport;
  const logger = pino({ level: 'debug' });
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping bridge integration tests: ${mlxSkipReason}`);
      return;
    }

    // Check if test model is available first
    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping bridge integration tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3.2-3b-instruct\n');
      return; // Skip test setup entirely
    }

    // Initialize Python runtime
    runner = new PythonRunner({
      logger,
      verbose: true,
      startupTimeout: 60000, // 60 seconds for first-time startup
    });

    await runner.start();
    runnerStarted = true;

    // Get the transport that PythonRunner created internally
    const internalTransport = runner.getTransport();

    if (!internalTransport) {
      throw new Error('Failed to get transport from PythonRunner');
    }

    transport = internalTransport;
  }, 90000); // 90 second timeout for suite setup

  afterAll(async () => {
    if (!runnerStarted) {
      return;
    }

    // Transport will be closed by runner.stop()
    await runner.stop();
  });

  describe('Runtime Info', () => {
    test('should retrieve runtime information', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const result = await transport.request<{
        version: string;
        mlx_version: string;
        protocol: string;
        capabilities: string[];
      }>('runtime/info');

      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('mlx_version');
      expect(result).toHaveProperty('protocol', 'json-rpc-2.0');
      expect(result).toHaveProperty('capabilities');
      expect(Array.isArray(result.capabilities)).toBe(true);
    });
  });

  describe('Model Loading', () => {
    test('should load a model', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Use llama-3.2-3b-instruct model (has complete tokenizer files)
      const result = await transport.request('load_model', {
        model_id: 'llama-3.2-3b-instruct',
        local_path: 'models/llama-3.2-3b-instruct',
      });

      expect(result).toHaveProperty('model_id', 'llama-3.2-3b-instruct');
      expect(result).toHaveProperty('state', 'ready');
      expect(result).toHaveProperty('context_length');
    }, 60000); // 60 second timeout for model loading (larger model)

    test('should handle model loading errors', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Test error handling for non-existent models
      await expect(
        transport.request('load_model', {
          model_id: 'non-existent-model-12345',
        })
      ).rejects.toThrow();
    });
  });

  describe('Streaming (StreamRegistry)', () => {
    test('should handle streaming generation', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Ensure model is loaded first
      await transport.request('load_model', {
        model_id: 'llama-3.2-3b-instruct',
        local_path: 'models/llama-3.2-3b-instruct',
      });

      const streamId = `test-stream-${Date.now()}`;

      // Collect chunks
      const chunks: Array<{
        streamId: string;
        token: string;
        tokenId: number;
        isFinal: boolean;
      }> = [];

      const chunkHandler = (chunk: unknown): void => {
        chunks.push(chunk as never);
      };

      runner.streamRegistry.on('chunk', chunkHandler);

      // Register stream
      const statsPromise = runner.streamRegistry.register(streamId);

      // Request generation
      const result = await transport.request('generate', {
        model_id: 'llama-3.2-3b-instruct',
        prompt: 'Hello',
        stream_id: streamId,
        max_tokens: 5,
      });

      expect(result).toHaveProperty('stream_id', streamId);

      // Wait for completion
      const stats = await statsPromise;

      expect(stats).toHaveProperty('tokensGenerated');
      expect(stats).toHaveProperty('tokensPerSecond');
      expect(stats).toHaveProperty('timeToFirstToken');
      expect(chunks.length).toBeGreaterThan(0);

      // Cleanup listener
      runner.streamRegistry.off('chunk', chunkHandler);
    }, 60000); // 60 second timeout for generation

    test('should handle stream cancellation', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const streamId = `cancel-stream-${Date.now()}`;
      const abortController = new AbortController();

      const statsPromise = runner.streamRegistry.register(
        streamId,
        abortController.signal
      );

      // Cancel after brief delay
      setTimeout(() => abortController.abort(), 100);

      await expect(statsPromise).rejects.toThrow('aborted');
    });

    test('should handle stream timeout', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const streamId = `timeout-stream-${Date.now()}`;

      // Register with very short timeout
      const statsPromise = runner.streamRegistry.register(streamId, undefined, 100);

      await expect(statsPromise).rejects.toThrow('timed out');
    }, 10000);
  });

  describe('Tokenization', () => {
    test('should tokenize text', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Ensure model is loaded first
      await transport.request('load_model', {
        model_id: 'llama-3.2-3b-instruct',
        local_path: 'models/llama-3.2-3b-instruct',
      });

      const result = await transport.request<{
        tokens: number[];
        token_strings?: string[];
      }>('tokenize', {
        model_id: 'llama-3.2-3b-instruct',
        text: 'Hello, world!',
        add_bos: true,
      });

      expect(result).toHaveProperty('tokens');
      expect(Array.isArray(result.tokens)).toBe(true);
      expect(result.tokens.length).toBeGreaterThan(0);
    }, 30000); // 30 second timeout
  });

  describe('Error Handling', () => {
    test('should handle unknown method', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await expect(
        transport.request('unknown_method', {})
      ).rejects.toThrow();
    });

    test('should handle invalid params', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await expect(
        transport.request('load_model', {
          // Missing required model_id
        })
      ).rejects.toThrow();
    });

    test('should handle request timeout', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Use a slow operation (load_model) with a very short timeout
      // Model loading takes several seconds, so 100ms timeout will definitely trigger
      await expect(
        transport.request('load_model', {
          model_id: 'llama-3.2-3b-instruct',
          local_path: 'models/llama-3.2-3b-instruct',
        }, { timeout: 100 })
      ).rejects.toThrow(/timeout|timed out/i);
    }, 10000);
  });

  describe('Shutdown', () => {
    test('should shutdown gracefully', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const result = await transport.request('shutdown');
      expect(result).toHaveProperty('success', true);
    });
  });
});
