/**
 * Python Runtime Manager
 *
 * Manages the lifecycle of multiple Python worker processes for Phase 2 multi-worker scaling.
 * This module coordinates N Python workers with intelligent health monitoring, automatic restart,
 * and integration with RuntimeRouter for load balancing.
 *
 * Key Features:
 * - Worker Pool Management: Spawn and monitor N Python worker processes
 * - Health Monitoring: Periodic heartbeat checks with automatic failure detection
 * - Automatic Restart: Failed workers are restarted with exponential backoff
 * - Graceful Shutdown: Drain in-flight requests before terminating workers
 * - Router Integration: Register/unregister workers with RuntimeRouter
 * - Statistics Tracking: Per-worker and aggregate metrics
 *
 * Architecture:
 * - Each worker is a separate PythonRunner instance with its own process
 * - RuntimeRouter handles request routing across the worker pool
 * - Health checks run periodically (default: 5s) to detect stale workers
 * - Failed workers are automatically restarted (up to maxRestarts limit)
 * - All workers share the same model (loaded independently per process)
 *
 * Thread Safety:
 * - Workers map is mutable (concurrent start/stop/restart operations)
 * - State updates are atomic (status changes before/after async operations)
 * - Router registration is synchronized (register before marking ready)
 *
 * Graceful Degradation:
 * - If worker fails during startup → retry with exponential backoff
 * - If all workers fail → emit allWorkersFailed event, log critical error
 * - If worker hangs (no heartbeat) → mark failed, restart automatically
 * - If shutdown requested during restart → cancel restart, cleanup gracefully
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { PythonRunner } from './python-runner.js';
import type { PythonRunnerOptions } from './python-runner.js';
import { RuntimeRouter } from '../core/runtime-router.js';
import type { PythonWorker, RuntimeRouterStats } from '../core/runtime-router.js';

/**
 * Python Runtime Manager configuration
 */
export interface PythonRuntimeManagerConfig {
  /** Number of worker processes (default: 3) */
  workerCount: number;

  /** Python executable path */
  pythonPath: string;

  /** Runtime script path */
  runtimePath: string;

  /** Maximum restart attempts per worker (default: 3) */
  maxRestarts: number;

  /** Worker startup timeout (milliseconds, default: 30000) */
  startupTimeout: number;

  /** Worker shutdown timeout (milliseconds, default: 5000) */
  shutdownTimeout: number;

  /** Worker restart delay (milliseconds, default: 1000) */
  restartDelay: number;

  /** Health check interval (milliseconds, default: 5000) */
  healthCheckInterval: number;

  /** Heartbeat timeout (milliseconds, default: 10000) */
  heartbeatTimeout: number;

  /** Routing strategy: 'round-robin' or 'least-busy' (default: 'round-robin') */
  routingStrategy: 'round-robin' | 'least-busy';

  /** Enable verbose logging (default: false) */
  verbose?: boolean;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Worker state (internal representation)
 *
 * Extends PythonWorker with internal bookkeeping fields.
 */
export interface WorkerState {
  /** Unique worker ID (UUID) */
  id: string;

  /** Process ID (null if not started) */
  pid: number | null;

  /** Worker status */
  status: 'starting' | 'idle' | 'busy' | 'failed' | 'stopped';

  /** Underlying PythonRunner instance */
  runtime: PythonRunner | null;

  /** Restart count for this worker */
  restartCount: number;

  /** Last heartbeat timestamp (milliseconds since epoch) */
  lastHeartbeat: number;

  /** Worker start time (milliseconds since epoch) */
  startedAt: number;

  /** Last error (if any) */
  error?: string;
}

/**
 * Manager statistics
 */
export interface PythonRuntimeManagerStats {
  /** Total worker count (including failed) */
  totalWorkers: number;

  /** Active worker count (status === 'idle' or 'busy') */
  activeWorkers: number;

