/**
 * Metrics Collector - Collects and analyzes performance metrics
 *
 * Tracks:
 * - Latency distribution (p50, p95, p99, p99.9)
 * - Throughput (requests/sec)
 * - Error rates
 * - System resource usage
 */

export interface LatencyHistogram {
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
}

export interface MetricsSnapshot {
  latencies: number[];
  errors: number;
  throughput: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

export class MetricsCollector {
  private latencies: number[] = [];
  private errors: number = 0;
  private startTime: number = 0;

  /**
   * Start collecting metrics
   */
  start(): void {
    this.latencies = [];
    this.errors = 0;
    this.startTime = Date.now();
  }

  /**
   * Record successful request latency
   */
  recordLatency(durationMs: number): void {
    this.latencies.push(durationMs);
  }

  /**
   * Record failed request
   */
  recordError(): void {
    this.errors++;
  }

  /**
   * Get current snapshot of metrics
   */
  getSnapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const totalRequests = this.latencies.length + this.errors;
    const durationSec = (Date.now() - this.startTime) / 1000;

    return {
      latencies: this.latencies,
      errors: this.errors,
      throughput: totalRequests / durationSec,
      errorRate: this.errors / totalRequests,
      p50: this.percentile(sorted, 0.50),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
      p999: this.percentile(sorted, 0.999),
    };
  }

  /**
   * Get latency histogram
   */
  getHistogram(): LatencyHistogram {
    const buckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const counts = new Array(buckets.length).fill(0);

    for (const latency of this.latencies) {
      for (let i = 0; i < buckets.length; i++) {
        if (latency <= buckets[i]) {
          counts[i]++;
          break;
        }
      }
    }

    return {
      buckets: buckets.map((le, i) => ({ le, count: counts[i] })),
      sum: this.latencies.reduce((a, b) => a + b, 0),
      count: this.latencies.length,
    };
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.latencies = [];
    this.errors = 0;
    this.startTime = Date.now();
  }
}
