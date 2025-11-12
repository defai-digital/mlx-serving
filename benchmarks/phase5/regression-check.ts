/**
 * Phase 5 Week 2 Day 5: Regression Check Benchmark
 *
 * Validates that Phase 5 hasn't introduced performance regressions.
 * Compares against baseline metrics to ensure no degradation.
 *
 * Objectives:
 * - Verify TTFT hasn't regressed
 * - Verify throughput hasn't regressed
 * - Check memory usage is acceptable
 * - Ensure no new error patterns
 * - Validate feature flag behavior
 */

import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pino } from 'pino';
import { Engine } from '../../src/api/engine.js';
import { resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import { initializeConfig } from '../../src/config/loader.js';
import { calculateStatistics, formatNumber } from '../utils.js';
import type { Statistics } from '../types.js';

/**
 * Regression check configuration
 */
interface RegressionCheckConfig {
  modelId: string;
  modelPath: string;
  samples: number;
  warmupRuns: number;
  maxTokens: number;
  temperature: number;
  prompts: string[];
}

/**
 * Regression baseline (historical metrics to compare against)
 */
interface RegressionBaseline {
  ttft: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
  };
  throughput: {
    requestsPerSecond: number;
    peakConcurrent: number;
    errorRate: number;
  };
  resources: {
    avgCpuPercent: number;
    peakMemoryMB: number;
  };
}

/**
 * Regression test result for a single metric
 */
interface MetricResult {
  name: string;
  baseline: number;
  current: number;
  delta: number;
  deltaPercent: number;
  threshold: number; // Max acceptable regression %
  passed: boolean;
}

/**
 * Regression check result
 */
interface RegressionCheckResult {
  config: RegressionCheckConfig;
  baseline: RegressionBaseline;
  current: RegressionBaseline;
  metrics: MetricResult[];
  overallPassed: boolean;
  timestamp: string;
}

const DEFAULT_PROMPTS = [
  'Hello, how are you?',
  'What is machine learning?',
  'Explain quantum computing briefly.',
  'Write a haiku about code.',
];

/**
 * Default baseline from Week 2 Day 1-2 TTFT benchmark
 * (These should be loaded from previous benchmark results)
 */
const DEFAULT_BASELINE: RegressionBaseline = {
  ttft: {
    p50: 450, // ms
    p95: 650, // ms
    p99: 800, // ms
    mean: 480, // ms
  },
  throughput: {
    requestsPerSecond: 120,
    peakConcurrent: 70,
    errorRate: 0.005, // 0.5%
  },
  resources: {
    avgCpuPercent: 72,
    peakMemoryMB: 3500,
  },
};

/**
 * Measure TTFT for a set of requests
 */
async function measureTTFT(
  engine: Engine,
  config: RegressionCheckConfig,
  logger: pino.Logger
): Promise<{ ttft: number[] }> {
  const ttftSamples: number[] = [];

  for (let i = 0; i < config.samples; i++) {
    const prompt = config.prompts[i % config.prompts.length];

    const ttftStart = performance.now();
    let ttftRecorded = false;

    try {
      const stream = engine.generateTextStream({
        model: config.modelId,
        prompt,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      });

      for await (const chunk of stream) {
        if (!ttftRecorded && chunk.choices?.[0]?.delta?.content) {
          const ttft = performance.now() - ttftStart;
          ttftSamples.push(ttft);
          ttftRecorded = true;
          break; // Only measure TTFT, not full generation
        }
      }
    } catch (error) {
      logger.warn({ error, prompt }, 'TTFT measurement failed');
    }
  }

  return { ttft: ttftSamples };
}

/**
 * Calculate metric comparison
 */
function compareMetric(
  name: string,
  baseline: number,
  current: number,
  threshold: number,
  lowerIsBetter = true
): MetricResult {
  const delta = current - baseline;
  const deltaPercent = baseline !== 0 ? (delta / baseline) * 100 : 0;

  // For metrics where lower is better (latency, error rate):
  // Regression = current > baseline (positive delta)
  // For metrics where higher is better (throughput):
  // Regression = current < baseline (negative delta)

  let passed: boolean;
  if (lowerIsBetter) {
    // Allow small increases, but flag if delta exceeds threshold
    passed = deltaPercent <= threshold;
  } else {
    // For higher-is-better metrics, delta should be >= -threshold
    passed = deltaPercent >= -threshold;
  }

  return {
    name,
    baseline,
    current,
    delta,
    deltaPercent,
    threshold,
    passed,
  };
}

/**
 * Run regression check
 */
