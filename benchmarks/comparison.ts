/**
 * Comparison Benchmark: kr-mlx-lm vs mlx-engine
 *
 * Compares performance between kr-mlx-lm and the reference mlx-engine implementation.
 * Measures TTFT (Time To First Token), throughput, and overall latency.
 *
 * Prerequisites:
 * - mlx-engine installed: git clone https://github.com/lmstudio-ai/mlx-engine.git /tmp/mlx-engine
 * - Python 3.11 environment with mlx-engine dependencies
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration, getSystemInfo } from './utils.js';
import type { BenchmarkConfig } from './types.js';

interface ComparisonResult {
  name: string;
  engine: 'kr-mlx-lm' | 'mlx-engine';
  timestamp: string;
  modelId: string;
  prompt: string;
  ttftMs: number;
  totalTimeMs: number;
  totalTokens: number;
  throughputTokensPerSec: number;
  success: boolean;
  error?: string;
}

interface ComparisonBenchmarkResult {
  name: string;
  timestamp: string;
  samples: number;
  modelId: string;
  krMlxLm: {
    ttft: ReturnType<typeof calculateStatistics>;
    throughput: ReturnType<typeof calculateStatistics>;
    totalTime: ReturnType<typeof calculateStatistics>;
    successRate: number;
  };
  mlxEngine: {
    ttft: ReturnType<typeof calculateStatistics>;
    throughput: ReturnType<typeof calculateStatistics>;
    totalTime: ReturnType<typeof calculateStatistics>;
    successRate: number;
  };
  rawResults: ComparisonResult[];
}

/**
 * Test configuration
 */
interface ComparisonTest {
  modelId: string;
  modelPath: string;
  prompts: string[];
  maxTokens: number;
  temperature: number;
}

const COMPARISON_TESTS: ComparisonTest[] = [
  {
    modelId: 'llama-3.2-3b-instruct',
    modelPath: 'models/llama-3.2-3b-instruct',
    prompts: [
      'Hello, how are you?',
      'Explain quantum computing in simple terms.',
      'Write a haiku about programming.',
      'What is the capital of France?',
      'Describe the process of photosynthesis.',
    ],
    maxTokens: 100,
    temperature: 0.7,
  },
];

/**
 * Run mlx-engine benchmark using Python subprocess
 */
async function runMlxEngineBenchmark(
  test: ComparisonTest,
  prompt: string,
  mlxEnginePath: string
): Promise<ComparisonResult> {
  const startTime = performance.now();
  let ttftMs = 0;
  let totalTokens = 0;
  let firstTokenReceived = false;
  let generatedText = '';

  return new Promise((resolve) => {
    const pythonScript = `
import sys
import time
import json
sys.path.insert(0, '${mlxEnginePath}')

from mlx_engine.generate import load_model, create_generator, tokenize

# Load model
model_kit = load_model('${test.modelPath}', trust_remote_code=False)

# Tokenize prompt
prompt_tokens = tokenize(model_kit, '''${prompt.replace(/'/g, "\\'")}''')

# Track timing
start_time = time.time()
first_token_time = None
total_tokens = 0

# Generate
generator = create_generator(
    model_kit,
    prompt_tokens,
    max_tokens=${test.maxTokens},
    temp=${test.temperature}
)

for result in generator:
    if first_token_time is None:
        first_token_time = time.time()

    total_tokens += len(result.tokens)
    print(result.text, end='', flush=True)

end_time = time.time()

# Print stats as JSON
stats = {
    'ttft_ms': (first_token_time - start_time) * 1000 if first_token_time else 0,
    'total_time_ms': (end_time - start_time) * 1000,
    'total_tokens': total_tokens
}
print('\\n__STATS__' + json.dumps(stats))
`;

    const python = spawn('python3.11', ['-c', pythonScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      if (!firstTokenReceived && chunk.length > 0) {
        ttftMs = performance.now() - startTime;
        firstTokenReceived = true;
      }
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      const totalTimeMs = performance.now() - startTime;

      if (code !== 0) {
        resolve({
          name: `mlx-engine - ${test.modelId}`,
          engine: 'mlx-engine',
          timestamp: new Date().toISOString(),
          modelId: test.modelId,
          prompt,
          ttftMs: 0,
          totalTimeMs,
          totalTokens: 0,
          throughputTokensPerSec: 0,
          success: false,
          error: stderr || 'Unknown error',
        });
        return;
      }

      // Parse stats from output
      const statsMatch = stdout.match(/__STATS__(.+)$/);
      if (statsMatch) {
        try {
          const stats = JSON.parse(statsMatch[1]);
          const effectiveTime = (stats.total_time_ms - stats.ttft_ms) / 1000;
          const throughput = effectiveTime > 0 ? stats.total_tokens / effectiveTime : 0;

          resolve({
            name: `mlx-engine - ${test.modelId}`,
            engine: 'mlx-engine',
            timestamp: new Date().toISOString(),
            modelId: test.modelId,
            prompt,
            ttftMs: stats.ttft_ms,
            totalTimeMs: stats.total_time_ms,
            totalTokens: stats.total_tokens,
            throughputTokensPerSec: throughput,
            success: true,
          });
          return;
        } catch (e) {
          // Fall through to default response
        }
      }

      // Fallback if stats parsing failed
      resolve({
        name: `mlx-engine - ${test.modelId}`,
        engine: 'mlx-engine',
        timestamp: new Date().toISOString(),
        modelId: test.modelId,
        prompt,
        ttftMs,
        totalTimeMs,
        totalTokens: 0,
        throughputTokensPerSec: 0,
        success: false,
        error: 'Failed to parse stats',
      });
    });
  });
}

