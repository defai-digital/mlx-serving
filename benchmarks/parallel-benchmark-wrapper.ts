#!/usr/bin/env tsx
/**
 * Parallel Benchmark Wrapper
 *
 * Runs benchmarks with true parallel execution for faster completion.
 * Uses Promise.all() to execute multiple requests concurrently.
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createEngine } from '../dist/index.js';
import {
  calculateStatistics,
  formatNumber,
  formatDuration,
  getSystemInfo,
  createProgressBar,
} from './utils.js';

interface BenchmarkConfig {
  model: string;
  questionCount: number;
  maxTokens: number;
  temperature: number;
  topP?: number;
  compareMode: 'mlx-serving' | 'mlx-engine' | 'both';
  outputPath?: string;
  verbose: boolean;
  concurrency: number; // NEW: Parallel request limit
}

interface QuestionResult {
  questionIndex: number;
  question: string;
  ttftMs: number;
  latencyMs: number;
  tokens: number;
  tokensPerSec: number;
  output: string;
  success: boolean;
  error?: string;
}

interface EngineResults {
  engineName: string;
  modelId: string;
  modelLoadTimeMs: number;
  totalTimeMs: number;
  totalTokens: number;
  completed: number;
  failed: number;
  questions: QuestionResult[];
  statistics: {
    latency: ReturnType<typeof calculateStatistics>;
    ttft: ReturnType<typeof calculateStatistics>;
    tokensPerSec: ReturnType<typeof calculateStatistics>;
    tokensPerRequest: ReturnType<typeof calculateStatistics>;
  };
}

interface BenchmarkReport {
  config: BenchmarkConfig;
  timestamp: string;
  systemInfo: ReturnType<typeof getSystemInfo>;
  mlxServing?: EngineResults;
  mlxEngine?: EngineResults;
  comparison?: {
    speedup: number;
    ttftSpeedup: number;
    latencySpeedup: number;
    winner: 'mlx-serving' | 'mlx-engine' | 'tie';
  };
}

// Question generation (same as flexible-benchmark)
function generateQuestions(count: number): string[] {
  const templates = [
    'What is {}?',
    'Explain {} in simple terms.',
    'Describe the key features of {}.',
    'What are the benefits of using {}?',
    'How does {} work?',
    'What are common applications of {}?',
    'Compare {} with traditional approaches.',
    'What is the history of {}?',
    'What are common misconceptions about {}?',
    'How can someone learn {}?',
  ];

  const topics = [
    'quantum computing', 'artificial intelligence', 'machine learning',
    'deep learning', 'neural networks', 'natural language processing',
    'computer vision', 'reinforcement learning', 'blockchain', 'cryptography',
    'cloud computing', 'edge computing', 'distributed systems', 'microservices',
    'containerization', 'kubernetes', 'serverless computing', 'DevOps',
    'continuous integration', 'test-driven development',
  ];

  const questions: string[] = [];
  let topicIndex = 0;
  let templateIndex = 0;

  for (let i = 0; i < count; i++) {
    const template = templates[templateIndex % templates.length];
    const topic = topics[topicIndex % topics.length];
    questions.push(template.replace('{}', topic));

    topicIndex++;
    if (topicIndex % topics.length === 0) {
      templateIndex++;
    }
  }

  return questions;
}

/**
 * Run benchmark with parallel execution using batches
 */
