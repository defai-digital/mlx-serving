/**
 * Week 4 Performance Benchmark
 *
 * Compares Week 3 baseline (continuous batching only) vs Week 4 (with memory optimization features):
 * - MemoryController: Dynamic batch sizing based on GPU memory
 * - PromptCacheManager: Caching of repeated prompts
 * - Metrics: Cache hit rates, memory utilization, throughput improvements
 *
 * Expected Improvements:
 * - Throughput: 3-5x (from 130 tok/s to 390-650 tok/s)
 * - TTFT (cached): 7-8x faster (from 78ms to 10ms)
 * - Max Batch Size: 2-4x larger (from 8 to 16-32 adaptive)
 * - Memory Utilization: +25% (from 60% to 75-85%)
 *
 * Run with: npm tsx benchmarks/week4-performance-benchmark.ts
 */

import { createEngine } from '../src/index.js';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

interface BenchmarkResult {
  questionNumber: number;
  question: string;
  isRepeat: boolean;
  metrics: {
    totalTimeMs: number;
    ttftMs: number | null;
    tokensGenerated: number;
    throughputTokensPerSec: number;
  };
  success: boolean;
  error?: string;
}

interface Week4Metrics {
  memoryController?: {
    enabled: boolean;
    currentLimit: number;
    utilization: number;
    activeMemoryGb: number;
    oomPrevented?: number;
  };
  promptCache?: {
    enabled: boolean;
    cacheSize: number;
    hitRate: number;
    totalRequests: number;
    cacheHits: number;
    memoryMb: number;
  };
}

interface BenchmarkSummary {
  testName: string;
  timestamp: string;
  modelId: string;
  totalQuestions: number;
  successRate: number;
  metrics: {
    avgTotalTimeMs: number;
    avgTTFTMs: number;
    avgThroughput: number;
    p50TotalTimeMs: number;
    p95TotalTimeMs: number;
    p99TotalTimeMs: number;
    totalTokens: number;
  };
  week4Metrics?: Week4Metrics;
  cacheEffectiveness?: {
    firstRequestAvgMs: number;
    repeatRequestAvgMs: number;
    speedupRatio: number;
  };
}

/**
 * 30 questions with some repeats to test cache effectiveness
 */
const QUESTIONS = [
  // First set (unique prompts)
  'What is machine learning?',
  'Explain quantum computing.',
  'How does photosynthesis work?',
  'What causes climate change?',
  'Describe the water cycle.',
  'How do vaccines work?',
  'What is artificial intelligence?',
  'Explain neural networks.',
  'How does the internet work?',
  'What is DNA?',

  // Second set (repeats - should hit cache)
  'What is machine learning?',  // repeat
  'Explain quantum computing.',  // repeat
  'How does photosynthesis work?',  // repeat
  'What causes climate change?',  // repeat
  'Describe the water cycle.',  // repeat

  // Third set (more unique)
  'How do electric cars work?',
  'What are black holes?',
  'Explain the greenhouse effect.',
  'How does GPS work?',
  'What is cryptocurrency?',

  // Fourth set (more repeats)
  'How does the internet work?',  // repeat
  'What is DNA?',  // repeat
  'What is artificial intelligence?',  // repeat
  'Explain neural networks.',  // repeat
  'How do vaccines work?',  // repeat

  // Fifth set (final unique)
  'What is the speed of light?',
  'How do magnets work?',
  'Explain the theory of relativity.',
  'What causes earthquakes?',
  'How do solar panels work?',
];

