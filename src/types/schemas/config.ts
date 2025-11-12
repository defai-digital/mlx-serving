/**
 * Runtime Configuration Schemas
 *
 * Zod schemas for validating runtime.yaml configuration.
 * Covers all 60+ properties across 11 sections with cross-field validation.
 *
 * @module schemas/config
 */

import { z } from 'zod';

/**
 * Batch Queue Configuration
 */
export const BatchQueueConfigSchema = z.object({
  enabled: z.boolean(),
  max_batch_size: z.number().int().positive('Max batch size must be positive'),
  flush_interval_ms: z.number().int().positive('Flush interval must be positive'),
  adaptive_sizing: z.boolean().optional(),
  target_batch_time_ms: z.number().int().positive('Target batch time must be positive').optional(),
  priority_queue: z.boolean().optional(),
});

/**
 * Python Runtime Configuration
 */
export const PythonRuntimeConfigSchema = z.object({
  python_path: z.string().min(1, 'Python path cannot be empty'),
  runtime_path: z.string().min(1, 'Runtime path cannot be empty'),
  max_restarts: z.number().int().min(0, 'must be >= 0'),
  startup_timeout_ms: z.number().int().min(1000, 'must be >= 1000ms'),
  shutdown_timeout_ms: z.number().int().positive('must be positive'),
  init_probe_fallback_ms: z.number().int().positive('must be positive'),
  restart_delay_base_ms: z.number().int().positive('must be positive'),
});

/**
 * JSON-RPC Retry Configuration
 */
export const JsonRpcRetryConfigSchema = z.object({
  max_attempts: z.number().int().min(1, 'must be >= 1'),
  initial_delay_ms: z.number().int().min(0, 'must be >= 0'),
  max_delay_ms: z.number().int().positive('must be positive'),
  backoff_multiplier: z.number().min(1, 'must be >= 1'),
  retryable_errors: z.array(z.string()),
  jitter: z.number().min(0).max(1).optional(),
}).refine(
  (data) => data.max_delay_ms >= data.initial_delay_ms,
  {
    message: 'must be >= initial_delay_ms',
    path: ['max_delay_ms'],
  }
);

/**
 * JSON-RPC Circuit Breaker Configuration
 */
export const JsonRpcCircuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().int().min(1, 'must be >= 1'),
  recovery_timeout_ms: z.number().int().positive('must be positive'),
  half_open_max_calls: z.number().int().min(1, 'must be >= 1'),
  half_open_success_threshold: z.number().int().min(1, 'must be >= 1'),
  failure_window_ms: z.number().int().positive('must be positive').optional(),
});

/**
 * JSON-RPC Configuration
 */
export const JsonRpcConfigSchema = z.object({
  default_timeout_ms: z.number().int().positive('Default timeout must be positive'),
  max_line_buffer_size: z.number().int().positive('Max line buffer size must be positive'),
  max_pending_requests: z.number().int().positive('Max pending requests must be positive'),
  retry: JsonRpcRetryConfigSchema,
  circuit_breaker: JsonRpcCircuitBreakerConfigSchema,
});

/**
 * Stream Registry Adaptive Limits Configuration
 */
export const AdaptiveLimitsConfigSchema = z.object({
  enabled: z.boolean(),
  min_streams: z.number().int().positive('Min streams must be positive'),
  max_streams: z.number().int().positive('Max streams must be positive'),
  target_ttft_ms: z.number().int().positive('Target TTFT must be positive'),
  target_latency_ms: z.number().int().positive('Target latency must be positive'),
  adjustment_interval_ms: z.number().int().positive('Adjustment interval must be positive'),
  scale_up_threshold: z.number().min(0).max(1, 'Scale up threshold must be 0-1'),
  scale_down_threshold: z.number().min(0).max(1, 'Scale down threshold must be 0-1'),
}).refine(
  (data) => data.max_streams >= data.min_streams,
  {
    message: 'max_streams must be >= min_streams',
    path: ['max_streams'],
  }
);

/**
 * Stream Registry Chunk Pooling Configuration
 */
export const ChunkPoolingConfigSchema = z.object({
  enabled: z.boolean(),
  pool_size: z.number().int().positive('Pool size must be positive'),
  pool_cleanup_interval_ms: z.number().int().positive('Pool cleanup interval must be positive'),
});

