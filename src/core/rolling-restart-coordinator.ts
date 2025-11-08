/**
 * Rolling Restart Coordinator
 *
 * Phase 3.4 subsystem that enables zero-downtime worker restarts by orchestrating
 * drain → verify → swap sequencing across the Python worker pool. The
 * coordinator acts as the glue between RuntimeRouter, PythonRuntimeManager,
 * StreamRegistry, and CircuitBreaker to ensure that rolling upgrades never drop
 * requests and never breach the configured minimum active worker threshold.
 *
 * Responsibilities:
 * - Pause routing to the target worker and wait for in-flight requests to
 *   complete (drain phase) with configurable timeout.
 * - Gate swap on replacement worker health (preflight checks) so unhealthy
 *   workers never take traffic.
 * - Optionally replay timed-out requests on the new worker when a drain cannot
 *   complete in time.
 * - Emit rich lifecycle events (drain_started, drain_completed,
 *   worker_replaced, restart_completed) for observability.
 * - Track metrics such as drain time distribution, timeout count, and replay
 *   success rate.
 * - Run a watchdog that ensures the cluster never drops below the configured
 *   minimum number of active workers.
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';

/** Convenience type that allows synchronous or asynchronous hook return values. */
type MaybePromise<T> = T | Promise<T>;

/** Internal constant that controls how often drain polls worker activity. */
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 250;

/**
 * Rolling restart coordinator configuration (Phase 3.4 spec).
 */
export interface RollingRestartCoordinatorConfig {
  enabled: boolean;
  drainTimeoutMs: number;
  minActiveWorkers: number;
  preflightCheckEnabled: boolean;
  preflightTimeoutMs: number;
  requestReplayEnabled: boolean;
  maxReplayAttempts: number;
  watchdogIntervalMs: number;
  logger?: Logger;
}

/** Default configuration derived from the specification. */
const DEFAULT_CONFIG: Omit<RollingRestartCoordinatorConfig, 'logger'> = {
  enabled: true,
  drainTimeoutMs: 30_000,
  minActiveWorkers: 1,
  preflightCheckEnabled: true,
  preflightTimeoutMs: 5_000,
  requestReplayEnabled: true,
  maxReplayAttempts: 1,
  watchdogIntervalMs: 5_000,
};

/** Resolve runtime configuration by overlaying user-supplied overrides. */
function resolveConfig(
  config: Partial<RollingRestartCoordinatorConfig>
): RollingRestartCoordinatorConfig {
  return {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    drainTimeoutMs: config.drainTimeoutMs ?? DEFAULT_CONFIG.drainTimeoutMs,
    minActiveWorkers: config.minActiveWorkers ?? DEFAULT_CONFIG.minActiveWorkers,
    preflightCheckEnabled: config.preflightCheckEnabled ?? DEFAULT_CONFIG.preflightCheckEnabled,
    preflightTimeoutMs: config.preflightTimeoutMs ?? DEFAULT_CONFIG.preflightTimeoutMs,
    requestReplayEnabled: config.requestReplayEnabled ?? DEFAULT_CONFIG.requestReplayEnabled,
    maxReplayAttempts: config.maxReplayAttempts ?? DEFAULT_CONFIG.maxReplayAttempts,
    watchdogIntervalMs: config.watchdogIntervalMs ?? DEFAULT_CONFIG.watchdogIntervalMs,
    logger: config.logger,
  };
}

/**
 * Worker lifecycle state as viewed by the RollingRestartCoordinator.
 */
export enum WorkerState {
  /** Worker is healthy and serving traffic. */
  ACTIVE = 'active',
  /** Worker is draining (no new traffic, waiting for in-flight completion). */
  DRAINING = 'draining',
  /** Worker fully drained (safe to swap). */
  DRAINED = 'drained',
  /** Worker has been replaced by a new instance. */
  REPLACED = 'replaced',
  /** Worker drain exceeded timeout window. */
  TIMEOUT = 'timeout',
  /** Worker experienced unrecoverable error during restart. */
  FAILED = 'failed',
}

