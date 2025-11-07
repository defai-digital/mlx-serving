/**
 * 100 Questions Apple-to-Apple Benchmark
 *
 * Comprehensive comparison with 100 diverse questions to measure:
 * - Average response time
 * - Token generation consistency
 * - Overall throughput
 * - TTFT variance across different prompts
 * - Statistical significance with larger sample size
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration } from './utils.js';

/**
 * 100 diverse questions covering various topics and lengths
 */
const QUESTIONS = [
  // Science (20 questions)
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

  // Technology (20 questions)
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

  // Biology & Medicine (20 questions)
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
  'What is metabolism?',
  'How do muscles contract?',
  'Explain the immune system.',
  'What are stem cells?',
  'How does the digestive system work?',
  'What is genetic engineering?',
  'Describe the nervous system.',
  'How do hormones regulate body functions?',
  'What is cancer and how does it develop?',
  'Explain the circulatory system.',

  // Physics & Chemistry (20 questions)
  'What is atomic structure?',
  'How does sound travel?',
  'Explain states of matter.',
  'What are chemical reactions?',
  'How does electricity flow?',
  'What is thermodynamics?',
  'Describe molecular bonding.',
  'How do waves propagate?',
  'What is radioactivity?',
  'Explain the laws of motion.',
  'What is osmosis?',
  'How do semiconductors work?',
  'What are polymers?',
  'Describe the pH scale.',
  'How does diffusion occur?',
  'What is electromagnetic induction?',
  'Explain the principle of conservation of energy.',
  'What are isotopes?',
  'How does nuclear fission work?',
  'What is the difference between acids and bases?',

  // Computer Science & Math (20 questions)
  'What is an algorithm?',
  'Explain binary code.',
  'How do databases work?',
  'What is encryption?',
  'Describe cloud computing.',
  'How does the internet protocol work?',
  'What are data structures?',
  'Explain object-oriented programming.',
  'How do compilers work?',
  'What is a blockchain?',
  'Describe the concept of recursion.',
  'How does machine vision work?',
  'What are prime numbers?',
  'Explain probability theory.',
  'How does calculus work?',
  'What is linear algebra?',
  'Describe the concept of infinity.',
  'How do neural networks learn?',
  'What is cybersecurity?',
  'Explain the concept of big data.',
];

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

interface ComparisonReport {
  timestamp: string;
  modelId: string;
  totalQuestions: number;
  krMlxLm: {
    avgResponseTime: ReturnType<typeof calculateStatistics>;
    avgTTFT: ReturnType<typeof calculateStatistics>;
    avgThroughput: ReturnType<typeof calculateStatistics>;
    avgTokens: number;
    successRate: number;
    totalTime: number;
  };
  mlxEngine: {
    avgResponseTime: ReturnType<typeof calculateStatistics>;
    avgTTFT: ReturnType<typeof calculateStatistics>;
    avgThroughput: ReturnType<typeof calculateStatistics>;
    avgTokens: number;
    successRate: number;
    totalTime: number;
  };
  comparison: {
    responseTimeSpeedup: number;
    ttftSpeedup: number;
    throughputSpeedup: number;
    totalTimeSpeedup: number;
  };
  rawResults: QuestionResult[];
}

/**
 * Test kr-serve-mlx with a single question (REUSES ENGINE - DO NOT CREATE NEW ONE)
 */
