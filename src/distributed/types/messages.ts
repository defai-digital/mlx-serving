/**
 * Message type schemas for distributed inference system
 *
 * All message types are defined with Zod schemas for runtime validation.
 */

import { z } from 'zod';

// ============================================================================
// Model Skills Schema (from Week 3 PRD)
// ============================================================================

/**
 * Model skills available on a worker
 */
export const ModelSkillsSchema = z.object({
  /** Models discovered from worker's local "model" folder */
  availableModels: z.array(z.string()),
  /** Model name → local path mapping */
  modelPaths: z.record(z.string(), z.string()),
  /** Total size in bytes of all models */
  totalModelSize: z.number().nonnegative(),
  /** Timestamp of last model folder scan */
  lastScanned: z.number().int().positive(),
});

export type ModelSkills = z.infer<typeof ModelSkillsSchema>;

// ============================================================================
// Worker Registration Schema
// ============================================================================

/**
 * Worker registration message
 *
 * Sent by worker to controller when joining the cluster.
 */
export const WorkerRegistrationSchema = z.object({
  /** Unique worker identifier (UUID) */
  workerId: z.string().uuid(),
  /** Hostname of the worker */
  hostname: z.string(),
  /** IP address of the worker */
  ip: z.string().ip(),
  /** Port the worker is listening on */
  port: z.number().int().min(1024).max(65535),
  /** Model skills available on this worker */
  skills: ModelSkillsSchema,
  /** Current worker status */
  status: z.enum(['online', 'offline', 'degraded']),
  /** Timestamp of registration */
  timestamp: z.number().int().positive(),
});

export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;

// ============================================================================
// Worker Heartbeat Schema
// ============================================================================

/**
 * Worker metrics for heartbeat
 */
export const WorkerMetricsSchema = z.object({
  /** CPU usage percentage (0-100) */
  cpuUsagePercent: z.number().min(0).max(100),
  /** Memory used in GB */
  memoryUsedGB: z.number().nonnegative(),
  /** GPU utilization percentage (0-100) */
  gpuUtilizationPercent: z.number().min(0).max(100),
  /** Number of active requests being processed */
  activeRequests: z.number().int().nonnegative(),
  /** Total number of requests handled since startup */
  totalRequestsHandled: z.number().int().nonnegative(),
  /** Average latency in milliseconds */
  avgLatencyMs: z.number().nonnegative(),
  /** List of currently loaded models */
  modelsLoaded: z.array(z.string()),
});

export type WorkerMetrics = z.infer<typeof WorkerMetricsSchema>;

/**
 * Worker heartbeat message
 *
 * Sent periodically by worker to controller to indicate health.
 */
export const WorkerHeartbeatSchema = z.object({
  /** Unique worker identifier (UUID) */
  workerId: z.string().uuid(),
  /** Current worker status */
  status: z.enum(['online', 'offline', 'degraded']),
  /** Current metrics */
  metrics: WorkerMetricsSchema,
  /** Timestamp of heartbeat */
  timestamp: z.number().int().positive(),
});

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;

// ============================================================================
// Inference Request Schema
// ============================================================================

/**
 * Inference request message
 *
 * Sent by controller to worker to request generation.
 */
export const InferenceRequestSchema = z.object({
  /** Unique request identifier (UUID) */
  requestId: z.string().uuid(),
  /** Model to use for inference */
  modelId: z.string(),
  /** Input prompt text */
  prompt: z.string(),
  /** Maximum tokens to generate (optional) */
  maxTokens: z.number().int().positive().optional(),
  /** Temperature for sampling (0-2, optional) */
  temperature: z.number().min(0).max(2).optional(),
  /** Top-p nucleus sampling (0-1, optional) */
  topP: z.number().min(0).max(1).optional(),
  /** Session ID for sticky sessions (optional) */
  sessionId: z.string().uuid().optional(),
  /** Enable streaming response (optional, default false) */
  stream: z.boolean().optional(),
});

export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

// ============================================================================
// Streaming Response Schema
// ============================================================================

/**
 * Streaming token response
 */
export const StreamingTokenResponseSchema = z.object({
  /** Request ID this response belongs to */
  requestId: z.string().uuid(),
  /** Response type discriminator */
  type: z.literal('token'),
  /** Generated token text */
  token: z.string(),
  /** Index of this token in the sequence */
  index: z.number().int().nonnegative(),
});

export type StreamingTokenResponse = z.infer<typeof StreamingTokenResponseSchema>;

/**
 * Streaming done response
 */
export const StreamingDoneResponseSchema = z.object({
  /** Request ID this response belongs to */
  requestId: z.string().uuid(),
  /** Response type discriminator */
  type: z.literal('done'),
  /** Total tokens generated */
  totalTokens: z.number().int().positive(),
  /** Total latency in milliseconds */
  latencyMs: z.number().nonnegative(),
});

export type StreamingDoneResponse = z.infer<typeof StreamingDoneResponseSchema>;

/**
 * Streaming error response
 */
export const StreamingErrorResponseSchema = z.object({
  /** Request ID this response belongs to */
  requestId: z.string().uuid(),
  /** Response type discriminator */
  type: z.literal('error'),
  /** Error message */
  error: z.string(),
  /** Error code */
  code: z.string(),
});

export type StreamingErrorResponse = z.infer<typeof StreamingErrorResponseSchema>;

/**
 * Streaming response message (discriminated union)
 *
 * Sent by worker to controller during generation.
 */
export const StreamingResponseSchema = z.discriminatedUnion('type', [
  StreamingTokenResponseSchema,
  StreamingDoneResponseSchema,
  StreamingErrorResponseSchema,
]);

export type StreamingResponse = z.infer<typeof StreamingResponseSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate worker registration message
 *
 * @param data - Raw data to validate
 * @returns Validated WorkerRegistration
 * @throws {z.ZodError} if validation fails
 */
export function validateWorkerRegistration(data: unknown): WorkerRegistration {
  return WorkerRegistrationSchema.parse(data);
}

/**
 * Validate worker heartbeat message
 *
 * @param data - Raw data to validate
 * @returns Validated WorkerHeartbeat
 * @throws {z.ZodError} if validation fails
 */
export function validateWorkerHeartbeat(data: unknown): WorkerHeartbeat {
  return WorkerHeartbeatSchema.parse(data);
}

/**
 * Validate inference request message
 *
 * @param data - Raw data to validate
 * @returns Validated InferenceRequest
 * @throws {z.ZodError} if validation fails
 */
export function validateInferenceRequest(data: unknown): InferenceRequest {
  return InferenceRequestSchema.parse(data);
}

/**
 * Validate streaming response message
 *
 * @param data - Raw data to validate
 * @returns Validated StreamingResponse
 * @throws {z.ZodError} if validation fails
 */
export function validateStreamingResponse(data: unknown): StreamingResponse {
  return StreamingResponseSchema.parse(data);
}
