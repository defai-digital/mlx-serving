/**
 * Telemetry bridge adapter
 *
 * Connects the TelemetryHooks interface (used by Engine) to the TelemetryManager
 * (OpenTelemetry implementation). This allows the Engine to use simple callbacks
 * while the telemetry system records structured metrics.
 *
 * @module telemetry/bridge
 */

import type { TelemetryHooks } from '../types/engine.js';
import type { ModelHandle } from '../types/models.js';
import type { GenerationStats, EngineError } from '../types/generators.js';
import { TelemetryManager, type TelemetryConfig, type MlxServingMetrics } from './otel.js';
import type { Logger } from 'pino';

/**
 * Creates telemetry hooks that bridge to OpenTelemetry metrics.
 *
 * @param config - Telemetry configuration
 * @param logger - Optional logger for telemetry events
 * @returns TelemetryHooks implementation and TelemetryManager instance
 *
 * @example
 * ```typescript
 * const { hooks, manager } = await createTelemetryBridge({
 *   enabled: true,
 *   serviceName: 'mlx-serving',
 *   prometheusPort: 9464
 * }, logger);
 *
 * const engine = await createEngine({
 *   telemetry: {
 *     enabled: true,
 *     hooks
 *   }
 * });
 *
 * // Metrics are automatically recorded via hooks
 * // Access Prometheus metrics at http://localhost:9464/metrics
 *
 * // Cleanup on shutdown
 * await manager.shutdown();
 * ```
 */
export async function createTelemetryBridge(
  config: TelemetryConfig,
  logger?: Logger
): Promise<{ hooks: TelemetryHooks; manager: TelemetryManager }> {
  const manager = new TelemetryManager({ ...config, logger });

  if (config.enabled) {
    await manager.start();
  }

  const hooks: TelemetryHooks = createHooksFromManager(manager, config.enabled);

  return { hooks, manager };
}

/**
 * Creates TelemetryHooks implementation from a TelemetryManager.
 *
 * @param manager - TelemetryManager instance
 * @param enabled - Whether telemetry is enabled
 * @returns TelemetryHooks implementation
 * @internal
 */
function createHooksFromManager(
  manager: TelemetryManager,
  enabled: boolean
): TelemetryHooks {
  if (!enabled) {
    // Return no-op hooks when disabled
    return {};
  }

  return {
    onModelLoaded: (model: ModelHandle) => {
      try {
        const metrics = manager.metrics;
        metrics.modelsLoaded.add(1, {
          model: model.descriptor.id,
          type: model.descriptor.modality || 'text',
        });
      } catch (err) {
        // Silently fail to avoid breaking engine operations
      }
    },

    onTokenGenerated: (_token: string, stats: GenerationStats) => {
      try {
        const metrics = manager.metrics;
        metrics.tokensGenerated.add(1, {
          model: stats.modelId || 'unknown',
        });
      } catch (err) {
        // Silently fail
      }
    },

    onGenerationCompleted: (stats: GenerationStats) => {
      try {
        const metrics = manager.metrics;
        const modelId = stats.modelId || 'unknown';

        // Record generation duration (totalTime is in seconds, convert to ms)
        if (stats.totalTime !== undefined) {
          metrics.generationDuration.record(stats.totalTime * 1000, {
            model: modelId,
          });
        }

        // Record total tokens generated
        const totalTokens = stats.tokensGenerated || 0;
        if (totalTokens > 0) {
          metrics.tokensGenerated.add(totalTokens, {
            model: modelId,
          });
        }
      } catch (err) {
        // Silently fail
      }
    },

    onError: (error: EngineError) => {
      try {
        const metrics = manager.metrics;
        metrics.errorsTotal.add(1, {
          code: error.code || 'UNKNOWN',
          type: 'Error', // EngineError doesn't have a name property
        });

        // Track generation errors specifically
        if (error.code === 'GENERATION_ERROR') {
          metrics.generationErrors.add(1, {
            model: 'unknown',
          });
        }
      } catch (err) {
        // Silently fail
      }
    },
  };
}

/**
 * Get metrics from a telemetry manager (for testing/debugging).
 *
 * @param manager - TelemetryManager instance
 * @returns MlxServingMetrics if started, undefined otherwise
 */
export function getMetrics(manager: TelemetryManager): MlxServingMetrics | undefined {
  try {
    return manager.isStarted() ? manager.metrics : undefined;
  } catch {
    return undefined;
  }
}
