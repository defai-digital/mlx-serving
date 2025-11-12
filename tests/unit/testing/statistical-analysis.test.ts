/**
 * Statistical Analysis Tests
 *
 * Tests for statistical methods used in A/B testing framework.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateSampleStatistics,
  welchTTest,
  calculateEffectSize,
  calculateSampleSize,
  formatPValue,
  getSignificanceLevel,
} from '../../../src/testing/statistical-analysis.js';

describe('Statistical Analysis', () => {
  describe('calculateSampleStatistics', () => {
    it('should calculate basic statistics correctly', () => {
      const values = [1, 2, 3, 4, 5];
      const stats = calculateSampleStatistics(values);

      expect(stats.n).toBe(5);
      expect(stats.mean).toBe(3);
      expect(stats.median).toBe(3);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(5);
    });

    it('should calculate variance and standard deviation', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const stats = calculateSampleStatistics(values);

      // Expected: mean = 5, variance = 4, stdDev = 2
      expect(stats.mean).toBe(5);
      expect(stats.variance).toBeCloseTo(4, 5);
      expect(stats.stdDev).toBeCloseTo(2, 5);
    });

    it('should calculate percentiles correctly', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1); // [1, 2, ..., 100]
      const stats = calculateSampleStatistics(values);

      expect(stats.median).toBeCloseTo(50.5, 1);
      expect(stats.p95).toBeCloseTo(95.05, 1);
      expect(stats.p99).toBeCloseTo(99.01, 1);
    });

    it('should throw error for empty array', () => {
      expect(() => calculateSampleStatistics([])).toThrow('Cannot calculate statistics for empty array');
    });
  });

  describe('welchTTest', () => {
    it('should detect significant difference between groups', () => {
      // Two clearly different groups
      const baseline = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]; // mean = 14.5
      const variant = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]; // mean = 24.5

      const result = welchTTest(baseline, variant, 0.95);

      // Should be highly significant
      expect(result.pValue).toBeLessThan(0.001);
      expect(result.significant).toBe(true);
      expect(result.tStatistic).toBeGreaterThan(0);
      expect(result.confidenceLevel).toBe(0.95);
    });

    it('should not detect difference when groups are similar', () => {
      // Two similar groups (just noise)
      const baseline = [10, 11, 10.5, 11.5, 10.2, 10.8, 11.2, 10.6, 11.4, 10.9];
      const variant = [10.1, 11.1, 10.6, 11.4, 10.3, 10.9, 11.3, 10.5, 11.2, 10.7];

      const result = welchTTest(baseline, variant, 0.95);

      // Should not be significant
      expect(result.pValue).toBeGreaterThan(0.05);
      expect(result.significant).toBe(false);
    });

    it('should calculate confidence interval', () => {
      const baseline = [10, 12, 14, 16, 18];
      const variant = [20, 22, 24, 26, 28];

      const result = welchTTest(baseline, variant, 0.95);

      // Confidence interval should contain the true mean difference
      const [lower, upper] = result.confidenceInterval;
      expect(lower).toBeGreaterThan(0); // Variant is clearly higher
      expect(upper).toBeGreaterThan(lower);
    });

    it('should handle different confidence levels', () => {
      const baseline = [10, 11, 12, 13, 14];
      const variant = [15, 16, 17, 18, 19];

      const result95 = welchTTest(baseline, variant, 0.95);
      const result99 = welchTTest(baseline, variant, 0.99);

      // 99% CI should be wider than 95% CI
      const width95 = result95.confidenceInterval[1] - result95.confidenceInterval[0];
      const width99 = result99.confidenceInterval[1] - result99.confidenceInterval[0];
      expect(width99).toBeGreaterThan(width95);
    });

    it('should handle unequal variances (Welch test)', () => {
      // One group with high variance, one with low variance
      const baseline = [10, 10, 10, 10, 10]; // variance = 0
      const variant = [5, 10, 15, 20, 25]; // high variance

      const result = welchTTest(baseline, variant, 0.95);

      // Should still work (this is the advantage of Welch's t-test)
      expect(result.tStatistic).toBeDefined();
      expect(result.pValue).toBeDefined();
      expect(result.degreesOfFreedom).toBeGreaterThan(0);
    });
  });

  describe('calculateEffectSize', () => {
    it('should calculate Cohen\'s d correctly', () => {
      // Two groups with known effect size
      // Group 1: mean = 0, std ≈ 0.707
      // Group 2: mean = 0.5, std ≈ 0.707
      // Expected Cohen's d ≈ 0.707 (medium effect)
      const baseline = [-1, -0.5, 0, 0.5, 1];
      const variant = [-0.5, 0, 0.5, 1, 1.5];

      const result = calculateEffectSize(baseline, variant);

      expect(result.cohensD).toBeCloseTo(0.707, 1);
      expect(result.interpretation).toBe('medium');
    });

    it('should classify effect sizes correctly', () => {
      // Negligible effect
      const negligible1 = [10, 11, 12, 13, 14];
      const negligible2 = [10.1, 11.1, 12.1, 13.1, 14.1];
      const negligibleEffect = calculateEffectSize(negligible1, negligible2);
      expect(negligibleEffect.interpretation).toBe('negligible');

      // Large effect
      const large1 = [10, 11, 12, 13, 14];
      const large2 = [20, 21, 22, 23, 24];
      const largeEffect = calculateEffectSize(large1, large2);
      expect(largeEffect.interpretation).toBe('large');
    });

    it('should handle negative effect (variant worse than baseline)', () => {
      const baseline = [20, 21, 22, 23, 24];
      const variant = [10, 11, 12, 13, 14];

      const result = calculateEffectSize(baseline, variant);

      expect(result.cohensD).toBeLessThan(0);
    });
  });

  describe('calculateSampleSize', () => {
    it('should calculate sample size for medium effect', () => {
      // Medium effect (d = 0.5), α = 0.05, power = 0.8
      const result = calculateSampleSize(0.5, 0.05, 0.8);

      // Expected: approximately 64 per group
      expect(result.requiredSampleSize).toBeGreaterThan(50);
      expect(result.requiredSampleSize).toBeLessThan(80);
      expect(result.power).toBe(0.8);
      expect(result.alpha).toBe(0.05);
      expect(result.effectSize).toBe(0.5);
    });

    it('should require more samples for smaller effect sizes', () => {
      const small = calculateSampleSize(0.2, 0.05, 0.8); // Small effect
      const medium = calculateSampleSize(0.5, 0.05, 0.8); // Medium effect
      const large = calculateSampleSize(0.8, 0.05, 0.8); // Large effect

      expect(small.requiredSampleSize).toBeGreaterThan(medium.requiredSampleSize);
      expect(medium.requiredSampleSize).toBeGreaterThan(large.requiredSampleSize);
    });

    it('should require more samples for higher power', () => {
      const power80 = calculateSampleSize(0.5, 0.05, 0.8);
      const power90 = calculateSampleSize(0.5, 0.05, 0.9);

      expect(power90.requiredSampleSize).toBeGreaterThan(power80.requiredSampleSize);
    });

    it('should throw error for invalid inputs', () => {
      expect(() => calculateSampleSize(0, 0.05, 0.8)).toThrow('Effect size must be positive');
      expect(() => calculateSampleSize(0.5, 0, 0.8)).toThrow('Alpha must be between 0 and 1');
      expect(() => calculateSampleSize(0.5, 0.05, 0)).toThrow('Power must be between 0 and 1');
      expect(() => calculateSampleSize(0.5, 0.05, 1.5)).toThrow('Power must be between 0 and 1');
    });
  });

  describe('formatPValue', () => {
    it('should format very small p-values', () => {
      expect(formatPValue(0.0001)).toBe('p < 0.001');
      expect(formatPValue(0.0005)).toBe('p < 0.001');
    });

    it('should format small p-values with 3 decimals', () => {
      expect(formatPValue(0.005)).toBe('p = 0.005');
      expect(formatPValue(0.009)).toBe('p = 0.009');
    });

    it('should format larger p-values with 2 decimals', () => {
      expect(formatPValue(0.05)).toBe('p = 0.05');
      expect(formatPValue(0.12)).toBe('p = 0.12');
    });
  });

  describe('getSignificanceLevel', () => {
    it('should classify p-values correctly', () => {
      expect(getSignificanceLevel(0.0001)).toBe('highly');
      expect(getSignificanceLevel(0.005)).toBe('moderately');
      expect(getSignificanceLevel(0.03)).toBe('weakly');
      expect(getSignificanceLevel(0.1)).toBe('not');
    });
  });
});
