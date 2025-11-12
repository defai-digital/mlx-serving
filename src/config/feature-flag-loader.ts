/**
 * Feature Flag Loader
 *
 * Loads feature flags from YAML with hash-based deterministic routing
 * Supports zero-downtime config reload via SIGHUP signal
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import * as yaml from 'js-yaml';

/**
 * Feature Flag Configuration Schema
 */
export interface FeatureFlagConfig {
  phase4_rollout: {
    enabled: boolean;
    percentage: number;
    hash_seed: string;
  };
  adaptive_governor: {
    enabled: boolean;
    rollout_percentage: number;
    hash_seed: string;
  };
  http2_transport: {
    enabled: boolean;
    rollout_percentage: number;
    hash_seed: string;
  };
  ttft_pipeline: {
    enabled: boolean;
    rollout_percentage: number;
    hash_seed: string;
    warmup_queue?: { enabled: boolean };
    speculation?: { enabled: boolean; allowlist_only: boolean };
    kv_prep?: { enabled: boolean };
  };
  qos_monitor: {
    enabled: boolean;
    rollout_percentage: number;
    hash_seed: string;
    evaluator?: { enabled: boolean };
    executor?: { enabled: boolean; dry_run: boolean };
    policy_store?: { enabled: boolean };
  };
  qos_integration: {
    enabled: boolean;
    rollout_percentage: number;
    hash_seed: string;
  };
  emergency: {
    kill_switch: boolean;
    rollback_to_baseline: boolean;
  };
  observability: {
    log_feature_decisions: boolean;
    export_metrics: boolean;
    metric_prefix: string;
  };
  config_reload: {
    enabled: boolean;
    validate_on_reload: boolean;
    rollback_on_error: boolean;
  };
}

/**
 * Feature Flag Evaluation Result
 */
export interface FeatureFlagEvaluation {
  feature: string;
  enabled: boolean;
  reason: string;
  hash?: number;
  threshold?: number;
}

/**
 * Feature Flag Loader Class
 */
export class FeatureFlagLoader {
  private config: FeatureFlagConfig | null = null;
  private configPath: string;
  private previousConfig: FeatureFlagConfig | null = null;
  private readonly logger?: Logger;

  constructor(configPath?: string, logger?: Logger) {
    // Find package root and default to config/feature-flags.yaml
    this.configPath = configPath || this.getDefaultConfigPath();
    this.logger = logger;
  }

