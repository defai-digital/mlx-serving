export { Engine, createEngine } from './api/engine.js';
export { MLXEngine, createMLXEngine } from './api/mlx-engine.js';
export { GenerationStatsCollector, type StatsCollectorOptions } from './api/stats-collector.js';
export { EngineClientError, type EngineErrorCode } from './api/errors.js';
export * from './api/helpers.js';
export * from './api/module-helpers.js';
export * from './api/validators.js';
export {
  ENGINE_API_SNAPSHOT_VERSION,
} from './api/contracts/engine-public-api.js';
export type { EnginePublicAPI } from './api/contracts/engine-public-api.js';
export type * from './api/events.js';

// Phase 4: Telemetry & Monitoring
export { createTelemetryBridge, getMetrics } from './telemetry/bridge.js';
export { TelemetryManager, type TelemetryConfig, type KrServeMetrics } from './telemetry/otel.js';

export type {
  EngineOptions,
  LoadModelOptions,
  GeneratorParams,
  GeneratorChunk,
  TokenizeRequest,
  TokenizeResponse,
  GenerationStats,
  ModelHandle,
  ModelDescriptor,
  CompatibilityReport,
  RuntimeInfo,
  HealthStatus,
} from './types/index.js';

export * from './types/index.js';
