/**
 * Phase 5 Week 2 Day 1-2: Quick TTFT Benchmark Test
 *
 * Quick validation with 20 samples before running full 1000-sample benchmark.
 */

import { runPhase5TtftBenchmark, displayResults, exportResults, generateMarkdownReport } from './ttft-benchmark.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main(): Promise<void> {
  // Quick test configuration (20 samples for fast validation)
  const config = {
    modelId: 'gemma-2-2b-it-4bit',
    modelPath: 'mlx-community/gemma-2-2b-it-4bit', // Smaller model for faster testing
    samples: 20, // Quick test with 20 samples
    warmupRuns: 3, // 3 warmup runs
    maxTokens: 30, // Shorter generation for speed
    temperature: 0.7,
    prompts: [
      'Hello, how are you today?',
      'What is the capital of France?',
      'Explain quantum computing briefly.',
      'Write a short haiku about code.',
    ],
  };

  console.log('\n🧪 Phase 5 TTFT Benchmark - Quick Validation Test\n');
  console.log('Running with 20 samples for validation...\n');

  try {
    // Run benchmark
    const result = await runPhase5TtftBenchmark(config);

    // Display results
    displayResults(result);

    // Export JSON results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = join(
      process.cwd(),
      'benchmarks',
      'results',
      `phase5-ttft-quick-${timestamp}.json`
    );
    await exportResults(result, jsonPath);

    // Generate markdown report
    const markdownReport = generateMarkdownReport(result);
    const reportPath = join(
      process.cwd(),
      'automatosx',
      'tmp',
      `PHASE5-TTFT-QUICK-TEST-${timestamp}.md`
    );
    await mkdir(join(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, markdownReport, 'utf-8');
    console.log(`\nMarkdown report saved to: ${reportPath}`);

    console.log('\n✅ Quick validation test complete!');
    console.log('\nTo run full 1000-sample benchmark, use: npx tsx benchmarks/phase5/ttft-benchmark.ts');
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
