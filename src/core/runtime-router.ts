/**
 * Runtime Router
 *
 * Intelligent routing of requests across multiple Python worker processes.
 * Supports round-robin and least-busy strategies with sticky session affinity
 * for streaming requests.
 *
 * Architecture:
 * - WorkerRoutingStrategy: Pluggable routing algorithms (round-robin, least-busy)
 * - Sticky Sessions: Map streamId → workerId for streaming affinity
 * - Health Tracking: Monitor worker status and heartbeats
 * - Statistics: Per-worker request counts, sticky session hit rate
 *
 * Thread Safety:
 * - route() called concurrently from multiple requests
 * - Workers map is mutable (add/remove workers)
 * - Sticky session map updated atomically
 *
 * Graceful Degradation:
 * - If sticky worker unavailable → select new worker, update mapping
 * - If no workers available → return null (caller handles backpressure)
 * - If all workers busy → still route (backpressure handled upstream)
 */

import type { Logger } from 'pino';

/**
 * Python worker state
 *
 * Represents a single Python runtime process in the worker pool.
 */
export interface PythonWorker {
  /** Unique worker ID (e.g., "worker-1") */
  id: string;

  /** Process ID */
  pid: number;

  /** Worker status */
  status: 'idle' | 'busy' | 'failed' | 'starting';

  /** Active request count */
  activeRequests: number;

  /** Total requests processed (lifetime) */
  totalRequests: number;

  /** Last heartbeat timestamp (milliseconds since epoch) */
  lastHeartbeat: number;

  /** Worker start time (milliseconds since epoch) */
  startedAt: number;

  /** Reference to underlying Python runtime (PythonRunner or similar) */
  runtime: unknown; // Type to be defined by PythonRuntimeManager
}

/**
 * Runtime router configuration
 */
export interface RuntimeRouterConfig {
  /** Enable multi-worker routing (default: false) */
  enabled: boolean;

  /** Number of worker processes (default: 3) */
  workerCount: number;

  /** Routing strategy: 'round-robin' or 'least-busy' (default: 'round-robin') */
  routingStrategy: 'round-robin' | 'least-busy';

  /** Health check interval (milliseconds, default: 5000) */
  healthCheckInterval: number;

  /** Worker restart delay (milliseconds, default: 1000) */
  workerRestartDelay: number;

  /** Enable sticky sessions for streaming (default: true) */
  stickySessionEnabled: boolean;

  /** Sticky session TTL (milliseconds, default: 300000 = 5 minutes) */
  stickySessionTTL: number;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Worker routing strategy interface
 *
 * Implementations:
 * - RoundRobinStrategy: Simple round-robin distribution
 * - LeastBusyStrategy: Route to worker with fewest active requests
 */
export interface WorkerRoutingStrategy {
  /**
   * Select next worker for request
   *
   * @param workers - Available workers (filtered to healthy only)
   * @param requestId - Optional request ID for logging
   * @returns Selected worker or null if none available
   */
  selectWorker(workers: PythonWorker[], requestId?: string): PythonWorker | null;
}

/**
 * Routing statistics
 */
export interface RuntimeRouterStats {
  /** Whether routing is enabled */
  enabled: boolean;

  /** Total worker count (including failed) */
  totalWorkers: number;

  /** Active worker count (status !== 'failed') */
  activeWorkers: number;

  /** Failed worker count */
  failedWorkers: number;

  /** Total requests routed */
  totalRequests: number;

  /** Current routing strategy */
  routingStrategy: string;

  /** Per-worker active request counts */
  workerUtilization: number[];

  /** Sticky session hit rate (0-1) */
  stickySessionHitRate: number;
}

/**
 * Sticky session entry (internal)
 *
 * Maps streamId → workerId with expiration tracking.
 */
interface StickySessionEntry {
  workerId: string;
  expiresAt: number;
  createdAt: number;
}

/**
 * Round-Robin Routing Strategy
 *
 * Distributes requests evenly across workers using a simple counter.
 * Thread-safe through atomic counter increments.
 */
class RoundRobinStrategy implements WorkerRoutingStrategy {
  private counter = 0;

