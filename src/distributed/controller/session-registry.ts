/**
 * Session Registry
 *
 * Tracks session-to-worker affinity for sticky sessions.
 * Provides TTL-based expiration and automatic cleanup.
 */

import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Session entry with worker mapping and expiration
 */
interface SessionEntry {
  sessionId: string;
  workerId: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
}

/**
 * Session Registry configuration
 */
export interface SessionRegistryConfig {
  /** Session TTL in milliseconds (default: 30 minutes) */
  ttlMs: number;
  /** Cleanup interval in milliseconds (default: 1 minute) */
  cleanupIntervalMs: number;
}

/**
 * Session Registry statistics
 */
export interface SessionRegistryStats {
  totalSessions: number;
  activeSessions: number;
  expiredSessions: number;
  hitRate: number;
  totalLookups: number;
  totalHits: number;
  totalMisses: number;
}

/**
 * Session Registry
 *
 * Maps session IDs to worker IDs for sticky session support.
 * Automatically expires sessions after TTL and performs periodic cleanup.
 *
 * @example
 * ```typescript
 * const registry = new SessionRegistry({
 *   ttlMs: 1800000, // 30 minutes
 *   cleanupIntervalMs: 60000, // 1 minute
 * });
 *
 * // Set session affinity
 * registry.setSession('session-123', 'worker-abc');
 *
 * // Get worker for session
 * const workerId = registry.getSession('session-123');
 * ```
 */
export class SessionRegistry {
  private sessions: Map<string, SessionEntry> = new Map();
  private cleanupInterval?: NodeJS.Timeout;
  private logger: Logger;
  private config: SessionRegistryConfig;

  // Statistics
  private totalLookups = 0;
  private totalHits = 0;
  private totalMisses = 0;
  private expiredCount = 0;

  constructor(config: SessionRegistryConfig) {
    this.config = config;
    this.logger = createLogger('SessionRegistry');

    // Start automatic cleanup
    this.startCleanup();

    this.logger.info('Session registry initialized', {
      ttlMs: config.ttlMs,
      cleanupIntervalMs: config.cleanupIntervalMs,
    });
  }

  /**
   * Set session affinity
   *
   * Maps a session ID to a worker ID. The session will expire after TTL.
   *
   * @param sessionId - Session ID
   * @param workerId - Worker ID to route this session to
   */
  setSession(sessionId: string, workerId: string): void {
    const now = Date.now();
    const expiresAt = now + this.config.ttlMs;

    const entry: SessionEntry = {
      sessionId,
      workerId,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt,
    };

    this.sessions.set(sessionId, entry);

    this.logger.debug('Session created', {
      sessionId,
      workerId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /**
   * Get worker ID for session
   *
   * Returns the worker ID associated with this session, or undefined if:
   * - Session doesn't exist
   * - Session has expired
   *
   * @param sessionId - Session ID
   * @returns Worker ID or undefined
   */
  getSession(sessionId: string): string | undefined {
    this.totalLookups++;

    const entry = this.sessions.get(sessionId);

    if (!entry) {
      this.totalMisses++;
      this.logger.debug('Session not found', { sessionId });
      return undefined;
    }

    // Check if expired
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.totalMisses++;
      this.expiredCount++;
      this.sessions.delete(sessionId);
      this.logger.debug('Session expired', {
        sessionId,
        workerId: entry.workerId,
      });
      return undefined;
    }

    // Update last accessed time
    entry.lastAccessedAt = now;

    // Optionally extend TTL on access (sliding expiration)
    // entry.expiresAt = now + this.config.ttlMs;

    this.totalHits++;
    this.logger.debug('Session found', {
      sessionId,
      workerId: entry.workerId,
    });

    return entry.workerId;
  }

  /**
   * Remove session
   *
   * Explicitly removes a session from the registry.
   * Useful when a session is explicitly terminated.
   *
   * @param sessionId - Session ID
   * @returns true if session was removed, false if not found
   */
  removeSession(sessionId: string): boolean {
    const existed = this.sessions.has(sessionId);

    if (existed) {
      const entry = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);

      this.logger.debug('Session removed', {
        sessionId,
        workerId: entry?.workerId,
      });
    }

    return existed;
  }

  /**
   * Remove all sessions for a specific worker
   *
   * Useful when a worker goes offline or is removed from the cluster.
   *
   * @param workerId - Worker ID
   * @returns Number of sessions removed
   */
  removeSessionsByWorker(workerId: string): number {
    let removed = 0;

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.workerId === workerId) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info('Removed sessions for offline worker', {
        workerId,
        count: removed,
      });
    }

    return removed;
  }

  /**
   * Get all sessions for a worker
   *
   * @param workerId - Worker ID
   * @returns Array of session IDs
   */
  getSessionsByWorker(workerId: string): string[] {
    const sessions: string[] = [];

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.workerId === workerId) {
        sessions.push(sessionId);
      }
    }

    return sessions;
  }

  /**
   * Check if session exists and is valid
   *
   * @param sessionId - Session ID
   * @returns true if session exists and hasn't expired
   */
  hasSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);

    if (!entry) {
      return false;
    }

    const now = Date.now();
    return now < entry.expiresAt;
  }

  /**
   * Get session count
   *
   * @returns Total number of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get registry statistics
   *
   * @returns Session registry stats
   */
  getStats(): SessionRegistryStats {
    const activeSessions = this.sessions.size;
    const hitRate = this.totalLookups > 0 ? this.totalHits / this.totalLookups : 0;

    return {
      totalSessions: this.totalLookups,
      activeSessions,
      expiredSessions: this.expiredCount,
      hitRate,
      totalLookups: this.totalLookups,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
    };
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    const count = this.sessions.size;
    this.sessions.clear();

    this.logger.info('All sessions cleared', { count });
  }

  /**
   * Start automatic cleanup of expired sessions
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);

    this.logger.debug('Cleanup timer started', {
      intervalMs: this.config.cleanupIntervalMs,
    });
  }

  /**
   * Stop automatic cleanup
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      this.logger.debug('Cleanup timer stopped');
    }
  }

  /**
   * Cleanup expired sessions
   *
   * Removes all sessions that have passed their expiration time.
   *
   * @returns Number of sessions removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (now >= entry.expiresAt) {
        this.sessions.delete(sessionId);
        this.expiredCount++;
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info('Expired sessions cleaned up', {
        removed,
        remaining: this.sessions.size,
      });
    }

    return removed;
  }

  /**
   * Destroy session registry
   *
   * Stops cleanup and clears all sessions.
   */
  destroy(): void {
    this.stopCleanup();
    this.clear();
    this.logger.info('Session registry destroyed');
  }
}