/**
 * Stream Registry Backpressure Configuration
 */
export const BackpressureConfigSchema = z.object({
  enabled: z.boolean(),
  max_unacked_chunks: z.number().int().positive('Max unacked chunks must be positive'),
  ack_timeout_ms: z.number().int().positive('Ack timeout must be positive'),
  slow_consumer_threshold_ms: z.number().int().positive('Slow consumer threshold must be positive'),
});

/**
 * Stream Registry Metrics Configuration
 */
export const StreamMetricsConfigSchema = z.object({
  enabled: z.boolean(),
  track_ttft: z.boolean(),
  track_throughput: z.boolean(),
  track_cancellations: z.boolean(),
  export_interval_ms: z.number().int().positive('Export interval must be positive'),
});

/**
 * Stream Registry Configuration
 */
export const StreamRegistryConfigSchema = z.object({
  default_timeout_ms: z.number().int().positive('must be positive'),
  max_active_streams: z.number().int().min(1, 'must be >= 1'),
  cleanup_interval_ms: z.number().int().positive('must be positive'),
  adaptive_limits: AdaptiveLimitsConfigSchema,
  chunk_pooling: ChunkPoolingConfigSchema,
  backpressure: BackpressureConfigSchema,
  metrics: StreamMetricsConfigSchema,
});

const TenantBudgetSchema = z.object({
  tenant_id: z.string().optional(),
  hard_limit: z.number().int().positive('Hard limit must be positive'),
  burst_limit: z.number().int().positive('Burst limit must be positive'),
  decay_ms: z.number().int().positive('Decay must be positive'),
});

const AdaptiveGovernorPidSchema = z.object({
  kp: z.number(),
  ki: z.number(),
  kd: z.number(),
  integral_saturation: z.number().int().positive('Integral saturation must be positive'),
  sample_interval_ms: z.number().int().positive('Sample interval must be positive'),
});

const AdaptiveGovernorCleanupSchema = z.object({
  sweep_interval_ms: z.number().int().positive('Sweep interval must be positive'),
  max_stale_lifetime_ms: z.number().int().positive('Max stale lifetime must be positive'),
});

export const AdaptiveGovernorConfigSchema = z
  .object({
    enabled: z.boolean(),
    target_ttft_ms: z.number().int().positive('Target TTFT must be positive'),
    max_concurrent: z.number().int().positive('Max concurrent must be positive'),
    min_concurrent: z.number().int().positive('Min concurrent must be positive'),
    pid: AdaptiveGovernorPidSchema,
    cleanup: AdaptiveGovernorCleanupSchema,
    tenant_budgets: z.record(TenantBudgetSchema),
  })
  .refine(
    (data) => data.max_concurrent >= data.min_concurrent,
    {
      message: 'max_concurrent must be >= min_concurrent',
      path: ['max_concurrent'],
    }
  );

/**
 * Model Memory Cache Configuration
 */
export const ModelMemoryCacheConfigSchema = z.object({
  enabled: z.boolean(),
  max_cached_models: z.number().int().positive('Max cached models must be positive'),
  eviction_strategy: z.literal('lru'),
  warmup_on_start: z.array(z.string()),
  track_stats: z.boolean(),
});

/**
 * Model Configuration
 */
export const ModelConfigSchema = z.object({
  default_context_length: z.number().int().positive('Default context length must be positive'),
  default_max_tokens: z.number().int().positive('Default max tokens must be positive'),
  max_loaded_models: z.number().int().positive('Max loaded models must be positive'),
  supported_dtypes: z.array(z.string()),
  default_quantization: z.enum(['none', 'int8', 'int4']),
  default_dtype: z.string().min(1, 'Default dtype cannot be empty'),
  trusted_model_directories: z.array(z.string()).nullable(),
  max_generation_tokens: z.number().int().positive('Max generation tokens must be positive'),
  max_temperature: z.number().min(0, 'Max temperature must be >= 0'),
  memory_cache: ModelMemoryCacheConfigSchema,
});

/**
 * Cache Configuration
 */
export const CacheConfigSchema = z.object({
  enabled: z.boolean(),
  cache_dir: z.string().min(1, 'Cache dir cannot be empty'),
  max_size_bytes: z.number().int().positive('Max size bytes must be positive'),
  max_age_days: z.number().int().positive('Max age days must be positive'),
  eviction_policy: z.enum(['lru', 'lfu', 'fifo']),
  preload_models: z.array(z.string()),
  validate_on_startup: z.boolean(),
  enable_compression: z.boolean(),
});

