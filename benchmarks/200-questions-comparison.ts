/**
 * 200 Questions Apple-to-Apple Benchmark
 *
 * Comprehensive comparison between kr-serve-mlx and mlx-engine with 200 diverse questions
 */

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { calculateStatistics, formatNumber, formatDuration } from './utils.js';

// 200 diverse questions covering science, technology, history, and general knowledge
const QUESTIONS = [
  // Science (40 questions)
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
  'What is the nitrogen cycle?',
  'Explain the carbon cycle.',
  'How do rockets reach space?',
  'What is the ozone layer?',
  'Describe nuclear fusion.',
  'How do plants make food?',
  'What causes gravity?',
  'How do electric cars work?',
  'What is the theory of plate tectonics?',
  'Describe how lasers work.',
  'What is the speed of light?',
  'How do telescopes help us see distant objects?',
  'What are enzymes?',
  'Explain the concept of entropy.',
  'How does 5G technology differ from 4G?',
  'Describe the process of mitosis.',
  'How do wind turbines generate electricity?',
  'What is the Doppler effect?',
  'Explain neural networks in simple terms.',
  'How does the heart pump blood?',

  // Technology (40 questions)
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
  'Explain cloud computing.',
  'What is blockchain technology?',
  'How do microprocessors work?',
  'What is virtual reality?',
  'Explain how 3D printing works.',
  'What is the Internet of Things?',
  'How does facial recognition work?',
  'What is quantum computing?',
  'Explain how MRI machines work.',
  'What is nanotechnology?',
  'How do electric motors work?',
  'What is renewable energy?',
  'Explain how fiber optics work.',
  'What is augmented reality?',
  'How do touchscreens work?',
  'What is biometric authentication?',
  'Explain how search engines work.',
  'What is edge computing?',
  'How do lithium-ion batteries work?',
  'What is deep learning?',
  'Explain how drones work.',
  'What is computer vision?',
  'How do smart homes work?',
  'What is natural language processing?',
  'Explain how voice assistants work.',
  'What is robotics?',
  'How do autonomous vehicles work?',
  'What is the difference between RAM and ROM?',
  'Explain how operating systems work.',
  'What is cybersecurity?',

  // History & Geography (40 questions)
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
  'When was the internet invented?',
  'What is the Silk Road?',
  'Who was Albert Einstein?',
  'What are the continents of the world?',
  'When did the Roman Empire fall?',
  'What is the Magna Carta?',
  'Who painted the Mona Lisa?',
  'What was the Space Race?',
  'When did humans start using fire?',
  'What is democracy?',
  'Who invented the telephone?',
  'What was the French Revolution?',
  'When was the printing press invented?',
  'What is the United Nations?',
  'Who was Isaac Newton?',
  'What are the oceans of the world?',
  'When did the dinosaurs go extinct?',
  'What is the European Union?',
  'Who discovered penicillin?',
  'What was the Apollo program?',
  'When was the first computer built?',
  'What is NATO?',
  'Who was Marie Curie?',
  'What are the Great Lakes?',
  'When did the Berlin Wall fall?',
  'What is the Panama Canal?',
  'Who invented the airplane?',
  'What was the Manhattan Project?',
  'When was the theory of evolution published?',
  'What is the Antarctic Treaty?',

  // General Knowledge (40 questions)
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
  'What is the deepest part of the ocean?',
  'How many time zones are there in the world?',
  'What is the largest rainforest in the world?',
  'How many chambers does the human heart have?',
  'What is the smallest country in the world?',
  'How many teeth do adults have?',
  'What is the brightest star in the sky?',
  'How many muscles are in the human body?',
  'What is the largest mammal in the world?',
  'How many chromosomes do humans have?',
  'What is the hottest planet in our solar system?',
  'How many layers does the Earth have?',
  'What is the most spoken language in the world?',
  'How many countries are in Africa?',
  'What is the largest island in the world?',
  'How many keys are on a standard piano?',
  'What is the coldest place on Earth?',
  'How many weeks are in a year?',
  'What is the largest lake in the world?',
  'How many strings does a guitar have?',
  'What is the most abundant element in the universe?',
  'How many continents are there?',
  'What is the longest bone in the human body?',
  'How many sides does a hexagon have?',
  'What is the smallest bone in the human body?',
  'How many degrees are in a circle?',
  'What is the capital of Australia?',
  'How many planets have rings?',
  'What is the fastest bird in flight?',
  'How many states are in the USA?',

  // Mixed Topics (40 questions)
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
  'What is a glacier?',
  'How do fish breathe underwater?',
  'What is a comet?',
  'How do bees make honey?',
  'What is a constellation?',
  'How do birds migrate?',
  'What is a prism?',
  'How do magnifying glasses work?',
  'What is a rainbow?',
  'How do mirrors reflect light?',
  'What is sound?',
  'How do echoes form?',
  'What is an atom?',
  'How do plants drink water?',
  'What is a molecule?',
  'How do lungs work?',
  'What is a cell?',
  'How does digestion work?',
  'What is a nucleus?',
  'How do muscles move?',
  'What is a protein?',
  'How does vision work?',
  'What is chlorophyll?',
  'How does hearing work?',
  'What is a gene?',
  'How does the immune system work?',
  'What is metabolism?',
  'How do nerves transmit signals?',
  'What is a hormone?',
  'How does blood clot?',
];

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

    // Progress update every 25 questions
    if ((i + 1) % 25 === 0) {
      const successCount = results.filter(r => r.success).length;
      const successRate = (successCount / results.length) * 100;
      console.log(`\n  Progress: ${i + 1}/${QUESTIONS.length} (${successRate.toFixed(1)}% success)\n`);
    }
  }

  await engine.shutdown();
  return results;
}

