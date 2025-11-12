/**
 * Phase 4 Integration Factory
 *
 * Factory pattern for creating and wiring Phase 4/5 components with dependency injection.
 * Supports zero-downtime startup and gradual rollout via feature flags.
 *
 * Components integrated:
 * - Phase 4.1: Adaptive Stream Governor (PID-based admission control)
 * - Phase 4.3: TTFT Pipeline (warmup queue, speculation, KV prefetch)
 * - Phase 4.4: QoS Monitor (SLO monitoring + auto-remediation)
 * - Phase 4.5: QoS Integration (event-driven integration layer)
 *
 * Phase 5 Week 1 Day 2-3: Added TtftIntegration component for TTFT acceleration
 */

import type { Logger } from 'pino';
import type { StreamRegistry } from '../bridge/stream-registry.js';
import { QosIntegration, type QosIntegrationConfig } from '../streaming/integration/QosIntegration.js';
import { AdaptiveGovernor, type StreamGovernorConfig } from '../streaming/governor/AdaptiveGovernor.js';
import type { QosMonitorConfig } from '../streaming/qos/QosMonitor.js';
import { getFeatureFlags } from '../config/feature-flag-loader.js';
import type { Config } from '../config/loader.js';
import { TtftIntegration } from '../core/ttft-integration.js';

/**
 * Phase 4 Integration Options
 */
export interface Phase4IntegrationOptions {
  streamRegistry: StreamRegistry;
  config: Config;
  logger?: Logger;
  requestId?: string; // Optional request ID for feature flag evaluation
}

/**
 * Phase 4 Integration Components
 * Returned by the factory for lifecycle management
 */
export interface Phase4Components {
  qosIntegration?: QosIntegration;
  adaptiveGovernor?: AdaptiveGovernor;
  ttftIntegration?: TtftIntegration;
  enabled: boolean;
}

/**
 * Phase 4 Integration Factory
 *
 * Creates and wires Phase 4 components based on feature flags and configuration.
 * Supports gradual rollout via hash-based feature routing.
 */
export class Phase4IntegrationFactory {
  private static instance: Phase4Components | null = null;

