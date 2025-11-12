/**
 * NATS client wrapper for distributed inference system
 *
 * Provides type-safe publish/subscribe and request/reply messaging.
 */

import {
  connect,
  type NatsConnection,
  StringCodec,
  JSONCodec,
  type ConnectionOptions,
  type Subscription as NatsSubscription,
} from 'nats';
import { createLogger, type Logger } from '../utils/logger.js';
import { ConnectionError, TimeoutError, NatsError } from '../utils/errors.js';
import type { NatsClientOptions } from '../types/index.js';

/**
 * Connection state enum
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  CLOSED = 'closed',
}

/**
 * Event emitter for connection state changes
 */
type EventHandler = (...args: unknown[]) => void;

/**
 * NATS client wrapper with type-safe messaging
 *
 * @example
 * ```typescript
 * const client = new NatsClient();
 * await client.connect({ mode: 'embedded' });
 *
 * // Publish
 * await client.publish('worker.heartbeat', { workerId: '123', status: 'online' });
 *
 * // Subscribe
 * await client.subscribe('worker.heartbeat', (msg) => {
 *   console.log('Heartbeat:', msg);
 * });
 *
 * // Request/Reply
 * const response = await client.request('worker.123.inference', request, { timeout: 5000 });
 *
 * await client.disconnect();
 * ```
 */
export class NatsClient {
  private nc?: NatsConnection;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private readonly logger: Logger;
  private readonly sc = StringCodec();
  private readonly jc = JSONCodec();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();

  constructor() {
    this.logger = createLogger('NatsClient');
  }