/**
 * Rolling restart phases for diagnostics.
 */
export enum RestartPhase {
  /** No restart running. */
  IDLE = 'idle',
  /** Validating restart preconditions and snapshotting workers. */
  PRECHECKS = 'prechecks',
  /** Draining target worker. */
  DRAINING = 'draining',
  /** Verifying replacement worker health. */
  VERIFYING = 'verifying',
  /** Swapping route registration between old/new workers. */
  SWAPPING = 'swapping',
  /** Restart completed successfully. */
  COMPLETED = 'completed',
  /** Restart failed or aborted. */
  FAILED = 'failed',
}

/**
 * Health status returned by preflight checks.
 */
export interface HealthStatus {
  workerId: string;
  healthy: boolean;
  checkedAt: number;
  details?: string;
}

/**
 * Drain status exposed per worker for diagnostics.
 */
export interface DrainStatus {
  workerId: string;
  state: WorkerState;
  queuedRequests: number;
  activeRequests: number;
  drained: boolean;
  drainStartedAt?: number;
  drainCompletedAt?: number;
  timeoutAt?: number;
  replayAttempts: number;
  replacementWorkerId?: string;
}

/**
 * Drain result returned by drainWorker().
 */
export interface DrainResult {
  workerId: string;
  durationMs: number;
  timedOut: boolean;
  replayTriggered: boolean;
  replaySucceeded: boolean;
  activeRequestsAtTimeout: number;
  queuedRequestsAtTimeout: number;
}

/** Summary of a worker replacement step (for RestartResult). */
export interface WorkerRestartSummary {
  workerId: string;
  replacementWorkerId?: string;
  drain: DrainResult;
  health: HealthStatus;
}

/**
 * Restart result returned by initiateRollingRestart().
 */
export interface RestartResult {
  /** Final phase (COMPLETED or FAILED). */
  phase: RestartPhase;
  /** All workers processed during this restart. */
  completedWorkers: WorkerRestartSummary[];
  /** Workers that failed to restart (workerId + error). */
  failedWorkers: Array<{ workerId: string; error: string }>;
  /** Total restart duration (ms). */
  durationMs: number;
  /** Whether restart was skipped (e.g., disabled). */
  skipped?: boolean;
  /** Optional human-readable reason. */
  reason?: string;
}

/**
 * Restart status snapshot for monitoring endpoints.
 */
export interface RestartStatus {
  phase: RestartPhase;
  completedWorkers: number;
  activeWorkers: number;
  timeElapsedMs: number;
  lastUpdatedAt: number;
}

/**
 * Coordinator-wide metrics surfaced via getCoordinatorMetrics().
 */
export interface CoordinatorMetrics {
  totalRestarts: number;
  avgDrainTimeMs: number;
  timeoutCount: number;
  dropCount: number;
  replayAttempts: number;
  replaySuccesses: number;
  watchdogViolations: number;
  downtimeMs: number;
}

/**
 * Options passed into the request replay hook.
 */
export interface RequestReplayOptions {
  workerId: string;
  replacementWorkerId?: string;
  maxAttempts: number;
}

/** Outcome returned by request replay hook. */
export interface RequestReplayResult {
  success: boolean;
  attempts: number;
  replayedRequests: number;
  failedReason?: string;
}

/**
 * Dependencies required (or optional) by the rolling restart coordinator to
 * integrate with the rest of the serving stack. Each hook is optional and will
 * fall back to no-op behavior when omitted, allowing the coordinator to be
 * unit tested in isolation.
 */
