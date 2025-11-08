/**
 * Request Coalescing Registry
 *
 * Multiplexes streaming responses from a single backend invocation to multiple
 * subscribers. This is the Phase 1 optimization for sharing inference results
 * across concurrent identical requests.
 *
 * Core Concept:
 * - Track in-flight requests by fingerprint (SHA256 of request params)
 * - Share a single Python inference call across N concurrent clients
 * - N clients → 1 Python inference → N responses via stream multiplexing
 *
 * Stream Multiplexing:
 * - Each subscriber gets its own ReadableStream
 * - Primary stream chunks are broadcast to all active subscribers
 * - Backpressure-aware (tracks unacked chunks per subscriber)
 * - Automatic cleanup when stream completes or subscribers disconnect
 *
 * Architecture:
 * - Map<fingerprint, CoalescedRequest>
 * - CoalescedRequest tracks primary stream + all subscribers
 * - Each subscriber has independent ReadableStreamDefaultController
 * - Error propagation: primary stream error → all subscribers fail
 * - Cancellation: last subscriber disconnect → cancel primary stream
 *
 * Safety:
 * - Max subscribers limit (default: 100)
 * - Timeout for coalescing window (default: 5s)
 * - Automatic cleanup of expired/completed requests
 * - Error isolation: subscriber errors don't affect others
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { StreamChunk } from '../bridge/stream-registry.js';
import type { GenerateResponse } from '../bridge/serializers.js';

/**
 * Configuration for coalescing registry
 */
export interface CoalescingRegistryConfig {
  /** Enable coalescing (default: false for safety) */
  enabled: boolean;

  /** Maximum subscribers per coalesced request (default: 100) */
  maxSubscribers: number;

  /** Coalescing window timeout in milliseconds (default: 5000ms) */
  timeout: number;

  /** Logger instance */
  logger?: Logger;
}

/**
 * Coalesced subscriber state
 */
export interface CoalescedSubscriber {
  /** Subscriber ID (stream_id) */
  id: string;

  /** ReadableStream for this subscriber */
  stream: ReadableStream<StreamChunk>;

  /** When subscriber was added */
  addedAt: number;

  /** Stream controller for chunk emission */
  controller: ReadableStreamDefaultController<StreamChunk>;

  /** Count of unacked chunks (for backpressure) */
  unackedChunks: number;

  /** Whether subscriber has been closed */
  closed: boolean;
}

/**
 * Coalesced request status
 */
export type CoalescedRequestStatus = 'pending' | 'active' | 'completed' | 'failed';

/**
 * Coalesced request tracking
 */
export interface CoalescedRequest {
  /** Request fingerprint (SHA256 hash) */
  fingerprint: string;

  /** When request was created */
  createdAt: number;

  /** When request expires (timeout) */
  expiresAt: number;

  /** Current request status */
  status: CoalescedRequestStatus;

  /** All subscribers sharing this request */
  subscribers: CoalescedSubscriber[];

  /** Primary stream (first request) */
  primaryStream?: ReadableStream<StreamChunk>;

  /** Error message (if failed) */
  error?: string;

  /** Total chunks received */
  chunkCount: number;

  /** Timeout handle for cleanup */
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Coalescing statistics
 */
export interface CoalescingStats {
  /** Whether coalescing is enabled */
  enabled: boolean;

  /** Total coalesce() calls */
  totalRequests: number;

  /** Requests that shared existing stream */
  coalescedRequests: number;

  /** Requests that created new stream */
  primaryRequests: number;

  /** Current active subscribers across all requests */
  activeSubscribers: number;

  /** Current active coalesced requests */
  activeRequests: number;

  /** Coalescing ratio (coalescedRequests / totalRequests) */
  coalescingRatio: number;

  /** Total timeouts */
  timeouts: number;

  /** Total errors */
  errors: number;

  /** Total completed requests */
  completed: number;
}

/**
 * Request Coalescing Registry
 *
 * Manages in-flight request multiplexing for streaming responses.
 */
export class CoalescingRegistry {
  private readonly config: CoalescingRegistryConfig;
  private readonly logger?: Logger;

  // Active coalesced requests: Map<fingerprint, CoalescedRequest>
  private readonly requests = new Map<string, CoalescedRequest>();

  // Statistics tracking
  private stats = {
    totalRequests: 0,
    coalescedRequests: 0,
    primaryRequests: 0,
    timeouts: 0,
    errors: 0,
    completed: 0,
  };

  constructor(config: CoalescingRegistryConfig) {
    this.config = config;
    this.logger = config.logger;

    this.logger?.info(
      {
        enabled: config.enabled,
        maxSubscribers: config.maxSubscribers,
        timeout: config.timeout,
      },
      'CoalescingRegistry initialized'
    );
  }