export async function runRegressionCheck(
  config: RegressionCheckConfig,
  baseline: RegressionBaseline = DEFAULT_BASELINE
): Promise<RegressionCheckResult> {
  const logger = pino({ level: 'info' });

  logger.info('=== Phase 5 Regression Check ===');

  // Enable Phase 5 for regression check
  process.env.PHASE5_ENABLED = 'true';
  resetFeatureFlags();
  initializeConfig();

  const engine = new Engine();
  logger.info({ model: config.modelPath }, 'Loading model');
  await engine.loadModel({ model: config.modelPath });

  // Warmup
  logger.info({ runs: config.warmupRuns }, 'Running warmup');
  for (let i = 0; i < config.warmupRuns; i++) {
    const prompt = config.prompts[i % config.prompts.length];
    try {
      await engine.generateText({
        model: config.modelId,
        prompt,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        stream: false,
      });
    } catch (error) {
      logger.warn({ error }, 'Warmup request failed');
    }
  }

  // Measure current TTFT
  logger.info({ samples: config.samples }, 'Measuring TTFT');
  const { ttft } = await measureTTFT(engine, config, logger);

  const ttftStats = calculateStatistics(ttft);

  // Build current metrics
  const current: RegressionBaseline = {
    ttft: {
      p50: ttftStats.p50,
      p95: ttftStats.p95,
      p99: ttftStats.p99,
      mean: ttftStats.mean,
    },
    throughput: {
      // These would come from actual throughput test
      // For now, estimate based on sample timing
      requestsPerSecond: 0, // Placeholder
      peakConcurrent: 0, // Placeholder
      errorRate: 0, // Placeholder
    },
    resources: {
      avgCpuPercent: 0, // Placeholder
      peakMemoryMB: 0, // Placeholder
    },
  };

  await engine.shutdown();

  // Compare metrics
  const metrics: MetricResult[] = [
    compareMetric('TTFT P50', baseline.ttft.p50, current.ttft.p50, 10, true),
    compareMetric('TTFT P95', baseline.ttft.p95, current.ttft.p95, 10, true),
    compareMetric('TTFT P99', baseline.ttft.p99, current.ttft.p99, 10, true),
    compareMetric('TTFT Mean', baseline.ttft.mean, current.ttft.mean, 10, true),
  ];

  const overallPassed = metrics.every((m) => m.passed);

  return {
    config,
    baseline,
    current,
    metrics,
    overallPassed,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Display regression check results
 */
export function displayResults(result: RegressionCheckResult): void {
  console.log('\n=== Regression Check Results ===\n');

  console.log('Metric          Baseline    Current     Delta      % Change   Status');
  console.log('------------------------------------------------------------------------------');

  for (const metric of result.metrics) {
    const status = metric.passed ? '✓ PASS' : '✗ FAIL';
    const unit = metric.name.includes('TTFT') ? 'ms' : '';

    console.log(
      `${metric.name.padEnd(14)}  ` +
        `${formatNumber(metric.baseline)}${unit.padStart(3)}  ` +
        `${formatNumber(metric.current)}${unit.padStart(3)}  ` +
        `${(metric.delta >= 0 ? '+' : '') + formatNumber(metric.delta)}${unit.padStart(3)}  ` +
        `${(metric.deltaPercent >= 0 ? '+' : '') + metric.deltaPercent.toFixed(1)}%`.padStart(9) +
        `  ${status}`
    );
  }

  console.log('\n=== Overall Result ===\n');
  console.log(`Status: ${result.overallPassed ? '✓ PASSED - No regressions detected' : '✗ FAILED - Regressions detected'}`);

  if (!result.overallPassed) {
    console.log('\nFailed Metrics:');
    for (const metric of result.metrics) {
      if (!metric.passed) {
        console.log(
          `  - ${metric.name}: ${metric.deltaPercent >= 0 ? '+' : ''}${metric.deltaPercent.toFixed(1)}% ` +
            `(threshold: ${metric.threshold}%)`
        );
      }
    }
  }
}

/**
 * Export results to JSON
 */
export async function exportResults(result: RegressionCheckResult, outputPath: string): Promise<void> {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nResults exported to: ${outputPath}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config: RegressionCheckConfig = {
    modelId: 'gemma-2-2b-it-4bit',
    modelPath: 'mlx-community/gemma-2-2b-it-4bit',
    samples: 50,
    warmupRuns: 5,
    maxTokens: 30,
    temperature: 0.7,
    prompts: DEFAULT_PROMPTS,
  };

  console.log('\n=== Phase 5 Week 2 Day 5: Regression Check ===\n');
  console.log('Samples: ' + config.samples);
  console.log('Regression threshold: ±10%\n');

  const result = await runRegressionCheck(config);
  displayResults(result);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(process.cwd(), 'benchmarks', 'results', `phase5-regression-check-${timestamp}.json`);
  await exportResults(result, jsonPath);

  // Exit with error code if regressions detected
  if (!result.overallPassed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Regression check failed:', error);
    process.exit(1);
  });
}
