/**
 * Connection Pool
 *
 * Phase 3.1: Manages a pool of persistent connections to Python workers for reuse
 * instead of creating new connections per request.
 *
 * Purpose:
 * - Reduce connection overhead by reusing persistent IPC connections
 * - Improve utilization of Python worker pool
 * - Health check connections via periodic heartbeat
 * - Auto-replacement of dead connections
 * - Leak detection and statistics tracking
 *
 * Key Features:
 * - Lazy connection creation (create on demand up to max)
 * - Min/max pool size bounds with warmup support
 * - Health checks via heartbeat frames
 * - Idle timeout to close unused connections
 * - Connection reuse tracking for observability
 * - Automatic replacement of failed connections
 *
 * Architecture:
 * - PooledConnection: Per-connection state tracking
 * - acquire(): Get idle connection or create new (up to max)
 * - release(): Return connection to idle pool
 * - destroy(): Stop runtime and remove from pool
 * - Health checks run periodically to ping connections
 *
 * Thread Safety:
 * - Connections map is mutable (concurrent acquire/release/destroy)
 * - State updates are atomic (isAcquired flag before/after operations)
 * - Health checks are non-blocking (fire and forget)
 *
 * Graceful Degradation:
 * - If connection fails during acquire → create new or wait
 * - If health check fails → mark unhealthy, destroy and replace
 * - If idle timeout expires → destroy connection
 * - If pool below min → create replacement connections
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { PythonRunner } from './python-runner.js';
import type { PythonRunnerOptions } from './python-runner.js';

/**
 * Connection Pool Configuration
 */
export interface ConnectionPoolConfig {
  /** Enable connection pooling (default: true) */
  enabled: boolean;

  /** Minimum pool size (default: 2) */
  minConnections: number;

  /** Maximum pool size (default: 10) */
  maxConnections: number;

  /** Timeout to acquire connection (milliseconds, default: 5000) */
  acquireTimeoutMs: number;

  /** Idle connection timeout (milliseconds, default: 60000) */
  idleTimeoutMs: number;

  /** Health check interval (milliseconds, default: 30000) */
  healthCheckIntervalMs: number;

  /** Warmup on startup (default: true) */
  warmupOnStart: boolean;

  /** Logger instance */
  logger?: Logger;

  /** Python runner options (used to create new connections) */
  pythonOptions?: PythonRunnerOptions;
}

/**
 * Pooled Connection Interface
 */
export interface PooledConnection {
  /** Unique connection ID */
  id: string;

  /** Worker ID (for routing) */
  workerId: string;

  /** Python runtime instance */
  runtime: PythonRunner;

  /** Creation timestamp (milliseconds) */
  createdAt: number;

  /** Last used timestamp (milliseconds) */
  lastUsedAt: number;

  /** Use count (number of times acquired) */
  useCount: number;

  /** Health status */
  isHealthy: boolean;

  /** Acquisition status */
  isAcquired: boolean;
}

/**
 * Connection Pool Statistics
 */
export interface ConnectionPoolStats {
  /** Pool enabled status */
  enabled: boolean;

  /** Total connections (idle + acquired) */
  totalConnections: number;

  /** Idle connections */
  idleConnections: number;

  /** Acquired connections */
  acquiredConnections: number;

  /** Total acquire operations */
  totalAcquires: number;

  /** Total release operations */
  totalReleases: number;

  /** Total destroy operations */
  totalDestroys: number;

  /** Reuse rate (useCount / totalConnections) */
  reuseRate: number;

  /** Average acquire time (milliseconds) */
  avgAcquireTimeMs: number;

  /** Healthy connections */
  healthyConnections: number;

  /** Unhealthy connections */
  unhealthyConnections: number;
}

/**
 * Connection Pool Events
 */
export interface ConnectionPoolEvents {
  /** Connection created */
  connectionCreated: (connection: PooledConnection) => void;

  /** Connection destroyed */
  connectionDestroyed: (connectionId: string, reason: string) => void;

  /** Connection acquired */
  connectionAcquired: (connectionId: string) => void;

  /** Connection released */
  connectionReleased: (connectionId: string) => void;

  /** Health check failed */
  healthCheckFailed: (connectionId: string, error: Error) => void;

  /** Pool below minimum */
  poolBelowMin: (current: number, min: number) => void;

  /** Pool at capacity */
  poolAtCapacity: (current: number, max: number) => void;

  /** Acquire timeout */
  acquireTimeout: (timeoutMs: number) => void;
}

/**
 * Connection Pool
 *
 * Manages a pool of persistent Python runtime connections.
 */
export class ConnectionPool extends EventEmitter<ConnectionPoolEvents> {
  private config: ConnectionPoolConfig;
  private connections: Map<string, PooledConnection> = new Map();
  private waitQueue: Array<{
    resolve: (connection: PooledConnection) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    timestamp: number;
  }> = [];
  private started = false;
  private shutdownRequested = false;

