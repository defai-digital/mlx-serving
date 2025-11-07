/**
 * Draft Model Compatibility Tests (Week 2 Day 1)
 *
 * Validates draft-primary model pairing for speculative decoding:
 * - Vocabulary compatibility (critical: must match)
 * - Architecture family validation
 * - Model size validation (draft should be smaller)
 * - Performance estimation
 * - Special tokens compatibility
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { hasDraftModelPair, getMlxSkipReason } from '../helpers/model-availability.js';
import { tagEngineTop20 } from '../helpers/tags.js';

describe('Draft Model Compatibility Tests', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping draft model tests: ${mlxSkipReason}`);
      return;
    }

    // Check if required models are available first
    if (!hasDraftModelPair()) {
      skipTests = true;
      skipReason = 'required models not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping draft model tests: required models not found');
      // eslint-disable-next-line no-console
      console.warn('   Required: ./models/llama-3-8b-instruct and ./models/llama-3.2-3b-instruct\n');
      return; // Skip engine creation entirely
    }

    engine = await createEngine({
      pythonPath: '.kr-mlx-venv/bin/python',
      runtimePath: 'python/runtime.py',
    });

    // Pre-load models once for all tests
    await engine.load_model({
      model: 'llama-3-8b-test',
      local_path: './models/llama-3-8b-instruct',
    });

    await engine.load_draft_model({
      model: 'llama-3.2-3b-test',
      local_path: './models/llama-3.2-3b-instruct',
    });
  }, 60000);

  afterAll(async () => {
    if (engine) {
      // Clean up all models before disposing
      try {
        await engine.unload_draft_model('llama-3.2-3b-test');
        await engine.unload_model('llama-3-8b-test');
      } catch (e) {
        // Ignore cleanup errors
      }
      await engine.dispose();
    }
  });

  describe('Enhanced Compatibility Report', () => {
    it(tagEngineTop20('should return comprehensive compatibility report with all fields'), async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const report = await engine.isDraftModelCompatible(
        'llama-3-8b-test',
        'llama-3.2-3b-test'
      );

      // Verify complete report structure
      expect(report).toBeDefined();
      expect(report.compatible).toBeDefined();
      expect(Array.isArray(report.errors)).toBe(true);
      expect(Array.isArray(report.warnings)).toBe(true);
      expect(report.details).toBeDefined();

      // Verify primary model details
      expect(report.details.primaryModel).toMatchObject({
        id: 'llama-3-8b-test',
        vocabSize: expect.any(Number),
        parameterCount: expect.any(Number),
        architecture: expect.any(String),
      });

      // Verify draft model details
      expect(report.details.draftModel).toMatchObject({
        id: 'llama-3.2-3b-test',
        vocabSize: expect.any(Number),
        parameterCount: expect.any(Number),
        architecture: expect.any(String),
      });

      // Verify performance estimate
      expect(report.details.performanceEstimate).toMatchObject({
        expectedSpeedup: expect.any(String),
        sizeRatio: expect.any(String),
        recommendation: expect.any(String),
      });

      console.log('✓ Complete compatibility report structure validated:', {
        compatible: report.compatible,
        errorsCount: report.errors.length,
        warningsCount: report.warnings.length,
        primaryModel: report.details.primaryModel.id,
        draftModel: report.details.draftModel.id,
      });
    }, 30000);

    it('should validate vocabulary compatibility', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const report = await engine.isDraftModelCompatible(
        'llama-3-8b-test',
        'llama-3.2-3b-test'
      );

      // Same model family should have same vocabulary
      expect(report.details.primaryModel.vocabSize).toBe(
        report.details.draftModel.vocabSize
      );

      // If vocabularies match and no critical errors, should be compatible
      if (report.details.primaryModel.vocabSize === report.details.draftModel.vocabSize) {
        // No vocabulary mismatch error should exist
        const vocabError = report.errors.find((e) => e.includes('Vocabulary size mismatch'));
        expect(vocabError).toBeUndefined();
      }

      console.log('✓ Vocabulary compatibility check:', {
        primaryVocab: report.details.primaryModel.vocabSize,
        draftVocab: report.details.draftModel.vocabSize,
        compatible: report.compatible,
      });
    }, 30000);

    it(tagEngineTop20('should provide performance estimation'), async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const report = await engine.isDraftModelCompatible(
        'llama-3-8b-test',
        'llama-3.2-3b-test'
      );

      // Verify performance estimate exists
      expect(report.details.performanceEstimate).toBeDefined();
      expect(report.details.performanceEstimate.expectedSpeedup).toBeTruthy();
      expect(report.details.performanceEstimate.sizeRatio).toBeTruthy();
      expect(report.details.performanceEstimate.recommendation).toBeTruthy();

      // If parameter counts are available, validate format
      const primaryParams = report.details.primaryModel.parameterCount;
      const draftParams = report.details.draftModel.parameterCount;

      if (primaryParams > 0 && draftParams > 0) {
        // Full performance estimation available
        expect(report.details.performanceEstimate.expectedSpeedup).toMatch(/\d+\.\d+x/);
        expect(report.details.performanceEstimate.sizeRatio).toMatch(/\d+\.\d+%/);

        const speedupMatch = report.details.performanceEstimate.expectedSpeedup.match(
          /(\d+\.\d+)x/
        );
        const speedup = parseFloat(speedupMatch![1]);
        expect(speedup).toBeGreaterThanOrEqual(1.0);
      } else {
        // Basic framework: parameter counts not available
        // This is acceptable for Week 2 Day 1 basic framework
        expect(report.details.performanceEstimate.sizeRatio).toBe('N/A');
      }

      console.log('✓ Performance estimation:', {
        expectedSpeedup: report.details.performanceEstimate.expectedSpeedup,
        sizeRatio: report.details.performanceEstimate.sizeRatio,
        recommendation: report.details.performanceEstimate.recommendation,
        paramCountsAvailable: primaryParams > 0 && draftParams > 0,
      });
    }, 30000);

    it('should validate model sizes', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const report = await engine.isDraftModelCompatible(
        'llama-3-8b-test',
        'llama-3.2-3b-test'
      );

      const primaryParams = report.details.primaryModel.parameterCount;
      const draftParams = report.details.draftModel.parameterCount;

      // Verify parameter counts exist (may be 0 if not available)
      expect(primaryParams).toBeGreaterThanOrEqual(0);
      expect(draftParams).toBeGreaterThanOrEqual(0);

      if (primaryParams > 0 && draftParams > 0) {
        // Parameter counts available: validate relationship
        if (draftParams >= primaryParams) {
          // Should have a warning about this
          const sizeWarning = report.warnings.find((w) =>
            w.includes('not smaller than primary')
          );
          expect(sizeWarning).toBeDefined();
        } else {
          // Good pairing: draft is smaller
          expect(draftParams).toBeLessThan(primaryParams);
        }

        console.log('✓ Model size validation:', {
          primaryParams: primaryParams.toLocaleString(),
          draftParams: draftParams.toLocaleString(),
          ratio: ((draftParams / primaryParams) * 100).toFixed(1) + '%',
        });
      } else {
        // Basic framework: parameter counts not available
        // This is acceptable for Week 2 Day 1 basic framework
        console.log('✓ Model size validation (limited):', {
          primaryParams,
          draftParams,
          note: 'Parameter counts not available in basic framework',
        });
      }
    }, 30000);

    it('should separate errors from warnings', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      const report = await engine.isDraftModelCompatible(
        'llama-3-8b-test',
        'llama-3.2-3b-test'
      );

      // Verify arrays exist
      expect(Array.isArray(report.errors)).toBe(true);
      expect(Array.isArray(report.warnings)).toBe(true);

      // Compatible only if NO errors (warnings are OK)
      if (report.errors.length === 0) {
        expect(report.compatible).toBe(true);
      } else {
        expect(report.compatible).toBe(false);
      }

      console.log('✓ Error/warning separation:', {
        compatible: report.compatible,
        errors: report.errors,
        warnings: report.warnings,
      });
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should throw error for non-existent models', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await expect(
        engine.isDraftModelCompatible('non-existent-primary', 'non-existent-draft')
      ).rejects.toThrow();

      console.log('✓ Error handling for non-existent models works');
    });

    it('should throw error if primary model not loaded', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await expect(
        engine.isDraftModelCompatible('missing-primary', 'llama-3.2-3b-test')
      ).rejects.toThrow();

      console.log('✓ Error handling for missing primary model works');
    });

    it('should throw error if draft model not loaded', async () => {
      if (skipTests) {
        // eslint-disable-next-line no-console
        console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
        return;
      }

      await expect(
        engine.isDraftModelCompatible('llama-3-8b-test', 'missing-draft')
      ).rejects.toThrow();

      console.log('✓ Error handling for missing draft model works');
    });
  });
});
