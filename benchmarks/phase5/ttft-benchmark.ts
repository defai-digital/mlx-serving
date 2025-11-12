/**
 * Phase 5 Week 2 Day 1-2: TTFT Benchmark
 *
 * Comprehensive TTFT benchmark comparing baseline vs Phase 5 optimizations.
 * Tests feature flag controlled TTFT Pipeline with:
 * - Warmup queue for tokenizer preloading
 * - Speculative execution
 * - KV cache prefetch
 *
 * Target: TTFT P95 ≤ 550ms (stretch goal: ≤400ms)
 */

import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pino } from 'pino';
import { Engine } from '../../src/api/engine.js';
import { calculateStatistics, formatNumber, formatDuration, createProgressBar } from '../utils.js';
import type { Statistics } from '../types.js';
import { initializeFeatureFlags, resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import { initializeConfig } from '../../src/config/loader.js';

/**
 * Benchmark configuration
 */
interface BenchmarkConfig {
  modelId: string;
  modelPath: string;
  samples: number;
  warmupRuns: number;
  maxTokens: number;
  temperature: number;
  prompts: string[];
}

/**
 * TTFT measurement result
 */
interface TtftMeasurement {
  ttftMs: number;
  totalTokens: number;
  error?: string;
}

/**
 * Phase comparison result
 */
interface PhaseComparisonResult {
  baseline: {
    stats: Statistics;
    measurements: TtftMeasurement[];
    errorCount: number;
  };
  phase5: {
    stats: Statistics;
    measurements: TtftMeasurement[];
    errorCount: number;
  };
  improvement: {
    meanReduction: number;
    p50Reduction: number;
    p95Reduction: number;
    p99Reduction: number;
    percentImprovement: number;
  };
  targetsMet: {
    p95Target: boolean; // P95 ≤ 550ms
    p95Stretch: boolean; // P95 ≤ 400ms
  };
}

/**
 * Comprehensive benchmark result
 */
interface BenchmarkResult {
  timestamp: string;
  config: BenchmarkConfig;
  systemInfo: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  duration: {
    baselineMs: number;
    phase5Ms: number;
    totalMs: number;
  };
  comparison: PhaseComparisonResult;
}

/**
 * Default test prompts (varied length for realistic distribution)
 */
const DEFAULT_PROMPTS = [
  // Short prompts (10-20 tokens)
  'Hello, how are you today?',
  'What is the capital of France?',
  'Explain quantum computing.',
  'Write a haiku about programming.',

  // Medium prompts (30-50 tokens)
  'Explain the concept of machine learning in simple terms. Include examples of common applications.',
  'What are the key differences between supervised and unsupervised learning algorithms?',
  'Describe the process of photosynthesis step by step, including the role of chlorophyll.',

  // Long prompts (80-100 tokens)
  'Write a detailed explanation of how neural networks work, including the forward pass, backpropagation, and gradient descent. Explain how weights are updated during training and why deep networks are more powerful than shallow ones.',
  'Describe the history of the internet from ARPANET to modern day, including key milestones like TCP/IP, the World Wide Web, and the rise of mobile internet. Discuss the impact on society and commerce.',
];

/**
 * Measure TTFT for a single request
 */
async function measureTtft(
  engine: Engine,
  modelId: string,
  prompt: string,
  maxTokens: number,
  temperature: number
): Promise<TtftMeasurement> {
  const startTime = performance.now();
  let ttftMs = 0;
  let firstToken = false;
  let totalTokens = 0;

  try {
    const generator = engine.createGenerator({
      model: modelId,
      prompt,
      maxTokens,
      temperature,
      streaming: true,
    });

    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        if (!firstToken) {
          ttftMs = performance.now() - startTime;
          firstToken = true;
        }
        totalTokens++;
      }
    }

    if (!firstToken) {
      // No tokens generated
      return {
        ttftMs: performance.now() - startTime,
        totalTokens: 0,
        error: 'No tokens generated',
      };
    }

    return { ttftMs, totalTokens };
  } catch (error) {
    return {
      ttftMs: performance.now() - startTime,
      totalTokens: 0,
      error: String(error),
    };
  }
}

