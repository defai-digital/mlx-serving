/**
 * Simple Throughput Test
 *
 * Measures raw throughput by timing how long it takes to complete N requests
 * This avoids the token tracking issues and gives us clean timing data
 */

import { Engine } from '../dist/index.js';
import { pino } from 'pino';

const MODEL = 'models/llama-3.2-3b-instruct';
const NUM_REQUESTS = 8;
const MAX_TOKENS = 30;

interface TestResult {
  method: string;
  duration: number;
  throughput: number;
  avgLatency: number;
}

async function testSequential(): Promise<TestResult> {
  console.log('\n📊 Testing Sequential Generation (Baseline)...');

  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  await engine.loadModel({ model: MODEL });

  const start = performance.now();

  for (let i = 0; i < NUM_REQUESTS; i++) {
    const gen = engine.createGenerator({
      model: MODEL,
      prompt: `What is ${i+2}+${i+2}?`,
      maxTokens: MAX_TOKENS,
      streaming: true,
    });

    // Consume tokens
    for await (const _chunk of gen) {
      // Just consume
    }

    process.stdout.write('.');
  }

  const duration = performance.now() - start;

  await engine.shutdown();

  console.log(' ✓');

  return {
    method: 'Sequential',
    duration,
    throughput: NUM_REQUESTS / (duration / 1000),
    avgLatency: duration / NUM_REQUESTS,
  };
}

async function testContinuous(): Promise<TestResult> {
  console.log('\n📊 Testing Continuous Batching...');

  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  await engine.loadModel({ model: MODEL });

  const runtime = (engine as any).lastTransport;
  if (!runtime) {
    throw new Error('Runtime not available');
  }

  const completed = new Set<string>();

  runtime.on('notification', (method: string, params: any) => {
    if (method === 'stream.chunk') {
      process.stdout.write('.');
    }

    if (method === 'stream.event' && params?.event === 'completed') {
      completed.add(params.stream_id);
    }
  });

  const start = performance.now();

  // Send all requests
  for (let i = 0; i < NUM_REQUESTS; i++) {
    await runtime.request('continuous_generate', {
      model_id: MODEL,
      prompt: `What is ${i+2}+${i+2}?`,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      stream_id: `stream-${i}`,
    });
  }

  // Wait for completion
  const timeout = 60000;
  const checkInterval = 100;
  let elapsed = 0;

  while (completed.size < NUM_REQUESTS && elapsed < timeout) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    elapsed += checkInterval;
  }

  const duration = performance.now() - start;

  await engine.shutdown();

  console.log(' ✓');

  if (completed.size < NUM_REQUESTS) {
    console.log(`\n⚠️  Warning: Only ${completed.size}/${NUM_REQUESTS} completed`);
  }

  return {
    method: 'Continuous Batching',
    duration,
    throughput: NUM_REQUESTS / (duration / 1000),
    avgLatency: duration / NUM_REQUESTS,
  };
}

function printResults(results: TestResult[]) {
  console.log('\n' + '='.repeat(80));
  console.log('THROUGHPUT TEST RESULTS');
  console.log('='.repeat(80));

  console.log('\nConfiguration:');
  console.log(`  Model: ${MODEL}`);
  console.log(`  Requests: ${NUM_REQUESTS}`);
  console.log(`  Max Tokens: ${MAX_TOKENS} per request`);

  console.log('\n' + '─'.repeat(80));
  console.log('Method                    Duration    Throughput    Avg Latency    Speedup');
  console.log('─'.repeat(80));

  const baseline = results.find(r => r.method === 'Sequential');
  const baselineThroughput = baseline?.throughput || 1;

  for (const result of results) {
    const speedup = result.throughput / baselineThroughput;
    const speedupStr = speedup.toFixed(2) + 'x';

    console.log(
      `${result.method.padEnd(24)} ` +
      `${result.duration.toFixed(0).padStart(9)}ms  ` +
      `${result.throughput.toFixed(2).padStart(11)} r/s  ` +
      `${result.avgLatency.toFixed(0).padStart(11)}ms  ` +
      `${speedupStr.padStart(9)}`
    );
  }

  console.log('─'.repeat(80));

  // Analysis
  if (results.length >= 2) {
    const sequential = results[0];
    const continuous = results[1];
    const improvement = ((continuous.throughput - sequential.throughput) / sequential.throughput) * 100;

    console.log('\nAnalysis:');
    console.log(`  Throughput improvement: ${improvement.toFixed(0)}% (${(continuous.throughput / sequential.throughput).toFixed(2)}x)`);
    console.log(`  Latency reduction: ${((sequential.avgLatency - continuous.avgLatency) / sequential.avgLatency * 100).toFixed(0)}%`);

    if (improvement >= 200) {
      console.log(`  Status: ✅ Target achieved! (3x+ improvement)`);
    } else if (improvement >= 100) {
      console.log(`  Status: ⚠️  Approaching target (need 3x, got ${(improvement/100 + 1).toFixed(1)}x)`);
    } else {
      console.log(`  Status: ❌ Below target (need 3x, got ${(improvement/100 + 1).toFixed(1)}x)`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Simple Throughput Test - Week 2 Validation                   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  try {
    const results: TestResult[] = [];

    // Test 1: Sequential
    results.push(await testSequential());
    await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down

    // Test 2: Continuous
    results.push(await testContinuous());

    // Print results
    printResults(results);

    console.log('\n✅ Test complete');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
