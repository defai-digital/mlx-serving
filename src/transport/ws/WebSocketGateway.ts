/**
 * WebSocket Gateway
 *
 * Bidirectional fallback transport for clients requiring control channel
 * or where HTTP/2 is unavailable. Includes frame size limits, heartbeat
 * handling, and integration with StreamingController.
 *
 * Phase 4.2 Implementation
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type { WsMessage } from '../http2/types.js';

/**
 * WebSocket Gateway Configuration
 */
export interface WebSocketGatewayConfig {
  maxConnections: number;
  maxFrameSizeBytes: number;
  idleTimeoutMs: number;
  heartbeatIntervalMs: number;
}

/**
 * WebSocket connection metadata
 */
interface WsConnection {
  id: string;
  ws: WebSocket;
  streamIds: Set<string>;
  lastActivity: number;
  messageCount: number;
}

/**
 * Gateway events
 */
export interface WebSocketGatewayEvents {
  connectionOpened: (connectionId: string) => void;
  connectionClosed: (connectionId: string) => void;
  messageReceived: (connectionId: string, message: WsMessage) => void;
  controlMessage: (connectionId: string, payload: unknown) => void;
  heartbeatTimeout: (connectionId: string) => void;
}

/**
 * WebSocket Gateway
 *
 * Manages WebSocket connections as fallback transport when HTTP/2
 * is unavailable or for bidirectional control channels.
 */
