/**
 * Throughput Benchmark
 *
 * Measures token generation throughput (tokens/sec) across different scenarios.
 * Tests streaming vs non-streaming, different model sizes, and various prompt lengths.
 */

import { performance } from 'node:perf_hooks';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, getSystemInfo } from './utils.js';
import type { ThroughputBenchmarkResult, BenchmarkConfig } from './types.js';
import type { GeneratorParams } from '../src/types/generators.js';

interface ThroughputTest {
  name: string;
  modelId: string;
  model: string;
  prompt: string;
  maxTokens: number;
  streaming: boolean;
}

/**
 * Test configurations for throughput
 */
const THROUGHPUT_TESTS: ThroughputTest[] = [
  {
    name: 'Short prompt, streaming',
    modelId: 'llama-3.2-3b-instruct',
    model: 'models/llama-3.2-3b-instruct',
    prompt: 'Write a short story about a robot.',
    maxTokens: 100,
    streaming: true,
  },
  {
    name: 'Short prompt, non-streaming',
    modelId: 'llama-3.2-3b-instruct',
    model: 'models/llama-3.2-3b-instruct',
    prompt: 'Write a short story about a robot.',
    maxTokens: 100,
    streaming: false,
  },
  {
    name: 'Medium prompt, streaming',
    modelId: 'llama-3.2-3b-instruct',
    model: 'models/llama-3.2-3b-instruct',
    prompt:
      'Explain the following concept in detail: Machine learning is a subset of artificial intelligence that focuses on building systems that learn from data.',
    maxTokens: 200,
    streaming: true,
  },
  {
    name: 'Long generation, streaming',
    modelId: 'llama-3.2-3b-instruct',
    model: 'models/llama-3.2-3b-instruct',
    prompt: 'Write a comprehensive guide to TypeScript for beginners.',
    maxTokens: 500,
    streaming: true,
  },
];

/**
 * Measure throughput for a single generation
 */
async function measureThroughput(
  engine: Engine,
  test: ThroughputTest
): Promise<{ tokensPerSecond: number; latencyMs: number; tokensGenerated: number }> {
  const startTime = performance.now();
  let tokensGenerated = 0;
  let totalTime = 0;

  try {
    const generatorParams: GeneratorParams = {
      model: test.modelId,
      prompt: test.prompt,
      maxTokens: test.maxTokens,
      temperature: 0.7,
      streaming: test.streaming,
    };

    const generator = engine.createGenerator(generatorParams);

    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        tokensGenerated++;
      } else if (chunk.type === 'metadata') {
        totalTime = chunk.stats.totalTime;
      }
    }

    const endTime = performance.now();
    const latencyMs = endTime - startTime;

    // Calculate tokens/sec (use measured time or fallback to latency)
    const timeInSeconds = totalTime > 0 ? totalTime / 1000 : latencyMs / 1000;
    const tokensPerSecond = tokensGenerated / timeInSeconds;

    return { tokensPerSecond, latencyMs, tokensGenerated };
  } catch (error) {
    console.error(`Error during throughput measurement: ${error}`);
    throw error;
  }
}

/**
 * Run throughput benchmark
 */