async function runBenchmark(testName: string, modelId: string): Promise<BenchmarkSummary> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🚀 ${testName}`);
  console.log(`${'='.repeat(70)}\n`);

  const engine = await createEngine();
  const results: BenchmarkResult[] = [];
  const seenQuestions = new Set<string>();

  try {
    // Load model
    console.log(`Loading model: ${modelId}...`);
    const startLoad = performance.now();
    await engine.loadModel({ model: modelId });
    const loadTime = performance.now() - startLoad;
    console.log(`✅ Model loaded in ${loadTime.toFixed(0)}ms\n`);

    // Run benchmark
    console.log(`Running ${QUESTIONS.length} questions (includes repeats for cache testing)...\n`);

    for (let i = 0; i < QUESTIONS.length; i++) {
      const question = QUESTIONS[i];
      const isRepeat = seenQuestions.has(question);
      seenQuestions.add(question);

      const prefix = isRepeat ? '🔄' : '🆕';
      process.stdout.write(`${prefix} Q${i + 1}/${QUESTIONS.length}: "${question.substring(0, 40)}..." `);

      const startTime = performance.now();
      let ttft: number | null = null;
      let firstTokenTime: number | null = null;

      try {
        let tokenCount = 0;

        for await (const chunk of engine.createGenerator({
          model: modelId,
          prompt: question,
          maxTokens: 50,  // Short responses for faster benchmarking
          temperature: 0.7,
        })) {
          tokenCount++;

          // Capture TTFT (time to first token)
          if (tokenCount === 1 && !firstTokenTime) {
            firstTokenTime = performance.now();
            ttft = firstTokenTime - startTime;
          }
        }

        const totalTime = performance.now() - startTime;
        const throughput = (tokenCount / totalTime) * 1000;

        results.push({
          questionNumber: i + 1,
          question,
          isRepeat,
          metrics: {
            totalTimeMs: totalTime,
            ttftMs: ttft,
            tokensGenerated: tokenCount,
            throughputTokensPerSec: throughput,
          },
          success: true,
        });

        console.log(`✅ ${totalTime.toFixed(0)}ms (${tokenCount} tokens, ${throughput.toFixed(1)} tok/s${ttft ? `, TTFT: ${ttft.toFixed(0)}ms` : ''})`);
      } catch (error: any) {
        const totalTime = performance.now() - startTime;
        results.push({
          questionNumber: i + 1,
          question,
          isRepeat,
          metrics: {
            totalTimeMs: totalTime,
            ttftMs: null,
            tokensGenerated: 0,
            throughputTokensPerSec: 0,
          },
          success: false,
          error: error.message,
        });

        console.log(`❌ Failed: ${error.message}`);
      }
    }

    // Try to get Week 4 metrics (will work if using continuous_generate)
    let week4Metrics: Week4Metrics | undefined;
    try {
      // @ts-ignore - accessing internal API for benchmarking
      const adapter = engine._adapter;
      if (adapter && typeof adapter.callMethod === 'function') {
        // @ts-ignore
        const metrics = await adapter.callMethod('get_week4_metrics', { model_id: modelId });
        week4Metrics = {
          memoryController: metrics.memory_controller,
          promptCache: metrics.prompt_cache,
        };
      }
    } catch (e) {
      // Week 4 metrics not available (expected if not using continuous batching)
    }

    // Calculate statistics
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const totalTimes = successful.map((r) => r.metrics.totalTimeMs);
    const ttfts = successful.filter((r) => r.metrics.ttftMs !== null).map((r) => r.metrics.ttftMs!);
    const throughputs = successful.map((r) => r.metrics.throughputTokensPerSec);

    const avgTotalTime = totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length;
    const avgTTFT = ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0;
    const avgThroughput = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;

    const sorted = totalTimes.sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    const totalTokens = successful.reduce((sum, r) => sum + r.metrics.tokensGenerated, 0);

    // Analyze cache effectiveness (first vs repeat requests)
    let cacheEffectiveness: BenchmarkSummary['cacheEffectiveness'];
    const firstRequests = successful.filter((r) => !r.isRepeat);
    const repeatRequests = successful.filter((r) => r.isRepeat);

    if (firstRequests.length > 0 && repeatRequests.length > 0) {
      const firstAvg = firstRequests.reduce((sum, r) => sum + r.metrics.totalTimeMs, 0) / firstRequests.length;
      const repeatAvg = repeatRequests.reduce((sum, r) => sum + r.metrics.totalTimeMs, 0) / repeatRequests.length;

      cacheEffectiveness = {
        firstRequestAvgMs: firstAvg,
        repeatRequestAvgMs: repeatAvg,
        speedupRatio: firstAvg / repeatAvg,
      };
    }

    const summary: BenchmarkSummary = {
      testName,
      timestamp: new Date().toISOString(),
      modelId,
      totalQuestions: QUESTIONS.length,
      successRate: (successful.length / QUESTIONS.length) * 100,
      metrics: {
        avgTotalTimeMs: avgTotalTime,
        avgTTFTMs: avgTTFT,
        avgThroughput: avgThroughput,
        p50TotalTimeMs: p50,
        p95TotalTimeMs: p95,
        p99TotalTimeMs: p99,
        totalTokens,
      },
      week4Metrics,
      cacheEffectiveness,
    };

    // Print summary
    console.log(`\n${'='.repeat(70)}`);
    console.log('📊 BENCHMARK SUMMARY\n');
    console.log(`Test: ${testName}`);
    console.log(`Model: ${modelId}`);
    console.log(`Questions: ${QUESTIONS.length} (${failed.length} failed)`);
    console.log(`Success Rate: ${summary.successRate.toFixed(1)}%\n`);

    console.log('Performance Metrics:');
    console.log(`  Avg Total Time:    ${avgTotalTime.toFixed(1)}ms`);
    console.log(`  Avg TTFT:          ${avgTTFT.toFixed(1)}ms`);
    console.log(`  Avg Throughput:    ${avgThroughput.toFixed(1)} tokens/sec`);
    console.log(`  P50 Latency:       ${p50.toFixed(1)}ms`);
    console.log(`  P95 Latency:       ${p95.toFixed(1)}ms`);
    console.log(`  P99 Latency:       ${p99.toFixed(1)}ms`);
    console.log(`  Total Tokens:      ${totalTokens}\n`);

    if (cacheEffectiveness) {
      console.log('Cache Effectiveness:');
      console.log(`  First requests avg:   ${cacheEffectiveness.firstRequestAvgMs.toFixed(1)}ms`);
      console.log(`  Repeat requests avg:  ${cacheEffectiveness.repeatRequestAvgMs.toFixed(1)}ms`);
      console.log(`  Speedup ratio:        ${cacheEffectiveness.speedupRatio.toFixed(2)}x`);
      console.log(`  ${cacheEffectiveness.speedupRatio > 1.1 ? '✅' : '⚠️ '} Cache ${cacheEffectiveness.speedupRatio > 1.1 ? 'effective' : 'not effective'}\n`);
    }

    if (week4Metrics) {
      console.log('Week 4 Metrics:');

      if (week4Metrics.memoryController) {
        const mc = week4Metrics.memoryController;
        console.log(`  Memory Controller:`);
        console.log(`    Enabled:         ${mc.enabled}`);
        console.log(`    Current Limit:   ${mc.currentLimit}`);
        console.log(`    Utilization:     ${(mc.utilization * 100).toFixed(1)}%`);
        console.log(`    Active Memory:   ${mc.activeMemoryGb.toFixed(2)} GB`);
        if (mc.oomPrevented !== undefined) {
          console.log(`    OOM Prevented:   ${mc.oomPrevented}`);
        }
      }

      if (week4Metrics.promptCache) {
        const pc = week4Metrics.promptCache;
        console.log(`  Prompt Cache:`);
        console.log(`    Enabled:         ${pc.enabled}`);
        console.log(`    Cache Size:      ${pc.cacheSize}`);
        console.log(`    Hit Rate:        ${(pc.hitRate * 100).toFixed(1)}%`);
        console.log(`    Total Requests:  ${pc.totalRequests}`);
        console.log(`    Cache Hits:      ${pc.cacheHits}`);
        console.log(`    Memory:          ${pc.memoryMb.toFixed(1)} MB`);
      }

      console.log();
    }

    console.log(`${'='.repeat(70)}\n`);

    // Save detailed results
    const resultsFile = `benchmark-results-${testName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`;
    await writeFile(resultsFile, JSON.stringify({ summary, results }, null, 2));
    console.log(`📝 Detailed results saved to: ${resultsFile}\n`);

    return summary;
  } finally {
    await engine.dispose();
  }
}

async function main() {
  console.log('🚀 Week 4 Performance Benchmark\n');
  console.log('This benchmark compares:');
  console.log('  1. Week 3 Baseline: Standard continuous batching');
  console.log('  2. Week 4 Features: MemoryController + PromptCacheManager + AsyncPriorityQueue');
  console.log();
  console.log('Expected Improvements:');
  console.log('  - Throughput: 3-5x (130 tok/s → 390-650 tok/s)');
  console.log('  - TTFT (cached): 7-8x faster (78ms → 10ms)');
  console.log('  - Max Batch Size: 2-4x larger (8 → 16-32 adaptive)');
  console.log('  - Memory Utilization: +25% (60% → 75-85%)');
  console.log();

  const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

  try {
    // Note: To properly compare Week 3 vs Week 4, you would need to:
    // 1. Disable Week 4 features for baseline test
    // 2. Enable Week 4 features for comparison test
    // This requires environment variables or config changes

    console.log('⚠️  Note: This benchmark uses whatever configuration is currently active.');
    console.log('    For a true Week 3 vs Week 4 comparison, run this twice:');
    console.log('      - Once with Week 4 features disabled (baseline)');
    console.log('      - Once with Week 4 features enabled (comparison)\n');

    const summary = await runBenchmark('Week 4 Performance Test', modelId);

    // Save summary
    const summaryFile = `benchmark-summary-week4-${Date.now()}.json`;
    await writeFile(summaryFile, JSON.stringify(summary, null, 2));
    console.log(`📊 Summary saved to: ${summaryFile}\n`);

    console.log('✅ Benchmark complete!\n');
  } catch (error) {
    console.error('❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