export class WebSocketGateway extends EventEmitter<WebSocketGatewayEvents> {
  private config: WebSocketGatewayConfig;
  private logger?: Logger;
  private wss?: WebSocketServer;
  private connections = new Map<string, WsConnection>();
  private nextConnectionId = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: WebSocketGatewayConfig, logger?: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Initialize the WebSocket server
   */
  public initialize(server?: any): void {
    this.wss = new WebSocketServer({
      server: server as any, // Attach to existing HTTP server if provided
      perMessageDeflate: false, // Disable compression for lower latency
      maxPayload: this.config.maxFrameSizeBytes,
    });

    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleConnection(ws, request);
    });

    this.wss.on('error', (err: Error) => {
      this.logger?.error({ err }, 'WebSocket server error');
    });

    // Start heartbeat monitoring
    this.startHeartbeat();

    // Start cleanup of idle connections
    this.startCleanup();

    this.logger?.info('WebSocket gateway initialized');
  }

  /**
   * Handle new WebSocket connection
   */
  public handleConnection(ws: WebSocket, request: IncomingMessage): void {
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      this.logger?.warn('WebSocket connection limit reached, rejecting');
      ws.close(1008, 'Connection limit reached');
      return;
    }

    const connectionId = this.generateConnectionId();
    const connection: WsConnection = {
      id: connectionId,
      ws,
      streamIds: new Set(),
      lastActivity: Date.now(),
      messageCount: 0,
    };

    this.connections.set(connectionId, connection);

    // Set up event handlers
    ws.on('message', (data: unknown) => {
      this.handleMessage(connectionId, data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(connectionId, code, reason.toString());
    });

    ws.on('error', (err: Error) => {
      this.logger?.error({ err, connectionId }, 'WebSocket connection error');
      this.closeConnection(connectionId, 1011, 'Internal error');
    });

    ws.on('pong', () => {
      this.handlePong(connectionId);
    });

    this.logger?.info(
      { connectionId, totalConnections: this.connections.size },
      'WebSocket connection opened'
    );

    try {
      this.emit('connectionOpened', connectionId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting connectionOpened event');
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(connectionId: string, data: unknown): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.lastActivity = Date.now();
    connection.messageCount++;

    let message: WsMessage;
    try {
      const dataStr = typeof data === 'string' ? data : String(data);
      message = JSON.parse(dataStr);
    } catch (err) {
      this.logger?.warn({ err, connectionId }, 'Invalid WebSocket message format');
      this.sendError(connectionId, 'Invalid message format');
      return;
    }

    // Validate message structure
    if (!message.type) {
      this.sendError(connectionId, 'Missing message type');
      return;
    }

    // Handle message based on type
    switch (message.type) {
      case 'ping':
        this.handlePing(connectionId);
        break;

      case 'control':
        try {
          this.emit('controlMessage', connectionId, message.payload);
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting controlMessage event');
        }
        break;

      case 'data':
        // Data messages handled by StreamingController
        try {
          this.emit('messageReceived', connectionId, message);
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting messageReceived event');
        }
        break;

      default:
        this.logger?.warn({ type: message.type, connectionId }, 'Unknown message type');
        this.sendError(connectionId, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Send a chunk to a specific connection
   */
  public async sendChunk(
    connectionId: string,
    streamId: string,
    chunk: Uint8Array | string
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const message: WsMessage = {
      type: 'data',
      streamId,
      payload: chunk,
    };

    try {
      connection.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger?.error({ err, connectionId, streamId }, 'Error sending chunk');
      throw err;
    }
  }

  /**
   * Handle ping message
   */
  private handlePing(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const message = {
      type: 'pong',
      payload: null,
    };

    connection.ws.send(JSON.stringify(message));
  }

  /**
   * Handle pong response
   */
  private handlePong(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  /**
   * Close a connection
   */
  public closeConnection(connectionId: string, code: number, reason: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(code, reason);
    }

    this.connections.delete(connectionId);

    this.logger?.info({ connectionId, code, reason }, 'WebSocket connection closed');

    try {
      this.emit('connectionClosed', connectionId);
    } catch (err) {
      this.logger?.error({ err }, 'Error emitting connectionClosed event');
    }
  }

  /**
   * Handle connection close event
   */
  private handleClose(connectionId: string, code: number, reason: string): void {
    this.closeConnection(connectionId, code, reason);
  }

  /**
   * Send error message to client
   */
  private sendError(connectionId: string, error: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const message = {
      type: 'error',
      error,
    };

    try {
      connection.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger?.error({ err, connectionId }, 'Error sending error message');
    }
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Send heartbeat pings to all connections
   */
  private sendHeartbeats(): void {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.ping();
      }
    }
  }

  /**
   * Start cleanup of idle connections
   */
  private startCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections();
    }, 60000); // Check every minute
  }

  /**
   * Clean up idle connections
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();

    for (const [connectionId, connection] of this.connections.entries()) {
      const idleTime = now - connection.lastActivity;

      if (idleTime >= this.config.idleTimeoutMs) {
        this.logger?.info({ connectionId, idleTime }, 'Closing idle connection');

        try {
          this.emit('heartbeatTimeout', connectionId);
        } catch (err) {
          this.logger?.error({ err }, 'Error emitting heartbeatTimeout event');
        }

        this.closeConnection(connectionId, 1000, 'Idle timeout');
      }
    }
  }

  /**
   * Generate unique connection ID
   */
  private generateConnectionId(): string {
    return `ws-${this.nextConnectionId++}`;
  }

  /**
   * Get statistics
   */
  public getStats(): {
    totalConnections: number;
    activeConnections: number;
    totalMessages: number;
  } {
    let totalMessages = 0;
    let activeConnections = 0;

    for (const connection of this.connections.values()) {
      totalMessages += connection.messageCount;
      if (connection.ws.readyState === WebSocket.OPEN) {
        activeConnections++;
      }
    }

    return {
      totalConnections: this.connections.size,
      activeConnections,
      totalMessages,
    };
  }

  /**
   * Shutdown the gateway
   */
  public async shutdown(): Promise<void> {
    this.logger?.info('Shutting down WebSocket gateway');

    // Stop timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Close all connections
    for (const [connectionId] of this.connections.entries()) {
      this.closeConnection(connectionId, 1001, 'Server shutdown');
    }

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    this.logger?.info('WebSocket gateway shut down');
  }
}
