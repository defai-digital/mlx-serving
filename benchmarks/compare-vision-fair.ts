#!/usr/bin/env tsx
/**
 * Fair benchmark comparing mlx-vlm and mlx-serving for vision models
 * BOTH load model once and reuse for all questions
 * Run: npx tsx benchmarks/compare-vision-fair.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

const MODEL = 'mlx-community/Qwen2-VL-72B-Instruct-4bit';
const QUESTIONS = 10;  // Number of image+text prompts
const CYCLES = 3;
const MAX_TOKENS = 100;
const TEMP = 0.7;

const TEST_IMAGES = [
  'benchmarks/test-images/text1.jpg',
  'benchmarks/test-images/shapes.jpg',
  'benchmarks/test-images/numbers.jpg',
  'benchmarks/test-images/math.jpg',
  'benchmarks/test-images/colors.jpg',
];

const SAMPLE_PROMPTS = [
  'What text do you see in this image?',
  'Describe the shapes and colors you see.',
  'What numbers are shown in this image?',
  'What question and answer are displayed?',
  'List the colors you see from top to bottom.',
  'Describe everything you see in detail.',
  'What is the main content of this image?',
  'What colors are most prominent?',
  'Can you read the text in this image?',
  'Describe the visual elements.',
];

interface BenchmarkResult {
  engine: string;
  cycle: number;
  questions: number;
  totalTime: number;
  avgLatency: number;
  tokensPerSecond: number;
  successRate: number;
}

class MLXEngineVisionServer {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }> = new Map();
  private requestId = 0;

  async start(model: string): Promise<void> {
    const pythonPath = '.kr-mlx-venv/bin/python';
    this.process = spawn(pythonPath, ['benchmarks/mlx-engine-vision-server.py']);

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to create Python process streams');
    }

    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const firstKey = this.pendingRequests.keys().next().value;
        if (firstKey !== undefined) {
          const { resolve } = this.pendingRequests.get(firstKey)!;
          this.pendingRequests.delete(firstKey);
          resolve(response);
        }
      } catch (error) {
        console.error('Failed to parse response:', line);
      }
    });

    // Send model name
    this.process.stdin.write(model + '\n');

    // Wait for "Model loaded" message
    await new Promise<void>((resolve) => {
      const onData = (data: Buffer) => {
        const message = data.toString();
        if (message.includes('ready for prompts')) {
          this.process!.stderr!.off('data', onData);
          resolve();
        }
      };
      this.process!.stderr!.on('data', onData);
    });
  }

  async generate(prompt: string, imagePath: string, maxTokens: number, temp: number): Promise<{ tokens: number }> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Server not started');
    }

    const id = this.requestId++;
    const request = {
      prompt,
      image_path: imagePath,
      max_tokens: maxTokens,
      temp,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 120000); // 2 minute timeout for vision models
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

function generateQuestions(count: number): Array<{ prompt: string; image: string }> {
  const questions: Array<{ prompt: string; image: string }> = [];
  for (let i = 0; i < count; i++) {
    const promptIdx = i % SAMPLE_PROMPTS.length;
    const imageIdx = i % TEST_IMAGES.length;
    questions.push({
      prompt: SAMPLE_PROMPTS[promptIdx],
      image: TEST_IMAGES[imageIdx],
    });
  }
  return questions;
}

async function benchmarkMLXEngine(cycle: number, server: MLXEngineVisionServer): Promise<BenchmarkResult> {
  console.log(`\n[mlx-engine] Starting cycle ${cycle}...`);

  const questions = generateQuestions(QUESTIONS);
  const startTime = Date.now();
  let totalTokens = 0;
  let successCount = 0;

  for (let i = 0; i < questions.length; i++) {
    const { prompt, image } = questions[i];
    process.stdout.write(`\r[mlx-engine] Progress: ${i + 1}/${QUESTIONS}`);

    try {
      const result = await server.generate(prompt, image, MAX_TOKENS, TEMP);
      totalTokens += result.tokens;
      successCount++;
    } catch (error) {
      console.error(`\nError on question ${i + 1}:`, error);
    }
  }

  const endTime = Date.now();
  const totalTime = (endTime - startTime) / 1000;
  const avgLatency = totalTime / QUESTIONS;
  const tokensPerSecond = totalTokens / totalTime;
  const successRate = (successCount / QUESTIONS) * 100;

  console.log(`\n[mlx-engine] Cycle ${cycle} complete: ${tokensPerSecond.toFixed(2)} tok/s`);

  return {
    engine: 'mlx-engine',
    cycle,
    questions: QUESTIONS,
    totalTime,
    avgLatency,
    tokensPerSecond,
    successRate,
  };
}

async function benchmarkMLXServing(cycle: number, engine: any): Promise<BenchmarkResult> {
  console.log(`\n[mlx-serving] Starting cycle ${cycle}...`);

  const questions = generateQuestions(QUESTIONS);
  let totalTokens = 0;
  let successCount = 0;

  const startTime = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const { prompt, image } = questions[i];
    process.stdout.write(`\r[mlx-serving] Progress: ${i + 1}/${QUESTIONS}`);

    try {
      // Read image as base64
      const imageBuffer = readFileSync(image);
      const imageBase64 = imageBuffer.toString('base64');

      let tokenCount = 0;
      for await (const chunk of engine.createGenerator({
        model: MODEL,
        prompt,
        images: [`data:image/jpeg;base64,${imageBase64}`],
        maxTokens: MAX_TOKENS,
        temperature: TEMP,
      })) {
        if (chunk.type === 'token') {
          tokenCount++;
        }
      }
      totalTokens += tokenCount;
      successCount++;
    } catch (error) {
      console.error(`\nError on question ${i + 1}:`, error);
    }
  }

  const endTime = Date.now();
  const totalTime = (endTime - startTime) / 1000;
  const avgLatency = totalTime / QUESTIONS;
  const tokensPerSecond = totalTokens / totalTime;
  const successRate = (successCount / QUESTIONS) * 100;

  console.log(`\n[mlx-serving] Cycle ${cycle} complete: ${tokensPerSecond.toFixed(2)} tok/s`);

  return {
    engine: 'mlx-serving',
    cycle,
    questions: QUESTIONS,
    totalTime,
    avgLatency,
    tokensPerSecond,
    successRate,
  };
}

function calculateAverage(results: BenchmarkResult[]): BenchmarkResult {
  const totalTokensPerSec = results.reduce((sum, r) => sum + r.tokensPerSecond, 0);
  const totalLatency = results.reduce((sum, r) => sum + r.avgLatency, 0);
  const totalTime = results.reduce((sum, r) => sum + r.totalTime, 0);
  const totalSuccessRate = results.reduce((sum, r) => sum + r.successRate, 0);

  return {
    engine: results[0].engine,
    cycle: 0,
    questions: results[0].questions,
    totalTime: totalTime / results.length,
    avgLatency: totalLatency / results.length,
    tokensPerSecond: totalTokensPerSec / results.length,
    successRate: totalSuccessRate / results.length,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('MLX Vision Model FAIR Comparison Benchmark');
  console.log('(Both engines load model once, reuse for all questions)');
  console.log('='.repeat(60));
  console.log(`Model: ${MODEL}`);
  console.log(`Questions: ${QUESTIONS}`);
  console.log(`Cycles: ${CYCLES}`);
  console.log(`Max Tokens: ${MAX_TOKENS}`);
  console.log(`Temperature: ${TEMP}`);
  console.log('='.repeat(60));

  const mlxEngineResults: BenchmarkResult[] = [];
  const mlxServingResults: BenchmarkResult[] = [];

  // Benchmark mlx-engine
  console.log('\n\n📊 Benchmarking mlx-engine (persistent server)...\n');
  console.log('Loading model...');
  const mlxEngineServer = new MLXEngineVisionServer();
  await mlxEngineServer.start(MODEL);
  console.log('Model loaded! Starting cycles...\n');

  for (let i = 1; i <= CYCLES; i++) {
    const result = await benchmarkMLXEngine(i, mlxEngineServer);
    mlxEngineResults.push(result);
  }

  await mlxEngineServer.stop();

  // Benchmark mlx-serving
  console.log('\n\n📊 Benchmarking mlx-serving...\n');
  console.log('Loading model...');
  const { createEngine } = await import('../dist/index.js');
  const mlxServingEngine = await createEngine();
  await mlxServingEngine.loadModel({ model: MODEL });
  console.log('Model loaded! Starting cycles...\n');

  for (let i = 1; i <= CYCLES; i++) {
    const result = await benchmarkMLXServing(i, mlxServingEngine);
    mlxServingResults.push(result);
  }

  await mlxServingEngine.dispose();

  // Calculate averages
  const mlxEngineAvg = calculateAverage(mlxEngineResults);
  const mlxServingAvg = calculateAverage(mlxServingResults);

  // Print results
  console.log('\n\n' + '='.repeat(60));
  console.log('VISION BENCHMARK RESULTS (FAIR COMPARISON)');
  console.log('='.repeat(60));

  console.log('\n📈 mlx-engine (Python - Model Loaded Once)');
  console.log('-'.repeat(60));
  mlxEngineResults.forEach((r) => {
    console.log(`Cycle ${r.cycle}: ${r.tokensPerSecond.toFixed(2)} tok/s | ${r.avgLatency.toFixed(2)}s latency | ${r.successRate.toFixed(1)}% success`);
  });
  console.log('-'.repeat(60));
  console.log(`Average: ${mlxEngineAvg.tokensPerSecond.toFixed(2)} tok/s | ${mlxEngineAvg.avgLatency.toFixed(2)}s latency | ${mlxEngineAvg.successRate.toFixed(1)}% success`);

  console.log('\n📈 mlx-serving (TypeScript - Model Loaded Once)');
  console.log('-'.repeat(60));
  mlxServingResults.forEach((r) => {
    console.log(`Cycle ${r.cycle}: ${r.tokensPerSecond.toFixed(2)} tok/s | ${r.avgLatency.toFixed(2)}s latency | ${r.successRate.toFixed(1)}% success`);
  });
  console.log('-'.repeat(60));
  console.log(`Average: ${mlxServingAvg.tokensPerSecond.toFixed(2)} tok/s | ${mlxServingAvg.avgLatency.toFixed(2)}s latency | ${mlxServingAvg.successRate.toFixed(1)}% success`);

  // Comparison
  const improvement = ((mlxServingAvg.tokensPerSecond / mlxEngineAvg.tokensPerSecond - 1) * 100);
  console.log('\n🔄 Comparison (Fair: Both Reuse Loaded Model)');
  console.log('-'.repeat(60));
  console.log(`mlx-serving vs mlx-engine: ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%`);
  console.log(`Throughput: ${mlxServingAvg.tokensPerSecond.toFixed(2)} vs ${mlxEngineAvg.tokensPerSecond.toFixed(2)} tok/s`);
  console.log(`Latency: ${mlxServingAvg.avgLatency.toFixed(2)} vs ${mlxEngineAvg.avgLatency.toFixed(2)} seconds`);

  // Save results
  mkdirSync('results', { recursive: true });
  const results = {
    timestamp: new Date().toISOString(),
    benchmark_type: 'vision_fair_comparison',
    note: 'Both engines load model once and reuse for all questions',
    model: MODEL,
    questions: QUESTIONS,
    cycles: CYCLES,
    maxTokens: MAX_TOKENS,
    temperature: TEMP,
    mlxEngine: {
      cycles: mlxEngineResults,
      average: mlxEngineAvg,
    },
    mlxServing: {
      cycles: mlxServingResults,
      average: mlxServingAvg,
    },
    comparison: {
      improvement: improvement,
      winner: improvement > 0 ? 'mlx-serving' : 'mlx-engine',
    },
  };

  const outputFile = join('results', `vision-fair-comparison-${Date.now()}.json`);
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${outputFile}`);
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
