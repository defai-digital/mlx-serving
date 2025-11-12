/**
 * HTTP/2 Session Manager
 *
 * Manages lifecycle states of HTTP/2 sessions, load balancing,
 * health checks via ping/pong, and graceful session draining.
 *
 * Phase 4.2 Implementation
 */

import { EventEmitter } from 'eventemitter3';
import type { ServerHttp2Session } from 'http2';
import type { Logger } from 'pino';
import { SessionState, type ManagedSession } from './types.js';

/**
 * Session manager events
 */
export interface SessionManagerEvents {
  sessionCreated: (sessionId: string) => void;
  sessionDraining: (sessionId: string) => void;
  sessionClosed: (sessionId: string, reason: string) => void;
  healthCheckFailed: (sessionId: string) => void;
}

/**
 * Session Manager Configuration
 */
export interface SessionManagerConfig {
  maxSessions: number;
  maxStreamsPerSession: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
}

/**
 * HTTP/2 Session Manager
 *
 * Tracks session lifecycle, selects healthy sessions for load balancing,
 * and manages graceful session rotation.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private sessions = new Map<string, ManagedSession>();
  private config: SessionManagerConfig;
  private logger?: Logger;
  private pingTimer?: NodeJS.Timeout;

  constructor(config: SessionManagerConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Register a new session
   */
  public registerSession(session: ServerHttp2Session, sessionId: string): void {
    const managed: ManagedSession = {
      id: sessionId,
      session,
      state: SessionState.ACTIVE,
      activeStreams: 0,
      createdAt: Date.now(),
      lastPingAt: 0,
      lastPongAt: 0,
    };

    this.sessions.set(sessionId, managed);

    // Set up session event handlers
    session.on('close', () => {
      this.handleSessionClose(sessionId, 'close_event');
    });

    session.on('error', (err) => {
      this.logger?.error({ err, sessionId }, 'Session error');
      this.handleSessionClose(sessionId, 'error');
    });

    session.on('goaway', (errorCode) => {
      this.logger?.warn({ sessionId, errorCode }, 'Session received GOAWAY');
      this.drainSession(sessionId);
    });

    this.logger?.info({ sessionId, totalSessions: this.sessions.size }, 'Session registered');

    try {
      this.emit('sessionCreated', sessionId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting sessionCreated event');
    }
  }

  /**
   * Unregister a session
   */
  public unregisterSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return;
    }

    managed.state = SessionState.CLOSED;
    this.sessions.delete(sessionId);

    this.logger?.info({ sessionId, remainingSessions: this.sessions.size }, 'Session unregistered');
  }

  /**
   * Select a session for new stream allocation
   * Load balancing: least active streams among healthy sessions
   */
  public selectSession(): ManagedSession | null {
    const healthy = this.getHealthySessions();

    if (healthy.length === 0) {
      return null;
    }

    // Find session with fewest active streams
    let selected = healthy[0];
    for (const session of healthy) {
      if (session.activeStreams < selected.activeStreams) {
        selected = session;
      }
    }

    // Check capacity
    if (selected.activeStreams >= this.config.maxStreamsPerSession) {
      return null;
    }

    return selected;
  }

  /**
   * Get all healthy (active) sessions
   */
  public getHealthySessions(): ManagedSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === SessionState.ACTIVE
    );
  }

  /**
   * Begin draining a session (no new streams, wait for existing to finish)
   */
  public async drainSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return;
    }

    if (managed.state !== SessionState.ACTIVE) {
      return;
    }

    managed.state = SessionState.DRAINING;

    this.logger?.info(
      { sessionId, activeStreams: managed.activeStreams },
      'Session draining started'
    );

    try {
      this.emit('sessionDraining', sessionId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting sessionDraining event');
    }

    // Wait for active streams to finish (or timeout)
    const maxWaitMs = 30000; // 30 seconds
    const startTime = Date.now();

    while (managed.activeStreams > 0 && Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (managed.activeStreams > 0) {
      this.logger?.warn(
        { sessionId, remainingStreams: managed.activeStreams },
        'Session drain timeout, forcefully closing'
      );
    }

    this.closeSession(sessionId);
  }

  /**
   * Forcefully close a session
   */
  public closeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return;
    }

    if (!managed.session.closed) {
      managed.session.close();
    }

    this.unregisterSession(sessionId);
  }

  /**
   * Increment active stream count
   */
  public incrementStreams(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.activeStreams++;
    }
  }

  /**
   * Decrement active stream count
   */
  public decrementStreams(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.activeStreams = Math.max(0, managed.activeStreams - 1);
    }
  }

  /**
   * Start health check timer
   */
  public startHealthChecks(): void {
    if (this.pingTimer) {
      return;
    }

    this.pingTimer = setInterval(() => {
      this.checkAllSessions();
    }, this.config.pingIntervalMs);
  }

  /**
   * Stop health check timer
   */
  public stopHealthChecks(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  /**
   * Check health of all active sessions
   */
  private checkAllSessions(): void {
    for (const managed of this.getHealthySessions()) {
      void this.pingSession(managed);
    }
  }

  /**
   * Ping a session to check health
   */
  private async pingSession(managed: ManagedSession): Promise<void> {
    const { id, session } = managed;

    managed.lastPingAt = Date.now();

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Ping timeout'));
        }, this.config.pingTimeoutMs);

        session.ping((err) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      managed.lastPongAt = Date.now();
    } catch (err) {
      this.logger?.warn({ err, sessionId: id }, 'Ping failed');

      try {
        this.emit('healthCheckFailed', id);
      } catch (emitErr) {
        this.logger?.error({ err: emitErr }, 'Error emitting healthCheckFailed event');
      }

      // Drain unhealthy session
      void this.drainSession(id);
    }
  }

  /**
   * Handle session close event
   */
  private handleSessionClose(sessionId: string, reason: string): void {
    this.logger?.info({ sessionId, reason }, 'Session closed');

    try {
      this.emit('sessionClosed', sessionId, reason);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting sessionClosed event');
    }

    this.unregisterSession(sessionId);
  }

  /**
   * Get statistics
   */
  public getStats(): {
    totalSessions: number;
    activeSessions: number;
    drainingSessions: number;
    totalActiveStreams: number;
  } {
    let activeSessions = 0;
    let drainingSessions = 0;
    let totalActiveStreams = 0;

    for (const managed of this.sessions.values()) {
      if (managed.state === SessionState.ACTIVE) {
        activeSessions++;
      } else if (managed.state === SessionState.DRAINING) {
        drainingSessions++;
      }
      totalActiveStreams += managed.activeStreams;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      drainingSessions,
      totalActiveStreams,
    };
  }

  /**
   * Shutdown all sessions
   */
  public async shutdown(): Promise<void> {
    this.stopHealthChecks();

    const drainPromises = Array.from(this.sessions.keys()).map((id) =>
      this.drainSession(id)
    );

    await Promise.all(drainPromises);
  }
}
