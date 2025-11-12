/**
 * Phase 5 Week 2 Day 5: Stress Test Benchmark
 *
 * Gradually increase load until system breaks to identify limits and failure modes.
 *
 * Objectives:
 * - Find maximum sustainable throughput
 * - Identify breaking point (req/s, concurrency, duration)
 * - Categorize failure modes (OOM, timeout, crashes)
 * - Verify graceful degradation
 * - Test resource cleanup on failure
 */

import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { pino } from 'pino';
import { Engine } from '../../src/api/engine.js';
import { resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import { initializeConfig } from '../../src/config/loader.js';

/**
 * Stress test configuration
 */
interface StressTestConfig {
  modelId: string;
  modelPath: string;
  startingRequestsPerSecond: number;
  incrementRequestsPerSecond: number;
  incrementIntervalMs: number;
  maxRequestsPerSecond: number;
  maxConcurrent: number;
  maxDurationMs: number;
  failureThreshold: number; // Error rate to consider failure
  maxTokens: number;
  temperature: number;
  prompts: string[];
}

/**
 * Stress level metrics
 */
interface StressLevelMetrics {
  level: number;
  requestsPerSecond: number;
  duration: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  peakConcurrent: number;
  avgCpuPercent: number;
  peakMemoryMB: number;
  errorTypes: Record<string, number>;
  degradationDetected: boolean;
}

/**
 * Failure classification
 */
enum FailureMode {
  OOM = 'out_of_memory',
  Timeout = 'timeout',
  HighErrorRate = 'high_error_rate',
  Crash = 'crash',
  ResourceExhaustion = 'resource_exhaustion',
  None = 'none',
}

/**
 * Stress test result
 */
interface StressTestResult {
  config: StressTestConfig;
  phaseEnabled: boolean;
  levels: StressLevelMetrics[];
  breakingPoint: {
    level: number;
    requestsPerSecond: number;
    failureMode: FailureMode;
    errorRate: number;
    lastSuccessfulLevel: number;
    lastSuccessfulRequestsPerSecond: number;
  };
  duration: number;
  timestamp: string;
}

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
 * Calculate percentile
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Run a single stress level
 */
async function runStressLevel(
  engine: Engine,
  config: StressTestConfig,
  level: number,
  requestsPerSecond: number,
  logger: pino.Logger
): Promise<StressLevelMetrics> {
  logger.info({ level, requestsPerSecond }, 'Starting stress level');

  const startTime = Date.now();
  const endTime = startTime + config.incrementIntervalMs;
  const intervalMs = 1000 / requestsPerSecond;

  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  const errorTypes: Record<string, number> = {};
  const latencies: number[] = [];
  let peakConcurrent = 0;
  const cpuSamples: number[] = [];
  const memorySamples: number[] = [];

  let concurrentRequests = 0;
  let lastRequestTime = startTime;
  const inFlightRequests: Promise<void>[] = [];

  // Main loop
  while (Date.now() < endTime) {
    const now = Date.now();

    // Launch request if target rate allows and under concurrency limit
    if (
      now - lastRequestTime >= intervalMs &&
      concurrentRequests < config.maxConcurrent
    ) {
      const prompt = config.prompts[totalRequests % config.prompts.length];

      concurrentRequests++;
      peakConcurrent = Math.max(peakConcurrent, concurrentRequests);
      totalRequests++;

      const requestStart = Date.now();
      const requestPromise = engine
        .generateText({
          model: config.modelId,
          prompt,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          stream: false,
        })
        .then(() => {
          const latency = Date.now() - requestStart;
          latencies.push(latency);
          successfulRequests++;
          concurrentRequests--;
        })
        .catch((error: Error) => {
          const errorType = error.message || 'unknown';
          errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
          failedRequests++;
          concurrentRequests--;
        });

      inFlightRequests.push(requestPromise);
      lastRequestTime = now;
    }

    // Sample resources every second
    if (now - startTime >= cpuSamples.length * 1000) {
      const resources = getResourceMetrics();
      cpuSamples.push(resources.cpuPercent);
      memorySamples.push(resources.memoryMB);
    }

    // Small delay to prevent tight loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Wait for all in-flight requests to complete or timeout
  await Promise.race([
    Promise.all(inFlightRequests),
    new Promise((resolve) => setTimeout(resolve, 30000)), // 30 second timeout
  ]);

  const duration = Date.now() - startTime;
  const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;
  const avgLatencyMs = latencies.length > 0 ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length : 0;
  const p95LatencyMs = percentile(latencies, 95);
  const p99LatencyMs = percentile(latencies, 99);
  const avgCpuPercent = cpuSamples.length > 0 ? cpuSamples.reduce((sum, c) => sum + c, 0) / cpuSamples.length : 0;
  const peakMemoryMB = memorySamples.length > 0 ? Math.max(...memorySamples) : 0;

  // Detect degradation (latency spike or error rate increase)
  const degradationDetected = errorRate > 0.05 || p95LatencyMs > 2000;

  return {
    level,
    requestsPerSecond,
    duration,
    totalRequests,
    successfulRequests,
    failedRequests,
    errorRate,
    avgLatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    peakConcurrent,
    avgCpuPercent,
    peakMemoryMB,
    errorTypes,
    degradationDetected,
  };
}

/**
 * Classify failure mode
 */
function classifyFailureMode(
  metrics: StressLevelMetrics,
  resources: { memoryMB: number; totalMemoryMB: number }
): FailureMode {
  // Check for OOM (memory usage > 90% of total)
  if (resources.memoryMB / resources.totalMemoryMB > 0.9) {
    return FailureMode.OOM;
  }

  // Check for high error rate
  if (metrics.errorRate > 0.1) {
    return FailureMode.HighErrorRate;
  }

  // Check for timeout-dominated errors
  const timeoutErrors = metrics.errorTypes['timeout'] || 0;
  if (timeoutErrors / metrics.totalRequests > 0.05) {
    return FailureMode.Timeout;
  }

  // Check for resource exhaustion (CPU > 95%)
  if (metrics.avgCpuPercent > 95) {
    return FailureMode.ResourceExhaustion;
  }

  return FailureMode.None;
}

/**
 * Run stress test with gradual load increase
 */
export async function runStressTest(config: StressTestConfig, phaseEnabled: boolean): Promise<StressTestResult> {
  const logger = pino({ level: 'info' });

  logger.info('=== Phase 5 Stress Test ===');
  logger.info({ phaseEnabled }, 'Phase 5 enabled');

  // Configure feature flags
  process.env.PHASE5_ENABLED = phaseEnabled ? 'true' : 'false';
  resetFeatureFlags();
  initializeConfig();

  const engine = new Engine();
  logger.info({ model: config.modelPath }, 'Loading model');
  await engine.loadModel({ model: config.modelPath });

  const startTime = Date.now();
  const levels: StressLevelMetrics[] = [];
  let currentLevel = 0;
  let currentRequestsPerSecond = config.startingRequestsPerSecond;
  let breakingPointReached = false;
  let failureMode: FailureMode = FailureMode.None;

  logger.info('Starting gradual load increase');

  // Gradually increase load until failure
  while (
    !breakingPointReached &&
    currentRequestsPerSecond <= config.maxRequestsPerSecond &&
    Date.now() - startTime < config.maxDurationMs
  ) {
    logger.info({ level: currentLevel, requestsPerSecond: currentRequestsPerSecond }, 'Running stress level');

    try {
      const levelMetrics = await runStressLevel(engine, config, currentLevel, currentRequestsPerSecond, logger);

      levels.push(levelMetrics);

      // Check if breaking point reached
      const resources = getResourceMetrics();
      failureMode = classifyFailureMode(levelMetrics, resources);

      if (failureMode !== FailureMode.None || levelMetrics.errorRate > config.failureThreshold) {
        breakingPointReached = true;
        logger.warn(
          {
            level: currentLevel,
            requestsPerSecond: currentRequestsPerSecond,
            failureMode,
            errorRate: levelMetrics.errorRate,
          },
          'Breaking point reached'
        );
      } else {
        logger.info(
          {
            level: currentLevel,
            requestsPerSecond: currentRequestsPerSecond,
            errorRate: levelMetrics.errorRate,
            p95Latency: levelMetrics.p95LatencyMs,
          },
          'Level completed successfully'
        );

        // Increase load for next level
        currentLevel++;
        currentRequestsPerSecond += config.incrementRequestsPerSecond;
      }
    } catch (error) {
      logger.error({ error }, 'Stress level failed with crash');
      failureMode = FailureMode.Crash;
      breakingPointReached = true;
    }
  }

  // Shutdown engine
  await engine.shutdown();

  // Determine last successful level
  const lastSuccessfulLevel = levels.findIndex((l) => l.errorRate > config.failureThreshold || l.degradationDetected);
  const actualLastSuccessfulLevel = lastSuccessfulLevel === -1 ? levels.length - 1 : lastSuccessfulLevel - 1;

  const duration = Date.now() - startTime;

  return {
    config,
    phaseEnabled,
    levels,
    breakingPoint: {
      level: currentLevel,
      requestsPerSecond: currentRequestsPerSecond,
      failureMode,
      errorRate: levels[levels.length - 1]?.errorRate || 0,
      lastSuccessfulLevel: Math.max(0, actualLastSuccessfulLevel),
      lastSuccessfulRequestsPerSecond:
        levels[actualLastSuccessfulLevel]?.requestsPerSecond || config.startingRequestsPerSecond,
    },
    duration,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Display stress test results
 */
export function displayResults(result: StressTestResult): void {
  console.log('\n=== Stress Test Results ===\n');

  console.log(`Phase: ${result.phaseEnabled ? 'Phase 5 ENABLED' : 'Baseline'}`);
  console.log(`Duration: ${(result.duration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`Levels tested: ${result.levels.length}\n`);

  console.log('Level  Req/s   Requests  Errors   P95 Lat   Peak Conc   CPU     Memory    Status');
  console.log('------------------------------------------------------------------------------------');

  for (const level of result.levels) {
    const status = level.degradationDetected ? '⚠ DEGR' : level.errorRate > 0.01 ? '⚠ ERR' : '✓ OK';
    console.log(
      `${level.level.toString().padStart(3)}    ` +
        `${level.requestsPerSecond.toString().padStart(5)}   ` +
        `${level.totalRequests.toString().padStart(8)}  ` +
        `${(level.errorRate * 100).toFixed(1).padStart(6)}%  ` +
        `${level.p95LatencyMs.toFixed(0).padStart(7)}ms  ` +
        `${level.peakConcurrent.toString().padStart(9)}   ` +
        `${level.avgCpuPercent.toFixed(1).padStart(6)}%  ` +
        `${level.peakMemoryMB.toFixed(0).padStart(8)}MB  ` +
        `${status}`
    );
  }

  console.log('\n=== Breaking Point ===\n');
  console.log(`Maximum sustainable throughput: ${result.breakingPoint.lastSuccessfulRequestsPerSecond} req/s`);
  console.log(`Breaking point: ${result.breakingPoint.requestsPerSecond} req/s (level ${result.breakingPoint.level})`);
  console.log(`Failure mode: ${result.breakingPoint.failureMode}`);
  console.log(`Error rate at break: ${(result.breakingPoint.errorRate * 100).toFixed(1)}%`);
}

/**
 * Export results to JSON
 */
export async function exportResults(result: StressTestResult, outputPath: string): Promise<void> {
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nResults exported to: ${outputPath}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config: StressTestConfig = {
    modelId: 'gemma-2-27b-it-4bit',
    modelPath: 'mlx-community/gemma-2-27b-it-4bit',
    startingRequestsPerSecond: 50,
    incrementRequestsPerSecond: 20,
    incrementIntervalMs: 30000, // 30 seconds per level
    maxRequestsPerSecond: 300,
    maxConcurrent: 150,
    maxDurationMs: 600000, // 10 minutes max
    failureThreshold: 0.1, // 10% error rate
    maxTokens: 50,
    temperature: 0.7,
    prompts: DEFAULT_PROMPTS,
  };

  console.log('\n=== Phase 5 Week 2 Day 5: Stress Test ===\n');
  console.log('Starting load: ' + config.startingRequestsPerSecond + ' req/s');
  console.log('Increment: +' + config.incrementRequestsPerSecond + ' req/s every 30 seconds');
  console.log('Max load: ' + config.maxRequestsPerSecond + ' req/s');
  console.log('Failure threshold: ' + (config.failureThreshold * 100) + '%\n');

  // Run stress test with Phase 5 enabled
  const result = await runStressTest(config, true);
  displayResults(result);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(process.cwd(), 'benchmarks', 'results', `phase5-stress-test-${timestamp}.json`);
  await exportResults(result, jsonPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Stress test failed:', error);
    process.exit(1);
  });
}