/**
 * Run kr-mlx-lm benchmark
 */
async function runKrMlxLmBenchmark(test: ComparisonTest, prompt: string): Promise<ComparisonResult> {
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  try {
    const startTime = performance.now();
    let ttftMs = 0;
    let firstToken = false;
    let totalTokens = 0;

    // Load model
    await engine.loadModel({
      model: test.modelPath,
    });

    // Generate
    const generator = engine.createGenerator({
      model: test.modelId,
      prompt,
      maxTokens: test.maxTokens,
      temperature: test.temperature,
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

    const totalTimeMs = performance.now() - startTime;
    const effectiveTime = (totalTimeMs - ttftMs) / 1000;
    const throughput = effectiveTime > 0 ? totalTokens / effectiveTime : 0;

    await engine.shutdown();

    return {
      name: `kr-mlx-lm - ${test.modelId}`,
      engine: 'kr-mlx-lm',
      timestamp: new Date().toISOString(),
      modelId: test.modelId,
      prompt,
      ttftMs,
      totalTimeMs,
      totalTokens,
      throughputTokensPerSec: throughput,
      success: true,
    };
  } catch (error) {
    await engine.shutdown();
    return {
      name: `kr-mlx-lm - ${test.modelId}`,
      engine: 'kr-mlx-lm',
      timestamp: new Date().toISOString(),
      modelId: test.modelId,
      prompt,
      ttftMs: 0,
      totalTimeMs: 0,
      totalTokens: 0,
      throughputTokensPerSec: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run comparison benchmark
 */
export async function runComparisonBenchmark(
  config: BenchmarkConfig & { mlxEnginePath?: string } = {}
): Promise<ComparisonBenchmarkResult[]> {
  const { samples = 5, verbose = false, mlxEnginePath = '/tmp/mlx-engine' } = config;

  console.log('\n=== Comparison Benchmark: kr-mlx-lm vs mlx-engine ===\n');
  console.log(`Samples per test: ${samples}`);
  console.log(`mlx-engine path: ${mlxEnginePath}`);
  console.log(`System: ${getSystemInfo().platform} ${getSystemInfo().arch}`);
  console.log(`Node.js: ${getSystemInfo().nodeVersion}`);
  console.log('');

  const results: ComparisonBenchmarkResult[] = [];

  for (const test of COMPARISON_TESTS) {
    console.log(`\nTesting model: ${test.modelId}`);
    const rawResults: ComparisonResult[] = [];

    for (let i = 0; i < samples; i++) {
      const prompt = test.prompts[i % test.prompts.length];

      if (verbose) {
        console.log(`\n  Sample ${i + 1}/${samples} - Prompt: "${prompt.substring(0, 50)}..."`);
      }

      // Run kr-mlx-lm
      if (verbose) {
        console.log('    Running kr-mlx-lm...');
      }
      const krResult = await runKrMlxLmBenchmark(test, prompt);
      rawResults.push(krResult);

      if (verbose) {
        console.log(`    ✓ TTFT: ${formatDuration(krResult.ttftMs)}, Throughput: ${krResult.throughputTokensPerSec.toFixed(2)} tok/s`);
      }

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Run mlx-engine
      if (verbose) {
        console.log('    Running mlx-engine...');
      }
      const mlxResult = await runMlxEngineBenchmark(test, prompt, mlxEnginePath);
      rawResults.push(mlxResult);

      if (verbose) {
        if (mlxResult.success) {
          console.log(`    ✓ TTFT: ${formatDuration(mlxResult.ttftMs)}, Throughput: ${mlxResult.throughputTokensPerSec.toFixed(2)} tok/s`);
        } else {
          console.log(`    ✗ Failed: ${mlxResult.error}`);
        }
      }

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Calculate statistics
    const krResults = rawResults.filter((r) => r.engine === 'kr-mlx-lm' && r.success);
    const mlxResults = rawResults.filter((r) => r.engine === 'mlx-engine' && r.success);

    if (krResults.length === 0) {
      console.warn(`  Warning: No successful kr-mlx-lm results for ${test.modelId}`);
      continue;
    }

    const krTtfts = krResults.map((r) => r.ttftMs);
    const krThroughputs = krResults.map((r) => r.throughputTokensPerSec);
    const krTotalTimes = krResults.map((r) => r.totalTimeMs);

    const mlxTtfts = mlxResults.map((r) => r.ttftMs);
    const mlxThroughputs = mlxResults.map((r) => r.throughputTokensPerSec);
    const mlxTotalTimes = mlxResults.map((r) => r.totalTimeMs);

    results.push({
      name: `Comparison - ${test.modelId}`,
      timestamp: new Date().toISOString(),
      samples,
      modelId: test.modelId,
      krMlxLm: {
        ttft: calculateStatistics(krTtfts),
        throughput: calculateStatistics(krThroughputs),
        totalTime: calculateStatistics(krTotalTimes),
        successRate: (krResults.length / samples) * 100,
      },
      mlxEngine: {
        ttft: mlxTtfts.length > 0 ? calculateStatistics(mlxTtfts) : { mean: 0, median: 0, min: 0, max: 0, p95: 0, p99: 0, stdDev: 0 },
        throughput: mlxThroughputs.length > 0 ? calculateStatistics(mlxThroughputs) : { mean: 0, median: 0, min: 0, max: 0, p95: 0, p99: 0, stdDev: 0 },
        totalTime: mlxTotalTimes.length > 0 ? calculateStatistics(mlxTotalTimes) : { mean: 0, median: 0, min: 0, max: 0, p95: 0, p99: 0, stdDev: 0 },
        successRate: (mlxResults.length / samples) * 100,
      },
      rawResults,
    });
  }

  return results;
}

/**
 * Format comparison results as console table
 */
export function formatComparisonResults(results: ComparisonBenchmarkResult[]): void {
  console.log('\n=== Comparison Benchmark Results ===\n');

  for (const result of results) {
    console.log(`\nModel: ${result.modelId} (${result.samples} samples)\n`);

    // TTFT Comparison
    console.log('Time To First Token (TTFT):');
    console.log('  ' + ['Engine', 'Mean', 'Median', 'P95', 'P99', 'Success'].map((h) => h.padEnd(15)).join(' '));
    console.log('  ' + '-'.repeat(90));

    const krTtftRow = [
      'kr-mlx-lm'.padEnd(15),
      formatDuration(result.krMlxLm.ttft.mean).padEnd(15),
      formatDuration(result.krMlxLm.ttft.median).padEnd(15),
      formatDuration(result.krMlxLm.ttft.p95).padEnd(15),
      formatDuration(result.krMlxLm.ttft.p99).padEnd(15),
      `${result.krMlxLm.successRate.toFixed(0)}%`.padEnd(15),
    ];

    const mlxTtftRow = [
      'mlx-engine'.padEnd(15),
      formatDuration(result.mlxEngine.ttft.mean).padEnd(15),
      formatDuration(result.mlxEngine.ttft.median).padEnd(15),
      formatDuration(result.mlxEngine.ttft.p95).padEnd(15),
      formatDuration(result.mlxEngine.ttft.p99).padEnd(15),
      `${result.mlxEngine.successRate.toFixed(0)}%`.padEnd(15),
    ];

    console.log('  ' + krTtftRow.join(' '));
    console.log('  ' + mlxTtftRow.join(' '));

    // Throughput Comparison
    console.log('\nThroughput (tokens/sec):');
    console.log('  ' + ['Engine', 'Mean', 'Median', 'P95', 'P99'].map((h) => h.padEnd(15)).join(' '));
    console.log('  ' + '-'.repeat(75));

    const krThroughputRow = [
      'kr-mlx-lm'.padEnd(15),
      formatNumber(result.krMlxLm.throughput.mean, 2, 13),
      formatNumber(result.krMlxLm.throughput.median, 2, 13),
      formatNumber(result.krMlxLm.throughput.p95, 2, 13),
      formatNumber(result.krMlxLm.throughput.p99, 2, 13),
    ];

    const mlxThroughputRow = [
      'mlx-engine'.padEnd(15),
      formatNumber(result.mlxEngine.throughput.mean, 2, 13),
      formatNumber(result.mlxEngine.throughput.median, 2, 13),
      formatNumber(result.mlxEngine.throughput.p95, 2, 13),
      formatNumber(result.mlxEngine.throughput.p99, 2, 13),
    ];

    console.log('  ' + krThroughputRow.join(' '));
    console.log('  ' + mlxThroughputRow.join(' '));

    // Performance comparison
    if (result.mlxEngine.successRate > 0) {
      console.log('\nPerformance Comparison:');
      const ttftRatio = result.mlxEngine.ttft.mean / result.krMlxLm.ttft.mean;
      const throughputRatio = result.krMlxLm.throughput.mean / result.mlxEngine.throughput.mean;

      console.log(`  TTFT: kr-mlx-lm is ${ttftRatio.toFixed(2)}x ${ttftRatio > 1 ? 'slower' : 'faster'} than mlx-engine`);
      console.log(`  Throughput: kr-mlx-lm is ${throughputRatio.toFixed(2)}x ${throughputRatio > 1 ? 'faster' : 'slower'} than mlx-engine`);
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const results = await runComparisonBenchmark({ samples: 5, verbose: true });
  formatComparisonResults(results);

  // Export results as JSON
  const outputPath = new URL('./results/comparison.json', import.meta.url);
  await mkdir(new URL('./results', import.meta.url), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nResults exported to: ${outputPath.pathname}`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
