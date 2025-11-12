/**
 * WebSocket Server
 *
 * WebSocket support for streaming inference responses.
 * Provides real-time bidirectional communication for token streaming.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { ControllerNode } from './controller-node.js';
import type { InferenceRequest } from '../types/messages.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

/**
 * WebSocket message types
 */
interface WsInferenceMessage {
  type: 'inference';
  data: {
    model: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

interface WsTokenMessage {
  type: 'token';
  data: {
    token: string;
    index: number;
  };
}

interface WsDoneMessage {
  type: 'done';
  data: {
    totalTokens: number;
    latencyMs: number;
  };
}

interface WsErrorMessage {
  type: 'error';
  data: {
    error: string;
  };
}

type WsMessage = WsInferenceMessage | WsTokenMessage | WsDoneMessage | WsErrorMessage;

/**
 * WebSocket Server
 *
 * Provides WebSocket endpoint for real-time streaming inference.
 *
 * Protocol:
 * - Client sends: { type: 'inference', data: { model, prompt, ... } }
 * - Server sends: { type: 'token', data: { token, index } }
 * - Server sends: { type: 'done', data: { totalTokens, latencyMs } }
 * - Server sends: { type: 'error', data: { error } }
 *
 * @example
 * ```typescript
 * const wsServer = new WsServer(controller, httpServer);
 * await wsServer.start();
 * ```
 */
export class WsServer {
  private wss?: WebSocketServer;
  private controller: ControllerNode;
  private httpServer: Server;
  private logger: Logger;
  private activeConnections = 0;

  constructor(controller: ControllerNode, httpServer: Server) {
    this.controller = controller;
    this.httpServer = httpServer;
    this.logger = createLogger('WsServer');
  }

  /**
   * Start WebSocket server
   */
  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
    });

    this.wss.on('connection', this.handleConnection.bind(this));

    this.logger.info('WebSocket server started', {
      path: '/ws',
    });
  }

  /**
   * Stop WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.wss) {
      this.logger.warn('WebSocket server not running');
      return;
    }

    return new Promise((resolve) => {
      // Close all active connections
      this.wss!.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1000, 'Server shutting down');
        }
      });

      // Close server
      this.wss!.close(() => {
        this.logger.info('WebSocket server stopped');
        this.wss = undefined;
        resolve();
      });
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    this.activeConnections++;
    const connectionId = randomUUID();

    this.logger.info('WebSocket connection established', {
      connectionId,
      activeConnections: this.activeConnections,
    });

    // Handle messages from client
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;

        if (message.type === 'inference') {
          await this.handleInferenceMessage(ws, message, connectionId);
        } else {
          this.sendError(ws, `Unknown message type: ${(message as any).type}`);
        }
      } catch (error) {
        this.logger.error('Failed to process message', error as Error, {
          connectionId,
        });
        this.sendError(ws, `Failed to process message: ${(error as Error).message}`);
      }
    });

    // Handle connection close
    ws.on('close', () => {
      this.activeConnections--;
      this.logger.info('WebSocket connection closed', {
        connectionId,
        activeConnections: this.activeConnections,
      });
    });

    // Handle errors
    ws.on('error', (error) => {
      this.logger.error('WebSocket error', error as Error, {
        connectionId,
      });
    });

    // Send welcome message
    this.send(ws, {
      type: 'connected',
      data: {
        connectionId,
        message: 'WebSocket connection established',
      },
    } as any);
  }

  /**
   * Handle inference message from client
   */
  private async handleInferenceMessage(
    ws: WebSocket,
    message: WsInferenceMessage,
    connectionId: string
  ): Promise<void> {
    const startTime = Date.now();
    const requestId = randomUUID();

    this.logger.info('WebSocket inference request', {
      connectionId,
      requestId,
      model: message.data.model,
      promptLength: message.data.prompt.length,
    });

    try {
      // Create inference request
      const inferenceRequest: InferenceRequest = {
        requestId,
        modelId: message.data.model,
        prompt: message.data.prompt,
        maxTokens: message.data.maxTokens,
        temperature: message.data.temperature,
        topP: message.data.topP,
      };

      // Route to worker
      const stream = await this.controller.handleInferenceRequest(inferenceRequest);

      // Stream tokens back to client
      await this.streamTokens(ws, stream, startTime);
    } catch (error) {
      this.logger.error('WebSocket inference failed', error as Error, {
        connectionId,
        requestId,
      });
      this.sendError(ws, (error as Error).message);
    }
  }

  /**
   * Stream tokens to WebSocket client
   */
  private async streamTokens(
    ws: WebSocket,
    stream: ReadableStream,
    startTime: number
  ): Promise<void> {
    const reader = stream.getReader();
    let tokenIndex = 0;
    let totalTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Send token message
        this.send(ws, {
          type: 'token',
          data: {
            token: value,
            index: tokenIndex++,
          },
        });

        totalTokens++;
      }

      // Send done message
      const latencyMs = Date.now() - startTime;
      this.send(ws, {
        type: 'done',
        data: {
          totalTokens,
          latencyMs,
        },
      });

      this.logger.info('WebSocket streaming complete', {
        totalTokens,
        latencyMs,
      });
    } catch (error) {
      this.logger.error('WebSocket streaming error', error as Error);
      this.sendError(ws, (error as Error).message);
    }
  }

  /**
   * Send message to WebSocket client
   */
  private send(ws: WebSocket, message: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message to WebSocket client
   */
  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, {
      type: 'error',
      data: {
        error,
      },
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.wss !== undefined;
  }

  /**
   * Get active connection count
   */
  getActiveConnections(): number {
    return this.activeConnections;
  }
}
