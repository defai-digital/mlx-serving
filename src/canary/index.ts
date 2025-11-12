/**
 * Canary Deployment System - Zero-downtime gradual rollout with automated rollback
 *
 * @module canary
 * @packageDocumentation
 */

// Core orchestration
export {
  CanaryManager,
  DEFAULT_CANARY_CONFIG,
  type CanaryManagerConfig,
  type CanaryStage,
  type DeploymentStatus,
  type StageTransition,
} from './canary-manager.js';

// Traffic routing
export {
  CanaryRouter,
  type CanaryRouterConfig,
  type RoutingDecision,
  type RoutingStats,
} from './canary-router.js';

// Automated rollback
export {
  RollbackController,
  DEFAULT_TRIGGERS,
  type RollbackConfig,
  type RollbackTrigger,
  type RollbackEvent,
} from './rollback-controller.js';

// Metrics collection
export {
  MetricsCollector,
  type MetricsSnapshot,
  type ComparisonResult,
} from './metrics-collector.js';
