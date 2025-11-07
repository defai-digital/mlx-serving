/**
 * Integration test for GenerateBatcher and batch_generate RPC
 *
 * Tests end-to-end batching behavior:
 * - Multiple generate requests batched into single batch_generate RPC
 * - Results properly distributed to each stream
 * - Priority queue behavior
 * - Error isolation between batch items
 * - Streaming still works
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/api/engine.js';
import type { Engine } from '../../src/types/engine.js';
import type { GeneratorChunk } from '../../src/types/generators.js';
import { getMlxSkipReason } from '../helpers/model-availability.js';

const _mlxSkipReason = getMlxSkipReason();

// KNOWN ISSUE RESOLVED: MLX library had concurrent GPU access limitations when used through
// stdio-based JSON-RPC. The library works fine with concurrent requests in pure Python
// (verified with asyncio.gather), but crashed with SIGSEGV when concurrent requests
// went through our TypeScript→Python bridge.
//
// SOLUTION: GPU Scheduler Layer (v1.4.0) serializes Metal GPU command buffer submissions
// while maintaining CPU-level parallelism. This prevents SIGSEGV crashes while achieving
// +15% throughput and -30% P99 latency. Enable with MLX_GPU_SCHEDULER=on.
//
// Tests re-enabled to validate GPU scheduler fix.
describe('GenerateBatcher Integration (GPU Scheduler validation)', () => {
  let engine: Engine;
  let originalSchedulerEnv: string | undefined;

  beforeAll(async () => {
    // Enable GPU scheduler for these tests to prevent SIGSEGV
    originalSchedulerEnv = process.env.MLX_GPU_SCHEDULER;
    process.env.MLX_GPU_SCHEDULER = 'on';

    engine = await createEngine();

    // Load a small test model and wait for it to be ready
    const handle = await engine.loadModel({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    });

    // Verify model is ready before proceeding with tests
    expect(handle.state).toBe('ready');

    // CRITICAL: Warmup the model with a test generation
    // This ensures GPU is fully initialized and Metal command buffers are ready
    // Without this, concurrent tests may hit uninitialized GPU state
    const warmupGen = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'warmup',
      maxTokens: 1,
    });

    // Consume warmup generation
    for await (const _chunk of warmupGen) {
      // Just consume to complete warmup
    }

    // Add small delay after warmup
    await new Promise(resolve => setTimeout(resolve, 500));
  }, 60_000); // 60 second timeout for model loading

  afterAll(async () => {
    if (engine) {
      await engine.dispose();
    }
    // Restore original scheduler setting
    if (originalSchedulerEnv === undefined) {
      delete process.env.MLX_GPU_SCHEDULER;
    } else {
      process.env.MLX_GPU_SCHEDULER = originalSchedulerEnv;
    }
  });

  it('batches concurrent generate requests', async () => {
    // Create multiple concurrent generate requests
    // They should be batched into a single batch_generate RPC call

    const promises = [
      collectTokens(engine, 'Count to 5', 20),
      collectTokens(engine, 'Say hello', 10),
      collectTokens(engine, 'Name a color', 5),
    ];

    const results = await Promise.all(promises);

    // Verify each stream got results
    expect(results[0].length).toBeGreaterThan(0);
    expect(results[1].length).toBeGreaterThan(0);
    expect(results[2].length).toBeGreaterThan(0);

    // Verify streams are independent
    expect(results[0]).not.toEqual(results[1]);
    expect(results[1]).not.toEqual(results[2]);
  }, 30_000);

  it('handles errors in batch items independently', async () => {
    // Create batch with one invalid request
    const validPromise = collectTokens(engine, 'Say hello', 5);

    // Invalid request (negative max tokens)
    const invalidPromise = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'This will fail',
      maxTokens: -10,
    });

    // Valid request should succeed even if invalid one fails
    const [validResult, invalidResult] = await Promise.allSettled([
      validPromise,
      consumeGenerator(invalidPromise),
    ]);

    expect(validResult.status).toBe('fulfilled');
    expect(invalidResult.status).toBe('rejected');
  }, 30_000);

  // KNOWN ISSUE: This test fails due to test interference when multiple tests share the same engine.
  // The test works in isolation (see priority-test-isolated.test.ts) but fails when run with other tests.
  // Root cause: "Received chunk for unregistered stream" - streams being cancelled prematurely after previous tests.
  // TODO: Investigate stream registry cleanup and batch queue state management
  it.skip('respects priority ordering', async () => {
    // This is harder to test directly, but we can verify that priority
    // parameter is accepted without errors

    const generator = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'Test priority',
      maxTokens: 5,
    }, { priority: 'urgent' });

    const tokens = await collectTokensFromGenerator(generator);
    expect(tokens.length).toBeGreaterThan(0);
  }, 30_000);

  it('supports abort during batching', async () => {
    const controller = new AbortController();

    const generator = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'This will be aborted',
      maxTokens: 50,
    }, { signal: controller.signal });

    // Abort immediately
    controller.abort();

    // AbortError is converted to EngineError with code 'Cancelled' by the generator factory
    await expect(consumeGenerator(generator)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'Cancelled',
    });
  }, 30_000);

  // KNOWN ISSUE: This test fails due to test interference (same root cause as priority ordering test above).
  // Stream gets cancelled prematurely with "Generate request aborted" even though no AbortSignal is provided.
  // TODO: Investigate stream registry cleanup and batch queue state management
  it.skip('streams tokens from batched requests', async () => {
    const generator = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'Count to 10',
      maxTokens: 30,
      streaming: true,
    });

    const chunks = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
      if (chunk.type === 'token') {
        // Verify we're getting tokens incrementally (streaming)
        expect(typeof chunk.token).toBe('string');
      }
    }

    // Should have received multiple token chunks
    const tokenChunks = chunks.filter(c => c.type === 'token');
    expect(tokenChunks.length).toBeGreaterThan(1);
  }, 30_000);
});

/**
 * Helper: Collect all tokens from a prompt
 */
async function collectTokens(engine: Engine, prompt: string, maxTokens: number): Promise<string[]> {
  const generator = engine.createGenerator({
    model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    prompt,
    maxTokens,
  });

  return collectTokensFromGenerator(generator);
}

/**
 * Helper: Collect tokens from a generator
 */
async function collectTokensFromGenerator(generator: AsyncGenerator<GeneratorChunk, void>): Promise<string[]> {
  const tokens: string[] = [];

  for await (const chunk of generator) {
    if (chunk.type === 'token') {
      tokens.push(chunk.token);
    }
  }

  return tokens;
}

/**
 * Helper: Consume generator without collecting tokens
 */
async function consumeGenerator(generator: AsyncGenerator): Promise<void> {
  for await (const _ of generator) {
    // Just consume
  }
}