/**
 * Run TTFT benchmark for a specific configuration
 */
async function runTtftPhase(
  config: BenchmarkConfig,
  phaseEnabled: boolean,
  logger: pino.Logger
): Promise<{ measurements: TtftMeasurement[]; durationMs: number }> {
  const measurements: TtftMeasurement[] = [];
  const phaseStartTime = performance.now();

  // Configure feature flags
  if (phaseEnabled) {
    // Enable Phase 5 TTFT Pipeline
    // This would normally be done via config/feature-flags.yaml
    // For benchmark, we programmatically enable it
    process.env.PHASE5_TTFT_ENABLED = 'true';
  } else {
    process.env.PHASE5_TTFT_ENABLED = 'false';
  }

  // Reset feature flags to pick up new environment
  resetFeatureFlags();
  initializeConfig(); // Reload config

  // Create engine
  const engine = new Engine({}, { logger });

  try {
    // Load model once
    await engine.loadModel({
      model: config.modelPath,
    });

    logger.info(`Model loaded: ${config.modelId}`);

    // Warmup runs (not counted in results)
    logger.info(`Running ${config.warmupRuns} warmup runs...`);
    for (let i = 0; i < config.warmupRuns; i++) {
      const prompt = config.prompts[i % config.prompts.length];
      await measureTtft(engine, config.modelId, prompt, config.maxTokens, config.temperature);
    }

    // Actual benchmark runs
    logger.info(`Running ${config.samples} benchmark samples...`);
    for (let i = 0; i < config.samples; i++) {
      const prompt = config.prompts[i % config.prompts.length];
      const measurement = await measureTtft(
        engine,
        config.modelId,
        prompt,
        config.maxTokens,
        config.temperature
      );
      measurements.push(measurement);

      // Progress indicator every 100 samples
      if ((i + 1) % 100 === 0 || i === config.samples - 1) {
        const progress = createProgressBar(i + 1, config.samples);
        logger.info(progress);
      }

      // Small delay between requests to avoid overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await engine.shutdown();
  }

  const durationMs = performance.now() - phaseStartTime;
  return { measurements, durationMs };
}

/**
 * Calculate confidence interval for mean
 * Using t-distribution for 95% confidence
 */
function calculateConfidenceInterval(
  values: number[],
  confidenceLevel = 0.95
): { lower: number; upper: number; margin: number } {
  const n = values.length;
  const mean = values.reduce((sum, val) => sum + val, 0) / n;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (n - 1);
  const stdError = Math.sqrt(variance / n);

  // t-value for 95% confidence (approximate for large n)
  const tValue = n > 30 ? 1.96 : 2.0; // Use 1.96 for n > 30, 2.0 for smaller samples

  const margin = tValue * stdError;

  return {
    lower: mean - margin,
    upper: mean + margin,
    margin,
  };
}

/**
 * Compare baseline vs Phase 5 results
 */
function compareResults(
  baselineMeasurements: TtftMeasurement[],
  phase5Measurements: TtftMeasurement[]
): PhaseComparisonResult {
  // Filter out errors
  const baselineValid = baselineMeasurements.filter((m) => !m.error);
  const phase5Valid = phase5Measurements.filter((m) => !m.error);

  const baselineTtfts = baselineValid.map((m) => m.ttftMs);
  const phase5Ttfts = phase5Valid.map((m) => m.ttftMs);

  const baselineStats = calculateStatistics(baselineTtfts);
  const phase5Stats = calculateStatistics(phase5Ttfts);

  const improvement = {
    meanReduction: baselineStats.mean - phase5Stats.mean,
    p50Reduction: baselineStats.median - phase5Stats.median,
    p95Reduction: baselineStats.p95 - phase5Stats.p95,
    p99Reduction: baselineStats.p99 - phase5Stats.p99,
    percentImprovement: ((baselineStats.mean - phase5Stats.mean) / baselineStats.mean) * 100,
  };

  const targetsMet = {
    p95Target: phase5Stats.p95 <= 550, // Target: P95 ≤ 550ms
    p95Stretch: phase5Stats.p95 <= 400, // Stretch goal: P95 ≤ 400ms
  };

  return {
    baseline: {
      stats: baselineStats,
      measurements: baselineMeasurements,
      errorCount: baselineMeasurements.length - baselineValid.length,
    },
    phase5: {
      stats: phase5Stats,
      measurements: phase5Measurements,
      errorCount: phase5Measurements.length - phase5Valid.length,
    },
    improvement,
    targetsMet,
  };
}

/**
 * Run comprehensive TTFT benchmark
 */
export async function runPhase5TtftBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const logger = pino({ level: 'info' });
  const benchmarkStartTime = performance.now();

  console.log('\n=== Phase 5 Week 2: TTFT Benchmark ===\n');
  console.log(`Model: ${config.modelId}`);
  console.log(`Samples: ${config.samples}`);
  console.log(`Warmup: ${config.warmupRuns} runs`);
  console.log(`Max tokens: ${config.maxTokens}`);
  console.log(`Temperature: ${config.temperature}`);
  console.log(`Prompts: ${config.prompts.length} variants`);
  console.log('');

  // Phase 1: Baseline (Phase 5 disabled)
  console.log('=== Phase 1: Baseline (Phase 5 DISABLED) ===\n');
  const baselineResult = await runTtftPhase(config, false, logger);

  // Small delay between phases
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Phase 2: Phase 5 enabled (TTFT Pipeline active)
  console.log('\n=== Phase 2: Phase 5 (TTFT Pipeline ENABLED) ===\n');
  const phase5Result = await runTtftPhase(config, true, logger);

  const benchmarkTotalMs = performance.now() - benchmarkStartTime;

  // Compare results
  const comparison = compareResults(baselineResult.measurements, phase5Result.measurements);

  const result: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    config,
    systemInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    duration: {
      baselineMs: baselineResult.durationMs,
      phase5Ms: phase5Result.durationMs,
      totalMs: benchmarkTotalMs,
    },
    comparison,
  };

  return result;
}