  // Health check timer
  private healthCheckTimer: NodeJS.Timeout | null = null;

  // Idle timeout cleanup timer
  private idleCleanupTimer: NodeJS.Timeout | null = null;

  // Statistics tracking
  private totalAcquires = 0;
  private totalReleases = 0;
  private totalDestroys = 0;
  private acquireTimeSamples: number[] = [];

  constructor(config: ConnectionPoolConfig) {
    super();

    // Set defaults
    this.config = {
      enabled: config.enabled ?? true,
      minConnections: config.minConnections ?? 2,
      maxConnections: config.maxConnections ?? 10,
      acquireTimeoutMs: config.acquireTimeoutMs ?? 5000,
      idleTimeoutMs: config.idleTimeoutMs ?? 60000,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30000,
      warmupOnStart: config.warmupOnStart ?? true,
      logger: config.logger || undefined,
      pythonOptions: config.pythonOptions ?? {},
    };

    // Validate configuration
    if (this.config.minConnections < 0) {
      throw new Error('minConnections must be >= 0');
    }

    if (this.config.maxConnections < this.config.minConnections) {
      throw new Error('maxConnections must be >= minConnections');
    }

    if (this.config.acquireTimeoutMs <= 0) {
      throw new Error('acquireTimeoutMs must be > 0');
    }

    if (this.config.idleTimeoutMs <= 0) {
      throw new Error('idleTimeoutMs must be > 0');
    }

    if (this.config.healthCheckIntervalMs <= 0) {
      throw new Error('healthCheckIntervalMs must be > 0');
    }
  }

  /**
   * Start the connection pool
   *
   * Initializes the pool and optionally warms up minimum connections.
   */
  public async start(): Promise<void> {
    if (this.started) {
      throw new Error('ConnectionPool already started');
    }

    if (!this.config.enabled) {
      this.config.logger?.info('ConnectionPool disabled, skipping start');
      this.started = true;
      return;
    }

    this.started = true;
    this.shutdownRequested = false;

    this.config.logger?.info(
      {
        minConnections: this.config.minConnections,
        maxConnections: this.config.maxConnections,
        warmupOnStart: this.config.warmupOnStart,
      },
      'Starting ConnectionPool'
    );

    // Start health check timer
    this.startHealthChecks();

    // Start idle cleanup timer
    this.startIdleCleanup();

    // Warmup minimum connections if enabled
    if (this.config.warmupOnStart && this.config.minConnections > 0) {
      await this.warmup();
    }

    this.config.logger?.info('ConnectionPool started');
  }

  /**
   * Stop the connection pool
   *
   * Destroys all connections and stops background timers.
   */
  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.shutdownRequested = true;

    this.config.logger?.info('Stopping ConnectionPool');

    // Stop timers
    this.stopHealthChecks();
    this.stopIdleCleanup();

