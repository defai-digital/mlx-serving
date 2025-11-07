import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, validateConfig, initializeConfig, getConfig } from '../../../src/config/loader.js';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { Config } from '../../../src/config/loader.js';

describe('Config Loader', () => {
  const testConfigDir = join(process.cwd(), 'test-config-tmp');
  const testConfigPath = join(testConfigDir, 'test-runtime.yaml');

  const validConfig: Partial<Config> = {
    batch_queue: {
      enabled: true,
      max_batch_size: 20,
      flush_interval_ms: 2,
      adaptive_sizing: true,
      target_batch_time_ms: 10,
      priority_queue: true,
    },
    python_runtime: {
      python_path: 'python3',
      runtime_path: 'python/runtime.py',
      max_restarts: 3,
      startup_timeout_ms: 5000,
      shutdown_timeout_ms: 3000,
      init_probe_fallback_ms: 100,
      restart_delay_base_ms: 1000,
    },
    json_rpc: {
      default_timeout_ms: 30000,
      max_line_buffer_size: 10485760,
      max_pending_requests: 100,
      retry: {
        max_attempts: 3,
        initial_delay_ms: 100,
        max_delay_ms: 5000,
        backoff_multiplier: 2,
        retryable_errors: ['ECONNRESET', 'ETIMEDOUT'],
        jitter: 0.1,
      },
      circuit_breaker: {
        failure_threshold: 5,
        recovery_timeout_ms: 30000,
        half_open_max_calls: 3,
        half_open_success_threshold: 2,
        failure_window_ms: 60000,
      },
    },
    stream_registry: {
      default_timeout_ms: 30000,
      max_active_streams: 10,
      cleanup_interval_ms: 5000,
      adaptive_limits: {
        enabled: false,
        min_streams: 5,
        max_streams: 50,
        target_ttft_ms: 1000,
        target_latency_ms: 100,
        adjustment_interval_ms: 5000,
        scale_up_threshold: 0.8,
        scale_down_threshold: 0.3,
      },
      chunk_pooling: {
        enabled: false,
        pool_size: 1000,
        pool_cleanup_interval_ms: 30000,
      },
      backpressure: {
        enabled: false,
        max_unacked_chunks: 100,
        ack_timeout_ms: 5000,
        slow_consumer_threshold_ms: 1000,
      },
      metrics: {
        enabled: false,
        track_ttft: true,
        track_throughput: true,
        track_cancellations: true,
        export_interval_ms: 10000,
      },
    },
    model: {
      default_context_length: 2048,
      default_max_tokens: 512,
      max_loaded_models: 3,
      supported_dtypes: ['float16', 'float32', 'int8', 'int4'],
      default_quantization: 'none',
      default_dtype: 'float16',
      trusted_model_directories: null,
      max_generation_tokens: 4096,
      max_temperature: 2.0,
      memory_cache: {
        enabled: true,
        max_cached_models: 5,
        eviction_strategy: 'lru',
        warmup_on_start: [],
        track_stats: true,
      },
    },
    cache: {
      enabled: false,
      cache_dir: '.kr-mlx-cache',
      max_size_bytes: 107374182400,
      max_age_days: 30,
      eviction_policy: 'lru',
      preload_models: [],
      validate_on_startup: false,
      enable_compression: false,
    },
    python_bridge: {
      max_buffer_size: 10485760,
      stream_queue_size: 1000,
      queue_put_max_retries: 3,
      queue_put_backoff_ms: 10,
    },
    outlines: {
      max_schema_size_bytes: 1048576,
    },
    performance: {
      aggressive_gc: false,
      enable_batching: true,
      batch_size: 10,
      batch_timeout_ms: 100,
      use_messagepack: false,
    },
    telemetry: {
      enabled: false,
      service_name: 'kr-serve-mlx',
      prometheus_port: 9464,
      export_interval_ms: 10000,
    },
    development: {
      verbose: false,
      debug: false,
      log_ipc: false,
      enable_profiling: false,
    },
  };

  beforeEach(() => {
    // Create test config directory
    try {
      mkdirSync(testConfigDir, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }
  });

  afterEach(() => {
    // Clean up test config
    try {
      unlinkSync(testConfigPath);
    } catch (err) {
      // File might not exist
    }
    try {
      rmdirSync(testConfigDir);
    } catch (err) {
      // Directory might not be empty or not exist
    }
  });

  describe('loadConfig', () => {
    it('should load valid configuration from YAML file', () => {
      writeFileSync(testConfigPath, yaml.dump(validConfig));

      const config = loadConfig(testConfigPath);

      expect(config).toBeDefined();
      expect(config.batch_queue.enabled).toBe(true);
      expect(config.batch_queue.max_batch_size).toBe(20);
      expect(config.python_runtime.max_restarts).toBe(3);
    });

    it('should throw error for non-existent config file', () => {
      const nonExistentPath = join(testConfigDir, 'non-existent.yaml');

      expect(() => loadConfig(nonExistentPath)).toThrow('Configuration file not found');
      expect(() => loadConfig(nonExistentPath)).toThrow(nonExistentPath);
    });

    it('should throw error for invalid YAML syntax', () => {
      writeFileSync(testConfigPath, 'invalid: yaml: syntax: [[[');

      expect(() => loadConfig(testConfigPath)).toThrow('Failed to load configuration');
    });

    it('should apply environment-specific overrides (production)', () => {
      const configWithEnv = {
        ...validConfig,
        development: {
          verbose: true, // Base config
          debug: false,
          log_ipc: false,
          enable_profiling: false,
        },
        environments: {
          production: {
            development: {
              verbose: false, // Override for production
              debug: false,
              log_ipc: false,
              enable_profiling: false,
            },
            telemetry: {
              enabled: true,
              service_name: 'kr-serve-mlx-prod',
              prometheus_port: 9464,
              export_interval_ms: 10000,
            },
          },
        },
      };

      writeFileSync(testConfigPath, yaml.dump(configWithEnv));

      const config = loadConfig(testConfigPath, 'production');

      expect(config.development.verbose).toBe(false); // Overridden
      expect(config.telemetry.enabled).toBe(true); // Overridden
      expect(config.telemetry.service_name).toBe('kr-serve-mlx-prod'); // Overridden
      expect(config.environments).toBeUndefined(); // Removed from final config
    });

    it('should apply environment-specific overrides (test)', () => {
      const configWithEnv = {
        ...validConfig,
        python_runtime: {
          ...validConfig.python_runtime!,
          startup_timeout_ms: 5000,
        },
        environments: {
          test: {
            python_runtime: {
              startup_timeout_ms: 1000, // Faster for tests
            },
          },
        },
      };

      writeFileSync(testConfigPath, yaml.dump(configWithEnv));

      const config = loadConfig(testConfigPath, 'test');

      expect(config.python_runtime.startup_timeout_ms).toBe(1000); // Overridden
    });

    it('should use development environment when explicitly specified', () => {
      const configWithEnv = {
        ...validConfig,
        development: {
          verbose: false,
          debug: false,
          log_ipc: false,
          enable_profiling: false,
        },
        environments: {
          development: {
            development: {
              verbose: true, // Override for development
              debug: true,
              log_ipc: true,
              enable_profiling: false,
            },
          },
        },
      };

      writeFileSync(testConfigPath, yaml.dump(configWithEnv));

      // Explicitly specify development environment
      const config = loadConfig(testConfigPath, 'development');

      expect(config.development.verbose).toBe(true);
      expect(config.development.debug).toBe(true);
    });

    it('should handle missing environment overrides gracefully', () => {
      const configWithEnv = {
        ...validConfig,
        environments: {
          production: {
            telemetry: {
              enabled: true,
            },
          },
        },
      };

      writeFileSync(testConfigPath, yaml.dump(configWithEnv));

      // Request test environment but only production override exists
      const config = loadConfig(testConfigPath, 'test');

      // Should just use base config
      expect(config.telemetry.enabled).toBe(false); // Base config value
    });
  });

  describe('validateConfig', () => {
    it('should pass validation for valid config', () => {
      expect(() => validateConfig(validConfig as Config)).not.toThrow();
    });

    it('should reject startup_timeout_ms < 1000ms', () => {
      const invalidConfig = {
        ...validConfig,
        python_runtime: {
          ...validConfig.python_runtime!,
          startup_timeout_ms: 500, // Too low
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'python_runtime.startup_timeout_ms must be >= 1000ms'
      );
    });

    it('should reject negative max_restarts', () => {
      const invalidConfig = {
        ...validConfig,
        python_runtime: {
          ...validConfig.python_runtime!,
          max_restarts: -1, // Negative
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'python_runtime.max_restarts must be >= 0'
      );
    });

    it('should reject buffer size < 1024 bytes', () => {
      const invalidConfig = {
        ...validConfig,
        python_bridge: {
          ...validConfig.python_bridge!,
          max_buffer_size: 512, // Too small
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'python_bridge.max_buffer_size must be >= 1024 bytes'
      );
    });

    it('should reject max_active_streams < 1', () => {
      const invalidConfig = {
        ...validConfig,
        stream_registry: {
          ...validConfig.stream_registry!,
          max_active_streams: 0, // Too low
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'stream_registry.max_active_streams must be >= 1'
      );
    });

    it('should reject max_delay_ms < initial_delay_ms', () => {
      const invalidConfig = {
        ...validConfig,
        json_rpc: {
          ...validConfig.json_rpc!,
          retry: {
            ...validConfig.json_rpc!.retry,
            initial_delay_ms: 1000,
            max_delay_ms: 500, // Less than initial
          },
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'json_rpc.retry.max_delay_ms must be >= initial_delay_ms'
      );
    });

    it('should reject backoff_multiplier < 1', () => {
      const invalidConfig = {
        ...validConfig,
        json_rpc: {
          ...validConfig.json_rpc!,
          retry: {
            ...validConfig.json_rpc!.retry,
            backoff_multiplier: 0.5, // Too low
          },
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'json_rpc.retry.backoff_multiplier must be >= 1'
      );
    });

    it('should reject circuit_breaker failure_threshold < 1', () => {
      const invalidConfig = {
        ...validConfig,
        json_rpc: {
          ...validConfig.json_rpc!,
          circuit_breaker: {
            ...validConfig.json_rpc!.circuit_breaker,
            failure_threshold: 0, // Too low
          },
        },
      };

      expect(() => validateConfig(invalidConfig as Config)).toThrow(
        'json_rpc.circuit_breaker.failure_threshold must be >= 1'
      );
    });

    it('should accumulate multiple validation errors', () => {
      const invalidConfig = {
        ...validConfig,
        python_runtime: {
          ...validConfig.python_runtime!,
          startup_timeout_ms: 500, // Error 1
          max_restarts: -1, // Error 2
        },
        stream_registry: {
          ...validConfig.stream_registry!,
          max_active_streams: 0, // Error 3
        },
      };

      try {
        validateConfig(invalidConfig as Config);
        expect.fail('Should have thrown validation error');
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain('startup_timeout_ms');
        expect(error.message).toContain('max_restarts');
        expect(error.message).toContain('max_active_streams');
      }
    });
  });

  describe('initializeConfig', () => {
    it('should initialize and validate config', () => {
      writeFileSync(testConfigPath, yaml.dump(validConfig));

      const config = initializeConfig(testConfigPath);

      expect(config).toBeDefined();
      expect(config.batch_queue.enabled).toBe(true);
    });

    it('should reject invalid config during initialization', () => {
      const invalidConfig = {
        ...validConfig,
        python_runtime: {
          ...validConfig.python_runtime!,
          startup_timeout_ms: 500,
        },
      };

      writeFileSync(testConfigPath, yaml.dump(invalidConfig));

      expect(() => initializeConfig(testConfigPath)).toThrow('startup_timeout_ms');
    });
  });

  describe('getConfig', () => {
    it('should initialize config on first access if not initialized', () => {
      // Uses default config path, which should exist
      const config = getConfig();

      expect(config).toBeDefined();
      expect(config.batch_queue).toBeDefined();
      expect(config.python_runtime).toBeDefined();
    });
  });
});