  /**
   * Generate deterministic fingerprint for request
   *
   * Uses SHA256 hash of canonicalized parameters (same as RequestDeduplicator).
   *
   * @param params - Request parameters to fingerprint
   * @returns Hex-encoded SHA256 hash
   */
  public fingerprint(params: {
    modelId: string;
    prompt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number;
  }): string {
    // Canonicalize: sort object keys for determinism
    const canonical = {
      modelId: params.modelId,
      prompt: params.prompt,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { topP: params.topP }),
      ...(params.topK !== undefined && { topK: params.topK }),
      ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
      ...(params.seed !== undefined && { seed: params.seed }),
    };

    const payload = JSON.stringify(canonical);
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Coalesce a request
   *
   * If an in-flight request exists for this fingerprint, attach as subscriber.
   * Otherwise, create a new primary stream.
   *
   * @param fingerprint - Request fingerprint
   * @param streamFactory - Factory function to create primary stream
   * @returns ReadableStream for this subscriber
   */
  public async coalesce(
    fingerprint: string,
    streamFactory: () => Promise<ReadableStream<StreamChunk>>
  ): Promise<ReadableStream<StreamChunk>> {
    if (!this.config.enabled) {
      // Coalescing disabled - always create new stream
      return streamFactory();
    }

    this.stats.totalRequests++;

    const existing = this.requests.get(fingerprint);

    if (existing && existing.status !== 'failed' && existing.status !== 'completed') {
      // In-flight request exists - attach as subscriber
      return this.attachSubscriber(fingerprint, existing);
    }

    // No in-flight request - create primary stream
    return this.createPrimaryStream(fingerprint, streamFactory);
  }

  /**
   * Create primary stream (first request)
   *
   * @param fingerprint - Request fingerprint
   * @param streamFactory - Factory function to create stream
   * @returns Primary ReadableStream
   */
  private async createPrimaryStream(
    fingerprint: string,
    streamFactory: () => Promise<ReadableStream<StreamChunk>>
  ): Promise<ReadableStream<StreamChunk>> {
    this.stats.primaryRequests++;

    const now = Date.now();

    // Create coalesced request entry
    const request: CoalescedRequest = {
      fingerprint,
      createdAt: now,
      expiresAt: now + this.config.timeout,
      status: 'pending',
      subscribers: [],
      chunkCount: 0,
    };

    // Setup timeout for cleanup
    request.timeoutHandle = setTimeout(() => {
      this.handleTimeout(fingerprint);
    }, this.config.timeout);

    this.requests.set(fingerprint, request);

    this.logger?.debug(
      { fingerprint, timeout: this.config.timeout },
      'Creating primary stream for coalescing'
    );

    try {
      // Create primary stream
      const primaryStream = await streamFactory();
      request.primaryStream = primaryStream;
      request.status = 'active';

      // Create subscriber stream that taps into primary
      const subscriberStream = this.createSubscriberStream(fingerprint, request, true);

      // Start consuming primary stream to broadcast chunks
      this.startBroadcasting(fingerprint, primaryStream, request);

      return subscriberStream;
    } catch (error) {
      // Primary stream creation failed
      request.status = 'failed';
      request.error = error instanceof Error ? error.message : String(error);
      this.stats.errors++;

      this.logger?.error(
        { fingerprint, error: request.error },
        'Failed to create primary stream'
      );

      // Cleanup
      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }
      this.requests.delete(fingerprint);

      throw error;
    }
  }

  /**
   * Attach subscriber to existing in-flight request
   *
   * @param fingerprint - Request fingerprint
   * @param request - Existing coalesced request
   * @returns ReadableStream for new subscriber
   */
  private attachSubscriber(
    fingerprint: string,
    request: CoalescedRequest
  ): ReadableStream<StreamChunk> {
    // Check subscriber limit
    if (request.subscribers.length >= this.config.maxSubscribers) {
      const error = new Error(
        `Max subscribers (${this.config.maxSubscribers}) reached for coalesced request`
      );
      this.logger?.warn(
        { fingerprint, subscribers: request.subscribers.length, maxSubscribers: this.config.maxSubscribers },
        'Max subscribers limit reached'
      );
      throw error;
    }

    this.stats.coalescedRequests++;

    const subscriberStream = this.createSubscriberStream(fingerprint, request, false);

    this.logger?.info(
      {
        fingerprint,
        totalSubscribers: request.subscribers.length,
        chunksSoFar: request.chunkCount,
        status: request.status,
      },
      'Subscriber attached to coalesced request'
    );

    return subscriberStream;
  }

