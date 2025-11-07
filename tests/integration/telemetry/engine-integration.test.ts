import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Engine } from '../../../src/api/engine.js';
import { createTelemetryBridge } from '../../../src/telemetry/bridge.js';
import type { TelemetryConfig } from '../../../src/telemetry/otel.js';
import type { TelemetryHooks } from '../../../src/types/engine.js';
import { pino } from 'pino';

// Mock PythonRunner to avoid starting real Python process
vi.mock('../../../src/bridge/python-runner.js', () => {
  return {
    PythonRunner: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getTransport: vi.fn().mockReturnValue({
        request: vi.fn().mockResolvedValue({
          model_id: 'test-model',
          state: 'ready',
          context_length: 2048,
        }),
      }),
      streamRegistry: {
        on: vi.fn(),
        off: vi.fn(),
        register: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
        cleanup: vi.fn(),
        getActiveCount: vi.fn().mockReturnValue(0),
      },
      getInfo: vi.fn().mockReturnValue({
        pid: 12345,
        status: 'ready',
        uptime: 1000,
      }),
    })),
  };
});

describe('Engine Telemetry Integration', () => {
  const logger = pino({ level: 'silent' });

  describe('with telemetry enabled', () => {
    let engine: Engine;
    let _telemetryHooks: TelemetryHooks;
    let onModelLoadedSpy: any;
    let onTokenGeneratedSpy: any;
    let onGenerationCompletedSpy: any;
    let onErrorSpy: any;

    beforeEach(async () => {
      // Create telemetry bridge
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-engine-integration',
        prometheusPort: 9475,
        logger,
      };

      const { hooks, manager } = await createTelemetryBridge(config, logger);
      _telemetryHooks = hooks;

      // Create spies for hooks
      onModelLoadedSpy = vi.fn(hooks.onModelLoaded ?? (() => {}));
      onTokenGeneratedSpy = vi.fn(hooks.onTokenGenerated ?? (() => {}));
      onGenerationCompletedSpy = vi.fn(hooks.onGenerationCompleted ?? (() => {}));
      onErrorSpy = vi.fn(hooks.onError ?? (() => {}));

      // Create engine with telemetry hooks
      engine = new Engine(
        {
          telemetry: {
            enabled: true,
            hooks: {
              onModelLoaded: onModelLoadedSpy,
              onTokenGenerated: onTokenGeneratedSpy,
              onGenerationCompleted: onGenerationCompletedSpy,
              onError: onErrorSpy,
            },
          },
        },
        {
          logger,
        }
      );

      // Save manager for cleanup
      (engine as any)._telemetryManager = manager;
    });

    afterEach(async () => {
      await engine.shutdown();
      const manager = (engine as any)._telemetryManager;
      if (manager?.isStarted?.()) {
        await manager.shutdown();
      }
    });

    it('should call onModelLoaded hook when loading a model', async () => {
      // Mock the transport to return a valid model response
      const mockTransport = (engine as any).runner.getTransport();
      mockTransport.request.mockResolvedValueOnce({
        model_id: 'test-model',
        state: 'ready',
        context_length: 2048,
        vocab_size: 32000,
        revision: 'main',
        quantization: null,
        dtype: 'float16',
      });

      // Also mock runtime/info for BatchQueue capability detection
      mockTransport.request.mockResolvedValueOnce({
        capabilities: ['batch_tokenize', 'batch_check_draft'],
      });

      await engine.loadModel({ model: 'test-model' });

      expect(onModelLoadedSpy).toHaveBeenCalledTimes(1);
      expect(onModelLoadedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          descriptor: expect.objectContaining({
            id: 'test-model',
          }),
          state: 'ready',
        })
      );
    });

    it('should call onError hook when model load fails', async () => {
      // Mock the transport to reject before the loadModel call
      const mockTransport = (engine as any).runner.getTransport();

      // Clear previous mocks and set up rejection
      mockTransport.request.mockReset();
      mockTransport.request.mockRejectedValue(new Error('Model not found'));

      try {
        await engine.loadModel({ model: 'invalid-model' });
        expect.fail('Should have thrown an error');
      } catch (error) {
        // Error should have been caught
        expect(error).toBeDefined();
      }

      expect(onErrorSpy).toHaveBeenCalled();
      expect(onErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Model not found'),
        })
      );
    });
  });

  describe('with telemetry disabled', () => {
    let engine: Engine;

    beforeEach(() => {
      engine = new Engine(
        {
          telemetry: {
            enabled: false,
          },
        },
        {
          logger,
        }
      );
    });

    afterEach(async () => {
      await engine.shutdown();
    });

    it('should not have telemetry hooks when disabled', () => {
      // Internal telemetry property should be undefined
      expect((engine as any).telemetry).toBeUndefined();
    });

    it('should work normally without telemetry', async () => {
      // Mock the transport
      const mockTransport = (engine as any).runner.getTransport();
      mockTransport.request.mockResolvedValueOnce({
        model_id: 'test-model',
        state: 'ready',
        context_length: 2048,
        vocab_size: 32000,
        revision: 'main',
        quantization: null,
        dtype: 'float16',
      });

      // Also mock runtime/info
      mockTransport.request.mockResolvedValueOnce({
        capabilities: [],
      });

      const model = await engine.loadModel({ model: 'test-model' });
      expect(model.descriptor.id).toBe('test-model');
    });
  });

  describe('hook error handling', () => {
    let engine: Engine;
    let failingHookCalled: boolean;

    beforeEach(() => {
      failingHookCalled = false;

      // Create a hook that throws an error but wraps it in try-catch (simulating bridge.ts behavior)
      const safeFailingHook = vi.fn((_model) => {
        try {
          failingHookCalled = true;
          throw new Error('Telemetry hook error');
        } catch (err) {
          // Silently catch error, like bridge.ts does
        }
      });

      engine = new Engine(
        {
          telemetry: {
            enabled: true,
            hooks: {
              onModelLoaded: safeFailingHook,
            },
          },
        },
        {
          logger,
        }
      );
    });

    afterEach(async () => {
      await engine.shutdown();
    });

    it('should not crash engine when hook throws error', async () => {
      // Mock the transport
      const mockTransport = (engine as any).runner.getTransport();
      // Don't use mockReset() as it clears the implementation
      // Just add new resolved values to the queue
      mockTransport.request
        .mockResolvedValueOnce({
          model_id: 'test-model',
          state: 'ready',
          context_length: 2048,
          vocab_size: 32000,
          revision: 'main',
          quantization: null,
          dtype: 'float16',
        })
        .mockResolvedValueOnce({
          capabilities: [],
        });

      // Engine should continue working even if hook fails
      // The hook silently catches errors (like bridge.ts implementation)
      const model = await engine.loadModel({ model: 'test-model' });
      expect(model.descriptor.id).toBe('test-model');
      expect(failingHookCalled).toBe(true); // Verify hook was actually called
    });
  });
});
