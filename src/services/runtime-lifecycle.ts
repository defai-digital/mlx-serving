import type { Logger } from 'pino';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';
import { PythonRunner, type RuntimeInfo as PythonRuntimeInfo } from '../bridge/python-runner.js';
import type { EngineOptions, RuntimeInfo, HealthStatus } from '../types/index.js';
import type { EngineEvents } from '../api/events.js';
import type { ModelManager } from '../core/model-manager.js';
import { EngineClientError, createTransportError, toEngineError } from '../api/errors.js';

type EmitFunction = <E extends keyof EngineEvents>(
  event: E,
  payload: Parameters<EngineEvents[E]>[0]
) => void;

export interface RuntimeLifecycleServiceConfig {
  options?: EngineOptions;
  logger: Logger;
  runner?: PythonRunner;
  emit: EmitFunction;
}

export interface CircuitBreakerSnapshot {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
}

/**
 * Service responsible for managing the Python runtime lifecycle and
 * circuit breaker state. Encapsulates runner start/stop, runtime info,
 * health checks, and circuit breaker bookkeeping.
 */
export class RuntimeLifecycleService {
  private readonly logger: Logger;
  private readonly emit: EmitFunction;
  private readonly runner: PythonRunner;

  private started = false;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  private circuitBreakerState: CircuitBreakerSnapshot['state'] = 'closed';
  private circuitBreakerFailures = 0;
  private circuitBreakerLastFailure = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 30000;

  constructor(config: RuntimeLifecycleServiceConfig) {
    this.logger = config.logger;
    this.emit = config.emit;
    this.runner =
      config.runner ??
      new PythonRunner({
        pythonPath: config.options?.pythonPath,
        runtimePath: config.options?.runtimePath,
        logger: this.logger,
      });
  }

  public getRunner(): PythonRunner {
    return this.runner;
  }

  public getTransport(): JsonRpcTransport | null {
    return this.runner.getTransport();
  }

  public getActiveTransport(): JsonRpcTransport {
    const transport = this.runner.getTransport();
    if (!transport) {
      throw createTransportError('Python runtime transport unavailable');
    }
    return transport;
  }

  public getCircuitBreakerSnapshot(): CircuitBreakerSnapshot {
    return {
      state: this.circuitBreakerState,
      failures: this.circuitBreakerFailures,
      lastFailure: this.circuitBreakerLastFailure,
    };
  }

  public resetCircuitBreaker(): void {
    if (this.circuitBreakerState !== 'closed' || this.circuitBreakerFailures > 0) {
      this.logger?.info(
        {
          previousState: this.circuitBreakerState,
          previousFailures: this.circuitBreakerFailures,
        },
        'Circuit breaker reset to closed state after successful operation'
      );
    }
    this.circuitBreakerState = 'closed';
    this.circuitBreakerFailures = 0;
    this.circuitBreakerLastFailure = 0;
  }

  public recordCircuitBreakerFailure(): void {
    this.circuitBreakerFailures += 1;
    this.circuitBreakerLastFailure = Date.now();

    if (this.circuitBreakerState === 'half-open') {
      this.logger?.error(
        {
          failures: this.circuitBreakerFailures,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD,
        },
        'Circuit breaker reopened due to failure during half-open state'
      );
      this.circuitBreakerState = 'open';
      this.emit('error', {
        error: {
          code: 'RuntimeError',
          message: 'Circuit breaker reopened after failed recovery attempt',
          details: {
            failures: this.circuitBreakerFailures,
            threshold: this.CIRCUIT_BREAKER_THRESHOLD,
            previousState: 'half-open',
          },
        },
        context: 'circuit_breaker',
        timestamp: Date.now(),
      });
      return;
    }

    if (this.circuitBreakerFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      if (this.circuitBreakerState !== 'open') {
        this.logger?.error(
          {
            failures: this.circuitBreakerFailures,
            threshold: this.CIRCUIT_BREAKER_THRESHOLD,
          },
          'Circuit breaker opened due to repeated failures'
        );
        this.circuitBreakerState = 'open';
        this.emit('error', {
          error: {
            code: 'RuntimeError',
            message: 'Circuit breaker opened due to repeated state reconciliation failures',
            details: {
              failures: this.circuitBreakerFailures,
              threshold: this.CIRCUIT_BREAKER_THRESHOLD,
            },
          },
          context: 'circuit_breaker',
          timestamp: Date.now(),
        });
      }
    } else {
      this.logger?.warn(
        {
          failures: this.circuitBreakerFailures,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD,
        },
        'Circuit breaker failure recorded'
      );
    }
  }

  public canAttemptOperation(): boolean {
    if (this.circuitBreakerState === 'closed') {
      return true;
    }

    if (this.circuitBreakerState === 'open') {
      const timeSinceLastFailure = Date.now() - this.circuitBreakerLastFailure;
      if (timeSinceLastFailure >= this.CIRCUIT_BREAKER_TIMEOUT) {
        this.logger?.info(
          { timeSinceLastFailure, timeout: this.CIRCUIT_BREAKER_TIMEOUT },
          'Circuit breaker transitioning to half-open state'
        );
        this.circuitBreakerState = 'half-open';
        return true;
      }

      this.logger?.warn(
        {
          timeSinceLastFailure,
          timeout: this.CIRCUIT_BREAKER_TIMEOUT,
          remainingTime: this.CIRCUIT_BREAKER_TIMEOUT - timeSinceLastFailure,
        },
        'Circuit breaker is open - operation blocked'
      );
      return false;
    }

    return true;
  }

