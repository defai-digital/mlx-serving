/**
 * Default Configuration Constants
 *
 * All magic numbers and hardcoded values centralized here for easy tuning.
 * Performance-critical values are exposed for runtime configuration.
 */

/**
 * Python Runtime Configuration
 */
export const PYTHON_RUNTIME = {
  /** Default Python executable path */
  DEFAULT_PYTHON_PATH: '.mlx-serving-venv/bin/python',

  /** Default runtime script path */
  DEFAULT_RUNTIME_PATH: 'python/runtime.py',

  /** Maximum process restart attempts before giving up */
  MAX_RESTARTS: 3,

  /** Process startup timeout (ms) */
  STARTUP_TIMEOUT_MS: 30_000, // 30 seconds

  /** Graceful shutdown timeout (ms) */
  SHUTDOWN_TIMEOUT_MS: 5_000, // 5 seconds

  /** Initial delay for Python process initialization (ms) */
  INIT_PROBE_DELAY_MS: 500, // 0.5 seconds

  /** Exponential backoff base for restart delays (ms) */
  RESTART_DELAY_BASE_MS: 1_000, // 1 second per attempt
} as const;

/**
 * JSON-RPC Transport Configuration
 */
export const JSON_RPC = {
  /** Default request timeout (ms) */
  DEFAULT_TIMEOUT_MS: 30_000, // 30 seconds

  /** Maximum line buffer size for incomplete JSON (bytes) */
  MAX_LINE_BUFFER_SIZE: 64_000, // 64KB

  /** Maximum pending requests before applying backpressure */
  MAX_PENDING_REQUESTS: 100,
} as const;

/**
 * Stream Registry Configuration
 */
export const STREAM_REGISTRY = {
  /** Default stream timeout (ms) */
  DEFAULT_TIMEOUT_MS: 300_000, // 5 minutes

  /** Maximum concurrent active streams */
  MAX_ACTIVE_STREAMS: 10,

  /** Cleanup interval for expired streams (ms) */
  CLEANUP_INTERVAL_MS: 60_000, // 1 minute
} as const;

/**
 * Model Configuration
 */
export const MODEL = {
  /** Default context length when not specified in config */
  DEFAULT_CONTEXT_LENGTH: 8192,

  /** Default quantization mode */
  DEFAULT_QUANTIZATION: 'none' as const,
} as const;

/**
 * Python Bridge IPC Configuration
 */
export const PYTHON_BRIDGE = {
  /** stdin buffer overflow limit (bytes) - 1MB */
  MAX_BUFFER_SIZE: 1_048_576,

  /** asyncio.Queue maxsize for token streaming */
  STREAM_QUEUE_SIZE: 100,

  /** Maximum retries for queue.put backpressure */
  QUEUE_PUT_MAX_RETRIES: 100,

  /** Backoff delay for queue.put retry (ms) */
  QUEUE_PUT_BACKOFF_MS: 10,
} as const;

/**
 * Performance Tuning Configuration
 */
export const PERFORMANCE = {
  /** Enable aggressive garbage collection */
  AGGRESSIVE_GC: false,

  /** Enable IPC message batching */
  ENABLE_BATCHING: false,

  /** Batch size for IPC messages */
  BATCH_SIZE: 10,

  /** Batch timeout (ms) */
  BATCH_TIMEOUT_MS: 50,

  /** Enable MessagePack for IPC (instead of JSON) */
  USE_MESSAGEPACK: false,
} as const;

/**
 * Development/Testing Configuration
 */
export const DEV = {
  /** Enable verbose logging */
  VERBOSE: false,

  /** Enable debug mode */
  DEBUG: false,

  /** Log all IPC messages */
  LOG_IPC: false,
} as const;

/**
 * Derived Constants (computed from base values)
 */
export const DERIVED = {
  /** Estimated buffer size for queue (tokens * avg bytes per token) */
  STREAM_QUEUE_BUFFER_BYTES: PYTHON_BRIDGE.STREAM_QUEUE_SIZE * 50,

  /** Maximum total wait time for queue backpressure */
  QUEUE_MAX_WAIT_MS:
    PYTHON_BRIDGE.QUEUE_PUT_MAX_RETRIES * PYTHON_BRIDGE.QUEUE_PUT_BACKOFF_MS,
} as const;

/**
 * Configuration Type for Runtime Overrides
 */
export interface RuntimeConfig {
  pythonRuntime?: Partial<typeof PYTHON_RUNTIME>;
  jsonRpc?: Partial<typeof JSON_RPC>;
  streamRegistry?: Partial<typeof STREAM_REGISTRY>;
  model?: Partial<typeof MODEL>;
  pythonBridge?: Partial<typeof PYTHON_BRIDGE>;
  performance?: Partial<typeof PERFORMANCE>;
  dev?: Partial<typeof DEV>;
}

/**
 * Merge runtime configuration with defaults
 */
export function mergeConfig(override?: RuntimeConfig): {
  pythonRuntime: typeof PYTHON_RUNTIME;
  jsonRpc: typeof JSON_RPC;
  streamRegistry: typeof STREAM_REGISTRY;
  model: typeof MODEL;
  pythonBridge: typeof PYTHON_BRIDGE;
  performance: typeof PERFORMANCE;
  dev: typeof DEV;
} {
  return {
    pythonRuntime: { ...PYTHON_RUNTIME, ...override?.pythonRuntime },
    jsonRpc: { ...JSON_RPC, ...override?.jsonRpc },
    streamRegistry: { ...STREAM_REGISTRY, ...override?.streamRegistry },
    model: { ...MODEL, ...override?.model },
    pythonBridge: { ...PYTHON_BRIDGE, ...override?.pythonBridge },
    performance: { ...PERFORMANCE, ...override?.performance },
    dev: { ...DEV, ...override?.dev },
  };
}
