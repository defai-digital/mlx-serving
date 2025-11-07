/**
 * Integration Tests: Request Batching (Week 1)
 *
 * Tests BatchQueue integration with Python runtime
 * Verifies batch_tokenize and batch_check_draft methods
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PythonRunner } from '../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';
import { BatchQueue } from '../../src/core/batch-queue.js';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';
import { tagEngineTop20 } from '../helpers/tags.js';

describe('BatchQueue Integration Tests', () => {
  let runner: PythonRunner;
  let transport: JsonRpcTransport;
  let batchQueue: BatchQueue;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping batch queue tests: ${mlxSkipReason}`);
      return;
    }

    // Check if test model is available first
    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping batch queue tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3.2-3b-instruct\n');
      return; // Skip test setup entirely
    }

    // Start Python runtime
    runner = new PythonRunner({
      pythonPath: '.kr-mlx-venv/bin/python',
      runtimePath: 'python/runtime.py',
    });

    await runner.start();

    // Create transport and batch queue
    const maybeTransport = runner.getTransport();
    if (!maybeTransport) {
      throw new Error('Failed to get transport from runner');
    }
    transport = maybeTransport;
    batchQueue = new BatchQueue(transport, {
      maxBatchSize: 3,
      flushIntervalMs: 10,
      enabled: true,
    });
  }, 30000); // 30s timeout for Python startup

  afterAll(async () => {
    if (batchQueue) {
      batchQueue.cleanup();
    }
    if (runner) {
      await runner.stop();
    }
  });

  describe('batch_tokenize', () => {
    it('should verify Python runtime supports batch_tokenize', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const info = await transport.request<{ capabilities: string[] }>('runtime/info');

      expect(info.capabilities).toContain('batch_tokenize');
    });

    it(tagEngineTop20('should batch multiple tokenize requests through Python'), async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Load a test model first
      await transport.request('load_model', {
        model_id: 'test-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      // Manually call batch_tokenize on Python runtime
      const response = await transport.request<{
        results: Array<{
          success: boolean;
          result?: { tokens: number[]; token_strings?: string[] };
          error?: string;
        }>;
      }>('batch_tokenize', {
        requests: [
          { model_id: 'test-model', text: 'Hello', add_special_tokens: true },
          { model_id: 'test-model', text: 'World', add_special_tokens: true },
        ],
      });

      // Verify response structure
      expect(response.results).toHaveLength(2);

      // Both should succeed
      expect(response.results[0].success).toBe(true);
      expect(response.results[1].success).toBe(true);

      // Both should have tokens
      expect(response.results[0].result?.tokens).toBeDefined();
      expect(response.results[1].result?.tokens).toBeDefined();

      // Cleanup
      await transport.request('unload_model', { model_id: 'test-model' });
    }, 15000);

    it(tagEngineTop20('should isolate errors in batch_tokenize'), async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await transport.request('load_model', {
        model_id: 'test-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      const response = await transport.request<{
        results: Array<{
          success: boolean;
          result?: { tokens: number[] };
          error?: string;
        }>;
      }>('batch_tokenize', {
        requests: [
          { model_id: 'test-model', text: 'Valid request' },
          { model_id: 'nonexistent-model', text: 'Invalid model' }, // Should fail
          { model_id: 'test-model', text: 'Another valid request' },
        ],
      });

      expect(response.results).toHaveLength(3);

      // First request should succeed
      expect(response.results[0].success).toBe(true);
      expect(response.results[0].result?.tokens).toBeDefined();

      // Second request should fail (model not loaded)
      expect(response.results[1].success).toBe(false);
      expect(response.results[1].error).toBeDefined();

      // Third request should still succeed (error isolation)
      expect(response.results[2].success).toBe(true);
      expect(response.results[2].result?.tokens).toBeDefined();

      await transport.request('unload_model', { model_id: 'test-model' });
    }, 15000);
  });

  describe('batch_check_draft', () => {
    it('should verify Python runtime supports batch_check_draft', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const info = await transport.request<{ capabilities: string[] }>('runtime/info');

      expect(info.capabilities).toContain('batch_check_draft');
    });

    it(tagEngineTop20('should batch multiple check_draft requests through Python'), async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Load primary and draft models
      await transport.request('load_model', {
        model_id: 'primary-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      await transport.request('load_model', {
        model_id: 'draft-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      const response = await transport.request<{
        results: Array<{
          success: boolean;
          result?: { compatible: boolean; warnings?: string[] };
          error?: string;
        }>;
      }>('batch_check_draft', {
        requests: [
          { primary_id: 'primary-model', draft_id: 'draft-model' },
          { primary_id: 'primary-model', draft_id: 'draft-model' },
        ],
      });

      expect(response.results).toHaveLength(2);

      // Both should succeed
      expect(response.results[0].success).toBe(true);
      expect(response.results[1].success).toBe(true);

      // Both should have compatibility info
      expect(response.results[0].result?.compatible).toBeDefined();
      expect(response.results[1].result?.compatible).toBeDefined();

      await transport.request('unload_model', { model_id: 'primary-model' });
      await transport.request('unload_model', { model_id: 'draft-model' });
    }, 15000);

    it('should isolate errors in batch_check_draft', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await transport.request('load_model', {
        model_id: 'primary-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      const response = await transport.request<{
        results: Array<{
          success: boolean;
          result?: { compatible: boolean };
          error?: string;
        }>;
      }>('batch_check_draft', {
        requests: [
          { primary_id: 'primary-model', draft_id: 'nonexistent-draft' }, // Should fail
          { primary_id: 'nonexistent-primary', draft_id: 'primary-model' }, // Should fail
        ],
      });

      expect(response.results).toHaveLength(2);

      // Both should fail (models not loaded)
      expect(response.results[0].success).toBe(false);
      expect(response.results[0].error).toBeDefined();

      expect(response.results[1].success).toBe(false);
      expect(response.results[1].error).toBeDefined();

      await transport.request('unload_model', { model_id: 'primary-model' });
    }, 15000);
  });

  describe('BatchQueue End-to-End', () => {
    it('should transparently batch tokenize calls', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await transport.request('load_model', {
        model_id: 'test-model',
        local_path: './models/llama-3.2-3b-instruct',
      });

      // Queue multiple requests rapidly
      const promises = [
        batchQueue.tokenize({ model_id: 'test-model', text: 'First' }),
        batchQueue.tokenize({ model_id: 'test-model', text: 'Second' }),
        batchQueue.tokenize({ model_id: 'test-model', text: 'Third' }),
      ];

      // Wait for all to complete
      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.tokens).toBeDefined();
        expect(Array.isArray(result.tokens)).toBe(true);
      });

      // Verify batching efficiency
      const stats = batchQueue.getStats();
      expect(stats.tokenizeRequests).toBe(3);
      expect(stats.tokenizeBatches).toBeLessThanOrEqual(2); // Should batch efficiently

      await transport.request('unload_model', { model_id: 'test-model' });
    }, 15000);
  });
});
