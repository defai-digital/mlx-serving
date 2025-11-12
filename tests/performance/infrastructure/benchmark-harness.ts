/**
 * Benchmark Harness - Base class for performance tests
 *
 * Provides reusable infrastructure for:
 * - Warmup logic
 * - Result collection
 * - Error handling
 * - Statistics calculation
 */

export interface BenchmarkConfig {
  workers: number;
  duration: number;
  concurrency: number;
  warmupDuration?: number;
  modelId?: string;
}

export interface BenchmarkResult {
  name: string;
  config: BenchmarkConfig;
  requestsPerSec: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latencyP999: number;
  durationMs: number;
  errorRate: number;
}

export abstract class BenchmarkHarness {
  /**
   * Benchmark name for reporting
   */
  abstract name(): string;

  /**
   * Warmup phase - prepare system before measurement
   */
  abstract warmup(config: BenchmarkConfig): Promise<void>;

  /**
   * Main benchmark execution
   */
  abstract run(config: BenchmarkConfig): Promise<BenchmarkResult>;

  /**
   * Execute full benchmark: warmup → run → analyze
   */
  async execute(config: BenchmarkConfig): Promise<BenchmarkResult> {
    console.log(`Starting benchmark: ${this.name()}`);
    console.log(`Config:`, JSON.stringify(config, null, 2));

    // Warmup phase
    const warmupDuration = config.warmupDuration || 5000; // 5s default
    if (warmupDuration > 0) {
      console.log(`Warmup (${warmupDuration}ms)...`);
      await this.warmup({ ...config, duration: warmupDuration });
    }

    // Main benchmark run
    console.log(`Running benchmark (${config.duration}ms)...`);
    const result = await this.run(config);

    // Analyze and return
    console.log(`Benchmark complete: ${result.requestsPerSec} req/sec`);
    return result;
  }

  /**
   * Calculate percentile from sorted latencies
   */
  protected percentile(sortedLatencies: number[], p: number): number {
    if (sortedLatencies.length === 0) return 0;
    const index = Math.ceil(sortedLatencies.length * p) - 1;
    return sortedLatencies[Math.max(0, index)];
  }

  /**
   * Analyze latencies and produce result
   */
  protected analyzeResults(
    name: string,
    config: BenchmarkConfig,
    latencies: number[],
    errors: number,
    durationMs: number
  ): BenchmarkResult {
    const sorted = [...latencies].sort((a, b) => a - b);
    const totalRequests = latencies.length + errors;

    return {
      name,
      config,
      requestsPerSec: (totalRequests / durationMs) * 1000,
      totalRequests,
      successfulRequests: latencies.length,
      failedRequests: errors,
      latencyP50: this.percentile(sorted, 0.50),
      latencyP95: this.percentile(sorted, 0.95),
      latencyP99: this.percentile(sorted, 0.99),
      latencyP999: this.percentile(sorted, 0.999),
      durationMs,
      errorRate: errors / totalRequests,
    };
  }
}