/**
 * Python Bridge Configuration
 */
export const PythonBridgeConfigSchema = z.object({
  max_buffer_size: z.number().int().min(1024, 'must be >= 1024 bytes'),
  stream_queue_size: z.number().int().positive('must be positive'),
  queue_put_max_retries: z.number().int().min(0, 'must be >= 0'),
  queue_put_backoff_ms: z.number().int().positive('must be positive'),
});

/**
 * Outlines Configuration
 */
export const OutlinesConfigSchema = z.object({
  max_schema_size_bytes: z.number().int().positive('Max schema size bytes must be positive'),
});

/**
 * Performance Configuration
 */
export const PerformanceConfigSchema = z.object({
  aggressive_gc: z.boolean(),
  enable_batching: z.boolean(),
  batch_size: z.number().int().positive('Batch size must be positive'),
  batch_timeout_ms: z.number().int().positive('Batch timeout must be positive'),
  use_messagepack: z.boolean(),
});

/**
 * Telemetry Configuration
 */
export const TelemetryConfigSchema = z.object({
  enabled: z.boolean(),
  service_name: z.string().min(1, 'Service name cannot be empty'),
  prometheus_port: z.number().int().min(1024, 'Prometheus port must be >= 1024').max(65535, 'Prometheus port must be <= 65535'),
  export_interval_ms: z.number().int().positive('Export interval must be positive'),
});

/**
 * Development Configuration
 */
export const DevelopmentConfigSchema = z.object({
  verbose: z.boolean(),
  debug: z.boolean(),
  log_ipc: z.boolean(),
  enable_profiling: z.boolean(),
});

/**
 * Runtime Configuration Schema (Base)
 *
 * Defines the complete structure for runtime.yaml
 */
const RuntimeConfigSchemaBase = z.object({
  batch_queue: BatchQueueConfigSchema,
  python_runtime: PythonRuntimeConfigSchema,
  json_rpc: JsonRpcConfigSchema,
  stream_registry: StreamRegistryConfigSchema,
  streaming: z
    .object({
      phase4: z
        .object({
          adaptive_governor: AdaptiveGovernorConfigSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  model: ModelConfigSchema,
  cache: CacheConfigSchema,
  python_bridge: PythonBridgeConfigSchema,
  outlines: OutlinesConfigSchema,
  performance: PerformanceConfigSchema,
  telemetry: TelemetryConfigSchema,
  development: DevelopmentConfigSchema,
});

/**
 * Runtime Configuration Schema with Environments
 *
 * Supports recursive environment overrides using z.lazy()
 */
export const RuntimeConfigSchema: z.ZodType<{
  batch_queue: z.infer<typeof BatchQueueConfigSchema>;
  python_runtime: z.infer<typeof PythonRuntimeConfigSchema>;
  json_rpc: z.infer<typeof JsonRpcConfigSchema>;
  stream_registry: z.infer<typeof StreamRegistryConfigSchema>;
  model: z.infer<typeof ModelConfigSchema>;
  cache: z.infer<typeof CacheConfigSchema>;
  python_bridge: z.infer<typeof PythonBridgeConfigSchema>;
  outlines: z.infer<typeof OutlinesConfigSchema>;
  performance: z.infer<typeof PerformanceConfigSchema>;
  telemetry: z.infer<typeof TelemetryConfigSchema>;
  development: z.infer<typeof DevelopmentConfigSchema>;
  environments?: {
    production?: Partial<z.infer<typeof RuntimeConfigSchemaBase>>;
    development?: Partial<z.infer<typeof RuntimeConfigSchemaBase>>;
    test?: Partial<z.infer<typeof RuntimeConfigSchemaBase>>;
  };
}> = RuntimeConfigSchemaBase.extend({
  environments: z.object({
    production: z.lazy(() => RuntimeConfigSchemaBase.partial()).optional(),
    development: z.lazy(() => RuntimeConfigSchemaBase.partial()).optional(),
    test: z.lazy(() => RuntimeConfigSchemaBase.partial()).optional(),
  }).optional(),
});

/**
 * Type inference for RuntimeConfig
 */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