export interface RollingRestartCoordinatorDependencies {
  /** Enumerate worker IDs in restart order. */
  listWorkers?: () => MaybePromise<string[]>;
  /** Pause routing / mark worker unavailable. */
  pauseWorkerRouting?: (workerId: string) => MaybePromise<void>;
  /** Resume routing for a worker or its replacement. */
  resumeWorkerRouting?: (workerId: string, replacementWorkerId?: string) => MaybePromise<void>;
  /** Remove terminated worker from router/manager. */
  removeWorker?: (workerId: string) => MaybePromise<void>;
  /** Spawn replacement worker and return its ID. */
  spawnReplacementWorker?: (workerId: string) => MaybePromise<string | undefined>;
  /** Health check hook (falls back to healthy if undefined). */
  healthCheck?: (workerId: string, timeoutMs: number) => MaybePromise<HealthStatus>;
  /** Get in-flight request count for worker (drain signal). */
  getWorkerActiveRequestCount?: (workerId: string) => MaybePromise<number>;
  /** Queue depth helper (used for diagnostics + replay heuristics). */
  getWorkerQueuedRequestCount?: (workerId: string) => MaybePromise<number>;
  /** Get aggregate active worker count (for watchdog + prechecks). */
  getActiveWorkerCount?: () => MaybePromise<number>;
  /** Optional request replay hook invoked on drain timeout. */
  requestReplay?: (options: RequestReplayOptions) => MaybePromise<RequestReplayResult>;
  /** Optional circuit breaker integrations. */
  openCircuit?: (workerId: string, reason: string) => MaybePromise<void>;
  closeCircuit?: (workerId: string) => MaybePromise<void>;
  /** Time source override (useful for testing). */
  now?: () => number;
}

/**
 * Lifecycle events emitted by the coordinator for observability hooks.
 */
export interface RollingRestartCoordinatorEvents {
  drain_started: (payload: { workerId: string }) => void;
  drain_completed: (
    payload: { workerId: string; durationMs: number; timedOut: boolean }
  ) => void;
  drain_timeout: (
    payload: { workerId: string; activeRequests: number; queuedRequests: number }
  ) => void;
  worker_replaced: (
    payload: { workerId: string; replacementWorkerId: string; drainDurationMs: number }
  ) => void;
  restart_completed: (payload: { durationMs: number; workers: string[] }) => void;
  restart_failed: (
    payload: { reason: string; failedWorkers: Array<{ workerId: string; error: string }> }
  ) => void;
  watchdog_violation: (payload: { activeWorkers: number; min: number }) => void;
  request_replay: (
    payload: {
      workerId: string;
      success: boolean;
      attempts: number;
      replayedRequests: number;
      replacementWorkerId?: string;
      reason?: string;
    }
  ) => void;
}

/**
 * Internal per-worker book keeping structure.
 */
interface WorkerContext {
  workerId: string;
  state: WorkerState;
  drainStartedAt?: number;
  drainCompletedAt?: number;
  drainDurationMs?: number;
  timeoutAt?: number;
  lastKnownActiveRequests: number;
  queuedRequests: number;
  replayAttempts: number;
  replacementWorkerId?: string;
  healthStatus?: HealthStatus;
  drainPromise?: Promise<DrainResult>;
}

/** Mutable metrics accumulator (converted to CoordinatorMetrics on demand). */
interface InternalMetrics {
  totalRestarts: number;
  totalDrainTimeMs: number;
  drainSamples: number;
  timeoutCount: number;
  dropCount: number;
  replayAttempts: number;
  replaySuccesses: number;
  watchdogViolations: number;
  downtimeMs: number;
  downtimeStart?: number;
}

/** Restart abort signal used by watchdog or manual cancellation. */
interface AbortSignalState {
  requested: boolean;
  reason?: string;
  error?: Error;
}

/**
 * RollingRestartCoordinator implementation.
 */
export class RollingRestartCoordinator extends EventEmitter<RollingRestartCoordinatorEvents> {
  private readonly config: RollingRestartCoordinatorConfig;
  private readonly logger?: Logger;
  private readonly deps: RollingRestartCoordinatorDependencies;

