import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '@/distributed/worker/metrics-collector.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector(100); // Small window for testing
  });

  describe('initialization', () => {
    it('should start with zero metrics', () => {
      const metrics = collector.getMetrics();

      expect(metrics.requests.total).toBe(0);
      expect(metrics.requests.success).toBe(0);
      expect(metrics.requests.error).toBe(0);
      expect(metrics.latency.avg).toBe(0);
      expect(metrics.throughput.tokensPerSecond).toBe(0);
    });
  });

  describe('recordRequest()', () => {
    it('should record successful requests', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');
      collector.recordRequest(2000, 100, 'model-2');

      const metrics = collector.getMetrics();

      expect(metrics.requests.total).toBe(3);
      expect(metrics.requests.success).toBe(3);
      expect(metrics.requests.error).toBe(0);
    });

    it('should track multiple models separately', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');
      collector.recordRequest(2000, 100, 'model-2');

      const metrics = collector.getMetrics();

      expect(metrics.models['model-1']).toBeDefined();
      expect(metrics.models['model-1'].requestCount).toBe(2);
      expect(metrics.models['model-2']).toBeDefined();
      expect(metrics.models['model-2'].requestCount).toBe(1);
    });

    it('should calculate per-model average latency', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.models['model-1'].avgLatency).toBe(1250);
    });
  });

  describe('recordError()', () => {
    it('should record errors', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordError(new Error('Test error'));
      collector.recordError(new Error('Another error'));

      const metrics = collector.getMetrics();

      expect(metrics.requests.total).toBe(3);
      expect(metrics.requests.success).toBe(1);
      expect(metrics.requests.error).toBe(2);
    });

    it('should not affect latency calculations', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordError(new Error('Test error'));

      const metrics = collector.getMetrics();

      expect(metrics.latency.avg).toBe(1000);
    });
  });

  describe('getMetrics() - latency', () => {
    it('should calculate min latency', () => {
      const latencies = [1000, 1500, 2000, 2500, 3000];
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.min).toBe(1000);
    });

    it('should calculate max latency', () => {
      const latencies = [1000, 1500, 2000, 2500, 3000];
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.max).toBe(3000);
    });

    it('should calculate average latency', () => {
      const latencies = [1000, 1500, 2000, 2500, 3000];
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.avg).toBe(2000);
    });

    it('should calculate p50 latency', () => {
      const latencies = [1000, 1500, 2000, 2500, 3000];
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.p50).toBe(2000);
    });

    it('should calculate p95 latency', () => {
      const latencies = [1000, 1500, 2000, 2500, 3000];
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.p95).toBe(3000);
    });

    it('should calculate p99 latency', () => {
      const latencies = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
      for (const latency of latencies) {
        collector.recordRequest(latency, 100, 'model-1');
      }

      const metrics = collector.getMetrics();

      expect(metrics.latency.p99).toBeGreaterThan(900);
      expect(metrics.latency.p99).toBeLessThanOrEqual(1000);
    });

    it('should handle single request correctly', () => {
      collector.recordRequest(1500, 100, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.latency.min).toBe(1500);
      expect(metrics.latency.max).toBe(1500);
      expect(metrics.latency.avg).toBe(1500);
      expect(metrics.latency.p50).toBe(1500);
      expect(metrics.latency.p95).toBe(1500);
      expect(metrics.latency.p99).toBe(1500);
    });
  });

  describe('getMetrics() - throughput', () => {
    it('should calculate tokens per second', () => {
      // 100 tokens in 1 second = 100 tokens/second
      collector.recordRequest(1000, 100, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.throughput.tokensPerSecond).toBe(100);
    });

    it('should calculate tokens per second for multiple requests', () => {
      // 200 tokens in 2 seconds = 100 tokens/second
      collector.recordRequest(1000, 100, 'model-1');
      collector.recordRequest(1000, 100, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.throughput.tokensPerSecond).toBe(100);
    });

    it('should calculate requests per second', () => {
      // Add recent requests
      collector.recordRequest(1000, 100, 'model-1');
      collector.recordRequest(1000, 100, 'model-1');

      const metrics = collector.getMetrics();

      // Should be within last 60 seconds
      expect(metrics.throughput.requestsPerSecond).toBeGreaterThan(0);
    });
  });

  describe('getAverageLatency()', () => {
    it('should return average latency', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');
      collector.recordRequest(2000, 100, 'model-1');

      const avgLatency = collector.getAverageLatency();

      expect(avgLatency).toBe(1500);
    });

    it('should return 0 if no requests', () => {
      const avgLatency = collector.getAverageLatency();

      expect(avgLatency).toBe(0);
    });
  });

  describe('getThroughput()', () => {
    it('should return tokens per second', () => {
      collector.recordRequest(1000, 100, 'model-1');

      const throughput = collector.getThroughput();

      expect(throughput).toBe(100);
    });

    it('should return 0 if no requests', () => {
      const throughput = collector.getThroughput();

      expect(throughput).toBe(0);
    });
  });

  describe('getErrorRate()', () => {
    it('should calculate error rate', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordError(new Error('Error 1'));
      collector.recordError(new Error('Error 2'));

      const errorRate = collector.getErrorRate();

      expect(errorRate).toBeCloseTo(2 / 3, 2);
    });

    it('should return 0 if no requests', () => {
      const errorRate = collector.getErrorRate();

      expect(errorRate).toBe(0);
    });

    it('should return 0 if no errors', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');

      const errorRate = collector.getErrorRate();

      expect(errorRate).toBe(0);
    });

    it('should return 1 if all errors', () => {
      collector.recordError(new Error('Error 1'));
      collector.recordError(new Error('Error 2'));

      const errorRate = collector.getErrorRate();

      expect(errorRate).toBe(1);
    });
  });

  describe('reset()', () => {
    it('should reset all metrics', () => {
      collector.recordRequest(1000, 50, 'model-1');
      collector.recordRequest(1500, 75, 'model-1');
      collector.recordError(new Error('Error'));

      collector.reset();

      const metrics = collector.getMetrics();

      expect(metrics.requests.total).toBe(0);
      expect(metrics.requests.success).toBe(0);
      expect(metrics.requests.error).toBe(0);
      expect(metrics.latency.avg).toBe(0);
      expect(metrics.throughput.tokensPerSecond).toBe(0);
    });
  });

  describe('rolling window', () => {
    it('should maintain maximum number of samples', () => {
      const maxSamples = 10;
      const collector2 = new MetricsCollector(maxSamples);

      // Add more than max samples
      for (let i = 0; i < 20; i++) {
        collector2.recordRequest(1000, 100, 'model-1');
      }

      const metrics = collector2.getMetrics();

      // Total count should be 20, but calculations use last 10 samples
      expect(metrics.requests.total).toBe(20);
    });

    it('should evict old samples', () => {
      const maxSamples = 5;
      const collector2 = new MetricsCollector(maxSamples);

      // Add samples with different latencies
      collector2.recordRequest(1000, 100, 'model-1');
      collector2.recordRequest(2000, 100, 'model-1');
      collector2.recordRequest(3000, 100, 'model-1');
      collector2.recordRequest(4000, 100, 'model-1');
      collector2.recordRequest(5000, 100, 'model-1');

      // First sample (1000ms) should be in window
      let metrics = collector2.getMetrics();
      expect(metrics.latency.min).toBe(1000);

      // Add one more sample to evict first
      collector2.recordRequest(6000, 100, 'model-1');

      metrics = collector2.getMetrics();
      // Now min should be 2000ms (first sample evicted)
      expect(metrics.latency.min).toBe(2000);
    });
  });

  describe('edge cases', () => {
    it('should handle empty metrics gracefully', () => {
      const metrics = collector.getMetrics();

      expect(metrics.requests.total).toBe(0);
      expect(metrics.latency.min).toBe(0);
      expect(metrics.latency.max).toBe(0);
      expect(metrics.throughput.tokensPerSecond).toBe(0);
      expect(Object.keys(metrics.models)).toHaveLength(0);
    });

    it('should handle very large latency values', () => {
      collector.recordRequest(1000000, 100, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.latency.avg).toBe(1000000);
    });

    it('should handle zero token generation', () => {
      collector.recordRequest(1000, 0, 'model-1');

      const metrics = collector.getMetrics();

      expect(metrics.throughput.tokensPerSecond).toBe(0);
    });
  });
});
