/**
 * OpenTelemetry infrastructure for mlx-serving.
 *
 * Provides metrics collection, Prometheus exporter, and standardized
 * instrumentation for model loading, token generation, IPC operations,
 * and error tracking.
 *
 * @module telemetry/otel
 */

import { metrics, type Meter, type Counter, type Histogram } from '@opentelemetry/api';
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import type { Logger } from 'pino';

/**
 * Configuration options for OpenTelemetry metrics.
 */
export interface TelemetryConfig {
  /**
   * Enable metrics collection (default: false).
   */
  enabled: boolean;
  /**
   * Service name for metrics (default: 'mlx-serving').
   */
  serviceName?: string;
  /**
   * Prometheus exporter port (default: 9464).
   */
  prometheusPort?: number;
  /**
   * Metrics export interval in milliseconds (default: 60000).
   */
  exportIntervalMs?: number;
  /**
   * Optional logger for telemetry events.
   */
  logger?: Logger;
}

/**
 * Internal normalized config with all optional fields resolved.
 * @internal
 */
interface NormalizedTelemetryConfig {
  enabled: boolean;
  serviceName: string;
  prometheusPort: number;
  exportIntervalMs: number;
  logger: Logger | undefined;
}

/**
 * Standard metrics exported by mlx-serving.
 */
export interface MlxServingMetrics {
  // Model lifecycle
  modelsLoaded: Counter;
  modelsUnloaded: Counter;
  modelLoadDuration: Histogram;

  // Token generation
  tokensGenerated: Counter;
  generationDuration: Histogram;
  generationErrors: Counter;

  // IPC operations
  ipcRequestsTotal: Counter;
  ipcRequestDuration: Histogram;
  ipcRequestsInFlight: Counter;

  // Batch operations (Phase 1)
  batchOperationsTotal: Counter;
  batchSizeHistogram: Histogram;
  batchEfficiency: Histogram;

  // Error tracking
  errorsTotal: Counter;
  retryAttemptsTotal: Counter;
  circuitBreakerStateChanges: Counter;
}

/**
 * OpenTelemetry telemetry manager for mlx-serving.
 *
 * Initializes the metrics provider, creates standardized metrics,
 * and provides a simple API for instrumentation throughout the codebase.
 *
 * @example
 * ```typescript
 * const telemetry = new TelemetryManager({
 *   enabled: true,
 *   serviceName: 'mlx-serving',
 *   prometheusPort: 9464
 * });
 *
 * await telemetry.start();
 *
 * // Instrument model loading
 * telemetry.metrics.modelsLoaded.add(1, { model: 'llama-3-8b' });
 *
 * // Instrument token generation
 * const startTime = Date.now();
 * // ... generate tokens ...
 * const duration = Date.now() - startTime;
 * telemetry.metrics.generationDuration.record(duration, { model: 'llama-3-8b' });
 *
 * await telemetry.shutdown();
 * ```
 */
export class TelemetryManager {
  private readonly config: NormalizedTelemetryConfig;
  private meterProvider: MeterProvider | null = null;
  private prometheusExporter: PrometheusExporter | null = null;
  private meter: Meter | null = null;
  private _metrics: MlxServingMetrics | null = null;
  private started = false;

  constructor(config: TelemetryConfig) {
    this.config = {
      enabled: config.enabled,
      serviceName: config.serviceName || 'mlx-serving',
      prometheusPort: config.prometheusPort ?? 9464,
      exportIntervalMs: config.exportIntervalMs ?? 60000,
      logger: config.logger, // explicitly optional
    };
  }

  /**
   * Get the initialized metrics. Throws if not started.
   */
  public get metrics(): MlxServingMetrics {
    if (!this._metrics) {
      throw new Error('TelemetryManager not started. Call start() first.');
    }
    return this._metrics;
  }

  /**
   * Initialize the OpenTelemetry metrics provider and create metrics.
   *
   * Sets up the Prometheus exporter on the configured port and registers
   * all standard mlx-serving metrics.
   *
   * @throws {Error} if telemetry is disabled or already started.
   */
  public async start(): Promise<void> {
    if (!this.config.enabled) {
      throw new Error('Telemetry is disabled. Set enabled:true in config.');
    }

    if (this.started) {
      this.config.logger?.warn('TelemetryManager already started');
      return;
    }

    try {
      // Create Prometheus exporter (acts as its own reader, not a push exporter)
      this.prometheusExporter = new PrometheusExporter({
        port: this.config.prometheusPort,
      });

      // Create meter provider with Prometheus exporter as reader
      // Note: PrometheusExporter is a MetricReader but may have version-specific quirks
      // Type assertion to work around potential interface mismatches
      this.meterProvider = new MeterProvider({
        readers: [this.prometheusExporter as unknown as MetricReader],
      });

      // Register global meter provider
      metrics.setGlobalMeterProvider(this.meterProvider);

      // Get meter for this service
      this.meter = metrics.getMeter(this.config.serviceName, '0.2.0');

      // Create all metrics
      this._metrics = this.createMetrics();

      this.started = true;

      this.config.logger?.info(
        {
          serviceName: this.config.serviceName,
          prometheusPort: this.config.prometheusPort,
          exportIntervalMs: this.config.exportIntervalMs,
        },
        'OpenTelemetry metrics started'
      );

      // Log Prometheus scrape endpoint
      this.config.logger?.info(
        { endpoint: `http://localhost:${this.config.prometheusPort}/metrics` },
        'Prometheus metrics available'
      );
    } catch (error) {
      this.config.logger?.error({ error }, 'Failed to start telemetry');
      throw error;
    }
  }

