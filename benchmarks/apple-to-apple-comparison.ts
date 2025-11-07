/**
 * Apple-to-Apple Comparison Benchmark
 *
 * Strict fair comparison between kr-mlx-lm and mlx-engine.
 * Ensures identical conditions for both engines:
 * - Same model path and configuration
 * - Same prompts and generation parameters
 * - Warm-up phase to eliminate cold start bias
 * - Randomized test order to eliminate sequence bias
 * - Multiple runs for statistical significance
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration, getSystemInfo } from './utils.js';

/**
 * Test conditions that must be identical for both engines
 */
interface TestConditions {
  modelPath: string;
  modelId: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number; // For reproducibility if supported
}

/**
 * Test result with detailed metrics
 */
interface TestResult {
  engine: 'kr-mlx-lm' | 'mlx-engine';
  testId: string;
  runNumber: number;
  conditions: TestConditions;
  metrics: {
    modelLoadTimeMs: number;     // Time to load model
    ttftMs: number;               // Time to first token (excluding model load)
    generationTimeMs: number;     // Total generation time (excluding model load and TTFT)
    totalTimeMs: number;          // Total time including model load
    totalTokens: number;
    throughputTokensPerSec: number;
    tokensPerSecExcludingTTFT: number; // Pure generation speed
  };
  output: {
    text: string;
    tokenCount: number;
  };
  systemState: {
    timestamp: string;
    memoryUsageMB: number;
    cpuLoadPercent?: number;
  };
  success: boolean;
  error?: string;
}

/**
 * Comparison report
 */
interface ComparisonReport {
  testName: string;
  timestamp: string;
  conditions: TestConditions;
  totalRuns: number;
  warmupRuns: number;
  krMlxLm: {
    modelLoadTime: ReturnType<typeof calculateStatistics>;
    ttft: ReturnType<typeof calculateStatistics>;
    generationTime: ReturnType<typeof calculateStatistics>;
    totalTime: ReturnType<typeof calculateStatistics>;
    throughput: ReturnType<typeof calculateStatistics>;
    pureGenSpeed: ReturnType<typeof calculateStatistics>;
    successRate: number;
    avgTokens: number;
  };
  mlxEngine: {
    modelLoadTime: ReturnType<typeof calculateStatistics>;
    ttft: ReturnType<typeof calculateStatistics>;
    generationTime: ReturnType<typeof calculateStatistics>;
    totalTime: ReturnType<typeof calculateStatistics>;
    throughput: ReturnType<typeof calculateStatistics>;
    pureGenSpeed: ReturnType<typeof calculateStatistics>;
    successRate: number;
    avgTokens: number;
  };
  comparison: {
    modelLoadSpeedup: number;      // mlxEngine / krMlxLm (< 1 = kr slower, > 1 = kr faster)
    ttftSpeedup: number;
    generationSpeedup: number;
    throughputSpeedup: number;
    pureGenSpeedup: number;
    outputConsistency: number;     // How similar are token counts
  };
  rawResults: TestResult[];
}

/**
 * Shuffle array (Fisher-Yates)
 */
function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Get current memory usage
 */
function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed / 1024 / 1024;
}

/**
 * Test kr-mlx-lm with precise timing
 */
