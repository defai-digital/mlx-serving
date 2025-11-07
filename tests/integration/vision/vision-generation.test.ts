import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../../src/api/engine.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../../../src/types/index.js';
import { hasVisionSupport } from '../../helpers/vision-support.js';
import { getMlxSkipReason } from '../../helpers/model-availability.js';
import { tagEngineTop20 } from '../../helpers/tags.js';

describe('Vision Generation', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;
  const testImagePath = join(__dirname, '../../fixtures/test-image.jpg');

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  Skipping vision generation tests: ${mlxSkipReason}`);
      return;
    }

    // Check if mlx-vlm is available first
    const visionAvailable = await hasVisionSupport();
    if (!visionAvailable) {
      skipTests = true;
      skipReason = 'mlx-vlm not available';
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Skipping vision generation tests: mlx-vlm library is not installed');
      // eslint-disable-next-line no-console
      console.warn('   Install with: pip install mlx-vlm>=0.2.1\n');
      return; // Skip engine creation entirely
    }

    engine = await createEngine();

    await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
    });
  }, 180000); // 3 min timeout for model loading

  afterAll(async () => {
    if (engine) {
      await engine.dispose();
    }
  });

  it(tagEngineTop20('should generate from image file path'), async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const chunks: string[] = [];

    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'What is in this image?',
      image: { source: testImagePath },
      maxTokens: 50,
    })) {
      if (chunk.type === 'token') {
        chunks.push(chunk.token || '');
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.join('');
    expect(text.length).toBeGreaterThan(10);
  }, 180000); // 3 min timeout

  it('should generate from Buffer', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const imageBuffer = readFileSync(testImagePath);
    const chunks: string[] = [];

    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'Describe this image.',
      image: { source: imageBuffer, format: 'jpg' },
      maxTokens: 30,
    })) {
      if (chunk.type === 'token') {
        chunks.push(chunk.token || '');
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
  }, 180000);

  it('should provide generation stats', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    let statsReceived = false;

    for await (const chunk of engine.createVisionGenerator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'What do you see?',
      image: { source: testImagePath },
      maxTokens: 20,
    })) {
      if (chunk.type === 'metadata' && chunk.stats) {
        statsReceived = true;
        expect(chunk.stats.tokensGenerated).toBeGreaterThan(0);
        expect(chunk.stats.tokensPerSecond).toBeGreaterThan(0);
      }
    }

    expect(statsReceived).toBe(true);
  }, 180000);

  it(tagEngineTop20('should use snake_case alias'), async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const chunks: string[] = [];

    for await (const chunk of engine.create_vision_generator({
      model: 'llava-hf/llava-1.5-7b-hf',
      prompt: 'Test',
      image: { source: testImagePath },
      maxTokens: 10,
    })) {
      if (chunk.type === 'token') {
        chunks.push(chunk.token || '');
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
  }, 180000);
});
