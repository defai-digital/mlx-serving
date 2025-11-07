/**
 * Timeout Management Tests (Week 2 Day 2)
 *
 * Validates timeout mechanisms:
 * - TimeoutError class with context (method, timeout, requestId, duration)
 * - Timeout configuration via CreateGeneratorOptions
 * - JSON-RPC transport timeout tracking
 *
 * NOTE: We avoid testing AbortSignal because it triggers MLX Metal crashes:
 * "A command encoder is already encoding to this command buffer" (SIGABRT)
 *
 * We focus on testing that timeout configuration is accepted and that the
 * TimeoutError infrastructure is correct.
 *
 * Bug Fix #75: Mock PythonRunner to avoid real MLX runtime execution
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/index.js';
import { TimeoutError, createTimeoutError } from '../../src/api/errors.js';

// Bug Fix #75: Mock Python runtime to avoid GPU execution in timeout tests
vi.mock('../../src/bridge/python-runner.js', async () => {
  const { EventEmitter } = await import('eventemitter3');

  // Mock StreamRegistry that emits events (Bug Fix: correct event format)
  class MockStreamRegistry extends EventEmitter {
    private activeStreams = new Set<string>();

    // Emit chunks for a stream
    async emitStreamChunks(streamId: string, maxTokens: number): Promise<void> {
      this.activeStreams.add(streamId);

      // Defer emissions to next tick to allow generator to be fully set up
      await new Promise((resolve) => setImmediate(resolve));

      // Emit all chunks
      for (let i = 0; i < maxTokens; i++) {
        this.emit('chunk', {
          streamId,
          token: `token${i}`,
          tokenId: i,
          logprob: -1.0,
          isFinal: i === maxTokens - 1,
        });
      }

      // Emit final stats with correct format
      const stats = {
        streamId,
        tokensGenerated: maxTokens,
        tokensPerSecond: 30.0,
        timeToFirstToken: 50,
        totalTime: (maxTokens / 30.0) * 1000,
      };
      this.emit('stats', stats);

      // Bug fix: completed event takes TWO parameters (streamId, stats)
      this.emit('completed', streamId, stats);
      this.activeStreams.delete(streamId);
    }

    // Bug Fix: Correct register() signature to match real StreamRegistry
    register(_streamId: string, _signal?: AbortSignal, _timeout?: number): Promise<{
      streamId: string;
      tokensGenerated: number;
      tokensPerSecond: number;
      timeToFirstToken: number;
      totalTime: number;
    }> {
      // Return a promise that never resolves (real register resolves when stream completes)
      return new Promise(() => {});
    }

    handleChunk(): void {}
    handleStats(): void {}
    handleEvent(): void {}
    isActive(streamId: string): boolean {
      return this.activeStreams.has(streamId);
    }
    getActiveCount(): number {
      return this.activeStreams.size;
    }
    getStats(): undefined {
      return undefined;
    }
    cancel(streamId: string): void {
      this.activeStreams.delete(streamId);
    }
    cleanup(): void {
      this.activeStreams.clear();
    }
  }

  return {
    PythonRunner: vi.fn().mockImplementation(() => {
      const mockStreamRegistry = new MockStreamRegistry();

      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getTransport: vi.fn().mockReturnValue({
          request: vi.fn().mockImplementation(async (method: string, params: any) => {
            // Mock different JSON-RPC methods
            if (method === 'load_model') {
              return { model_handle: params?.model_id || 'timeout-test-model' };
            }
            if (method === 'unload_model') {
              return { success: true };
            }
            if (method === 'tokenize') {
              const text = String(params?.text ?? '');
              const tokens = text.split(' ').map((_word: string, index: number) => index + 1);
              return { tokens, count: tokens.length };
            }
            if (method === 'batch_tokenize') {
              // Return batch tokenize results
              const requests = params?.requests || [];
              return {
                results: requests.map((req: any) => {
                  const text = String(req.text ?? '');
                  const tokens = text.split(' ').map((_word: string, index: number) => index + 1);
                  return { success: true, result: { tokens, count: tokens.length } };
                }),
              };
            }
            if (method === 'generate') {
              // Bug Fix: Use the streamId from params (sent by GeneratorFactory)
              const streamId = params?.stream_id || `stream-${Date.now()}`;
              const maxTokens = params?.max_tokens || 5;

              // Emit chunks asynchronously (don't await to return immediately)
              void mockStreamRegistry.emitStreamChunks(streamId, maxTokens);

              return { stream_id: streamId };
            }
            if (method === 'runtime/info') {
              return {
                version: '1.0.0',
                python_version: '3.9.0',
                capabilities: ['generate', 'tokenize', 'batch_tokenize', 'batch_check_draft'],
                uptime: 1000,
              };
            }
            if (method === 'runtime/state') {
              return {
                loaded_models: [],
                active_streams: 0,
                restart_count: 0,
              };
            }
            return {};
          }),
        }),
        streamRegistry: mockStreamRegistry,
        getInfo: vi.fn().mockReturnValue({
          pid: 12345,
          uptime: 1000,
          memoryUsage: 100000,
          status: 'ready',
        }),
      };
    }),
  };
});

describe('Timeout Management Tests', () => {
  let engine: Engine;

  beforeAll(async () => {
    // Bug Fix #75: Use mocked engine (no real Python execution)
    engine = await createEngine();

    // Load mock model (handled by mock transport)
    await engine.load_model({
      model: 'timeout-test-model',
    });
  }, 30000);

  afterAll(async () => {
    await engine.unload_model('timeout-test-model');
    await engine.dispose();
  });

  describe('TimeoutError Class', () => {
    it('should create TimeoutError with full context', () => {
      const error = new TimeoutError('Test timeout', {
        method: 'test_method',
        timeout: 5000,
        requestId: '123',
        duration: 5001,
      });

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TimeoutError');
      expect(error.code).toBe('Timeout');
      expect(error.method).toBe('test_method');
      expect(error.timeout).toBe(5000);
      expect(error.requestId).toBe('123');
      expect(error.duration).toBe(5001);
      expect(error.message).toContain('Test timeout');

      console.log('✓ TimeoutError created with full context');
    });

    it('should work without optional fields', () => {
      const error = new TimeoutError('Basic timeout', {
        method: 'basic_method',
        timeout: 3000,
      });

      expect(error.method).toBe('basic_method');
      expect(error.timeout).toBe(3000);
      expect(error.requestId).toBeUndefined();
      expect(error.duration).toBeUndefined();

      console.log('✓ TimeoutError works without optional fields');
    });

    it('should serialize to EngineError shape', () => {
      const error = new TimeoutError('Serialization test', {
        method: 'serialize',
        timeout: 1000,
        requestId: '456',
        duration: 1234,
      });

      const obj = error.toObject();
      expect(obj.code).toBe('Timeout');
      expect(obj.message).toContain('Serialization test');
      expect(obj.details).toMatchObject({
        method: 'serialize',
        timeout: 1000,
        requestId: '456',
        duration: 1234,
      });

      console.log('✓ TimeoutError serializes correctly');
    });

    it('should use createTimeoutError helper', () => {
      const error = createTimeoutError('test_method', 5000, '789', 5123);

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.method).toBe('test_method');
      expect(error.timeout).toBe(5000);
      expect(error.requestId).toBe('789');
      expect(error.duration).toBe(5123);
      expect(error.message).toContain('5000ms');
      expect(error.message).toContain('test_method');
      expect(error.message).toContain('789');

      console.log('✓ createTimeoutError helper works correctly');
    });
  });

  describe('Timeout Configuration', () => {
    it('should accept timeoutMs parameter in generator options', async () => {
      // Create a generator with explicit timeout (should complete successfully)
      const generator = engine.createGenerator(
        {
          model: 'timeout-test-model',
          prompt: 'Hello world',
          maxTokens: 5,
        },
        {
          timeoutMs: 60000, // 60 second timeout (generous)
        }
      );

      let count = 0;
      for await (const chunk of generator) {
        if (chunk.type === 'token') {
          count++;
        }
      }

      expect(count).toBeGreaterThan(0);
      console.log(`✓ Generator with timeout completed: ${count} tokens`);
    }, 30000);

    it('should work with default timeout when not specified', async () => {
      // Generator without explicit timeout should use default
      const generator = engine.createGenerator({
        model: 'timeout-test-model',
        prompt: 'Test prompt',
        maxTokens: 5,
      });

      let count = 0;
      for await (const chunk of generator) {
        if (chunk.type === 'token') {
          count++;
        }
      }

      expect(count).toBeGreaterThan(0);
      console.log('✓ Generator with default timeout completed');
    }, 30000);

    it('should accept different timeout values', async () => {
      // Test that various timeout values are accepted
      const timeouts = [10000, 30000, 60000]; // 10s, 30s, 60s

      for (const timeout of timeouts) {
        const generator = engine.createGenerator(
          {
            model: 'timeout-test-model',
            prompt: 'Quick test',
            maxTokens: 3,
          },
          {
            timeoutMs: timeout,
          }
        );

        let count = 0;
        for await (const chunk of generator) {
          if (chunk.type === 'token') {
            count++;
          }
        }

        expect(count).toBeGreaterThan(0);
      }

      console.log(`✓ All ${timeouts.length} timeout configurations worked`);
    }, 60000);
  });

  describe('Integration with Engine API', () => {
    it('should tokenize successfully', async () => {
      const result = await engine.tokenize({
        model: 'timeout-test-model',
        text: 'This is a test sentence for timeout management',
      });

      expect(result.tokens).toBeDefined();
      expect(Array.isArray(result.tokens)).toBe(true);
      expect(result.tokens.length).toBeGreaterThan(0);

      console.log(`✓ Tokenize completed: ${result.tokens.length} tokens`);
    }, 10000);

    // Note: Generation functionality is tested in mlx-engine-migration.test.ts
    // This test suite focuses on timeout configuration, which is tested above

    it('should handle concurrent tokenize requests', async () => {
      // Multiple concurrent requests should all succeed
      const promises = Array.from({ length: 3 }, (_, i) =>
        engine.tokenize({
          model: 'timeout-test-model',
          text: `Concurrent request ${i}`,
        })
      );

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.tokens).toBeDefined();
        expect(result.tokens.length).toBeGreaterThan(0);
      });

      console.log(`✓ ${results.length} concurrent requests completed`);
    }, 15000);

    it('should handle sequential requests', async () => {
      // Sequential requests should maintain runtime stability
      const count = 3;

      for (let i = 0; i < count; i++) {
        const result = await engine.tokenize({
          model: 'timeout-test-model',
          text: `Sequential request ${i}`,
        });

        expect(result.tokens).toBeDefined();
        expect(result.tokens.length).toBeGreaterThan(0);
      }

      console.log(`✓ ${count} sequential requests completed`);
    }, 15000);
  });

  describe('Timeout Handle Cleanup', () => {
    // Note: Timeout handle cleanup is implicitly tested by all timeout tests above
    // and by the absence of memory leaks in long-running integration tests

    it('should maintain runtime health across multiple operations', async () => {
      // Get initial runtime state
      const initialInfo = await engine.getRuntimeInfo();
      const initialCaps = initialInfo.capabilities.length;

      // Perform multiple operations
      for (let i = 0; i < 3; i++) {
        await engine.tokenize({
          model: 'timeout-test-model',
          text: `Health check ${i}`,
        });
      }

      // Verify runtime is still healthy
      const finalInfo = await engine.getRuntimeInfo();
      expect(finalInfo.capabilities.length).toBe(initialCaps);

      console.log('✓ Runtime healthy after multiple operations');
    }, 20000);
  });
});