  /**
   * Create Phase 4 components with dependency injection
   *
   * @param options - Integration options
   * @returns Phase4Components with lifecycle management
   */
  public static create(options: Phase4IntegrationOptions): Phase4Components {
    const { streamRegistry, config, logger, requestId = 'default' } = options;

    // Check feature flags for Phase 4 rollout
    const featureFlags = getFeatureFlags();
    const isPhase4Enabled = featureFlags.isPhase4Enabled(requestId);

    if (!isPhase4Enabled) {
      logger?.debug('[Phase4Factory] Phase 4 disabled via feature flags');
      return { enabled: false };
    }

    logger?.info('[Phase4Factory] Phase 4 enabled, creating components...');

    const components: Phase4Components = {
      enabled: true,
    };

    // Component 1: Adaptive Governor (Phase 4.1)
    if (config.streaming?.phase4?.adaptive_governor?.enabled) {
      const governorEval = featureFlags.evaluate('adaptive_governor', requestId);

      if (governorEval.enabled) {
        logger?.info('[Phase4Factory] Creating AdaptiveGovernor...');

        try {
          const governorConfig = config.streaming.phase4.adaptive_governor as unknown as StreamGovernorConfig;
          components.adaptiveGovernor = new AdaptiveGovernor(
            governorConfig,
            logger
          );

          // Wire to StreamRegistry (via method injection)
          // StreamRegistry will call governor.evaluate() before admitting new streams
          logger?.info('[Phase4Factory] AdaptiveGovernor created successfully');
        } catch (error) {
          logger?.error('[Phase4Factory] Failed to create AdaptiveGovernor:', error);
        }
      } else {
        logger?.debug(`[Phase4Factory] AdaptiveGovernor disabled by feature flag: ${governorEval.reason}`);
      }
    }

    // Component 2: TTFT Pipeline Integration (Phase 4.3)
    if (config.ttft_accelerator?.enabled) {
      const ttftEval = featureFlags.evaluate('ttft_pipeline', requestId);

      if (ttftEval.enabled) {
        logger?.info('[Phase4Factory] Creating TtftIntegration...');

        try {
          components.ttftIntegration = new TtftIntegration({
            config,
            logger,
            requestId,
          });

          logger?.info('[Phase4Factory] TtftIntegration created successfully');
        } catch (error) {
          logger?.error('[Phase4Factory] Failed to create TtftIntegration:', error);
        }
      } else {
        logger?.debug(`[Phase4Factory] TTFT Pipeline disabled by feature flag: ${ttftEval.reason}`);
      }
    }

    // Component 3: QoS Monitor + Integration (Phase 4.4 + 4.5)
    // Phase 5 Week 1 Day 3-4: Added PolicyEngine support
    if (config.qos_monitor?.enabled) {
      const qosEval = featureFlags.evaluate('qos_monitor', requestId);

      if (qosEval.enabled) {
        logger?.info('[Phase4Factory] Creating QoSIntegration with PolicyEngine...');

        try {
          // Transform snake_case config to camelCase for TypeScript interfaces
          const qosMonitorConfig: QosMonitorConfig = {
            enabled: config.qos_monitor.enabled,
            evaluator: {
              enabled: config.qos_monitor.evaluator.enabled,
              evaluationIntervalMs: config.qos_monitor.evaluator.check_interval_ms,
              windowMs: 300000, // 5 minutes default
              tdigestCompression: 100, // Default compression
            },
            executor: {
              enabled: config.qos_monitor.executor.enabled,
              cooldownMs: 60000, // 1 minute default
              maxExecutionsPerWindow: 10,
              executionWindowMs: 300000, // 5 minutes
              loopDetectionWindow: 5,
            },
            policyStore: {
              policies: [], // Will be loaded by PolicyEngine from YAML
            },
            usePolicyEngine: true, // Enable PolicyEngine by default
          };

          const qosIntegrationConfig: QosIntegrationConfig = {
            enabled: true,
            qosMonitor: qosMonitorConfig,
            sampleRate: 1, // Sample all metrics by default
          };

          components.qosIntegration = new QosIntegration(
            streamRegistry,
            qosIntegrationConfig,
            logger
          );

          logger?.info('[Phase4Factory] QoSIntegration created successfully with PolicyEngine enabled');
        } catch (error) {
          logger?.error('[Phase4Factory] Failed to create QoSIntegration:', error);
        }
      } else {
        logger?.debug(`[Phase4Factory] QoS Monitor disabled by feature flag: ${qosEval.reason}`);
      }
    }

    // Cache instance for singleton pattern (optional)
    Phase4IntegrationFactory.instance = components;

    return components;
  }

  /**
   * Get singleton instance (if exists)
   */
  public static getInstance(): Phase4Components | null {
    return Phase4IntegrationFactory.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  public static reset(): void {
    Phase4IntegrationFactory.instance = null;
  }

  /**
   * Shutdown all Phase 4 components
   * Call this during engine shutdown to clean up resources
   */
  public static async shutdown(components: Phase4Components): Promise<void> {
    if (!components.enabled) {
      return;
    }

    // Shutdown QoS Monitor
    if (components.qosIntegration) {
      // QosIntegration cleanup (if needed)
      // Currently QosIntegration doesn't require explicit shutdown
    }

    // Shutdown Adaptive Governor
    if (components.adaptiveGovernor) {
      // AdaptiveGovernor cleanup (if needed)
      // Currently doesn't require explicit shutdown
    }
  }
}

/**
 * Convenience function to create Phase 4 components
 *
 * @param options - Integration options
 * @returns Phase4Components
 */
export function createPhase4Integration(
  options: Phase4IntegrationOptions
): Phase4Components {
  return Phase4IntegrationFactory.create(options);
}

/**
 * Check if Phase 4 is enabled for a given request
 *
 * @param requestId - Request identifier for feature flag evaluation
 * @returns true if Phase 4 should be enabled
 */
export function isPhase4EnabledForRequest(requestId: string): boolean {
  const featureFlags = getFeatureFlags();
  return featureFlags.isPhase4Enabled(requestId);
}