  /**
   * Get default feature flags config path
   */
  private getDefaultConfigPath(): string {
    // Start from current directory and walk up to find package.json
    let currentDir = process.cwd();
    while (currentDir !== '/') {
      const packageJsonPath = join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        return join(currentDir, 'config', 'feature-flags.yaml');
      }
      currentDir = join(currentDir, '..');
    }
    // Fallback to relative path
    return join(process.cwd(), 'config', 'feature-flags.yaml');
  }

  /**
   * Load feature flags from YAML file
   */
  public load(): FeatureFlagConfig {
    try {
      const fileContents = readFileSync(this.configPath, 'utf8');
      const config = yaml.load(fileContents) as FeatureFlagConfig;

      // Validate config structure
      this.validateConfig(config);

      // Store previous config for rollback
      if (this.config) {
        this.previousConfig = this.config;
      }

      this.config = config;
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Feature flags file not found: ${this.configPath}. ` +
          `Please ensure config/feature-flags.yaml exists.`
        );
      }
      throw new Error(`Failed to load feature flags: ${error}`);
    }
  }

  /**
   * Reload feature flags (for zero-downtime config updates)
   */
  public reload(): FeatureFlagConfig {
    try {
      const newConfig = this.load();

      // If validation fails, rollback is automatic (load() throws)
      return newConfig;
    } catch (error) {
      // Rollback to previous config if reload fails
      if (this.config && this.config.config_reload.rollback_on_error && this.previousConfig) {
        this.logger?.error({ error }, 'Feature flag reload failed, rolling back to previous config');
        this.config = this.previousConfig;
        return this.config;
      }
      throw error;
    }
  }

  /**
   * Validate feature flag configuration
   */
  private validateConfig(config: FeatureFlagConfig): void {
    // Validate percentage values (0-100)
    const percentageFields = [
      config.phase4_rollout.percentage,
      config.adaptive_governor.rollout_percentage,
      config.http2_transport.rollout_percentage,
      config.ttft_pipeline.rollout_percentage,
      config.qos_monitor.rollout_percentage,
      config.qos_integration.rollout_percentage,
    ];

    for (const pct of percentageFields) {
      if (pct < 0 || pct > 100) {
        throw new Error(`Invalid rollout percentage: ${pct}. Must be 0-100.`);
      }
    }

    // Validate hash seeds exist
    if (!config.phase4_rollout.hash_seed) {
      throw new Error('Missing phase4_rollout.hash_seed');
    }
  }

  /**
   * Get current configuration
   */
  public getConfig(): FeatureFlagConfig {
    if (!this.config) {
      this.load();
    }
    return this.config!;
  }

  /**
   * Deterministic hash-based routing
   * Returns true if request should receive feature
   *
   * @param requestId - Unique request identifier (e.g., stream ID, request UUID)
   * @param hashSeed - Seed for hash function (from config)
   * @param percentage - Target percentage (0-100)
   * @returns true if feature should be enabled for this request
   */
  public static shouldEnableFeature(
    requestId: string,
    hashSeed: string,
    percentage: number
  ): boolean {
    if (percentage === 0) return false;
    if (percentage === 100) return true;

    // MD5 hash of requestId + seed
    const hash = createHash('md5')
      .update(requestId + hashSeed)
      .digest('hex');

    // Convert first 8 hex chars to number, then modulo 100
    const hashValue = parseInt(hash.substring(0, 8), 16) % 100;

    return hashValue < percentage;
  }

  /**
   * Evaluate feature flag for a specific request
   *
   * @param feature - Feature name
   * @param requestId - Unique request identifier
   * @returns FeatureFlagEvaluation result
   */
  public evaluate(feature: string, requestId: string): FeatureFlagEvaluation {
    const config = this.getConfig();

    // Emergency kill switch
    if (config.emergency.kill_switch) {
      return {
        feature,
        enabled: false,
        reason: 'Emergency kill switch active',
      };
    }

    // Emergency rollback
    if (config.emergency.rollback_to_baseline) {
      return {
        feature,
        enabled: false,
        reason: 'Emergency rollback to baseline',
      };
    }

    // Global phase4_rollout gate
    if (!config.phase4_rollout.enabled) {
      return {
        feature,
        enabled: false,
        reason: 'Phase 4 rollout globally disabled',
      };
    }

    // Check if feature should be enabled based on hash routing
    let featureConfig: { enabled: boolean; rollout_percentage: number; hash_seed: string } | null = null;

    switch (feature) {
      case 'adaptive_governor':
        featureConfig = config.adaptive_governor;
        break;
      case 'http2_transport':
        featureConfig = config.http2_transport;
        break;
      case 'ttft_pipeline':
        featureConfig = config.ttft_pipeline;
        break;
      case 'qos_monitor':
        featureConfig = config.qos_monitor;
        break;
      case 'qos_integration':
        featureConfig = config.qos_integration;
        break;
      default:
        return {
          feature,
          enabled: false,
          reason: `Unknown feature: ${feature}`,
        };
    }

    // Feature disabled in config
    if (!featureConfig.enabled) {
      return {
        feature,
        enabled: false,
        reason: 'Feature disabled in config',
      };
    }

    // Hash-based routing
    const shouldEnable = FeatureFlagLoader.shouldEnableFeature(
      requestId,
      featureConfig.hash_seed,
      featureConfig.rollout_percentage
    );

    const hash = createHash('md5')
      .update(requestId + featureConfig.hash_seed)
      .digest('hex');
    const hashValue = parseInt(hash.substring(0, 8), 16) % 100;

    // Log decision if observability enabled
    if (config.observability.log_feature_decisions) {
      this.logger?.info(
        {
          feature,
          requestId,
          enabled: shouldEnable,
          hashValue,
          threshold: featureConfig.rollout_percentage,
        },
        'Feature flag decision evaluated'
      );
    }

    return {
      feature,
      enabled: shouldEnable,
      reason: shouldEnable
        ? `Hash routing (${hashValue} < ${featureConfig.rollout_percentage})`
        : `Hash routing (${hashValue} >= ${featureConfig.rollout_percentage})`,
      hash: hashValue,
      threshold: featureConfig.rollout_percentage,
    };
  }

  /**
   * Check if Phase 4 rollout is active for a request
   *
   * @param requestId - Unique request identifier
   * @returns true if Phase 4 features should be enabled
   */
  public isPhase4Enabled(requestId: string): boolean {
    const config = this.getConfig();

    // Emergency controls
    if (config.emergency.kill_switch || config.emergency.rollback_to_baseline) {
      return false;
    }

    // Global gate
    if (!config.phase4_rollout.enabled) {
      return false;
    }

    // Hash-based routing
    return FeatureFlagLoader.shouldEnableFeature(
      requestId,
      config.phase4_rollout.hash_seed,
      config.phase4_rollout.percentage
    );
  }
}

/**
 * Global feature flag loader instance
 */
let globalLoader: FeatureFlagLoader | null = null;

/**
 * Initialize global feature flag loader
 */
export function initializeFeatureFlags(configPath?: string, logger?: Logger): FeatureFlagLoader {
  globalLoader = new FeatureFlagLoader(configPath, logger);
  globalLoader.load();
  return globalLoader;
}

/**
 * Get global feature flag loader
 */
export function getFeatureFlags(): FeatureFlagLoader {
  if (!globalLoader) {
    globalLoader = initializeFeatureFlags();
  }
  return globalLoader;
}

/**
 * Reset global feature flag loader (for testing)
 */
export function resetFeatureFlags(): void {
  globalLoader = null;
}

/**
 * Reload feature flags (for zero-downtime config updates)
 */
export function reloadFeatureFlags(): FeatureFlagConfig {
  const loader = getFeatureFlags();
  return loader.reload();
}