  selectWorker(workers: PythonWorker[]): PythonWorker | null {
    if (workers.length === 0) {
      return null;
    }

    // Simple modulo rotation
    const index = this.counter % workers.length;
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER; // Prevent overflow

    return workers[index] ?? null;
  }
}

/**
 * Least-Busy Routing Strategy
 *
 * Routes to worker with fewest active requests.
 * Breaks ties using round-robin counter.
 */
class LeastBusyStrategy implements WorkerRoutingStrategy {
  private tieBreaker = 0;

  selectWorker(workers: PythonWorker[]): PythonWorker | null {
    if (workers.length === 0) {
      return null;
    }

    // Find minimum active request count
    let minActive = Number.MAX_SAFE_INTEGER;
    const candidates: PythonWorker[] = [];

    for (const worker of workers) {
      if (worker.activeRequests < minActive) {
        minActive = worker.activeRequests;
        candidates.length = 0;
        candidates.push(worker);
      } else if (worker.activeRequests === minActive) {
        candidates.push(worker);
      }
    }

    // Tie-breaker: round-robin among candidates
    if (candidates.length === 0) {
      return null;
    }

    const index = this.tieBreaker % candidates.length;
    this.tieBreaker = (this.tieBreaker + 1) % Number.MAX_SAFE_INTEGER;

    return candidates[index] ?? null;
  }
}

/**
 * Runtime Router
 *
 * Routes requests to healthy Python workers with configurable strategies.
 * Supports sticky sessions for streaming requests and automatic failover.
 */
export class RuntimeRouter {
  private readonly config: RuntimeRouterConfig;
  private readonly logger?: Logger;
  private readonly strategy: WorkerRoutingStrategy;

  /**
   * Worker registry
   *
   * IMPORTANT: This is a mutable map updated by PythonRuntimeManager.
   * Workers can be added, removed, or have their status changed at any time.
   */
  private readonly workers = new Map<string, PythonWorker>();

  /**
   * Stream -> Worker affinity map (for sticky sessions)
   *
   * Maps streamId → workerId with TTL expiration.
   * Enables streaming requests to maintain worker affinity.
   */
  private readonly streamAffinity = new Map<string, StickySessionEntry>();

  /**
   * Statistics counters
   *
   * Tracked across all routing decisions for observability.
   */
  private stats = {
    totalRequests: 0,
    stickySessionHits: 0,
    stickySessionMisses: 0,
  };

  /**
   * Cleanup timer for expired sticky sessions
   *
   * Runs periodically to prevent memory leaks.
   */
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: RuntimeRouterConfig) {
    this.config = config;
    this.logger = config.logger;

    // Initialize routing strategy
    this.strategy = this.createStrategy(config.routingStrategy);

    // Start cleanup timer for sticky sessions
    if (config.enabled && config.stickySessionEnabled) {
      this.startCleanupTimer();
    }

    this.logger?.info(
      {
        enabled: config.enabled,
        workerCount: config.workerCount,
        strategy: config.routingStrategy,
        stickySessionEnabled: config.stickySessionEnabled,
        stickySessionTTL: config.stickySessionTTL,
      },
      'RuntimeRouter initialized'
    );
  }

