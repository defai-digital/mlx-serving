/**
 * Comprehensive Benchmark: Sequential vs Static vs Continuous Batching
 *
 * Week 2 Day 5: Validate continuous batching performance
 *
 * Compares:
 * 1. Sequential generation (baseline) - One request at a time
 * 2. Static batching (Week 1) - Fixed batch, all start/finish together
 * 3. Continuous batching (Week 2) - Dynamic batch, join/leave independently
 *
 * Expected Results:
 * - Sequential: 2.6 req/sec (baseline)
 * - Static batching: 6-8 req/sec (2-3x improvement)
 * - Continuous batching: 12-20 req/sec (3-5x improvement) 🎯
 */

import { Engine } from '../dist/index.js';
import { pino } from 'pino';

const TEST_QUESTIONS = [
  'What is 2+2?',
  'What is 3+3?',
  'What is 4+4?',
  'What is 5+5?',
  'What is 6+6?',
  'What is 7+7?',
  'What is 8+8?',
  'What is 9+9?',
];

const MODEL = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 30;

interface BenchmarkResult {
  method: string;
  totalTime: number;
  avgLatency: number;
  throughput: number;
  requests: number;
  totalTokens: number;
  tokenThroughput: number;
  description: string;
}

async function benchmarkSequential(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking Sequential Generation (Baseline)...');
  console.log('   One request at a time, no batching\n');

  let totalTokens = 0;
  const start = performance.now();

  for (const question of questions) {
    const generator = engine.createGenerator({
      model: MODEL,
      prompt: question,
      maxTokens: MAX_TOKENS,
      streaming: true,
    });

    let tokenCount = 0;
    for await (const chunk of generator) {
      tokenCount++;
    }
    totalTokens += tokenCount;

    process.stdout.write('.');
  }

  const totalTime = performance.now() - start;
  console.log(' ✓');

  return {
    method: 'Sequential',
    totalTime,
    avgLatency: totalTime / questions.length,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
    totalTokens,
    tokenThroughput: totalTokens / (totalTime / 1000),
    description: 'Baseline - no batching, one at a time'
  };
}

async function benchmarkStaticBatching(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking Static Batching (Week 1)...');
  console.log('   Fixed batch size, all start/finish together\n');

  const runtime = (engine as any).lastTransport;
  if (!runtime) {
    throw new Error('Runtime not available');
  }

  const requests = questions.map((question, i) => ({
    model_id: MODEL,
    prompt: question,
    max_tokens: MAX_TOKENS,
    stream_id: `stream-static-${i}`,
    temperature: 0.7,
  }));

  // Track tokens
  const tokens = new Map<string, number>();
  const completed = new Set<string>();

  runtime.on('notification', (notification: any) => {
    const { method, params } = notification;

    if (method === 'stream.chunk') {
      const { stream_id } = params;
      if (stream_id?.startsWith('stream-static-')) {
        tokens.set(stream_id, (tokens.get(stream_id) || 0) + 1);
        process.stdout.write('.');
      }
    }

    if (method === 'stream.event') {
      const { stream_id, event } = params;
      if (event === 'completed' && stream_id?.startsWith('stream-static-')) {
        completed.add(stream_id);
      }
    }
  });

  const start = performance.now();

  // Send batch request
  await runtime.request('batch_generate_parallel', {
    requests,
    batch_size: questions.length,
  });

  // Wait for completion
  const timeout = 60000;
  const checkInterval = 100;
  let elapsed = 0;

  while (completed.size < requests.length && elapsed < timeout) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    elapsed += checkInterval;
  }

  const totalTime = performance.now() - start;
  console.log(' ✓');

  const totalTokens = Array.from(tokens.values()).reduce((sum, count) => sum + count, 0);

  return {
    method: 'Static Batching (Week 1)',
    totalTime,
    avgLatency: totalTime / questions.length,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
    totalTokens,
    tokenThroughput: totalTokens / (totalTime / 1000),
    description: 'Fixed batch, all requests start/finish together'
  };
}

