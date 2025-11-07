/**
 * kr-mlx-lm Benchmark Script
 *
 * Measures performance metrics for kr-mlx-lm
 */

import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';

interface BenchmarkResult {
  framework: string;
  model: string;
  prompt: string;
  maxTokens: number;
  timeToFirstToken: number;  // ms
  tokensPerSecond: number;
  totalTime: number;         // ms
  totalTokens: number;
  memoryUsage: {
    start: number;           // MB
    peak: number;            // MB
    end: number;             // MB
  };
  success: boolean;
  error?: string;
}

async function measureMemory(): Promise<number> {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);  // MB
}

async function runBenchmark(
  engine: Engine,
  modelPath: string,
  prompt: string,
  maxTokens: number
): Promise<BenchmarkResult> {
  const memStart = await measureMemory();
  let memPeak = memStart;
  let firstTokenTime = 0;
  let tokenCount = 0;
  let error: string | undefined;
  let success = false;

  const startTime = Date.now();

  try {
    // Load model
    const modelId = modelPath.split('/').pop() || 'unknown';
    await engine.loadModel({
      model: modelId,
      local_path: modelPath,
    });

    console.log(`[kr-mlx-lm] Model loaded: ${modelId}`);

    // Generate tokens
    const genStartTime = Date.now();
    const generator = engine.createGenerator({
      model: modelId,
      prompt,
      maxTokens,
      temperature: 0.0,  // Deterministic for fair comparison
    });

    for await (const chunk of generator) {
      if (chunk.type === 'token' && tokenCount === 0) {
        firstTokenTime = Date.now() - genStartTime;
      }

      if (chunk.type === 'token') {
        tokenCount++;
      }

      // Update peak memory
      const currentMem = await measureMemory();
      if (currentMem > memPeak) {
        memPeak = currentMem;
      }
    }

    success = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[kr-mlx-lm] Error:`, error);
  }

  const totalTime = Date.now() - startTime;
  const memEnd = await measureMemory();

  return {
    framework: 'kr-mlx-lm',
    model: modelPath,
    prompt,
    maxTokens,
    timeToFirstToken: firstTokenTime,
    tokensPerSecond: tokenCount > 0 ? (tokenCount / (totalTime / 1000)) : 0,
    totalTime,
    totalTokens: tokenCount,
    memoryUsage: {
      start: memStart,
      peak: memPeak,
      end: memEnd,
    },
    success,
    error,
  };
}

async function main() {
  console.log('=== kr-mlx-lm Benchmark ===\n');

  const engine = await createEngine({
    pythonPath: '.kr-mlx-venv/bin/python',
    runtimePath: 'python/runtime.py',
  });

  const testCases = [
    {
      model: './models/llama-3.2-3b-instruct',
      prompt: 'Write a short story about a robot learning to code.',
      maxTokens: 100,
    },
    {
      model: './models/llama-3.2-3b-instruct',
      prompt: 'Explain quantum computing in simple terms.',
      maxTokens: 200,
    },
    {
      model: './models/llama-3.2-3b-instruct',
      prompt: 'What is the meaning of life?',
      maxTokens: 50,
    },
  ];

  const results: BenchmarkResult[] = [];

  for (const testCase of testCases) {
    console.log(`\nTest: ${testCase.prompt.substring(0, 50)}...`);
    console.log(`Model: ${testCase.model}`);
    console.log(`Max Tokens: ${testCase.maxTokens}\n`);

    const result = await runBenchmark(
      engine,
      testCase.model,
      testCase.prompt,
      testCase.maxTokens
    );

    results.push(result);

    console.log(`Results:`);
    console.log(`  - Time to First Token: ${result.timeToFirstToken}ms`);
    console.log(`  - Tokens/Second: ${result.tokensPerSecond.toFixed(2)}`);
    console.log(`  - Total Time: ${result.totalTime}ms`);
    console.log(`  - Total Tokens: ${result.totalTokens}`);
    console.log(`  - Memory (Start/Peak/End): ${result.memoryUsage.start}MB / ${result.memoryUsage.peak}MB / ${result.memoryUsage.end}MB`);
    console.log(`  - Success: ${result.success}`);

    // Unload model between tests
    try {
      const modelId = testCase.model.split('/').pop() || 'unknown';
      await engine.unloadModel(modelId);
    } catch (err) {
      console.warn('Failed to unload model:', err);
    }
  }

  await engine.dispose();

  // Save results
  const fs = await import('fs/promises');
  await fs.writeFile(
    './benchmarks/results/kr-mlx-lm-results.json',
    JSON.stringify(results, null, 2)
  );

  console.log('\n=== Benchmark Complete ===');
  console.log(`Results saved to: ./benchmarks/results/kr-mlx-lm-results.json`);

  // Summary
  const avgTTFT = results.reduce((sum, r) => sum + r.timeToFirstToken, 0) / results.length;
  const avgTPS = results.reduce((sum, r) => sum + r.tokensPerSecond, 0) / results.length;
  const successRate = (results.filter(r => r.success).length / results.length) * 100;

  console.log('\nSummary:');
  console.log(`  - Average TTFT: ${avgTTFT.toFixed(2)}ms`);
  console.log(`  - Average Tokens/Second: ${avgTPS.toFixed(2)}`);
  console.log(`  - Success Rate: ${successRate.toFixed(1)}%`);
}

main().catch(console.error);