  /**
   * Route request to appropriate worker
   *
   * Algorithm:
   * 1. Check sticky session (if streamId provided and enabled)
   * 2. If sticky worker unavailable, select new worker via strategy
   * 3. Establish new sticky session if streaming
   * 4. Return selected worker or null if none available
   *
   * Thread Safety:
   * - Workers map is read-only during routing (mutations external)
   * - Sticky session map updated atomically (Map operations are atomic)
   *
   * @param requestId - Optional request ID for logging
   * @param streamId - Optional stream ID for sticky sessions
   * @returns Selected worker or null if none available
   */
  public route(requestId?: string, streamId?: string): PythonWorker | null {
    if (!this.config.enabled) {
      // Routing disabled → return first available worker (fallback)
      const workers = Array.from(this.workers.values());
      return workers[0] ?? null;
    }

    this.stats.totalRequests++;

    // Step 1: Check sticky session (streaming affinity)
    if (streamId && this.config.stickySessionEnabled) {
      const session = this.streamAffinity.get(streamId);

      if (session) {
        const now = Date.now();

        // Check expiration
        if (now >= session.expiresAt) {
          this.logger?.debug({ streamId, workerId: session.workerId }, 'Sticky session expired');
          this.streamAffinity.delete(streamId);
          this.stats.stickySessionMisses++;
        } else {
          // Session valid → check worker availability
          const worker = this.workers.get(session.workerId);

          if (worker && worker.status !== 'failed') {
            // Sticky session hit!
            this.stats.stickySessionHits++;
            this.logger?.debug(
              {
                requestId,
                streamId,
                workerId: worker.id,
                age: now - session.createdAt,
              },
              'Sticky session hit'
            );
            return worker;
          } else {
            // Worker unavailable → remove session, select new worker
            this.logger?.warn(
              {
                requestId,
                streamId,
                workerId: session.workerId,
                workerStatus: worker?.status ?? 'not-found',
              },
              'Sticky session miss (worker unavailable)'
            );
            this.streamAffinity.delete(streamId);
            this.stats.stickySessionMisses++;
          }
        }
      }
    }

    // Step 2: Select worker using strategy
    const healthyWorkers = Array.from(this.workers.values()).filter(
      (w) => w.status !== 'failed' && w.status !== 'starting'
    );

    if (healthyWorkers.length === 0) {
      this.logger?.warn({ requestId, streamId }, 'No healthy workers available for routing');
      return null;
    }

    const selectedWorker = this.strategy.selectWorker(healthyWorkers, requestId);

    if (!selectedWorker) {
      this.logger?.error(
        { requestId, streamId, strategy: this.config.routingStrategy },
        'Worker selection strategy returned null (unexpected)'
      );
      return null;
    }

    // Step 3: Establish sticky session (if streaming)
    if (streamId && this.config.stickySessionEnabled) {
      const now = Date.now();
      const session: StickySessionEntry = {
        workerId: selectedWorker.id,
        expiresAt: now + this.config.stickySessionTTL,
        createdAt: now,
      };

      this.streamAffinity.set(streamId, session);

      this.logger?.debug(
        {
          requestId,
          streamId,
          workerId: selectedWorker.id,
          ttl: this.config.stickySessionTTL,
        },
        'Sticky session established'
      );
    }

    this.logger?.debug(
      {
        requestId,
        streamId,
        workerId: selectedWorker.id,
        strategy: this.config.routingStrategy,
        activeRequests: selectedWorker.activeRequests,
      },
      'Request routed to worker'
    );

    return selectedWorker;
  }

  /**
   * Register worker
   *
   * Called by PythonRuntimeManager when a new worker is spawned.
   *
   * @param worker - Worker to register
   */
  public registerWorker(worker: PythonWorker): void {
    this.workers.set(worker.id, worker);
    this.logger?.info({ workerId: worker.id, pid: worker.pid }, 'Worker registered');
  }

