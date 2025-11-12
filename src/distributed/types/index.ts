/**
 * Distributed inference type definitions
 *
 * Re-exports all types and schemas for easy importing.
 */

// Message types and schemas
export {
  // Schemas
  ModelSkillsSchema,
  WorkerRegistrationSchema,
  WorkerMetricsSchema,
  WorkerHeartbeatSchema,
  InferenceRequestSchema,
  StreamingTokenResponseSchema,
  StreamingDoneResponseSchema,
  StreamingErrorResponseSchema,
  StreamingResponseSchema,
  // Types
  type ModelSkills,
  type WorkerRegistration,
  type WorkerMetrics,
  type WorkerHeartbeat,
  type InferenceRequest,
  type StreamingTokenResponse,
  type StreamingDoneResponse,
  type StreamingErrorResponse,
  type StreamingResponse,
  // Validators
  validateWorkerRegistration,
  validateWorkerHeartbeat,
  validateInferenceRequest,
  validateStreamingResponse,
} from './messages.js';

// Configuration types and schemas
export {
  // Schemas
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
  // Types
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
  // Helpers
  validateClusterConfig,
  createDefaultClusterConfig,
} from './config.js';
