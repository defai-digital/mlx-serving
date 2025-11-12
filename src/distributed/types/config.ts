/**
 * Configuration types for distributed inference system
 *
 * All configuration types are defined with Zod schemas for runtime validation.
 */

import { z } from 'zod';

// ============================================================================
// NATS Client Options
// ============================================================================

/**
 * NATS client connection options
 */
export const NatsClientOptionsSchema = z.object({
  /** Connection mode */
  mode: z.enum(['embedded', 'external']),
  /** Server URL (required for external mode) */
  serverUrl: z.string().url().optional(),
  /** Username for authentication */
  user: z.string().optional(),
  /** Password for authentication */
  password: z.string().optional(),
  /** Enable automatic reconnection */
  reconnect: z.boolean().default(true),
  /** Maximum reconnection attempts */
  maxReconnectAttempts: z.number().int().positive().default(10),
  /** Wait time between reconnection attempts (ms) */
  reconnectTimeWait: z.number().int().positive().default(2000),
});

export type NatsClientOptions = z.infer<typeof NatsClientOptionsSchema>;

// ============================================================================
// Embedded Server Options
// ============================================================================

/**
 * Embedded NATS server options
 */
export const EmbeddedServerOptionsSchema = z.object({
  /** NATS server port */
  port: z.number().int().min(1024).max(65535).default(4222),
  /** HTTP monitoring port */
  httpPort: z.number().int().min(1024).max(65535).default(8222),
  /** JetStream configuration */
  jetstream: z.object({
    /** Enable JetStream */
    enabled: z.boolean().default(false),
    /** JetStream store directory */
    storeDir: z.string().default('.nats/jetstream'),
  }).optional(),
  /** Log level for NATS server */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type EmbeddedServerOptions = z.infer<typeof EmbeddedServerOptionsSchema>;

// ============================================================================
// Cluster Configuration
// ============================================================================

/**
 * NATS configuration
 */
export const NatsConfigSchema = z.object({
  /** NATS mode (embedded or external) */
  mode: z.enum(['embedded', 'external']).default('embedded'),
  /** External server URL */
  serverUrl: z.string().url().optional(),
  /** Username for authentication */
  user: z.string().optional(),
  /** Password for authentication */
  password: z.string().optional(),
  /** Embedded server settings */
  embedded: EmbeddedServerOptionsSchema.optional(),
  /** Enable automatic reconnection */
  reconnect: z.boolean().default(true),
  /** Maximum reconnection attempts */
  maxReconnectAttempts: z.number().int().positive().default(10),
  /** Wait time between reconnection attempts (ms) */
  reconnectTimeWait: z.number().int().positive().default(2000),
});

export type NatsConfig = z.infer<typeof NatsConfigSchema>;

/**
 * Controller configuration
 */
export const ControllerConfigSchema = z.object({
  /** Enable controller mode */
  enabled: z.boolean().default(false),
  /** Bind address */
  bindAddress: z.string().default('0.0.0.0'),
  /** Controller port */
  port: z.number().int().min(1024).max(65535).default(8080),
  /** Dashboard port */
  dashboardPort: z.number().int().min(1024).max(65535).default(8081),
});

export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

/**
 * Pre-warm model configuration
 */
export const PreWarmModelConfigSchema = z.object({
  /** Model ID */
  model: z.string(),
  /** Priority (high, medium, low) */
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type PreWarmModelConfig = z.infer<typeof PreWarmModelConfigSchema>;

/**
 * Pre-warming configuration
 */
export const PreWarmConfigSchema = z.object({
  /** Enable pre-warming */
  enabled: z.boolean().default(false),
  /** Models to pre-warm */
  models: z.array(PreWarmModelConfigSchema).default([]),
  /** Timeout per model (ms) */
  timeoutPerModelMs: z.number().int().positive().default(30000),
  /** Warm models in parallel */
  parallel: z.boolean().default(false),
  /** When to register worker (warming = register immediately, complete = wait for pre-warming) */
  registerWhen: z.enum(['warming', 'complete']).default('warming'),
});

export type PreWarmConfig = z.infer<typeof PreWarmConfigSchema>;

/**
 * Resource limits configuration (Week 4)
 */
export const ResourceLimitsConfigSchema = z.object({
  /** Enable resource management */
  enabled: z.boolean().default(false),
  /** Soft memory limit in GB (start rejecting low priority requests) */
  softMemoryLimitGB: z.number().positive().default(8),
  /** Hard memory limit in GB (reject all new requests) */
  hardMemoryLimitGB: z.number().positive().default(10),
  /** Memory check interval in ms */
  checkIntervalMs: z.number().int().positive().default(5000),
});

export type ResourceLimitsConfig = z.infer<typeof ResourceLimitsConfigSchema>;

/**
 * Request queue configuration (Week 4)
 */
export const RequestQueueConfigSchema = z.object({
  /** Enable request queueing */
  enabled: z.boolean().default(false),
  /** Maximum queue depth */
  maxDepth: z.number().int().positive().default(100),
  /** Reject requests when queue is full (vs drop low priority) */
  rejectWhenFull: z.boolean().default(true),
  /** Number of priority levels (2-5) */
  priorityLevels: z.number().int().min(2).max(5).default(3),
});

export type RequestQueueConfig = z.infer<typeof RequestQueueConfigSchema>;

/**
 * Continuous batching configuration (Week 4)
 */
export const ContinuousBatchingConfigSchema = z.object({
  /** Enable continuous batching */
  enabled: z.boolean().default(false),
  /** Minimum batch size */
  minBatchSize: z.number().int().min(1).default(1),
  /** Maximum batch size */
  maxBatchSize: z.number().int().min(1).max(32).default(8),
  /** Batch formation timeout in ms */
  batchTimeoutMs: z.number().int().positive().default(50),
  /** Enable adaptive timeout based on queue depth */
  adaptiveTimeout: z.boolean().default(true),
});

export type ContinuousBatchingConfig = z.infer<typeof ContinuousBatchingConfigSchema>;

/**
 * Worker configuration
 */
export const WorkerConfigSchema = z.object({
  /** Worker port */
  port: z.number().int().min(1024).max(65535).default(8080),
  /** Worker ID (auto-generated if not provided) */
  workerId: z.string().uuid().optional(),
  /** Pre-warming configuration */
  preWarming: PreWarmConfigSchema.optional(),
  /** Resource limits configuration (Week 4) */
  resourceLimits: ResourceLimitsConfigSchema.optional(),
  /** Request queue configuration (Week 4) */
  requestQueue: RequestQueueConfigSchema.optional(),
  /** Continuous batching configuration (Week 4) */
  continuousBatching: ContinuousBatchingConfigSchema.optional(),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Discovery configuration
 */
export const DiscoveryConfigSchema = z.object({
  /** Controller IP address for workers to discover */
  controllerIp: z.string().ip().optional(),
  /** Enable discovery */
  enabled: z.boolean().default(true),
  /** Heartbeat interval (ms) */
  heartbeatIntervalMs: z.number().int().positive().default(5000),
  /** Offline timeout (ms) */
  offlineTimeoutMs: z.number().int().positive().default(15000),
});

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/**
 * Static worker configuration
 */
export const StaticWorkerSchema = z.object({
  /** Worker ID (optional, will be generated if not provided) */
  workerId: z.string().optional(),
  /** Worker URL (e.g., http://localhost:8080) */
  url: z.string().url(),
  /** Worker IP address (optional, parsed from URL if not provided) */
  ip: z.string().ip().optional(),
  /** Worker port (optional, parsed from URL if not provided) */
  port: z.number().int().min(1024).max(65535).optional(),
  /** Worker name (optional) */
  name: z.string().optional(),
  /** Worker priority (0-100) */
  priority: z.number().int().min(0).max(100).default(50),
});

export type StaticWorker = z.infer<typeof StaticWorkerSchema>;

/**
 * Workers configuration
 */
export const WorkersConfigSchema = z.object({
  /** Static workers (pre-configured) */
  static: z.array(StaticWorkerSchema).default([]),
});

export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;

/**
 * Session affinity configuration
 */
export const SessionAffinityConfigSchema = z.object({
  /** Enable session affinity */
  enabled: z.boolean().default(false),
  /** Session TTL (ms) */
  ttlMs: z.number().int().positive().default(1800000), // 30 minutes
  /** Cleanup interval (ms) */
  cleanupIntervalMs: z.number().int().positive().default(60000), // 1 minute
});

export type SessionAffinityConfig = z.infer<typeof SessionAffinityConfigSchema>;

/**
 * Circuit breaker configuration
 */
export const CircuitBreakerConfigSchema = z.object({
  /** Enable circuit breaker */
  enabled: z.boolean().default(false),
  /** Number of failures before opening circuit */
  failureThreshold: z.number().int().positive().default(5),
  /** Number of successes to close circuit from half-open */
  successThreshold: z.number().int().positive().default(2),
  /** Time to wait before trying half-open (ms) */
  timeoutMs: z.number().int().positive().default(30000),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Retry configuration
 */
export const RetryConfigSchema = z.object({
  /** Enable retry */
  enabled: z.boolean().default(false),
  /** Maximum number of retries */
  maxRetries: z.number().int().min(0).max(10).default(2),
  /** Initial retry delay (ms) */
  retryDelayMs: z.number().int().positive().default(100),
  /** Error codes that trigger retry */
  retryOnErrors: z.array(z.string()).default(['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'WORKER_OVERLOADED']),
});

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

/**
 * Request routing configuration
 */
export const RequestRoutingConfigSchema = z.object({
  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfigSchema.default({
    enabled: false,
    failureThreshold: 5,
    successThreshold: 2,
    timeoutMs: 30000,
  }),
  /** Retry configuration */
  retry: RetryConfigSchema.default({
    enabled: false,
    maxRetries: 2,
    retryDelayMs: 100,
    retryOnErrors: ['WORKER_TIMEOUT', 'WORKER_UNAVAILABLE', 'WORKER_OVERLOADED'],
  }),
  /** Standard request timeout (ms) */
  timeoutMs: z.number().int().positive().default(30000),
  /** Streaming request timeout (ms) */
  streamingTimeoutMs: z.number().int().positive().default(60000),
});

export type RequestRoutingConfig = z.infer<typeof RequestRoutingConfigSchema>;

/**
 * Load balancing configuration
 */
export const LoadBalancingConfigSchema = z.object({
  /** Load balancing strategy */
  strategy: z.enum(['round_robin', 'least_loaded', 'smart']).default('smart'),
  /** Enable sticky sessions (deprecated, use sessionAffinity) */
  stickySession: z.boolean().default(false),
  /** Session affinity configuration */
  sessionAffinity: SessionAffinityConfigSchema.optional(),
});

export type LoadBalancingConfig = z.infer<typeof LoadBalancingConfigSchema>;

/**
 * Logging configuration
 */
export const LoggingConfigSchema = z.object({
  /** Log level */
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Log format */
  format: z.enum(['json', 'text']).default('json'),
  /** Log file path */
  file: z.string().optional(),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Complete cluster configuration
 */
export const ClusterConfigSchema = z.object({
  /** Node mode */
  mode: z.enum(['controller', 'worker', 'both']).default('both'),
  /** NATS configuration */
  nats: NatsConfigSchema,
  /** Controller configuration */
  controller: ControllerConfigSchema.optional(),
  /** Worker configuration */
  worker: WorkerConfigSchema.optional(),
  /** Discovery configuration */
  discovery: DiscoveryConfigSchema,
  /** Static workers configuration */
  workers: WorkersConfigSchema.default({ static: [] }),
  /** Load balancing configuration */
  loadBalancing: LoadBalancingConfigSchema.default({
    strategy: 'smart',
    stickySession: false,
  }),
  /** Request routing configuration (circuit breaker, retry, timeout) */
  requestRouting: RequestRoutingConfigSchema.optional(),
  /** Logging configuration */
  logging: LoggingConfigSchema.default({
    level: 'info',
    format: 'json',
  }),
});

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate cluster configuration
 *
 * @param data - Raw configuration data
 * @returns Validated ClusterConfig
 * @throws {z.ZodError} if validation fails
 */
export function validateClusterConfig(data: unknown): ClusterConfig {
  return ClusterConfigSchema.parse(data);
}

/**
 * Create default cluster configuration
 *
 * @returns Default ClusterConfig
 */
export function createDefaultClusterConfig(): ClusterConfig {
  return ClusterConfigSchema.parse({
    mode: 'both',
    nats: {
      mode: 'embedded',
      embedded: {
        port: 4222,
        httpPort: 8222,
        logLevel: 'info',
      },
    },
    discovery: {
      enabled: true,
      heartbeatIntervalMs: 5000,
      offlineTimeoutMs: 15000,
    },
  });
}