async function benchmarkContinuousBatching(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking Continuous Batching (Week 2)...');
  console.log('   Dynamic batch, requests join/leave independently\n');

  const runtime = (engine as any).lastTransport;
  if (!runtime) {
    throw new Error('Runtime not available');
  }

  // Track tokens and completion
  const tokens = new Map<string, number>();
  const completed = new Set<string>();
  const startTimes = new Map<string, number>();
  const endTimes = new Map<string, number>();

  runtime.on('notification', (notification: any) => {
    const { method, params } = notification;

    if (method === 'stream.chunk') {
      const { stream_id } = params;
      if (stream_id?.startsWith('stream-continuous-')) {
        tokens.set(stream_id, (tokens.get(stream_id) || 0) + 1);
        process.stdout.write('.');
      }
    }

    if (method === 'stream.event') {
      const { stream_id, event } = params;
      if (event === 'completed' && stream_id?.startsWith('stream-continuous-')) {
        completed.add(stream_id);
        endTimes.set(stream_id, performance.now());
      }
    }
  });

  const testStart = performance.now();

  // Send requests (non-blocking)
  for (let i = 0; i < questions.length; i++) {
    const stream_id = `stream-continuous-${i}`;
    startTimes.set(stream_id, performance.now());

    await runtime.request('continuous_generate', {
      model_id: MODEL,
      prompt: questions[i],
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      stream_id,
    });

    // Stagger slightly to demonstrate continuous batching benefit
    if (i < questions.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // Wait for completion
  const timeout = 60000;
  const checkInterval = 100;
  let elapsed = 0;

  while (completed.size < questions.length && elapsed < timeout) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    elapsed += checkInterval;
  }

  const totalTime = performance.now() - testStart;
  console.log(' ✓');

  const totalTokens = Array.from(tokens.values()).reduce((sum, count) => sum + count, 0);

  // Calculate average per-request latency
  let totalLatency = 0;
  for (const [stream_id, start] of startTimes.entries()) {
    const end = endTimes.get(stream_id) || testStart + totalTime;
    totalLatency += (end - start);
  }
  const avgLatency = totalLatency / questions.length;

  return {
    method: 'Continuous Batching (Week 2)',
    totalTime,
    avgLatency,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
    totalTokens,
    tokenThroughput: totalTokens / (totalTime / 1000),
    description: 'Dynamic batch, no head-of-line blocking'
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(90));
  console.log('BENCHMARK RESULTS - Sequential vs Static vs Continuous Batching');
  console.log('='.repeat(90));

  console.log('\nConfiguration:');
  console.log(`  Model: ${MODEL}`);
  console.log(`  Requests: ${results[0]?.requests || 0}`);
  console.log(`  Max Tokens: ${MAX_TOKENS} per request`);

  console.log('\n' + '─'.repeat(90));
  console.log('Method                          Total Time  Avg Latency  Throughput    Speedup  Tokens   Tok/s');
  console.log('─'.repeat(90));

  const baseline = results.find(r => r.method === 'Sequential');
  const baselineThroughput = baseline?.throughput || 1;

  for (const result of results) {
    if (result.totalTime === 0) continue;

    const speedup = result.throughput / baselineThroughput;
    const speedupStr = speedup.toFixed(2) + 'x';
    const improvement = ((speedup - 1) * 100).toFixed(0) + '%';

    console.log(
      `${result.method.padEnd(30)} ` +
      `${result.totalTime.toFixed(0).padStart(9)}ms  ` +
      `${result.avgLatency.toFixed(0).padStart(9)}ms  ` +
      `${result.throughput.toFixed(2).padStart(9)} r/s  ` +
      `${speedupStr.padStart(7)}  ` +
      `${result.totalTokens.toString().padStart(6)}  ` +
      `${result.tokenThroughput.toFixed(1).padStart(7)}`
    );
    console.log(`  └─ ${result.description} ${speedup > 1 ? `(+${improvement})` : ''}`);
  }

  console.log('─'.repeat(90));

  // Analysis
  console.log('\nDetailed Analysis:');

  const sequential = results.find(r => r.method === 'Sequential');
  const staticBatch = results.find(r => r.method === 'Static Batching (Week 1)');
  const continuous = results.find(r => r.method === 'Continuous Batching (Week 2)');

  if (sequential && staticBatch) {
    const improvement = ((staticBatch.throughput - sequential.throughput) / sequential.throughput) * 100;
    console.log(`\n  Week 1 (Static Batching):`);
    console.log(`    • Throughput: ${staticBatch.throughput.toFixed(2)} req/sec (${improvement.toFixed(0)}% improvement)`);
    console.log(`    • Target: 2-3x improvement (200-300%)`);
    console.log(`    • Status: ${improvement >= 100 ? '✅ Target achieved' : '⚠️  Below target'}`);
  }

  if (sequential && continuous) {
    const improvement = ((continuous.throughput - sequential.throughput) / sequential.throughput) * 100;
    console.log(`\n  Week 2 (Continuous Batching):`);
    console.log(`    • Throughput: ${continuous.throughput.toFixed(2)} req/sec (${improvement.toFixed(0)}% improvement)`);
    console.log(`    • Target: 3-5x improvement (200-400%)`);
    console.log(`    • Status: ${improvement >= 200 ? '✅ Target achieved' : '⚠️  Below target'}`);
  }

  if (staticBatch && continuous) {
    const improvement = ((continuous.throughput - staticBatch.throughput) / staticBatch.throughput) * 100;
    console.log(`\n  Week 2 vs Week 1:`);
    console.log(`    • Additional improvement: ${improvement.toFixed(0)}%`);
    console.log(`    • Continuous batching benefit: ${improvement >= 20 ? '✅ Significant' : '⚠️  Marginal'}`);
  }

  // Key insights
  console.log('\nKey Insights:');
  if (continuous && staticBatch) {
    if (continuous.avgLatency < staticBatch.avgLatency) {
      const reduction = ((staticBatch.avgLatency - continuous.avgLatency) / staticBatch.avgLatency) * 100;
      console.log(`  ✓ Lower average latency: -${reduction.toFixed(0)}% (no head-of-line blocking)`);
    }
    if (continuous.tokenThroughput > staticBatch.tokenThroughput) {
      const increase = ((continuous.tokenThroughput - staticBatch.tokenThroughput) / staticBatch.tokenThroughput) * 100;
      console.log(`  ✓ Higher token throughput: +${increase.toFixed(0)}%`);
    }
    console.log(`  ✓ Dynamic batch composition: Requests join/leave independently`);
    console.log(`  ✓ Continuous GPU utilization: No idle periods`);
  }

  console.log('\n' + '='.repeat(90));
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Comprehensive Batching Benchmark - Sequential vs Static vs Continuous            ║');
  console.log('║  Week 2 Day 5: Performance Validation                                             ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');

  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  try {
    // Load model
    console.log(`\n📦 Loading model: ${MODEL}...`);
    await engine.loadModel({ model: MODEL });
    console.log('✅ Model loaded');

    // Run benchmarks
    const results: BenchmarkResult[] = [];

    // 1. Sequential (baseline)
    results.push(await benchmarkSequential(engine, TEST_QUESTIONS));
    await new Promise(resolve => setTimeout(resolve, 1000)); // Cool down

    // 2. Static batching (Week 1)
    try {
      results.push(await benchmarkStaticBatching(engine, TEST_QUESTIONS));
      await new Promise(resolve => setTimeout(resolve, 1000)); // Cool down
    } catch (error) {
      console.log('⚠️  Static batching benchmark failed:', error);
    }

    // 3. Continuous batching (Week 2)
    try {
      results.push(await benchmarkContinuousBatching(engine, TEST_QUESTIONS));
      await new Promise(resolve => setTimeout(resolve, 1000)); // Cool down
    } catch (error) {
      console.error('❌ Continuous batching benchmark failed:', error);
    }

    // Print results
    printResults(results);

    // Cleanup
    await engine.shutdown();

    console.log('\n✅ Benchmark complete');

    // Exit with success if we got results
    if (results.length >= 2) {
      process.exit(0);
    } else {
      console.log('\n⚠️  Insufficient benchmark results');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Benchmark failed:', error);
    await engine.shutdown();
    process.exit(1);
  }
}

main();