async function benchmarkMLXServingParallel(
  config: BenchmarkConfig,
  questions: string[]
): Promise<EngineResults> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Benchmarking mlx-serving (PARALLEL MODE)');
  console.log(`   Concurrency: ${config.concurrency} requests at a time`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const engine = await createEngine({
    telemetry: { enabled: false },
    rpcTimeout: 300000,
  });

  try {
    // Load model
    console.log(`Loading model: ${config.model}...`);
    const loadStart = Date.now();
    await engine.loadModel({
      model: config.model,
      maxTokens: config.maxTokens,
    });
    const modelLoadTimeMs = Date.now() - loadStart;
    console.log(`✓ Model loaded in ${formatDuration(modelLoadTimeMs)}\n`);

    // Run benchmark in parallel batches
    const startTime = Date.now();
    const results: QuestionResult[] = new Array(questions.length);
    let totalTokens = 0;
    let completed = 0;
    let failed = 0;

    console.log(`Running ${questions.length} questions with concurrency ${config.concurrency}...\n`);

    // Process in batches
    for (let batchStart = 0; batchStart < questions.length; batchStart += config.concurrency) {
      const batchEnd = Math.min(batchStart + config.concurrency, questions.length);
      const batchPromises: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const questionIndex = i;
        const question = questions[i];

        const promise = (async () => {
          const requestStart = Date.now();
          let firstTokenTime: number | null = null;
          let tokenCount = 0;
          let output = '';

          try {
            for await (const chunk of engine.createGenerator({
              model: config.model,
              prompt: question,
              maxTokens: config.maxTokens,
              temperature: config.temperature,
              topP: config.topP,
            })) {
              if (chunk.type === 'token') {
                if (chunk.token === '<pad>' || chunk.token.trim() === '') {
                  continue;
                }
                if (firstTokenTime === null) {
                  firstTokenTime = Date.now() - requestStart;
                }
                output += chunk.token;
                tokenCount++;
              }
            }

            const latencyMs = Date.now() - requestStart;
            const tokensPerSec = latencyMs > 0 ? (tokenCount / latencyMs) * 1000 : 0;

            results[questionIndex] = {
              questionIndex,
              question,
              ttftMs: firstTokenTime || 0,
              latencyMs,
              tokens: tokenCount,
              tokensPerSec,
              output,
              success: true,
            };

            totalTokens += tokenCount;
            completed++;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results[questionIndex] = {
              questionIndex,
              question,
              ttftMs: 0,
              latencyMs: Date.now() - requestStart,
              tokens: 0,
              tokensPerSec: 0,
              output: '',
              success: false,
              error,
            };
            failed++;
            if (config.verbose) {
              console.error(`✗ Question ${questionIndex + 1} failed: ${error}`);
            }
          }
        })();

        batchPromises.push(promise);
      }

      // Wait for batch to complete
      await Promise.all(batchPromises);

      // Progress update
      console.log(createProgressBar(batchEnd, questions.length));
    }

    const totalTimeMs = Date.now() - startTime;

    console.log(`\n✓ Completed ${completed}/${questions.length} requests`);
    if (failed > 0) {
      console.log(`✗ Failed: ${failed} requests`);
    }

    // Calculate statistics
    const successfulResults = results.filter((r) => r && r.success);
    const latencies = successfulResults.map((r) => r.latencyMs);
    const ttfts = successfulResults.map((r) => r.ttftMs);
    const throughputs = successfulResults.map((r) => r.tokensPerSec);
    const tokenCounts = successfulResults.map((r) => r.tokens);

    const statistics = {
      latency: calculateStatistics(latencies.length > 0 ? latencies : [0]),
      ttft: calculateStatistics(ttfts.length > 0 ? ttfts : [0]),
      tokensPerSec: calculateStatistics(throughputs.length > 0 ? throughputs : [0]),
      tokensPerRequest: calculateStatistics(tokenCounts.length > 0 ? tokenCounts : [0]),
    };

    return {
      engineName: 'mlx-serving',
      modelId: config.model,
      modelLoadTimeMs,
      totalTimeMs,
      totalTokens,
      completed,
      failed,
      questions: results,
      statistics,
    };
  } finally {
    await engine.dispose();
  }
}

/**
 * mlx-engine benchmark (sequential - Python doesn't support true parallelism due to GIL)
 */