  /**
   * Create ReadableStream for subscriber
   *
   * @param fingerprint - Request fingerprint
   * @param request - Coalesced request
   * @param isPrimary - Whether this is the primary subscriber
   * @returns ReadableStream for subscriber
   */
  private createSubscriberStream(
    fingerprint: string,
    request: CoalescedRequest,
    isPrimary: boolean
  ): ReadableStream<StreamChunk> {
    const subscriberId = `${fingerprint.substring(0, 8)}-sub-${request.subscribers.length}`;

    let controller: ReadableStreamDefaultController<StreamChunk>;

    const stream = new ReadableStream<StreamChunk>({
      start: (ctrl) => {
        controller = ctrl;

        // Create subscriber record
        const subscriber: CoalescedSubscriber = {
          id: subscriberId,
          stream,
          addedAt: Date.now(),
          controller: ctrl,
          unackedChunks: 0,
          closed: false,
        };

        request.subscribers.push(subscriber);

        this.logger?.debug(
          { fingerprint, subscriberId, isPrimary, totalSubscribers: request.subscribers.length },
          'Subscriber stream created'
        );
      },

      cancel: (reason) => {
        // Subscriber disconnected
        this.handleSubscriberDisconnect(fingerprint, subscriberId, reason);
      },
    });

    return stream;
  }

  /**
   * Start broadcasting primary stream chunks to all subscribers
   *
   * Consumes the primary stream and emits chunks to all active subscribers.
   *
   * @param fingerprint - Request fingerprint
   * @param primaryStream - Primary ReadableStream
   * @param request - Coalesced request
   */
  private async startBroadcasting(
    fingerprint: string,
    primaryStream: ReadableStream<StreamChunk>,
    request: CoalescedRequest
  ): Promise<void> {
    const reader = primaryStream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream completed successfully
          this.completeRequest(fingerprint, request);
          break;
        }