async function testKrMlxLmQuestion(
  engine: Engine,
  modelPath: string,
  question: string,
  questionNumber: number,
  maxTokens: number
): Promise<QuestionResult> {
  try {
    // Measure generation only (model is already loaded)
    const genStart = performance.now();
    let ttftMs = 0;
    let firstToken = false;
    let totalTokens = 0;
    let generatedText = '';

    const generator = engine.createGenerator({
      model: modelPath,
      prompt: question,
      maxTokens,
      temperature: 0.7,
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

    const totalTimeMs = performance.now() - genStart;
    const generationTimeMs = totalTimeMs - ttftMs;
    const throughput = totalTimeMs > 0 ? (totalTokens / (totalTimeMs / 1000)) : 0;

    return {
      questionNumber,
      question,
      engine: 'kr-serve-mlx',
      metrics: {
        totalTimeMs,
        ttftMs,
        generationTimeMs,
        totalTokens,
        throughputTokensPerSec: throughput,
      },
      output: generatedText,
      success: true,
    };
  } catch (error) {
    return {
      questionNumber,
      question,
      engine: 'kr-serve-mlx',
      metrics: {
        totalTimeMs: 0,
        ttftMs: 0,
        generationTimeMs: 0,
        totalTokens: 0,
        throughputTokensPerSec: 0,
      },
      output: '',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run 100-question comparison
 */
export async function run100QuestionComparison(config: {
  modelPath: string;
  modelId: string;
  maxTokens?: number;
  mlxEnginePath?: string;
  verbose?: boolean;
}): Promise<ComparisonReport> {
  const {
    modelPath,
    modelId,
    maxTokens = 50,
    mlxEnginePath = '/tmp/mlx-engine',
    verbose = false,
  } = config;

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        100 Questions Apple-to-Apple Benchmark                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log('Test Configuration:');
  console.log(`  Model: ${modelId}`);
  console.log(`  Path: ${modelPath}`);
  console.log(`  Questions: ${QUESTIONS.length}`);
  console.log(`  Max Tokens per Question: ${maxTokens}`);
  console.log(`  mlx-engine Path: ${mlxEnginePath}`);
  console.log('');

  const allResults: QuestionResult[] = [];

  // Test kr-serve-mlx
  console.log('\n📊 Testing kr-serve-mlx (100 questions)...\n');

  // Create engine and load model ONCE
  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });
  await engine.loadModel({ model: modelPath });
  console.log('  Model loaded, starting benchmark...\n');

  const krStartTime = performance.now();

  for (let i = 0; i < QUESTIONS.length; i++) {
    if (verbose) {
      process.stdout.write(`  [${i + 1}/100] ${QUESTIONS[i].substring(0, 50)}... `);
    }

    const result = await testKrMlxLmQuestion(engine, modelPath, QUESTIONS[i], i + 1, maxTokens);
    allResults.push(result);

    if (verbose) {
      if (result.success) {
        console.log(`✓ ${result.metrics.totalTimeMs.toFixed(0)}ms (${result.metrics.totalTokens} tokens)`);
      } else {
        console.log(`✗ ${result.error}`);
      }
    }
  }

  const krTotalTime = performance.now() - krStartTime;

  // Shutdown engine after all questions
  await engine.shutdown();

  console.log(`\n✅ kr-serve-mlx completed in ${(krTotalTime / 1000).toFixed(2)}s\n`);

  // Test mlx-engine
  console.log('\n📊 Testing mlx-engine (100 questions)...\n');

  // Create Python script that loads model ONCE and tests all questions
  const pythonScript = `
import sys
import time
import json
sys.path.insert(0, '${mlxEnginePath}')

from mlx_engine.generate import load_model, create_generator, tokenize

# Load model ONCE
model_kit = load_model('${modelPath}', trust_remote_code=False)
print('  Model loaded, starting benchmark...\\n', file=sys.stderr)

questions = ${JSON.stringify(QUESTIONS)}
results = []

for i, question in enumerate(questions):
    # Tokenize prompt
    prompt_tokens = tokenize(model_kit, question)

    # Measure generation
    gen_start = time.time()
    first_token_time = None
    total_tokens = 0
    generated_text = ''

    generator = create_generator(
        model_kit,
        prompt_tokens,
        max_tokens=${maxTokens},
        temp=0.7
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

    results.append({
        'questionNumber': i + 1,
        'question': question,
        'metrics': {
            'total_time_ms': total_time * 1000,
            'ttft_ms': ttft * 1000,
            'generation_time_ms': generation_time * 1000,
            'total_tokens': total_tokens,
            'throughput': throughput
        },
        'output': generated_text,
        'success': True
    })

    print(f'  [{i+1}/100] {question[:50]}... ✓ {int(total_time * 1000)}ms ({total_tokens} tokens)', file=sys.stderr)

# Output all results as JSON
print('__RESULTS__' + json.dumps(results))
`;

  const mlxStartTime = performance.now();

  // Run Python script
  const python = spawn(`${mlxEnginePath}/.venv/bin/python`, ['-c', pythonScript], {
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
    if (verbose) {
      process.stderr.write(text);
    }
  });

  await new Promise<void>((resolve, reject) => {
    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}: ${stderr}`));
        return;
      }

      const resultsMatch = stdout.match(/__RESULTS__(.+)$/s);
      if (resultsMatch) {
        try {
          const results = JSON.parse(resultsMatch[1]);
          results.forEach((r: { questionNumber: number; question: string; metrics: { total_time_ms: number; ttft_ms: number; generation_time_ms: number; total_tokens: number; throughput: number }; output: string; success: boolean }) => {
            allResults.push({
              questionNumber: r.questionNumber,
              question: r.question,
              engine: 'mlx-engine',
              metrics: {
                totalTimeMs: r.metrics.total_time_ms,
                ttftMs: r.metrics.ttft_ms,
                generationTimeMs: r.metrics.generation_time_ms,
                totalTokens: r.metrics.total_tokens,
                throughputTokensPerSec: r.metrics.throughput,
              },
              output: r.output,
              success: r.success,
            });
          });
          resolve();
        } catch (e) {
          reject(new Error('Failed to parse results'));
        }
      } else {
        reject(new Error('No results found in output'));
      }
    });
  });

  const mlxTotalTime = performance.now() - mlxStartTime;
  console.log(`\n✅ mlx-engine completed in ${(mlxTotalTime / 1000).toFixed(2)}s\n`);

  // Analyze results
  const krResults = allResults.filter((r) => r.engine === 'kr-serve-mlx' && r.success);
  const mlxResults = allResults.filter((r) => r.engine === 'mlx-engine' && r.success);

  if (krResults.length === 0 || mlxResults.length === 0) {
    throw new Error('Not enough successful results for comparison');
  }

  const krResponseTimes = krResults.map((r) => r.metrics.totalTimeMs);
  const krTTFTs = krResults.map((r) => r.metrics.ttftMs);
  const krThroughputs = krResults.map((r) => r.metrics.throughputTokensPerSec);
  const krTotalTokens = krResults.reduce((sum, r) => sum + r.metrics.totalTokens, 0);
  const krAvgTokens = krTotalTokens / krResults.length;

  const mlxResponseTimes = mlxResults.map((r) => r.metrics.totalTimeMs);
  const mlxTTFTs = mlxResults.map((r) => r.metrics.ttftMs);
  const mlxThroughputs = mlxResults.map((r) => r.metrics.throughputTokensPerSec);
  const mlxTotalTokens = mlxResults.reduce((sum, r) => sum + r.metrics.totalTokens, 0);
  const mlxAvgTokens = mlxTotalTokens / mlxResults.length;

  const krResponseStats = calculateStatistics(krResponseTimes);
  const krTTFTStats = calculateStatistics(krTTFTs);
  const krThroughputStats = calculateStatistics(krThroughputs);

  const mlxResponseStats = calculateStatistics(mlxResponseTimes);
  const mlxTTFTStats = calculateStatistics(mlxTTFTs);
  const mlxThroughputStats = calculateStatistics(mlxThroughputs);

  // Calculate speedups
  const responseTimeSpeedup = mlxResponseStats.mean / krResponseStats.mean;
  const ttftSpeedup = mlxTTFTStats.mean / krTTFTStats.mean;
  const throughputSpeedup = krThroughputStats.mean / mlxThroughputStats.mean;
  const totalTimeSpeedup = mlxTotalTime / krTotalTime;

  const report: ComparisonReport = {
    timestamp: new Date().toISOString(),
    modelId,
    totalQuestions: QUESTIONS.length,
    krMlxLm: {
      avgResponseTime: krResponseStats,
      avgTTFT: krTTFTStats,
      avgThroughput: krThroughputStats,
      avgTokens: krAvgTokens,
      successRate: (krResults.length / QUESTIONS.length) * 100,
      totalTime: krTotalTime,
    },
    mlxEngine: {
      avgResponseTime: mlxResponseStats,
      avgTTFT: mlxTTFTStats,
      avgThroughput: mlxThroughputStats,
      avgTokens: mlxAvgTokens,
      successRate: (mlxResults.length / QUESTIONS.length) * 100,
      totalTime: mlxTotalTime,
    },
    comparison: {
      responseTimeSpeedup,
      ttftSpeedup,
      throughputSpeedup,
      totalTimeSpeedup,
    },
    rawResults: allResults,
  };

  // Print comparison report
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          100 Questions Comparison Results                    ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`Model: ${modelId}`);
  console.log(`Total Questions: ${QUESTIONS.length}`);
  console.log(
    `Success Rate: kr-serve-mlx ${report.krMlxLm.successRate.toFixed(0)}%, mlx-engine ${report.mlxEngine.successRate.toFixed(0)}%\n`
  );

  console.log('═══ Average Response Time per Question ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(
    `  kr-serve-mlx    ${formatDuration(krResponseStats.mean)}    ${formatDuration(krResponseStats.median)}    ${formatDuration(krResponseStats.p95)}    ${formatDuration(krResponseStats.p99)}    ${formatDuration(krResponseStats.min)}    ${formatDuration(krResponseStats.max)}`
  );
  console.log(
    `  mlx-engine      ${formatDuration(mlxResponseStats.mean)}    ${formatDuration(mlxResponseStats.median)}    ${formatDuration(mlxResponseStats.p95)}    ${formatDuration(mlxResponseStats.p99)}    ${formatDuration(mlxResponseStats.min)}    ${formatDuration(mlxResponseStats.max)}`
  );
  console.log(
    `  Speedup: ${responseTimeSpeedup.toFixed(3)}x (${responseTimeSpeedup > 1 ? 'kr faster ✓' : 'mlx faster'})\n`
  );

  console.log('═══ Average Time To First Token ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(
    `  kr-serve-mlx    ${formatDuration(krTTFTStats.mean)}    ${formatDuration(krTTFTStats.median)}    ${formatDuration(krTTFTStats.p95)}    ${formatDuration(krTTFTStats.p99)}    ${formatDuration(krTTFTStats.min)}    ${formatDuration(krTTFTStats.max)}`
  );
  console.log(
    `  mlx-engine      ${formatDuration(mlxTTFTStats.mean)}    ${formatDuration(mlxTTFTStats.median)}    ${formatDuration(mlxTTFTStats.p95)}    ${formatDuration(mlxTTFTStats.p99)}    ${formatDuration(mlxTTFTStats.min)}    ${formatDuration(mlxTTFTStats.max)}`
  );
  console.log(`  Speedup: ${ttftSpeedup.toFixed(3)}x (${ttftSpeedup > 1 ? 'kr faster ✓' : 'mlx faster'})\n`);

  console.log('═══ Average Throughput ═══');
  console.log('  Engine          Mean         Median       P95          P99          Min          Max');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  console.log(
    `  kr-serve-mlx        ${formatNumber(krThroughputStats.mean)}     ${formatNumber(krThroughputStats.median)}     ${formatNumber(krThroughputStats.p95)}     ${formatNumber(krThroughputStats.p99)}     ${formatNumber(krThroughputStats.min)}     ${formatNumber(krThroughputStats.max)}`
  );
  console.log(
    `  mlx-engine          ${formatNumber(mlxThroughputStats.mean)}     ${formatNumber(mlxThroughputStats.median)}     ${formatNumber(mlxThroughputStats.p95)}     ${formatNumber(mlxThroughputStats.p99)}     ${formatNumber(mlxThroughputStats.min)}     ${formatNumber(mlxThroughputStats.max)}`
  );
  console.log(
    `  Speedup: ${throughputSpeedup.toFixed(3)}x (${throughputSpeedup > 1 ? 'kr faster ✓' : 'mlx faster'})\n`
  );

  console.log('═══ Total Time for 100 Questions ═══');
  console.log(`  kr-serve-mlx:   ${(krTotalTime / 1000).toFixed(2)}s`);
  console.log(`  mlx-engine:     ${(mlxTotalTime / 1000).toFixed(2)}s`);
  console.log(
    `  Speedup: ${totalTimeSpeedup.toFixed(3)}x (${totalTimeSpeedup > 1 ? 'kr faster ✓' : 'mlx faster'})\n`
  );

  console.log('═══ Summary ═══');
  console.log(
    `  Average Tokens per Question: kr-serve-mlx ${krAvgTokens.toFixed(1)}, mlx-engine ${mlxAvgTokens.toFixed(1)}`
  );
  console.log(`  Total Tokens Generated: kr-serve-mlx ${krTotalTokens}, mlx-engine ${mlxTotalTokens}\n`);

  // Export results to JSON
  const resultsDir = './benchmarks/results';
  await mkdir(resultsDir, { recursive: true });
  const resultsPath = `${resultsDir}/100-questions-comparison.json`;
  await writeFile(resultsPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 Results exported to: ${resultsPath}`);

  return report;
}

// Run benchmark if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const modelPath = process.env.MODEL_PATH ?? 'models/llama-3.2-3b-instruct';
  const modelId = process.env.MODEL_ID ?? 'llama-3.2-3b-instruct';

  run100QuestionComparison({
    modelPath,
    modelId,
    maxTokens: 50,
    verbose: true,
  })
    .then(() => {
      console.log('\n✅ Benchmark completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Benchmark failed:', error);
      process.exit(1);
    });
}