async function benchmarkMLXEngine(
  config: BenchmarkConfig,
  questions: string[]
): Promise<EngineResults> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔧 Benchmarking mlx-engine (Python - Sequential)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const pythonScript = `
import sys
import json
import time
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

model_id = "${config.model}"
max_tokens = ${config.maxTokens}
temperature = ${config.temperature}
top_p = ${config.topP || 1.0}
questions = ${JSON.stringify(questions)}

results = {
    "engineName": "mlx-engine",
    "modelId": model_id,
    "questions": [],
    "totalTokens": 0,
    "completed": 0,
    "failed": 0
}

try:
    print(f"Loading model: {model_id}...", file=sys.stderr)
    load_start = time.time()
    model, tokenizer = load(model_id)
    model_load_time = (time.time() - load_start) * 1000
    results["modelLoadTimeMs"] = model_load_time
    print(f"✓ Model loaded in {model_load_time:.2f}ms\\n", file=sys.stderr)

    sampler = make_sampler(temp=temperature, top_p=top_p)
    benchmark_start = time.time()

    for i, question in enumerate(questions):
        request_start = time.time()
        question_result = {
            "questionIndex": i,
            "question": question,
            "success": False
        }

        try:
            response = generate(
                model=model,
                tokenizer=tokenizer,
                prompt=question,
                max_tokens=max_tokens,
                sampler=sampler,
                verbose=False
            )

            latency_ms = (time.time() - request_start) * 1000
            token_count = len(tokenizer.encode(response))
            tokens_per_sec = (token_count / latency_ms) * 1000 if latency_ms > 0 else 0

            question_result.update({
                "ttftMs": 0,
                "latencyMs": latency_ms,
                "tokens": token_count,
                "tokensPerSec": tokens_per_sec,
                "output": response,
                "success": True
            })

            results["totalTokens"] += token_count
            results["completed"] += 1

        except Exception as e:
            question_result.update({
                "ttftMs": 0,
                "latencyMs": (time.time() - request_start) * 1000,
                "tokens": 0,
                "tokensPerSec": 0,
                "output": "",
                "error": str(e)
            })
            results["failed"] += 1

        results["questions"].append(question_result)

        if (i + 1) % max(1, len(questions) // 10) == 0:
            progress = (i + 1) / len(questions) * 100
            print(f"Progress: {i + 1}/{len(questions)} ({progress:.0f}%)", file=sys.stderr)

    results["totalTimeMs"] = (time.time() - benchmark_start) * 1000
    print(json.dumps(results))

except Exception as e:
    print(f"ERROR: {str(e)}", file=sys.stderr)
    sys.exit(1)
`;

  const scriptPath = '/tmp/mlx-engine-benchmark-parallel.py';
  await writeFile(scriptPath, pythonScript);

  return new Promise<EngineResults>((resolve, reject) => {
    const python = spawn('.kr-mlx-venv/bin/python', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (config.verbose) {
        process.stderr.write(text);
      }
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}\n${stderr}`));
        return;
      }

      try {
        const results = JSON.parse(stdout);

        const successfulResults = results.questions.filter((r: QuestionResult) => r.success);
        const latencies = successfulResults.map((r: QuestionResult) => r.latencyMs);
        const ttfts = successfulResults.map((r: QuestionResult) => r.ttftMs);
        const throughputs = successfulResults.map((r: QuestionResult) => r.tokensPerSec);
        const tokenCounts = successfulResults.map((r: QuestionResult) => r.tokens);

        results.statistics = {
          latency: calculateStatistics(latencies.length > 0 ? latencies : [0]),
          ttft: calculateStatistics(ttfts.length > 0 ? ttfts : [0]),
          tokensPerSec: calculateStatistics(throughputs.length > 0 ? throughputs : [0]),
          tokensPerRequest: calculateStatistics(tokenCounts.length > 0 ? tokenCounts : [0]),
        };

        resolve(results);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err}\n${stdout}`));
      }
    });
  });
}

