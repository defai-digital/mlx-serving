import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PythonRunner, RuntimeInfo as PythonRuntimeInfo } from '../../../src/bridge/python-runner.js';
import type { JsonRpcTransport } from '../../../src/bridge/jsonrpc-transport.js';
import type { ModelManager } from '../../../src/core/model-manager.js';
import { RuntimeLifecycleService } from '../../../src/services/runtime-lifecycle.js';
import { EngineClientError } from '../../../src/api/errors.js';

interface RunnerOverrides {
  transport?: JsonRpcTransport | null;
  info?: PythonRuntimeInfo;
  activeStreams?: number;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createRunner(overrides: RunnerOverrides = {}): PythonRunner {
  const defaultInfo: PythonRuntimeInfo = overrides.info ?? {
    pid: 42,
    uptime: 1000,
    memoryUsage: 0,
    status: 'ready',
  };

  const transport = overrides.transport ?? null;
  const activeStreams = overrides.activeStreams ?? 0;

  const runner = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getTransport: vi.fn().mockReturnValue(transport),
    getInfo: vi.fn().mockReturnValue(defaultInfo),
    streamRegistry: {
      getActiveCount: vi.fn().mockReturnValue(activeStreams),
      cleanup: vi.fn(),
    },
  };

  return runner as unknown as PythonRunner;
}

function createService(runnerOverrides: RunnerOverrides = {}): {
  service: RuntimeLifecycleService;
  runner: PythonRunner & Record<string, any>;
  emit: any;
  logger: any;
} {
  const runner = createRunner(runnerOverrides);
  const emit = vi.fn();
  const logger = createMockLogger();
  const service = new RuntimeLifecycleService({
    logger,
    emit,
    runner,
    options: {},
  });

  return { service, runner: runner as unknown as PythonRunner & Record<string, any>, emit, logger };
}

describe('RuntimeLifecycleService', () => {
  it('starts the Python runner only once even with multiple ensureStarted calls', async () => {
    const { service, runner } = createService();

    await service.ensureStarted();
    await service.ensureStarted();

    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('stops the Python runner on shutdown after start', async () => {
    const { service, runner } = createService();

    await service.ensureStarted();
    await service.shutdown();

    expect(runner.stop).toHaveBeenCalledTimes(1);
  });

  it('fetches runtime info through the active transport', async () => {
    const transport = {
      request: vi.fn().mockResolvedValue({
        version: '1.0.0',
        mlx_version: '3.3.0',
        protocol: 'jsonrpc',
        capabilities: ['batch_tokenize'],
      }),
    } as unknown as JsonRpcTransport;

    const { service } = createService({ transport });

    const info = await service.getRuntimeInfo();

    expect(transport.request).toHaveBeenCalledWith('runtime/info');
    expect(info.version).toBe('1.0.0');
  });

  it('surfaces circuit breaker errors in health checks when open', async () => {
    const transport = {
      request: vi.fn().mockResolvedValue({
        loaded_models: [{ model_id: 'model-1', state: 'ready', type: 'llm' }],
      }),
    } as unknown as JsonRpcTransport;

    const { service } = createService({ transport });

    // Trip the breaker by recording enough failures
    service.recordCircuitBreakerFailure();
    service.recordCircuitBreakerFailure();
    service.recordCircuitBreakerFailure();

    const modelManager = {
      listModels: () => [{ descriptor: { id: 'model-1' } }],
    } as unknown as ModelManager;

    const health = await service.healthCheck(modelManager);

    expect(health.status).toBe('degraded');
    expect(health.stateErrors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Circuit breaker is open/)])
    );
  });

  it('throws a transport error when requesting active transport without runner connection', () => {
    const { service } = createService({ transport: null });

    expect(() => service.getActiveTransport()).toThrow(EngineClientError);
  });
});
