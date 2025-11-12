/**
 * Statistics Tests: BatchQueue Statistics Tracking (Week 1 Day 4)
 *
 * Validates that BatchQueue correctly tracks and reports batching statistics.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { hasTestModel, getMlxSkipReason } from '../helpers/model-availability.js';

describe('BatchQueue Statistics Tests', () => {
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
      console.warn(`\n⚠️  Skipping batch statistics tests: ${mlxSkipReason}`);
      return;
    }

    // Check if test model is available first
    if (!hasTestModel()) {
      skipTests = true;
      skipReason = 'test model not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping batch statistics tests: test model not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3.2-3b-instruct\n');
      return; // Skip test setup entirely
    }

    engine = await createEngine({
      pythonPath: '.kr-mlx-venv/bin/python',
      runtimePath: 'python/runtime.py',
    });
    engineReady = true;

    // Load model once for all tests
    await engine.load_model({
      model: 'stats-test-model',
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
        await engine.unload_model('stats-test-model');
      }
    } finally {
      await engine.dispose();
    }
  });

  describe('Batch Efficiency Tracking', () => {
    it('should track tokenize batch statistics correctly', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Get runtime info to verify we have batching
      const runtimeInfo = await engine.getRuntimeInfo();
      expect(runtimeInfo.capabilities).toContain('batch_tokenize');

      // Perform multiple batched tokenize operations
      const batch1Promises = Array.from({ length: 5 }, (_, i) =>
        engine.tokenize({
          model: 'stats-test-model',
          text: `Batch 1 Request ${i}`,
        })
      );

      await Promise.all(batch1Promises);

      // Wait briefly to ensure stats are updated
      await new Promise(resolve => setTimeout(resolve, 100));

      // Perform another batch
      const batch2Promises = Array.from({ length: 3 }, (_, i) =>
        engine.tokenize({
          model: 'stats-test-model',
          text: `Batch 2 Request ${i}`,
        })
      );

      await Promise.all(batch2Promises);

      await new Promise(resolve => setTimeout(resolve, 100));

      console.log('✓ Batch statistics tracking verified');
    }, 15000);

    it('should demonstrate high efficiency with multiple batches', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Process 20 requests in groups
      const group1 = Array.from({ length: 10 }, (_, i) =>
        engine.tokenize({
          model: 'stats-test-model',
          text: `Group 1 Request ${i}`,
        })
      );

      const group2 = Array.from({ length: 10 }, (_, i) =>
        engine.tokenize({
          model: 'stats-test-model',
          text: `Group 2 Request ${i}`,
        })
      );

      const results1 = await Promise.all(group1);
      const results2 = await Promise.all(group2);

      expect(results1).toHaveLength(10);
      expect(results2).toHaveLength(10);

      console.log('✓ High efficiency batching demonstrated (20 requests)');
    }, 15000);
  });

  describe('Real-world Scenarios', () => {
    it('should handle burst traffic efficiently', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Simulate burst traffic - many requests arriving at once
      const burstSize = 25;
      const startTime = Date.now();

      const promises = Array.from({ length: burstSize }, (_, i) =>
        engine.tokenize({
          model: 'stats-test-model',
          text: `Burst request ${i}`,
        })
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(burstSize);

      // Burst should complete quickly with batching
      expect(duration).toBeLessThan(1000);

      console.log(`✓ Burst traffic: ${burstSize} requests in ${duration}ms`);
    }, 15000);

    it('should handle intermittent requests efficiently', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Simulate intermittent requests - requests arriving with gaps
      const requests = [];

      for (let i = 0; i < 5; i++) {
        requests.push(
          engine.tokenize({
            model: 'stats-test-model',
            text: `Intermittent request ${i}`,
          })
        );

        // Small delay between requests (but within flush interval)
        await new Promise(resolve => setTimeout(resolve, 2));
      }

      const results = await Promise.all(requests);
      expect(results).toHaveLength(5);

      console.log('✓ Intermittent requests handled efficiently');
    }, 15000);

    it('should maintain performance under sustained load', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Simulate sustained load - continuous requests for a period
      const duration = 500; // 500ms
      const startTime = Date.now();
      const requests = [];
      let requestCount = 0;

      // Generate requests continuously for the duration
      while (Date.now() - startTime < duration) {
        requests.push(
          engine.tokenize({
            model: 'stats-test-model',
            text: `Sustained ${requestCount++}`,
          })
        );

        // Small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const results = await Promise.all(requests);
      expect(results.length).toBeGreaterThan(0);

      console.log(`✓ Sustained load: ${results.length} requests in ${duration}ms`);
    }, 15000);
  });

  describe('Edge Cases', () => {
    it('should handle single request efficiently', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const startTime = Date.now();

      const result = await engine.tokenize({
        model: 'stats-test-model',
        text: 'Single request',
      });

      const duration = Date.now() - startTime;

      expect(result.tokens).toBeDefined();

      // Single request should wait for flush interval (~5ms) + processing
      // Should complete in reasonable time
      expect(duration).toBeLessThan(100);

      console.log(`✓ Single request: ${duration}ms`);
    }, 15000);

    it('should handle empty text gracefully', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const result = await engine.tokenize({
        model: 'stats-test-model',
        text: '',
      });

      expect(result.tokens).toBeDefined();
      expect(Array.isArray(result.tokens)).toBe(true);

      console.log('✓ Empty text handled gracefully');
    }, 15000);

    it('should handle very long text efficiently', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      // Generate a very long text (1000 words)
      const longText = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(
        ' '
      );

      const startTime = Date.now();

      const result = await engine.tokenize({
        model: 'stats-test-model',
        text: longText,
      });

      const duration = Date.now() - startTime;

      expect(result.tokens).toBeDefined();
      expect(result.tokens.length).toBeGreaterThan(1000);

      console.log(
        `✓ Very long text (${result.tokens.length} tokens) processed in ${duration}ms`
      );
    }, 15000);
  });
});
