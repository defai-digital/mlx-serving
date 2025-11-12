/**
 * Object Pooling Example
 *
 * Demonstrates how to use ObjectPool for efficient object reuse and reduced GC pressure.
 *
 * Performance gain: 20% reduction in garbage collection overhead
 *
 * Run: npx tsx examples/performance/02-object-pooling.ts
 */

import { ObjectPool } from '@defai.digital/mlx-serving';

// Example object type (state object in real usage)
interface GeneratorState {
  modelId: string;
  status: 'idle' | 'active' | 'complete';
  lastUsed: number;
  tokensGenerated: number;
}

// Factory function: creates new objects
function createState(): GeneratorState {
  return {
    modelId: '',
    status: 'idle',
    lastUsed: 0,
    tokensGenerated: 0,
  };
}

// Reset function: prepares objects for reuse
function resetState(state: GeneratorState): void {
  state.modelId = '';
  state.status = 'idle';
  state.lastUsed = 0;
  state.tokensGenerated = 0;
}

async function main() {
  console.log('=== Object Pooling Example ===\n');

  // Step 1: Create an object pool
  console.log('Creating object pool...');
  const pool = new ObjectPool<GeneratorState>(
    createState,  // Factory function
    resetState,   // Reset function
    {
      maxSize: 100,      // Maximum pool size
      preallocate: 10,   // Pre-create 10 objects
    }
  );

  console.log('Pool created with:');
  console.log('  - Max size: 100');
  console.log('  - Preallocated: 10 objects\n');

  // Step 2: Get initial statistics
  let stats = pool.getStats();
  console.log('Initial pool stats:');
  console.log(`  - Total created: ${stats.totalCreated}`);
  console.log(`  - Available: ${stats.available}`);
  console.log(`  - In use: ${stats.inUse}`);
  console.log(`  - Reuse count: ${stats.reuseCount}\n`);

  // Step 3: Simulate multiple generations (without pooling)
  console.log('Simulating 1,000 generations WITHOUT pooling...');
  const withoutPoolStart = Date.now();
  const states1: GeneratorState[] = [];

  for (let i = 0; i < 1000; i++) {
    // Create new object every time (GC pressure)
    const state = createState();
    state.modelId = `model-${i % 5}`;
    state.status = 'active';
    state.tokensGenerated = Math.floor(Math.random() * 100);
    states1.push(state);
  }

  const withoutPoolTime = Date.now() - withoutPoolStart;
  console.log(`Completed in ${withoutPoolTime}ms`);
  console.log(`Objects created: ${states1.length}\n`);

  // Step 4: Simulate multiple generations (with pooling)
  console.log('Simulating 1,000 generations WITH pooling...');
  const withPoolStart = Date.now();

  for (let i = 0; i < 1000; i++) {
    // Acquire from pool (reuse)
    const state = pool.acquire();
    state.modelId = `model-${i % 5}`;
    state.status = 'active';
    state.tokensGenerated = Math.floor(Math.random() * 100);

    // Release back to pool
    pool.release(state);
  }

  const withPoolTime = Date.now() - withPoolStart;
  console.log(`Completed in ${withPoolTime}ms`);

  // Step 5: Get final statistics
  stats = pool.getStats();
  console.log('\nFinal pool stats:');
  console.log(`  - Total created: ${stats.totalCreated}`);
  console.log(`  - Available: ${stats.available}`);
  console.log(`  - In use: ${stats.inUse}`);
  console.log(`  - Reuse count: ${stats.reuseCount}`);
  console.log(`  - Hit rate: ${(stats.hitRate * 100).toFixed(2)}%\n`);

  // Step 6: Performance comparison
  console.log('=== Performance Comparison ===');
  console.log(`Without pooling: ${withoutPoolTime}ms (1,000 objects created)`);
  console.log(`With pooling: ${withPoolTime}ms (${stats.totalCreated} objects created, ${stats.reuseCount} reuses)`);
  console.log(`Speedup: ${(withoutPoolTime / withPoolTime).toFixed(2)}x faster`);
  console.log(`GC pressure reduction: ${(((1000 - stats.totalCreated) / 1000) * 100).toFixed(1)}%\n`);

  // Step 7: Real-world usage pattern
  console.log('=== Real-World Usage Pattern ===');
  console.log('Simulating concurrent generations with acquire/release...\n');

  const concurrent = 5;
  const activeStates: GeneratorState[] = [];

  // Acquire objects for concurrent operations
  for (let i = 0; i < concurrent; i++) {
    const state = pool.acquire();
    state.modelId = `model-${i}`;
    state.status = 'active';
    state.lastUsed = Date.now();
    activeStates.push(state);
    console.log(`[Acquire] State ${i}: ${state.modelId} (status: ${state.status})`);
  }

  stats = pool.getStats();
  console.log(`\nPool state: ${stats.available} available, ${stats.inUse} in use`);

  // Simulate work
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Release objects back to pool
  console.log('\nReleasing objects back to pool...');
  for (let i = 0; i < activeStates.length; i++) {
    const state = activeStates[i];
    state.status = 'complete';
    pool.release(state);
    console.log(`[Release] State ${i}: ${state.modelId} (status: ${state.status})`);
  }

  stats = pool.getStats();
  console.log(`\nPool state: ${stats.available} available, ${stats.inUse} in use\n`);

  // Step 8: Best practices
  console.log('=== Best Practices ===');
  console.log('1. Always release objects after use (try/finally pattern)');
  console.log('2. Set maxSize based on expected concurrency');
  console.log('3. Preallocate objects for peak load');
  console.log('4. Monitor hit rate (should be >90% for optimal benefit)');
  console.log('5. Reset function should clear all state\n');

  // Step 9: Try/finally pattern example
  console.log('Example: Safe acquire/release with try/finally:');
  console.log(`
  const state = pool.acquire();
  try {
    // Use state
    state.modelId = 'model-1';
    state.status = 'active';
    // ... do work ...
  } finally {
    // Always release, even if error occurs
    pool.release(state);
  }
  `);

  console.log('Example complete.');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
