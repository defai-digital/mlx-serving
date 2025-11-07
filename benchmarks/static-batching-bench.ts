/**
 * Static Batching Benchmark
 *
 * Week 1 Day 5: Validate 2-3x throughput improvement
 *
 * Compares:
 * - Sequential generation (baseline)
 * - Batch generation (IPC batching only)
 * - Parallel batch generation (GPU batching) ← NEW
 *
 * Target: 2-3x throughput improvement with GPU batching
 */

import { Engine } from '../dist/index.js';
import { pino } from 'pino';

const TEST_QUESTIONS = [
  'What is 2+2?',
  'What is 3+3?',
  'What is 4+4?',
  'What is 5+5?',
];

const MODEL = 'models/llama-3.2-3b-instruct';
const MAX_TOKENS = 50;

interface BenchmarkResult {
  method: string;
  totalTime: number;
  avgLatency: number;
  throughput: number;
  requests: number;
}

async function benchmarkSequential(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking Sequential Generation (Baseline)...');

  const start = performance.now();

  for (const question of questions) {
    const generator = engine.createGenerator({
      model: MODEL,
      prompt: question,
      maxTokens: MAX_TOKENS,
      streaming: true,
    });

    // Consume all tokens
    for await (const chunk of generator) {
      // Just consume
    }
  }

  const totalTime = performance.now() - start;

  return {
    method: 'Sequential',
    totalTime,
    avgLatency: totalTime / questions.length,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
  };
}

async function benchmarkBatchIPC(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking IPC Batch Generation...');

  const start = performance.now();

  // Use existing batch_generate (IPC batching only, still sequential GPU)
  const requests = questions.map((question, i) => ({
    model_id: MODEL,
    prompt: question,
    max_tokens: MAX_TOKENS,
    stream_id: `stream-ipc-${i}`,
  }));

  // Note: This requires accessing the internal transport
  // For now, we'll fall back to sequential if not available
  const runtime = (engine as any).lastTransport;

  if (!runtime) {
    console.log('⚠️  Batch IPC not available, skipping...');
    return {
      method: 'Batch IPC',
      totalTime: 0,
      avgLatency: 0,
      throughput: 0,
      requests: questions.length,
    };
  }

  // Track completion
  const completions = new Map<string, boolean>();
  requests.forEach(req => completions.set(req.stream_id, false));

  // Listen for completions
  const completionPromise = new Promise<void>((resolve) => {
    const checkComplete = () => {
      if (Array.from(completions.values()).every(done => done)) {
        resolve();
      }
    };

    // Listen for stream events
    engine.on('generation:completed', (event: any) => {
      if (event.streamId && completions.has(event.streamId)) {
        completions.set(event.streamId, true);
        checkComplete();
      }
    });
  });

  // Send batch request
  await runtime.request('batch_generate', { requests });

  // Wait for all to complete
  await completionPromise;

  const totalTime = performance.now() - start;

  return {
    method: 'Batch IPC',
    totalTime,
    avgLatency: totalTime / questions.length,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
  };
}

async function benchmarkBatchParallel(engine: Engine, questions: string[]): Promise<BenchmarkResult> {
  console.log('\n📊 Benchmarking Parallel Batch Generation (GPU Batching)...');

  const start = performance.now();

  // Use new batch_generate_parallel (GPU batching)
  const requests = questions.map((question, i) => ({
    model_id: MODEL,
    prompt: question,
    max_tokens: MAX_TOKENS,
    stream_id: `stream-parallel-${i}`,
  }));

  const runtime = (engine as any).lastTransport;

  if (!runtime) {
    throw new Error('Runtime not available');
  }

  // Track completion
  const completions = new Map<string, boolean>();
  requests.forEach(req => completions.set(req.stream_id, false));

  // Listen for completions
  const completionPromise = new Promise<void>((resolve) => {
    const checkComplete = () => {
      if (Array.from(completions.values()).every(done => done)) {
        resolve();
      }
    };

    // Listen for stream events
    const handler = (event: any) => {
      if (event.params?.stream_id && completions.has(event.params.stream_id)) {
        if (event.params.event === 'completed') {
          completions.set(event.params.stream_id, true);
          checkComplete();
        }
      }
    };

    // Subscribe to stream.event notifications
    runtime.on('notification', handler);

    // Cleanup after completion
    completionPromise.then(() => {
      runtime.off('notification', handler);
    });
  });

  // Send batch_generate_parallel request
  await runtime.request('batch_generate_parallel', {
    requests,
    batch_size: questions.length,
  });

  // Wait for all to complete
  await completionPromise;

  const totalTime = performance.now() - start;

  return {
    method: 'Batch Parallel (GPU)',
    totalTime,
    avgLatency: totalTime / questions.length,
    throughput: (questions.length / (totalTime / 1000)),
    requests: questions.length,
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(80));

  console.log('\nConfiguration:');
  console.log(`  Model: ${MODEL}`);
  console.log(`  Requests: ${results[0]?.requests || 0}`);
  console.log(`  Max Tokens: ${MAX_TOKENS}`);

  console.log('\nResults:');
  console.log('─'.repeat(80));
  console.log('Method                     Total Time    Avg Latency    Throughput    Speedup');
  console.log('─'.repeat(80));

  const baseline = results.find(r => r.method === 'Sequential');
  const baselineThroughput = baseline?.throughput || 1;

  for (const result of results) {
    if (result.totalTime === 0) continue; // Skip skipped benchmarks

    const speedup = result.throughput / baselineThroughput;
    const speedupStr = speedup.toFixed(2) + 'x';

    console.log(
      `${result.method.padEnd(25)} ${result.totalTime.toFixed(0).padStart(9)}ms` +
      `   ${result.avgLatency.toFixed(0).padStart(9)}ms` +
      `   ${result.throughput.toFixed(2).padStart(9)} req/s` +
      `   ${speedupStr.padStart(7)}`
    );
  }

  console.log('─'.repeat(80));

  // Analysis
  console.log('\nAnalysis:');

  const parallel = results.find(r => r.method === 'Batch Parallel (GPU)');
  if (parallel && baseline) {
    const improvement = ((parallel.throughput - baseline.throughput) / baseline.throughput) * 100;
    const latencyOverhead = parallel.avgLatency - baseline.avgLatency;

    console.log(`  ✓ GPU Batching Improvement: ${improvement.toFixed(1)}%`);
    console.log(`  ✓ Latency Overhead: +${latencyOverhead.toFixed(0)}ms`);

    if (improvement >= 100) {
      console.log(`  ✅ Target achieved! (>2x improvement)`);
    } else {
      console.log(`  ⚠️  Below target (need >2x, got ${(improvement / 100 + 1).toFixed(2)}x)`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Static Batching Benchmark - Week 1 Validation               ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

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

    // 2. Batch IPC (for comparison)
    try {
      results.push(await benchmarkBatchIPC(engine, TEST_QUESTIONS));
    } catch (error) {
      console.log('⚠️  Batch IPC benchmark skipped:', error);
    }

    // 3. Batch Parallel (GPU) - NEW
    try {
      results.push(await benchmarkBatchParallel(engine, TEST_QUESTIONS));
    } catch (error) {
      console.error('❌ Batch Parallel benchmark failed:', error);
    }

    // Print results
    printResults(results);

    // Cleanup
    await engine.shutdown();

    console.log('\n✅ Benchmark complete');

  } catch (error) {
    console.error('❌ Benchmark failed:', error);
    process.exit(1);
  }
}

main();