  /** Starting worker count */
  startingWorkers: number;

  /** Failed worker count */
  failedWorkers: number;

  /** Stopped worker count */
  stoppedWorkers: number;

  /** Total restart count (all workers) */
  totalRestarts: number;

  /** Router statistics */
  routerStats: RuntimeRouterStats;
}

/**
 * Manager events
 */
export interface PythonRuntimeManagerEvents {
  /** Worker became ready (passed startup probe) */
  workerReady: (workerId: string) => void;

  /** Worker encountered error */
  workerError: (workerId: string, error: Error) => void;

  /** Worker is being restarted */
  workerRestart: (workerId: string, attempt: number) => void;

  /** Worker process exited */
  workerExit: (workerId: string, code: number | null) => void;

  /** All workers are ready */
  allWorkersReady: () => void;

  /** All workers have failed */
  allWorkersFailed: () => void;
}

/**
 * Python Runtime Manager
 *
 * Manages multiple Python worker processes with lifecycle control, health monitoring,
 * and integration with RuntimeRouter for load balancing.
 */
export class PythonRuntimeManager extends EventEmitter<PythonRuntimeManagerEvents> {
  private readonly config: PythonRuntimeManagerConfig;
  private readonly logger?: Logger;
  private readonly router: RuntimeRouter;

  /**
   * Worker state map
   *
   * IMPORTANT: This is the single source of truth for worker state.
   * All state changes must update this map atomically.
   */
  private readonly workers = new Map<string, WorkerState>();

  /** Shutdown flag (prevents restart during shutdown) */
  private shutdownRequested = false;

  /** Health check timer (periodic heartbeat monitoring) */
  private healthCheckTimer?: NodeJS.Timeout;

  /** Total restart count (all workers, lifetime) */
  private totalRestarts = 0;

  constructor(config: PythonRuntimeManagerConfig) {
    super();

    this.config = config;
    this.logger = config.logger;

    // Initialize router with config
    this.router = new RuntimeRouter({
      enabled: config.workerCount > 1, // Enable multi-worker routing if > 1 worker
      workerCount: config.workerCount,
      routingStrategy: config.routingStrategy,
      healthCheckInterval: config.healthCheckInterval,
      workerRestartDelay: config.restartDelay,
      stickySessionEnabled: true, // Always enable sticky sessions for streaming
      stickySessionTTL: 300000, // 5 minutes
      logger: config.logger,
    });

    this.logger?.info(
      {
        workerCount: config.workerCount,
        pythonPath: config.pythonPath,
        runtimePath: config.runtimePath,
        maxRestarts: config.maxRestarts,
        routingStrategy: config.routingStrategy,
      },
      'PythonRuntimeManager initialized'
    );
  }

  /**
   * Start all worker processes
   *
   * Spawns N workers in parallel and waits for all to become ready.
   * Throws if any worker fails to start.
   */
  public async start(): Promise<void> {
    if (this.workers.size > 0) {
      throw new Error('Workers already started (call stop() first)');
    }

    this.shutdownRequested = false;

    this.logger?.info(
      { workerCount: this.config.workerCount },
      'Starting Python worker pool...'
    );

    // Start workers in parallel
    const startPromises: Promise<void>[] = [];

    for (let i = 0; i < this.config.workerCount; i++) {
      const workerId = randomUUID();
      startPromises.push(this.startWorker(workerId));
    }

    // Wait for all workers to start
    await Promise.all(startPromises);

    // Start health monitoring
    this.startHealthMonitoring();

    this.logger?.info(
      {
        workerCount: this.workers.size,
        activeWorkers: this.getActiveWorkerCount(),
      },
      'All workers started successfully'
    );

    this.emit('allWorkersReady');
  }

