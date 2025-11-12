/**
 * Phase 5 Week 2 Day 3-4: Throughput Benchmark
 *
 * 10-minute sustained load test measuring throughput under production conditions.
 * Compares baseline vs Phase 5 optimizations with real-time metrics.
 *
 * Targets:
 * - Sustained throughput ≥ 130 req/s
 * - Peak concurrency ≥ 75 concurrent streams
 * - CPU utilization < 80%
 * - Error rate < 1%
 */

import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { pino } from 'pino';
import { Engine } from '../../src/api/engine.js';
import { calculateStatistics, formatNumber, formatDuration } from '../utils.js';
import type { Statistics } from '../types.js';
import { resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import { initializeConfig } from '../../src/config/loader.js';

/**
 * Throughput benchmark configuration
 */
interface ThroughputBenchmarkConfig {
  modelId: string;
  modelPath: string;
  durationMs: number;
  targetRequestsPerSecond: number;
  maxConcurrent: number;
  warmupDurationMs: number;
  maxTokens: number;
  temperature: number;
  prompts: string[];
}

/**
 * Real-time throughput metrics
 */
interface ThroughputMetrics {
  timestamp: number;
  requestsPerSecond: {
    actual: number;
    target: number;
    deviation: number;
  };
  tokenThroughput: {
    tokensPerSecond: number;
    totalTokens: number;
  };
  concurrency: {
    current: number;
    peak: number;
    average: number;
  };
  latencyMs: number[];
  errors: {
    count: number;
    types: Record<string, number>;
  };
  resources: {
    cpuPercent: number;
    memoryMB: number;
    totalMemoryMB: number;
  };
}

/**
 * Request result
 */
interface RequestResult {
  success: boolean;
  latencyMs: number;
  tokens: number;
  error?: string;
}

/**
 * Phase throughput result
 */
interface PhaseThroughputResult {
  metrics: ThroughputMetrics[];
  summary: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgRequestsPerSecond: number;
    avgTokensPerSecond: number;
    peakConcurrent: number;
    avgConcurrent: number;
    latency: Statistics;
    errorRate: number;
    avgCpuPercent: number;
    avgMemoryMB: number;
    durationMs: number;
  };
}

/**
 * Full benchmark result
 */
interface BenchmarkResult {
  timestamp: string;
  config: ThroughputBenchmarkConfig;
  systemInfo: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpus: number;
    totalMemoryMB: number;
  };
  baseline: PhaseThroughputResult;
  phase5: PhaseThroughputResult;
  comparison: {
    requestsPerSecondImprovement: number;
    tokenThroughputImprovement: number;
    concurrencyImprovement: number;
    latencyImprovement: number;
    errorRateImprovement: number;
  };
  targetsMet: {
    throughput: boolean; // ≥ 130 req/s
    concurrency: boolean; // ≥ 75 concurrent
    cpu: boolean; // < 80%
    errorRate: boolean; // < 1%
  };
}

/**
 * Default test prompts
 */
const DEFAULT_PROMPTS = [
  'Hello, how are you?',
  'What is machine learning?',
  'Explain quantum computing briefly.',
  'Write a haiku about code.',
  'What are the benefits of TypeScript?',
  'How does async/await work?',
  'Explain REST API design.',
  'What is functional programming?',
];

/**
 * Get current resource metrics
 */
function getResourceMetrics(): { cpuPercent: number; memoryMB: number; totalMemoryMB: number } {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();

  return {
    cpuPercent: ((cpuUsage.user + cpuUsage.system) / 1000000) / os.cpus().length,
    memoryMB: memoryUsage.heapUsed / 1024 / 1024,
    totalMemoryMB: os.totalmem() / 1024 / 1024,
  };
}

/**
 * Send a single request and measure metrics
 */
async function sendRequest(
  engine: Engine,
  modelId: string,
  prompt: string,
  maxTokens: number,
  temperature: number
): Promise<RequestResult> {
  const startTime = performance.now();
  let tokens = 0;

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
        tokens++;
      }
    }

    return {
      success: true,
      latencyMs: performance.now() - startTime,
      tokens,
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: performance.now() - startTime,
      tokens: 0,
      error: String(error),
    };
  }
}

/**
 * Run warmup phase
 */
async function runWarmup(
  engine: Engine,
  modelId: string,
  prompts: string[],
  durationMs: number,
  maxTokens: number,
  temperature: number,
  logger: pino.Logger
): Promise<void> {
  logger.info(`Running warmup for ${durationMs}ms...`);

  const startTime = Date.now();
  let requestCount = 0;

  while (Date.now() - startTime < durationMs) {
    const prompt = prompts[requestCount % prompts.length];
    await sendRequest(engine, modelId, prompt, maxTokens, temperature);
    requestCount++;
  }

  logger.info(`Warmup complete: ${requestCount} requests in ${durationMs}ms`);
}

