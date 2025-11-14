#!/usr/bin/env tsx
/**
 * Phase 2 Quick Benchmark - mlx-serving only
 * Tests three Qwen models with Phase 2 optimizations enabled
 */

import { Engine } from '../src/index.js';
import { writeFileSync } from 'fs';

const MODELS = [
  { name: 'mlx-community/Qwen2.5-32B-Instruct-4bit', size: '32B' },
  { name: 'mlx-community/Qwen3-30B-A3B-4bit', size: '30B' },
  { name: 'mlx-community/Qwen2.5-14B-Instruct-4bit', size: '14B' },
];

const QUESTIONS = [
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

const MAX_TOKENS = 100;
const TEMP = 0.7;
const CYCLES = 5;

interface BenchmarkResult {
  model: string;
  size: string;
  cycle: number;
  questions: number;
  totalTime: number;
  avgLatency: number;
  tokensPerSecond: number;
  successRate: number;
}

async function benchmarkModel(modelName: string, modelSize: string): Promise<BenchmarkResult[]> {
  console.log(`\n🔷 Benchmarking ${modelName} (${modelSize})\n`);

  const engine = new Engine();

  try {
    // Load model once
    console.log('Loading model...');
    await engine.loadModel({
      model: modelName,
    });
    console.log('Model loaded ✓\n');

    const results: BenchmarkResult[] = [];

    // Run multiple cycles
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      console.log(`Cycle ${cycle}/${CYCLES}...`);
      const startTime = Date.now();
      let totalTokens = 0;
      let successCount = 0;

      for (const question of QUESTIONS) {
        try {
          let tokens = 0;

          await engine.generate({
            model: modelName,
            prompt: question,
            maxTokens: MAX_TOKENS,
            temperature: TEMP,
            streaming: true,
            onChunk: () => {
              tokens++;
            },
          });

          totalTokens += tokens;
          successCount++;
        } catch (error) {
          console.error(`  ❌ Question failed: ${error}`);
        }
      }

      const totalTime = (Date.now() - startTime) / 1000; // seconds
      const avgLatency = totalTime / QUESTIONS.length;
      const tokensPerSecond = totalTokens / totalTime;
      const successRate = (successCount / QUESTIONS.length) * 100;

      const result: BenchmarkResult = {
        model: modelName,
        size: modelSize,
        cycle,
        questions: QUESTIONS.length,
        totalTime,
        avgLatency,
        tokensPerSecond,
        successRate,
      };

      results.push(result);

      console.log(`  ✓ ${totalTime.toFixed(2)}s | ${tokensPerSecond.toFixed(2)} tok/s | ${successRate}% success\n`);
    }

    // Unload model
    await engine.unloadModel({ model: modelName });

    return results;
  } catch (error) {
    throw error;
  }
}

async function main() {
  console.log('============================================================');
  console.log('Phase 2 Optimization Benchmark - mlx-serving');
  console.log('============================================================');
  console.log(`Models: ${MODELS.length}`);
  console.log(`Questions per cycle: ${QUESTIONS.length}`);
  console.log(`Cycles: ${CYCLES}`);
  console.log(`Max Tokens: ${MAX_TOKENS}`);
  console.log(`Temperature: ${TEMP}`);
  console.log('============================================================\n');

  const allResults: Record<string, BenchmarkResult[]> = {};

  for (const model of MODELS) {
    try {
      const results = await benchmarkModel(model.name, model.size);
      allResults[model.name] = results;

      // Calculate average
      const avgTps = results.reduce((sum, r) => sum + r.tokensPerSecond, 0) / results.length;
      const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length;

      console.log(`\n📊 ${model.name} Average Results:`);
      console.log(`   Throughput: ${avgTps.toFixed(2)} tokens/second`);
      console.log(`   Latency: ${avgLatency.toFixed(3)} seconds`);
      console.log(`   Success Rate: ${results[0].successRate}%\n`);
    } catch (error) {
      console.error(`\n❌ Failed to benchmark ${model.name}:`);
      console.error(error);
    }
  }

  // Save results
  const timestamp = Date.now();
  const resultsPath = `results/phase2-benchmark-${timestamp}.json`;
  writeFileSync(
    resultsPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: 'phase2-optimizations',
      optimizations: {
        binary_streaming: true,
        adaptive_batching: true,
        token_buffering: true,
        object_pooling: true,
      },
      models: MODELS.map(m => m.name),
      maxTokens: MAX_TOKENS,
      temperature: TEMP,
      cycles: CYCLES,
      results: allResults,
    }, null, 2)
  );

  console.log(`\n✅ Results saved to: ${resultsPath}`);
}

main().catch(console.error);
