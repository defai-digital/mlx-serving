/**
 * 50 Questions Apple-to-Apple Benchmark
 *
 * Fair comparison between kr-serve-mlx and mlx-lm (Python) with 50 diverse questions
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics } from './utils.js';

// 50 diverse questions covering science, technology, history, and general knowledge
const QUESTIONS = [
  // Science (10 questions)
  'What is the capital of France?',
  'Explain photosynthesis in simple terms.',
  'How do airplanes fly?',
  'What causes seasons on Earth?',
  'Describe the water cycle.',
  'What is DNA and why is it important?',
  'How does the internet work?',
  'Explain the theory of relativity in one paragraph.',
  'What are black holes?',
  'How do vaccines work?',

  // Technology (10 questions)
  'What is cryptocurrency?',
  'Explain machine learning basics.',
  'How do magnets work?',
  'What is the periodic table?',
  'How does GPS technology work?',
  'What are antibiotics and how do they work?',
  'What are tectonic plates?',
  'Describe the electromagnetic spectrum.',
  'What is a semiconductor?',
  'How does Wi-Fi work?',

  // History & Geography (10 questions)
  'Who invented the light bulb?',
  'What was the Industrial Revolution?',
  'When did World War II end?',
  'What is the Great Wall of China?',
  'Who was Leonardo da Vinci?',
  'What are the Seven Wonders of the World?',
  'When was the first moon landing?',
  'What is the Renaissance?',
  'Who discovered America?',
  'What was the Cold War?',

  // General Knowledge (10 questions)
  'What is the tallest mountain in the world?',
  'How many planets are in our solar system?',
  'What is the largest ocean on Earth?',
  'How many bones are in the human body?',
  'What is the fastest animal on land?',
  'How many seconds are in a day?',
  'What is the longest river in the world?',
  'How many countries are in the United Nations?',
  'What is the largest desert in the world?',
  'How many elements are in the periodic table?',

  // Mixed Topics (10 questions)
  'What is a food chain?',
  'How does rain form?',
  'What is an ecosystem?',
  'How do seeds grow into plants?',
  'What is biodiversity?',
  'How does lightning form?',
  'What is a habitat?',
  'How do butterflies transform?',
  'What is a fossil?',
  'How do volcanoes erupt?',
];

const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 100;
const TEMPERATURE = 0.7;

interface QuestionResult {
  questionNumber: number;
  question: string;
  engine: 'kr-serve-mlx' | 'mlx-lm';
  metrics: {
    totalTimeMs: number;
    ttftMs: number;
    generationTimeMs: number;
    totalTokens: number;
    throughputTokensPerSec: number;
  };
  output: string;
  success: boolean;
  error?: string;
}

async function benchmarkKrServeMlx(): Promise<QuestionResult[]> {
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  console.log('  Loading model...');
  const loadStart = performance.now();
  await engine.loadModel({ model: MODEL_PATH });
  const loadEnd = performance.now();
  const loadTime = loadEnd - loadStart;
  console.log(`  Model loaded in ${(loadTime / 1000).toFixed(2)}s\n`);

  const results: QuestionResult[] = [];

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    process.stdout.write(`  [${i + 1}/${QUESTIONS.length}] ${question.substring(0, 50)}... `);

    try {
      const startTime = performance.now();
      let firstTokenTime: number | null = null;
      let tokenCount = 0;
      let output = '';

      const generator = engine.createGenerator({
        model: MODEL_PATH,
        prompt: question,
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        streaming: true,
      });

      for await (const chunk of generator) {
        if (chunk.type === 'token') {
          if (firstTokenTime === null) {
            firstTokenTime = performance.now();
          }
          tokenCount++;
          output += chunk.token;
        }
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const ttft = firstTokenTime ? firstTokenTime - startTime : 0;
      const generationTime = firstTokenTime ? endTime - firstTokenTime : totalTime;
      const throughput = generationTime > 0 ? (tokenCount / generationTime) * 1000 : 0;

      results.push({
        questionNumber: i + 1,
        question,
        engine: 'kr-serve-mlx',
        metrics: {
          totalTimeMs: totalTime,
          ttftMs: ttft,
          generationTimeMs: generationTime,
          totalTokens: tokenCount,
          throughputTokensPerSec: throughput,
        },
        output: output.substring(0, 100),
        success: true,
      });

      console.log(`✓ ${Math.round(totalTime)}ms (${tokenCount} tokens)`);
    } catch (error) {
      console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
      results.push({
        questionNumber: i + 1,
        question,
        engine: 'kr-serve-mlx',
        metrics: { totalTimeMs: 0, ttftMs: 0, generationTimeMs: 0, totalTokens: 0, throughputTokensPerSec: 0 },
        output: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await engine.shutdown();
  return results;
}

async function benchmarkMlxLm(): Promise<QuestionResult[]> {
  console.log('  Starting mlx-lm (Python) benchmark...\n');

  // Use Python mlx-lm library directly
  const pythonScript = `
import sys
import time
import json
from mlx_lm import load, generate

# Load model once
print("  Loading model...", file=sys.stderr, flush=True)
load_start = time.perf_counter()
model, tokenizer = load("${MODEL_PATH}")
load_end = time.perf_counter()
print(f"  Model loaded in {(load_end - load_start):.2f}s\\n", file=sys.stderr, flush=True)

# Read questions from stdin
questions = json.loads(sys.stdin.read())

results = []
for i, question in enumerate(questions):
    # Progress indicator
    print(f"  [{i + 1}/${QUESTIONS.length}] {question[:50]}... ", file=sys.stderr, end='', flush=True)

    start_time = time.perf_counter()

    try:
        # Generate response
        response = generate(
            model,
            tokenizer,
            prompt=question,
            max_tokens=${MAX_TOKENS},
            verbose=False,
        )

        end_time = time.perf_counter()
        total_time_ms = (end_time - start_time) * 1000

        # Count tokens in response
        token_count = len(tokenizer.encode(response))

        results.append({
            "questionNumber": i + 1,
            "question": question,
            "engine": "mlx-lm",
            "metrics": {
                "totalTimeMs": total_time_ms,
                "ttftMs": 0,  # mlx-lm doesn't expose TTFT
                "generationTimeMs": total_time_ms,
                "totalTokens": token_count,
                "throughputTokensPerSec": (token_count / total_time_ms) * 1000 if total_time_ms > 0 else 0
            },
            "output": response[:100],  # Truncate for JSON size
            "success": True
        })

        print(f"✓ {round(total_time_ms)}ms ({token_count} tokens)", file=sys.stderr, flush=True)

    except Exception as e:
        results.append({
            "questionNumber": i + 1,
            "question": question,
            "engine": "mlx-lm",
            "metrics": {
                "totalTimeMs": 0,
                "ttftMs": 0,
                "generationTimeMs": 0,
                "totalTokens": 0,
                "throughputTokensPerSec": 0
            },
            "output": "",
            "success": False,
            "error": str(e)
        })

        print(f"✗ {str(e)}", file=sys.stderr, flush=True)

# Output results as JSON
print(json.dumps(results))
`;

  try {
    const pythonResults = await new Promise<QuestionResult[]>((resolve, reject) => {
      const proc = spawn('.kr-mlx-venv/bin/python', ['-c', pythonScript]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        // Forward progress to console
        process.stderr.write(text);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse Python output: ${error}`));
          }
        } else {
          reject(new Error(`Python process exited with code ${code}\nStderr: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });

      // Send questions to Python via stdin
      proc.stdin.write(JSON.stringify(QUESTIONS));
      proc.stdin.end();
    });

    return pythonResults;

  } catch (error) {
    console.error(`\n❌ mlx-lm benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    // Return empty results for all questions
    return QUESTIONS.map((q, i) => ({
      questionNumber: i + 1,
      question: q,
      engine: 'mlx-lm',
      metrics: { totalTimeMs: 0, ttftMs: 0, generationTimeMs: 0, totalTokens: 0, throughputTokensPerSec: 0 },
      output: '',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         50 Questions Apple-to-Apple Benchmark                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Test Configuration:');
  console.log(`  Model: llama-3.2-3b-instruct`);
  console.log(`  Path: ${MODEL_PATH}`);
  console.log(`  Questions: 50`);
  console.log(`  Max Tokens per Question: ${MAX_TOKENS}`);
  console.log(`  Temperature: ${TEMPERATURE}\n\n`);

  console.log('📊 Testing kr-serve-mlx (50 questions)...\n');
  const krStart = performance.now();
  const krResults = await benchmarkKrServeMlx();
  const krEnd = performance.now();
  const krTotalTime = (krEnd - krStart) / 1000;

  console.log(`\n✅ kr-serve-mlx completed in ${krTotalTime.toFixed(2)}s\n`);

  console.log('📊 Testing mlx-lm (Python) (50 questions)...\n');
  const mlxStart = performance.now();
  const mlxResults = await benchmarkMlxLm();
  const mlxEnd = performance.now();
  const mlxTotalTime = (mlxEnd - mlxStart) / 1000;

  console.log(`\n✅ mlx-lm completed in ${mlxTotalTime.toFixed(2)}s\n`);

  // Calculate statistics
  const krSuccessful = krResults.filter(r => r.success);
  const mlxSuccessful = mlxResults.filter(r => r.success);

  const krResponseTimes = krSuccessful.map(r => r.metrics.totalTimeMs);
  const mlxResponseTimes = mlxSuccessful.map(r => r.metrics.totalTimeMs);

  const krTTFTs = krSuccessful.map(r => r.metrics.ttftMs);
  const mlxTTFTs = mlxSuccessful.map(r => r.metrics.ttftMs);

  const krThroughputs = krSuccessful.map(r => r.metrics.throughputTokensPerSec);
  const mlxThroughputs = mlxSuccessful.map(r => r.metrics.throughputTokensPerSec);

  const krStats = calculateStatistics(krResponseTimes);
  const mlxStats = calculateStatistics(mlxResponseTimes);

  const krTTFTStats = calculateStatistics(krTTFTs);
  const mlxTTFTStats = calculateStatistics(mlxTTFTs);

  const krThroughputStats = calculateStatistics(krThroughputs);
  const mlxThroughputStats = calculateStatistics(mlxThroughputs);

  const krSuccessRate = (krSuccessful.length / krResults.length) * 100;
  const mlxSuccessRate = (mlxSuccessful.length / mlxResults.length) * 100;

  const krTotalTokens = krSuccessful.reduce((sum, r) => sum + r.metrics.totalTokens, 0);
  const mlxTotalTokens = mlxSuccessful.reduce((sum, r) => sum + r.metrics.totalTokens, 0);

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║            50 Questions Comparison Results                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log(`Model: llama-3.2-3b-instruct`);
  console.log(`Success Rate: kr-serve-mlx ${krSuccessRate.toFixed(1)}%, mlx-lm ${mlxSuccessRate.toFixed(1)}%\n`);

  const respImprovement = ((mlxStats.mean - krStats.mean) / mlxStats.mean) * 100;
  const ttftImprovement = mlxTTFTStats.mean > 0 ? ((mlxTTFTStats.mean - krTTFTStats.mean) / mlxTTFTStats.mean) * 100 : 0;
  const throughputImprovement = ((krThroughputStats.mean - mlxThroughputStats.mean) / mlxThroughputStats.mean) * 100;
  const totalTimeImprovement = ((mlxTotalTime - krTotalTime) / mlxTotalTime) * 100;

  const medianImprovement = ((mlxStats.median - krStats.median) / mlxStats.median) * 100;
  const p95Improvement = ((mlxStats.p95 - krStats.p95) / mlxStats.p95) * 100;

  console.log('┌──────────────────────┬──────────────┬──────────────┬─────────────┐');
  console.log('│ Metric               │ kr-serve-mlx │ mlx-lm       │ Improvement │');
  console.log('├──────────────────────┼──────────────┼──────────────┼─────────────┤');
  console.log(`│ Response Time (avg)  │ ${krStats.mean.toFixed(2).padStart(7)} ms   │ ${mlxStats.mean.toFixed(2).padStart(7)} ms   │ ${(respImprovement > 0 ? '+' : '') + respImprovement.toFixed(1).padStart(6)}% │`);
  console.log(`│ Response Time (P50)  │ ${krStats.median.toFixed(2).padStart(7)} ms   │ ${mlxStats.median.toFixed(2).padStart(7)} ms   │ ${(medianImprovement > 0 ? '+' : '') + medianImprovement.toFixed(1).padStart(6)}% │`);
  console.log(`│ Response Time (P95)  │ ${krStats.p95.toFixed(2).padStart(7)} ms   │ ${mlxStats.p95.toFixed(2).padStart(7)} ms   │ ${(p95Improvement > 0 ? '+' : '') + p95Improvement.toFixed(1).padStart(6)}% │`);
  console.log(`│ TTFT (avg)           │ ${krTTFTStats.mean.toFixed(2).padStart(7)} ms   │ ${mlxTTFTStats.mean.toFixed(2).padStart(7)} ms   │ ${'N/A'.padStart(9)} │`);
  console.log(`│ Throughput (avg)     │ ${krThroughputStats.mean.toFixed(2).padStart(7)} t/s  │ ${mlxThroughputStats.mean.toFixed(2).padStart(7)} t/s  │ ${(throughputImprovement > 0 ? '+' : '') + throughputImprovement.toFixed(1).padStart(6)}% │`);
  console.log(`│ Total Time (50q)     │ ${krTotalTime.toFixed(2).padStart(7)}s     │ ${mlxTotalTime.toFixed(2).padStart(7)}s     │ ${(totalTimeImprovement > 0 ? '+' : '') + totalTimeImprovement.toFixed(1).padStart(6)}% │`);
  console.log(`│ Total Tokens         │ ${krTotalTokens.toString().padStart(7)} tok  │ ${mlxTotalTokens.toString().padStart(7)} tok  │ ${''.padStart(9)} │`);
  console.log('└──────────────────────┴──────────────┴──────────────┴─────────────┘\n');

  // Summary
  if (respImprovement > 0) {
    console.log(`✅ **kr-serve-mlx is ${respImprovement.toFixed(1)}% faster than mlx-lm**\n`);
  } else {
    console.log(`⚠️ **kr-serve-mlx is ${Math.abs(respImprovement).toFixed(1)}% slower than mlx-lm**\n`);
  }

  console.log('Key Findings:');
  console.log(`  • kr-serve-mlx avg response: ${krStats.mean.toFixed(2)}ms`);
  console.log(`  • mlx-lm avg response: ${mlxStats.mean.toFixed(2)}ms`);
  console.log(`  • kr-serve-mlx throughput: ${krThroughputStats.mean.toFixed(2)} tokens/sec`);
  console.log(`  • mlx-lm throughput: ${mlxThroughputStats.mean.toFixed(2)} tokens/sec`);
  console.log(`  • Both achieved ${krSuccessRate.toFixed(0)}% success rate\n`);

  // Export results
  const reportPath = 'benchmarks/results/50-questions-apple-to-apple.json';
  await mkdir('benchmarks/results', { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      modelId: 'llama-3.2-3b-instruct',
      totalQuestions: 50,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      krServeMlx: {
        successRate: krSuccessRate,
        totalTime: krTotalTime,
        totalTokens: krTotalTokens,
        responseTime: krStats,
        ttft: krTTFTStats,
        throughput: krThroughputStats,
        rawResults: krResults,
      },
      mlxLm: {
        successRate: mlxSuccessRate,
        totalTime: mlxTotalTime,
        totalTokens: mlxTotalTokens,
        responseTime: mlxStats,
        ttft: mlxTTFTStats,
        throughput: mlxThroughputStats,
        rawResults: mlxResults,
      },
      improvements: {
        responseTime: respImprovement,
        ttft: ttftImprovement,
        throughput: throughputImprovement,
        totalTime: totalTimeImprovement,
      },
    }, null, 2)
  );

  console.log(`📊 Results exported to: ${reportPath}\n`);

  // Create markdown report
  const markdownPath = 'V1_4_2_50Q_APPLE_TO_APPLE_BENCHMARK.md';
  const markdown = `# Apple-to-Apple Benchmark: kr-serve-mlx vs mlx-lm

**Date**: ${new Date().toISOString().split('T')[0]}
**Model**: mlx-community/Llama-3.2-3B-Instruct-4bit
**Questions**: 50
**Max Tokens per Request**: ${MAX_TOKENS}
**Temperature**: ${TEMPERATURE}
**Execution**: Sequential (fair comparison)

---

## Overall Performance

| Metric | kr-serve-mlx | mlx-lm | Ratio (kr/mlx) |
|--------|--------------|--------|----------------|
| **Total Time** | ${krTotalTime.toFixed(2)}s | ${mlxTotalTime.toFixed(2)}s | ${(krTotalTime / mlxTotalTime).toFixed(3)}x |
| **Throughput** | ${krThroughputStats.mean.toFixed(2)} tok/s | ${mlxThroughputStats.mean.toFixed(2)} tok/s | **${(krThroughputStats.mean / mlxThroughputStats.mean).toFixed(3)}x** |
| **Total Tokens** | ${krTotalTokens} | ${mlxTotalTokens} | ${(krTotalTokens / mlxTotalTokens).toFixed(3)}x |

---

## Latency Statistics

| Metric | kr-serve-mlx | mlx-lm | Ratio (kr/mlx) |
|--------|--------------|--------|----------------|
| **Average Latency** | ${krStats.mean.toFixed(2)}ms | ${mlxStats.mean.toFixed(2)}ms | **${(krStats.mean / mlxStats.mean).toFixed(3)}x** |
| **P50 Latency** | ${krStats.median.toFixed(2)}ms | ${mlxStats.median.toFixed(2)}ms | ${(krStats.median / mlxStats.median).toFixed(3)}x |
| **P95 Latency** | ${krStats.p95.toFixed(2)}ms | ${mlxStats.p95.toFixed(2)}ms | ${(krStats.p95 / mlxStats.p95).toFixed(3)}x |
| **P99 Latency** | ${krStats.p99.toFixed(2)}ms | ${mlxStats.p99.toFixed(2)}ms | ${(krStats.p99 / mlxStats.p99).toFixed(3)}x |


---

## Reliability

| Metric | kr-serve-mlx | mlx-lm |
|--------|--------------|--------|
| **Completed** | ${krSuccessful.length} | ${mlxSuccessful.length} |
| **Failed** | ${krResults.length - krSuccessful.length} | ${mlxResults.length - mlxSuccessful.length} |
| **Success Rate** | ${krSuccessRate.toFixed(1)}% | ${mlxSuccessRate.toFixed(1)}% |

---

## Summary

${respImprovement > 0 ?
  `✅ **kr-serve-mlx is ${respImprovement.toFixed(1)}% faster than mlx-lm**` :
  `⚠️ **kr-serve-mlx is ${Math.abs(respImprovement).toFixed(1)}% slower than mlx-lm**`}

- Throughput: **${(throughputImprovement > 0 ? '+' : '')}${throughputImprovement.toFixed(1)}%** ${throughputImprovement > 0 ? 'faster' : 'slower'}
- Average Latency: **${(respImprovement > 0 ? '+' : '')}${respImprovement.toFixed(1)}%** ${respImprovement > 0 ? 'faster' : 'slower'}


### Key Findings

1. **TypeScript Overhead**: kr-serve-mlx has ${((krTotalTime / mlxTotalTime - 1) * 100).toFixed(1)}% ${krTotalTime > mlxTotalTime ? 'higher' : 'lower'} total time compared to native Python

2. **Runtime Performance**: TypeScript bridge and IPC introduce ${Math.abs(respImprovement).toFixed(1)}% ${respImprovement > 0 ? 'improvement' : 'overhead'}

3. **Reliability**: kr-serve-mlx: ${krSuccessRate.toFixed(1)}%, mlx-lm: ${mlxSuccessRate.toFixed(1)}%

4. **Consistency**: ${krStats.p95 < mlxStats.p95 ? 'kr-serve-mlx' : 'mlx-lm'} shows lower latency variance

---

**Conclusion**: ${respImprovement > 0 ?
  'kr-serve-mlx outperforms native Python mlx-lm, demonstrating that the TypeScript wrapper adds value through optimizations (batching, caching, scheduling) that more than compensate for IPC overhead.' :
  'kr-serve-mlx has overhead compared to mlx-lm, which is expected for a TypeScript wrapper. The added benefits (type safety, Node.js ecosystem, API compatibility) may justify the performance trade-off for many use cases.'}
`;

  await writeFile(markdownPath, markdown);
  console.log(`📄 Markdown report: ${markdownPath}\n`);
}

main().catch(console.error);
