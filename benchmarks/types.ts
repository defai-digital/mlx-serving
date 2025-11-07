/**
 * Benchmark Framework Types
 *
 * Common types for performance benchmarks across the kr-mlx-lm project.
 */

/**
 * Statistical metrics for benchmark results
 */
export interface Statistics {
  mean: number;
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdDev: number;
}

/**
 * Base benchmark result interface
 */
export interface BenchmarkResult {
  name: string;
  timestamp: string;
  samples: number;
  durationMs: number;
}

/**
 * IPC overhead benchmark results
 */
export interface IpcBenchmarkResult extends BenchmarkResult {
  codec: string;
  encodeStats: Statistics;
  decodeStats: Statistics;
  totalBytes: number;
  avgPayloadSizeBytes: number;
  compressionRatio?: number; // relative to JSON
}

/**
 * TTFT (Time To First Token) benchmark results
 */
export interface TtftBenchmarkResult extends BenchmarkResult {
  modelId: string;
  promptLength: number;
  coldStart: Statistics;
  warmStart: Statistics;
}

/**
 * Throughput benchmark results
 */
export interface ThroughputBenchmarkResult extends BenchmarkResult {
  modelId: string;
  tokensGenerated: number;
  tokensPerSecond: Statistics;
  avgLatencyMs: Statistics;
  streaming: boolean;
}

/**
 * Complete benchmark suite results
 */
export interface BenchmarkSuiteResult {
  timestamp: string;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpus: number;
    totalMemoryMB: number;
  };
  ipc?: IpcBenchmarkResult[];
  ttft?: TtftBenchmarkResult[];
  throughput?: ThroughputBenchmarkResult[];
}

/**
 * Benchmark configuration
 */
export interface BenchmarkConfig {
  samples?: number;
  warmupRuns?: number;
  timeout?: number;
  verbose?: boolean;
}

/**
 * Benchmark report options
 */
export interface ReportOptions {
  format: 'console' | 'json' | 'csv' | 'markdown';
  output?: string; // file path for non-console formats
  includeRaw?: boolean; // include raw sample data
}