  /**
   * Stop all worker processes
   *
   * Gracefully stops all workers (drains in-flight requests, sends shutdown signal).
   * Waits up to shutdownTimeout for each worker to exit.
   */
  public async stop(): Promise<void> {
    this.shutdownRequested = true;

    // Stop health monitoring
    this.stopHealthMonitoring();

    this.logger?.info({ workerCount: this.workers.size }, 'Stopping all workers...');

    // Stop workers in parallel
    const stopPromises: Promise<void>[] = [];

    for (const workerId of Array.from(this.workers.keys())) {
      stopPromises.push(this.stopWorker(workerId));
    }

    await Promise.all(stopPromises);

    // Cleanup router
    this.router.cleanup();

    this.workers.clear();

    this.logger?.info('All workers stopped');
  }

  /**
   * Route request to worker
   *
   * Delegates to RuntimeRouter for intelligent load balancing.
   *
   * @param requestId - Optional request ID for logging
   * @param streamId - Optional stream ID for sticky sessions
   * @returns Selected worker or null if none available
   */
  public route(requestId?: string, streamId?: string): PythonWorker | null {
    return this.router.route(requestId, streamId);
  }

  /**
   * Get worker by ID
   *
   * @param workerId - Worker ID
   * @returns Worker state or undefined if not found
   */
  public getWorker(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Restart specific worker
   *
   * Stops the worker, waits restart delay, then starts a new worker.
   * Respects maxRestarts limit per worker.
   *
   * @param workerId - Worker ID to restart
   */
  public async restartWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    // Check restart limit
    if (worker.restartCount >= this.config.maxRestarts) {
      this.logger?.error(
        {
          workerId,
          restartCount: worker.restartCount,
          maxRestarts: this.config.maxRestarts,
        },
        'Worker exceeded max restarts, not restarting'
      );

      // Check if all workers are failed
      const activeWorkers = this.getActiveWorkerCount();
      if (activeWorkers === 0) {
        this.emit('allWorkersFailed');
      }

      return;
    }

    worker.restartCount++;
    this.totalRestarts++;

    this.logger?.info(
      {
        workerId,
        restartCount: worker.restartCount,
        maxRestarts: this.config.maxRestarts,
      },
      'Restarting worker...'
    );

    this.emit('workerRestart', workerId, worker.restartCount);

    // Stop old worker
    await this.stopWorker(workerId);

    // Exponential backoff: baseDelay * 2^(restartCount - 1)
    const backoffDelay = this.config.restartDelay * Math.pow(2, worker.restartCount - 1);
    await new Promise((resolve) => setTimeout(resolve, backoffDelay));

    // Check if shutdown was requested during delay
    if (this.shutdownRequested) {
      this.logger?.info({ workerId }, 'Shutdown requested during restart delay, aborting restart');
      return;
    }

    // Start new worker (reuse same workerId)
    await this.startWorker(workerId);

    this.logger?.info(
      {
        workerId,
        restartCount: worker.restartCount,
      },
      'Worker restarted successfully'
    );
  }

  /**
   * Mark worker as busy
   *
   * Called when request is dispatched to worker.
   * Delegates to RuntimeRouter.
   *
   * @param workerId - Worker ID
   */
  public markWorkerBusy(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to mark unknown worker as busy');
      return;
    }

    this.router.markWorkerBusy(workerId);
  }

  /**
   * Mark worker as idle
   *
   * Called when request completes.
   * Delegates to RuntimeRouter.
   *
   * @param workerId - Worker ID
   */
  public markWorkerIdle(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to mark unknown worker as idle');
      return;
    }

