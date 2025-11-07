/**
 * Benchmark: Native CommandBufferPool vs Python
 *
 * Tests the performance improvement of C++/ObjC++ buffer pooling
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

interface BenchmarkResult {
  backend: 'native' | 'python';
  operations: number;
  duration_ms: number;
  ops_per_sec: number;
  avg_latency_us: number;
}

async function runPythonBenchmark(useNative: boolean, iterations: number): Promise<BenchmarkResult> {
  const pythonScript = `
import time
import os
import sys

# Set USE_NATIVE environment variable
os.environ['USE_NATIVE'] = '${useNative ? 'true' : 'false'}'

# Add python directory to path
sys.path.insert(0, 'python')

from native.command_buffer_pool import CommandBufferPool

# Create pool
pool = CommandBufferPool(pool_size=16)

# Warmup
for _ in range(100):
    buf = pool.acquire()
    pool.release(buf)

# Benchmark
start = time.perf_counter()

for _ in range(${iterations}):
    buf = pool.acquire()
    pool.release(buf)

duration = time.perf_counter() - start

# Get stats
stats = pool.get_stats()

print(f"RESULT:{stats['backend']}:{${iterations}}:{duration * 1000:.3f}")
`;

  return new Promise((resolve, reject) => {
    const python = spawn('.kr-mlx-venv/bin/python', ['-c', pythonScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited with code ${code}: ${stderr}`));
        return;
      }

      // Parse result: RESULT:backend:operations:duration_ms
      const match = stdout.match(/RESULT:(\w+):(\d+):([\d.]+)/);
      if (!match) {
        reject(new Error(`Failed to parse result: ${stdout}`));
        return;
      }

      const [, backend, ops, duration_ms] = match;
      const result: BenchmarkResult = {
        backend: backend as 'native' | 'python',
        operations: parseInt(ops),
        duration_ms: parseFloat(duration_ms),
        ops_per_sec: parseInt(ops) / (parseFloat(duration_ms) / 1000),
        avg_latency_us: (parseFloat(duration_ms) / parseInt(ops)) * 1000
      };

      resolve(result);
    });
  });
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  CommandBufferPool: Native vs Python Benchmark      ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const iterations = 100000;

  console.log(`Running ${iterations.toLocaleString()} acquire/release cycles...\n`);

  // Benchmark Python
  console.log('Testing Python implementation...');
  const pythonResult = await runPythonBenchmark(false, iterations);

  // Benchmark Native
  console.log('Testing Native (C++/ObjC++) implementation...');
  const nativeResult = await runPythonBenchmark(true, iterations);

  // Calculate speedup
  const speedup = pythonResult.duration_ms / nativeResult.duration_ms;
  const latencyImprovement = ((pythonResult.avg_latency_us - nativeResult.avg_latency_us) / pythonResult.avg_latency_us) * 100;

  console.log('\n═══ Results ═══\n');

  console.log('Python Implementation:');
  console.log(`  Duration:        ${pythonResult.duration_ms.toFixed(2)}ms`);
  console.log(`  Operations/sec:  ${pythonResult.ops_per_sec.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
  console.log(`  Avg Latency:     ${pythonResult.avg_latency_us.toFixed(2)}µs\n`);

  console.log('Native Implementation:');
  console.log(`  Duration:        ${nativeResult.duration_ms.toFixed(2)}ms`);
  console.log(`  Operations/sec:  ${nativeResult.ops_per_sec.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
  console.log(`  Avg Latency:     ${nativeResult.avg_latency_us.toFixed(2)}µs\n`);

  console.log('═══ Performance Gain ═══\n');
  console.log(`  Speedup:              ${speedup.toFixed(2)}x`);
  console.log(`  Latency Reduction:    ${latencyImprovement.toFixed(1)}%`);
  console.log(`  Time Saved:           ${(pythonResult.duration_ms - nativeResult.duration_ms).toFixed(2)}ms\n`);

  if (speedup >= 2.0) {
    console.log('✅ Excellent! Native implementation is significantly faster');
  } else if (speedup >= 1.5) {
    console.log('✅ Good! Native implementation provides meaningful improvement');
  } else if (speedup >= 1.1) {
    console.log('⚠️  Moderate improvement - may not justify complexity');
  } else {
    console.log('❌ Minimal improvement - not worth the effort');
  }

  // Expected impact on end-to-end performance
  const bufferPoolOverhead = 0.05; // Assume 5% of total request time
  const endToEndImprovement = bufferPoolOverhead * latencyImprovement;

  console.log(`\n📊 Estimated end-to-end impact: ${endToEndImprovement.toFixed(2)}% improvement`);
  console.log('   (assuming buffer pool is 5% of total request time)\n');
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
