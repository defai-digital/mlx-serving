/**
 * Benchmark Utilities
 *
 * Statistical calculations and helper functions for benchmarks.
 */

import type { Statistics } from './types.js';

/**
 * Calculate statistics from an array of numbers
 */
export function calculateStatistics(values: number[]): Statistics {
  if (values.length === 0) {
    throw new Error('Cannot calculate statistics for empty array');
  }

  // Sort for percentile calculations
  const sorted = [...values].sort((a, b) => a - b);

  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / sorted.length;

  const median = calculatePercentile(sorted, 50);
  const p95 = calculatePercentile(sorted, 95);
  const p99 = calculatePercentile(sorted, 99);

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean,
    median,
    p95,
    p99,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev,
  };
}

/**
 * Calculate percentile value from sorted array
 */
function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (percentile < 0 || percentile > 100) {
    throw new Error('Percentile must be between 0 and 100');
  }

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Format number with fixed decimals and padding
 */
export function formatNumber(value: number, decimals = 2, padding = 10): string {
  return value.toFixed(decimals).padStart(padding, ' ');
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Format duration to human-readable time
 */
export function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(2)} μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(2)} ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${(ms / 60000).toFixed(2)} min`;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Measure execution time of async function
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Run benchmark samples with warmup
 */
export async function runSamples<T>(
  fn: () => Promise<T>,
  samples: number,
  warmupRuns = 3
): Promise<{ results: T[]; durations: number[] }> {
  // Warmup
  for (let i = 0; i < warmupRuns; i++) {
    await fn();
  }

  // Actual benchmark runs
  const results: T[] = [];
  const durations: number[] = [];

  for (let i = 0; i < samples; i++) {
    const { result, durationMs } = await measureTime(fn);
    results.push(result);
    durations.push(durationMs);
  }

  return { results, durations };
}

/**
 * Get system information for benchmark context
 */
export async function getSystemInfo() {
  const os = process.platform;
  const arch = process.arch;

  // Use dynamic import for Node.js built-ins in ESM
  const osModule = await import('node:os');
  const cpus = osModule.cpus().length;
  const totalMemoryMB = Math.round(osModule.totalmem() / 1024 / 1024);

  return {
    nodeVersion: process.version,
    platform: os,
    arch,
    cpus,
    totalMemoryMB,
  };
}

/**
 * Create progress bar for console output
 */
export function createProgressBar(current: number, total: number, width = 40): string {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${percentage}% (${current}/${total})`;
}

/**
 * Format statistics as table row
 */
export function formatStatsRow(stats: Statistics): string[] {
  return [
    formatNumber(stats.mean, 2, 8),
    formatNumber(stats.median, 2, 8),
    formatNumber(stats.p95, 2, 8),
    formatNumber(stats.p99, 2, 8),
    formatNumber(stats.min, 2, 8),
    formatNumber(stats.max, 2, 8),
    formatNumber(stats.stdDev, 2, 8),
  ];
}

/**
 * Calculate compression ratio relative to baseline
 */
export function calculateCompressionRatio(size: number, baselineSize: number): number {
  return baselineSize / size;
}
