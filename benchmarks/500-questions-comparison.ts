/**
 * 500 Questions Apple-to-Apple Benchmark
 * 
 * Extended benchmark with 500 questions (10x the 50-question set) to validate:
 * - Stability under extended workload
 * - Memory management over time
 * - Consistent performance across hundreds of requests
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration } from './utils.js';

// 50 diverse questions - we'll repeat 10x for 500 total
const BASE_QUESTIONS = [
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
  'What is climate change?',
  'Explain how computers process information.',
  'What is artificial intelligence?',
  'How do batteries store energy?',
  'What causes earthquakes?',
  'Explain the greenhouse effect.',
  'How does the human brain work?',
  'What is quantum mechanics?',
  'Describe the process of evolution.',
  'How do solar panels generate electricity?',
  'What is cryptocurrency?',
  'Explain machine learning basics.',
  'How do magnets work?',
  'What is the periodic table?',
  'Describe the nitrogen cycle.',
  'How does GPS technology work?',
  'What are antibiotics and how do they work?',
  'Explain the carbon cycle.',
  'How do rockets reach space?',
  'What is the ozone layer?',
  'Describe nuclear fusion.',
  'How do plants make food?',
  'What causes gravity?',
  'Explain the water cycle in detail.',
  'How do electric cars work?',
  'What is the theory of plate tectonics?',
  'Describe how lasers work.',
  'What is the speed of light?',
  'How do telescopes help us see distant objects?',
  'What are enzymes?',
  'Explain the concept of entropy.',
  'How does 5G technology differ from 4G?',
  'What is the nitrogen cycle?',
  'Describe the process of mitosis.',
  'How do wind turbines generate electricity?',
  'What is the Doppler effect?',
  'Explain neural networks in simple terms.',
  'How does the heart pump blood?',
  'What are tectonic plates?',
  'Describe the electromagnetic spectrum.',
];

// Generate 500 questions by repeating base set 10 times
const QUESTIONS = Array.from({ length: 10 }, () => BASE_QUESTIONS).flat();

const MODEL_PATH = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 50;

interface QuestionResult {
  questionNumber: number;
  question: string;
  engine: 'kr-serve-mlx' | 'mlx-engine';
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

  console.log('  Model loaded, starting benchmark...\n');
  await engine.loadModel({ model: MODEL_PATH });

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
        output,
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

    // Progress update every 50 questions
    if ((i + 1) % 50 === 0) {
      const successCount = results.filter(r => r.success).length;
      const successRate = (successCount / results.length) * 100;
      console.log(`\n  Progress: ${i + 1}/${QUESTIONS.length} (${successRate.toFixed(1)}% success)\n`);
    }
  }

  await engine.shutdown();
  return results;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        500 Questions Apple-to-Apple Benchmark                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Test Configuration:');
  console.log(`  Model: llama-3.2-3b-instruct`);
  console.log(`  Path: ${MODEL_PATH}`);
  console.log(`  Questions: 500`);
  console.log(`  Max Tokens per Question: ${MAX_TOKENS}\n\n`);

  console.log('📊 Testing kr-serve-mlx (500 questions)...\n');
  const benchmarkStart = performance.now();
  const krResults = await benchmarkKrServeMlx();
  const benchmarkEnd = performance.now();
  const totalTime = (benchmarkEnd - benchmarkStart) / 1000;

  console.log(`\n✅ kr-serve-mlx completed in ${totalTime.toFixed(2)}s\n`);

  // Calculate statistics
  const successfulResults = krResults.filter(r => r.success);
  const responseTimes = successfulResults.map(r => r.metrics.totalTimeMs);
  const ttfts = successfulResults.map(r => r.metrics.ttftMs);
  const throughputs = successfulResults.map(r => r.metrics.throughputTokensPerSec);
  const tokens = successfulResults.map(r => r.metrics.totalTokens);
  const avgTokens = tokens.reduce((a, b) => a + b, 0) / tokens.length;
  const successRate = (successfulResults.length / krResults.length) * 100;

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           500 Questions Benchmark Results                    ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log(`Model: llama-3.2-3b-instruct`);
  console.log(`Total Questions: 500`);
  console.log(`Success Rate: ${successRate.toFixed(1)}%\n`);

  const respStats = calculateStatistics(responseTimes);
  const ttftStats = calculateStatistics(ttfts);
  const throughputStats = calculateStatistics(throughputs);

  console.log('═══ Average Response Time per Question ═══');
  console.log(`  Mean:   ${respStats.mean.toFixed(2)} ms`);
  console.log(`  Median: ${respStats.median.toFixed(2)} ms`);
  console.log(`  P95:    ${respStats.p95.toFixed(2)} ms`);
  console.log(`  P99:    ${respStats.p99.toFixed(2)} ms`);
  console.log(`  Min:    ${respStats.min.toFixed(2)} ms`);
  console.log(`  Max:    ${respStats.max.toFixed(2)} ms\n`);

  console.log('═══ Average Time To First Token ═══');
  console.log(`  Mean:   ${ttftStats.mean.toFixed(2)} ms`);
  console.log(`  Median: ${ttftStats.median.toFixed(2)} ms`);
  console.log(`  P95:    ${ttftStats.p95.toFixed(2)} ms`);
  console.log(`  P99:    ${ttftStats.p99.toFixed(2)} ms\n`);

  console.log('═══ Average Throughput ═══');
  console.log(`  Mean:   ${throughputStats.mean.toFixed(2)} tok/s`);
  console.log(`  Median: ${throughputStats.median.toFixed(2)} tok/s\n`);

  console.log('═══ Total Time for 500 Questions ═══');
  console.log(`  Total:  ${totalTime.toFixed(2)}s`);
  console.log(`  Average Tokens per Question: ${avgTokens.toFixed(1)}`);
  console.log(`  Total Tokens Generated: ${tokens.reduce((a, b) => a + b, 0)}\n`);

  // Export results
  const reportPath = 'benchmarks/results/500-questions-benchmark.json';
  await mkdir('benchmarks/results', { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      modelId: 'llama-3.2-3b-instruct',
      totalQuestions: 500,
      successRate,
      avgResponseTime: respStats,
      avgTTFT: ttftStats,
      avgThroughput: throughputStats,
      avgTokens,
      totalTime,
      rawResults: krResults,
    }, null, 2)
  );

  console.log(`📊 Results exported to: ${reportPath}\n`);
}

main().catch(console.error);
