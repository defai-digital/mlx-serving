/**
 * Profile Python runtime to identify bottlenecks
 *
 * Runs a realistic workload and collects detailed profiling data
 */

import { Engine } from '../src/api/engine.js';
import { pino } from 'pino';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const QUESTIONS = [
  'What is the capital of France?',
  'Explain photosynthesis in simple terms.',
  'How do airplanes fly?',
  'What causes seasons on Earth?',
  'Describe the water cycle.',
  'What is DNA and why is it important?',
  'How does the internet work?',
  'Explain the theory of relativity.',
  'What are black holes?',
  'How do vaccines work?',
];

async function profilePythonRuntime() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Python Runtime Profiling                            ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  console.log('Creating profiled Python runtime...\n');

  // Create a Python script that profiles the runtime
  const pythonScript = `
import cProfile
import pstats
import io
import sys
import os
import json
import time

# Add paths
sys.path.insert(0, 'python')
os.chdir('${process.cwd()}')

# Create profiler
profiler = cProfile.Profile()

# Start profiling
profiler.enable()

# Import and run runtime operations
try:
    from runtime import main_loop, handle_request
    from gpu_scheduler import get_scheduler
    from models.generator import Generator

    # Simulate workload
    import asyncio

    async def run_test():
        # Initialize scheduler
        scheduler = get_scheduler()
        await scheduler.start()

        # Simulate some load
        for i in range(10):
            await asyncio.sleep(0.01)

        await scheduler.stop()

    asyncio.run(run_test())

except Exception as e:
    print(f"Error during profiling: {e}", file=sys.stderr)

# Stop profiling
profiler.disable()

# Generate stats
s = io.StringIO()
ps = pstats.Stats(profiler, stream=s)
ps.strip_dirs()
ps.sort_stats('cumulative')
ps.print_stats(50)  # Top 50 functions

# Save detailed stats
stats_str = s.getvalue()
print("=== PROFILING RESULTS ===")
print(stats_str)

# Save to file for analysis
with open('/tmp/python-runtime-profile.txt', 'w') as f:
    f.write(stats_str)

# Get totprim (total primitive calls) statistics
ps.sort_stats('tottime')
s2 = io.StringIO()
ps2 = pstats.Stats(profiler, stream=s2)
ps2.strip_dirs()
ps2.print_stats(30)
stats_tottime = s2.getvalue()

with open('/tmp/python-runtime-profile-tottime.txt', 'w') as f:
    f.write(stats_tottime)

print("\\n=== Profiling data saved to /tmp/python-runtime-profile*.txt ===")
`;

  // Run profiled Python
  return new Promise<void>((resolve, reject) => {
    const python = spawn('.kr-mlx-venv/bin/python', ['-c', pythonScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    python.on('close', (code) => {
      if (code !== 0) {
        console.error('\n❌ Profiling failed');
        reject(new Error(`Python exited with code ${code}`));
      } else {
        console.log('\n✅ Profiling complete');
        resolve();
      }
    });
  });
}

async function profileEndToEnd() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  End-to-End Request Profiling                        ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const logger = pino({ level: 'error' });
  const engine = new Engine({}, { logger });

  console.log('Loading model...');
  await engine.loadModel({ model: 'models/llama-3.2-3b-instruct' });

  const timings: Record<string, number[]> = {
    total: [],
    firstToken: [],
    generation: [],
  };

  console.log(`\nProcessing ${QUESTIONS.length} questions...\n`);

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    const startTime = performance.now();
    let firstTokenTime = 0;
    let tokenCount = 0;

    const generator = engine.createGenerator({
      model: 'models/llama-3.2-3b-instruct',
      prompt: question,
      maxTokens: 50,
      streaming: true,
    });

    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        if (tokenCount === 0) {
          firstTokenTime = performance.now() - startTime;
        }
        tokenCount++;
      }
    }

    const totalTime = performance.now() - startTime;
    const generationTime = totalTime - firstTokenTime;

    timings.total.push(totalTime);
    timings.firstToken.push(firstTokenTime);
    timings.generation.push(generationTime);

    console.log(`  [${i + 1}/${QUESTIONS.length}] ${totalTime.toFixed(0)}ms (TTFT: ${firstTokenTime.toFixed(0)}ms, Gen: ${generationTime.toFixed(0)}ms)`);
  }

  await engine.shutdown();

  // Calculate statistics
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  console.log('\n═══ Request Breakdown ═══\n');
  console.log(`  Average Total Time:      ${avg(timings.total).toFixed(2)}ms`);
  console.log(`  Average TTFT:            ${avg(timings.firstToken).toFixed(2)}ms (${(avg(timings.firstToken) / avg(timings.total) * 100).toFixed(1)}%)`);
  console.log(`  Average Generation Time: ${avg(timings.generation).toFixed(2)}ms (${(avg(timings.generation) / avg(timings.total) * 100).toFixed(1)}%)`);

  return timings;
}

async function main() {
  console.log('Starting comprehensive profiling...\n');

  // 1. Profile Python runtime
  try {
    await profilePythonRuntime();
  } catch (error) {
    console.error('Python profiling failed:', error);
  }

  // 2. Profile end-to-end requests
  try {
    await profileEndToEnd();
  } catch (error) {
    console.error('End-to-end profiling failed:', error);
  }

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  Profiling Complete                                  ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  console.log('Results saved to:');
  console.log('  • /tmp/python-runtime-profile.txt (cumulative time)');
  console.log('  • /tmp/python-runtime-profile-tottime.txt (self time)');
  console.log('\nNext steps:');
  console.log('  1. Review profiling data: cat /tmp/python-runtime-profile.txt');
  console.log('  2. Identify bottlenecks (functions with high cumulative time)');
  console.log('  3. Focus C++ optimization on top functions');
}

main().catch((error) => {
  console.error('Profiling failed:', error);
  process.exit(1);
});