  /**
   * Connect to NATS server
   *
   * @param options - Connection options
   * @throws {ConnectionError} if connection fails
   */
  async connect(options: NatsClientOptions): Promise<void> {
    this.logger.info('Connecting to NATS server', { mode: options.mode });
    this.state = ConnectionState.CONNECTING;

    try {
      const connectionOptions = this.buildConnectionOptions(options);
      this.nc = await connect(connectionOptions);

      this.state = ConnectionState.CONNECTED;
      this.logger.info('Connected to NATS server', {
        server: this.nc.getServer(),
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Emit connected event
      this.emit('connected');
    } catch (error) {
      this.state = ConnectionState.DISCONNECTED;
      this.logger.error('Failed to connect to NATS server', error as Error);
      this.emit('error', error);
      throw new ConnectionError(
        `Failed to connect to NATS: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  /**
   * Disconnect from NATS server
   */
  async disconnect(): Promise<void> {
    if (!this.nc) {
      this.logger.warn('Disconnect called but not connected');
      return;
    }

    this.logger.info('Disconnecting from NATS server');

    try {
      await this.nc.drain();
      this.state = ConnectionState.CLOSED;
      this.nc = undefined;
      this.logger.info('Disconnected from NATS server');
      this.emit('disconnected');
    } catch (error) {
      this.logger.error('Error during disconnect', error as Error);
      throw error;
    }
  }

  /**
   * Check if connected to NATS server
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.nc !== undefined;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Get NATS server URL
   */
  getServerUrl(): string | undefined {
    return this.nc?.getServer();
  }

  /**
   * Publish a message to a subject
   *
   * @param subject - NATS subject (topic)
   * @param data - Message data (will be JSON-encoded)
   * @throws {ConnectionError} if not connected
   * @throws {NatsError} if publish fails
   */
  async publish<T>(subject: string, data: T): Promise<void> {
    if (!this.nc) {
      throw new ConnectionError('Not connected to NATS');
    }

    try {
      this.logger.debug('Publishing message', { subject });

      const encoded = this.jc.encode(data);
      this.nc.publish(subject, encoded);

      // Flush to ensure message is sent
      await this.nc.flush();

      this.logger.debug('Message published', { subject });
    } catch (error) {
      this.logger.error('Failed to publish message', error as Error, { subject });
      throw new NatsError(
        `Failed to publish to ${subject}: ${(error as Error).message}`,
        'PUBLISH_ERROR',
        error as Error
      );
    }
  }

  /**
   * Subscribe to a subject
   *
   * @param subject - NATS subject (supports wildcards: *, >)
   * @param callback - Callback function for received messages
   * @returns Subscription handle (for unsubscribe)
   * @throws {ConnectionError} if not connected
   * @throws {NatsError} if subscription fails
   */
  async subscribe<T>(
    subject: string,
    callback: (data: T) => void | Promise<void>
  ): Promise<NatsSubscription> {
    if (!this.nc) {
      throw new ConnectionError('Not connected to NATS');
    }

    try {
      this.logger.info('Subscribing to subject', { subject });

      const sub = this.nc.subscribe(subject);

      // Process messages in background
      (async () => {
        try {
          for await (const msg of sub) {
            try {
              const data = this.jc.decode(msg.data) as T;
              this.logger.debug('Message received', { subject });

              await callback(data);
            } catch (error) {
              this.logger.error('Error processing message', error as Error, {
                subject,
              });
            }
          }
        } catch (error) {
          if (this.isConnected()) {
            this.logger.error('Subscription error', error as Error, { subject });
          }
        }
      })();

      this.logger.info('Subscribed to subject', { subject });
      return sub;
    } catch (error) {
      this.logger.error('Failed to subscribe', error as Error, { subject });
      throw new NatsError(
        `Failed to subscribe to ${subject}: ${(error as Error).message}`,
        'SUBSCRIPTION_ERROR',
        error as Error
      );
    }
  }

  /**
   * Unsubscribe from a subject
   *
   * @param subscription - Subscription handle from subscribe()
   */
  async unsubscribe(subscription: NatsSubscription): Promise<void> {
    try {
      subscription.unsubscribe();
      this.logger.debug('Unsubscribed from subject');
    } catch (error) {
      this.logger.error('Failed to unsubscribe', error as Error);
      throw error;
    }
  }

  /**
   * Send a request and wait for reply (RPC pattern)
   *
   * @param subject - NATS subject
   * @param data - Request data
   * @param options - Request options (timeout)
   * @returns Response data
   * @throws {ConnectionError} if not connected
   * @throws {TimeoutError} if request times out
   * @throws {NatsError} if request fails
   */
  async request<Req, Res>(
    subject: string,
    data: Req,
    options: { timeout?: number } = {}
  ): Promise<Res> {
    if (!this.nc) {
      throw new ConnectionError('Not connected to NATS');
    }

    const timeout = options.timeout ?? 5000; // Default 5s timeout

    try {
      this.logger.debug('Sending request', { subject, timeout });

      const encoded = this.jc.encode(data);
      const msg = await this.nc.request(subject, encoded, { timeout });

      const response = this.jc.decode(msg.data) as Res;
      this.logger.debug('Received response', { subject });

      return response;
    } catch (error) {
      if ((error as Error).message.includes('timeout')) {
        this.logger.warn('Request timed out', { subject, timeout });
        throw new TimeoutError(
          `Request to ${subject} timed out after ${timeout}ms`,
          timeout
        );
      }

      this.logger.error('Request failed', error as Error, { subject });
      throw new NatsError(
        `Request to ${subject} failed: ${(error as Error).message}`,
        'REQUEST_ERROR',
        error as Error
      );
    }
  }

  /**
   * Reply to requests on a subject (RPC handler)
   *
   * @param subject - NATS subject
   * @param handler - Handler function for requests
   * @returns Subscription handle
   * @throws {ConnectionError} if not connected
   * @throws {NatsError} if reply setup fails
   */
  async reply<Req, Res>(
    subject: string,
    handler: (data: Req) => Promise<Res> | Res
  ): Promise<NatsSubscription> {
    if (!this.nc) {
      throw new ConnectionError('Not connected to NATS');
    }

    try {
      this.logger.info('Setting up reply handler', { subject });

      const sub = this.nc.subscribe(subject);

      (async () => {
        try {
          for await (const msg of sub) {
            try {
              const request = this.jc.decode(msg.data) as Req;
              this.logger.debug('Request received', { subject });

              const response = await handler(request);
              const encoded = this.jc.encode(response);

              msg.respond(encoded);
              this.logger.debug('Response sent', { subject });
            } catch (error) {
              this.logger.error('Error handling request', error as Error, {
                subject,
              });

              // Send error response
              const errorResponse = {
                error: (error as Error).message,
              };
              msg.respond(this.jc.encode(errorResponse));
            }
          }
        } catch (error) {
          if (this.isConnected()) {
            this.logger.error('Reply handler error', error as Error, { subject });
          }
        }
      })();

      this.logger.info('Reply handler set up', { subject });
      return sub;
    } catch (error) {
      this.logger.error('Failed to set up reply handler', error as Error, {
        subject,
      });
      throw new NatsError(
        `Failed to setup reply handler for ${subject}: ${(error as Error).message}`,
        'REPLY_ERROR',
        error as Error
      );
    }
  }

  /**
   * Register event handler
   *
   * @param event - Event name ('connected', 'disconnected', 'error')
   * @param handler - Event handler function
   */
  on(event: 'connected' | 'disconnected' | 'error', handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unregister event handler
   *
   * @param event - Event name
   * @param handler - Event handler function
   */
  off(event: 'connected' | 'disconnected' | 'error', handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit event to registered handlers
   */
  private emit(event: 'connected' | 'disconnected' | 'error', ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(...args));
    }
  }

  /**
   * Build NATS connection options
   */
  private buildConnectionOptions(options: NatsClientOptions): ConnectionOptions {
    const serverUrl =
      options.mode === 'embedded'
        ? 'nats://localhost:4222'
        : options.serverUrl;

    if (!serverUrl) {
      throw new Error('Server URL is required for external mode');
    }

    const connectionOptions: ConnectionOptions = {
      servers: serverUrl,
      name: 'mlx-serving-distributed',
      reconnect: options.reconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      reconnectTimeWait: options.reconnectTimeWait ?? 2000,
    };

    if (options.user && options.password) {
      connectionOptions.user = options.user;
      connectionOptions.pass = options.password;
    }

    return connectionOptions;
  }

  /**
   * Setup event handlers for NATS connection
   */
  private setupEventHandlers(): void {
    if (!this.nc) return;

    (async () => {
      for await (const status of this.nc!.status()) {
        this.logger.debug('NATS status update', {
          type: status.type,
          data: status.data,
        });

        switch (status.type) {
          case 'disconnect':
            this.state = ConnectionState.DISCONNECTED;
            this.logger.warn('NATS connection lost');
            this.emit('disconnected');
            break;

          case 'reconnecting':
            this.state = ConnectionState.RECONNECTING;
            this.logger.info('NATS reconnecting');
            break;

          case 'reconnect':
            this.state = ConnectionState.CONNECTED;
            this.logger.info('NATS reconnected');
            this.emit('connected');
            break;

          case 'error':
            const errorData = status.data instanceof Error ? status.data : new Error(String(status.data));
            this.logger.error('NATS error', errorData);
            this.emit('error', errorData);
            break;
        }
      }
    })();
  }
}
