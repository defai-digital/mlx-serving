/**
 * HTTP/2 Session Pool
 *
 * Manages a pool of HTTP/2 sessions for multiplexed streaming.
 * Handles session rotation, GOAWAY events, health monitoring, and
 * stream allocation across sessions.
 *
 * Phase 4.2 Implementation
 */

import http2 from 'http2';
import fs from 'fs';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { SessionManager, type SessionManagerConfig } from './SessionManager.js';
import type {
  Http2PoolOptions,
  Http2PoolStats,
  MultiplexedStreamHandle,
} from './types.js';

/**
 * Pool events
 */
export interface Http2PoolEvents {
  sessionCreated: (sessionId: string) => void;
  sessionRotated: (oldSessionId: string, newSessionId: string) => void;
  streamAcquired: (streamId: string, sessionId: string) => void;
  streamReleased: (streamId: string) => void;
  poolExhausted: () => void;
}

/**
 * HTTP/2 Session Pool
 *
 * Central pool manager for HTTP/2 multiplexed sessions.
 * Provides stream handles and manages session lifecycle.
 */
export class Http2Pool extends EventEmitter<Http2PoolEvents> {
  private options: Http2PoolOptions;
  private logger?: Logger;
  private sessionManager: SessionManager;
  private server?: http2.Http2SecureServer | http2.Http2Server;
  private streamHandles = new Map<string, MultiplexedStreamHandle>();
  private nextSessionId = 0;
  private initialized = false;
  private sessionCreatedHandler?: (id: string) => void;
  private sessionClosedHandler?: (id: string, reason: string) => void;

  constructor(options: Http2PoolOptions, logger?: Logger) {
    super();
    this.options = options;
    this.logger = logger;

    const sessionManagerConfig: SessionManagerConfig = {
      maxSessions: options.maxSessions,
      maxStreamsPerSession: options.maxStreamsPerSession,
      pingIntervalMs: options.pingIntervalMs,
      pingTimeoutMs: 5000, // 5 second ping timeout
    };

    this.sessionManager = new SessionManager(sessionManagerConfig, logger);
  }

  /**
   * Initialize the HTTP/2 server and create initial sessions
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger?.warn('Http2Pool already initialized, skipping');
      return;
    }

    // Remove old listeners if any (defensive)
    if (this.sessionCreatedHandler) {
      this.sessionManager.off('sessionCreated', this.sessionCreatedHandler);
    }
    if (this.sessionClosedHandler) {
      this.sessionManager.off('sessionClosed', this.sessionClosedHandler);
    }

    // Create HTTP/2 server
    this.server = this.createHttp2Server();

    // Start health checks
    this.sessionManager.startHealthChecks();

    // Store handlers for cleanup
    this.sessionCreatedHandler = (id) => {
      try {
        this.emit('sessionCreated', id);
      } catch (err) {
        this.logger?.error({ err }, 'Error emitting sessionCreated event');
      }
    };

    this.sessionClosedHandler = (id, reason) => {
      this.logger?.info({ sessionId: id, reason }, 'Session closed');
    };

    // Register event listeners
    this.sessionManager.on('sessionCreated', this.sessionCreatedHandler);
    this.sessionManager.on('sessionClosed', this.sessionClosedHandler);

    this.initialized = true;
    this.logger?.info(
      { maxSessions: this.options.maxSessions },
      'HTTP/2 pool initialized'
    );
  }

  /**
   * Acquire a stream handle for a request
   */
  public async acquireStream(streamId: string): Promise<MultiplexedStreamHandle | null> {
    const session = this.sessionManager.selectSession();

    if (!session) {
      // No available sessions, try to create one if under limit
      const stats = this.sessionManager.getStats();
      if (stats.totalSessions < this.options.maxSessions) {
        // Will be created on next HTTP/2 connection
        this.logger?.warn('No sessions available, waiting for client connection');
        try {
          this.emit('poolExhausted');
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting poolExhausted event');
        }
        return null;
      }

      this.logger?.error('Pool exhausted and at max sessions');
      return null;
    }

    // Create a new stream on the selected session
    // Note: In HTTP/2, streams are created by the server in response to client requests
    // This is a simplified implementation - in production, you'd integrate with the
    // actual request/response cycle

    const handle: MultiplexedStreamHandle = {
      sessionId: session.id,
      streamId: Date.now(), // Temporary - would be actual stream ID in production
      stream: null as unknown as MultiplexedStreamHandle['stream'], // Would be actual ServerHttp2Stream
      acquiredAt: Date.now(),
    };

    this.streamHandles.set(streamId, handle);
    this.sessionManager.incrementStreams(session.id);

    this.logger?.debug({ streamId, sessionId: session.id }, 'Stream acquired');

    try {
      this.emit('streamAcquired', streamId, session.id);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting streamAcquired event');
    }

    return handle;
  }

