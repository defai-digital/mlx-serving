/**
 * TTFT (Time To First Token) Benchmark
 *
 * Measures the latency from request to first token generation.
 * Compares cold start vs warm start performance across different models.
 */

import { performance } from 'node:perf_hooks';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration, getSystemInfo } from './utils.js';
import type { TtftBenchmarkResult, BenchmarkConfig } from './types.js';

interface TtftTest {
  modelId: string;
  model: string;
  prompts: string[];
}

/**
 * Test configurations for different model sizes
 */
const TTFT_TESTS: TtftTest[] = [
  {
    modelId: 'llama-3.2-3b-instruct',
    model: 'models/llama-3.2-3b-instruct',
    prompts: [
      'Hello, how are you?',
      'The quick brown fox jumps over the lazy dog.',
      'Explain the concept of machine learning in simple terms.',
      'Write a haiku about programming.',
    ],
  },
  // Add more models as needed
];

/**
 * Measure TTFT for a single generation
 */
async function measureTtft(
  engine: Engine,
  modelId: string,
  prompt: string
): Promise<{ ttftMs: number; totalTokens: number }> {
  const startTime = performance.now();
  let ttftMs = 0;
  let firstToken = false;
  let totalTokens = 0;

  try {
    const generator = engine.createGenerator({
      model: modelId,
      prompt,
      maxTokens: 50,
      temperature: 0.7,
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

    return { ttftMs, totalTokens };
  } catch (error) {
    console.error(`Error during TTFT measurement: ${error}`);
    throw error;
  }
}

/**
 * Run cold start test (model loading + first generation)
 */
async function runColdStartTest(test: TtftTest, samples: number): Promise<number[]> {
  const timings: number[] = [];

  for (let i = 0; i < samples; i++) {
    const logger = pino({ level: 'error' }); // Suppress logs during benchmark
    const engine = new Engine({}, { logger });

    try {
      const startTime = performance.now();

      // Load model
      await engine.loadModel({
        model: test.model,
      });

      // First generation
      const prompt = test.prompts[i % test.prompts.length];
      const { ttftMs } = await measureTtft(engine, test.modelId, prompt);

      timings.push(ttftMs);
    } finally {
      await engine.shutdown();
    }

    // Brief pause between cold starts
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return timings;
}

/**
 * Run warm start test (model already loaded)
 */
async function runWarmStartTest(test: TtftTest, samples: number): Promise<number[]> {
  const timings: number[] = [];
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  try {
    // Load model once
    await engine.loadModel({
      model: test.model,
    });

    // Run multiple generations
    for (let i = 0; i < samples; i++) {
      const prompt = test.prompts[i % test.prompts.length];
      const { ttftMs } = await measureTtft(engine, test.modelId, prompt);
      timings.push(ttftMs);

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await engine.shutdown();
  }

  return timings;
}

/**
 * Run TTFT benchmark
 */
export async function runTtftBenchmark(config: BenchmarkConfig = {}): Promise<TtftBenchmarkResult[]> {
  const { samples = 10, verbose = false } = config;

  console.log('\n=== TTFT Benchmark ===\n');
  console.log(`Samples per test: ${samples}`);
  console.log(`System: ${getSystemInfo().platform} ${getSystemInfo().arch}`);
  console.log(`Node.js: ${getSystemInfo().nodeVersion}`);
  console.log('');

  const results: TtftBenchmarkResult[] = [];

  for (const test of TTFT_TESTS) {
    console.log(`\nTesting model: ${test.modelId}`);

    if (verbose) {
      console.log('  Running cold start tests...');
    }

    // Cold start tests
    const coldStartTimings = await runColdStartTest(test, samples);
    const coldStartStats = calculateStatistics(coldStartTimings);

    if (verbose) {
      console.log('  Running warm start tests...');
    }

    // Warm start tests
    const warmStartTimings = await runWarmStartTest(test, samples);
    const warmStartStats = calculateStatistics(warmStartTimings);

    results.push({
      name: `TTFT - ${test.modelId}`,
      timestamp: new Date().toISOString(),
      samples,
      modelId: test.modelId,
      promptLength: test.prompts[0].length,
      coldStart: coldStartStats,
      warmStart: warmStartStats,
      durationMs: coldStartStats.mean + warmStartStats.mean,
    });

    if (verbose) {
      console.log(`  Cold start TTFT: ${formatDuration(coldStartStats.mean)}`);
      console.log(`  Warm start TTFT: ${formatDuration(warmStartStats.mean)}`);
      console.log(
        `  Improvement: ${((coldStartStats.mean / warmStartStats.mean).toFixed(2))}x faster when warm`
      );
    }
  }

  return results;
}

/**
 * Format TTFT benchmark results
 */
export function formatTtftResults(results: TtftBenchmarkResult[]): void {
  console.log('\n=== TTFT Benchmark Results ===\n');

  for (const result of results) {
    console.log(`\nModel: ${result.modelId}`);
    console.log('  ' + ['Type', 'Mean', 'Median', 'P95', 'P99', 'Min', 'Max'].map((h) => h.padEnd(12)).join(' '));
    console.log('  ' + '-'.repeat(84));

    const coldRow = [
      'Cold Start'.padEnd(12),
      formatNumber(result.coldStart.mean, 2, 10),
      formatNumber(result.coldStart.median, 2, 10),
      formatNumber(result.coldStart.p95, 2, 10),
      formatNumber(result.coldStart.p99, 2, 10),
      formatNumber(result.coldStart.min, 2, 10),
      formatNumber(result.coldStart.max, 2, 10),
    ];

    const warmRow = [
      'Warm Start'.padEnd(12),
      formatNumber(result.warmStart.mean, 2, 10),
      formatNumber(result.warmStart.median, 2, 10),
      formatNumber(result.warmStart.p95, 2, 10),
      formatNumber(result.warmStart.p99, 2, 10),
      formatNumber(result.warmStart.min, 2, 10),
      formatNumber(result.warmStart.max, 2, 10),
    ];

    console.log('  ' + coldRow.join(' '));
    console.log('  ' + warmRow.join(' '));
  }

  // Performance targets
  console.log('\n=== Performance Targets ===\n');

  for (const result of results) {
    const warmP95 = result.warmStart.p95;
    const targetMs = 200; // Target: < 200ms p95 for warm start

    const targetMet = warmP95 < targetMs;
    console.log(
      `${result.modelId}: ${targetMet ? '✓ PASSED' : '✗ FAILED'} (Warm P95: ${warmP95.toFixed(2)}ms, Target: <${targetMs}ms)`
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const results = await runTtftBenchmark({ samples: 10, verbose: true });
  formatTtftResults(results);

  // Export results as JSON
  const outputPath = new URL('./results/ttft.json', import.meta.url);
  const fs = await import('fs/promises');
  await fs.mkdir(new URL('./results', import.meta.url), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nResults exported to: ${outputPath.pathname}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