export async function runThroughputBenchmark(config: BenchmarkConfig = {}): Promise<ThroughputBenchmarkResult[]> {
  const { samples = 10, verbose = false } = config;

  console.log('\n=== Throughput Benchmark ===\n');
  console.log(`Samples per test: ${samples}`);
  console.log(`System: ${getSystemInfo().platform} ${getSystemInfo().arch}`);
  console.log(`Node.js: ${getSystemInfo().nodeVersion}`);
  console.log('');

  const results: ThroughputBenchmarkResult[] = [];

  // Group tests by model to avoid repeated loading
  const testsByModel = new Map<string, ThroughputTest[]>();
  for (const test of THROUGHPUT_TESTS) {
    if (!testsByModel.has(test.modelId)) {
      testsByModel.set(test.modelId, []);
    }
    testsByModel.get(test.modelId)!.push(test);
  }

  for (const [modelId, tests] of testsByModel) {
    console.log(`\nTesting model: ${modelId}`);

    const logger = pino({ level: 'error' });
    const engine = new Engine({}, { logger });

    try {
      // Load model once for all tests
      if (verbose) {
        console.log('  Loading model...');
      }

      await engine.loadModel({
        model: tests[0].model,
      });

      // Run each test
      for (const test of tests) {
        if (verbose) {
          console.log(`  Running: ${test.name}`);
        }

        const tokensPerSecondSamples: number[] = [];
        const latencySamples: number[] = [];
        let totalTokensGenerated = 0;

        for (let i = 0; i < samples; i++) {
          const { tokensPerSecond, latencyMs, tokensGenerated } = await measureThroughput(engine, test);

          tokensPerSecondSamples.push(tokensPerSecond);
          latencySamples.push(latencyMs);
          totalTokensGenerated += tokensGenerated;

          if (verbose && i === 0) {
            console.log(`    First sample: ${tokensPerSecond.toFixed(2)} tokens/sec`);
          }

          // Brief pause between samples
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const tokensPerSecondStats = calculateStatistics(tokensPerSecondSamples);
        const latencyStats = calculateStatistics(latencySamples);

        results.push({
          name: `Throughput - ${test.name}`,
          timestamp: new Date().toISOString(),
          samples,
          modelId: test.modelId,
          tokensGenerated: Math.round(totalTokensGenerated / samples),
          tokensPerSecond: tokensPerSecondStats,
          avgLatencyMs: latencyStats,
          streaming: test.streaming,
          durationMs: latencyStats.mean,
        });

        if (verbose) {
          console.log(`    Average: ${tokensPerSecondStats.mean.toFixed(2)} tokens/sec`);
          console.log(`    P95: ${tokensPerSecondStats.p95.toFixed(2)} tokens/sec`);
        }
      }
    } finally {
      await engine.shutdown();
    }

    // Pause between models
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return results;
}

/**
 * Format throughput benchmark results
 */
export function formatThroughputResults(results: ThroughputBenchmarkResult[]): void {
  console.log('\n=== Throughput Benchmark Results ===\n');

  // Group by streaming mode
  const streamingResults = results.filter((r) => r.streaming);
  const nonStreamingResults = results.filter((r) => !r.streaming);

  const printTable = (title: string, data: ThroughputBenchmarkResult[]) => {
    if (data.length === 0) return;

    console.log(`\n${title}:`);
    console.log(
      '  ' +
        ['Test', 'Tokens', 'Mean (t/s)', 'P95 (t/s)', 'Latency (ms)']
          .map((h) => h.padEnd(20))
          .join(' ')
    );
    console.log('  ' + '-'.repeat(100));

    for (const result of data) {
      const testName = result.name.replace('Throughput - ', '');
      console.log(
        '  ' +
          [
            testName.padEnd(20).slice(0, 20),
            result.tokensGenerated.toString().padEnd(20),
            formatNumber(result.tokensPerSecond.mean, 2, 18),
            formatNumber(result.tokensPerSecond.p95, 2, 18),
            formatNumber(result.avgLatencyMs.mean, 2, 18),
          ].join(' ')
      );
    }
  };

  printTable('Streaming Mode', streamingResults);
  printTable('Non-Streaming Mode', nonStreamingResults);

  // Performance summary
  console.log('\n=== Performance Summary ===\n');

  const allTokensPerSec = results.map((r) => r.tokensPerSecond.mean);
  const avgThroughput = allTokensPerSec.reduce((sum, val) => sum + val, 0) / allTokensPerSec.length;

  console.log(`Average Throughput: ${formatNumber(avgThroughput, 2)} tokens/sec`);

  // Compare streaming vs non-streaming
  if (streamingResults.length > 0 && nonStreamingResults.length > 0) {
    const streamingAvg =
      streamingResults.reduce((sum, r) => sum + r.tokensPerSecond.mean, 0) / streamingResults.length;
    const nonStreamingAvg =
      nonStreamingResults.reduce((sum, r) => sum + r.tokensPerSecond.mean, 0) / nonStreamingResults.length;

    console.log(`\nStreaming avg:     ${formatNumber(streamingAvg, 2)} tokens/sec`);
    console.log(`Non-streaming avg: ${formatNumber(nonStreamingAvg, 2)} tokens/sec`);

    const diff = ((streamingAvg / nonStreamingAvg - 1) * 100).toFixed(1);
    console.log(`Difference: ${diff}%`);
  }

  // Performance target
  const minTargetTps = 20; // Minimum 20 tokens/sec
  const targetMet = allTokensPerSec.every((tps) => tps >= minTargetTps);

  console.log(`\nThroughput Target (>= ${minTargetTps} tokens/sec): ${targetMet ? '✓ PASSED' : '✗ FAILED'}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const results = await runThroughputBenchmark({ samples: 10, verbose: true });
  formatThroughputResults(results);

  // Export results as JSON
  const outputPath = new URL('./results/throughput.json', import.meta.url);
  const fs = await import('fs/promises');
  await fs.mkdir(new URL('./results', import.meta.url), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nResults exported to: ${outputPath.pathname}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