  private readonly workers = new Map<string, WorkerContext>();
  private restartPhase: RestartPhase = RestartPhase.IDLE;
  private restartStartedAt = 0;
  private readonly restartHistory: WorkerRestartSummary[] = [];
  private readonly restartFailures: Array<{ workerId: string; error: string }> = [];
  private watchdogTimer?: NodeJS.Timeout;
  private readonly metrics: InternalMetrics = {
    totalRestarts: 0,
    totalDrainTimeMs: 0,
    drainSamples: 0,
    timeoutCount: 0,
    dropCount: 0,
    replayAttempts: 0,
    replaySuccesses: 0,
    watchdogViolations: 0,
    downtimeMs: 0,
  };
  private readonly abortSignal: AbortSignalState = { requested: false };
  private lastObservedActiveWorkers = 0;

  constructor(
    config: Partial<RollingRestartCoordinatorConfig> = {},
    dependencies: RollingRestartCoordinatorDependencies = {}
  ) {
    super();

    this.config = resolveConfig(config);
    this.logger = this.config.logger;
    this.deps = dependencies;

    if (this.config.enabled) {
      this.startWatchdog();
    }
  }

  /**
   * Start a coordinated rolling restart across all workers.
   */
  public async initiateRollingRestart(): Promise<RestartResult> {
    if (!this.config.enabled) {
      return {
        phase: RestartPhase.IDLE,
        completedWorkers: [],
        failedWorkers: [],
        durationMs: 0,
        skipped: true,
        reason: 'RollingRestartCoordinator disabled via config',
      };
    }

    if (this.restartPhase !== RestartPhase.IDLE) {
      throw new Error('Rolling restart already in progress');
    }

    this.restartPhase = RestartPhase.PRECHECKS;
    this.restartStartedAt = this.now();
    this.restartHistory.length = 0;
    this.restartFailures.length = 0;
    this.abortSignal.requested = false;
    this.abortSignal.reason = undefined;
    this.abortSignal.error = undefined;

    const workerIds = await this.listWorkers();
    if (workerIds.length === 0) {
      this.restartPhase = RestartPhase.COMPLETED;
      return {
        phase: RestartPhase.COMPLETED,
        completedWorkers: [],
        failedWorkers: [],
        durationMs: 0,
        skipped: true,
        reason: 'No workers registered for restart',
      };
    }

    this.metrics.totalRestarts++;

    for (const workerId of workerIds) {
      if (this.abortSignal.requested) {
        break;
      }

      try {
        const summary = await this.restartSingleWorker(workerId);
        this.restartHistory.push(summary);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.restartFailures.push({ workerId, error: errorMessage });
        this.logger?.error({ workerId, error: errorMessage }, 'Worker restart failed');
        this.restartPhase = RestartPhase.FAILED;
        break;
      }
    }

    const durationMs = this.now() - this.restartStartedAt;
    const phase = this.restartFailures.length === 0 && !this.abortSignal.requested
      ? RestartPhase.COMPLETED
      : RestartPhase.FAILED;

    if (phase === RestartPhase.COMPLETED) {
      this.emit('restart_completed', {
        durationMs,
        workers: this.restartHistory.map((w) => w.workerId),
      });
    } else {
      const reason = this.abortSignal.reason ?? 'Worker restart failure';
      this.emit('restart_failed', {
        reason,
        failedWorkers: [...this.restartFailures],
      });
    }

    this.restartPhase = RestartPhase.IDLE;

    return {
      phase,
      completedWorkers: [...this.restartHistory],
      failedWorkers: [...this.restartFailures],
      durationMs,
      reason: this.abortSignal.reason,
      skipped: false,
    };
  }

  /**
   * Drain a single worker. Public so PythonRuntimeManager can drain ad-hoc.
   */
  public async drainWorker(workerId: string): Promise<DrainResult> {
    const context = this.getOrCreateContext(workerId);

    if (context.drainPromise) {
      return context.drainPromise;
    }

    context.drainPromise = this.executeDrain(workerId, context).finally(() => {
      context.drainPromise = undefined;
    });

    return context.drainPromise;
  }

