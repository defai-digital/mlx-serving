/**
 * Concurrency Load Test Script - v1.2.0
 *
 * Manual load testing script to validate v1.2.0 concurrency improvements.
 * Run this script to measure real-world performance under various load levels.
 *
 * Usage:
 *   npx tsx tests/load/concurrency-load-test.ts [concurrency] [model]
 *
 * Examples:
 *   npx tsx tests/load/concurrency-load-test.ts 10 mlx-community/Llama-3.2-1B-Instruct-4bit
 *   npx tsx tests/load/concurrency-load-test.ts 50 mlx-community/Llama-3.2-3B-Instruct-4bit
 */

import { MLXEngine } from '../../src/api/mlx-engine.js';

interface LoadTestConfig {
  concurrency: number;
  model: string;
  maxTokens: number;
  iterations: number;
}

interface LoadTestResults {
  totalRequests: number;
  successful: number;
  failed: number;
  totalTokens: number;
  totalDuration: number;
  avgLatency: number;
  throughput: number;
  successRate: number;
  errors: Array<{ index: number; error: string }>;
}

async function runLoadTest(config: LoadTestConfig): Promise<LoadTestResults> {
  console.log('🚀 Starting Concurrency Load Test - v1.2.0');
  console.log('='.repeat(60));
  console.log(`Model:       ${config.model}`);
  console.log(`Concurrency: ${config.concurrency} requests`);
  console.log(`Max Tokens:  ${config.maxTokens}`);
  console.log(`Iterations:  ${config.iterations}`);
  console.log('='.repeat(60));
  console.log('');

  const engine = new MLXEngine(config.model);
  await engine.init();

  const results: LoadTestResults = {
    totalRequests: 0,
    successful: 0,
    failed: 0,
    totalTokens: 0,
    totalDuration: 0,
    avgLatency: 0,
    throughput: 0,
    successRate: 0,
    errors: [],
  };

  try {
    for (let iter = 0; iter < config.iterations; iter++) {
      console.log(`\n📊 Iteration ${iter + 1}/${config.iterations}`);

      const requests = Array.from({ length: config.concurrency }, (_, i) => ({
        prompt: `Load test request ${iter}-${i}: Generate a short response.`,
        max_tokens: config.maxTokens,
      }));

      const startTime = Date.now();
      const batchResults = await Promise.allSettled(
        requests.map(async (req, idx) => {
          try {
            const tokens: string[] = [];
            const reqStart = Date.now();

            for await (const chunk of engine.generateStream(req.prompt, { max_tokens: req.max_tokens })) {
              if (chunk.type === 'token') {
                tokens.push(chunk.token);
              }
            }

            const latency = Date.now() - reqStart;
            return { tokens, latency, index: idx };
          } catch (error) {
            throw new Error(
              `Request ${idx} failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        })
      );

      const iterDuration = Date.now() - startTime;

      // Process results
      let iterTokens = 0;
      let iterSuccessful = 0;
      let iterFailed = 0;
      const latencies: number[] = [];

      batchResults.forEach((result, idx) => {
        results.totalRequests++;

        if (result.status === 'fulfilled') {
          iterSuccessful++;
          results.successful++;
          iterTokens += result.value.tokens.length;
          results.totalTokens += result.value.tokens.length;
          latencies.push(result.value.latency);
        } else {
          iterFailed++;
          results.failed++;
          results.errors.push({
            index: iter * config.concurrency + idx,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });

      results.totalDuration += iterDuration;

      // Print iteration stats
      const iterSuccessRate = (iterSuccessful / config.concurrency) * 100;
      const iterThroughput = (iterTokens / iterDuration) * 1000;
      const iterAvgLatency = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

      console.log(`   ✅ Succeeded: ${iterSuccessful}/${config.concurrency} (${iterSuccessRate.toFixed(1)}%)`);
      console.log(`   ❌ Failed: ${iterFailed}`);
      console.log(`   🔢 Tokens: ${iterTokens}`);
      console.log(`   ⏱️  Duration: ${iterDuration}ms`);
      console.log(`   ⚡ Throughput: ${iterThroughput.toFixed(1)} tok/s`);
      console.log(`   📊 Avg Latency: ${iterAvgLatency.toFixed(0)}ms`);

      // Small delay between iterations
      if (iter < config.iterations - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Calculate final stats
    results.successRate = (results.successful / results.totalRequests) * 100;
    results.throughput = (results.totalTokens / results.totalDuration) * 1000;
    results.avgLatency = results.totalDuration / results.totalRequests;

    console.log('\n');
    console.log('='.repeat(60));
    console.log('📈 FINAL RESULTS');
    console.log('='.repeat(60));
    console.log(`Total Requests:  ${results.totalRequests}`);
    console.log(`Successful:      ${results.successful} (${results.successRate.toFixed(1)}%)`);
    console.log(`Failed:          ${results.failed}`);
    console.log(`Total Tokens:    ${results.totalTokens}`);
    console.log(`Total Duration:  ${(results.totalDuration / 1000).toFixed(2)}s`);
    console.log(`Avg Latency:     ${results.avgLatency.toFixed(0)}ms`);
    console.log(`Throughput:      ${results.throughput.toFixed(1)} tok/s`);
    console.log('='.repeat(60));

    // Print errors if any
    if (results.errors.length > 0) {
      console.log('\n⚠️  ERRORS:');
      results.errors.forEach((err) => {
        console.log(`   Request ${err.index}: ${err.error}`);
      });
    }

    // v1.2.0 Comparison
    console.log('\n🎯 v1.2.0 IMPROVEMENT METRICS:');
    console.log('='.repeat(60));
    console.log('Expected improvements vs v1.1.1:');
    console.log(`  ✅ Success Rate: ${results.successRate.toFixed(1)}% (v1.1.1: 70%)`);
    if (results.successRate > 70) {
      console.log('     ✅ IMPROVED from v1.1.1!');
    } else {
      console.log('     ⚠️  Below v1.1.1 baseline');
    }

    const rejectionRate = (results.failed / results.totalRequests) * 100;
    console.log(`  ✅ Rejections: ${rejectionRate.toFixed(1)}% (v1.1.1: 12%)`);
    if (rejectionRate < 12) {
      console.log('     ✅ REDUCED from v1.1.1!');
    } else {
      console.log('     ⚠️  Above v1.1.1 baseline');
    }

    console.log('='.repeat(60));
  } finally {
    await engine.dispose();
  }

  return results;
}

// CLI handling
const concurrency = parseInt(process.argv[2] || '10', 10);
const model = process.argv[3] || 'mlx-community/Llama-3.2-1B-Instruct-4bit';
const maxTokens = parseInt(process.argv[4] || '10', 10);
const iterations = parseInt(process.argv[5] || '3', 10);

const config: LoadTestConfig = {
  concurrency,
  model,
  maxTokens,
  iterations,
};

runLoadTest(config)
  .then((results) => {
    console.log('\n✅ Load test completed successfully!');
    process.exit(results.successRate >= 70 ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n❌ Load test failed:', error);
    process.exit(1);
  });