    this.router.markWorkerIdle(workerId);
  }

  /**
   * Get manager statistics
   *
   * @returns Current statistics
   */
  public getStats(): PythonRuntimeManagerStats {
    const workers = Array.from(this.workers.values());

    const totalWorkers = workers.length;
    const activeWorkers = workers.filter(
      (w) => w.status === 'idle' || w.status === 'busy'
    ).length;
    const startingWorkers = workers.filter((w) => w.status === 'starting').length;
    const failedWorkers = workers.filter((w) => w.status === 'failed').length;
    const stoppedWorkers = workers.filter((w) => w.status === 'stopped').length;

    return {
      totalWorkers,
      activeWorkers,
      startingWorkers,
      failedWorkers,
      stoppedWorkers,
      totalRestarts: this.totalRestarts,
      routerStats: this.router.getStats(),
    };
  }

  /**
   * Start individual worker
   *
   * Creates PythonRunner instance, registers with router, waits for ready event.
   *
   * @param workerId - Unique worker ID
   */
  private async startWorker(workerId: string): Promise<void> {
    const startTime = Date.now();

    // Create worker state
    const workerState: WorkerState = {
      id: workerId,
      pid: null,
      status: 'starting',
      runtime: null,
      restartCount: 0,
      lastHeartbeat: startTime,
      startedAt: startTime,
    };

    this.workers.set(workerId, workerState);

    this.logger?.debug({ workerId }, 'Starting worker...');

    // Create PythonRunner instance
    const runnerOptions: PythonRunnerOptions = {
      pythonPath: this.config.pythonPath,
      runtimePath: this.config.runtimePath,
      verbose: this.config.verbose,
      maxRestarts: 0, // We handle restarts at manager level
      startupTimeout: this.config.startupTimeout,
      logger: this.logger,
    };

    const runner = new PythonRunner(runnerOptions);
    workerState.runtime = runner;

    // Setup event handlers
    runner.on('ready', () => {
      this.handleWorkerReady(workerId);
    });

    runner.on('error', (error: Error) => {
      this.handleWorkerError(workerId, error);
    });

    runner.on('exit', (code: number | null) => {
      this.handleWorkerExit(workerId, code);
    });

    // Start runner (will throw on failure)
    try {
      await runner.start();

      // Update worker state
      const info = runner.getInfo();
      workerState.pid = info.pid;
      workerState.status = 'idle';
      workerState.lastHeartbeat = Date.now();

      // Register with router
      this.registerWorkerWithRouter(workerState);

      this.logger?.info(
        {
          workerId,
          pid: workerState.pid,
          startupTime: Date.now() - startTime,
        },
        'Worker started successfully'
      );
    } catch (error) {
      // Startup failed
      workerState.status = 'failed';
      workerState.error = error instanceof Error ? error.message : String(error);

      this.logger?.error(
        {
          workerId,
          error: workerState.error,
        },
        'Worker failed to start'
      );

      throw error;
    }
  }

  /**
   * Stop individual worker
   *
   * Unregisters from router, sends shutdown signal, waits for graceful exit.
   *
   * @param workerId - Worker ID
   */
  private async stopWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to stop unknown worker');
      return;
    }

    this.logger?.debug({ workerId, pid: worker.pid }, 'Stopping worker...');

    // Unregister from router
    this.router.unregisterWorker(workerId);

    // Stop runtime
    if (worker.runtime) {
      try {
        await Promise.race([
          worker.runtime.stop(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Worker shutdown timeout')),
              this.config.shutdownTimeout
            )
          ),
        ]);
      } catch (error) {
        this.logger?.warn(
          {
            workerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Worker shutdown failed or timed out'
        );
      }

      worker.runtime = null;
    }

    // Update state
    worker.status = 'stopped';
    worker.pid = null;

    this.logger?.debug({ workerId }, 'Worker stopped');
  }

  /**
   * Register worker with router
   *
   * Converts WorkerState to PythonWorker format expected by router.
   *
   * @param worker - Worker state
   */
  private registerWorkerWithRouter(worker: WorkerState): void {
    if (!worker.runtime || worker.pid === null) {
      this.logger?.warn({ workerId: worker.id }, 'Cannot register worker without runtime or PID');
      return;
    }

    const pythonWorker: PythonWorker = {
      id: worker.id,
      pid: worker.pid,
      status: 'idle',
      activeRequests: 0,
      totalRequests: 0,
      lastHeartbeat: worker.lastHeartbeat,
      startedAt: worker.startedAt,
      runtime: worker.runtime,
    };

    this.router.registerWorker(pythonWorker);

    this.logger?.debug({ workerId: worker.id, pid: worker.pid }, 'Worker registered with router');
  }

  /**
   * Handle worker ready event
   *
   * @param workerId - Worker ID
   */
  private handleWorkerReady(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }

    worker.status = 'idle';
    worker.lastHeartbeat = Date.now();

    this.logger?.debug({ workerId, pid: worker.pid }, 'Worker ready');

    this.emit('workerReady', workerId);
  }

  /**
   * Handle worker error event
   *
   * @param workerId - Worker ID
   * @param error - Error object
   */
  private handleWorkerError(workerId: string, error: Error): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }

    worker.error = error.message;

    this.logger?.error(
      {
        workerId,
        pid: worker.pid,
        error: error.message,
      },
      'Worker error'
    );

    this.emit('workerError', workerId, error);
  }

  /**
   * Handle worker exit event
   *
   * Triggers automatic restart if not during shutdown.
   *
   * @param workerId - Worker ID
   * @param code - Exit code
   */
  private handleWorkerExit(workerId: string, code: number | null): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return;
    }

    this.logger?.warn(
      {
        workerId,
        pid: worker.pid,
        code,
      },
      'Worker exited unexpectedly'
    );

    this.emit('workerExit', workerId, code);

    // Mark as failed
    worker.status = 'failed';
    this.router.markWorkerFailed(workerId);

    // Trigger automatic restart (if not shutting down)
    if (!this.shutdownRequested) {
      this.restartWorker(workerId).catch((err) => {
        this.logger?.error(
          {
            workerId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to restart worker after exit'
        );
      });
    }
  }

  /**
   * Start health monitoring
   *
   * Runs periodic heartbeat checks to detect stale workers.
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      return; // Already started
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);

    this.logger?.debug(
      { interval: this.config.healthCheckInterval },
      'Health monitoring started'
    );
  }

  /**
   * Stop health monitoring
   *
   * Clears health check timer.
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;

      this.logger?.debug('Health monitoring stopped');
    }
  }

  /**
   * Perform health check on all workers
   *
   * Checks heartbeat age and marks stale workers as failed.
   * Triggers automatic restart for failed workers.
   */
  private performHealthCheck(): void {
    const now = Date.now();

    for (const [workerId, worker] of Array.from(this.workers.entries())) {
      // Skip workers that are not active
      if (worker.status !== 'idle' && worker.status !== 'busy') {
        continue;
      }

      // Check heartbeat timeout
      const heartbeatAge = now - worker.lastHeartbeat;

      if (heartbeatAge > this.config.heartbeatTimeout) {
        this.logger?.error(
          {
            workerId,
            pid: worker.pid,
            heartbeatAge,
            heartbeatTimeout: this.config.heartbeatTimeout,
          },
          'Worker heartbeat timeout, marking as failed'
        );

        worker.status = 'failed';
        worker.error = `Heartbeat timeout (${heartbeatAge}ms > ${this.config.heartbeatTimeout}ms)`;

        this.router.markWorkerFailed(workerId);

        // Trigger automatic restart
        this.restartWorker(workerId).catch((err) => {
          this.logger?.error(
            {
              workerId,
              error: err instanceof Error ? err.message : String(err),
            },
            'Failed to restart worker after heartbeat timeout'
          );
        });
      }
    }
  }

  /**
   * Get active worker count
   *
   * @returns Number of workers with status 'idle' or 'busy'
   */
  private getActiveWorkerCount(): number {
    let count = 0;
    for (const worker of Array.from(this.workers.values())) {
      if (worker.status === 'idle' || worker.status === 'busy') {
        count++;
      }
    }
    return count;
  }
}