        // Broadcast chunk to all subscribers
        this.broadcastChunk(fingerprint, request, value);
        request.chunkCount++;
      }
    } catch (error) {
      // Primary stream error - propagate to all subscribers
      this.failRequest(
        fingerprint,
        request,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Broadcast chunk to all active subscribers
   *
   * @param fingerprint - Request fingerprint
   * @param request - Coalesced request
   * @param chunk - Stream chunk to broadcast
   */
  private broadcastChunk(
    fingerprint: string,
    request: CoalescedRequest,
    chunk: StreamChunk
  ): void {
    const activeSubscribers = request.subscribers.filter((s) => !s.closed);

    if (activeSubscribers.length === 0) {
      // No active subscribers - cancel primary stream
      this.logger?.warn({ fingerprint }, 'No active subscribers, canceling stream');
      this.completeRequest(fingerprint, request);
      return;
    }

    for (const subscriber of activeSubscribers) {
      try {
        // Enqueue chunk to subscriber controller
        subscriber.controller.enqueue(chunk);
        subscriber.unackedChunks++;

        // Check backpressure (simple warning, no blocking)
        if (subscriber.unackedChunks > 100) {
          this.logger?.warn(
            { fingerprint, subscriberId: subscriber.id, unackedChunks: subscriber.unackedChunks },
            'High unacked chunk count for subscriber'
          );
        }
      } catch (error) {
        // Subscriber controller error (likely closed)
        this.logger?.warn(
          { fingerprint, subscriberId: subscriber.id, error },
          'Failed to enqueue chunk to subscriber'
        );
        subscriber.closed = true;
      }
    }
  }

  /**
   * Complete coalesced request successfully
   *
   * @param fingerprint - Request fingerprint
   * @param request - Coalesced request
   */
  private completeRequest(fingerprint: string, request: CoalescedRequest): void {
    if (request.status === 'completed' || request.status === 'failed') {
      // Already completed
      return;
    }

    request.status = 'completed';
    this.stats.completed++;

    // Close all subscriber controllers
    for (const subscriber of request.subscribers) {
      if (!subscriber.closed) {
        try {
          subscriber.controller.close();
          subscriber.closed = true;
        } catch (error) {
          // Ignore close errors
          this.logger?.debug(
            { fingerprint, subscriberId: subscriber.id, error },
            'Error closing subscriber controller'
          );
        }
      }
    }

    // Cleanup timeout
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
      request.timeoutHandle = undefined;
    }

    this.logger?.info(
      {
        fingerprint,
        subscribers: request.subscribers.length,
        chunks: request.chunkCount,
        duration: Date.now() - request.createdAt,
      },
      'Coalesced request completed'
    );

    // Remove from registry
    this.requests.delete(fingerprint);
  }

  /**
   * Fail coalesced request with error
   *
   * Propagates error to all subscribers.
   *
   * @param fingerprint - Request fingerprint
   * @param request - Coalesced request
   * @param error - Error message
   */
  private failRequest(fingerprint: string, request: CoalescedRequest, error: string): void {
    if (request.status === 'completed' || request.status === 'failed') {
      // Already completed/failed
      return;
    }

    request.status = 'failed';
    request.error = error;
    this.stats.errors++;

    // Error all subscriber controllers
    const errorObj = new Error(`Coalesced stream failed: ${error}`);

    for (const subscriber of request.subscribers) {
      if (!subscriber.closed) {
        try {
          subscriber.controller.error(errorObj);
          subscriber.closed = true;
        } catch (err) {
          // Ignore error errors
          this.logger?.debug(
            { fingerprint, subscriberId: subscriber.id, err },
            'Error erroring subscriber controller'
          );
        }
      }
    }

    // Cleanup timeout
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
      request.timeoutHandle = undefined;
    }

    this.logger?.error(
      {
        fingerprint,
        subscribers: request.subscribers.length,
        error,
      },
      'Coalesced request failed'
    );

    // Remove from registry
    this.requests.delete(fingerprint);
  }

  /**
   * Handle subscriber disconnect
   *
   * If last subscriber disconnects, cancel primary stream.
   *
   * @param fingerprint - Request fingerprint
   * @param subscriberId - Subscriber ID
   * @param reason - Cancellation reason
   */
  private handleSubscriberDisconnect(
    fingerprint: string,
    subscriberId: string,
    reason?: any
  ): void {
    const request = this.requests.get(fingerprint);
    if (!request) {
      return;
    }

    // Mark subscriber as closed
    const subscriber = request.subscribers.find((s) => s.id === subscriberId);
    if (subscriber) {
      subscriber.closed = true;

      this.logger?.debug(
        { fingerprint, subscriberId, reason },
        'Subscriber disconnected'
      );
    }

    // Check if all subscribers are closed
    const activeSubscribers = request.subscribers.filter((s) => !s.closed);
    if (activeSubscribers.length === 0) {
      this.logger?.info(
        { fingerprint, totalSubscribers: request.subscribers.length },
        'All subscribers disconnected, completing request'
      );
      this.completeRequest(fingerprint, request);
    }
  }

  /**
   * Handle coalescing timeout
   *
   * @param fingerprint - Request fingerprint
   */
  private handleTimeout(fingerprint: string): void {
    const request = this.requests.get(fingerprint);
    if (!request) {
      return;
    }

    if (request.status === 'completed' || request.status === 'failed') {
      // Already completed
      return;
    }

    this.stats.timeouts++;

    this.logger?.warn(
      {
        fingerprint,
        subscribers: request.subscribers.length,
        status: request.status,
        timeout: this.config.timeout,
      },
      'Coalescing timeout reached'
    );

    this.failRequest(fingerprint, request, `Timeout after ${this.config.timeout}ms`);
  }

  /**
   * Get coalescing statistics
   *
   * @returns Current statistics
   */
  public getStats(): CoalescingStats {
    let activeSubscribers = 0;
    for (const [, request] of Array.from(this.requests.entries())) {
      activeSubscribers += request.subscribers.filter((s) => !s.closed).length;
    }

    const total = this.stats.totalRequests;
    const coalescingRatio = total > 0 ? this.stats.coalescedRequests / total : 0;

    return {
      enabled: this.config.enabled,
      totalRequests: this.stats.totalRequests,
      coalescedRequests: this.stats.coalescedRequests,
      primaryRequests: this.stats.primaryRequests,
      activeSubscribers,
      activeRequests: this.requests.size,
      coalescingRatio,
      timeouts: this.stats.timeouts,
      errors: this.stats.errors,
      completed: this.stats.completed,
    };
  }

  /**
   * Cleanup expired/completed requests
   *
   * Called periodically to remove stale entries.
   */
  public cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [fingerprint, request] of Array.from(this.requests.entries())) {
      // Remove completed/failed requests
      if (request.status === 'completed' || request.status === 'failed') {
        if (request.timeoutHandle) {
          clearTimeout(request.timeoutHandle);
        }
        this.requests.delete(fingerprint);
        cleaned++;
        continue;
      }

      // Remove expired requests
      if (now >= request.expiresAt) {
        this.handleTimeout(fingerprint);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger?.debug({ cleaned }, 'Cleaned up expired coalesced requests');
    }
  }

  /**
   * Clear all coalesced requests
   *
   * Fails all in-flight requests and clears the registry.
   */
  public clear(): void {
    const keys = Array.from(this.requests.keys());

    for (const fingerprint of keys) {
      const request = this.requests.get(fingerprint);
      if (request) {
        this.failRequest(fingerprint, request, 'Registry cleared');
      }
    }

    this.logger?.info({ cleared: keys.length }, 'CoalescingRegistry cleared');
  }
}
