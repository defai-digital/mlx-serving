#!/usr/bin/env tsx
/**
 * Apple-to-Apple Benchmark: kr-serve-mlx vs mlx-engine
 *
 * Compares performance for 200 questions under identical conditions:
 * - Same model (Llama-3.2-3B-Instruct-4bit)
 * - Same questions (200 varied prompts)
 * - Same max_tokens (100)
 * - Same temperature (0.7)
 * - Sequential execution (fair comparison)
 *
 * Metrics:
 * - Total time
 * - Throughput (tokens/sec)
 * - Average TTFT (time to first token)
 * - Average latency per request
 * - P50, P95, P99 latencies
 */

import { createEngine } from '../dist/index.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Test configuration
const MODEL_ID = 'mlx-community/Llama-3.2-3B-Instruct-4bit';
const NUM_QUESTIONS = 200;
const MAX_TOKENS = 100;
const TEMPERATURE = 0.7;

// Generate 200 varied questions
function generateQuestions(count: number): string[] {
  const templates = [
    'What is the capital of {}?',
    'Explain the concept of {} in simple terms.',
    'Write a short poem about {}.',
    'What are the benefits of {}?',
    'How does {} work?',
    'Compare {} and machine learning.',
    'What is the history of {}?',
    'Describe {} in one paragraph.',
    'What are common misconceptions about {}?',
    'How can I learn more about {}?',
  ];

  const topics = [
    'quantum computing', 'artificial intelligence', 'renewable energy', 'blockchain',
    'climate change', 'space exploration', 'genetic engineering', 'cybersecurity',
    'virtual reality', 'nanotechnology', 'robotics', 'biotechnology',
    'autonomous vehicles', 'neural networks', 'cloud computing', 'data science',
    'cryptography', 'augmented reality', 'edge computing', 'Internet of Things',
    'solar energy', 'wind power', 'electric vehicles', 'sustainable agriculture',
    'ocean conservation', 'rainforest preservation', 'recycling technology',
    'green architecture', 'carbon capture', 'biofuels', 'hydroelectric power',
    'geothermal energy', 'fusion energy', 'battery technology', 'smart grids',
    'quantum mechanics', 'string theory', 'dark matter', 'black holes',
    'exoplanets', 'Mars exploration', 'asteroid mining', 'space stations',
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

// Benchmark kr-serve-mlx
async function benchmarkKrServe(questions: string[]): Promise<BenchmarkResult> {
  console.log('\n🚀 Benchmarking kr-serve-mlx...\n');

  const engine = await createEngine();

  try {
    // Load model
    console.log('Loading model...');
    const loadStart = Date.now();
    await engine.loadModel({
      model: MODEL_ID,
      maxTokens: MAX_TOKENS,
    });
    const loadTime = Date.now() - loadStart;
    console.log(`✓ Model loaded in ${loadTime}ms\n`);

    // Run benchmark
    const startTime = Date.now();
    const latencies: number[] = [];
    const ttfts: number[] = [];
    let totalTokens = 0;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      const requestStart = Date.now();
      let firstTokenTime: number | null = null;
      let tokenCount = 0;

      try {
        for await (const chunk of engine.createGenerator({
          modelId: MODEL_ID,
          prompt: question,
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        })) {
          if (firstTokenTime === null) {
            firstTokenTime = Date.now() - requestStart;
            ttfts.push(firstTokenTime);
          }
          tokenCount++;
        }

        const latency = Date.now() - requestStart;
        latencies.push(latency);
        totalTokens += tokenCount;
        completed++;

        if ((i + 1) % 20 === 0) {
          console.log(`Progress: ${i + 1}/${questions.length} (${Math.round((i + 1) / questions.length * 100)}%)`);
        }
      } catch (error) {
        console.error(`✗ Request ${i + 1} failed:`, error);
        failed++;
      }
    }

    const totalTime = Date.now() - startTime;

    console.log(`\n✓ Completed ${completed}/${questions.length} requests`);
    if (failed > 0) {
      console.log(`✗ Failed: ${failed} requests`);
    }

    return {
      name: 'kr-serve-mlx',
      totalTime,
      totalTokens,
      completed,
      failed,
      latencies,
      ttfts,
      loadTime,
    };
  } finally {
    await engine.dispose();
  }
}

// Benchmark mlx-engine (Python)
async function benchmarkMlxEngine(questions: string[]): Promise<BenchmarkResult> {
  console.log('\n🐍 Benchmarking mlx-engine (Python)...\n');

  // Create Python benchmark script
  const pythonScript = `
import sys
import time
import json
from mlx_lm import load, generate

# Load model
print("Loading model...", file=sys.stderr)
load_start = time.time()
model, tokenizer = load("${MODEL_ID}")
load_time = (time.time() - load_start) * 1000
print(f"✓ Model loaded in {load_time:.0f}ms\\n", file=sys.stderr)

# Read questions from stdin
questions = json.loads(sys.stdin.read())

# Run benchmark
start_time = time.time()
latencies = []
ttfts = []
total_tokens = 0
completed = 0
failed = 0

for i, question in enumerate(questions):
    request_start = time.time()
    first_token_time = None
    token_count = 0

    try:
        # Generate response
        response = generate(
            model,
            tokenizer,
            prompt=question,
            max_tokens=${MAX_TOKENS},
            temp=${TEMPERATURE},
            verbose=False,
        )

        # Count tokens
        token_count = len(tokenizer.encode(response))

        # Record latency
        latency = (time.time() - request_start) * 1000
        latencies.append(latency)
        total_tokens += token_count
        completed += 1

        if (i + 1) % 20 == 0:
            pct = round((i + 1) / len(questions) * 100)
            print(f"Progress: {i + 1}/{len(questions)} ({pct}%)", file=sys.stderr)

    except Exception as e:
        print(f"✗ Request {i + 1} failed: {e}", file=sys.stderr)
        failed += 1

total_time = (time.time() - start_time) * 1000

print(f"\\n✓ Completed {completed}/{len(questions)} requests", file=sys.stderr)
if failed > 0:
    print(f"✗ Failed: {failed} requests", file=sys.stderr)

# Output results as JSON
result = {
    "totalTime": total_time,
    "totalTokens": total_tokens,
    "completed": completed,
    "failed": failed,
    "latencies": latencies,
    "ttfts": [],  # mlx-engine doesn't expose TTFT easily
    "loadTime": load_time,
}

print(json.dumps(result))
`;

  // Write Python script to temp file
  const tempFile = path.join('/tmp', 'mlx-engine-bench.py');
  fs.writeFileSync(tempFile, pythonScript);

  // Run Python benchmark
  return new Promise((resolve, reject) => {
    const python = spawn('.kr-mlx-venv/bin/python', [tempFile], {
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text); // Forward to console
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}\n${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          name: 'mlx-engine',
          ...result,
        });
      } catch (error) {
        reject(new Error(`Failed to parse Python output: ${error}\n${stdout}`));
      }
    });

    // Send questions to Python via stdin
    python.stdin.write(JSON.stringify(questions));
    python.stdin.end();
  });
}