  public async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.shuttingDown) {
      throw new EngineClientError('RuntimeError', 'Engine shutdown in progress');
    }

    if (!this.startPromise) {
      this.startPromise = this.runner
        .start()
        .then(() => {
          this.started = true;
        })
        .catch((error) => {
          this.startPromise = null;
          throw toEngineError(error, 'RuntimeError');
        });
    }

    try {
      await this.startPromise;
    } catch (error) {
      throw toEngineError(error, 'RuntimeError');
    }
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      try {
        if (this.started) {
          await this.runner.stop();
        }
      } catch (error) {
        throw toEngineError(error, 'RuntimeError');
      } finally {
        this.started = false;
        this.startPromise = null;
        this.shuttingDown = false;
        this.shutdownPromise = null;
      }
    })();

    return this.shutdownPromise;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async getRuntimeInfo(): Promise<RuntimeInfo> {
    await this.ensureStarted();
    const transport = this.getActiveTransport();
    try {
      const response = await transport.request<{
        version: string;
        mlx_version: string;
        protocol: string;
        capabilities: string[];
        mlx_supported?: boolean;
        memory?: { rss: number; vms: number };
      }>('runtime/info');

      return {
        version: response.version,
        mlxVersion: response.mlx_version,
        protocol: response.protocol,
        capabilities: response.capabilities,
        mlxSupported: response.mlx_supported,
        memory: response.memory,
      };
    } catch (error) {
      throw toEngineError(error, 'RuntimeError');
    }
  }

  public async healthCheck(modelManager?: ModelManager | null): Promise<HealthStatus> {
    try {
      const info = this.runner.getInfo();
      const activeStreams = this.runner.streamRegistry.getActiveCount();
      const modelHandles = modelManager?.listModels() ?? [];
      const loadedModels = modelHandles.length;

      const runtimeStatusMap: Record<PythonRuntimeInfo['status'], 'running' | 'stopped' | 'crashed'> = {
        starting: 'running',
        ready: 'running',
        error: 'crashed',
        stopped: 'stopped',
      };

      let healthRuntimeStatus: 'running' | 'stopped' | 'crashed';
      if (info.status in runtimeStatusMap) {
        healthRuntimeStatus = runtimeStatusMap[info.status];
      } else {
        this.logger?.warn(
          { pythonStatus: info.status, knownStatuses: Object.keys(runtimeStatusMap) },
          'Unknown Python runtime status, treating as "crashed" for safety'
        );
        healthRuntimeStatus = 'crashed';
      }

      const runtimeStatus: HealthStatus['runtime'] = {
        pid: info.pid > 0 ? info.pid : undefined,
        status: healthRuntimeStatus,
      };

      let status: HealthStatus['status'] = 'healthy';
      if (info.status === 'stopped' || info.status === 'error') {
        status = 'unhealthy';
      } else if (activeStreams > 10 || info.status === 'starting') {
        status = 'degraded';
      }

      let stateConsistent: boolean | undefined = undefined;
      let stateErrors: string[] | undefined = undefined;

      if (info.status === 'ready') {
        const transport = this.runner.getTransport();
        if (transport) {
          try {
            const response = await transport.request<{
              loaded_models?: Array<{ model_id: string; state: string; type: string }>;
              active_streams?: number;
              restart_count?: number;
            }>('runtime/state', undefined, { timeout: 5000 });

            if (response && response.loaded_models) {
              const pythonModels = new Set<string>(response.loaded_models.map(m => m.model_id));
              const typescriptModels = new Set(modelHandles.map(h => h.descriptor.id));

              const orphanedInPython = Array.from(pythonModels).filter(id => !typescriptModels.has(id));
              const orphanedInTS = Array.from(typescriptModels).filter(id => !pythonModels.has(id));

              stateErrors = [];
              if (orphanedInPython.length > 0) {
                stateErrors.push(
                  `${orphanedInPython.length} orphaned models in Python: ${orphanedInPython.join(', ')}`
                );
              }
              if (orphanedInTS.length > 0) {
                stateErrors.push(
                  `${orphanedInTS.length} orphaned models in TypeScript: ${orphanedInTS.join(', ')}`
                );
              }

              stateConsistent = stateErrors.length === 0;
              if (!stateConsistent && status === 'healthy') {
                status = 'degraded';
              }
            } else {
              stateConsistent = undefined;
            }
          } catch {
            stateErrors = ['Failed to query Python runtime state'];
            stateConsistent = false;
            if (status === 'healthy') {
              status = 'degraded';
            }
          }
        }
      }

      const breaker = this.getCircuitBreakerSnapshot();
      if (breaker.state === 'open') {
        status = 'degraded';
        stateErrors = stateErrors || [];
        stateErrors.push(`Circuit breaker is open (${breaker.failures} failures)`);
        stateConsistent = false;
      } else if (breaker.state === 'half-open') {
        stateErrors = stateErrors || [];
        stateErrors.push('Circuit breaker is half-open (recovery in progress)');
      }

      return {
        status,
        uptime: info.uptime,
        activeStreams,
        loadedModels,
        runtime: runtimeStatus,
        stateConsistent,
        stateErrors: stateErrors && stateErrors.length > 0 ? stateErrors : undefined,
      };
    } catch {
      return {
        status: 'unhealthy',
        uptime: 0,
        activeStreams: 0,
        loadedModels: 0,
        runtime: {
          status: 'crashed',
        },
        stateConsistent: false,
        stateErrors: ['Health check failed with exception'],
      };
    }
  }
}
