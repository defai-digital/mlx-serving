/**
 * Integration Tests: Engine with BatchQueue (Week 1 Day 3)
 *
 * Tests that Engine correctly uses BatchQueue for tokenization
 * when Python runtime supports batching capabilities.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';
import { tagEngineTop20 } from '../helpers/tags.js';

describe('Engine Batch Integration', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping engine batch tests: ${mlxSkipReason}`);
      return;
    }

    // Check if test model is available first
    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping engine batch tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3.2-3b-instruct\n');
      return; // Skip test setup entirely
    }

    engine = await createEngine({
      pythonPath: '.kr-mlx-venv/bin/python',
      runtimePath: 'python/runtime.py',
    });
  }, 30000);

  afterAll(async () => {
    if (engine) {
      await engine.dispose();
    }
  });

  it(tagEngineTop20('should automatically use batching for tokenize requests'), async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    // Load model with local path (using snake_case for compatibility)
    await engine.load_model({
      model: 'test-model',
      local_path: './models/llama-3.2-3b-instruct',
    });

    // Multiple tokenize calls should be batched automatically
    const promises = [
      engine.tokenize({ model: 'test-model', text: 'Hello' }),
      engine.tokenize({ model: 'test-model', text: 'World' }),
      engine.tokenize({ model: 'test-model', text: 'Test' }),
    ];

    const results = await Promise.all(promises);

    // All should succeed
    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.tokens).toBeDefined();
      expect(Array.isArray(result.tokens)).toBe(true);
      expect(result.tokens.length).toBeGreaterThan(0);
    });

    // Cleanup
    await engine.unload_model('test-model');
  }, 30000);

  it(tagEngineTop20('should handle snake_case API with batching'), async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    // Load model
    await engine.load_model({
      model: 'test-model-2',
      local_path: './models/llama-3.2-3b-instruct',
    });

    // Test snake_case API
    const result = await engine.tokenize({
      model: 'test-model-2',
      text: 'Batching test',
    });

    expect(result.tokens).toBeDefined();
    expect(result.tokens.length).toBeGreaterThan(0);

    await engine.unload_model('test-model-2');
  }, 30000);

  it(tagEngineTop20('should report runtime capabilities including batching'), async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const info = await engine.getRuntimeInfo();

    expect(info.capabilities).toContain('batch_tokenize');
    expect(info.capabilities).toContain('batch_check_draft');
    expect(info.version).toBeDefined();
    expect(info.protocol).toBe('json-rpc-2.0');
  }, 15000);
});
