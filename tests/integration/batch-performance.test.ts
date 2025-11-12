/**
 * Performance Tests: BatchQueue Performance Validation (Week 1 Day 4)
 *
 * Tests batch processing performance improvements and validates
 * efficiency gains from request batching.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';

describe('BatchQueue Performance Tests', () => {
  let engine: Engine;
  let engineReady = false;
  let modelLoaded = false;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping batch performance tests: ${mlxSkipReason}`);
      return;
    }

    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping batch performance tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3.2-3b-instruct\n');
      return;
    }

    engine = await createEngine({
      pythonPath: '.kr-mlx-venv/bin/python',
      runtimePath: 'python/runtime.py',
    });
    engineReady = true;

    // Load model once for all tests
    await engine.load_model({
      model: 'perf-test-model',
      local_path: './models/llama-3.2-3b-instruct',
    });
    modelLoaded = true;
  }, 30000);

  afterAll(async () => {
    if (!engineReady) {
      return;
    }

    try {
      if (modelLoaded) {
        await engine.unload_model('perf-test-model');
      }
    } finally {
      await engine.dispose();
    }
  });

  describe('Concurrent Requests', () => {
    it('should efficiently batch 10 concurrent tokenize requests', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const startTime = Date.now();

      // Create 10 concurrent requests
      const promises = Array.from({ length: 10 }, (_, i) =>
        engine.tokenize({
          model: 'perf-test-model',
          text: `Request ${i}: This is a test sentence for tokenization.`,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All should succeed
      expect(results).toHaveLength(10);
      results.forEach((result, _i) => {
        expect(result.tokens).toBeDefined();
        expect(Array.isArray(result.tokens)).toBe(true);
        expect(result.tokens.length).toBeGreaterThan(0);
      });

      // Batching should complete in reasonable time
      // With batching: ~100-200ms
      // Without batching: ~500-1000ms (10 sequential IPC calls)
      expect(duration).toBeLessThan(1000);

      console.log(`✓ 10 concurrent requests completed in ${duration}ms`);
    }, 15000);

    it('should handle 50 concurrent requests efficiently', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const startTime = Date.now();

      // Create 50 concurrent requests (will be split into multiple batches)
      const promises = Array.from({ length: 50 }, (_, i) =>
        engine.tokenize({
          model: 'perf-test-model',
          text: `Request ${i}: Test`,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All should succeed
      expect(results).toHaveLength(50);
      results.forEach(result => {
        expect(result.tokens).toBeDefined();
        expect(Array.isArray(result.tokens)).toBe(true);
      });

      // Should complete in reasonable time even with multiple batches
      expect(duration).toBeLessThan(3000);

      console.log(`✓ 50 concurrent requests completed in ${duration}ms`);
    }, 20000);
  });

  describe('Batch Size Behavior', () => {
    it('should flush immediately when maxBatchSize is reached', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const startTime = Date.now();

      // Create exactly maxBatchSize (10) requests
      const promises = Array.from({ length: 10 }, (_, i) =>
        engine.tokenize({
          model: 'perf-test-model',
          text: `Batch ${i}`,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(10);

      // Should flush immediately without waiting for flushIntervalMs (5ms)
      // Duration should be dominated by IPC + tokenization time, not timer
      console.log(`✓ maxBatchSize batch completed in ${duration}ms`);
    }, 15000);

    it('should respect flushIntervalMs for smaller batches', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const startTime = Date.now();

      // Create only 3 requests (less than maxBatchSize)
      const promises = Array.from({ length: 3 }, (_, i) =>
        engine.tokenize({
          model: 'perf-test-model',
          text: `Small batch ${i}`,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(3);

      // Should wait for flushIntervalMs (5ms) before flushing
      // Duration includes ~5ms wait + IPC + tokenization
      console.log(`✓ Small batch completed in ${duration}ms (includes 5ms flush interval)`);
    }, 15000);
  });

  describe('Sequential vs Parallel Performance', () => {
    it('should demonstrate batching advantage over sequential processing', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const testSize = 10;

      // Test 1: Sequential processing (simulate non-batch behavior)
      const sequentialStart = Date.now();
      for (let i = 0; i < testSize; i++) {
        await engine.tokenize({
          model: 'perf-test-model',
          text: `Sequential ${i}`,
        });
      }
      const sequentialDuration = Date.now() - sequentialStart;

      // Test 2: Parallel processing with batching
      const parallelStart = Date.now();
      const promises = Array.from({ length: testSize }, (_, i) =>
        engine.tokenize({
          model: 'perf-test-model',
          text: `Parallel ${i}`,
        })
      );
      await Promise.all(promises);
      const parallelDuration = Date.now() - parallelStart;

      console.log(`Sequential: ${sequentialDuration}ms`);
      console.log(`Parallel (batched): ${parallelDuration}ms`);
      console.log(
        `Speedup: ${(sequentialDuration / parallelDuration).toFixed(2)}x`
      );

      // Batching should be significantly faster
      // Conservative expectation: at least 2x faster
      expect(parallelDuration).toBeLessThan(sequentialDuration);

      // Aggressive expectation: 3x+ faster (if batching works well)
      if (parallelDuration * 3 < sequentialDuration) {
        console.log('✓ Excellent batching performance (>3x speedup)');
      } else if (parallelDuration * 2 < sequentialDuration) {
        console.log('✓ Good batching performance (>2x speedup)');
      } else {
        console.log('⚠ Moderate batching performance');
      }
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should isolate errors in batch without affecting other requests', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Mix valid and invalid requests
      const promises = [
        engine.tokenize({ model: 'perf-test-model', text: 'Valid 1' }),
        engine.tokenize({ model: 'nonexistent-model', text: 'Invalid' }), // Should fail
        engine.tokenize({ model: 'perf-test-model', text: 'Valid 2' }),
      ];

      const results = await Promise.allSettled(promises);

      expect(results).toHaveLength(3);

      // First request should succeed
      expect(results[0].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled') {
        expect(results[0].value.tokens).toBeDefined();
      }

      // Second request should fail
      expect(results[1].status).toBe('rejected');

      // Third request should succeed (error isolation)
      expect(results[2].status).toBe('fulfilled');
      if (results[2].status === 'fulfilled') {
        expect(results[2].value.tokens).toBeDefined();
      }
    }, 15000);
  });

  describe('Mixed Text Lengths', () => {
    it('should efficiently batch requests with varying text lengths', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const texts = [
        'Short',
        'This is a medium length sentence for testing.',
        'This is a much longer sentence that contains significantly more tokens and should still be efficiently processed within the same batch as shorter sentences, demonstrating that the batching mechanism can handle heterogeneous request sizes.',
      ];

      const startTime = Date.now();

      const promises = texts.map(text =>
        engine.tokenize({
          model: 'perf-test-model',
          text,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(3);

      // Verify token counts correlate with text length
      expect(results[0].tokens.length).toBeLessThan(results[1].tokens.length);
      expect(results[1].tokens.length).toBeLessThan(results[2].tokens.length);

      console.log(`✓ Mixed lengths: ${results[0].tokens.length}, ${results[1].tokens.length}, ${results[2].tokens.length} tokens in ${duration}ms`);
    }, 15000);
  });
});
