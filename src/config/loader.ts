/**
 * Configuration Loader
 *
 * Loads configuration from YAML files with environment-specific overrides
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import type { CacheConfig } from '../types/cache.js';
import { RuntimeConfigSchema } from '../types/schemas/config.js';

/**
 * Configuration Schema (matches runtime.yaml structure)
 */
export interface Config {
  batch_queue: {
    enabled: boolean;
    max_batch_size: number;
    flush_interval_ms: number;
    adaptive_sizing?: boolean; // Week 2 Day 3
    target_batch_time_ms?: number; // Week 2 Day 3
    priority_queue?: boolean; // Week 2 Day 3
  };
  python_runtime: {
    python_path: string;
    runtime_path: string;
    max_restarts: number;
    startup_timeout_ms: number;
    shutdown_timeout_ms: number;
    init_probe_fallback_ms: number;
    restart_delay_base_ms: number;
  };
  json_rpc: {
    default_timeout_ms: number;
    max_line_buffer_size: number;
    max_pending_requests: number;
    retry: {
      max_attempts: number;
      initial_delay_ms: number;
      max_delay_ms: number;
      backoff_multiplier: number;
      retryable_errors: string[];
      jitter?: number;
    };
    circuit_breaker: {
      failure_threshold: number;
      recovery_timeout_ms: number;
      half_open_max_calls: number;
      half_open_success_threshold: number;
      failure_window_ms?: number;
    };
  };
  stream_registry: {
    default_timeout_ms: number;
    max_active_streams: number;
    cleanup_interval_ms: number;
    // Phase 4: Stream Optimization (v0.2.0)
    adaptive_limits: {
      enabled: boolean;
      min_streams: number;
      max_streams: number;
      target_ttft_ms: number;
      target_latency_ms: number;
      adjustment_interval_ms: number;
      scale_up_threshold: number;
      scale_down_threshold: number;
    };
    chunk_pooling: {
      enabled: boolean;
      pool_size: number;
      pool_cleanup_interval_ms: number;
    };
    backpressure: {
      enabled: boolean;
      max_unacked_chunks: number;
      ack_timeout_ms: number;
      slow_consumer_threshold_ms: number;
    };
    metrics: {
      enabled: boolean;
      track_ttft: boolean;
      track_throughput: boolean;
      track_cancellations: boolean;
      export_interval_ms: number;
    };
  };
  model: {
    default_context_length: number;
    default_max_tokens: number;
    max_loaded_models: number;
    supported_dtypes: string[];
    default_quantization: 'none' | 'int8' | 'int4';
    default_dtype: string;
    trusted_model_directories: string[] | null;
    max_generation_tokens: number;
    max_temperature: number;
    // Phase 2: In-Memory Model Caching (v0.2.0)
    memory_cache: {
      enabled: boolean;
      max_cached_models: number;
      eviction_strategy: 'lru';
      warmup_on_start: string[];
      track_stats: boolean;
    };
  };
  cache: {
    enabled: boolean;
    cache_dir: string;
    max_size_bytes: number;
    max_age_days: number;
    eviction_policy: 'lru' | 'lfu' | 'fifo';
    preload_models: string[];
    validate_on_startup: boolean;
    enable_compression: boolean;
  };
  python_bridge: {
    max_buffer_size: number;
    stream_queue_size: number;
    queue_put_max_retries: number;
    queue_put_backoff_ms: number;
  };
  outlines: {
    max_schema_size_bytes: number;
  };
  performance: {
    aggressive_gc: boolean;
    enable_batching: boolean;
    batch_size: number;
    batch_timeout_ms: number;
    use_messagepack: boolean;
  };
  telemetry: {
    enabled: boolean;
    service_name: string;
    prometheus_port: number;
    export_interval_ms: number;
  };
  development: {
    verbose: boolean;
    debug: boolean;
    log_ipc: boolean;
    enable_profiling: boolean;
  };
  environments?: {
    production?: Partial<Config>;
    development?: Partial<Config>;
    test?: Partial<Config>;
  };
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const output = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = output[key];

