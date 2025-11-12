/**
 * Distributed Inference System for mlx-serving
 *
 * Main entry point for distributed inference functionality.
 * Provides NATS messaging, configuration management, and type-safe messaging.
 */

// NATS Client and Server
export { NatsClient, ConnectionState } from './nats/client.js';
export { EmbeddedNatsServer } from './nats/embedded-server.js';

// Configuration
export {
  loadClusterConfig,
  loadClusterConfigWithEnv,
  validateConfig,
} from './config/loader.js';

// Types and Schemas
export {
  // Message types
  type ModelSkills,
  type WorkerRegistration,
  type WorkerMetrics,
  type WorkerHeartbeat,
  type InferenceRequest,
  type StreamingTokenResponse,
  type StreamingDoneResponse,
  type StreamingErrorResponse,
  type StreamingResponse,
  // Message schemas
  ModelSkillsSchema,
  WorkerRegistrationSchema,
  WorkerMetricsSchema,
  WorkerHeartbeatSchema,
  InferenceRequestSchema,
  StreamingTokenResponseSchema,
  StreamingDoneResponseSchema,
  StreamingErrorResponseSchema,
  StreamingResponseSchema,
  // Message validators
  validateWorkerRegistration,
  validateWorkerHeartbeat,
  validateInferenceRequest,
  validateStreamingResponse,
  // Configuration types
  type NatsClientOptions,
  type EmbeddedServerOptions,
  type NatsConfig,
  type ControllerConfig,
  type WorkerConfig,
  type DiscoveryConfig,
  type StaticWorker,
  type WorkersConfig,
  type LoadBalancingConfig,
  type LoggingConfig,
  type ClusterConfig,
  // Configuration schemas
  NatsClientOptionsSchema,
  EmbeddedServerOptionsSchema,
  NatsConfigSchema,
  ControllerConfigSchema,
  WorkerConfigSchema,
  DiscoveryConfigSchema,
  StaticWorkerSchema,
  WorkersConfigSchema,
  LoadBalancingConfigSchema,
  LoggingConfigSchema,
  ClusterConfigSchema,
  // Configuration helpers
  validateClusterConfig,
  createDefaultClusterConfig,
} from './types/index.js';

// Logger
export { createLogger, Logger, type LogLevel, type LogEntry } from './utils/logger.js';

// Errors
export {
  DistributedError,
  NatsError,
  ConnectionError,
  TimeoutError,
  ConfigurationError,
  ValidationError,
  WorkerError,
  ControllerError,
  EmbeddedServerError,
  isDistributedError,
  isNatsError,
  wrapError,
} from './utils/errors.js';