// Calculate percentiles
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

// Calculate statistics
interface BenchmarkResult {
  name: string;
  totalTime: number;
  totalTokens: number;
  completed: number;
  failed: number;
  latencies: number[];
  ttfts: number[];
  loadTime: number;
}

interface Stats {
  name: string;
  totalTime: number;
  loadTime: number;
  throughput: number;
  avgLatency: number;
  avgTTFT: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  totalTokens: number;
  completed: number;
  failed: number;
  successRate: number;
}

function calculateStats(result: BenchmarkResult): Stats {
  const avgLatency = result.latencies.length > 0
    ? result.latencies.reduce((a, b) => a + b, 0) / result.latencies.length
    : 0;

  const avgTTFT = result.ttfts.length > 0
    ? result.ttfts.reduce((a, b) => a + b, 0) / result.ttfts.length
    : 0;

  const throughput = result.totalTokens / (result.totalTime / 1000);

  return {
    name: result.name,
    totalTime: result.totalTime,
    loadTime: result.loadTime,
    throughput,
    avgLatency,
    avgTTFT,
    p50Latency: percentile(result.latencies, 50),
    p95Latency: percentile(result.latencies, 95),
    p99Latency: percentile(result.latencies, 99),
    totalTokens: result.totalTokens,
    completed: result.completed,
    failed: result.failed,
    successRate: (result.completed / (result.completed + result.failed)) * 100,
  };
}