  /**
   * Run preflight health checks for a worker (typically replacement worker).
   */
  public async checkWorkerHealth(workerId: string): Promise<HealthStatus> {
    if (!this.config.preflightCheckEnabled) {
      return {
        workerId,
        healthy: true,
        checkedAt: this.now(),
        details: 'Preflight check disabled via config',
      };
    }

    if (!this.deps.healthCheck) {
      return {
        workerId,
        healthy: true,
        checkedAt: this.now(),
        details: 'No healthCheck hook provided',
      };
    }

    const timeoutMs = this.config.preflightTimeoutMs;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<HealthStatus>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          workerId,
          healthy: false,
          checkedAt: this.now(),
          details: `Preflight health check timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    });

    try {
      const healthPromise = this.deps.healthCheck(workerId, timeoutMs);
      const result = await Promise.race([healthPromise, timeoutPromise]);
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** Get restart status snapshot. */
  public getRestartStatus(): RestartStatus {
    void this.refreshActiveWorkerCountSnapshot().catch((err) => {
      this.logger?.error({ err }, 'Failed to refresh active worker count snapshot');
    });

    return {
      phase: this.restartPhase,
      completedWorkers: this.restartHistory.length,
      activeWorkers: this.lastObservedActiveWorkers,
      timeElapsedMs: this.restartStartedAt ? this.now() - this.restartStartedAt : 0,
      lastUpdatedAt: this.now(),
    };
  }

  /**
   * Return coordinator metrics in a lightweight struct for diagnostics/exporters.
   */
  public getCoordinatorMetrics(): CoordinatorMetrics {
    const avgDrainTime = this.metrics.drainSamples > 0
      ? this.metrics.totalDrainTimeMs / this.metrics.drainSamples
      : 0;

    return {
      totalRestarts: this.metrics.totalRestarts,
      avgDrainTimeMs: avgDrainTime,
      timeoutCount: this.metrics.timeoutCount,
      dropCount: this.metrics.dropCount,
      replayAttempts: this.metrics.replayAttempts,
      replaySuccesses: this.metrics.replaySuccesses,
      watchdogViolations: this.metrics.watchdogViolations,
      downtimeMs: this.metrics.downtimeMs,
    };
  }

  /**
   * Return per-worker drain status snapshot. Unknown workers result in a
   * synthesized ACTIVE state to simplify caller handling.
   */
  public getWorkerDrainStatus(workerId: string): DrainStatus {
    const context = this.workers.get(workerId);
    if (!context) {
      return {
        workerId,
        state: WorkerState.ACTIVE,
        queuedRequests: 0,
        activeRequests: 0,
        drained: false,
        replayAttempts: 0,
      };
    }

    return {
      workerId,
      state: context.state,
      queuedRequests: context.queuedRequests,
      activeRequests: context.lastKnownActiveRequests,
      drained: context.state === WorkerState.DRAINED || context.state === WorkerState.REPLACED,
      drainStartedAt: context.drainStartedAt,
      drainCompletedAt: context.drainCompletedAt,
      timeoutAt: context.timeoutAt,
      replayAttempts: context.replayAttempts,
      replacementWorkerId: context.replacementWorkerId,
    };
  }

  /** Register worker context upfront (optional helper for callers). */
  public registerWorker(workerId: string): void {
    this.getOrCreateContext(workerId);
  }

  /** Remove worker context (e.g., after permanent removal). */
  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  /** Cleanup timers. */
  public dispose(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Restart a single worker by draining, verifying replacement, and swapping.
   */
  private async restartSingleWorker(workerId: string): Promise<WorkerRestartSummary> {
    let succeeded = false;
    this.restartPhase = RestartPhase.DRAINING;

    // Kick off replacement spawn immediately to hide startup time.
    const replacementPromise = this.spawnReplacementWorker(workerId).then((id) => {
      if (id) {
        const ctx = this.getOrCreateContext(workerId);
        ctx.replacementWorkerId = id;
      }
      return id;
    });

    try {
      const drain = await this.drainWorker(workerId);
      if (drain.timedOut && this.abortSignal.requested) {
        throw this.abortSignal.error ?? new Error(this.abortSignal.reason ?? 'Restart aborted');
      }

      this.restartPhase = RestartPhase.VERIFYING;
      const replacementWorkerId = await replacementPromise;
      const targetWorkerId = replacementWorkerId ?? workerId;
      const health = await this.checkWorkerHealth(targetWorkerId);

      if (!health.healthy) {
        this.abort(`Replacement worker ${targetWorkerId} failed health check`);
        throw new Error(health.details ?? 'Replacement worker failed health check');
      }

      this.restartPhase = RestartPhase.SWAPPING;
      await this.swapWorkers(workerId, targetWorkerId);

      const context = this.getOrCreateContext(workerId);
      context.state = WorkerState.REPLACED;
      context.replacementWorkerId = targetWorkerId;
      context.healthStatus = health;

      this.emit('worker_replaced', {
        workerId,
        replacementWorkerId: targetWorkerId,
        drainDurationMs: drain.durationMs,
      });

      succeeded = true;

      return {
        workerId,
        replacementWorkerId: targetWorkerId,
        drain,
        health,
      };
    } finally {
      if (!succeeded) {
        await this.deps.closeCircuit?.(workerId);
        await this.deps.resumeWorkerRouting?.(workerId);
      }
    }
  }

  /** Execute the drain loop for a worker. */
  private async executeDrain(workerId: string, context: WorkerContext): Promise<DrainResult> {
    await this.ensureMinActiveWorkersBudget(workerId);

    context.state = WorkerState.DRAINING;
    context.drainStartedAt = this.now();
    context.timeoutAt = context.drainStartedAt + this.config.drainTimeoutMs;
    context.replayAttempts = 0;

    await this.deps.pauseWorkerRouting?.(workerId);
    await this.deps.openCircuit?.(workerId, 'rolling-drain');

    this.emit('drain_started', { workerId });
    this.logger?.info({ workerId }, 'Worker drain started');

    const drainResult = await this.waitForDrainCompletion(workerId, context);

    if (!drainResult.timedOut) {
      context.state = WorkerState.DRAINED;
      context.drainCompletedAt = this.now();
      context.drainDurationMs = drainResult.durationMs;
      this.metrics.totalDrainTimeMs += drainResult.durationMs;
      this.metrics.drainSamples++;

      this.emit('drain_completed', {
        workerId,
        durationMs: drainResult.durationMs,
        timedOut: false,
      });
    } else {
      context.state = WorkerState.TIMEOUT;
      this.metrics.timeoutCount++;
      this.logger?.warn(
        {
          workerId,
          activeRequests: drainResult.activeRequestsAtTimeout,
          queuedRequests: drainResult.queuedRequestsAtTimeout,
          timeoutMs: this.config.drainTimeoutMs,
        },
        'Worker drain reached timeout'
      );
      this.emit('drain_timeout', {
        workerId,
        activeRequests: drainResult.activeRequestsAtTimeout,
        queuedRequests: drainResult.queuedRequestsAtTimeout,
      });
      this.emit('drain_completed', {
        workerId,
        durationMs: drainResult.durationMs,
        timedOut: true,
      });
      if (!drainResult.replayTriggered || !drainResult.replaySucceeded) {
        this.metrics.dropCount += Math.max(0, drainResult.activeRequestsAtTimeout);
      }
    }

    return drainResult;
  }

  /** Wait for drain completion or timeout. */
  private async waitForDrainCompletion(workerId: string, context: WorkerContext): Promise<DrainResult> {
    const deadline = context.timeoutAt ?? (this.now() + this.config.drainTimeoutMs);
    let durationMs = 0;
    let replayTriggered = false;
    let replaySucceeded = false;
    let activeRequestsAtTimeout = 0;
    let queuedRequestsAtTimeout = 0;

    while (this.now() < deadline) {
      const activeRequests = await this.getWorkerActiveRequests(workerId);
      const queuedRequests = await this.getWorkerQueuedRequests(workerId);

      context.lastKnownActiveRequests = activeRequests;
      context.queuedRequests = queuedRequests;

      if (activeRequests === 0) {
        durationMs = this.now() - (context.drainStartedAt ?? this.now());
        return {
          workerId,
          durationMs,
          timedOut: false,
          replayTriggered,
          replaySucceeded,
          activeRequestsAtTimeout,
          queuedRequestsAtTimeout,
        };
      }

      if (this.abortSignal.requested) {
        throw this.abortSignal.error ?? new Error(this.abortSignal.reason ?? 'Restart aborted');
      }

      await this.delay(DEFAULT_DRAIN_POLL_INTERVAL_MS);
    }

    activeRequestsAtTimeout = await this.getWorkerActiveRequests(workerId);
    queuedRequestsAtTimeout = await this.getWorkerQueuedRequests(workerId);

    if (this.config.requestReplayEnabled) {
      replayTriggered = true;
      const replayResult = await this.triggerRequestReplay(workerId, context.replacementWorkerId);
      context.replayAttempts = replayResult.attempts;
      replaySucceeded = replayResult.success;
    }

    durationMs = this.config.drainTimeoutMs;

    return {
      workerId,
      durationMs,
      timedOut: true,
      replayTriggered,
      replaySucceeded,
      activeRequestsAtTimeout,
      queuedRequestsAtTimeout,
    };
  }

  /** Trigger request replay hook when drain times out. */
  private async triggerRequestReplay(
    workerId: string,
    replacementWorkerId?: string
  ): Promise<RequestReplayResult> {
    if (!this.deps.requestReplay) {
      const fallback: RequestReplayResult = {
        success: false,
        attempts: 0,
        replayedRequests: 0,
        failedReason: 'No replay hook',
      };
      this.emit('request_replay', {
        workerId,
        success: fallback.success,
        attempts: fallback.attempts,
        replayedRequests: fallback.replayedRequests,
        replacementWorkerId,
        reason: fallback.failedReason,
      });
      return fallback;
    }

    const options: RequestReplayOptions = {
      workerId,
      replacementWorkerId,
      maxAttempts: this.config.maxReplayAttempts,
    };

    const result = await this.deps.requestReplay(options);
    this.metrics.replayAttempts += result.attempts;
    if (result.success) {
      this.metrics.replaySuccesses += 1;
    }
    this.emit('request_replay', {
      workerId,
      success: result.success,
      attempts: result.attempts,
      replayedRequests: result.replayedRequests,
      replacementWorkerId,
      reason: result.failedReason,
    });
    return result;
  }

  /** Spawn replacement worker via dependency hook. */
  private async spawnReplacementWorker(workerId: string): Promise<string | undefined> {
    if (!this.deps.spawnReplacementWorker) {
      return undefined;
    }

    try {
      const replacementId = await this.deps.spawnReplacementWorker(workerId);
      return replacementId;
    } catch (err) {
      this.logger?.error({ workerId, err }, 'Failed to spawn replacement worker');
      throw err;
    }
  }

  /** Swap worker registrations (remove old, resume routing to new). */
  private async swapWorkers(oldWorkerId: string, newWorkerId: string): Promise<void> {
    if (oldWorkerId !== newWorkerId) {
      await this.deps.removeWorker?.(oldWorkerId);
    }
    await this.deps.closeCircuit?.(oldWorkerId);
    await this.deps.resumeWorkerRouting?.(newWorkerId, oldWorkerId);
  }

  /** Ensure draining will not breach minActiveWorkers. */
  private async ensureMinActiveWorkersBudget(workerId: string): Promise<void> {
    const activeWorkers = await this.refreshActiveWorkerCountSnapshot();

    if (activeWorkers - 1 < this.config.minActiveWorkers) {
      const message = `Cannot drain worker ${workerId}: active workers (${activeWorkers}) would drop below min (${this.config.minActiveWorkers})`;
      this.logger?.error(message);
      throw new Error(message);
    }
  }

  /** List workers via dependency or existing context. */
  private async listWorkers(): Promise<string[]> {
    if (this.deps.listWorkers) {
      const workerIds = await this.deps.listWorkers();
      workerIds.forEach((id) => this.getOrCreateContext(id));
      return workerIds;
    }

    return Array.from(this.workers.keys());
  }

  /** Get or create worker context object. */
  private getOrCreateContext(workerId: string): WorkerContext {
    let context = this.workers.get(workerId);
    if (!context) {
      context = {
        workerId,
        state: WorkerState.ACTIVE,
        lastKnownActiveRequests: 0,
        queuedRequests: 0,
        replayAttempts: 0,
      };
      this.workers.set(workerId, context);
    }
    return context;
  }

  /** Poll worker active request count via dependency (fallback to 0). */
  private async getWorkerActiveRequests(workerId: string): Promise<number> {
    if (!this.deps.getWorkerActiveRequestCount) {
      return 0;
    }
    const value = await this.deps.getWorkerActiveRequestCount(workerId);
    return Math.max(0, value);
  }

  /** Poll worker queued requests via dependency (fallback to active count). */
  private async getWorkerQueuedRequests(workerId: string): Promise<number> {
    if (this.deps.getWorkerQueuedRequestCount) {
      const value = await this.deps.getWorkerQueuedRequestCount(workerId);
      return Math.max(0, value);
    }
    return this.getWorkerActiveRequests(workerId);
  }

  /** Active worker count snapshot (without caching). */
  private async fetchActiveWorkerCount(): Promise<number> {
    if (this.deps.getActiveWorkerCount) {
      return await this.deps.getActiveWorkerCount();
    }
    // Fallback to contexts not in terminal states.
    let count = 0;
    for (const ctx of this.workers.values()) {
      if (ctx.state === WorkerState.ACTIVE || ctx.state === WorkerState.DRAINING) {
        count++;
      }
    }
    return count;
  }

  /** Update cached active worker snapshot (used by sync status APIs). */
  private async refreshActiveWorkerCountSnapshot(): Promise<number> {
    const count = await this.fetchActiveWorkerCount();
    this.lastObservedActiveWorkers = count;
    return count;
  }

  /** Start watchdog timer that enforces minActiveWorkers. */
  private startWatchdog(): void {
    if (this.watchdogTimer) {
      return;
    }

    this.watchdogTimer = setInterval(() => {
      this.runWatchdogCheck().catch((err) => {
        this.logger?.error({ err }, 'Rolling restart watchdog check failed');
      });
    }, this.config.watchdogIntervalMs);

    if (typeof this.watchdogTimer.unref === 'function') {
      this.watchdogTimer.unref();
    }
  }

  /** Execute watchdog logic. */
  private async runWatchdogCheck(): Promise<void> {
    const activeWorkers = await this.refreshActiveWorkerCountSnapshot();

    if (activeWorkers < this.config.minActiveWorkers) {
      this.metrics.watchdogViolations++;

      if (!this.metrics.downtimeStart) {
        this.metrics.downtimeStart = this.now();
      }

      const reason = `Watchdog breach: active workers ${activeWorkers} < min ${this.config.minActiveWorkers}`;
      this.logger?.error(reason);
      this.emit('watchdog_violation', { activeWorkers, min: this.config.minActiveWorkers });

      if (!this.abortSignal.requested && this.restartPhase !== RestartPhase.IDLE) {
        this.abort(reason);
      }
    } else if (this.metrics.downtimeStart) {
      this.metrics.downtimeMs += this.now() - this.metrics.downtimeStart;
      this.metrics.downtimeStart = undefined;
    }
  }

  /** Abort current restart in progress. */
  private abort(reason: string): void {
    this.abortSignal.requested = true;
    this.abortSignal.reason = reason;
    this.abortSignal.error = new Error(reason);
    this.restartPhase = RestartPhase.FAILED;
  }

  /** Utility: sleep helper. */
  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Utility: monotonic-ish now helper (w/testing override). */
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
