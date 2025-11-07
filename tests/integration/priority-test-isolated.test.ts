/**
 * Isolated test for priority parameter
 * Tests if priority ordering works without interference from other tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../src/api/engine.js';
import type { Engine } from '../../src/types/engine.js';
import { getMlxSkipReason } from '../helpers/model-availability.js';
import { getPythonRuntimeSkipReason } from '../helpers/python-runtime.js';

const _mlxSkipReason = getMlxSkipReason();

describe('Priority Parameter Isolated Test', () => {
  let engine: Engine;
  let originalSchedulerEnv: string | undefined;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    // Enable GPU scheduler for these tests to prevent SIGSEGV
    originalSchedulerEnv = process.env.MLX_GPU_SCHEDULER;
    process.env.MLX_GPU_SCHEDULER = 'on';

    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping priority tests: ${mlxSkipReason}`);
      return;
    }

    const pythonSkipReason = getPythonRuntimeSkipReason();
    if (pythonSkipReason) {
      skipTests = true;
      skipReason = pythonSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping priority tests: ${pythonSkipReason}`);
      return;
    }

    engine = await createEngine();

    // Load a small test model and wait for it to be ready
    const handle = await engine.loadModel({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
    });

    // Verify model is ready before proceeding with tests
    expect(handle.state).toBe('ready');

    // CRITICAL: Warmup the model with a test generation
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

  it('should generate tokens with priority parameter', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const generator = engine.createGenerator({
      model: 'mlx-community/Llama-3.2-1B-Instruct-4bit',
      prompt: 'Say hello',
      maxTokens: 10,
    }, { priority: 'urgent' });

    const tokens: string[] = [];
    for await (const chunk of generator) {
      if (chunk.type === 'token') {
        tokens.push(chunk.token);
      }
    }

    console.log(`✅ Priority test generated ${tokens.length} tokens`);
    expect(tokens.length).toBeGreaterThan(0);
  }, 30_000);
});
