/**
 * Model Preloading Example
 *
 * Demonstrates how to configure model preloading for zero first-request latency.
 *
 * Performance gain: 104x faster first request (5,200ms → 50ms)
 *
 * Prerequisites:
 * 1. Edit config/runtime.yaml to enable model_preload
 * 2. npm run setup (if not already done)
 *
 * Run: npx tsx examples/performance/01-model-preloading.ts
 */

import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  console.log('=== Model Preloading Example ===\n');

  // Step 1: Create engine (models preload automatically if configured)
  console.log('Creating engine with model preloading...');
  const startTime = Date.now();

  const engine = await createEngine({
    verbose: true, // Enable logging to see preload progress
  });

  const createTime = Date.now() - startTime;
  console.log(`Engine created in ${createTime}ms\n`);

  // Step 2: Check preload statistics
  console.log('Checking preload status...');
  const stats = engine.getPreloadStats();

  console.log(`Preloaded models: ${stats.preloadedModels.length}`);
  for (const model of stats.preloadedModels) {
    console.log(`  - ${model.modelId}`);
    console.log(`    Warmup requests: ${model.warmupRequests}`);
    console.log(`    Preload time: ${model.preloadTimeMs}ms`);
  }
  console.log();

  // Step 3: First request (should be fast due to preloading)
  console.log('Sending first request (should be fast)...');
  const firstRequestStart = Date.now();

  const generator = engine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'What is the capital of France?',
    maxTokens: 50,
  });

  let firstTokenTime: number | null = null;
  let tokens = 0;

  for await (const chunk of generator) {
    if (firstTokenTime === null) {
      firstTokenTime = Date.now() - firstRequestStart;
      console.log(`First token: ${firstTokenTime}ms (TTFT)`);
    }
    process.stdout.write(chunk.text);
    tokens++;
  }
  console.log('\n');

  const totalTime = Date.now() - firstRequestStart;
  console.log(`Total generation time: ${totalTime}ms`);
  console.log(`Tokens generated: ${tokens}`);
  console.log(`Throughput: ${(tokens / (totalTime / 1000)).toFixed(2)} tok/s\n`);

  // Step 4: Second request (should also be fast)
  console.log('Sending second request (should also be fast)...');
  const secondRequestStart = Date.now();

  const generator2 = engine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'What is 2 + 2?',
    maxTokens: 50,
  });

  let secondFirstTokenTime: number | null = null;
  let tokens2 = 0;

  for await (const chunk of generator2) {
    if (secondFirstTokenTime === null) {
      secondFirstTokenTime = Date.now() - secondRequestStart;
      console.log(`First token: ${secondFirstTokenTime}ms (TTFT)`);
    }
    process.stdout.write(chunk.text);
    tokens2++;
  }
  console.log('\n');

  const totalTime2 = Date.now() - secondRequestStart;
  console.log(`Total generation time: ${totalTime2}ms`);
  console.log(`Tokens generated: ${tokens2}`);
  console.log(`Throughput: ${(tokens2 / (totalTime2 / 1000)).toFixed(2)} tok/s\n`);

  // Step 5: Performance summary
  console.log('=== Performance Summary ===');
  console.log(`Without preloading: ~5,200ms TTFT (cold start)`);
  console.log(`With preloading: ~${firstTokenTime}ms TTFT`);
  console.log(`Speedup: ${(5200 / (firstTokenTime || 1)).toFixed(1)}x faster\n`);

  // Cleanup
  await engine.close();
  console.log('Engine closed.');
}

// Configuration example (add to config/runtime.yaml):
console.log(`
Configuration Required:
=======================

Edit config/runtime.yaml:

model_preload:
  enabled: true
  models:
    - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"
      warmup_requests: 3
      max_tokens: 10
  parallel: true
  max_parallel: 2
  fail_fast: false

Then run this example.
`);

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