async function testKrMlxLm(
  conditions: TestConditions,
  testId: string,
  runNumber: number
): Promise<TestResult> {
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  const startMemory = getMemoryUsageMB();
  const startTimestamp = new Date().toISOString();

  try {
    // Measure model load time
    const loadStart = performance.now();
    await engine.loadModel({
      model: conditions.modelPath,
    });
    const modelLoadTimeMs = performance.now() - loadStart;

    // Measure generation
    const genStart = performance.now();
    let ttftMs = 0;
    let firstToken = false;
    let totalTokens = 0;
    let generatedText = '';

    const generator = engine.createGenerator({
      model: conditions.modelPath, // Use modelPath not modelId
      prompt: conditions.prompt,
      maxTokens: conditions.maxTokens,
      temperature: conditions.temperature,
      topP: conditions.topP,
      repetitionPenalty: conditions.repetitionPenalty,
      streaming: true,
    });

    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        if (!firstToken) {
          ttftMs = performance.now() - genStart;
          firstToken = true;
        }
        totalTokens++;
        generatedText += chunk.token;
      }
    }

    const totalGenerationMs = performance.now() - genStart;
    const generationTimeMs = totalGenerationMs - ttftMs; // Exclude TTFT
    const totalTimeMs = performance.now() - loadStart; // Include model load

    const throughput = totalGenerationMs > 0 ? (totalTokens / (totalGenerationMs / 1000)) : 0;
    const pureGenSpeed = generationTimeMs > 0 ? (totalTokens / (generationTimeMs / 1000)) : 0;

    await engine.shutdown();

    return {
      engine: 'kr-mlx-lm',
      testId,
      runNumber,
      conditions,
      metrics: {
        modelLoadTimeMs,
        ttftMs,
        generationTimeMs,
        totalTimeMs,
        totalTokens,
        throughputTokensPerSec: throughput,
        tokensPerSecExcludingTTFT: pureGenSpeed,
      },
      output: {
        text: generatedText,
        tokenCount: totalTokens,
      },
      systemState: {
        timestamp: startTimestamp,
        memoryUsageMB: getMemoryUsageMB() - startMemory,
      },
      success: true,
    };
  } catch (error) {
    await engine.shutdown();
    return {
      engine: 'kr-mlx-lm',
      testId,
      runNumber,
      conditions,
      metrics: {
        modelLoadTimeMs: 0,
        ttftMs: 0,
        generationTimeMs: 0,
        totalTimeMs: 0,
        totalTokens: 0,
        throughputTokensPerSec: 0,
        tokensPerSecExcludingTTFT: 0,
      },
      output: {
        text: '',
        tokenCount: 0,
      },
      systemState: {
        timestamp: startTimestamp,
        memoryUsageMB: getMemoryUsageMB() - startMemory,
      },
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test mlx-engine with precise timing
 */
async function testMlxEngine(
  conditions: TestConditions,
  testId: string,
  runNumber: number,
  mlxEnginePath: string
): Promise<TestResult> {
  const startMemory = getMemoryUsageMB();
  const startTimestamp = new Date().toISOString();

  return new Promise((resolve) => {
    const pythonScript = `
import sys
import time
import json
sys.path.insert(0, '${mlxEnginePath}')

from mlx_engine.generate import load_model, create_generator, tokenize

# Measure model load time
load_start = time.time()
model_kit = load_model('${conditions.modelPath}', trust_remote_code=False)
model_load_time = time.time() - load_start

# Tokenize prompt
prompt_tokens = tokenize(model_kit, '''${conditions.prompt.replace(/'/g, "\\'")}''')

# Measure generation
gen_start = time.time()
first_token_time = None
total_tokens = 0
generated_text = ''

generator = create_generator(
    model_kit,
    prompt_tokens,
    max_tokens=${conditions.maxTokens},
    temp=${conditions.temperature}${conditions.topP ? `,\n    top_p=${conditions.topP}` : ''}${conditions.repetitionPenalty ? `,\n    repetition_penalty=${conditions.repetitionPenalty}` : ''}
)

for result in generator:
    if first_token_time is None:
        first_token_time = time.time()

    total_tokens += len(result.tokens)
    generated_text += result.text

gen_end = time.time()

# Calculate metrics
total_gen_time = gen_end - gen_start
ttft = (first_token_time - gen_start) if first_token_time else 0
generation_time = total_gen_time - ttft
total_time = model_load_time + total_gen_time

throughput = (total_tokens / total_gen_time) if total_gen_time > 0 else 0
pure_gen_speed = (total_tokens / generation_time) if generation_time > 0 else 0

# Output stats as JSON
stats = {
    'model_load_time_ms': model_load_time * 1000,
    'ttft_ms': ttft * 1000,
    'generation_time_ms': generation_time * 1000,
    'total_time_ms': total_time * 1000,
    'total_tokens': total_tokens,
    'throughput': throughput,
    'pure_gen_speed': pure_gen_speed,
    'generated_text': generated_text
}
print('__STATS__' + json.dumps(stats))
`;

    const python = spawn(`${mlxEnginePath}/.venv/bin/python`, ['-c', pythonScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        resolve({
          engine: 'mlx-engine',
          testId,
          runNumber,
          conditions,
          metrics: {
            modelLoadTimeMs: 0,
            ttftMs: 0,
            generationTimeMs: 0,
            totalTimeMs: 0,
            totalTokens: 0,
            throughputTokensPerSec: 0,
            tokensPerSecExcludingTTFT: 0,
          },
          output: {
            text: '',
            tokenCount: 0,
          },
          systemState: {
            timestamp: startTimestamp,
            memoryUsageMB: getMemoryUsageMB() - startMemory,
          },
          success: false,
          error: stderr || `Python exited with code ${code}`,
        });
        return;
      }

      const statsMatch = stdout.match(/__STATS__(.+)$/s);
      if (statsMatch) {
        try {
          const stats = JSON.parse(statsMatch[1]);
          resolve({
            engine: 'mlx-engine',
            testId,
            runNumber,
            conditions,
            metrics: {
              modelLoadTimeMs: stats.model_load_time_ms,
              ttftMs: stats.ttft_ms,
              generationTimeMs: stats.generation_time_ms,
              totalTimeMs: stats.total_time_ms,
              totalTokens: stats.total_tokens,
              throughputTokensPerSec: stats.throughput,
              tokensPerSecExcludingTTFT: stats.pure_gen_speed,
            },
            output: {
              text: stats.generated_text,
              tokenCount: stats.total_tokens,
            },
            systemState: {
              timestamp: startTimestamp,
              memoryUsageMB: getMemoryUsageMB() - startMemory,
            },
            success: true,
          });
          return;
        } catch (e) {
          // Fall through
        }
      }

      resolve({
        engine: 'mlx-engine',
        testId,
        runNumber,
        conditions,
        metrics: {
          modelLoadTimeMs: 0,
          ttftMs: 0,
          generationTimeMs: 0,
          totalTimeMs: 0,
          totalTokens: 0,
          throughputTokensPerSec: 0,
          tokensPerSecExcludingTTFT: 0,
        },
        output: {
          text: '',
          tokenCount: 0,
        },
        systemState: {
          timestamp: startTimestamp,
          memoryUsageMB: getMemoryUsageMB() - startMemory,
        },
        success: false,
        error: 'Failed to parse stats',
      });
    });
  });
}

/**
 * Run apple-to-apple comparison
 */
export async function runAppleToAppleComparison(config: {
  conditions: TestConditions;
  runs?: number;
  warmupRuns?: number;
  randomizeOrder?: boolean;
  mlxEnginePath?: string;
  verbose?: boolean;
}): Promise<ComparisonReport> {
  const {
    conditions,
    runs = 10,
    warmupRuns = 2,
    randomizeOrder = true,
    mlxEnginePath = '/tmp/mlx-engine',
    verbose = false,
  } = config;

  const testName = `Apple-to-Apple: ${conditions.modelId}`;
  const testId = `test-${Date.now()}`;

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         Apple-to-Apple Comparison Benchmark                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log('Test Configuration:');
  console.log(`  Model: ${conditions.modelId}`);
  console.log(`  Path: ${conditions.modelPath}`);
  console.log(`  Prompt: "${conditions.prompt.substring(0, 60)}..."`);
  console.log(`  Max Tokens: ${conditions.maxTokens}`);
  console.log(`  Temperature: ${conditions.temperature}`);
  console.log(`  Runs: ${runs} (+ ${warmupRuns} warmup)`);
  console.log(`  Randomize Order: ${randomizeOrder}`);
  console.log(`  mlx-engine Path: ${mlxEnginePath}`);
  console.log('');

  const allResults: TestResult[] = [];

  // Warmup phase
  if (warmupRuns > 0) {
    console.log(`\n🔥 Warmup Phase (${warmupRuns} runs each engine)...\n`);

    for (let i = 0; i < warmupRuns; i++) {
      if (verbose) console.log(`  Warmup ${i + 1}/${warmupRuns} - kr-mlx-lm...`);
      await testKrMlxLm(conditions, `warmup-kr-${i}`, i);

      if (verbose) console.log(`  Warmup ${i + 1}/${warmupRuns} - mlx-engine...`);
      await testMlxEngine(conditions, `warmup-mlx-${i}`, i, mlxEnginePath);

      // Cool down
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log('✅ Warmup complete\n');
  }

  // Main test phase
  console.log(`\n📊 Main Test Phase (${runs} runs each engine)...\n`);

  for (let i = 0; i < runs; i++) {
    // Create test order for this run
    const engines: Array<'kr-mlx-lm' | 'mlx-engine'> = randomizeOrder
      ? shuffle(['kr-mlx-lm', 'mlx-engine'])
      : ['kr-mlx-lm', 'mlx-engine'];

    if (verbose) {
      console.log(`  Run ${i + 1}/${runs} - Order: ${engines.join(' → ')}`);
    }

    for (const engine of engines) {
      if (engine === 'kr-mlx-lm') {
        if (verbose) console.log('    Testing kr-mlx-lm...');
        const result = await testKrMlxLm(conditions, testId, i);
        allResults.push(result);
        if (verbose && result.success) {
          console.log(`      ✓ TTFT: ${result.metrics.ttftMs.toFixed(2)}ms, Tokens: ${result.metrics.totalTokens}, Throughput: ${result.metrics.throughputTokensPerSec.toFixed(2)} tok/s`);
        }
      } else {
        if (verbose) console.log('    Testing mlx-engine...');
        const result = await testMlxEngine(conditions, testId, i, mlxEnginePath);
        allResults.push(result);
        if (verbose && result.success) {
          console.log(`      ✓ TTFT: ${result.metrics.ttftMs.toFixed(2)}ms, Tokens: ${result.metrics.totalTokens}, Throughput: ${result.metrics.throughputTokensPerSec.toFixed(2)} tok/s`);
        }
      }

      // Cool down between tests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Cool down between runs
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log('\n✅ Testing complete\n');

  // Analyze results
  const krResults = allResults.filter((r) => r.engine === 'kr-mlx-lm' && r.success);
  const mlxResults = allResults.filter((r) => r.engine === 'mlx-engine' && r.success);

  if (krResults.length === 0 || mlxResults.length === 0) {
    throw new Error('Not enough successful results for comparison');
  }

  const krStats = {
    modelLoadTime: calculateStatistics(krResults.map((r) => r.metrics.modelLoadTimeMs)),
    ttft: calculateStatistics(krResults.map((r) => r.metrics.ttftMs)),
    generationTime: calculateStatistics(krResults.map((r) => r.metrics.generationTimeMs)),
    totalTime: calculateStatistics(krResults.map((r) => r.metrics.totalTimeMs)),
    throughput: calculateStatistics(krResults.map((r) => r.metrics.throughputTokensPerSec)),
    pureGenSpeed: calculateStatistics(krResults.map((r) => r.metrics.tokensPerSecExcludingTTFT)),
    successRate: (krResults.length / runs) * 100,
    avgTokens: krResults.reduce((sum, r) => sum + r.metrics.totalTokens, 0) / krResults.length,
  };

  const mlxStats = {
    modelLoadTime: calculateStatistics(mlxResults.map((r) => r.metrics.modelLoadTimeMs)),
    ttft: calculateStatistics(mlxResults.map((r) => r.metrics.ttftMs)),
    generationTime: calculateStatistics(mlxResults.map((r) => r.metrics.generationTimeMs)),
    totalTime: calculateStatistics(mlxResults.map((r) => r.metrics.totalTimeMs)),
    throughput: calculateStatistics(mlxResults.map((r) => r.metrics.throughputTokensPerSec)),
    pureGenSpeed: calculateStatistics(mlxResults.map((r) => r.metrics.tokensPerSecExcludingTTFT)),
    successRate: (mlxResults.length / runs) * 100,
    avgTokens: mlxResults.reduce((sum, r) => sum + r.metrics.totalTokens, 0) / mlxResults.length,
  };

  // Calculate speedup ratios (> 1 means kr-mlx-lm is faster)
  const comparison = {
    modelLoadSpeedup: mlxStats.modelLoadTime.mean / krStats.modelLoadTime.mean,
    ttftSpeedup: mlxStats.ttft.mean / krStats.ttft.mean,
    generationSpeedup: mlxStats.generationTime.mean / krStats.generationTime.mean,
    throughputSpeedup: krStats.throughput.mean / mlxStats.throughput.mean,
    pureGenSpeedup: krStats.pureGenSpeed.mean / mlxStats.pureGenSpeed.mean,
    outputConsistency: Math.abs(krStats.avgTokens - mlxStats.avgTokens) / Math.max(krStats.avgTokens, mlxStats.avgTokens),
  };

  return {
    testName,
    timestamp: new Date().toISOString(),
    conditions,
    totalRuns: runs,
    warmupRuns,
    krMlxLm: krStats,
    mlxEngine: mlxStats,
    comparison,
    rawResults: allResults,
  };
}

/**
 * Format comparison report
 */
export function formatComparisonReport(report: ComparisonReport): void {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║              Apple-to-Apple Comparison Results               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Test: ${report.testName}`);
  console.log(`Runs: ${report.totalRuns} (after ${report.warmupRuns} warmup runs)`);
  console.log(`Success Rate: kr-mlx-lm ${report.krMlxLm.successRate.toFixed(0)}%, mlx-engine ${report.mlxEngine.successRate.toFixed(0)}%\n`);

  // Model Load Time
  console.log('═══ Model Load Time ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-mlx-lm       ${formatDuration(report.krMlxLm.modelLoadTime.mean).padEnd(12)} ${formatDuration(report.krMlxLm.modelLoadTime.median).padEnd(12)} ${formatDuration(report.krMlxLm.modelLoadTime.p95).padEnd(12)} ${formatDuration(report.krMlxLm.modelLoadTime.p99).padEnd(12)} ${formatDuration(report.krMlxLm.modelLoadTime.min).padEnd(12)} ${formatDuration(report.krMlxLm.modelLoadTime.max)}`);
  console.log(`  mlx-engine      ${formatDuration(report.mlxEngine.modelLoadTime.mean).padEnd(12)} ${formatDuration(report.mlxEngine.modelLoadTime.median).padEnd(12)} ${formatDuration(report.mlxEngine.modelLoadTime.p95).padEnd(12)} ${formatDuration(report.mlxEngine.modelLoadTime.p99).padEnd(12)} ${formatDuration(report.mlxEngine.modelLoadTime.min).padEnd(12)} ${formatDuration(report.mlxEngine.modelLoadTime.max)}`);
  console.log(`  Speedup: ${report.comparison.modelLoadSpeedup.toFixed(3)}x ${report.comparison.modelLoadSpeedup > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  // TTFT
  console.log('═══ Time To First Token (TTFT) ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-mlx-lm       ${formatDuration(report.krMlxLm.ttft.mean).padEnd(12)} ${formatDuration(report.krMlxLm.ttft.median).padEnd(12)} ${formatDuration(report.krMlxLm.ttft.p95).padEnd(12)} ${formatDuration(report.krMlxLm.ttft.p99).padEnd(12)} ${formatDuration(report.krMlxLm.ttft.min).padEnd(12)} ${formatDuration(report.krMlxLm.ttft.max)}`);
  console.log(`  mlx-engine      ${formatDuration(report.mlxEngine.ttft.mean).padEnd(12)} ${formatDuration(report.mlxEngine.ttft.median).padEnd(12)} ${formatDuration(report.mlxEngine.ttft.p95).padEnd(12)} ${formatDuration(report.mlxEngine.ttft.p99).padEnd(12)} ${formatDuration(report.mlxEngine.ttft.min).padEnd(12)} ${formatDuration(report.mlxEngine.ttft.max)}`);
  console.log(`  Speedup: ${report.comparison.ttftSpeedup.toFixed(3)}x ${report.comparison.ttftSpeedup > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  // Throughput
  console.log('═══ Token Generation Throughput ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-mlx-lm       ${formatNumber(report.krMlxLm.throughput.mean, 2, 10)} ${formatNumber(report.krMlxLm.throughput.median, 2, 10)} ${formatNumber(report.krMlxLm.throughput.p95, 2, 10)} ${formatNumber(report.krMlxLm.throughput.p99, 2, 10)} ${formatNumber(report.krMlxLm.throughput.min, 2, 10)} ${formatNumber(report.krMlxLm.throughput.max, 2, 10)}`);
  console.log(`  mlx-engine      ${formatNumber(report.mlxEngine.throughput.mean, 2, 10)} ${formatNumber(report.mlxEngine.throughput.median, 2, 10)} ${formatNumber(report.mlxEngine.throughput.p95, 2, 10)} ${formatNumber(report.mlxEngine.throughput.p99, 2, 10)} ${formatNumber(report.mlxEngine.throughput.min, 2, 10)} ${formatNumber(report.mlxEngine.throughput.max, 2, 10)}`);
  console.log(`  Speedup: ${report.comparison.throughputSpeedup.toFixed(3)}x ${report.comparison.throughputSpeedup > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  // Pure Generation Speed (excluding TTFT)
  console.log('═══ Pure Generation Speed (excl. TTFT) ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-mlx-lm       ${formatNumber(report.krMlxLm.pureGenSpeed.mean, 2, 10)} ${formatNumber(report.krMlxLm.pureGenSpeed.median, 2, 10)} ${formatNumber(report.krMlxLm.pureGenSpeed.p95, 2, 10)} ${formatNumber(report.krMlxLm.pureGenSpeed.p99, 2, 10)} ${formatNumber(report.krMlxLm.pureGenSpeed.min, 2, 10)} ${formatNumber(report.krMlxLm.pureGenSpeed.max, 2, 10)}`);
  console.log(`  mlx-engine      ${formatNumber(report.mlxEngine.pureGenSpeed.mean, 2, 10)} ${formatNumber(report.mlxEngine.pureGenSpeed.median, 2, 10)} ${formatNumber(report.mlxEngine.pureGenSpeed.p95, 2, 10)} ${formatNumber(report.mlxEngine.pureGenSpeed.p99, 2, 10)} ${formatNumber(report.mlxEngine.pureGenSpeed.min, 2, 10)} ${formatNumber(report.mlxEngine.pureGenSpeed.max, 2, 10)}`);
  console.log(`  Speedup: ${report.comparison.pureGenSpeedup.toFixed(3)}x ${report.comparison.pureGenSpeedup > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  // Summary
  console.log('═══ Summary ═══');
  console.log(`  Average Tokens: kr-mlx-lm ${report.krMlxLm.avgTokens.toFixed(1)}, mlx-engine ${report.mlxEngine.avgTokens.toFixed(1)}`);
  console.log(`  Output Consistency: ${((1 - report.comparison.outputConsistency) * 100).toFixed(1)}%`);

  // PRD Targets
  console.log('\n═══ PRD Performance Targets ═══');
  const ttftTarget = report.comparison.ttftSpeedup >= 0.83; // <= 1.2x slower
  const throughputTarget = report.comparison.throughputSpeedup >= 0.9; // >= 90%

  console.log(`  TTFT Target (≤ 1.2x mlx-engine):         ${ttftTarget ? '✓ PASS' : '✗ FAIL'} (${report.comparison.ttftSpeedup.toFixed(3)}x)`);
  console.log(`  Throughput Target (≥ 90% mlx-engine):   ${throughputTarget ? '✓ PASS' : '✗ FAIL'} (${(report.comparison.throughputSpeedup * 100).toFixed(1)}%)`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const conditions: TestConditions = {
    modelPath: 'models/llama-3.2-3b-instruct',
    modelId: 'llama-3.2-3b-instruct',
    prompt: 'Explain quantum computing in simple terms.',
    maxTokens: 100,
    temperature: 0.7,
    topP: 0.9,
  };

  const report = await runAppleToAppleComparison({
    conditions,
    runs: 10,
    warmupRuns: 2,
    randomizeOrder: true,
    verbose: true,
  });

  formatComparisonReport(report);

  // Export results
  const outputPath = new URL('./results/apple-to-apple-comparison.json', import.meta.url);
  await mkdir(new URL('./results', import.meta.url), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n\n📊 Results exported to: ${outputPath.pathname}\n`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