/**
 * Format and display benchmark results
 */
export function displayResults(result: BenchmarkResult): void {
  const { comparison } = result;

  console.log('\n=== Benchmark Results ===\n');

  // Results table
  console.log('Phase           Mean      Median    P95       P99       Min       Max       StdDev    Errors');
  console.log('-'.repeat(100));

  const baselineRow = [
    'Baseline'.padEnd(15),
    formatNumber(comparison.baseline.stats.mean, 2, 9),
    formatNumber(comparison.baseline.stats.median, 2, 9),
    formatNumber(comparison.baseline.stats.p95, 2, 9),
    formatNumber(comparison.baseline.stats.p99, 2, 9),
    formatNumber(comparison.baseline.stats.min, 2, 9),
    formatNumber(comparison.baseline.stats.max, 2, 9),
    formatNumber(comparison.baseline.stats.stdDev, 2, 9),
    String(comparison.baseline.errorCount).padStart(6),
  ];

  const phase5Row = [
    'Phase 5'.padEnd(15),
    formatNumber(comparison.phase5.stats.mean, 2, 9),
    formatNumber(comparison.phase5.stats.median, 2, 9),
    formatNumber(comparison.phase5.stats.p95, 2, 9),
    formatNumber(comparison.phase5.stats.p99, 2, 9),
    formatNumber(comparison.phase5.stats.min, 2, 9),
    formatNumber(comparison.phase5.stats.max, 2, 9),
    formatNumber(comparison.phase5.stats.stdDev, 2, 9),
    String(comparison.phase5.errorCount).padStart(6),
  ];

  console.log(baselineRow.join(' '));
  console.log(phase5Row.join(' '));

  // Improvement summary
  console.log('\n=== Improvement Summary ===\n');
  console.log(`Mean TTFT:   ${formatNumber(comparison.improvement.meanReduction, 2)} ms reduction (${formatNumber(comparison.improvement.percentImprovement, 1)}% improvement)`);
  console.log(`P50 TTFT:    ${formatNumber(comparison.improvement.p50Reduction, 2)} ms reduction`);
  console.log(`P95 TTFT:    ${formatNumber(comparison.improvement.p95Reduction, 2)} ms reduction`);
  console.log(`P99 TTFT:    ${formatNumber(comparison.improvement.p99Reduction, 2)} ms reduction`);

  // Target validation
  console.log('\n=== Target Validation ===\n');
  console.log(
    `P95 Target (≤ 550ms):        ${comparison.targetsMet.p95Target ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(comparison.phase5.stats.p95, 2)} ms)`
  );
  console.log(
    `P95 Stretch Goal (≤ 400ms):  ${comparison.targetsMet.p95Stretch ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(comparison.phase5.stats.p95, 2)} ms)`
  );

  // Confidence intervals
  const baselineTtfts = comparison.baseline.measurements.filter((m) => !m.error).map((m) => m.ttftMs);
  const phase5Ttfts = comparison.phase5.measurements.filter((m) => !m.error).map((m) => m.ttftMs);

  const baselineCI = calculateConfidenceInterval(baselineTtfts);
  const phase5CI = calculateConfidenceInterval(phase5Ttfts);

  console.log('\n=== Statistical Confidence (95% CI) ===\n');
  console.log(`Baseline: ${formatNumber(baselineCI.lower, 2)} - ${formatNumber(baselineCI.upper, 2)} ms (±${formatNumber(baselineCI.margin, 2)} ms)`);
  console.log(`Phase 5:  ${formatNumber(phase5CI.lower, 2)} - ${formatNumber(phase5CI.upper, 2)} ms (±${formatNumber(phase5CI.margin, 2)} ms)`);

  // Duration
  console.log('\n=== Benchmark Duration ===\n');
  console.log(`Baseline phase: ${formatDuration(result.duration.baselineMs)}`);
  console.log(`Phase 5 phase:  ${formatDuration(result.duration.phase5Ms)}`);
  console.log(`Total duration: ${formatDuration(result.duration.totalMs)}`);
}

