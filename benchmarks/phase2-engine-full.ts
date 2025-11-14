#!/usr/bin/env tsx
/**
 * Phase 2 Engine Benchmark (MessagePack Disabled)
 * Full benchmark with multiple cycles to measure Phase 2 gains
 */

import { Engine } from '../src/index.js';
import { writeFileSync } from 'fs';

const MODEL = 'mlx-community/Qwen3-30B-A3B-4bit';
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

interface CycleResult {
  cycle: number;
  questions: number;
  totalTime: number;
  avgLatency: number;
  tokensPerSecond: number;
  successRate: number;
}

async function main() {
  console.log('============================================================');
  console.log('Phase 2 Engine Benchmark (MessagePack DISABLED)');
  console.log('============================================================');
  console.log(`Model: ${MODEL}`);
  console.log(`Questions per cycle: ${QUESTIONS.length}`);
  console.log(`Cycles: ${CYCLES}`);
  console.log(`Max Tokens: ${MAX_TOKENS}`);
  console.log(`Temperature: ${TEMP}`);
  console.log('============================================================\n');

  const engine = new Engine();
  const results: CycleResult[] = [];

  try {
    console.log('Loading model...');
    const loadStart = Date.now();
    await engine.loadModel({ model: MODEL });
    const loadTime = (Date.now() - loadStart) / 1000;
    console.log(`✓ Model loaded in ${loadTime.toFixed(2)}s\n`);

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      console.log(`\n🔷 Cycle ${cycle}/${CYCLES}:`);
      const startTime = Date.now();
      let totalTokens = 0;
      let successCount = 0;

      for (const question of QUESTIONS) {
        try {
          const result = await engine.generate({
            model: MODEL,
            prompt: question,
            maxTokens: MAX_TOKENS,
            temperature: TEMP,
            streaming: false,
          });

          const tokens = result.usage?.totalTokens || 0;
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

      const cycleResult: CycleResult = {
        cycle,
        questions: QUESTIONS.length,
        totalTime,
        avgLatency,
        tokensPerSecond,
        successRate,
      };

      results.push(cycleResult);

      console.log(`  ✓ ${totalTime.toFixed(2)}s | ${tokensPerSecond.toFixed(2)} tok/s | ${successRate}% success`);
    }

    await engine.unloadModel({ model: MODEL });

    // Calculate averages
    const avgTps = results.reduce((sum, r) => sum + r.tokensPerSecond, 0) / results.length;
    const avgLatency = results.reduce((sum, r) => sum + r.avgLatency, 0) / results.length;
    const minTps = Math.min(...results.map(r => r.tokensPerSecond));
    const maxTps = Math.max(...results.map(r => r.tokensPerSecond));

    console.log('\n============================================================');
    console.log('📊 RESULTS:');
    console.log('============================================================');
    console.log(`Average:  ${avgTps.toFixed(2)} tokens/second`);
    console.log(`Min:      ${minTps.toFixed(2)} tokens/second`);
    console.log(`Max:      ${maxTps.toFixed(2)} tokens/second`);
    console.log(`Cycles:   ${results.length}/${CYCLES}`);
    console.log('============================================================');

    console.log('\n📈 COMPARISON WITH BASELINE:');
    console.log('Baseline (Phase 1):     75.73 tokens/second');
    console.log(`Current  (Phase 2 - MessagePack disabled):     ${avgTps.toFixed(2)} tokens/second`);
    const improvement = ((avgTps - 75.73) / 75.73) * 100;
    console.log(`Improvement:            ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%`);
    console.log('============================================================\n');

    // Save results
    const timestamp = Date.now();
    const resultsPath = `results/phase2-engine-nomsgpack-${timestamp}.json`;
    writeFileSync(
      resultsPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        model: MODEL,
        phase2_enabled: true,
        messagepack_enabled: false,  // Disabled due to timeout issue
        adaptive_batching: true,
        token_buffering: true,
        cycles: results.length,
        results,
        average: avgTps,
        min: minTps,
        max: maxTps,
        baseline: 75.73,
        improvement,
      }, null, 2)
    );

    console.log(`✅ Results saved to: ${resultsPath}\n`);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Benchmark failed:');
    console.error(error);
    process.exit(1);
  }
}

main();