  /**
   * Unregister worker
   *
   * Called by PythonRuntimeManager when a worker is stopped or removed.
   * Cleans up sticky sessions for this worker.
   *
   * @param workerId - Worker ID to unregister
   */
  public unregisterWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to unregister unknown worker');
      return;
    }

    this.workers.delete(workerId);

    // Cleanup sticky sessions for this worker
    const affectedStreams: string[] = [];
    for (const [streamId, session] of Array.from(this.streamAffinity.entries())) {
      if (session.workerId === workerId) {
        affectedStreams.push(streamId);
      }
    }

    for (const streamId of affectedStreams) {
      this.streamAffinity.delete(streamId);
    }

    this.logger?.info(
      {
        workerId,
        pid: worker.pid,
        affectedStreams: affectedStreams.length,
      },
      'Worker unregistered'
    );
  }

  /**
   * Mark worker as busy
   *
   * Called when a request is dispatched to a worker.
   * Increments activeRequests counter.
   *
   * @param workerId - Worker ID
   */
  public markWorkerBusy(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to mark unknown worker as busy');
      return;
    }

    worker.activeRequests++;
    worker.totalRequests++;
    worker.status = 'busy';
    worker.lastHeartbeat = Date.now();

    this.logger?.debug(
      {
        workerId,
        activeRequests: worker.activeRequests,
        totalRequests: worker.totalRequests,
      },
      'Worker marked busy'
    );
  }

  /**
   * Mark worker as idle
   *
   * Called when a request completes.
   * Decrements activeRequests counter.
   *
   * @param workerId - Worker ID
   */
  public markWorkerIdle(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to mark unknown worker as idle');
      return;
    }

    worker.activeRequests = Math.max(0, worker.activeRequests - 1);
    worker.status = worker.activeRequests > 0 ? 'busy' : 'idle';
    worker.lastHeartbeat = Date.now();

    this.logger?.debug(
      {
        workerId,
        activeRequests: worker.activeRequests,
        status: worker.status,
      },
      'Worker marked idle'
    );
  }

  /**
   * Mark worker as failed
   *
   * Called when a worker crashes or becomes unresponsive.
   * Removes sticky sessions for this worker.
   *
   * @param workerId - Worker ID
   */
  public markWorkerFailed(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      this.logger?.warn({ workerId }, 'Attempted to mark unknown worker as failed');
      return;
    }

    worker.status = 'failed';

    // Cleanup sticky sessions for this worker
    const affectedStreams: string[] = [];
    for (const [streamId, session] of Array.from(this.streamAffinity.entries())) {
      if (session.workerId === workerId) {
        affectedStreams.push(streamId);
      }
    }

    for (const streamId of affectedStreams) {
      this.streamAffinity.delete(streamId);
    }

    this.logger?.warn(
      {
        workerId,
        activeRequests: worker.activeRequests,
        affectedStreams: affectedStreams.length,
      },
      'Worker marked failed'
    );
  }

  /**
   * Get routing statistics
   *
   * @returns Current statistics
   */
  public getStats(): RuntimeRouterStats {
    const workers = Array.from(this.workers.values());
    const activeWorkers = workers.filter((w) => w.status !== 'failed');
    const failedWorkers = workers.filter((w) => w.status === 'failed');

    const total = this.stats.stickySessionHits + this.stats.stickySessionMisses;
    const stickySessionHitRate = total > 0 ? this.stats.stickySessionHits / total : 0;

    const workerUtilization = workers.map((w) => w.activeRequests);

    return {
      enabled: this.config.enabled,
      totalWorkers: workers.length,
      activeWorkers: activeWorkers.length,
      failedWorkers: failedWorkers.length,
      totalRequests: this.stats.totalRequests,
      routingStrategy: this.config.routingStrategy,
      workerUtilization,
      stickySessionHitRate,
    };
  }

  /**
   * Cleanup resources
   *
   * Stops timers, clears sticky sessions, removes workers.
   * Safe to call multiple times.
   */
  public cleanup(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Clear sticky sessions
    this.streamAffinity.clear();

    // Clear workers (don't stop them, that's PythonRuntimeManager's job)
    this.workers.clear();

    this.logger?.debug('RuntimeRouter cleaned up');
  }

  /**
   * Create routing strategy instance
   *
   * @param strategyName - Strategy name from config
   * @returns Strategy instance
   */
  private createStrategy(strategyName: 'round-robin' | 'least-busy'): WorkerRoutingStrategy {
    switch (strategyName) {
      case 'round-robin':
        return new RoundRobinStrategy();
      case 'least-busy':
        return new LeastBusyStrategy();
      default:
        this.logger?.warn(
          { strategyName },
          'Unknown routing strategy, defaulting to round-robin'
        );
        return new RoundRobinStrategy();
    }
  }

  /**
   * Start cleanup timer for expired sticky sessions
   *
   * Runs every 30 seconds to prevent memory leaks.
   */
  private startCleanupTimer(): void {
    // Cleanup every 30 seconds
    const CLEANUP_INTERVAL_MS = 30000;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);

    this.logger?.debug(
      { intervalMs: CLEANUP_INTERVAL_MS },
      'Sticky session cleanup timer started'
    );
  }

  /**
   * Cleanup expired sticky sessions
   *
   * Called periodically by cleanup timer.
   * Removes sessions where current time >= expiresAt.
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let expired = 0;

    for (const [streamId, session] of Array.from(this.streamAffinity.entries())) {
      if (now >= session.expiresAt) {
        this.streamAffinity.delete(streamId);
        expired++;
      }
    }

    if (expired > 0) {
      this.logger?.debug(
        { expired, remaining: this.streamAffinity.size },
        'Cleaned up expired sticky sessions'
      );
    }
  }
}