/**
 * Export results to JSON file
 */
export async function exportResults(result: BenchmarkResult, outputPath: string): Promise<void> {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nResults exported to: ${outputPath}`);
}

/**
 * Generate markdown report
 */
export function generateMarkdownReport(result: BenchmarkResult): string {
  const { comparison } = result;

  let report = '# Phase 5 Week 2 Day 1-2: TTFT Benchmark Report\n\n';
  report += `**Date:** ${new Date(result.timestamp).toLocaleString()}\n`;
  report += `**Model:** ${result.config.modelId}\n`;
  report += `**Samples:** ${result.config.samples}\n\n`;

  report += '---\n\n';

  report += '## Summary\n\n';
  report += `Phase 5 TTFT Pipeline achieved **${formatNumber(comparison.improvement.percentImprovement, 1)}%** mean TTFT improvement.\n\n`;

  report += '## Results Table\n\n';
  report += '| Phase | Mean (ms) | Median (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | StdDev (ms) | Errors |\n';
  report += '|-------|-----------|-------------|----------|----------|----------|----------|-------------|--------|\n';
  report += `| Baseline | ${formatNumber(comparison.baseline.stats.mean, 2)} | ${formatNumber(comparison.baseline.stats.median, 2)} | ${formatNumber(comparison.baseline.stats.p95, 2)} | ${formatNumber(comparison.baseline.stats.p99, 2)} | ${formatNumber(comparison.baseline.stats.min, 2)} | ${formatNumber(comparison.baseline.stats.max, 2)} | ${formatNumber(comparison.baseline.stats.stdDev, 2)} | ${comparison.baseline.errorCount} |\n`;
  report += `| Phase 5 | ${formatNumber(comparison.phase5.stats.mean, 2)} | ${formatNumber(comparison.phase5.stats.median, 2)} | ${formatNumber(comparison.phase5.stats.p95, 2)} | ${formatNumber(comparison.phase5.stats.p99, 2)} | ${formatNumber(comparison.phase5.stats.min, 2)} | ${formatNumber(comparison.phase5.stats.max, 2)} | ${formatNumber(comparison.phase5.stats.stdDev, 2)} | ${comparison.phase5.errorCount} |\n\n`;

  report += '## Improvement Analysis\n\n';
  report += `- **Mean TTFT:** ${formatNumber(comparison.improvement.meanReduction, 2)} ms reduction (${formatNumber(comparison.improvement.percentImprovement, 1)}% improvement)\n`;
  report += `- **P50 TTFT:** ${formatNumber(comparison.improvement.p50Reduction, 2)} ms reduction\n`;
  report += `- **P95 TTFT:** ${formatNumber(comparison.improvement.p95Reduction, 2)} ms reduction\n`;
  report += `- **P99 TTFT:** ${formatNumber(comparison.improvement.p99Reduction, 2)} ms reduction\n\n`;

  report += '## Target Validation\n\n';
  report += `- **P95 Target (≤ 550ms):** ${comparison.targetsMet.p95Target ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(comparison.phase5.stats.p95, 2)} ms)\n`;
  report += `- **P95 Stretch Goal (≤ 400ms):** ${comparison.targetsMet.p95Stretch ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(comparison.phase5.stats.p95, 2)} ms)\n\n`;

  report += '## Statistical Significance\n\n';
  const baselineTtfts = comparison.baseline.measurements.filter((m) => !m.error).map((m) => m.ttftMs);
  const phase5Ttfts = comparison.phase5.measurements.filter((m) => !m.error).map((m) => m.ttftMs);

  const baselineCI = calculateConfidenceInterval(baselineTtfts);
  const phase5CI = calculateConfidenceInterval(phase5Ttfts);

  report += '**95% Confidence Intervals:**\n\n';
  report += `- Baseline: ${formatNumber(baselineCI.lower, 2)} - ${formatNumber(baselineCI.upper, 2)} ms (±${formatNumber(baselineCI.margin, 2)} ms)\n`;
  report += `- Phase 5: ${formatNumber(phase5CI.lower, 2)} - ${formatNumber(phase5CI.upper, 2)} ms (±${formatNumber(phase5CI.margin, 2)} ms)\n\n`;

  report += '## Benchmark Duration\n\n';
  report += `- Baseline phase: ${formatDuration(result.duration.baselineMs)}\n`;
  report += `- Phase 5 phase: ${formatDuration(result.duration.phase5Ms)}\n`;
  report += `- Total duration: ${formatDuration(result.duration.totalMs)}\n\n`;

  report += '---\n\n';
  report += '**Status:** Week 2 Day 1-2 COMPLETE\n';

  return report;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Default configuration for comprehensive TTFT benchmark
  const config: BenchmarkConfig = {
    modelId: 'gemma-2-27b-it-4bit',
    modelPath: 'mlx-community/gemma-2-27b-it-4bit',
    samples: 1000, // 1000+ samples for statistical significance
    warmupRuns: 10, // 10 warmup runs per phase
    maxTokens: 50, // Generate 50 tokens to measure TTFT + initial generation
    temperature: 0.7,
    prompts: DEFAULT_PROMPTS,
  };

  // Run benchmark
  const result = await runPhase5TtftBenchmark(config);

  // Display results
  displayResults(result);

  // Export JSON results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(
    process.cwd(),
    'benchmarks',
    'results',
    `phase5-ttft-${timestamp}.json`
  );
  await exportResults(result, jsonPath);

  // Generate and save markdown report
  const markdownReport = generateMarkdownReport(result);
  const reportPath = join(
    process.cwd(),
    'automatosx',
    'tmp',
    `PHASE5-WEEK2-DAY1-2-TTFT-BENCHMARK-REPORT.md`
  );
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, markdownReport, 'utf-8');
  console.log(`\nMarkdown report saved to: ${reportPath}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });
}