async function benchmarkMlxEngine(): Promise<QuestionResult[]> {
  console.log('  Starting mlx-lm (Python) benchmark...\n');

  const results: QuestionResult[] = [];

  // Use Python mlx-lm library directly
  const pythonScript = `
import sys
import time
import json
from mlx_lm import load, generate

# Load model once
model, tokenizer = load("${MODEL_PATH}")

# Read questions from stdin
questions = json.loads(sys.stdin.read())

results = []
for i, question in enumerate(questions):
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

        # Progress indicator (stderr)
        if (i + 1) % 25 == 0:
            print(f"Progress: {i + 1}/${QUESTIONS.length}", file=sys.stderr, flush=True)

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
        stderr += data.toString();
        // Forward progress indicators to console
        if (stderr.includes('Progress:')) {
          const match = stderr.match(/Progress: (\d+)\/\d+/);
          if (match) {
            console.log(`\n  Progress: ${match[1]}/${QUESTIONS.length}\n`);
          }
        }
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

    // Display results as they come in
    for (const result of pythonResults) {
      const statusIcon = result.success ? '✓' : '✗';
      const timeStr = result.success ? `${Math.round(result.metrics.totalTimeMs)}ms (${result.metrics.totalTokens} tokens)` : (result.error || 'failed');
      console.log(`  [${result.questionNumber}/${QUESTIONS.length}] ${result.question.substring(0, 50)}... ${statusIcon} ${timeStr}`);
    }

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
  console.log('║        200 Questions Apple-to-Apple Benchmark                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Test Configuration:');
  console.log(`  Model: llama-3.2-3b-instruct`);
  console.log(`  Path: ${MODEL_PATH}`);
  console.log(`  Questions: 200`);
  console.log(`  Max Tokens per Question: ${MAX_TOKENS}\n\n`);

  console.log('📊 Testing kr-serve-mlx (200 questions)...\n');
  const krStart = performance.now();
  const krResults = await benchmarkKrServeMlx();
  const krEnd = performance.now();
  const krTotalTime = (krEnd - krStart) / 1000;

  console.log(`\n✅ kr-serve-mlx completed in ${krTotalTime.toFixed(2)}s\n`);

  console.log('📊 Testing mlx-engine (200 questions)...\n');
  const mlxStart = performance.now();
  const mlxResults = await benchmarkMlxEngine();
  const mlxEnd = performance.now();
  const mlxTotalTime = (mlxEnd - mlxStart) / 1000;

  console.log(`\n✅ mlx-engine completed in ${mlxTotalTime.toFixed(2)}s\n`);

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

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           200 Questions Comparison Results                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log(`Model: llama-3.2-3b-instruct`);
  console.log(`Success Rate: kr-serve-mlx ${krSuccessRate.toFixed(1)}%, mlx-engine ${mlxSuccessRate.toFixed(1)}%\n`);

  const respImprovement = ((mlxStats.mean - krStats.mean) / mlxStats.mean) * 100;
  const ttftImprovement = ((mlxTTFTStats.mean - krTTFTStats.mean) / mlxTTFTStats.mean) * 100;
  const throughputImprovement = ((krThroughputStats.mean - mlxThroughputStats.mean) / mlxThroughputStats.mean) * 100;
  const totalTimeImprovement = ((mlxTotalTime - krTotalTime) / mlxTotalTime) * 100;

  console.log('┌──────────────────┬──────────────┬──────────────┬─────────────┐');
  console.log('│ Metric           │ kr-serve-mlx │ mlx-engine   │ Improvement │');
  console.log('├──────────────────┼──────────────┼──────────────┼─────────────┤');
  console.log(`│ Response Time    │ ${krStats.mean.toFixed(2)} ms`.padEnd(15) + `│ ${mlxStats.mean.toFixed(2)} ms`.padEnd(15) + `│ ${respImprovement > 0 ? '+' : ''}${respImprovement.toFixed(1)}%`.padEnd(13) + '│');
  console.log(`│ TTFT (Mean)      │ ${krTTFTStats.mean.toFixed(2)} ms`.padEnd(15) + `│ ${mlxTTFTStats.mean.toFixed(2)} ms`.padEnd(15) + `│ ${ttftImprovement > 0 ? '+' : ''}${ttftImprovement.toFixed(1)}%`.padEnd(13) + '│');
  console.log(`│ TTFT (P95)       │ ${krTTFTStats.p95.toFixed(2)} ms`.padEnd(15) + `│ ${mlxTTFTStats.p95.toFixed(2)} ms`.padEnd(15) + `│ -`.padEnd(13) + '│');
  console.log(`│ Throughput       │ ${krThroughputStats.mean.toFixed(2)} tok/s`.padEnd(15) + `│ ${mlxThroughputStats.mean.toFixed(2)} tok/s`.padEnd(15) + `│ ${throughputImprovement > 0 ? '+' : ''}${throughputImprovement.toFixed(1)}%`.padEnd(13) + '│');
  console.log(`│ Total Time (200q)│ ${krTotalTime.toFixed(2)}s`.padEnd(15) + `│ ${mlxTotalTime.toFixed(2)}s`.padEnd(15) + `│ ${totalTimeImprovement > 0 ? '+' : ''}${totalTimeImprovement.toFixed(1)}%`.padEnd(13) + '│');
  console.log('└──────────────────┴──────────────┴──────────────┴─────────────┘\n');

  // Export results
  const reportPath = 'benchmarks/results/200-questions-comparison.json';
  await mkdir('benchmarks/results', { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      modelId: 'llama-3.2-3b-instruct',
      totalQuestions: 200,
      krServeMlx: {
        successRate: krSuccessRate,
        totalTime: krTotalTime,
        responseTime: krStats,
        ttft: krTTFTStats,
        throughput: krThroughputStats,
        rawResults: krResults,
      },
      mlxEngine: {
        successRate: mlxSuccessRate,
        totalTime: mlxTotalTime,
        responseTime: mlxStats,
        ttft: mlxTTFTStats,
        throughput: mlxThroughputStats,
        rawResults: mlxResults,
      },
    }, null, 2)
  );

  console.log(`📊 Results exported to: ${reportPath}\n`);
}

main().catch(console.error);
