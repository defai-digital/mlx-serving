import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JsonRpcTransport } from '../../../src/bridge/jsonrpc-transport.js';
import type {
  LoadModelResponse,
  CheckDraftResponse,
} from '../../../src/bridge/serializers.js';

// Mock the config loader module before importing ModelManager
const mockGetConfig = vi.fn();
const mockGetCacheConfig = vi.fn();

vi.mock('../../../src/config/loader.js', () => ({
  getConfig: mockGetConfig,
  getCacheConfig: mockGetCacheConfig,
}));

// Import ModelManager AFTER mocking
const { ModelManager } = await import('../../../src/core/model-manager.js');

class MockTransport {
  public calls: Array<{ method: string; params: unknown }> = [];

  constructor(
    private readonly responders: Partial<
      Record<string, (params: unknown) => unknown | Promise<unknown>>
    >
  ) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const responder = this.responders[method];
    if (!responder) {
      throw new Error(`No responder registered for ${method}`);
    }
    return (await responder(params)) as T;
  }
}

// Mock logger that matches pino logger API
class MockLogger {
  public logs: Array<{ level: string; message: string; context?: unknown }> = [];

  debug(contextOrMessage: unknown, message?: string): void {
    if (typeof contextOrMessage === 'string') {
      // debug(message)
      this.logs.push({ level: 'debug', message: contextOrMessage });
    } else {
      // debug(context, message)
      this.logs.push({ level: 'debug', message: message || '', context: contextOrMessage });
    }
  }

  info(contextOrMessage: unknown, message?: string): void {
    if (typeof contextOrMessage === 'string') {
      // info(message) - single parameter
      this.logs.push({ level: 'info', message: contextOrMessage });
    } else {
      // info(context, message) - two parameters
      this.logs.push({ level: 'info', message: message || '', context: contextOrMessage });
    }
  }

  warn(contextOrMessage: unknown, message?: string): void {
    if (typeof contextOrMessage === 'string') {
      // warn(message) - single parameter
      this.logs.push({ level: 'warn', message: contextOrMessage });
    } else {
      // warn(context, message) - two parameters
      this.logs.push({ level: 'warn', message: message || '', context: contextOrMessage });
    }
  }

  error(contextOrMessage: unknown, message?: string): void {
    if (typeof contextOrMessage === 'string') {
      // error(message) - single parameter
      this.logs.push({ level: 'error', message: contextOrMessage });
    } else {
      // error(context, message) - two parameters
      this.logs.push({ level: 'error', message: message || '', context: contextOrMessage });
    }
  }
}