// Reporting functions
function printEngineResults(results: EngineResults): void {
  const totalThroughput = results.totalTimeMs > 0
    ? (results.totalTokens / results.totalTimeMs) * 1000
    : 0;

  console.log(`  Model Load Time:        ${formatDuration(results.modelLoadTimeMs)}`);
  console.log(`  Total Time:             ${formatDuration(results.totalTimeMs)}`);
  console.log(`  Total Tokens:           ${results.totalTokens}`);
  console.log(`  Completed:              ${results.completed}/${results.completed + results.failed}`);
  console.log(`  Success Rate:           ${formatNumber((results.completed / (results.completed + results.failed)) * 100, 1)}%`);
  console.log(`  Overall Throughput:     ${formatNumber(totalThroughput, 2)} tokens/sec`);
  console.log('');
  console.log('  Latency Statistics (ms):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.latency.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.latency.median, 2)}`);
  console.log(`    P95:                  ${formatNumber(results.statistics.latency.p95, 2)}`);
  console.log('');
  console.log('  TTFT Statistics (ms):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.ttft.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.ttft.median, 2)}`);
  console.log('');
  console.log('  Throughput Statistics (tokens/sec):');
  console.log(`    Mean:                 ${formatNumber(results.statistics.tokensPerSec.mean, 2)}`);
  console.log(`    Median (P50):         ${formatNumber(results.statistics.tokensPerSec.median, 2)}`);
  console.log('');
}

function printReport(report: BenchmarkReport): void {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    BENCHMARK RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Configuration:');
  console.log(`  Model:          ${report.config.model}`);
  console.log(`  Questions:      ${report.config.questionCount}`);
  console.log(`  Max Tokens:     ${report.config.maxTokens}`);
  console.log(`  Temperature:    ${report.config.temperature}`);
  console.log(`  Concurrency:    ${report.config.concurrency} (mlx-serving only)`);
  console.log(`  Compare Mode:   ${report.config.compareMode}`);
  console.log(`  Timestamp:      ${report.timestamp}`);
  console.log('');

  if (report.mlxServing) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('mlx-serving Results (Parallel):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    printEngineResults(report.mlxServing);
  }

  if (report.mlxEngine) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('mlx-engine Results (Sequential):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    printEngineResults(report.mlxEngine);
  }

  if (report.comparison) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Comparison:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Throughput Speedup:     ${formatNumber(report.comparison.speedup, 2)}x`);
    console.log(`  TTFT Speedup:           ${formatNumber(report.comparison.ttftSpeedup, 2)}x`);
    console.log(`  Latency Speedup:        ${formatNumber(report.comparison.latencySpeedup, 2)}x`);
    console.log(`  Winner:                 ${report.comparison.winner.toUpperCase()} 🏆`);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm', default: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit' },
      questions: { type: 'string', short: 'q', default: '200' },
      'max-tokens': { type: 'string', default: '100' },
      temperature: { type: 'string', short: 't', default: '0.7' },
      'top-p': { type: 'string' },
      compare: { type: 'string', short: 'c', default: 'both' },
      output: { type: 'string', short: 'o' },
      verbose: { type: 'boolean', short: 'v', default: false },
      concurrency: { type: 'string', default: '10' }, // NEW: Concurrent requests
    },
  });

  const config: BenchmarkConfig = {
    model: values.model as string,
    questionCount: parseInt(values.questions as string, 10),
    maxTokens: parseInt(values['max-tokens'] as string, 10),
    temperature: parseFloat(values.temperature as string),
    topP: values['top-p'] ? parseFloat(values['top-p'] as string) : undefined,
    compareMode: (values.compare as 'mlx-serving' | 'mlx-engine' | 'both') || 'both',
    outputPath: values.output as string,
    verbose: values.verbose as boolean,
    concurrency: parseInt(values.concurrency as string, 10),
  };

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     MLX PARALLEL BENCHMARK - Optimized Comparison             ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const questions = generateQuestions(config.questionCount);
  console.log(`✓ Generated ${questions.length} questions\n`);

  const report: BenchmarkReport = {
    config,
    timestamp: new Date().toISOString(),
    systemInfo: await getSystemInfo(),
  };

  try {
    if (config.compareMode === 'mlx-serving' || config.compareMode === 'both') {
      report.mlxServing = await benchmarkMLXServingParallel(config, questions);
    }

    if (config.compareMode === 'mlx-engine' || config.compareMode === 'both') {
      report.mlxEngine = await benchmarkMLXEngine(config, questions);
    }

    if (report.mlxServing && report.mlxEngine) {
      const servingThroughput = report.mlxServing.statistics.tokensPerSec.mean;
      const engineThroughput = report.mlxEngine.statistics.tokensPerSec.mean;
      const speedup = servingThroughput / engineThroughput;

      const servingTTFT = report.mlxServing.statistics.ttft.mean;
      const engineTTFT = report.mlxEngine.statistics.ttft.mean || servingTTFT;
      const ttftSpeedup = engineTTFT / servingTTFT;

      const servingLatency = report.mlxServing.statistics.latency.mean;
      const engineLatency = report.mlxEngine.statistics.latency.mean;
      const latencySpeedup = engineLatency / servingLatency;

      report.comparison = {
        speedup,
        ttftSpeedup,
        latencySpeedup,
        winner: speedup > 1.05 ? 'mlx-serving' : speedup < 0.95 ? 'mlx-engine' : 'tie',
      };
    }

    printReport(report);

    const outputPath = config.outputPath || `automatosx/tmp/qwen3-optimized-${config.questionCount}q-parallel.json`;
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`✓ Results saved to: ${outputPath}\n`);

  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