  /**
   * Shutdown the telemetry manager and flush all metrics.
   *
   * This should be called during graceful shutdown to ensure all metrics
   * are exported before the process exits.
   */
  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await this.meterProvider?.shutdown();
      this.prometheusExporter?.shutdown();

      this.started = false;
      this._metrics = null;
      this.meter = null;
      this.meterProvider = null;
      this.prometheusExporter = null;

      this.config.logger?.info('OpenTelemetry metrics shut down');
    } catch (error) {
      this.config.logger?.error({ error }, 'Failed to shutdown telemetry');
      throw error;
    }
  }

  /**
   * Check if telemetry is started and active.
   */
  public isStarted(): boolean {
    return this.started;
  }

  /**
   * Create all standard metrics for mlx-serving.
   */
  private createMetrics(): MlxServingMetrics {
    if (!this.meter) {
      throw new Error('Meter not initialized');
    }

    return {
      // Model lifecycle
      modelsLoaded: this.meter.createCounter('kr_serve_models_loaded_total', {
        description: 'Total number of models loaded',
        unit: '1',
      }),
      modelsUnloaded: this.meter.createCounter('kr_serve_models_unloaded_total', {
        description: 'Total number of models unloaded',
        unit: '1',
      }),
      modelLoadDuration: this.meter.createHistogram('kr_serve_model_load_duration_ms', {
        description: 'Time taken to load a model',
        unit: 'ms',
      }),

      // Token generation
      tokensGenerated: this.meter.createCounter('kr_serve_tokens_generated_total', {
        description: 'Total number of tokens generated',
        unit: '1',
      }),
      generationDuration: this.meter.createHistogram('kr_serve_generation_duration_ms', {
        description: 'Time taken to generate tokens',
        unit: 'ms',
      }),
      generationErrors: this.meter.createCounter('kr_serve_generation_errors_total', {
        description: 'Total number of generation errors',
        unit: '1',
      }),

      // IPC operations
      ipcRequestsTotal: this.meter.createCounter('kr_serve_ipc_requests_total', {
        description: 'Total number of JSON-RPC requests',
        unit: '1',
      }),
      ipcRequestDuration: this.meter.createHistogram('kr_serve_ipc_request_duration_ms', {
        description: 'Time taken for JSON-RPC requests',
        unit: 'ms',
      }),
      ipcRequestsInFlight: this.meter.createCounter('kr_serve_ipc_requests_in_flight', {
        description: 'Number of in-flight JSON-RPC requests',
        unit: '1',
      }),

      // Batch operations (Phase 1)
      batchOperationsTotal: this.meter.createCounter('kr_serve_batch_operations_total', {
        description: 'Total number of batched operations',
        unit: '1',
      }),
      batchSizeHistogram: this.meter.createHistogram('kr_serve_batch_size', {
        description: 'Size of batched requests',
        unit: '1',
      }),
      batchEfficiency: this.meter.createHistogram('kr_serve_batch_efficiency', {
        description: 'Batch efficiency (requests per batch)',
        unit: '1',
      }),

      // Error tracking
      errorsTotal: this.meter.createCounter('kr_serve_errors_total', {
        description: 'Total number of errors by type',
        unit: '1',
      }),
      retryAttemptsTotal: this.meter.createCounter('kr_serve_retry_attempts_total', {
        description: 'Total number of retry attempts',
        unit: '1',
      }),
      circuitBreakerStateChanges: this.meter.createCounter(
        'kr_serve_circuit_breaker_state_changes_total',
        {
          description: 'Total number of circuit breaker state changes',
          unit: '1',
        }
      ),
    };
  }
}

/**
 * Create a telemetry manager with the given configuration.
 *
 * @param config - Telemetry configuration
 * @returns TelemetryManager instance
 *
 * @example
 * ```typescript
 * const telemetry = createTelemetry({
 *   enabled: process.env.ENABLE_METRICS === 'true',
 *   serviceName: 'mlx-serving',
 *   prometheusPort: 9464
 * });
 *
 * if (telemetry) {
 *   await telemetry.start();
 * }
 * ```
 */
export function createTelemetry(config: TelemetryConfig): TelemetryManager {
  return new TelemetryManager(config);
}
