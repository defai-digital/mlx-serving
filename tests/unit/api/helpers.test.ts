import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Engine, GeneratorChunk, ModelHandle } from '@/types/index.js';
import {
  generateText,
  generateTextStreaming,
  ensureModelLoaded,
  batchTokenize,
  collectChunks,
  waitForModelReady,
  isEngineHealthy,
  getTotalTokenCount,
  retryLoadModel,
} from '@/api/helpers.js';

describe('API Helpers', () => {
  let mockEngine: Engine;

  beforeEach(() => {
    mockEngine = {
      loadModel: vi.fn(),
      loadDraftModel: vi.fn(),
      unloadModel: vi.fn(),
      unloadDraftModel: vi.fn(),
      isDraftModelCompatible: vi.fn(),
      tokenize: vi.fn(),
      listModels: vi.fn(),
      getModelInfo: vi.fn(),
      getRuntimeInfo: vi.fn(),
      healthCheck: vi.fn(),
      shutdown: vi.fn(),
      dispose: vi.fn(),
      createGenerator: vi.fn(),
    } as unknown as Engine;
  });

  describe('generateText', () => {
    it('should collect all tokens into a single string', async () => {
      const chunks: GeneratorChunk[] = [
        { type: 'token', token: 'Hello' },
        { type: 'token', token: ' ' },
        { type: 'token', token: 'World' },
        { type: 'metadata', stats: { tokensGenerated: 3, tokensPerSecond: 10, timeToFirstToken: 0.1, totalTime: 0.3 } },
      ];

      mockEngine.createGenerator = vi.fn().mockReturnValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const result = await generateText(mockEngine, {
        model: 'test-model',
        prompt: 'test',
      });

      expect(result).toBe('Hello World');
    });

    it('should throw on error chunk', async () => {
      const chunks: GeneratorChunk[] = [
        { type: 'token', token: 'Hello' },
        { type: 'error', error: { code: 'GenerationError', message: 'Test error' } },
      ];

      mockEngine.createGenerator = vi.fn().mockReturnValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      await expect(
        generateText(mockEngine, { model: 'test-model', prompt: 'test' })
      ).rejects.toThrow('Test error');
    });
  });

  describe('generateTextStreaming', () => {
    it('should invoke callback for each token', async () => {
      const chunks: GeneratorChunk[] = [
        { type: 'token', token: 'Hello' },
        { type: 'token', token: ' ' },
        { type: 'token', token: 'World' },
      ];

      mockEngine.createGenerator = vi.fn().mockReturnValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const tokens: string[] = [];
      const result = await generateTextStreaming(
        mockEngine,
        { model: 'test-model', prompt: 'test' },
        (token) => tokens.push(token)
      );

      expect(result).toBe('Hello World');
      expect(tokens).toEqual(['Hello', ' ', 'World']);
    });
  });

  describe('ensureModelLoaded', () => {
    it('should return existing model if already loaded', async () => {
      const existingHandle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'ready',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.getModelInfo = vi.fn().mockReturnValue(existingHandle);

      const result = await ensureModelLoaded(mockEngine, { model: 'test-model' });

      expect(result).toBe(existingHandle);
      expect(mockEngine.loadModel).not.toHaveBeenCalled();
    });

    it('should load model if not already loaded', async () => {
      const newHandle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'ready',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.getModelInfo = vi.fn().mockReturnValue(undefined);
      mockEngine.loadModel = vi.fn().mockResolvedValue(newHandle);

      const result = await ensureModelLoaded(mockEngine, { model: 'test-model' });

      expect(result).toBe(newHandle);
      expect(mockEngine.loadModel).toHaveBeenCalledWith({ model: 'test-model' });
    });
  });

  describe('batchTokenize', () => {
    it('should tokenize multiple texts', async () => {
      mockEngine.tokenize = vi
        .fn()
        .mockResolvedValueOnce({ tokens: [1, 2, 3] })
        .mockResolvedValueOnce({ tokens: [4, 5] })
        .mockResolvedValueOnce({ tokens: [6] });

      const result = await batchTokenize(mockEngine, 'test-model', [
        'First text',
        'Second text',
        'Third text',
      ]);

      expect(result).toEqual([[1, 2, 3], [4, 5], [6]]);
      expect(mockEngine.tokenize).toHaveBeenCalledTimes(3);
    });
  });

  describe('collectChunks', () => {
    it('should collect all chunks into an array', async () => {
      const chunks: GeneratorChunk[] = [
        { type: 'token', token: 'Hello' },
        { type: 'token', token: 'World' },
        { type: 'metadata', stats: { tokensGenerated: 2, tokensPerSecond: 10, timeToFirstToken: 0.1, totalTime: 0.2 } },
      ];

      mockEngine.createGenerator = vi.fn().mockReturnValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const result = await collectChunks(mockEngine, {
        model: 'test-model',
        prompt: 'test',
      });

      expect(result).toEqual(chunks);
    });
  });

  describe('waitForModelReady', () => {
    it('should return handle when model is ready', async () => {
      const handle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'ready',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.getModelInfo = vi.fn().mockReturnValue(handle);

      const result = await waitForModelReady(mockEngine, 'test-model', 1000, 50);

      expect(result).toBe(handle);
    });

    it('should throw on timeout', async () => {
      const handle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'loading',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.getModelInfo = vi.fn().mockReturnValue(handle);

      await expect(
        waitForModelReady(mockEngine, 'test-model', 100, 50)
      ).rejects.toThrow('Timeout waiting for model test-model to be ready');
    });

    it('should throw if model fails', async () => {
      const handle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'failed',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.getModelInfo = vi.fn().mockReturnValue(handle);

      await expect(
        waitForModelReady(mockEngine, 'test-model', 1000, 50)
      ).rejects.toThrow('Model test-model failed to load');
    });
  });

  describe('isEngineHealthy', () => {
    it('should return true when engine is healthy', async () => {
      mockEngine.healthCheck = vi.fn().mockResolvedValue({
        status: 'healthy',
        uptime: 1000,
        activeStreams: 0,
        loadedModels: 1,
      });

      const result = await isEngineHealthy(mockEngine);

      expect(result).toBe(true);
    });

    it('should return false when engine is unhealthy', async () => {
      mockEngine.healthCheck = vi.fn().mockResolvedValue({
        status: 'unhealthy',
        uptime: 1000,
        activeStreams: 0,
        loadedModels: 0,
      });

      const result = await isEngineHealthy(mockEngine);

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockEngine.healthCheck = vi.fn().mockRejectedValue(new Error('Test error'));

      const result = await isEngineHealthy(mockEngine);

      expect(result).toBe(false);
    });
  });

  describe('getTotalTokenCount', () => {
    it('should sum token counts across multiple texts', async () => {
      mockEngine.tokenize = vi
        .fn()
        .mockResolvedValueOnce({ tokens: [1, 2, 3] })
        .mockResolvedValueOnce({ tokens: [4, 5] });

      const result = await getTotalTokenCount(mockEngine, 'test-model', [
        'First text',
        'Second text',
      ]);

      expect(result).toBe(5);
    });
  });

  describe('retryLoadModel', () => {
    it('should succeed on first attempt', async () => {
      const handle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'ready',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.loadModel = vi.fn().mockResolvedValue(handle);

      const result = await retryLoadModel(mockEngine, { model: 'test-model' }, 3, 100);

      expect(result).toBe(handle);
      expect(mockEngine.loadModel).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const handle: ModelHandle = {
        descriptor: { id: 'test-model', source: 'local', modality: 'text', family: 'mlx-lm' },
        state: 'ready',
        contextLength: 2048,
        metadata: {},
      };

      mockEngine.loadModel = vi
        .fn()
        .mockRejectedValueOnce(new Error('First attempt failed'))
        .mockRejectedValueOnce(new Error('Second attempt failed'))
        .mockResolvedValue(handle);

      const result = await retryLoadModel(mockEngine, { model: 'test-model' }, 3, 10);

      expect(result).toBe(handle);
      expect(mockEngine.loadModel).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      mockEngine.loadModel = vi.fn().mockRejectedValue(new Error('Load failed'));

      await expect(
        retryLoadModel(mockEngine, { model: 'test-model' }, 2, 10)
      ).rejects.toThrow('Load failed');

      expect(mockEngine.loadModel).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });
});