      if (
        sourceValue &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        output[key] = deepMerge(targetValue, sourceValue as Partial<T[Extract<keyof T, string>]>) as T[Extract<keyof T, string>];
      } else if (sourceValue !== undefined) {
        output[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return output;
}

/**
 * Get the current module directory in a way that works for both ESM and CJS
 *
 * With tsup's shims enabled, __dirname is available in both contexts.
 * Tsup automatically converts it appropriately for each format.
 *
 * @returns The directory containing the current module
 */
function getCurrentModuleDir(): string {
  // With tsup shims: true, __dirname is available in both ESM and CJS outputs
  // In ESM output, tsup converts it to dirname(fileURLToPath(import.meta.url))
  // In CJS output, tsup uses the native __dirname

  // Use globalThis to access __dirname without TypeScript errors
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirnameValue = (globalThis as any).__dirname;

  if (typeof dirnameValue !== 'undefined') {
    return dirnameValue as string;
  }

  // Fallback for development mode when running TypeScript directly
  // In this case, we need to use import.meta.url
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    return dirname(fileURLToPath(import.meta.url));
  }

  // Last resort: use process.cwd()
  return process.cwd();
}

/**
 * Find the package root directory by looking for package.json
 */
function findPackageRoot(): string {
  // Start from current module directory
  let currentDir = getCurrentModuleDir();

  // Walk up until we find package.json or reach root
  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  // Fallback to cwd if package.json not found
  return process.cwd();
}

/**
 * Load configuration from YAML file
 */
export function loadConfig(
  configPath?: string,
  environment?: 'production' | 'development' | 'test'
): Config {
  // Default config path - use package directory, not user's cwd
  // This ensures config is loaded from the installed package location
  const packageRoot = findPackageRoot();
  const defaultConfigPath = join(packageRoot, 'config', 'runtime.yaml');
  const finalPath = configPath || defaultConfigPath;

  try {
    // Load base configuration
    const fileContents = readFileSync(finalPath, 'utf8');
    const baseConfig = yaml.load(fileContents) as Config;

    // Determine environment
    const env = environment || process.env.NODE_ENV || 'development';

    // Apply environment-specific overrides
    let finalConfig = baseConfig;
    if (baseConfig.environments) {
      const envConfig =
        env === 'production'
          ? baseConfig.environments.production
          : env === 'test'
          ? baseConfig.environments.test
          : baseConfig.environments.development;

      if (envConfig) {
        // Debug: Check memory_cache before merge
        const beforeMerge = baseConfig.model?.memory_cache;
        finalConfig = deepMerge(baseConfig, envConfig);
        const afterMerge = finalConfig.model?.memory_cache;

        if (process.env.DEBUG_CONFIG_MERGE) {
          console.error('[Config DEBUG] Merge check:', {
            env,
            beforeEnabled: beforeMerge?.enabled,
            afterEnabled: afterMerge?.enabled,
            hasEnvModel: !!(envConfig as Partial<Config>).model,
          });
        }
      }
    }

    // Remove environments section from final config
    delete finalConfig.environments;

    return finalConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration file not found: ${finalPath}. ` +
        `Please ensure config/runtime.yaml exists in the project root.`
      );
    }
    throw new Error(`Failed to load configuration: ${error}`);
  }
}

/**
 * Validate configuration values
 */
export function validateConfig(config: Config): void {
  const parseResult = RuntimeConfigSchema.safeParse(config);
  if (!parseResult.success) {
    // Format all errors with field paths (match old format)
    const errors = parseResult.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `${field} ${issue.message}`;
    });

    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Global configuration instance
 */
let globalConfig: Config | null = null;

/**
 * Initialize global configuration
 */
export function initializeConfig(
  configPath?: string,
  environment?: 'production' | 'development' | 'test'
): Config {
  globalConfig = loadConfig(configPath, environment);
  validateConfig(globalConfig);
  return globalConfig;
}

/**
 * Get global configuration
 */
export function getConfig(): Config {
  if (!globalConfig) {
    globalConfig = initializeConfig();
  }
  return globalConfig;
}

/**
 * Reset global configuration (for testing)
 */
export function resetConfig(): void {
  globalConfig = null;
}

/**
 * Convert YAML cache config (snake_case) to CacheConfig interface (camelCase)
 */
export function getCacheConfig(): CacheConfig {
  const config = getConfig();

  return {
    enabled: config.cache.enabled,
    cacheDir: config.cache.cache_dir,
    maxSizeBytes: config.cache.max_size_bytes,
    maxAgeDays: config.cache.max_age_days,
    evictionPolicy: config.cache.eviction_policy,
    preloadModels: config.cache.preload_models,
    validateOnStartup: config.cache.validate_on_startup,
    enableCompression: config.cache.enable_compression,
  };
}

/**
 * Export configuration for backward compatibility
 * Maps YAML config to old defaults.ts structure
 */
export function getCompatibleConfig(): {
  PYTHON_RUNTIME: {
    DEFAULT_PYTHON_PATH: string;
    DEFAULT_RUNTIME_PATH: string;
    MAX_RESTARTS: number;
    STARTUP_TIMEOUT_MS: number;
    SHUTDOWN_TIMEOUT_MS: number;
    INIT_PROBE_DELAY_MS: number;
    RESTART_DELAY_BASE_MS: number;
  };
  JSON_RPC: {
    DEFAULT_TIMEOUT_MS: number;
    MAX_LINE_BUFFER_SIZE: number;
    MAX_PENDING_REQUESTS: number;
  };
  STREAM_REGISTRY: {
    DEFAULT_TIMEOUT_MS: number;
    MAX_ACTIVE_STREAMS: number;
    CLEANUP_INTERVAL_MS: number;
  };
  MODEL: {
    DEFAULT_CONTEXT_LENGTH: number;
    DEFAULT_QUANTIZATION: string;
  };
  PYTHON_BRIDGE: {
    MAX_BUFFER_SIZE: number;
    STREAM_QUEUE_SIZE: number;
    QUEUE_PUT_MAX_RETRIES: number;
    QUEUE_PUT_BACKOFF_MS: number;
  };
  PERFORMANCE: {
    AGGRESSIVE_GC: boolean;
    ENABLE_BATCHING: boolean;
    BATCH_SIZE: number;
    BATCH_TIMEOUT_MS: number;
    USE_MESSAGEPACK: boolean;
  };
  DEV: {
    VERBOSE: boolean;
    DEBUG: boolean;
    LOG_IPC: boolean;
  };
} {
  const config = getConfig();

  return {
    PYTHON_RUNTIME: {
      DEFAULT_PYTHON_PATH: config.python_runtime.python_path,
      DEFAULT_RUNTIME_PATH: config.python_runtime.runtime_path,
      MAX_RESTARTS: config.python_runtime.max_restarts,
      STARTUP_TIMEOUT_MS: config.python_runtime.startup_timeout_ms,
      SHUTDOWN_TIMEOUT_MS: config.python_runtime.shutdown_timeout_ms,
      INIT_PROBE_DELAY_MS: config.python_runtime.init_probe_fallback_ms,
      RESTART_DELAY_BASE_MS: config.python_runtime.restart_delay_base_ms,
    },
    JSON_RPC: {
      DEFAULT_TIMEOUT_MS: config.json_rpc.default_timeout_ms,
      MAX_LINE_BUFFER_SIZE: config.json_rpc.max_line_buffer_size,
      MAX_PENDING_REQUESTS: config.json_rpc.max_pending_requests,
    },
    STREAM_REGISTRY: {
      DEFAULT_TIMEOUT_MS: config.stream_registry.default_timeout_ms,
      MAX_ACTIVE_STREAMS: config.stream_registry.max_active_streams,
      CLEANUP_INTERVAL_MS: config.stream_registry.cleanup_interval_ms,
    },
    MODEL: {
      DEFAULT_CONTEXT_LENGTH: config.model.default_context_length,
      DEFAULT_QUANTIZATION: config.model.default_quantization,
    },
    PYTHON_BRIDGE: {
      MAX_BUFFER_SIZE: config.python_bridge.max_buffer_size,
      STREAM_QUEUE_SIZE: config.python_bridge.stream_queue_size,
      QUEUE_PUT_MAX_RETRIES: config.python_bridge.queue_put_max_retries,
      QUEUE_PUT_BACKOFF_MS: config.python_bridge.queue_put_backoff_ms,
    },
    PERFORMANCE: {
      AGGRESSIVE_GC: config.performance.aggressive_gc,
      ENABLE_BATCHING: config.performance.enable_batching,
      BATCH_SIZE: config.performance.batch_size,
      BATCH_TIMEOUT_MS: config.performance.batch_timeout_ms,
      USE_MESSAGEPACK: config.performance.use_messagepack,
    },
    DEV: {
      VERBOSE: config.development.verbose,
      DEBUG: config.development.debug,
      LOG_IPC: config.development.log_ipc,
    },
  } as const;
}
