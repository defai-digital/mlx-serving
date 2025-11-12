/**
 * Adaptive Batching Example
 *
 * Demonstrates how adaptive batching dynamically optimizes throughput based on latency.
 *
 * Performance gain: 10-15% throughput improvement under load
 *
 * Prerequisites:
 * 1. Edit config/runtime.yaml to enable batch_queue
 * 2. npm run setup (if not already done)
 *
 * Run: npx tsx examples/performance/03-adaptive-batching.ts
 */

import { createEngine } from '@knowrag/mlx-serving';

async function main() {
  console.log('=== Adaptive Batching Example ===\n');

  // Step 1: Create engine with batching enabled
  console.log('Creating engine with adaptive batching...');
  const engine = await createEngine({
    verbose: false,
  });

  console.log('Engine created.\n');

  // Step 2: Check initial batch queue statistics
  console.log('Initial batch queue stats:');
  let stats = engine.getBatchQueueStats();
  console.log(`  - Enabled: ${stats.enabled}`);
  console.log(`  - Adaptive sizing: ${stats.adaptiveSizing}`);
  console.log(`  - Target latency: ${stats.targetLatencyMs}ms`);
  console.log(`  - Batch size range: [${stats.minBatchSize}, ${stats.maxBatchSize}]`);
  console.log(`  - Current batch size: ${stats.currentBatchSize}\n`);

  // Step 3: Send single request (no batching benefit)
  console.log('=== Single Request Test ===');
  console.log('Sending single request (no batching)...');
  const singleStart = Date.now();

  const generator1 = engine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'What is the capital of France?',
    maxTokens: 50,
  });

  let tokens1 = 0;
  for await (const chunk of generator1) {
    tokens1++;
  }

  const singleTime = Date.now() - singleStart;
  const singleThroughput = tokens1 / (singleTime / 1000);

  console.log(`Completed: ${tokens1} tokens in ${singleTime}ms`);
  console.log(`Throughput: ${singleThroughput.toFixed(2)} tok/s\n`);

  // Step 4: Send concurrent requests (batching benefit)
  console.log('=== Concurrent Request Test ===');
  console.log('Sending 5 concurrent requests (batching enabled)...');
  const concurrentStart = Date.now();

  const prompts = [
    'What is the capital of France?',
    'What is 2 + 2?',
    'What is the meaning of life?',
    'What is the speed of light?',
    'What is the largest planet?',
  ];

  const generators = prompts.map((prompt) =>
    engine.generate({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      prompt,
      maxTokens: 50,
    })
  );

  // Process all generators concurrently
  const results = await Promise.all(
    generators.map(async (generator) => {
      let tokens = 0;
      for await (const chunk of generator) {
        tokens++;
      }
      return tokens;
    })
  );

  const concurrentTime = Date.now() - concurrentStart;
  const totalTokens = results.reduce((sum, t) => sum + t, 0);
  const concurrentThroughput = totalTokens / (concurrentTime / 1000);

  console.log(`Completed: ${totalTokens} tokens in ${concurrentTime}ms`);
  console.log(`Throughput: ${concurrentThroughput.toFixed(2)} tok/s`);
  console.log(`Requests completed: ${results.length}\n`);

  // Step 5: Check updated batch queue statistics
  console.log('Updated batch queue stats:');
  stats = engine.getBatchQueueStats();
  console.log(`  - Total requests: ${stats.totalRequests}`);
  console.log(`  - Total batches: ${stats.totalBatches}`);
  console.log(`  - Avg batch size: ${stats.avgBatchSize.toFixed(2)}`);
  console.log(`  - Current batch size: ${stats.currentBatchSize}`);
  console.log(`  - Avg latency: ${stats.avgLatencyMs.toFixed(2)}ms`);
  console.log(`  - Throughput: ${stats.throughput.toFixed(2)} req/s\n`);

  // Step 6: Performance comparison
  console.log('=== Performance Comparison ===');
  console.log(`Single request throughput: ${singleThroughput.toFixed(2)} tok/s`);
  console.log(`Concurrent throughput: ${concurrentThroughput.toFixed(2)} tok/s`);
  console.log(`Improvement: ${((concurrentThroughput / singleThroughput - 1) * 100).toFixed(1)}%\n`);

  // Step 7: Demonstrate adaptive sizing
  console.log('=== Adaptive Sizing Demonstration ===');
  console.log('Sending increasing load to observe adaptive batch sizing...\n');

  const loadLevels = [1, 3, 5, 8];

  for (const load of loadLevels) {
    console.log(`Load level: ${load} concurrent requests`);
    const loadStart = Date.now();

    const loadGenerators = Array.from({ length: load }, (_, i) =>
      engine.generate({
        model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        prompt: `Question ${i + 1}: What is ${i + 1} + ${i + 1}?`,
        maxTokens: 30,
      })
    );

    await Promise.all(
      loadGenerators.map(async (generator) => {
        for await (const chunk of generator) {
          // Consume tokens
        }
      })
    );

    const loadTime = Date.now() - loadStart;
    stats = engine.getBatchQueueStats();

    console.log(`  Completed in: ${loadTime}ms`);
    console.log(`  Current batch size: ${stats.currentBatchSize}`);
    console.log(`  Avg batch size: ${stats.avgBatchSize.toFixed(2)}`);
    console.log(`  Avg latency: ${stats.avgLatencyMs.toFixed(2)}ms`);
    console.log();
  }

  // Step 8: Best practices
  console.log('=== Best Practices ===');
  console.log('1. Enable adaptive batching for production workloads');
  console.log('2. Set target_latency_ms based on your SLO (e.g., 100ms)');
  console.log('3. Monitor avgLatencyMs to verify SLO compliance');
  console.log('4. Adjust min/max_batch_size based on observed load');
  console.log('5. Batching works best with concurrent requests (>2)\n');

  // Cleanup
  await engine.close();
  console.log('Engine closed.');
}

// Configuration example (add to config/runtime.yaml):
console.log(`
Configuration Required:
=======================

Edit config/runtime.yaml:

batch_queue:
  enabled: true
  adaptive_sizing: true
  target_latency_ms: 100    # Target latency SLO
  min_batch_size: 1
  max_batch_size: 8
  window_size: 100          # Sample window for adaptation

Then run this example.
`);

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