// Format number with commas
function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Print comparison table
function printComparison(krStats: Stats, mlxStats: Stats) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 BENCHMARK RESULTS - Apple to Apple Comparison');
  console.log('='.repeat(80));
  console.log(`\nModel: ${MODEL_ID}`);
  console.log(`Questions: ${NUM_QUESTIONS}`);
  console.log(`Max Tokens per Request: ${MAX_TOKENS}`);
  console.log(`Temperature: ${TEMPERATURE}`);
  console.log(`Execution: Sequential (fair comparison)`);

  console.log('\n' + '-'.repeat(80));
  console.log('OVERALL PERFORMANCE');
  console.log('-'.repeat(80));

  const comparison = (kr: number, mlx: number): string => {
    if (mlx === 0) return '—';
    const ratio = kr / mlx;
    const sign = ratio > 1 ? '📈' : ratio < 1 ? '📉' : '➖';
    return `${sign} ${ratio.toFixed(3)}x`;
  };

  console.log(`\n${'Metric'.padEnd(30)} ${'kr-serve-mlx'.padEnd(20)} ${'mlx-engine'.padEnd(20)} ${'Ratio'.padEnd(15)}`);
  console.log('-'.repeat(90));

  console.log(`${'Total Time'.padEnd(30)} ${formatNumber(krStats.totalTime) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.totalTime) + 'ms'.padEnd(20)} ${comparison(krStats.totalTime, mlxStats.totalTime)}`);
  console.log(`${'Load Time'.padEnd(30)} ${formatNumber(krStats.loadTime) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.loadTime) + 'ms'.padEnd(20)} ${comparison(krStats.loadTime, mlxStats.loadTime)}`);
  console.log(`${'Throughput (tok/s)'.padEnd(30)} ${formatNumber(krStats.throughput).padEnd(20)} ${formatNumber(mlxStats.throughput).padEnd(20)} ${comparison(krStats.throughput, mlxStats.throughput)}`);
  console.log(`${'Total Tokens'.padEnd(30)} ${formatNumber(krStats.totalTokens).padEnd(20)} ${formatNumber(mlxStats.totalTokens).padEnd(20)} ${comparison(krStats.totalTokens, mlxStats.totalTokens)}`);

  console.log('\n' + '-'.repeat(80));
  console.log('LATENCY STATISTICS');
  console.log('-'.repeat(80));

  console.log(`\n${'Metric'.padEnd(30)} ${'kr-serve-mlx'.padEnd(20)} ${'mlx-engine'.padEnd(20)} ${'Ratio'.padEnd(15)}`);
  console.log('-'.repeat(90));

  console.log(`${'Average Latency'.padEnd(30)} ${formatNumber(krStats.avgLatency) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.avgLatency) + 'ms'.padEnd(20)} ${comparison(krStats.avgLatency, mlxStats.avgLatency)}`);
  console.log(`${'P50 Latency'.padEnd(30)} ${formatNumber(krStats.p50Latency) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.p50Latency) + 'ms'.padEnd(20)} ${comparison(krStats.p50Latency, mlxStats.p50Latency)}`);
  console.log(`${'P95 Latency'.padEnd(30)} ${formatNumber(krStats.p95Latency) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.p95Latency) + 'ms'.padEnd(20)} ${comparison(krStats.p95Latency, mlxStats.p95Latency)}`);
  console.log(`${'P99 Latency'.padEnd(30)} ${formatNumber(krStats.p99Latency) + 'ms'.padEnd(20)} ${formatNumber(mlxStats.p99Latency) + 'ms'.padEnd(20)} ${comparison(krStats.p99Latency, mlxStats.p99Latency)}`);

  if (krStats.avgTTFT > 0) {
    console.log(`${'Average TTFT'.padEnd(30)} ${formatNumber(krStats.avgTTFT) + 'ms'.padEnd(20)} ${'N/A'.padEnd(20)} ${'—'.padEnd(15)}`);
  }

  console.log('\n' + '-'.repeat(80));
  console.log('RELIABILITY');
  console.log('-'.repeat(80));

  console.log(`\n${'Metric'.padEnd(30)} ${'kr-serve-mlx'.padEnd(20)} ${'mlx-engine'.padEnd(20)}`);
  console.log('-'.repeat(75));

  console.log(`${'Completed'.padEnd(30)} ${krStats.completed.toString().padEnd(20)} ${mlxStats.completed.toString().padEnd(20)}`);
  console.log(`${'Failed'.padEnd(30)} ${krStats.failed.toString().padEnd(20)} ${mlxStats.failed.toString().padEnd(20)}`);
  console.log(`${'Success Rate'.padEnd(30)} ${formatNumber(krStats.successRate) + '%'.padEnd(20)} ${formatNumber(mlxStats.successRate) + '%'.padEnd(20)}`);

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const throughputRatio = krStats.throughput / mlxStats.throughput;
  const latencyRatio = krStats.avgLatency / mlxStats.avgLatency;

  console.log(`\n✓ kr-serve-mlx throughput: ${throughputRatio > 1 ? '📈' : '📉'} ${throughputRatio.toFixed(3)}x vs mlx-engine`);
  console.log(`✓ kr-serve-mlx latency: ${latencyRatio < 1 ? '📈' : '📉'} ${latencyRatio.toFixed(3)}x vs mlx-engine`);

  if (throughputRatio > 1) {
    console.log(`\n🎉 kr-serve-mlx is FASTER than mlx-engine!`);
  } else if (throughputRatio > 0.95) {
    console.log(`\n✅ kr-serve-mlx performance is COMPARABLE to mlx-engine (within 5%)`);
  } else {
    console.log(`\n⚠️  kr-serve-mlx is slower than mlx-engine`);
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

// Save results to markdown report
function saveReport(krStats: Stats, mlxStats: Stats, outputPath: string) {
  const throughputRatio = krStats.throughput / mlxStats.throughput;
  const latencyRatio = krStats.avgLatency / mlxStats.avgLatency;

  const report = `# Apple-to-Apple Benchmark: kr-serve-mlx vs mlx-engine

**Date**: ${new Date().toISOString().split('T')[0]}
**Model**: ${MODEL_ID}
**Questions**: ${NUM_QUESTIONS}
**Max Tokens per Request**: ${MAX_TOKENS}
**Temperature**: ${TEMPERATURE}
**Execution**: Sequential (fair comparison)

---

## Overall Performance

| Metric | kr-serve-mlx | mlx-engine | Ratio (kr/mlx) |
|--------|--------------|------------|----------------|
| **Total Time** | ${formatNumber(krStats.totalTime)}ms | ${formatNumber(mlxStats.totalTime)}ms | ${(krStats.totalTime / mlxStats.totalTime).toFixed(3)}x |
| **Load Time** | ${formatNumber(krStats.loadTime)}ms | ${formatNumber(mlxStats.loadTime)}ms | ${(krStats.loadTime / mlxStats.loadTime).toFixed(3)}x |
| **Throughput** | ${formatNumber(krStats.throughput)} tok/s | ${formatNumber(mlxStats.throughput)} tok/s | **${throughputRatio.toFixed(3)}x** |
| **Total Tokens** | ${formatNumber(krStats.totalTokens)} | ${formatNumber(mlxStats.totalTokens)} | ${(krStats.totalTokens / mlxStats.totalTokens).toFixed(3)}x |

---

## Latency Statistics

| Metric | kr-serve-mlx | mlx-engine | Ratio (kr/mlx) |
|--------|--------------|------------|----------------|
| **Average Latency** | ${formatNumber(krStats.avgLatency)}ms | ${formatNumber(mlxStats.avgLatency)}ms | **${latencyRatio.toFixed(3)}x** |
| **P50 Latency** | ${formatNumber(krStats.p50Latency)}ms | ${formatNumber(mlxStats.p50Latency)}ms | ${(krStats.p50Latency / mlxStats.p50Latency).toFixed(3)}x |
| **P95 Latency** | ${formatNumber(krStats.p95Latency)}ms | ${formatNumber(mlxStats.p95Latency)}ms | ${(krStats.p95Latency / mlxStats.p95Latency).toFixed(3)}x |
| **P99 Latency** | ${formatNumber(krStats.p99Latency)}ms | ${formatNumber(mlxStats.p99Latency)}ms | ${(krStats.p99Latency / mlxStats.p99Latency).toFixed(3)}x |
${krStats.avgTTFT > 0 ? `| **Average TTFT** | ${formatNumber(krStats.avgTTFT)}ms | N/A | — |\n` : ''}

---

## Reliability

| Metric | kr-serve-mlx | mlx-engine |
|--------|--------------|------------|
| **Completed** | ${krStats.completed} | ${mlxStats.completed} |
| **Failed** | ${krStats.failed} | ${mlxStats.failed} |
| **Success Rate** | ${formatNumber(krStats.successRate)}% | ${formatNumber(mlxStats.successRate)}% |

---

## Summary

${throughputRatio > 1 ? `🎉 **kr-serve-mlx is FASTER than mlx-engine!**

- Throughput: **${throughputRatio.toFixed(3)}x** (${((throughputRatio - 1) * 100).toFixed(1)}% faster)
- Average Latency: **${latencyRatio.toFixed(3)}x** (${latencyRatio < 1 ? ((1 - latencyRatio) * 100).toFixed(1) + '% faster' : ((latencyRatio - 1) * 100).toFixed(1) + '% slower'})
` : throughputRatio > 0.95 ? `✅ **kr-serve-mlx performance is COMPARABLE to mlx-engine** (within 5%)

- Throughput: **${throughputRatio.toFixed(3)}x** (${((1 - throughputRatio) * 100).toFixed(1)}% difference)
- Average Latency: **${latencyRatio.toFixed(3)}x** (${((latencyRatio - 1) * 100).toFixed(1)}% difference)
` : `⚠️ **kr-serve-mlx is slower than mlx-engine**

- Throughput: **${throughputRatio.toFixed(3)}x** (${((1 - throughputRatio) * 100).toFixed(1)}% slower)
- Average Latency: **${latencyRatio.toFixed(3)}x** (${((latencyRatio - 1) * 100).toFixed(1)}% slower)
`}

### Key Findings

1. **TypeScript Overhead**: ${krStats.loadTime > mlxStats.loadTime ? `kr-serve-mlx has ${((krStats.loadTime / mlxStats.loadTime - 1) * 100).toFixed(1)}% higher load time due to TypeScript bridge and IPC` : `kr-serve-mlx load time is comparable to mlx-engine`}

2. **Runtime Performance**: ${throughputRatio > 1 ? `kr-serve-mlx achieves higher throughput, demonstrating efficient bridge and batching` : throughputRatio > 0.95 ? `kr-serve-mlx runtime performance matches mlx-engine (< 5% overhead)` : `TypeScript bridge and IPC introduce ${((1 - throughputRatio) * 100).toFixed(1)}% overhead`}

3. **Reliability**: ${krStats.successRate === 100 && mlxStats.successRate === 100 ? `Both implementations achieved 100% success rate` : `kr-serve-mlx: ${formatNumber(krStats.successRate)}%, mlx-engine: ${formatNumber(mlxStats.successRate)}%`}

4. **Consistency**: ${krStats.p99Latency / krStats.p50Latency < mlxStats.p99Latency / mlxStats.p50Latency ? `kr-serve-mlx shows lower latency variance (P99/P50 ratio: ${(krStats.p99Latency / krStats.p50Latency).toFixed(2)} vs ${(mlxStats.p99Latency / mlxStats.p50Latency).toFixed(2)})` : `mlx-engine shows lower latency variance`}

---

**Conclusion**: ${throughputRatio > 1 ? `kr-serve-mlx outperforms mlx-engine in this benchmark, demonstrating that the TypeScript layer adds value through optimizations like batching and caching while maintaining high performance.` : throughputRatio > 0.95 ? `kr-serve-mlx achieves comparable performance to mlx-engine with minimal overhead (<5%), validating the TypeScript bridge design while adding type safety and Node.js integration.` : `kr-serve-mlx has overhead compared to mlx-engine, which is expected for a TypeScript wrapper. The added benefits (type safety, Node.js ecosystem, API compatibility) may justify the performance trade-off for many use cases.`}
`;

  fs.writeFileSync(outputPath, report);
  console.log(`\n📄 Report saved to: ${outputPath}\n`);
}

// Main benchmark
async function main() {
  console.log('=' .repeat(80));
  console.log('🏁 Apple-to-Apple Benchmark: kr-serve-mlx vs mlx-engine');
  console.log('='.repeat(80));
  console.log(`\nConfiguration:`);
  console.log(`  Model: ${MODEL_ID}`);
  console.log(`  Questions: ${NUM_QUESTIONS}`);
  console.log(`  Max Tokens: ${MAX_TOKENS}`);
  console.log(`  Temperature: ${TEMPERATURE}`);
  console.log(`  Execution: Sequential (fair comparison)\n`);

  // Generate questions
  console.log('Generating questions...');
  const questions = generateQuestions(NUM_QUESTIONS);
  console.log(`✓ Generated ${questions.length} questions\n`);

  try {
    // Benchmark kr-serve-mlx
    const krResult = await benchmarkKrServe(questions);
    const krStats = calculateStats(krResult);

    // Benchmark mlx-engine
    const mlxResult = await benchmarkMlxEngine(questions);
    const mlxStats = calculateStats(mlxResult);

    // Print comparison
    printComparison(krStats, mlxStats);

    // Save report
    const reportPath = path.join(process.cwd(), 'V1_4_2_200Q_APPLE_TO_APPLE_BENCHMARK.md');
    saveReport(krStats, mlxStats, reportPath);

    // Exit successfully
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
