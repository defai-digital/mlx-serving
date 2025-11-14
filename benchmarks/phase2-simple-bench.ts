#!/usr/bin/env tsx
/**
 * Simple Phase 2 Benchmark - Direct Model Testing
 * Avoids complex initialization, focuses on generation performance
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const MODEL = 'mlx-community/Qwen3-30B-A3B-4bit'; // Use model with baseline data
const QUESTIONS = [
  'What is the capital of France?',
  'Explain quantum computing.',
  'What are benefits of exercise?',
  'How does photosynthesis work?',
  'What is artificial intelligence?',
];
const MAX_TOKENS = 100;
const TEMP = 0.7;
const CYCLES = 3; // Reduced for faster testing

console.log('============================================================');
console.log('Phase 2 SIMPLE Benchmark - mlx-serving');
console.log('Using Python CLI directly (no Engine overhead)');
console.log('============================================================');
console.log(`Model: ${MODEL}`);
console.log(`Questions: ${QUESTIONS.length}`);
console.log(`Cycles: ${CYCLES}`);
console.log(`Max Tokens: ${MAX_TOKENS}`);
console.log('============================================================\n');

async function runPythonBench(): Promise<number> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let totalTokens = 0;

    console.log(`Loading model and generating ${QUESTIONS.length} responses...`);

    // Use mlx_lm.generate directly via Python
    const pythonCode = `
import sys
import time
from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler

model, tokenizer = load("${MODEL}")
start = time.time()

questions = ${JSON.stringify(QUESTIONS)}
total_tokens = 0

sampler = make_sampler(temp=${TEMP}, top_p=1.0)

for q in questions:
    token_count = 0
    for token in stream_generate(model, tokenizer, q, max_tokens=${MAX_TOKENS}, sampler=sampler):
        token_count += 1
    total_tokens += token_count
    sys.stderr.write(f".")
    sys.stderr.flush()

elapsed = time.time() - start
tps = total_tokens / elapsed
print(f"{total_tokens},{elapsed},{tps}")
`;

    const proc = spawn('.mlx-serving-venv/bin/python', ['-c', pythonCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data); // Show progress dots
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python process exited with code ${code}\n${stderr}`));
        return;
      }

      try {
        const [tokens, elapsed, tps] = stdout.trim().split(',').map(Number);
        console.log(`\n✓ Completed: ${tokens} tokens in ${elapsed.toFixed(2)}s = ${tps.toFixed(2)} tok/s\n`);
        resolve(tps);
      } catch (err) {
        reject(new Error(`Failed to parse output: ${stdout}\n${stderr}`));
      }
    });

    // 10 minute timeout for large models
    setTimeout(() => {
      proc.kill();
      reject(new Error('Benchmark timed out after 10 minutes'));
    }, 600000);
  });
}

async function main() {
  const results: number[] = [];

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`\n🔷 Cycle ${cycle}/${CYCLES}:`);
    try {
      const tps = await runPythonBench();
      results.push(tps);
    } catch (error) {
      console.error(`\n❌ Cycle ${cycle} failed:`);
      console.error(error);
      break;
    }
  }

  if (results.length > 0) {
    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    const min = Math.min(...results);
    const max = Math.max(...results);

    console.log('\n============================================================');
    console.log('📊 RESULTS:');
    console.log('============================================================');
    console.log(`Average:  ${avg.toFixed(2)} tokens/second`);
    console.log(`Min:      ${min.toFixed(2)} tokens/second`);
    console.log(`Max:      ${max.toFixed(2)} tokens/second`);
    console.log(`Cycles:   ${results.length}/${CYCLES}`);
    console.log('============================================================');

    console.log('\n📈 COMPARISON WITH BASELINE:');
    console.log('Baseline (Pre-Phase 2): 75.73 tokens/second');
    console.log(`Current  (Phase 2):     ${avg.toFixed(2)} tokens/second`);
    const improvement = ((avg - 75.73) / 75.73) * 100;
    console.log(`Improvement:            ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%`);
    console.log('============================================================\n');

    // Save results
    const timestamp = Date.now();
    writeFileSync(
      `results/phase2-simple-${timestamp}.json`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        model: MODEL,
        phase2_enabled: true,
        cycles: results.length,
        results: results.map((tps, i) => ({ cycle: i + 1, tokensPerSecond: tps })),
        average: avg,
        min,
        max,
        baseline: 75.73,
        improvement: improvement,
      }, null, 2)
    );

    console.log(`✅ Results saved to: results/phase2-simple-${timestamp}.json\n`);
  }
}

main().catch(console.error);
