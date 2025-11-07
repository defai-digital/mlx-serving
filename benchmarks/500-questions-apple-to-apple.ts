/**
 * 500 Questions Apple-to-Apple Benchmark
 *
 * Compares kr-serve-mlx vs mlx-engine on 500 diverse questions.
 * Tests identical conditions for fair comparison:
 * - Same model path and configuration
 * - Same 500 questions in same order
 * - Same generation parameters
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

/**
 * Test kr-serve-mlx on all 500 questions
 */
async function benchmarkKrServeMlx(): Promise<QuestionResult[]> {
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  console.log('  Loading model...');
  await engine.loadModel({ model: MODEL_PATH });
  console.log('  Model loaded, starting benchmark...\n');

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

/**
 * Test mlx-engine on all 500 questions
 */
async function benchmarkMlxEngine(mlxEnginePath: string): Promise<QuestionResult[]> {
  console.log('  Starting mlx-engine benchmark...\n');

  const results: QuestionResult[] = [];

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    process.stdout.write(`  [${i + 1}/${QUESTIONS.length}] ${question.substring(0, 50)}... `);

    try {
      const result = await testMlxEngineSingle(question, i + 1, mlxEnginePath);
      results.push(result);

      if (result.success) {
        console.log(`✓ ${Math.round(result.metrics.totalTimeMs)}ms (${result.metrics.totalTokens} tokens)`);
      } else {
        console.log(`✗ ${result.error}`);
      }
    } catch (error) {
      console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
      results.push({
        questionNumber: i + 1,
        question,
        engine: 'mlx-engine',
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

  return results;
}

/**
 * Test mlx-engine on a single question
 */
async function testMlxEngineSingle(
  question: string,
  questionNumber: number,
  mlxEnginePath: string
): Promise<QuestionResult> {
  return new Promise((resolve) => {
    const pythonScript = `
import sys
import time
import json
sys.path.insert(0, '${mlxEnginePath}')

from mlx_engine.generate import load_model, create_generator, tokenize

# Load model (will be cached after first load)
model_kit = load_model('${MODEL_PATH}', trust_remote_code=False)

# Tokenize prompt
prompt_tokens = tokenize(model_kit, '''${question.replace(/'/g, "\\'")}''')

# Measure generation
gen_start = time.time()
first_token_time = None
total_tokens = 0
generated_text = ''

generator = create_generator(
    model_kit,
    prompt_tokens,
    max_tokens=${MAX_TOKENS},
    temp=0.0
)

for result in generator:
    if first_token_time is None:
        first_token_time = time.time()

    total_tokens += len(result.tokens)
    generated_text += result.text

gen_end = time.time()

# Calculate metrics
total_time = gen_end - gen_start
ttft = (first_token_time - gen_start) if first_token_time else 0
generation_time = total_time - ttft

throughput = (total_tokens / total_time) if total_time > 0 else 0

# Output stats as JSON
stats = {
    'total_time_ms': total_time * 1000,
    'ttft_ms': ttft * 1000,
    'generation_time_ms': generation_time * 1000,
    'total_tokens': total_tokens,
    'throughput': throughput,
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
          questionNumber,
          question,
          engine: 'mlx-engine',
          metrics: { totalTimeMs: 0, ttftMs: 0, generationTimeMs: 0, totalTokens: 0, throughputTokensPerSec: 0 },
          output: '',
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
            questionNumber,
            question,
            engine: 'mlx-engine',
            metrics: {
              totalTimeMs: stats.total_time_ms,
              ttftMs: stats.ttft_ms,
              generationTimeMs: stats.generation_time_ms,
              totalTokens: stats.total_tokens,
              throughputTokensPerSec: stats.throughput,
            },
            output: stats.generated_text,
            success: true,
          });
          return;
        } catch (e) {
          // Fall through
        }
      }

      resolve({
        questionNumber,
        question,
        engine: 'mlx-engine',
        metrics: { totalTimeMs: 0, ttftMs: 0, generationTimeMs: 0, totalTokens: 0, throughputTokensPerSec: 0 },
        output: '',
        success: false,
        error: 'Failed to parse stats',
      });
    });
  });
}

async function main() {
  const mlxEnginePath = process.env.MLX_ENGINE_PATH || '/tmp/mlx-engine';

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     500 Questions Apple-to-Apple Comparison Benchmark       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Test Configuration:');
  console.log(`  Model: llama-3.2-3b-instruct`);
  console.log(`  Path: ${MODEL_PATH}`);
  console.log(`  Questions: 500`);
  console.log(`  Max Tokens per Question: ${MAX_TOKENS}`);
  console.log(`  mlx-engine Path: ${mlxEnginePath}\n\n`);

  // Test kr-serve-mlx
  console.log('📊 Testing kr-serve-mlx (500 questions)...\n');
  const krStartTime = performance.now();
  const krResults = await benchmarkKrServeMlx();
  const krEndTime = performance.now();
  const krTotalTime = (krEndTime - krStartTime) / 1000;
  console.log(`\n✅ kr-serve-mlx completed in ${krTotalTime.toFixed(2)}s\n`);

  // Test mlx-engine
  console.log('📊 Testing mlx-engine (500 questions)...\n');
  const mlxStartTime = performance.now();
  const mlxResults = await benchmarkMlxEngine(mlxEnginePath);
  const mlxEndTime = performance.now();
  const mlxTotalTime = (mlxEndTime - mlxStartTime) / 1000;
  console.log(`\n✅ mlx-engine completed in ${mlxTotalTime.toFixed(2)}s\n`);

  // Calculate statistics for kr-serve-mlx
  const krSuccessful = krResults.filter(r => r.success);
  const krSuccessRate = (krSuccessful.length / krResults.length) * 100;
  const krResponseTimes = krSuccessful.map(r => r.metrics.totalTimeMs);
  const krTtfts = krSuccessful.map(r => r.metrics.ttftMs);
  const krThroughputs = krSuccessful.map(r => r.metrics.throughputTokensPerSec);
  const krTokens = krSuccessful.map(r => r.metrics.totalTokens);
  const krAvgTokens = krTokens.reduce((a, b) => a + b, 0) / krTokens.length;

  // Calculate statistics for mlx-engine
  const mlxSuccessful = mlxResults.filter(r => r.success);
  const mlxSuccessRate = (mlxSuccessful.length / mlxResults.length) * 100;
  const mlxResponseTimes = mlxSuccessful.map(r => r.metrics.totalTimeMs);
  const mlxTtfts = mlxSuccessful.map(r => r.metrics.ttftMs);
  const mlxThroughputs = mlxSuccessful.map(r => r.metrics.throughputTokensPerSec);
  const mlxTokens = mlxSuccessful.map(r => r.metrics.totalTokens);
  const mlxAvgTokens = mlxTokens.reduce((a, b) => a + b, 0) / mlxTokens.length;

  // Calculate stats
  const krRespStats = calculateStatistics(krResponseTimes);
  const krTtftStats = calculateStatistics(krTtfts);
  const krThroughputStats = calculateStatistics(krThroughputs);

  const mlxRespStats = calculateStatistics(mlxResponseTimes);
  const mlxTtftStats = calculateStatistics(mlxTtfts);
  const mlxThroughputStats = calculateStatistics(mlxThroughputs);

  // Print results
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║      500 Questions Apple-to-Apple Comparison Results        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log(`Model: llama-3.2-3b-instruct`);
  console.log(`Total Questions: 500\n`);

  console.log('═══ Success Rate ═══');
  console.log(`  kr-serve-mlx: ${krSuccessRate.toFixed(1)}% (${krSuccessful.length}/500)`);
  console.log(`  mlx-engine:   ${mlxSuccessRate.toFixed(1)}% (${mlxSuccessful.length}/500)\n`);

  console.log('═══ Response Time per Question ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-serve-mlx    ${krRespStats.mean.toFixed(2).padEnd(12)} ${krRespStats.median.toFixed(2).padEnd(12)} ${krRespStats.p95.toFixed(2).padEnd(12)} ${krRespStats.p99.toFixed(2).padEnd(12)} ${krRespStats.min.toFixed(2).padEnd(12)} ${krRespStats.max.toFixed(2)}`);
  console.log(`  mlx-engine      ${mlxRespStats.mean.toFixed(2).padEnd(12)} ${mlxRespStats.median.toFixed(2).padEnd(12)} ${mlxRespStats.p95.toFixed(2).padEnd(12)} ${mlxRespStats.p99.toFixed(2).padEnd(12)} ${mlxRespStats.min.toFixed(2).padEnd(12)} ${mlxRespStats.max.toFixed(2)}`);
  console.log(`  Speedup: ${(mlxRespStats.mean / krRespStats.mean).toFixed(3)}x ${mlxRespStats.mean / krRespStats.mean > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  console.log('═══ Time To First Token ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-serve-mlx    ${krTtftStats.mean.toFixed(2).padEnd(12)} ${krTtftStats.median.toFixed(2).padEnd(12)} ${krTtftStats.p95.toFixed(2).padEnd(12)} ${krTtftStats.p99.toFixed(2).padEnd(12)} ${krTtftStats.min.toFixed(2).padEnd(12)} ${krTtftStats.max.toFixed(2)}`);
  console.log(`  mlx-engine      ${mlxTtftStats.mean.toFixed(2).padEnd(12)} ${mlxTtftStats.median.toFixed(2).padEnd(12)} ${mlxTtftStats.p95.toFixed(2).padEnd(12)} ${mlxTtftStats.p99.toFixed(2).padEnd(12)} ${mlxTtftStats.min.toFixed(2).padEnd(12)} ${mlxTtftStats.max.toFixed(2)}`);
  console.log(`  Speedup: ${(mlxTtftStats.mean / krTtftStats.mean).toFixed(3)}x ${mlxTtftStats.mean / krTtftStats.mean > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  console.log('═══ Throughput (tokens/s) ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(`  kr-serve-mlx    ${krThroughputStats.mean.toFixed(2).padEnd(12)} ${krThroughputStats.median.toFixed(2).padEnd(12)} ${krThroughputStats.p95.toFixed(2).padEnd(12)} ${krThroughputStats.p99.toFixed(2).padEnd(12)} ${krThroughputStats.min.toFixed(2).padEnd(12)} ${krThroughputStats.max.toFixed(2)}`);
  console.log(`  mlx-engine      ${mlxThroughputStats.mean.toFixed(2).padEnd(12)} ${mlxThroughputStats.median.toFixed(2).padEnd(12)} ${mlxThroughputStats.p95.toFixed(2).padEnd(12)} ${mlxThroughputStats.p99.toFixed(2).padEnd(12)} ${mlxThroughputStats.min.toFixed(2).padEnd(12)} ${mlxThroughputStats.max.toFixed(2)}`);
  console.log(`  Speedup: ${(krThroughputStats.mean / mlxThroughputStats.mean).toFixed(3)}x ${krThroughputStats.mean / mlxThroughputStats.mean > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  console.log('═══ Total Time for 500 Questions ═══');
  console.log(`  kr-serve-mlx: ${krTotalTime.toFixed(2)}s`);
  console.log(`  mlx-engine:   ${mlxTotalTime.toFixed(2)}s`);
  console.log(`  Speedup: ${(mlxTotalTime / krTotalTime).toFixed(3)}x ${mlxTotalTime / krTotalTime > 1 ? '(kr faster ✓)' : '(mlx faster)'}\n`);

  console.log('═══ Tokens Generated ═══');
  console.log(`  kr-serve-mlx: ${krTokens.reduce((a, b) => a + b, 0)} tokens (avg ${krAvgTokens.toFixed(1)}/question)`);
  console.log(`  mlx-engine:   ${mlxTokens.reduce((a, b) => a + b, 0)} tokens (avg ${mlxAvgTokens.toFixed(1)}/question)\n`);

  // Export results
  const reportPath = 'benchmarks/results/500-questions-apple-to-apple.json';
  await mkdir('benchmarks/results', { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      modelId: 'llama-3.2-3b-instruct',
      totalQuestions: 500,
      krServeMlx: {
        successRate: krSuccessRate,
        avgResponseTime: krRespStats,
        avgTTFT: krTtftStats,
        avgThroughput: krThroughputStats,
        avgTokens: krAvgTokens,
        totalTime: krTotalTime,
        totalTokens: krTokens.reduce((a, b) => a + b, 0),
        rawResults: krResults,
      },
      mlxEngine: {
        successRate: mlxSuccessRate,
        avgResponseTime: mlxRespStats,
        avgTTFT: mlxTtftStats,
        avgThroughput: mlxThroughputStats,
        avgTokens: mlxAvgTokens,
        totalTime: mlxTotalTime,
        totalTokens: mlxTokens.reduce((a, b) => a + b, 0),
        rawResults: mlxResults,
      },
      comparison: {
        responseTimeSpeedup: mlxRespStats.mean / krRespStats.mean,
        ttftSpeedup: mlxTtftStats.mean / krTtftStats.mean,
        throughputSpeedup: krThroughputStats.mean / mlxThroughputStats.mean,
        totalTimeSpeedup: mlxTotalTime / krTotalTime,
      },
    }, null, 2)
  );

  console.log(`📊 Results exported to: ${reportPath}\n`);
}

main().catch(console.error);
