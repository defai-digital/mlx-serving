import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelemetryManager } from '../../../src/telemetry/otel.js';
import type { TelemetryConfig } from '../../../src/telemetry/otel.js';
import { pino } from 'pino';

describe('TelemetryManager', () => {
  let telemetry: TelemetryManager;
  const logger = pino({ level: 'silent' });

  describe('when disabled', () => {
    beforeEach(() => {
      const config: TelemetryConfig = {
        enabled: false,
        serviceName: 'test-service',
        prometheusPort: 9999,
        logger,
      };
      telemetry = new TelemetryManager(config);
    });

    it('should not allow start() when disabled', async () => {
      await expect(telemetry.start()).rejects.toThrow('Telemetry is disabled');
    });

    it('should return false for isStarted()', () => {
      expect(telemetry.isStarted()).toBe(false);
    });

    it('should throw when accessing metrics before start', () => {
      expect(() => telemetry.metrics).toThrow('TelemetryManager not started');
    });
  });

  describe('when enabled', () => {
    beforeEach(async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-service',
        prometheusPort: 9465, // Use different port to avoid conflicts
        logger,
      };
      telemetry = new TelemetryManager(config);
    });

    afterEach(async () => {
      if (telemetry.isStarted()) {
        await telemetry.shutdown();
      }
    });

    it('should start successfully', async () => {
      await telemetry.start();
      expect(telemetry.isStarted()).toBe(true);
    });

    it('should expose all standard metrics after start', async () => {
      await telemetry.start();

      const metrics = telemetry.metrics;

      // Model lifecycle
      expect(metrics.modelsLoaded).toBeDefined();
      expect(metrics.modelsUnloaded).toBeDefined();
      expect(metrics.modelLoadDuration).toBeDefined();

      // Token generation
      expect(metrics.tokensGenerated).toBeDefined();
      expect(metrics.generationDuration).toBeDefined();
      expect(metrics.generationErrors).toBeDefined();

      // IPC operations
      expect(metrics.ipcRequestsTotal).toBeDefined();
      expect(metrics.ipcRequestDuration).toBeDefined();
      expect(metrics.ipcRequestsInFlight).toBeDefined();

      // Batch operations
      expect(metrics.batchOperationsTotal).toBeDefined();
      expect(metrics.batchSizeHistogram).toBeDefined();
      expect(metrics.batchEfficiency).toBeDefined();

      // Error tracking
      expect(metrics.errorsTotal).toBeDefined();
      expect(metrics.retryAttemptsTotal).toBeDefined();
      expect(metrics.circuitBreakerStateChanges).toBeDefined();
    });

    it('should allow recording metrics after start', async () => {
      await telemetry.start();

      const metrics = telemetry.metrics;

      // These should not throw
      expect(() => {
        metrics.modelsLoaded.add(1, { model: 'test-model', type: 'text' });
        metrics.tokensGenerated.add(100, { model: 'test-model' });
        metrics.generationDuration.record(1234, { model: 'test-model' });
        metrics.ipcRequestsTotal.add(1, { method: 'generate' });
        metrics.errorsTotal.add(1, { code: 'TestError', type: 'Error' });
      }).not.toThrow();
    });

    it('should warn when starting twice', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      await telemetry.start();
      await telemetry.start();

      expect(warnSpy).toHaveBeenCalledWith('TelemetryManager already started');
    });

    it('should shutdown cleanly', async () => {
      await telemetry.start();
      expect(telemetry.isStarted()).toBe(true);

      await telemetry.shutdown();
      expect(telemetry.isStarted()).toBe(false);
    });

    it('should not throw on shutdown when not started', async () => {
      await expect(telemetry.shutdown()).resolves.not.toThrow();
    });

    it('should throw when accessing metrics after shutdown', async () => {
      await telemetry.start();
      await telemetry.shutdown();

      expect(() => telemetry.metrics).toThrow('TelemetryManager not started');
    });
  });

  describe('configuration', () => {
    it('should use default serviceName if not provided', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        prometheusPort: 9466,
        logger,
      };
      telemetry = new TelemetryManager(config);

      await telemetry.start();
      expect(telemetry.isStarted()).toBe(true);

      await telemetry.shutdown();
    });

    it('should use default prometheusPort if not provided', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-service',
        logger,
      };
      telemetry = new TelemetryManager(config);

      await telemetry.start();
      expect(telemetry.isStarted()).toBe(true);

      await telemetry.shutdown();
    });

    it('should use default exportIntervalMs if not provided', async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-service',
        prometheusPort: 9467,
        logger,
      };
      telemetry = new TelemetryManager(config);

      await telemetry.start();
      expect(telemetry.isStarted()).toBe(true);

      await telemetry.shutdown();
    });
  });

  describe('metrics recording', () => {
    beforeEach(async () => {
      const config: TelemetryConfig = {
        enabled: true,
        serviceName: 'test-service',
        prometheusPort: 9468,
        logger,
      };
      telemetry = new TelemetryManager(config);
      await telemetry.start();
    });

    afterEach(async () => {
      await telemetry.shutdown();
    });

    it('should record model lifecycle metrics', () => {
      const metrics = telemetry.metrics;

      expect(() => {
        metrics.modelsLoaded.add(1, { model: 'llama-3-8b', type: 'text' });
        metrics.modelsUnloaded.add(1, { model: 'llama-3-8b', type: 'text' });
        metrics.modelLoadDuration.record(5432, { model: 'llama-3-8b' });
      }).not.toThrow();
    });

    it('should record token generation metrics', () => {
      const metrics = telemetry.metrics;

      expect(() => {
        metrics.tokensGenerated.add(150, { model: 'llama-3-8b' });
        metrics.generationDuration.record(2345, { model: 'llama-3-8b' });
        metrics.generationErrors.add(1, { model: 'llama-3-8b' });
      }).not.toThrow();
    });

    it('should record IPC metrics', () => {
      const metrics = telemetry.metrics;

      expect(() => {
        metrics.ipcRequestsTotal.add(1, { method: 'load_model' });
        metrics.ipcRequestDuration.record(123, { method: 'load_model' });
        metrics.ipcRequestsInFlight.add(1, { method: 'generate' });
        metrics.ipcRequestsInFlight.add(-1, { method: 'generate' });
      }).not.toThrow();
    });

    it('should record batch operation metrics', () => {
      const metrics = telemetry.metrics;

      expect(() => {
        metrics.batchOperationsTotal.add(1, { operation: 'tokenize' });
        metrics.batchSizeHistogram.record(5, { operation: 'tokenize' });
        metrics.batchEfficiency.record(0.85, { operation: 'tokenize' });
      }).not.toThrow();
    });

    it('should record error tracking metrics', () => {
      const metrics = telemetry.metrics;

      expect(() => {
        metrics.errorsTotal.add(1, { code: 'ModelLoadError', type: 'EngineError' });
        metrics.retryAttemptsTotal.add(1, { operation: 'load_model' });
        metrics.circuitBreakerStateChanges.add(1, { from: 'closed', to: 'open' });
      }).not.toThrow();
    });
  });
});
