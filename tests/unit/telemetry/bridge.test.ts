import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelemetryBridge, getMetrics } from '../../../src/telemetry/bridge.js';
import type { TelemetryConfig } from '../../../src/telemetry/otel.js';
import type { ModelHandle } from '../../../src/types/models.js';
import type { GenerationStats, EngineError } from '../../../src/types/generators.js';
import { pino } from 'pino';

describe('Telemetry Bridge', () => {
  const logger = pino({ level: 'silent' });

  describe('createTelemetryBridge', () => {
    it('should create hooks and manager when enabled', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-bridge',
        prometheusPort: 9469,
        logger,
      };

      const { hooks, manager } = await createTelemetryBridge(config, logger);

      expect(hooks).toBeDefined();
      expect(manager).toBeDefined();
      expect(manager.isStarted()).toBe(true);

      // Hooks should have all expected callbacks
      expect(hooks.onModelLoaded).toBeDefined();
      expect(hooks.onTokenGenerated).toBeDefined();
      expect(hooks.onGenerationCompleted).toBeDefined();
      expect(hooks.onError).toBeDefined();

      await manager.shutdown();
    });

    it('should create no-op hooks when disabled', async () => {
      const config: TelemetryConfig = {
        enabled: false,
        serviceName: 'test-bridge',
        prometheusPort: 9470,
        logger,
      };

      const { hooks, manager } = await createTelemetryBridge(config, logger);

      expect(hooks).toEqual({}); // Empty object for disabled telemetry
      expect(manager).toBeDefined();
      expect(manager.isStarted()).toBe(false);
    });
  });

  describe('TelemetryHooks integration', () => {
    let manager: Awaited<ReturnType<typeof createTelemetryBridge>>['manager'];
    let hooks: Awaited<ReturnType<typeof createTelemetryBridge>>['hooks'];

    beforeEach(async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-hooks',
        prometheusPort: 9471,
        logger,
      };

      const result = await createTelemetryBridge(config, logger);
      manager = result.manager;
      hooks = result.hooks;
    });

    afterEach(async () => {
      if (manager.isStarted()) {
        await manager.shutdown();
      }
    });

    describe('onModelLoaded', () => {
      it('should record model loaded metric', () => {
        const mockModel: ModelHandle = {
          descriptor: {
            id: 'llama-3-8b',
            source: 'huggingface',
            path: 'meta-llama/Llama-3-8B',
            modality: 'text',
            family: 'mlx-lm',
          },
          state: 'ready',
          contextLength: 8192,
          metadata: {},
        };

        const addSpy = vi.spyOn(manager.metrics.modelsLoaded, 'add');

        hooks.onModelLoaded?.(mockModel);

        expect(addSpy).toHaveBeenCalledWith(1, {
          model: 'llama-3-8b',
          type: 'text',
        });
      });

      it('should not throw on error', () => {
        const mockModel: ModelHandle = {
          descriptor: {
            id: 'test-model',
            source: 'local',
            path: '/test/path',
            modality: 'text',
            family: 'mlx-lm',
          },
          state: 'ready',
          contextLength: 2048,
          metadata: {},
        };

        // Temporarily break the metric to test error handling
        const originalAdd = manager.metrics.modelsLoaded.add;
        manager.metrics.modelsLoaded.add = (() => {
          throw new Error('Test error');
        }) as typeof originalAdd;

        expect(() => hooks.onModelLoaded?.(mockModel)).not.toThrow();

        // Restore original
        manager.metrics.modelsLoaded.add = originalAdd;
      });
    });

    describe('onTokenGenerated', () => {
      it('should record token generated metric', () => {
        const stats: GenerationStats = {
          modelId: 'llama-3-8b',
          tokensGenerated: 1,
          tokensPerSecond: 45.2,
          timeToFirstToken: 0.05,
          totalTime: 0.1,
        };

        const addSpy = vi.spyOn(manager.metrics.tokensGenerated, 'add');

        hooks.onTokenGenerated?.('hello', stats);

        expect(addSpy).toHaveBeenCalledWith(1, {
          model: 'llama-3-8b',
        });
      });

      it('should handle unknown model ID', () => {
        const stats: GenerationStats = {
          tokensGenerated: 1,
          tokensPerSecond: 45.2,
          timeToFirstToken: 0.05,
          totalTime: 0.1,
        };

        const addSpy = vi.spyOn(manager.metrics.tokensGenerated, 'add');

        hooks.onTokenGenerated?.('world', stats);

        expect(addSpy).toHaveBeenCalledWith(1, {
          model: 'unknown',
        });
      });

      it('should not throw on error', () => {
        const stats: GenerationStats = {
          modelId: 'test-model',
          tokensGenerated: 1,
          tokensPerSecond: 50,
          timeToFirstToken: 0.03,
          totalTime: 0.08,
        };

        const originalAdd = manager.metrics.tokensGenerated.add;
        manager.metrics.tokensGenerated.add = (() => {
          throw new Error('Test error');
        }) as typeof originalAdd;

        expect(() => hooks.onTokenGenerated?.('test', stats)).not.toThrow();

        manager.metrics.tokensGenerated.add = originalAdd;
      });
    });

    describe('onGenerationCompleted', () => {
      it('should record generation duration and token count', () => {
        const stats: GenerationStats = {
          modelId: 'llama-3-8b',
          tokensGenerated: 150,
          tokensPerSecond: 42.5,
          timeToFirstToken: 0.08,
          totalTime: 3.53, // seconds
        };

        const durationSpy = vi.spyOn(manager.metrics.generationDuration, 'record');
        const tokensSpy = vi.spyOn(manager.metrics.tokensGenerated, 'add');

        hooks.onGenerationCompleted?.(stats);

        // Duration should be in milliseconds
        expect(durationSpy).toHaveBeenCalledWith(3530, {
          model: 'llama-3-8b',
        });

        expect(tokensSpy).toHaveBeenCalledWith(150, {
          model: 'llama-3-8b',
        });
      });

      it('should handle missing totalTime', () => {
        const stats: GenerationStats = {
          modelId: 'llama-3-8b',
          tokensGenerated: 50,
          tokensPerSecond: 40,
          timeToFirstToken: 0.05,
        };

        const durationSpy = vi.spyOn(manager.metrics.generationDuration, 'record');
        const tokensSpy = vi.spyOn(manager.metrics.tokensGenerated, 'add');

        hooks.onGenerationCompleted?.(stats);

        // Duration should not be recorded when totalTime is undefined
        expect(durationSpy).not.toHaveBeenCalled();

        // But tokens should still be recorded
        expect(tokensSpy).toHaveBeenCalledWith(50, {
          model: 'llama-3-8b',
        });
      });

      it('should not record zero tokens', () => {
        const stats: GenerationStats = {
          modelId: 'llama-3-8b',
          tokensGenerated: 0,
          tokensPerSecond: 0,
          timeToFirstToken: 0.05,
          totalTime: 0.1,
        };

        const tokensSpy = vi.spyOn(manager.metrics.tokensGenerated, 'add');

        hooks.onGenerationCompleted?.(stats);

        expect(tokensSpy).not.toHaveBeenCalled();
      });

      it('should not throw on error', () => {
        const stats: GenerationStats = {
          modelId: 'test-model',
          tokensGenerated: 100,
          tokensPerSecond: 50,
          timeToFirstToken: 0.05,
          totalTime: 2.0,
        };

        const originalRecord = manager.metrics.generationDuration.record;
        manager.metrics.generationDuration.record = (() => {
          throw new Error('Test error');
        }) as typeof originalRecord;

        expect(() => hooks.onGenerationCompleted?.(stats)).not.toThrow();

        manager.metrics.generationDuration.record = originalRecord;
      });
    });

    describe('onError', () => {
      it('should record error metric with code', () => {
        const error: EngineError = {
          code: 'ModelLoadError',
          message: 'Failed to load model',
        };

        const errorsSpy = vi.spyOn(manager.metrics.errorsTotal, 'add');

        hooks.onError?.(error);

        expect(errorsSpy).toHaveBeenCalledWith(1, {
          code: 'ModelLoadError',
          type: 'Error',
        });
      });

      it('should record generation errors separately', () => {
        const error: EngineError = {
          code: 'GENERATION_ERROR',
          message: 'Token generation failed',
        };

        const errorsSpy = vi.spyOn(manager.metrics.errorsTotal, 'add');
        const genErrorsSpy = vi.spyOn(manager.metrics.generationErrors, 'add');

        hooks.onError?.(error);

        expect(errorsSpy).toHaveBeenCalledWith(1, {
          code: 'GENERATION_ERROR',
          type: 'Error',
        });

        expect(genErrorsSpy).toHaveBeenCalledWith(1, {
          model: 'unknown',
        });
      });

      it('should handle unknown error code', () => {
        const error: EngineError = {
          message: 'Unknown error',
        };

        const errorsSpy = vi.spyOn(manager.metrics.errorsTotal, 'add');

        hooks.onError?.(error);

        expect(errorsSpy).toHaveBeenCalledWith(1, {
          code: 'UNKNOWN',
          type: 'Error',
        });
      });

      it('should not throw on error', () => {
        const error: EngineError = {
          code: 'TestError',
          message: 'Test error message',
        };

        const originalAdd = manager.metrics.errorsTotal.add;
        manager.metrics.errorsTotal.add = (() => {
          throw new Error('Nested error');
        }) as typeof originalAdd;

        expect(() => hooks.onError?.(error)).not.toThrow();

        manager.metrics.errorsTotal.add = originalAdd;
      });
    });
  });

  describe('getMetrics', () => {
    it('should return metrics when manager is started', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-get-metrics',
        prometheusPort: 9472,
        logger,
      };

      const { manager } = await createTelemetryBridge(config, logger);

      const metrics = getMetrics(manager);

      expect(metrics).toBeDefined();
      expect(metrics?.modelsLoaded).toBeDefined();

      await manager.shutdown();
    });

    it('should return undefined when manager is not started', async () => {
      const config: TelemetryConfig = {
        enabled: false,
        serviceName: 'test-get-metrics',
        prometheusPort: 9473,
        logger,
      };

      const { manager } = await createTelemetryBridge(config, logger);

      const metrics = getMetrics(manager);

      expect(metrics).toBeUndefined();
    });

    it('should return undefined on error', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-get-metrics',
        prometheusPort: 9474,
        logger,
      };

      const { manager } = await createTelemetryBridge(config, logger);

      // Shut down manager to trigger error in getMetrics
      await manager.shutdown();

      const metrics = getMetrics(manager);

      expect(metrics).toBeUndefined();
    });
  });
});
