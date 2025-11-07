import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '../../../src/api/engine.js';
import type { Engine } from '../../../src/types/index.js';
import { hasVisionSupport } from '../../helpers/vision-support.js';
import { getMlxSkipReason } from '../../helpers/model-availability.js';

describe('Vision Model Loading', () => {
  let engine: Engine;
  let skipTests = false;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const mlxSkipReason = getMlxSkipReason();
    if (mlxSkipReason) {
      skipTests = true;
      skipReason = mlxSkipReason;
      console.warn(`\n⚠️  Skipping vision tests: ${mlxSkipReason}`);
      return;
    }

    // Check if mlx-vlm is available first
    const visionAvailable = await hasVisionSupport();
    if (!visionAvailable) {
      skipTests = true;
      skipReason = 'mlx-vlm not available';
      console.warn('\n⚠️  Skipping vision tests: mlx-vlm library is not installed');
      console.warn('   Install with: pip install mlx-vlm>=0.2.1\n');
      return; // Skip engine creation entirely
    }

    engine = await createEngine();
  }, 120000); // 2 min timeout for setup (includes hasVisionSupport check)

  afterAll(async () => {
    if (engine) {
      await engine.dispose();
    }
  });

  it('should load LLaVA model', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const visionModel = await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
    });

    expect(visionModel).toBeDefined();
    expect(visionModel.descriptor.id).toBe('llava-hf/llava-1.5-7b-hf');
    expect(visionModel.descriptor.modality).toBe('vision');
    expect(visionModel.descriptor.family).toBe('mlx-vlm');
    expect(visionModel.state).toBe('ready');
  }, 120000); // 2 min timeout

  it('should load vision model with quantization', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const visionModel = await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
      quantization: { bits: 4 },
    });

    expect(visionModel.metadata.quantization).toBeDefined();
  }, 120000);

  it('should unload vision model', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const visionModel = await engine.loadVisionModel({
      model: 'llava-hf/llava-1.5-7b-hf',
    });

    await engine.unloadModel(visionModel.descriptor.id);

    // Verify unloaded (attempting to generate should fail)
    await expect(async () => {
      for await (const _ of engine.createVisionGenerator({
        model: visionModel.descriptor.id,
        prompt: 'Test',
        image: { source: Buffer.from('test') },
      })) {
        // Should throw
      }
    }).rejects.toThrow();
  }, 120000);

  it('should use snake_case alias', async () => {
    if (skipTests) {
      // eslint-disable-next-line no-console
      console.log(`Skipped: ${skipReason ?? 'MLX runtime unavailable'}`);
      return;
    }

    const visionModel = await engine.load_vision_model({
      model: 'llava-hf/llava-1.5-7b-hf',
    });

    expect(visionModel).toBeDefined();
    expect(visionModel.descriptor.modality).toBe('vision');
  }, 120000);
});
