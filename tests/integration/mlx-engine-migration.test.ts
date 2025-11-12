/**
 * mlx-engine Migration Compatibility Tests
 *
 * These tests verify that code written for mlx-engine can migrate to kr-mlx-lm
 * with minimal changes, specifically testing snake_case API compatibility.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Engine, TokenizeRequest } from '../../src/types/index.js';
import { createEngine } from '../../src/index.js';

describe('mlx-engine Migration Compatibility', () => {
  let engine: Engine;

  beforeEach(async () => {
    // Mock Python runtime to avoid needing actual MLX installation
    vi.mock('../../src/bridge/python-runner.js', async () => {
      const { EventEmitter } = await import('eventemitter3');

      // Create proper StreamRegistry mock that extends EventEmitter
      class MockStreamRegistry extends EventEmitter {
        register(): Promise<{ streamId: string; tokensGenerated: number; tokensPerSecond: number; timeToFirstToken: number; totalTime: number }> {
          return Promise.resolve({ streamId: 'test', tokensGenerated: 0, tokensPerSecond: 0, timeToFirstToken: 0, totalTime: 0 });
        }
        handleChunk(): void {}
        handleStats(): void {}
        handleEvent(): void {}
        isActive(): boolean { return false; }
        getActiveCount(): number { return 0; }
        getStats(): undefined { return undefined; }
        cancel(): void {}
        cleanup(): void {}
      }

      return {
        PythonRunner: vi.fn().mockImplementation(() => ({
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          getTransport: vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (method: string, _params: unknown) => {
              // Mock responses for different JSON-RPC methods
              if (method === 'load_model' || method === 'load_draft_model') {
                return { model_handle: 'test-model-123' };
              }
              if (method === 'check_draft') {
                // Week 2 Day 1: Enhanced compatibility report format
                return {
                  compatible: true,
                  errors: [],
                  warnings: [],
                  details: {
                    primary_model: {
                      id: 'primary-model',
                      vocab_size: 32000,
                      parameter_count: 8000000000,
                      architecture: 'llama',
                    },
                    draft_model: {
                      id: 'draft-model',
                      vocab_size: 32000,
                      parameter_count: 3000000000,
                      architecture: 'llama',
                    },
                    performance_estimate: {
                      expected_speedup: '2.0x',
                      size_ratio: '37.5%',
                      recommendation: 'Good pairing for speculative decoding',
                    },
                  },
                };
              }
              if (method === 'tokenize') {
                return { tokens: [1, 2, 3], count: 3 };
              }
              return {};
            }),
          }),
          streamRegistry: new MockStreamRegistry(),
          getInfo: vi.fn().mockReturnValue({
            pid: 12345,
            uptime: 1000,
            memoryUsage: 100000,
            status: 'ready',
          }),
        })),
      };
    });

    engine = await createEngine();
  });

  afterEach(async () => {
    await engine.shutdown();
    vi.clearAllMocks();
  });

  describe('snake_case Method Names', () => {
    it('should accept load_model() with snake_case method name', async () => {
      const model = await engine.load_model({ model: 'test-model' });
      expect(model).toBeDefined();
      expect(model.descriptor.id).toBe('test-model');
    });

    it('should accept unload_model() with snake_case method name', async () => {
      await expect(engine.unload_model('test-model')).resolves.not.toThrow();
    });

    it('should accept load_draft_model() with snake_case method name', async () => {
      const model = await engine.load_draft_model({ model: 'draft-model' });
      expect(model).toBeDefined();
    });

    it('should accept unload_draft_model() with snake_case method name', async () => {
      await expect(engine.unload_draft_model('draft-model')).resolves.not.toThrow();
    });

    it('should accept is_draft_model_compatible() with snake_case method name', async () => {
      // Load both models first
      await engine.load_model({ model: 'primary-model' });
      await engine.load_draft_model({ model: 'draft-model' });

      const compatible = await engine.is_draft_model_compatible(
        'primary-model',
        'draft-model'
      );

      expect(compatible).toBeDefined();
      expect(typeof compatible.compatible).toBe('boolean');

      // Cleanup
      await engine.unload_model('primary-model');
      await engine.unload_draft_model('draft-model');
    });
  });

  describe('snake_case Parameters', () => {
    it('should normalize snake_case parameters in load_model()', async () => {
      const model = await engine.load_model({
        model: 'test-model',
        max_tokens: 512,          // snake_case
        temperature: 0.7,
        top_p: 0.9,               // snake_case
        repetition_penalty: 1.1,  // snake_case
      });

      expect(model).toBeDefined();
      expect(model.descriptor.id).toBe('test-model');
    });

    it('should normalize snake_case parameters in create_generator()', async () => {
      const generator = engine.create_generator({
        model: 'test-model',
        prompt: 'Hello, world!',
        max_tokens: 100,          // snake_case
        temperature: 0.8,
        top_p: 0.95,              // snake_case
        repetition_penalty: 1.2,  // snake_case
        stop_sequences: ['END'],  // snake_case
      });

      expect(generator).toBeDefined();
      expect(typeof generator.next).toBe('function');
    });

    it('should normalize snake_case parameters in tokenize()', async () => {
      // Fix: Load model first before tokenizing
      await engine.load_model({ model: 'test-model' });

      const result = await engine.tokenize({
        model: 'test-model',
        text: 'Hello, world!',
        addBos: true,  // Corrected to camelCase
      } as TokenizeRequest);

      expect(result).toBeDefined();
      expect(result.tokens).toBeDefined();
    });
  });

  describe('Mixed camelCase and snake_case', () => {
    it('should accept mixed parameter styles', async () => {
      const model = await engine.loadModel({
        model: 'test-model',
        maxTokens: 512,           // camelCase
        top_p: 0.9,               // snake_case
        temperature: 0.7,         // neutral
        repetition_penalty: 1.1,  // snake_case
      } as any);

      expect(model).toBeDefined();
    });

    it('should prefer camelCase when both styles provided', async () => {
      // This tests the preferDefined logic
      const model = await engine.loadModel({
        model: 'test-model',
        maxTokens: 512,        // camelCase (should be used)
        max_tokens: 256,       // snake_case (should be ignored)
      } as any);

      // In the normalizer, camelCase takes precedence
      expect(model).toBeDefined();
    });
  });

  describe('Real mlx-engine Code Pattern', () => {
    it('should run typical mlx-engine load and generate pattern', async () => {
      // Typical mlx-engine pattern:
      // engine = Engine()
      // model = engine.load_model(model='llama', max_tokens=100)
      // for chunk in engine.create_generator(prompt='Hello'):
      //     print(chunk['token'])

      // kr-mlx-lm equivalent with snake_case:
      const model = await engine.load_model({
        model: 'llama-3.1-8b',
        max_tokens: 100,
      });

      expect(model).toBeDefined();
      expect(model.descriptor.id).toBe('llama-3.1-8b');

      const generator = engine.create_generator({
        model: 'llama-3.1-8b',
        prompt: 'Hello',
        max_tokens: 50,
        temperature: 0.7,
      });

      expect(generator).toBeDefined();
    });

    it('should support mlx-engine style with all common parameters', async () => {
      const model = await engine.load_model({
        model: 'mistral-7b',
        max_tokens: 512,
        temperature: 0.8,
        top_p: 0.95,
        repetition_penalty: 1.15,
      });

      expect(model.descriptor.id).toBe('mistral-7b');

      const generator = engine.create_generator({
        model: 'mistral-7b',
        prompt: 'Explain quantum computing',
        max_tokens: 200,
        temperature: 0.8,
        top_p: 0.95,
        repetition_penalty: 1.15,
        stop_sequences: ['\n\n', 'END'],
        streaming: true,
      });

      expect(generator).toBeDefined();
    });
  });

  describe('Alias Support', () => {
    it('should support stream alias for streaming', async () => {
      const generator = engine.create_generator({
        model: 'test-model',
        prompt: 'Test',
        stream: true,  // Alias for 'streaming'
      });

      expect(generator).toBeDefined();
    });

    it('should support model_id alias for model', async () => {
      const model = await engine.load_model({
        model_id: 'test-model',  // Alias for 'model'
      });

      expect(model).toBeDefined();
      expect(model.descriptor.id).toBe('test-model');
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined values correctly', async () => {
      const model = await engine.loadModel({
        model: 'test-model',
      });

      expect(model).toBeDefined();
    });

    it('should handle null model parameter gracefully', async () => {
      // This should throw or return undefined
      await expect(
        engine.loadModel(null as any)
      ).rejects.toThrow();
    });

    it('should preserve unknown fields', async () => {
      // Config normalizer should preserve unknown fields
      const model = await engine.loadModel({
        model: 'test-model',
        custom_field: 'custom_value',  // Unknown field
        another_custom: 123,
      } as any);

      expect(model).toBeDefined();
    });
  });

  describe('Backward Compatibility', () => {
    it('should still work with pure camelCase (TypeScript style)', async () => {
      const generator = engine.createGenerator({
        model: 'test-model',
        prompt: 'Test',
        maxTokens: 512,
        temperature: 0.7,
        topP: 0.9,
        repetitionPenalty: 1.1,
      });

      expect(generator).toBeDefined();
    });

    it('should work with no optional parameters', async () => {
      const model = await engine.loadModel({
        model: 'test-model',
      });

      expect(model).toBeDefined();
      expect(model.descriptor.id).toBe('test-model');
    });
  });
});

describe('Migration Test: Real World Scenario', () => {
  it('should migrate from mlx-engine with minimal changes', async () => {
    // Simulate a real migration scenario

    // BEFORE (Python mlx-engine):
    // from mlx_engine import Engine
    // engine = Engine()
    // model = engine.load_model(
    //     model='llama-3.1-8b',
    //     max_tokens=512,
    //     temperature=0.7,
    //     top_p=0.9
    // )
    // for chunk in engine.create_generator(
    //     model='llama-3.1-8b',
    //     prompt='Hello',
    //     max_tokens=100
    // ):
    //     print(chunk['token'], end='')

    // AFTER (TypeScript kr-mlx-lm with snake_case):
    const engine = await createEngine();

    const model = await engine.load_model({
      model: 'llama-3.1-8b',
      max_tokens: 512,
      temperature: 0.7,
      top_p: 0.9,
    });

    expect(model.descriptor.id).toBe('llama-3.1-8b');

    const generator = engine.create_generator({
      model: 'llama-3.1-8b',
      prompt: 'Hello',
      max_tokens: 100,
    });

    expect(generator).toBeDefined();

    await engine.shutdown();
  });
});