describe('ModelManager', () => {
  // Set default config for tests that don't need custom configuration
  beforeEach(() => {
    mockGetConfig.mockReturnValue({
      model: {
        default_context_length: 8192,
        max_loaded_models: 5,
        memory_cache: {
          enabled: false, // Disabled by default to avoid interfering with existing tests
          max_cached_models: 5,
          eviction_strategy: 'lru',
          warmup_on_start: [],
          track_stats: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    mockGetCacheConfig.mockReturnValue({
      enabled: true,
      cacheDir: '/tmp/test-cache',
      maxSizeBytes: 1024 * 1024 * 1024,
      maxAgeDays: 7,
      evictionPolicy: 'lru',
      preloadModels: [],
      validateOnStartup: false,
      enableCompression: false,
    });
  });

  it('loads and caches model handles', async () => {
    const transport = new MockTransport({
      load_model: (params) => ({
        model_id: (params as { model_id: string }).model_id,
        state: 'ready',
        context_length: 8192,
      } satisfies LoadModelResponse),
      unload_model: () => ({ success: true }),
    });

    const manager = new ModelManager({ transport: transport as unknown as JsonRpcTransport });

    const handle = await manager.loadModel({ model: 'alpha' });
    expect(handle.descriptor.id).toBe('alpha');
    expect(handle.draft).toBe(false);

    const cachedHandle = await manager.loadModel({ model: 'alpha' });
    expect(cachedHandle).toBe(handle);
    expect(transport.calls.filter((call) => call.method === 'load_model')).toHaveLength(1);

    await manager.unloadModel('alpha');
    expect(transport.calls.some((call) => call.method === 'unload_model')).toBe(true);
  });

  it('tracks draft models and compatibility', async () => {
    const transport = new MockTransport({
      load_model: (params) => ({
        model_id: (params as { model_id: string }).model_id,
        state: 'ready',
        context_length: 4096,
      } satisfies LoadModelResponse),
      check_draft: () =>
        ({
          compatible: true,
          errors: [],
          warnings: [],
          details: {
            primary_model: {
              id: 'primary',
              vocab_size: 50000,
              parameter_count: 7000000000,
              architecture: 'llama',
            },
            draft_model: {
              id: 'draft-alpha',
              vocab_size: 50000,
              parameter_count: 3000000000,
              architecture: 'llama',
            },
            performance_estimate: {
              expected_speedup: '1.20x',
              size_ratio: '42.9%',
              recommendation: 'Good pairing',
            },
          },
        } satisfies CheckDraftResponse),
      unload_model: () => ({ success: true }),
    });

    const manager = new ModelManager({ transport: transport as unknown as JsonRpcTransport });

    const draft = await manager.loadDraftModel({ model: 'draft-alpha' });
    expect(draft.draft).toBe(true);

    const report = await manager.isDraftCompatible('primary', 'draft-alpha');
    expect(report.compatible).toBe(true);
    expect(manager.getDraftFor('primary')).toBe('draft-alpha');

    await manager.unloadDraftModel();
    expect(manager.getDraftFor('primary')).toBeUndefined();
  });

  describe('warmupModels', () => {
    it('should warmup multiple models successfully', async () => {
      // Configure warmup models
      mockGetConfig.mockReturnValue({
        model: {
          default_context_length: 8192,
          max_loaded_models: 5,
          memory_cache: {
            enabled: true,
            max_cached_models: 5,
            eviction_strategy: 'lru',
            warmup_on_start: ['model-1', 'model-2'],
            track_stats: true,
          },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const transport = new MockTransport({
        load_model: (params) => ({
          model_id: (params as { model_id: string }).model_id,
          state: 'ready',
          context_length: 8192,
        } satisfies LoadModelResponse),
      });

      const logger = new MockLogger();
      const manager = new ModelManager({
        transport: transport as unknown as JsonRpcTransport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
      });

      await manager.initialize();
      await manager.warmupModels();

      // Verify both models were loaded
      expect(transport.calls.filter((call) => call.method === 'load_model')).toHaveLength(2);
      expect(
        transport.calls.some(
          (call) =>
            call.method === 'load_model' &&
            (call.params as { model_id: string }).model_id === 'model-1'
        )
      ).toBe(true);
      expect(
        transport.calls.some(
          (call) =>
            call.method === 'load_model' &&
            (call.params as { model_id: string }).model_id === 'model-2'
        )
      ).toBe(true);

      // Verify logging
      expect(logger.logs.some((log) => log.level === 'info' && log.message.includes('Warming up'))).toBe(
        true
      );
      expect(
        logger.logs.some((log) => log.level === 'info' && log.message.includes('Model warmed up'))
      ).toBe(true);
      expect(
        logger.logs.some((log) => log.level === 'info' && log.message.includes('warmup complete'))
      ).toBe(true);
    });

    it('should handle warmup failures gracefully', async () => {
      // Configure warmup models
      mockGetConfig.mockReturnValue({
        model: {
          default_context_length: 8192,
          max_loaded_models: 5,
          memory_cache: {
            enabled: true,
            max_cached_models: 5,
            eviction_strategy: 'lru',
            warmup_on_start: ['bad-model', 'good-model'],
            track_stats: true,
          },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      let callCount = 0;
      const transport = new MockTransport({
        load_model: (params) => {
          const modelId = (params as { model_id: string }).model_id;
          callCount++;

          // First model fails, second succeeds
          if (modelId === 'bad-model') {
            throw new Error('Model not found');
          }

          return {
            model_id: modelId,
            state: 'ready',
            context_length: 8192,
          } satisfies LoadModelResponse;
        },
      });

      const logger = new MockLogger();
      const manager = new ModelManager({
        transport: transport as unknown as JsonRpcTransport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
      });

      await manager.initialize();

      // Should not throw even though one model fails
      await expect(manager.warmupModels()).resolves.not.toThrow();

      // Verify both models were attempted
      expect(callCount).toBe(2);

      // Verify failure was logged
      expect(
        logger.logs.some(
          (log) =>
            log.level === 'warn' &&
            log.message.includes('Failed to warmup model') &&
            typeof log.context === 'object' &&
            log.context !== null &&
            'model' in log.context &&
            log.context.model === 'bad-model'
        )
      ).toBe(true);

      // Verify completion message shows mixed results
      const completionLog = logger.logs.find(
        (log) => log.level === 'info' && log.message.includes('warmup complete')
      );
      expect(completionLog).toBeDefined();
      expect(completionLog?.context).toMatchObject({
        successful: 1,
        failed: 1,
        total: 2,
      });
    });

    it('should skip warmup when cache is disabled', async () => {
      mockGetConfig.mockReturnValue({
        model: {
          default_context_length: 8192,
          max_loaded_models: 5,
          memory_cache: {
            enabled: false, // Cache disabled
            max_cached_models: 5,
            eviction_strategy: 'lru',
            warmup_on_start: ['model-1'],
            track_stats: true,
          },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const transport = new MockTransport({
        load_model: () => {
          throw new Error('Should not be called');
        },
      });

      const logger = new MockLogger();
      const manager = new ModelManager({
        transport: transport as unknown as JsonRpcTransport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
      });

      await manager.initialize();
      await manager.warmupModels();

      // Verify no models were loaded
      expect(transport.calls).toHaveLength(0);

      // Verify debug log about skipping
      expect(
        logger.logs.some(
          (log) => log.level === 'debug' && log.message.includes('Model warmup skipped')
        )
      ).toBe(true);
    });

    it('should skip warmup when no models configured', async () => {
      mockGetConfig.mockReturnValue({
        model: {
          default_context_length: 8192,
          max_loaded_models: 5,
          memory_cache: {
            enabled: true,
            max_cached_models: 5,
            eviction_strategy: 'lru',
            warmup_on_start: [], // No models configured
            track_stats: true,
          },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const transport = new MockTransport({
        load_model: () => {
          throw new Error('Should not be called');
        },
      });

      const logger = new MockLogger();
      const manager = new ModelManager({
        transport: transport as unknown as JsonRpcTransport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
      });

      await manager.initialize();
      await manager.warmupModels();

      // Verify no models were loaded
      expect(transport.calls).toHaveLength(0);

      // Verify debug log about skipping
      expect(
        logger.logs.some(
          (log) => log.level === 'debug' && log.message.includes('Model warmup skipped')
        )
      ).toBe(true);
    });

    it('should warmup all models in parallel', async () => {
      mockGetConfig.mockReturnValue({
        model: {
          default_context_length: 8192,
          max_loaded_models: 5,
          memory_cache: {
            enabled: true,
            max_cached_models: 5,
            eviction_strategy: 'lru',
            warmup_on_start: ['model-1', 'model-2', 'model-3'],
            track_stats: true,
          },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const loadTimestamps: number[] = [];
      const transport = new MockTransport({
        load_model: async (params) => {
          loadTimestamps.push(Date.now());
          // Simulate async load with small delay
          await new Promise((resolve) => setTimeout(resolve, 10));

          return {
            model_id: (params as { model_id: string }).model_id,
            state: 'ready',
            context_length: 8192,
          } satisfies LoadModelResponse;
        },
      });

      const logger = new MockLogger();
      const manager = new ModelManager({
        transport: transport as unknown as JsonRpcTransport,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger as any,
      });

      await manager.initialize();
      await manager.warmupModels();

      // Verify all 3 models were loaded
      expect(transport.calls.filter((call) => call.method === 'load_model')).toHaveLength(3);

      // Verify loads started in parallel (all within ~5ms of each other)
      const timestamps = loadTimestamps.sort();
      const timeSpread = timestamps[timestamps.length - 1] - timestamps[0];
      expect(timeSpread).toBeLessThan(5);
    });
  });
});
