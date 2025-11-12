/**
 * Phase 5 Week 2 Day 3-4: Quick Throughput Benchmark Test
 *
 * Quick validation with 1-minute duration before running full 10-minute benchmark.
 */

import { runThroughputBenchmark, displayResults, exportResults } from './throughput-benchmark.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main(): Promise<void> {
  // Quick test configuration (1-minute for fast validation)
  const config = {
    modelId: 'gemma-2-2b-it-4bit',
    modelPath: 'mlx-community/gemma-2-2b-it-4bit', // Smaller model for faster testing
    durationMs: 60000, // 1 minute vs 10 minutes
    targetRequestsPerSecond: 50, // Lower target for quick test
    maxConcurrent: 50, // Lower concurrency limit
    warmupDurationMs: 10000, // 10 seconds vs 30 seconds
    maxTokens: 30, // Shorter generation for speed
    temperature: 0.7,
    prompts: [
      'Hello, how are you?',
      'What is machine learning?',
      'Explain quantum computing.',
      'Write a short haiku.',
    ],
  };

  console.log('\n🧪 Phase 5 Throughput Benchmark - Quick Validation Test\n');
  console.log('Running 1-minute load test for validation...\n');

  try {
    // Run benchmark
    const result = await runThroughputBenchmark(config);

    // Display results
    displayResults(result);

    // Export JSON results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = join(
      process.cwd(),
      'benchmarks',
      'results',
      `phase5-throughput-quick-${timestamp}.json`
    );
    await exportResults(result, jsonPath);

    console.log('\n✅ Quick validation test complete!');
    console.log('\nTo run full 10-minute benchmark, use: npx tsx benchmarks/phase5/throughput-benchmark.ts');
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