    // Reject all waiting acquires
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('ConnectionPool shutting down'));
    }
    this.waitQueue = [];

    // Destroy all connections
    const connectionIds = Array.from(this.connections.keys());
    for (const id of connectionIds) {
      const connection = this.connections.get(id);
      if (connection) {
        await this.destroyConnection(connection, 'pool shutdown');
      }
    }

    this.connections.clear();
    this.started = false;

    this.config.logger?.info('ConnectionPool stopped');
  }

  /**
   * Acquire a connection from the pool
   *
   * Returns an idle healthy connection if available, creates new if pool < max,
   * or waits for release if pool = max (up to acquireTimeout).
   *
   * @throws Error if timeout or pool disabled
   */
  public async acquire(): Promise<PooledConnection> {
    if (!this.config.enabled) {
      throw new Error('ConnectionPool is disabled');
    }

    if (!this.started || this.shutdownRequested) {
      throw new Error('ConnectionPool is not started');
    }

    const startTime = Date.now();

    // Try to get idle connection
    const idleConnection = this.getIdleConnection();
    if (idleConnection) {
      this.markAcquired(idleConnection);
      this.recordAcquireTime(Date.now() - startTime);
      return idleConnection;
    }

    // Try to create new connection if pool < max
    if (this.connections.size < this.config.maxConnections) {
      const connection = await this.createConnection();
      this.markAcquired(connection);
      this.recordAcquireTime(Date.now() - startTime);
      return connection;
    }

    // Pool at capacity, wait for release
    this.config.logger?.debug(
      { poolSize: this.connections.size, maxConnections: this.config.maxConnections },
      'Pool at capacity, waiting for release'
    );

    this.emit('poolAtCapacity', this.connections.size, this.config.maxConnections);

    return new Promise<PooledConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from wait queue
        const index = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }

        this.emit('acquireTimeout', this.config.acquireTimeoutMs);
        reject(
          new Error(
            `Failed to acquire connection within ${this.config.acquireTimeoutMs}ms (pool at capacity)`
          )
        );
      }, this.config.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timeout, timestamp: startTime });
    });
  }

  /**
   * Release a connection back to the pool
   *
   * Marks connection as not acquired and returns to idle pool.
   * If waiters exist, immediately re-acquire for next waiter.
   */
  public async release(connection: PooledConnection): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (!this.connections.has(connection.id)) {
      this.config.logger?.warn(
        { connectionId: connection.id },
        'Attempted to release unknown connection'
      );
      return;
    }

    // Update metadata
    connection.isAcquired = false;
    connection.lastUsedAt = Date.now();
    this.totalReleases++;

    this.config.logger?.debug(
      { connectionId: connection.id, useCount: connection.useCount },
      'Connection released'
    );

    this.emit('connectionReleased', connection.id);

    // If waiters exist, immediately acquire for next waiter
    const waiter = this.waitQueue.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.markAcquired(connection);
      this.recordAcquireTime(Date.now() - waiter.timestamp);
      waiter.resolve(connection);
    }
  }

  /**
   * Destroy a connection
   *
   * Stops Python runtime, removes from pool, and creates replacement if pool < min.
   */
  public async destroy(connection: PooledConnection): Promise<void> {
    await this.destroyConnection(connection, 'manual destroy');
  }

  /**
   * Get pool statistics
   */
  public getStats(): ConnectionPoolStats {
    let idleCount = 0;
    let acquiredCount = 0;
    let healthyCount = 0;
    let unhealthyCount = 0;
    let totalUseCount = 0;

    for (const connection of this.connections.values()) {
      if (connection.isAcquired) {
        acquiredCount++;
      } else {
        idleCount++;
      }

      if (connection.isHealthy) {
        healthyCount++;
      } else {
        unhealthyCount++;
      }

      totalUseCount += connection.useCount;
    }

    const reuseRate =
      this.connections.size > 0 ? totalUseCount / this.connections.size : 0;

    const avgAcquireTimeMs =
      this.acquireTimeSamples.length > 0
        ? this.acquireTimeSamples.reduce((a, b) => a + b, 0) / this.acquireTimeSamples.length
        : 0;

    return {
      enabled: this.config.enabled,
      totalConnections: this.connections.size,
      idleConnections: idleCount,
      acquiredConnections: acquiredCount,
      totalAcquires: this.totalAcquires,
      totalReleases: this.totalReleases,
      totalDestroys: this.totalDestroys,
      reuseRate,
      avgAcquireTimeMs,
      healthyConnections: healthyCount,
      unhealthyConnections: unhealthyCount,
    };
  }

  /**
   * Clean up idle connections
   *
   * Called by idle cleanup timer to destroy connections that haven't been used
   * for longer than idleTimeoutMs.
   */
  public cleanup(): void {
    if (!this.config.enabled || !this.started) {
      return;
    }

    const now = Date.now();
    const connectionIds = Array.from(this.connections.keys());

    for (const id of connectionIds) {
      const connection = this.connections.get(id);
      if (!connection || connection.isAcquired) {
        continue;
      }

      const idleMs = now - connection.lastUsedAt;
      if (idleMs > this.config.idleTimeoutMs) {
        this.config.logger?.debug(
          { connectionId: id, idleMs },
          'Connection idle timeout, destroying'
        );

        this.destroyConnection(connection, 'idle timeout').catch((err) => {
          this.config.logger?.error(
            { err, connectionId: id },
            'Error destroying idle connection'
          );
        });
      }
    }
  }

  /**
   * Warmup minimum connections
   *
   * Creates minConnections connections during startup.
   */
  private async warmup(): Promise<void> {
    this.config.logger?.info(
      { minConnections: this.config.minConnections },
      'Warming up connection pool'
    );

    const promises: Promise<PooledConnection>[] = [];
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createConnection());
    }

    try {
      await Promise.all(promises);
      this.config.logger?.info(
        { connections: this.connections.size },
        'Connection pool warmup complete'
      );
    } catch (err) {
      this.config.logger?.error({ err }, 'Error during connection pool warmup');
      throw err;
    }
  }

  /**
   * Get idle healthy connection from pool
   */
  private getIdleConnection(): PooledConnection | null {
    for (const connection of this.connections.values()) {
      if (!connection.isAcquired && connection.isHealthy) {
        return connection;
      }
    }
    return null;
  }

  /**
   * Mark connection as acquired
   */
  private markAcquired(connection: PooledConnection): void {
    connection.isAcquired = true;
    connection.useCount++;
    connection.lastUsedAt = Date.now();
    this.totalAcquires++;

    this.config.logger?.debug(
      { connectionId: connection.id, useCount: connection.useCount },
      'Connection acquired'
    );

    this.emit('connectionAcquired', connection.id);
  }

  /**
   * Record acquire time sample
   */
  private recordAcquireTime(timeMs: number): void {
    this.acquireTimeSamples.push(timeMs);

    // Keep last 100 samples for rolling average
    if (this.acquireTimeSamples.length > 100) {
      this.acquireTimeSamples.shift();
    }
  }

  /**
   * Create new connection
   */
  private async createConnection(): Promise<PooledConnection> {
    const id = randomUUID();
    const workerId = `worker-${id.slice(0, 8)}`;

    this.config.logger?.debug({ connectionId: id, workerId }, 'Creating new connection');

    // Create Python runtime
    const runtime = new PythonRunner({
      ...this.config.pythonOptions,
      logger: this.config.logger,
    });

    // Start runtime
    try {
      await runtime.start();
    } catch (err) {
      this.config.logger?.error({ err, connectionId: id }, 'Failed to start Python runtime');
      throw err;
    }

    const connection: PooledConnection = {
      id,
      workerId,
      runtime,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
      isHealthy: true,
      isAcquired: false,
    };

    this.connections.set(id, connection);

    this.config.logger?.info({ connectionId: id, workerId }, 'Connection created');

    this.emit('connectionCreated', connection);

    return connection;
  }

  /**
   * Destroy connection
   */
  private async destroyConnection(
    connection: PooledConnection,
    reason: string
  ): Promise<void> {
    this.config.logger?.debug(
      { connectionId: connection.id, reason },
      'Destroying connection'
    );

    // Remove from pool first
    this.connections.delete(connection.id);
    this.totalDestroys++;

    // Stop runtime
    try {
      await connection.runtime.stop();
    } catch (err) {
      this.config.logger?.error(
        { err, connectionId: connection.id },
        'Error stopping Python runtime'
      );
    }

    this.config.logger?.info({ connectionId: connection.id, reason }, 'Connection destroyed');

    this.emit('connectionDestroyed', connection.id, reason);

    // Create replacement if pool below minimum
    if (
      this.connections.size < this.config.minConnections &&
      !this.shutdownRequested &&
      this.started
    ) {
      this.config.logger?.debug(
        { current: this.connections.size, min: this.config.minConnections },
        'Pool below minimum, creating replacement connection'
      );

      this.emit('poolBelowMin', this.connections.size, this.config.minConnections);

      try {
        await this.createConnection();
      } catch (err) {
        this.config.logger?.error({ err }, 'Failed to create replacement connection');
      }
    }
  }

  /**
   * Start health check timer
   */
  private startHealthChecks(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks().catch((err) => {
        this.config.logger?.error({ err }, 'Error during health checks');
      });
    }, this.config.healthCheckIntervalMs);

    this.config.logger?.debug(
      { intervalMs: this.config.healthCheckIntervalMs },
      'Health checks started'
    );
  }

  /**
   * Stop health check timer
   */
  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.config.logger?.debug('Health checks stopped');
    }
  }

  /**
   * Start idle cleanup timer
   */
  private startIdleCleanup(): void {
    if (this.idleCleanupTimer) {
      return;
    }

    // Run cleanup every minute
    this.idleCleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000);

    this.config.logger?.debug('Idle cleanup started');
  }

  /**
   * Stop idle cleanup timer
   */
  private stopIdleCleanup(): void {
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
      this.config.logger?.debug('Idle cleanup stopped');
    }
  }

  /**
   * Perform health checks on all connections
   */
  private async performHealthChecks(): Promise<void> {
    const connectionIds = Array.from(this.connections.keys());

    for (const id of connectionIds) {
      const connection = this.connections.get(id);
      if (!connection) {
        continue;
      }

      // Skip acquired connections (in use)
      if (connection.isAcquired) {
        continue;
      }

      try {
        await this.healthCheckConnection(connection);
      } catch (err) {
        this.config.logger?.warn(
          { err, connectionId: id },
          'Health check failed, destroying connection'
        );

        this.emit('healthCheckFailed', id, err as Error);

        // Mark unhealthy and destroy
        connection.isHealthy = false;
        await this.destroyConnection(connection, 'health check failed');
      }
    }
  }

  /**
   * Health check a single connection
   *
   * Pings the Python runtime to verify it's responsive.
   */
  private async healthCheckConnection(connection: PooledConnection): Promise<void> {
    const transport = connection.runtime.getTransport();
    if (!transport) {
      throw new Error('Transport not available');
    }

    // Simple ping via runtime/info
    await transport.request('runtime/info', undefined, { timeout: 5000 });

    // If we get here, connection is healthy
    connection.isHealthy = true;
  }
}