  /**
   * Release a stream back to the pool
   */
  public releaseStream(streamId: string): void {
    const handle = this.streamHandles.get(streamId);
    if (!handle) {
      return;
    }

    this.sessionManager.decrementStreams(handle.sessionId);
    this.streamHandles.delete(streamId);

    this.logger?.debug({ streamId, sessionId: handle.sessionId }, 'Stream released');

    try {
      this.emit('streamReleased', streamId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting streamReleased event');
    }
  }

  /**
   * Create HTTP/2 server (with or without TLS)
   */
  private createHttp2Server(): http2.Http2SecureServer | http2.Http2Server {
    if (this.options.tls) {
      // Create secure server with TLS
      const tlsOptions: http2.SecureServerOptions = {
        allowHTTP1: true, // Fallback support
      };

      if (this.options.tls.caFile) {
        tlsOptions.ca = fs.readFileSync(this.options.tls.caFile);
      }

      if (this.options.tls.certFile && this.options.tls.keyFile) {
        tlsOptions.cert = fs.readFileSync(this.options.tls.certFile);
        tlsOptions.key = fs.readFileSync(this.options.tls.keyFile);
      }

      if (this.options.tls.rejectUnauthorized !== undefined) {
        tlsOptions.rejectUnauthorized = this.options.tls.rejectUnauthorized;
      }

      const server = http2.createSecureServer(tlsOptions);

      server.on('session', (session) => {
        const sessionId = this.generateSessionId();
        this.sessionManager.registerSession(session, sessionId);
      });

      server.on('error', (err) => {
        this.logger?.error({ err }, 'HTTP/2 server error');
      });

      return server;
    } else {
      // Create insecure server (for development)
      const server = http2.createServer();

      server.on('session', (session) => {
        const sessionId = this.generateSessionId();
        this.sessionManager.registerSession(session, sessionId);
      });

      server.on('error', (err) => {
        this.logger?.error({ err }, 'HTTP/2 server error');
      });

      return server;
    }
  }

  /**
   * Rotate a session (close and create new)
   */
  public async rotateSession(sessionId: string): Promise<void> {
    this.logger?.info({ sessionId }, 'Rotating session');

    await this.sessionManager.drainSession(sessionId);

    // New session will be created on next client connection
    const newSessionId = this.generateSessionId();

    try {
      this.emit('sessionRotated', sessionId, newSessionId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting sessionRotated event');
    }
  }

  /**
   * Get pool statistics
   */
  public getStats(): Http2PoolStats {
    const sessionStats = this.sessionManager.getStats();

    const maxCapacity =
      this.options.maxSessions * this.options.maxStreamsPerSession;
    const utilizationPercent =
      maxCapacity > 0 ? (sessionStats.totalActiveStreams / maxCapacity) * 100 : 0;

    return {
      totalSessions: sessionStats.totalSessions,
      activeSessions: sessionStats.activeSessions,
      drainingSessions: sessionStats.drainingSessions,
      totalStreams: sessionStats.totalActiveStreams,
      utilizationPercent,
    };
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `http2-session-${this.nextSessionId++}`;
  }

  /**
   * Shutdown the pool
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    this.logger?.info('Shutting down HTTP/2 pool');

    // Cleanup listeners
    if (this.sessionCreatedHandler) {
      this.sessionManager.off('sessionCreated', this.sessionCreatedHandler);
    }
    if (this.sessionClosedHandler) {
      this.sessionManager.off('sessionClosed', this.sessionClosedHandler);
    }

    // Stop health checks
    this.sessionManager.stopHealthChecks();

    // Drain all sessions
    await this.sessionManager.shutdown();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    this.initialized = false;
    this.logger?.info('HTTP/2 pool shut down');
  }

  /**
   * Start listening on a port (for standalone server mode)
   */
  public listen(port: number, host = 'localhost'): Promise<void> {
    if (!this.server) {
      return Promise.reject(new Error('Server not initialized'));
    }

    return new Promise((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.logger?.info({ port, host }, 'HTTP/2 server listening');
        resolve();
      });

      this.server!.once('error', reject);
    });
  }
}
