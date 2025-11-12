/**
 * Integration tests for QoS system edge cases
 *
 * Tests QoS evaluation, monitoring, and remediation with edge cases:
 * - Empty samples arrays
 * - Zero windowMs
 * - Division by zero scenarios
 * - NaN/Infinity prevention
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QosEvaluator } from '@/streaming/qos/QosEvaluator.js';
import type { SloConfig } from '@/types/qos.js';

describe('QoS Edge Cases Integration', () => {
  let evaluator: QosEvaluator;

  beforeEach(() => {
    evaluator = new QosEvaluator({
      enabled: true,
      evaluationIntervalMs: 1000,
      tdigestCompression: 100,
      windowMs: 60000,
    });
  });

  describe('Empty Samples Array', () => {
    it('should handle error rate evaluation with no samples', () => {
      const slo: SloConfig = {
        name: 'error-rate-slo',
        metric: 'error_rate',
        threshold: 0.1,
        windowMs: 60000,
        severity: 'critical',
      };

      evaluator.registerSlo(slo);

      // Evaluate with no samples
      const result = evaluator.evaluateSlo(slo.name);

      expect(result).toBeDefined();
      expect(result?.currentValue).toBe(0); // Should be 0, not NaN
      expect(Number.isNaN(result?.currentValue)).toBe(false);
      expect(result?.violated).toBe(false); // 0 < 0.1, no violation
    });

    it('should handle throughput evaluation with no samples', () => {
      const slo: SloConfig = {
        name: 'throughput-slo',
        metric: 'throughput',
        threshold: 100,
        windowMs: 60000,
        severity: 'warning',
      };

      evaluator.registerSlo(slo);

      // Evaluate with no samples
      const result = evaluator.evaluateSlo(slo.name);

      expect(result).toBeDefined();
      expect(result?.currentValue).toBe(0); // Should be 0, not NaN
      expect(Number.isFinite(result?.currentValue)).toBe(true);
      expect(result?.violated).toBe(false); // 0 < 100, no violation
    });

    it('should handle TTFT evaluation with no samples', () => {
      const slo: SloConfig = {
        name: 'ttft-slo',
        metric: 'ttft',
        threshold: 500,
        windowMs: 60000,
        severity: 'warning',
      };

      evaluator.registerSlo(slo);

      // Evaluate with no samples - should not crash
      const result = evaluator.evaluateSlo(slo.name);

      // With no samples, T-Digest returns 0 for percentiles
      expect(result).toBeDefined();
      expect(Number.isNaN(result?.currentValue)).toBe(false);
      expect(Number.isFinite(result?.currentValue)).toBe(true);
    });
  });

  describe('Zero Window Duration', () => {
    it('should handle throughput calculation with windowMs = 0', () => {
      const slo: SloConfig = {
        name: 'throughput-zero-window',
        metric: 'throughput',
        threshold: 1000,
        windowMs: 0, // Edge case: zero window
        severity: 'critical',
      };

      evaluator.registerSlo(slo);

      // Add some samples
      const now = Date.now();
      evaluator.recordSample('throughput-zero-window', {
        timestamp: now - 100,
        value: 1,
        metadata: {},
      });
      evaluator.recordSample('throughput-zero-window', {
        timestamp: now - 50,
        value: 1,
        metadata: {},
      });

      // Evaluate - should not produce Infinity
      const result = evaluator.evaluateSlo(slo.name);

      expect(result).toBeDefined();
      expect(Number.isFinite(result?.currentValue)).toBe(true);
      expect(result?.currentValue).not.toBe(Infinity);
      // With windowMs = 0, uses minimum 0.001s, so throughput = samples / 0.001
      expect(result?.currentValue).toBeGreaterThan(0);
    });

    it('should use minimum window duration of 1ms', () => {
      const slo: SloConfig = {
        name: 'min-window-throughput',
        metric: 'throughput',
        threshold: 10000,
        windowMs: 0,
        severity: 'warning',
      };

      evaluator.registerSlo(slo);

      // Add 10 samples
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        evaluator.recordSample('min-window-throughput', {
          timestamp: now - i,
          value: 1,
          metadata: {},
        });
      }

      const result = evaluator.evaluateSlo(slo.name);

      // 10 samples / 0.001s = 10000 samples/sec
      expect(result?.currentValue).toBe(10000);
    });
  });

  describe('Error Rate Edge Cases', () => {
    it('should handle 0% error rate (no errors)', () => {
      const slo: SloConfig = {
        name: 'zero-error-rate',
        metric: 'error_rate',
        threshold: 0.05,
        windowMs: 60000,
        severity: 'critical',
      };

      evaluator.registerSlo(slo);

      const now = Date.now();
      // Add 100 successful requests (value = 0)
      for (let i = 0; i < 100; i++) {
        evaluator.recordSample('zero-error-rate', {
          timestamp: now - i * 100,
          value: 0, // Success
          metadata: {},
        });
      }

      const result = evaluator.evaluateSlo(slo.name);

      expect(result?.currentValue).toBe(0); // 0% error rate
      expect(result?.violated).toBe(false);
    });

    it('should handle 100% error rate (all errors)', () => {
      const slo: SloConfig = {
        name: 'full-error-rate',
        metric: 'error_rate',
        threshold: 0.5,
        windowMs: 60000,
        severity: 'critical',
      };

      evaluator.registerSlo(slo);

      const now = Date.now();
      // Add 100 failed requests (value = 1)
      for (let i = 0; i < 100; i++) {
        evaluator.recordSample('full-error-rate', {
          timestamp: now - i * 100,
          value: 1, // Error
          metadata: {},
        });
      }

      const result = evaluator.evaluateSlo(slo.name);

      expect(result?.currentValue).toBe(1); // 100% error rate
      expect(result?.violated).toBe(true); // 1 > 0.5
    });

    it('should calculate correct error rate with mixed results', () => {
      const slo: SloConfig = {
        name: 'mixed-error-rate',
        metric: 'error_rate',
        threshold: 0.1,
        windowMs: 60000,
        severity: 'warning',
      };

      evaluator.registerSlo(slo);

      const now = Date.now();
      // Add 90 successful and 10 failed requests
      for (let i = 0; i < 90; i++) {
        evaluator.recordSample('mixed-error-rate', {
          timestamp: now - i * 100,
          value: 0, // Success
          metadata: {},
        });
      }
      for (let i = 0; i < 10; i++) {
        evaluator.recordSample('mixed-error-rate', {
          timestamp: now - (90 + i) * 100,
          value: 1, // Error
          metadata: {},
        });
      }

      const result = evaluator.evaluateSlo(slo.name);

      expect(result?.currentValue).toBe(0.1); // 10% error rate
      expect(result?.violated).toBe(false); // 0.1 == 0.1, no violation (not >)
    });
  });

  describe('NaN and Infinity Prevention', () => {
    it('should never produce NaN in evaluation results', () => {
      const slos: SloConfig[] = [
        {
          name: 'ttft-nan-test',
          metric: 'ttft',
          threshold: 500,
          windowMs: 0,
          severity: 'warning',
        },
        {
          name: 'error-rate-nan-test',
          metric: 'error_rate',
          threshold: 0.1,
          windowMs: 60000,
          severity: 'critical',
        },
        {
          name: 'throughput-nan-test',
          metric: 'throughput',
          threshold: 100,
          windowMs: 0,
          severity: 'warning',
        },
      ];

      slos.forEach((slo) => {
        evaluator.registerSlo(slo);
        const result = evaluator.evaluateSlo(slo.name);

        expect(result).toBeDefined();
        expect(Number.isNaN(result?.currentValue)).toBe(false);
      });
    });

    it('should never produce Infinity in evaluation results', () => {
      const slos: SloConfig[] = [
        {
          name: 'throughput-inf-test',
          metric: 'throughput',
          threshold: 1000,
          windowMs: 0, // Could cause Infinity without fix
          severity: 'critical',
        },
      ];

      slos.forEach((slo) => {
        evaluator.registerSlo(slo);

        // Add samples
        const now = Date.now();
        evaluator.recordSample(slo.name, {
          timestamp: now,
          value: 100,
          metadata: {},
        });

        const result = evaluator.evaluateSlo(slo.name);

        expect(result).toBeDefined();
        expect(Number.isFinite(result?.currentValue)).toBe(true);
        expect(result?.currentValue).not.toBe(Infinity);
      });
    });
  });

  describe('Multiple SLO Evaluation', () => {
    it('should evaluate multiple SLOs without corruption', () => {
      const slos: SloConfig[] = [
        {
          name: 'ttft-multi',
          metric: 'ttft',
          threshold: 500,
          windowMs: 60000,
          severity: 'warning',
        },
        {
          name: 'error-rate-multi',
          metric: 'error_rate',
          threshold: 0.05,
          windowMs: 60000,
          severity: 'critical',
        },
        {
          name: 'throughput-multi',
          metric: 'throughput',
          threshold: 100,
          windowMs: 60000,
          severity: 'warning',
        },
      ];

      slos.forEach((slo) => evaluator.registerSlo(slo));

      // Add samples to each SLO
      const now = Date.now();
      evaluator.recordSample('ttft-multi', {
        timestamp: now,
        value: 300,
        metadata: {},
      });
      evaluator.recordSample('error-rate-multi', {
        timestamp: now,
        value: 0,
        metadata: {},
      });
      evaluator.recordSample('throughput-multi', {
        timestamp: now,
        value: 1,
        metadata: {},
      });

      // Evaluate all SLOs
      const results = slos.map((slo) => evaluator.evaluateSlo(slo.name));

      // All results should be valid
      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(Number.isNaN(result?.currentValue)).toBe(false);
        expect(Number.isFinite(result?.currentValue)).toBe(true);
      });
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle burst traffic with no errors', () => {
      const slo: SloConfig = {
        name: 'burst-traffic',
        metric: 'error_rate',
        threshold: 0.01,
        windowMs: 60000,
        severity: 'critical',
      };

      evaluator.registerSlo(slo);

      const now = Date.now();
      // Simulate 1000 successful requests in quick succession
      for (let i = 0; i < 1000; i++) {
        evaluator.recordSample('burst-traffic', {
          timestamp: now - i,
          value: 0, // All successful
          metadata: {},
        });
      }

      const result = evaluator.evaluateSlo(slo.name);

      expect(result?.currentValue).toBe(0);
      expect(result?.violated).toBe(false);
    });

    it('should handle gradual degradation', () => {
      const slo: SloConfig = {
        name: 'gradual-degradation',
        metric: 'error_rate',
        threshold: 0.05,
        windowMs: 60000,
        severity: 'warning',
      };

      evaluator.registerSlo(slo);

      const now = Date.now();
      // Simulate gradual increase in errors: 0%, 2%, 4%, 6%
      const batches = [
        { errors: 0, successes: 100 },
        { errors: 2, successes: 98 },
        { errors: 4, successes: 96 },
        { errors: 6, successes: 94 },
      ];

      batches.forEach((batch, batchIdx) => {
        for (let i = 0; i < batch.errors; i++) {
          evaluator.recordSample('gradual-degradation', {
            timestamp: now - batchIdx * 1000 - i,
            value: 1, // Error
            metadata: {},
          });
        }
        for (let i = 0; i < batch.successes; i++) {
          evaluator.recordSample('gradual-degradation', {
            timestamp: now - batchIdx * 1000 - i,
            value: 0, // Success
            metadata: {},
          });
        }
      });

      const result = evaluator.evaluateSlo(slo.name);

      // Overall error rate: (0 + 2 + 4 + 6) / 400 = 12 / 400 = 0.03
      expect(result?.currentValue).toBeCloseTo(0.03, 2);
      expect(result?.violated).toBe(false); // 0.03 < 0.05
    });
  });
});
