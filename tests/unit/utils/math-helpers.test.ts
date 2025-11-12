/**
 * Unit tests for math helper utilities
 *
 * Tests safe mathematical operations that guard against division by zero,
 * NaN propagation, and other edge cases.
 */

import { describe, it, expect } from 'vitest';
import { safeAverage, safeDivide, safeSum } from '@/utils/math-helpers.js';

describe('Math Helpers', () => {
  describe('safeAverage', () => {
    it('should return 0 for empty array', () => {
      expect(safeAverage([])).toBe(0);
    });

    it('should return custom default for empty array', () => {
      expect(safeAverage([], 100)).toBe(100);
    });

    it('should calculate correct average for array with values', () => {
      expect(safeAverage([1, 2, 3])).toBe(2);
      expect(safeAverage([10, 20, 30])).toBe(20);
      expect(safeAverage([5])).toBe(5);
    });

    it('should handle floating point numbers correctly', () => {
      expect(safeAverage([1.5, 2.5, 3.5])).toBe(2.5);
      expect(safeAverage([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 10);
    });

    it('should handle negative numbers correctly', () => {
      expect(safeAverage([-1, -2, -3])).toBe(-2);
      expect(safeAverage([-10, 10])).toBe(0);
    });

    it('should handle zeros correctly', () => {
      expect(safeAverage([0, 0, 0])).toBe(0);
      expect(safeAverage([0, 1, 2])).toBe(1);
    });

    it('should handle large numbers correctly', () => {
      expect(safeAverage([1000000, 2000000, 3000000])).toBe(2000000);
    });

    it('should handle null/undefined input gracefully', () => {
      // @ts-expect-error Testing runtime behavior
      expect(safeAverage(null)).toBe(0);
      // @ts-expect-error Testing runtime behavior
      expect(safeAverage(undefined)).toBe(0);
    });
  });

  describe('safeDivide', () => {
    it('should return 0 for division by zero', () => {
      expect(safeDivide(10, 0)).toBe(0);
    });

    it('should return custom default for division by zero', () => {
      expect(safeDivide(10, 0, 100)).toBe(100);
    });

    it('should calculate correct division for valid inputs', () => {
      expect(safeDivide(10, 2)).toBe(5);
      expect(safeDivide(100, 4)).toBe(25);
      expect(safeDivide(7, 2)).toBe(3.5);
    });

    it('should handle negative numbers correctly', () => {
      expect(safeDivide(-10, 2)).toBe(-5);
      expect(safeDivide(10, -2)).toBe(-5);
      expect(safeDivide(-10, -2)).toBe(5);
    });

    it('should handle floating point divisors correctly', () => {
      expect(safeDivide(10, 2.5)).toBe(4);
      expect(safeDivide(1, 0.5)).toBe(2);
    });

    it('should handle zero numerator correctly', () => {
      expect(safeDivide(0, 10)).toBe(0);
      expect(safeDivide(0, 0)).toBe(0);
    });

    it('should handle large numbers correctly', () => {
      expect(safeDivide(1000000, 1000)).toBe(1000);
    });

    it('should handle very small divisors correctly', () => {
      expect(safeDivide(1, 0.001)).toBe(1000);
    });
  });

  describe('safeSum', () => {
    it('should return 0 for empty array', () => {
      expect(safeSum([])).toBe(0);
    });

    it('should return custom default for empty array', () => {
      expect(safeSum([], 100)).toBe(100);
    });

    it('should calculate correct sum for array with values', () => {
      expect(safeSum([1, 2, 3])).toBe(6);
      expect(safeSum([10, 20, 30])).toBe(60);
      expect(safeSum([5])).toBe(5);
    });

    it('should handle floating point numbers correctly', () => {
      expect(safeSum([1.5, 2.5, 3.5])).toBe(7.5);
      expect(safeSum([0.1, 0.2, 0.3])).toBeCloseTo(0.6, 10);
    });

    it('should handle negative numbers correctly', () => {
      expect(safeSum([-1, -2, -3])).toBe(-6);
      expect(safeSum([-10, 10])).toBe(0);
    });

    it('should handle zeros correctly', () => {
      expect(safeSum([0, 0, 0])).toBe(0);
      expect(safeSum([0, 1, 2])).toBe(3);
    });

    it('should handle large numbers correctly', () => {
      expect(safeSum([1000000, 2000000, 3000000])).toBe(6000000);
    });

    it('should handle null/undefined input gracefully', () => {
      // @ts-expect-error Testing runtime behavior
      expect(safeSum(null)).toBe(0);
      // @ts-expect-error Testing runtime behavior
      expect(safeSum(undefined)).toBe(0);
    });
  });

  describe('Edge Cases and Integration', () => {
    it('should handle division after sum correctly', () => {
      const values = [10, 20, 30];
      const sum = safeSum(values);
      const average = safeDivide(sum, values.length);
      expect(average).toBe(20);
    });

    it('should handle empty array sum and division', () => {
      const values: number[] = [];
      const sum = safeSum(values);
      const average = safeDivide(sum, values.length);
      expect(average).toBe(0);
    });

    it('should prevent NaN propagation', () => {
      // Without safe functions, this would produce NaN
      const values: number[] = [];
      const unsafeAverage = values.reduce((sum, v) => sum + v, 0) / values.length;
      expect(unsafeAverage).toBeNaN();

      // With safe functions, returns 0
      const safeAverageResult = safeAverage(values);
      expect(safeAverageResult).toBe(0);
      expect(Number.isNaN(safeAverageResult)).toBe(false);
    });

    it('should prevent Infinity from division by zero', () => {
      // Without safe functions, this would produce Infinity
      const unsafeResult = 10 / 0;
      expect(unsafeResult).toBe(Infinity);

      // With safe functions, returns 0
      const safeResult = safeDivide(10, 0);
      expect(safeResult).toBe(0);
      expect(Number.isFinite(safeResult)).toBe(true);
    });
  });

  describe('Real-World Use Cases', () => {
    it('should handle latency averaging with no samples', () => {
      const latencies: number[] = [];
      const avgLatency = safeAverage(latencies);
      expect(avgLatency).toBe(0);
      expect(Number.isNaN(avgLatency)).toBe(false);
    });

    it('should handle success rate calculation with no requests', () => {
      const successful = 0;
      const total = 0;
      const successRate = safeDivide(successful, total);
      expect(successRate).toBe(0);
      expect(Number.isNaN(successRate)).toBe(false);
    });

    it('should handle throughput calculation with zero window', () => {
      const requests = 100;
      const windowMs = 0;
      const throughput = safeDivide(requests, Math.max(windowMs / 1000, 0.001));
      expect(throughput).toBe(100000); // 100 requests / 0.001 seconds
      expect(Number.isFinite(throughput)).toBe(true);
    });

    it('should handle error rate with no errors', () => {
      const requests = [0, 0, 0, 0, 0];
      const errorCount = requests.filter((r) => r === 1).length;
      const errorRate = safeDivide(errorCount, requests.length);
      expect(errorRate).toBe(0);
    });

    it('should handle error rate with all errors', () => {
      const requests = [1, 1, 1, 1, 1];
      const errorCount = requests.filter((r) => r === 1).length;
      const errorRate = safeDivide(errorCount, requests.length);
      expect(errorRate).toBe(1);
    });
  });
});
