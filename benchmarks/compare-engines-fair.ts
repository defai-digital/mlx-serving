#!/usr/bin/env tsx
/**
 * Fair benchmark comparing mlx-engine and mlx-serving
 * BOTH load model once and reuse for all questions
 * Run: npx tsx benchmarks/compare-engines-fair.ts
 */

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

const MODEL = 'mlx-community/Meta-Llama-3.1-405B-2bit';
const QUESTIONS = 5;  // Minimal test for very large model
const CYCLES = 1;  // Single cycle due to extreme memory pressure
const MAX_TOKENS = 100;
const TEMP = 0.7;

const SAMPLE_QUESTIONS = [
  'What is the capital of France?',
  'Explain quantum computing in simple terms.',
  'What are the benefits of exercise?',
  'How does photosynthesis work?',
  'What is artificial intelligence?',
  'Describe the water cycle.',
  'What causes seasons on Earth?',
  'Explain how a computer CPU works.',
  'What is the theory of relativity?',
  'How do vaccines work?',
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

class MLXEngineServer {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }> = new Map();
  private requestId = 0;

  async start(model: string): Promise<void> {
    const pythonPath = '.kr-mlx-venv/bin/python';
    this.process = spawn(pythonPath, ['benchmarks/mlx-engine-server.py']);

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
        // Match response to pending request (simple: FIFO order)
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

  async generate(prompt: string, maxTokens: number, temp: number): Promise<{ tokens: number }> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Server not started');
    }

    const id = this.requestId++;
    const request = {
      prompt,
      max_tokens: maxTokens,
      temp,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      // Timeout after 300 seconds (5 minutes) for very large models
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 300000);
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

function generateQuestions(count: number): string[] {
  const questions: string[] = [];
  for (let i = 0; i < count; i++) {
    questions.push(SAMPLE_QUESTIONS[i % SAMPLE_QUESTIONS.length]);
  }
  return questions;
}

async function benchmarkMLXEngine(cycle: number, server: MLXEngineServer): Promise<BenchmarkResult> {
  console.log(`\n[mlx-engine] Starting cycle ${cycle}...`);

  const questions = generateQuestions(QUESTIONS);
  const startTime = Date.now();
  let totalTokens = 0;
  let successCount = 0;

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    process.stdout.write(`\r[mlx-engine] Progress: ${i + 1}/${QUESTIONS}`);

    try {
      const result = await server.generate(question, MAX_TOKENS, TEMP);
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
    const question = questions[i];
    process.stdout.write(`\r[mlx-serving] Progress: ${i + 1}/${QUESTIONS}`);

    try {
      let tokenCount = 0;
      for await (const chunk of engine.createGenerator({
        model: MODEL,
        prompt: question,
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
  console.log('MLX Engine FAIR Comparison Benchmark');
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
  const mlxEngineServer = new MLXEngineServer();
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
  console.log('BENCHMARK RESULTS (FAIR COMPARISON)');
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
    benchmark_type: 'fair_comparison',
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

  const outputFile = join('results', `fair-comparison-${Date.now()}.json`);
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${outputFile}`);
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