/**
 * Format progress bar
 */
function formatProgressBar(current: number, total: number, width = 40): string {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${percentage}%`;
}

/**
 * Display real-time stats
 */
function displayLiveStats(
  elapsedMs: number,
  durationMs: number,
  currentMetrics: ThroughputMetrics
): void {
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
  const totalMin = Math.floor(durationMs / 60000);
  const totalSec = Math.floor((durationMs % 60000) / 1000);

  const progress = formatProgressBar(elapsedMs, durationMs);

  console.log(`\n${progress} (${elapsedMin}:${String(elapsedSec).padStart(2, '0')} / ${totalMin}:${String(totalSec).padStart(2, '0')})\n`);
  console.log(`Requests/sec:   ${formatNumber(currentMetrics.requestsPerSecond.actual, 1)} / ${currentMetrics.requestsPerSecond.target} (target)   ${currentMetrics.requestsPerSecond.actual >= currentMetrics.requestsPerSecond.target * 0.9 ? '✓' : '✗'}`);
  console.log(`Concurrent:     ${currentMetrics.concurrency.current} (peak: ${currentMetrics.concurrency.peak}, avg: ${formatNumber(currentMetrics.concurrency.average, 1)})   ${currentMetrics.concurrency.peak >= 75 ? '✓' : '✗'}`);
  console.log(`Token/sec:      ${formatNumber(currentMetrics.tokenThroughput.tokensPerSecond, 1)}`);

  if (currentMetrics.latencyMs.length > 0) {
    const latencyStats = calculateStatistics(currentMetrics.latencyMs);
    console.log(`Latency P95:    ${formatNumber(latencyStats.p95, 1)} ms`);
  }

  console.log(`Errors:         ${formatNumber((currentMetrics.errors.count / (currentMetrics.tokenThroughput.totalTokens || 1)) * 100, 1)}% (${currentMetrics.errors.count})`);
  console.log(`CPU:            ${formatNumber(currentMetrics.resources.cpuPercent, 1)}%   ${currentMetrics.resources.cpuPercent < 80 ? '✓' : '✗'}`);
  console.log(`Memory:         ${formatNumber(currentMetrics.resources.memoryMB, 0)} MB`);
}

/**
 * Run throughput benchmark phase
 */
async function runThroughputPhase(
  config: ThroughputBenchmarkConfig,
  phaseEnabled: boolean,
  logger: pino.Logger
): Promise<PhaseThroughputResult> {
  // Configure feature flags
  process.env.PHASE5_ENABLED = phaseEnabled ? 'true' : 'false';
  resetFeatureFlags();
  initializeConfig();

  const engine = new Engine({}, { logger });

  try {
    // Load model
    await engine.loadModel({ model: config.modelPath });
    logger.info(`Model loaded: ${config.modelId}`);

    // Warmup
    await runWarmup(
      engine,
      config.modelId,
      config.prompts,
      config.warmupDurationMs,
      config.maxTokens,
      config.temperature,
      logger
    );

    // Main benchmark
    logger.info(`Starting ${config.durationMs}ms throughput test...`);

    const startTime = Date.now();
    const endTime = startTime + config.durationMs;

    const allMetrics: ThroughputMetrics[] = [];
    const allLatencies: number[] = [];

    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalTokens = 0;
    let concurrentRequests = 0;
    let peakConcurrent = 0;
    const concurrentSamples: number[] = [];
    const errorTypes: Record<string, number> = {};

    // Metrics collection interval (every second)
    let lastMetricTime = startTime;
    let requestsInLastSecond = 0;
    let tokensInLastSecond = 0;
    let latenciesInLastSecond: number[] = [];

    // Request launcher
    const intervalMs = 1000 / config.targetRequestsPerSecond;
    let lastRequestTime = startTime;

    const pendingRequests: Promise<void>[] = [];

    while (Date.now() < endTime) {
      const now = Date.now();

      // Launch requests at target rate
      if (now - lastRequestTime >= intervalMs && concurrentRequests < config.maxConcurrent) {
        const prompt = config.prompts[totalRequests % config.prompts.length];

        concurrentRequests++;
        peakConcurrent = Math.max(peakConcurrent, concurrentRequests);

        const requestPromise = sendRequest(
          engine,
          config.modelId,
          prompt,
          config.maxTokens,
          config.temperature
        ).then((result) => {
          concurrentRequests--;
          totalRequests++;

          if (result.success) {
            successfulRequests++;
            totalTokens += result.tokens;
            tokensInLastSecond += result.tokens;
          } else {
            failedRequests++;
            const errorType = result.error || 'unknown';
            errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
          }

          allLatencies.push(result.latencyMs);
          latenciesInLastSecond.push(result.latencyMs);
          requestsInLastSecond++;
        });

        pendingRequests.push(requestPromise);
        lastRequestTime = now;
      }

      // Collect metrics every second
      if (now - lastMetricTime >= 1000) {
        const elapsed = now - startTime;
        const resources = getResourceMetrics();

        concurrentSamples.push(concurrentRequests);

        const currentMetrics: ThroughputMetrics = {
          timestamp: now,
          requestsPerSecond: {
            actual: requestsInLastSecond,
            target: config.targetRequestsPerSecond,
            deviation: requestsInLastSecond - config.targetRequestsPerSecond,
          },
          tokenThroughput: {
            tokensPerSecond: tokensInLastSecond,
            totalTokens,
          },
          concurrency: {
            current: concurrentRequests,
            peak: peakConcurrent,
            average: concurrentSamples.reduce((a, b) => a + b, 0) / concurrentSamples.length,
          },
          latencyMs: [...latenciesInLastSecond],
          errors: {
            count: failedRequests,
            types: { ...errorTypes },
          },
          resources,
        };

        allMetrics.push(currentMetrics);

        // Display live stats every 5 seconds
        if (elapsed % 5000 < 1000) {
          displayLiveStats(elapsed, config.durationMs, currentMetrics);
        }

        // Reset counters
        requestsInLastSecond = 0;
        tokensInLastSecond = 0;
        latenciesInLastSecond = [];
        lastMetricTime = now;
      }

      // Small delay to prevent busy loop
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    // Wait for remaining requests
    logger.info('Waiting for pending requests...');
    await Promise.all(pendingRequests);

    const durationMs = Date.now() - startTime;

    // Calculate summary
    const avgRequestsPerSecond = (totalRequests / durationMs) * 1000;
    const avgTokensPerSecond = (totalTokens / durationMs) * 1000;
    const avgConcurrent = concurrentSamples.reduce((a, b) => a + b, 0) / concurrentSamples.length;
    const latencyStats = calculateStatistics(allLatencies);
    const errorRate = (failedRequests / totalRequests) * 100;

    const cpuSamples = allMetrics.map(m => m.resources.cpuPercent);
    const avgCpuPercent = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;

    const memorySamples = allMetrics.map(m => m.resources.memoryMB);
    const avgMemoryMB = memorySamples.reduce((a, b) => a + b, 0) / memorySamples.length;

    return {
      metrics: allMetrics,
      summary: {
        totalRequests,
        successfulRequests,
        failedRequests,
        avgRequestsPerSecond,
        avgTokensPerSecond,
        peakConcurrent,
        avgConcurrent,
        latency: latencyStats,
        errorRate,
        avgCpuPercent,
        avgMemoryMB,
        durationMs,
      },
    };
  } finally {
    await engine.shutdown();
  }
}

/**
 * Run complete throughput benchmark
 */
export async function runThroughputBenchmark(
  config: ThroughputBenchmarkConfig
): Promise<BenchmarkResult> {
  const logger = pino({ level: 'info' });

  console.log('\n=== Phase 5 Week 2: Throughput Benchmark ===\n');
  console.log(`Model: ${config.modelId}`);
  console.log(`Duration: ${formatDuration(config.durationMs)}`);
  console.log(`Target: ${config.targetRequestsPerSecond} req/s`);
  console.log(`Max concurrent: ${config.maxConcurrent}`);
  console.log(`Warmup: ${formatDuration(config.warmupDurationMs)}`);
  console.log('');

  // Phase 1: Baseline
  console.log('=== Phase 1: Baseline (Phase 5 DISABLED) ===\n');
  const baseline = await runThroughputPhase(config, false, logger);

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Phase 2: Phase 5
  console.log('\n=== Phase 2: Phase 5 (ENABLED) ===\n');
  const phase5 = await runThroughputPhase(config, true, logger);

  // Compare results
  const comparison = {
    requestsPerSecondImprovement: ((phase5.summary.avgRequestsPerSecond - baseline.summary.avgRequestsPerSecond) / baseline.summary.avgRequestsPerSecond) * 100,
    tokenThroughputImprovement: ((phase5.summary.avgTokensPerSecond - baseline.summary.avgTokensPerSecond) / baseline.summary.avgTokensPerSecond) * 100,
    concurrencyImprovement: ((phase5.summary.peakConcurrent - baseline.summary.peakConcurrent) / baseline.summary.peakConcurrent) * 100,
    latencyImprovement: ((baseline.summary.latency.p95 - phase5.summary.latency.p95) / baseline.summary.latency.p95) * 100,
    errorRateImprovement: baseline.summary.errorRate - phase5.summary.errorRate,
  };

  const targetsMet = {
    throughput: phase5.summary.avgRequestsPerSecond >= 130,
    concurrency: phase5.summary.peakConcurrent >= 75,
    cpu: phase5.summary.avgCpuPercent < 80,
    errorRate: phase5.summary.errorRate < 1,
  };

  return {
    timestamp: new Date().toISOString(),
    config,
    systemInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMB: os.totalmem() / 1024 / 1024,
    },
    baseline,
    phase5,
    comparison,
    targetsMet,
  };
}

/**
 * Display benchmark results
 */
export function displayResults(result: BenchmarkResult): void {
  console.log('\n=== Throughput Benchmark Results ===\n');

  console.log('Phase        Req/s     Peak Conc  P95 Lat   Error%    CPU%      Memory');
  console.log('-'.repeat(90));

  const baselineRow = [
    'Baseline'.padEnd(12),
    formatNumber(result.baseline.summary.avgRequestsPerSecond, 1, 9),
    String(result.baseline.summary.peakConcurrent).padStart(9),
    formatNumber(result.baseline.summary.latency.p95, 1, 9),
    formatNumber(result.baseline.summary.errorRate, 2, 9),
    formatNumber(result.baseline.summary.avgCpuPercent, 1, 9),
    formatNumber(result.baseline.summary.avgMemoryMB, 0, 9) + ' MB',
  ];

  const phase5Row = [
    'Phase 5'.padEnd(12),
    formatNumber(result.phase5.summary.avgRequestsPerSecond, 1, 9),
    String(result.phase5.summary.peakConcurrent).padStart(9),
    formatNumber(result.phase5.summary.latency.p95, 1, 9),
    formatNumber(result.phase5.summary.errorRate, 2, 9),
    formatNumber(result.phase5.summary.avgCpuPercent, 1, 9),
    formatNumber(result.phase5.summary.avgMemoryMB, 0, 9) + ' MB',
  ];

  console.log(baselineRow.join(' '));
  console.log(phase5Row.join(' '));

  console.log('\n=== Improvements ===\n');
  console.log(`Throughput:   ${result.comparison.requestsPerSecondImprovement >= 0 ? '+' : ''}${formatNumber(result.comparison.requestsPerSecondImprovement, 1)}%`);
  console.log(`Concurrency:  ${result.comparison.concurrencyImprovement >= 0 ? '+' : ''}${formatNumber(result.comparison.concurrencyImprovement, 1)}%`);
  console.log(`Latency P95:  ${result.comparison.latencyImprovement >= 0 ? '-' : '+'}${formatNumber(Math.abs(result.comparison.latencyImprovement), 1)}%`);
  console.log(`Error Rate:   ${result.comparison.errorRateImprovement >= 0 ? '-' : '+'}${formatNumber(Math.abs(result.comparison.errorRateImprovement), 2)}%`);

  console.log('\n=== Targets ===\n');
  console.log(`Throughput ≥ 130 req/s:  ${result.targetsMet.throughput ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(result.phase5.summary.avgRequestsPerSecond, 1)} req/s)`);
  console.log(`Concurrency ≥ 75:       ${result.targetsMet.concurrency ? '✅ PASSED' : '❌ FAILED'} (${result.phase5.summary.peakConcurrent} peak)`);
  console.log(`CPU < 80%:               ${result.targetsMet.cpu ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(result.phase5.summary.avgCpuPercent, 1)}%)`);
  console.log(`Error rate < 1%:         ${result.targetsMet.errorRate ? '✅ PASSED' : '❌ FAILED'} (${formatNumber(result.phase5.summary.errorRate, 2)}%)`);
}

/**
 * Export results
 */
export async function exportResults(result: BenchmarkResult, outputPath: string): Promise<void> {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nResults exported to: ${outputPath}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config: ThroughputBenchmarkConfig = {
    modelId: 'gemma-2-27b-it-4bit',
    modelPath: 'mlx-community/gemma-2-27b-it-4bit',
    durationMs: 600000, // 10 minutes
    targetRequestsPerSecond: 130,
    maxConcurrent: 100,
    warmupDurationMs: 30000, // 30 seconds
    maxTokens: 50,
    temperature: 0.7,
    prompts: DEFAULT_PROMPTS,
  };

  const result = await runThroughputBenchmark(config);
  displayResults(result);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(process.cwd(), 'benchmarks', 'results', `phase5-throughput-${timestamp}.json`);
  await exportResults(result, jsonPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Benchmark failed:', error);
    process.exit(1);
  });
}
