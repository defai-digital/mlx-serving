/**
 * Controller Node
 *
 * Main orchestrator for the distributed inference controller.
 * Manages workers, routes requests, and provides unified API.
 */

import { EventEmitter } from 'events';
import { NatsClient } from '../nats/client.js';
import { WorkerRegistry, type WorkerInfo } from './worker-registry.js';
import { SmartLoadBalancer } from './load-balancers/smart-load-balancer.js';
import { ApiServer } from './api-server.js';
import { WsServer } from './ws-server.js';
import { CircuitBreakerManager, CircuitState } from './circuit-breaker.js';
import { RetryHandler } from './retry-handler.js';
import { TimeoutHandler } from './timeout-handler.js';
import type { ClusterConfig } from '../types/config.js';
import type {
  WorkerRegistration,
  WorkerHeartbeat,
  InferenceRequest,
  StreamingResponse,
} from '../types/messages.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ControllerError, ControllerErrorCode } from '../utils/errors.js';

/**
 * Controller lifecycle states
 */
export enum ControllerState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  REGISTERING = 'registering',
  STARTING = 'starting',
  READY = 'ready',
  DRAINING = 'draining',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
}

/**
 * Active request tracking
 */
interface ActiveRequest {
  requestId: string;
  modelId: string;
  workerId: string;
  startTime: number;
}

/**
 * Request metadata for tracking retries, timeouts, etc.
 */
interface RequestMetadata {
  requestId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  retryCount: number;
  selectedWorker: string;
  failedWorkers: string[];
  circuitBreakerTrips: number;
  timeouts: number;
  finalError?: string;
}

/**
 * Cluster status response
 */
export interface ClusterStatus {
  controller: {
    version: string;
    uptime: number;
    mode: string;
    state: string;
  };
  workers: {
    total: number;
    online: number;
    offline: number;
  };
  requests: {
    active: number;
    total: number;
  };
}

/**
 * Controller Node options
 */
export interface ControllerNodeOptions {
  config: ClusterConfig;
}

/**
 * Controller Node
 *
 * Central coordinator for distributed inference cluster.
 *
 * Responsibilities:
 * 1. Worker discovery and registration
 * 2. Health monitoring (heartbeat tracking)
 * 3. Smart request routing (skills + hardware + load)
 * 4. Response aggregation and streaming
 * 5. API gateway (REST + WebSocket)
 *
 * Lifecycle: IDLE → CONNECTING → REGISTERING → STARTING → READY → DRAINING → STOPPING → STOPPED
 *
 * @example
 * ```typescript
 * const controller = new ControllerNode({ config });
 * await controller.start();
 * ```
 */
export class ControllerNode extends EventEmitter {
  private state: ControllerState = ControllerState.IDLE;
  private nats: NatsClient;
  private workerRegistry: WorkerRegistry;
  private loadBalancer: SmartLoadBalancer;
  private apiServer: ApiServer;
  private wsServer?: WsServer;
  private config: ClusterConfig;
  private logger: Logger;
  private healthCheckInterval?: NodeJS.Timeout;
  private activeRequests: Map<string, ActiveRequest> = new Map();
  private totalRequests = 0;
  private startTime = 0;

  // Phase 2 Week 3: Reliability components
  private circuitBreakerManager?: CircuitBreakerManager;
  private retryHandler?: RetryHandler;
  private timeoutHandler: TimeoutHandler;
  private requestMetrics: Map<string, RequestMetadata> = new Map();

  constructor(options: ControllerNodeOptions) {
    super();

    this.config = options.config;
    this.logger = createLogger('ControllerNode');

    // Initialize components
    this.nats = new NatsClient();
    this.workerRegistry = new WorkerRegistry();

    // Initialize load balancer with session affinity config
    const sessionAffinityConfig = this.config.loadBalancing?.sessionAffinity;
    this.loadBalancer = new SmartLoadBalancer({
      enableSessionAffinity: sessionAffinityConfig?.enabled ?? false,
      sessionTtlMs: sessionAffinityConfig?.ttlMs,
      sessionCleanupIntervalMs: sessionAffinityConfig?.cleanupIntervalMs,
    });

    // Initialize circuit breaker manager if enabled
    if (this.config.requestRouting?.circuitBreaker?.enabled) {
      this.circuitBreakerManager = new CircuitBreakerManager({
        failureThreshold: this.config.requestRouting.circuitBreaker.failureThreshold,
        successThreshold: this.config.requestRouting.circuitBreaker.successThreshold,
        timeoutMs: this.config.requestRouting.circuitBreaker.timeoutMs,
      });

      this.logger.info('Circuit breaker manager initialized', {
        failureThreshold: this.config.requestRouting.circuitBreaker.failureThreshold,
        successThreshold: this.config.requestRouting.circuitBreaker.successThreshold,
        timeoutMs: this.config.requestRouting.circuitBreaker.timeoutMs,
      });
    } else {
      this.logger.info('Circuit breaker disabled');
    }

    // Initialize retry handler if enabled
    if (this.config.requestRouting?.retry?.enabled) {
      this.retryHandler = new RetryHandler({
        maxRetries: this.config.requestRouting.retry.maxRetries,
        retryDelayMs: this.config.requestRouting.retry.retryDelayMs,
        exponentialBackoff: true,
        maxDelayMs: 1000,
      });

      this.logger.info('Retry handler initialized', {
        maxRetries: this.config.requestRouting.retry.maxRetries,
        retryDelayMs: this.config.requestRouting.retry.retryDelayMs,
      });
    } else {
      this.logger.info('Retry handler disabled');
    }

    // Initialize timeout handler (always enabled)
    this.timeoutHandler = new TimeoutHandler({
      standardTimeoutMs: this.config.requestRouting?.timeoutMs ?? 30000,
      streamingTimeoutMs: this.config.requestRouting?.streamingTimeoutMs ?? 60000,
    });

    this.logger.info('Timeout handler initialized', {
      standardTimeout: this.config.requestRouting?.timeoutMs ?? 30000,
      streamingTimeout: this.config.requestRouting?.streamingTimeoutMs ?? 60000,
    });

    this.apiServer = new ApiServer(this, this.config);

    this.logger.info('Controller node created', {
      state: this.state,
      sessionAffinity: sessionAffinityConfig?.enabled ?? false,
      circuitBreaker: this.config.requestRouting?.circuitBreaker?.enabled ?? false,
      retry: this.config.requestRouting?.retry?.enabled ?? false,
    });
  }

  /**
   * Start controller node
   *
   * Lifecycle: IDLE → CONNECTING → REGISTERING → STARTING → READY
   */
  async start(): Promise<void> {
    if (this.state !== ControllerState.IDLE) {
      throw new ControllerError('Controller already started');
    }

    this.logger.info('Starting controller node');
    this.startTime = Date.now();

    try {
      // 1. Connect to NATS
      this.state = ControllerState.CONNECTING;
      this.emit('stateChange', this.state);

      await this.nats.connect(this.config.nats);
      this.logger.info('Connected to NATS', {
        server: this.nats.getServerUrl(),
      });

      // 2. Subscribe to worker events
      this.state = ControllerState.REGISTERING;
      this.emit('stateChange', this.state);

      await this.subscribeToWorkerEvents();
      this.logger.info('Subscribed to worker events');

      // 2.5. Register static workers if configured
      if (this.config.workers?.static && this.config.workers.static.length > 0) {
        this.registerStaticWorkers();
        this.logger.info('Static workers registered', {
          count: this.config.workers.static.length,
        });
      }

      // 3. Start health monitoring
      this.state = ControllerState.STARTING;
      this.emit('stateChange', this.state);

      this.startHealthMonitoring();
      this.logger.info('Health monitoring started');

      // 4. Start API server
      await this.apiServer.start();
      this.logger.info('API server started');

      // 5. Start WebSocket server (optional)
      // Note: WsServer needs HTTP server from ApiServer
      // For now, we'll skip WebSocket in initial implementation
      // This can be added later by exposing HTTP server from ApiServer

      // 6. Controller is ready
      this.state = ControllerState.READY;
      this.emit('stateChange', this.state);
      this.emit('ready');

      this.logger.info('Controller node ready', {
        state: this.state,
        apiPort: this.config.controller?.port ?? 8080,
      });
    } catch (error) {
      this.state = ControllerState.STOPPED;
      this.emit('stateChange', this.state);
      this.logger.error('Failed to start controller', error as Error);
      throw new ControllerError(
        `Failed to start controller: ${(error as Error).message}`,
        ControllerErrorCode.CONTROLLER_ERROR,
        {},
        false,
        error as Error
      );
    }
  }

  /**
   * Stop controller node
   *
   * Lifecycle: READY → DRAINING → STOPPING → STOPPED
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping controller');
    this.state = ControllerState.DRAINING;
    this.emit('stateChange', this.state);

    // 1. Stop health monitoring
    this.stopHealthMonitoring();

    // 2. Wait for active requests to complete (max 30s)
    const maxWait = 30000;
    const startTime = Date.now();

    while (this.activeRequests.size > 0 && Date.now() - startTime < maxWait) {
      this.logger.info(`Waiting for ${this.activeRequests.size} active requests to complete`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.activeRequests.size > 0) {
      this.logger.warn(`Force shutdown with ${this.activeRequests.size} requests still active`);
    }

    // 3. Stop API server
    this.state = ControllerState.STOPPING;
    this.emit('stateChange', this.state);

    await this.apiServer.stop();

    // 4. Stop WebSocket server
    if (this.wsServer) {
      await this.wsServer.stop();
    }

    // 5. Disconnect from NATS
    await this.nats.disconnect();

    // 6. Cleanup
    this.state = ControllerState.STOPPED;
    this.emit('stateChange', this.state);
    this.emit('stopped');
    this.logger.info('Controller stopped');
  }

  /**
   * Get current controller state
   */
  getState(): ControllerState {
    return this.state;
  }

  /**
   * Subscribe to worker events (registration and heartbeat)
   */
  private async subscribeToWorkerEvents(): Promise<void> {
    // Subscribe to worker registrations
    await this.nats.subscribe<WorkerRegistration>('worker.register', (registration) => {
      this.handleWorkerRegistration(registration);
    });

    // Subscribe to worker heartbeats
    await this.nats.subscribe<WorkerHeartbeat>('worker.heartbeat', (heartbeat) => {
      this.handleWorkerHeartbeat(heartbeat);
    });

    // Subscribe to worker deregistrations
    await this.nats.subscribe<{ workerId: string; timestamp: number }>('worker.deregister', (deregistration) => {
      this.handleWorkerDeregistration(deregistration);
    });

    this.logger.info('Subscribed to worker topics', {
      topics: ['worker.register', 'worker.heartbeat', 'worker.deregister'],
    });
  }

  /**
   * Handle worker registration
   */
  private handleWorkerRegistration(registration: WorkerRegistration): void {
    this.logger.info('Worker registration received', {
      workerId: registration.workerId,
      hostname: registration.hostname,
      ip: registration.ip,
      modelsCount: registration.skills.availableModels.length,
    });

    this.workerRegistry.addWorker(registration);
    this.emit('workerRegistered', registration);
  }

  /**
   * Handle worker heartbeat
   */
  private handleWorkerHeartbeat(heartbeat: WorkerHeartbeat): void {
    this.logger.debug('Worker heartbeat received', {
      workerId: heartbeat.workerId,
      status: heartbeat.status,
      activeRequests: heartbeat.metrics.activeRequests,
    });

    this.workerRegistry.updateWorker(heartbeat);
    this.emit('workerHeartbeat', heartbeat);
  }

  /**
   * Handle worker deregistration
   */
  private handleWorkerDeregistration(deregistration: { workerId: string; timestamp: number }): void {
    this.logger.info('Worker deregistration received', {
      workerId: deregistration.workerId,
    });

    this.workerRegistry.removeWorker(deregistration.workerId);
    this.emit('workerDeregistered', deregistration);
  }

  /**
   * Register static workers from configuration
   */
  private registerStaticWorkers(): void {
    if (!this.config.workers?.static) return;

    for (const staticWorker of this.config.workers.static) {
      try {
        // Parse URL to extract IP and port
        const url = new URL(staticWorker.url);
        const hostname = url.hostname;
        const port = parseInt(url.port) || 8080;

        // Create worker registration message
        const registration: WorkerRegistration = {
          workerId: staticWorker.workerId || `static-${hostname}-${port}`,
          hostname: hostname,
          ip: staticWorker.ip || hostname,
          port: staticWorker.port || port,
          skills: {
            availableModels: [],
            modelPaths: {},
            totalModelSize: 0,
            lastScanned: Date.now(),
          },
          status: 'online',
          timestamp: Date.now(),
        };

        // Register the worker
        this.workerRegistry.addWorker(registration);

        this.logger.info('Static worker registered', {
          workerId: registration.workerId,
          url: staticWorker.url,
        });
      } catch (error) {
        this.logger.error('Failed to register static worker', error as Error, {
          worker: staticWorker,
        });
      }
    }
  }

  /**
   * Start health monitoring (check every 5s, mark offline after 15s)
   */
  private startHealthMonitoring(): void {
    const checkInterval = 5000; // 5 seconds
    const offlineTimeout = this.config.discovery?.offlineTimeoutMs ?? 15000;

    this.healthCheckInterval = setInterval(() => {
      this.detectOfflineWorkers(offlineTimeout);
    }, checkInterval);

    this.logger.debug('Health monitoring started', {
      checkIntervalMs: checkInterval,
      offlineTimeoutMs: offlineTimeout,
    });
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      this.logger.debug('Health monitoring stopped');
    }
  }

  /**
   * Detect and mark offline workers
   */
  private detectOfflineWorkers(offlineTimeout: number): void {
    const now = Date.now();
    const workers = this.workerRegistry.getAllWorkers();

    for (const worker of workers) {
      const timeSinceHeartbeat = now - worker.lastHeartbeat;

      if (timeSinceHeartbeat > offlineTimeout && worker.status !== 'offline') {
        this.logger.warn('Worker offline detected', {
          workerId: worker.workerId,
          hostname: worker.hostname,
          timeSinceHeartbeatMs: timeSinceHeartbeat,
        });

        this.workerRegistry.markOffline(worker.workerId);
        this.emit('workerOffline', worker);
      }
    }
  }

  /**
   * Filter workers by circuit breaker state
   * Only returns workers whose circuit breakers are CLOSED or HALF_OPEN
   */
  private filterHealthyWorkers(workers: WorkerInfo[]): WorkerInfo[] {
    if (!this.circuitBreakerManager) {
      return workers;
    }

    const healthy = workers.filter((worker) => {
      const breaker = this.circuitBreakerManager!.getBreaker(worker.workerId);
      const canMakeRequest = breaker.canMakeRequest();

      if (!canMakeRequest) {
        const state = breaker.getState();
        this.logger.debug('Worker excluded by circuit breaker', {
          workerId: worker.workerId,
          workerState: worker.status,
          circuitBreakerState: state,
        });
      }

      return canMakeRequest;
    });

    const filteredCount = workers.length - healthy.length;
    if (filteredCount > 0) {
      this.logger.warn('Workers filtered by circuit breaker', {
        totalWorkers: workers.length,
        healthyWorkers: healthy.length,
        filteredWorkers: filteredCount,
      });
    }

    return healthy;
  }

  /**
   * Update circuit breaker state after request completion
   */
  private updateCircuitBreaker(workerId: string, success: boolean): void {
    if (!this.circuitBreakerManager) {
      return;
    }

    const breaker = this.circuitBreakerManager.getBreaker(workerId);

    if (success) {
      breaker.recordSuccess();

      const state = breaker.getState();
      if (state === CircuitState.CLOSED) {
        this.logger.debug('Circuit breaker success recorded', {
          workerId,
          state,
        });
      }
    } else {
      breaker.recordFailure();

      const state = breaker.getState();

      if (state === CircuitState.OPEN) {
        this.logger.warn('Circuit breaker opened for worker', {
          workerId,
          state,
          message: 'Worker will be excluded from request routing until recovery',
        });
      } else if (state === CircuitState.HALF_OPEN) {
        this.logger.info('Circuit breaker entered half-open state', {
          workerId,
          state,
          message: 'Testing worker recovery',
        });
      }
    }
  }

  /**
   * Get circuit breaker statistics for all workers
   */
  public getCircuitBreakerStats(): Record<
    string,
    {
      state: CircuitState;
      failures: number;
      successes: number;
      lastFailureTime: number | null;
      lastSuccessTime: number | null;
      openedAt: number | null;
    }
  > {
    if (!this.circuitBreakerManager) {
      return {};
    }

    const workers = this.workerRegistry.getAllWorkers();
    const stats: Record<string, any> = {};

    for (const worker of workers) {
      const breaker = this.circuitBreakerManager.getBreaker(worker.workerId);
      const breakerStats = breaker.getStats();
      stats[worker.workerId] = breakerStats;
    }

    return stats;
  }

  /**
   * Handle inference request
   *
   * Main entry point for routing inference requests to workers.
   * Integrates retry, timeout, and circuit breaker logic.
   *
   * @param request - Inference request
   * @returns ReadableStream of tokens
   */
  async handleInferenceRequest(request: InferenceRequest): Promise<ReadableStream> {
    this.logger.info('Inference request received', {
      requestId: request.requestId,
      modelId: request.modelId,
      promptLength: request.prompt.length,
    });

    // Initialize metrics
    const metadata = this.initRequestMetadata(request);

    // Track active request
    this.activeRequests.set(request.requestId, {
      requestId: request.requestId,
      modelId: request.modelId,
      workerId: '', // Will be set after worker selection
      startTime: Date.now(),
    });
    this.totalRequests++;

    try {
      // Execute with retry + timeout + circuit breaker
      const stream = await this.executeWithRetry(request, request.sessionId);

      // Update metrics on success
      const activeReq = this.activeRequests.get(request.requestId);
      if (activeReq) {
        this.finalizeRequestMetadata(request.requestId, activeReq.workerId);
      }

      return stream;
    } catch (error) {
      // Remove from active requests on error
      this.activeRequests.delete(request.requestId);

      // Update metrics on failure
      this.finalizeRequestMetadata(request.requestId, '', error as Error);

      throw error;
    }
  }

  /**
   * Execute request with retry logic
   * Automatically retries on different workers if one fails
   */
  private async executeWithRetry(
    request: InferenceRequest,
    sessionId?: string
  ): Promise<ReadableStream> {
    if (!this.retryHandler) {
      return await this.executeSingleRequest(request, sessionId);
    }

    this.logger.debug('Executing request with retry', {
      requestId: request.requestId,
      sessionId,
      maxRetries: this.config.requestRouting?.retry?.maxRetries,
    });

    return await this.retryHandler.executeWithRetry(
      request,
      async (req, excludedWorkers) => {
        const allWorkers = this.workerRegistry.getAllWorkers();
        const healthyWorkers = this.filterHealthyWorkers(allWorkers);
        const availableWorkers = healthyWorkers.filter(
          (w) => !excludedWorkers.has(w.workerId)
        );

        if (availableWorkers.length === 0) {
          this.logger.error('No workers available for retry', undefined, {
            requestId: req.requestId,
            totalWorkers: allWorkers.length,
            healthyWorkers: healthyWorkers.length,
            excludedWorkers: excludedWorkers.size,
          });

          throw new ControllerError(
            'No workers available for request (all excluded, offline, or unhealthy)',
            ControllerErrorCode.NO_WORKERS_AVAILABLE,
            {
              totalWorkers: allWorkers.length,
              healthyWorkers: healthyWorkers.length,
              excludedWorkers: Array.from(excludedWorkers),
            }
          );
        }

        const worker = this.loadBalancer.selectWorker(
          availableWorkers,
          req,
          sessionId
        );

        this.logger.debug('Selected worker for request', {
          requestId: req.requestId,
          workerId: worker.workerId,
          availableWorkers: availableWorkers.length,
          excludedWorkers: excludedWorkers.size,
        });

        try {
          const stream = await this.sendRequestToWorker(worker, req);
          return stream;
        } catch (error) {
          this.updateMetadataOnRetry(req.requestId, worker.workerId, error as Error);
          throw error;
        }
      }
    );
  }

  /**
   * Execute single request without retry
   */
  private async executeSingleRequest(
    request: InferenceRequest,
    sessionId?: string
  ): Promise<ReadableStream> {
    const allWorkers = this.workerRegistry.getAllWorkers();
    const healthyWorkers = this.filterHealthyWorkers(allWorkers);

    if (healthyWorkers.length === 0) {
      throw new ControllerError(
        'No healthy workers available',
        ControllerErrorCode.NO_HEALTHY_WORKERS,
        {
          totalWorkers: allWorkers.length,
          onlineWorkers: allWorkers.filter((w) => w.status === 'online').length,
        }
      );
    }

    const worker = this.loadBalancer.selectWorker(healthyWorkers, request, sessionId);

    this.logger.debug('Executing single request', {
      requestId: request.requestId,
      workerId: worker.workerId,
    });

    return await this.sendRequestToWorker(worker, request);
  }

  /**
   * Send request to specific worker with timeout enforcement
   */
  private async sendRequestToWorker(
    worker: WorkerInfo,
    request: InferenceRequest
  ): Promise<ReadableStream> {
    const subject = `worker.${worker.workerId}.inference`;
    const isStreaming = request.stream === true;

    // Determine timeout based on request type
    const timeoutMs = isStreaming
      ? this.config.requestRouting?.streamingTimeoutMs ?? 60000
      : this.config.requestRouting?.timeoutMs ?? 30000;

    this.logger.debug('Sending request to worker with timeout', {
      workerId: worker.workerId,
      requestId: request.requestId,
      subject,
      streaming: isStreaming,
      timeoutMs,
    });

    // Update active request with worker ID
    const activeReq = this.activeRequests.get(request.requestId);
    if (activeReq) {
      activeReq.workerId = worker.workerId;
    }

    try {
      // Execute with timeout
      const stream = await this.timeoutHandler.withTimeout(
        (async () => {
          await this.nats.publish(subject, request);
          return await this.subscribeToResponse(request.requestId);
        })(),
        timeoutMs,
        `Request timeout (${timeoutMs}ms) for worker ${worker.workerId}`
      );

      // Success - update circuit breaker
      this.updateCircuitBreaker(worker.workerId, true);

      this.logger.debug('Request succeeded', {
        workerId: worker.workerId,
        requestId: request.requestId,
      });

      return stream;
    } catch (error) {
      // Failure - update circuit breaker
      this.updateCircuitBreaker(worker.workerId, false);

      const errorMessage = (error as Error).message;
      const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout');

      this.logger.error('Request failed', error as Error, {
        workerId: worker.workerId,
        requestId: request.requestId,
        timeout: isTimeout,
        timeoutMs,
      });

      // Re-throw with enhanced error context
      if (isTimeout) {
        throw new ControllerError(
          `Worker ${worker.workerId} timed out after ${timeoutMs}ms`,
          ControllerErrorCode.WORKER_TIMEOUT,
          {
            workerId: worker.workerId,
            requestId: request.requestId,
            timeoutMs,
            streaming: isStreaming,
          },
          true // retryable
        );
      }

      if (errorMessage.includes('unavailable') || errorMessage.includes('connection')) {
        throw new ControllerError(
          `Worker ${worker.workerId} unavailable: ${errorMessage}`,
          ControllerErrorCode.WORKER_UNAVAILABLE,
          {
            workerId: worker.workerId,
            requestId: request.requestId,
          },
          true // retryable
        );
      }

      // Generic error - re-throw original
      throw error;
    }
  }


  /**
   * Subscribe to response stream from worker
   */
  private async subscribeToResponse(requestId: string): Promise<ReadableStream> {
    const subject = `response.${requestId}`;

    this.logger.debug('Subscribing to response stream', {
      requestId,
      subject,
    });

    // Create ReadableStream that reads from NATS
    const stream = new ReadableStream({
      start: async (controller) => {
        // Subscribe to response topic
        await this.nats.subscribe<StreamingResponse>(subject, (response) => {
          if (response.type === 'token') {
            // Enqueue token
            controller.enqueue(response.token);
          } else if (response.type === 'done') {
            // Mark request as complete
            this.activeRequests.delete(requestId);

            this.logger.info('Inference request complete', {
              requestId,
              totalTokens: response.totalTokens,
              latencyMs: response.latencyMs,
            });

            // Close stream
            controller.close();
          } else if (response.type === 'error') {
            // Mark request as failed
            this.activeRequests.delete(requestId);

            this.logger.error('Inference request failed', new Error(response.error), {
              requestId,
              code: response.code,
            });

            // Error stream
            controller.error(new Error(response.error));
          }
        });
      },

      cancel: () => {
        // Cleanup on stream cancel
        this.activeRequests.delete(requestId);
        this.logger.debug('Response stream cancelled', { requestId });
      },
    });

    return stream;
  }

  /**
   * Get worker count
   */
  getWorkerCount(): number {
    return this.workerRegistry.getWorkerCount();
  }

  /**
   * Get online worker count
   */
  getOnlineWorkerCount(): number {
    return this.workerRegistry.getOnlineWorkerCount();
  }

  /**
   * Get worker by ID
   */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.workerRegistry.getWorker(workerId);
  }

  /**
   * Get all workers
   */
  getAllWorkers(): WorkerInfo[] {
    return this.workerRegistry.getAllWorkers();
  }

  /**
   * Initialize request metadata tracking
   */
  private initRequestMetadata(request: InferenceRequest): RequestMetadata {
    const metadata: RequestMetadata = {
      requestId: request.requestId,
      startTime: Date.now(),
      retryCount: 0,
      selectedWorker: '',
      failedWorkers: [],
      circuitBreakerTrips: 0,
      timeouts: 0,
    };

    this.requestMetrics.set(request.requestId, metadata);
    return metadata;
  }

  /**
   * Update request metadata on retry
   */
  private updateMetadataOnRetry(
    requestId: string,
    workerId: string,
    error: Error
  ): void {
    const metadata = this.requestMetrics.get(requestId);
    if (!metadata) return;

    metadata.retryCount++;
    metadata.failedWorkers.push(workerId);

    if (error instanceof ControllerError) {
      if (error.errorCode === ControllerErrorCode.WORKER_TIMEOUT) {
        metadata.timeouts++;
      }
      if (error.errorCode === ControllerErrorCode.CIRCUIT_BREAKER_OPEN) {
        metadata.circuitBreakerTrips++;
      }
    }
  }

  /**
   * Finalize request metadata
   */
  private finalizeRequestMetadata(
    requestId: string,
    workerId: string,
    error?: Error
  ): RequestMetadata | null {
    const metadata = this.requestMetrics.get(requestId);
    if (!metadata) return null;

    metadata.endTime = Date.now();
    metadata.durationMs = metadata.endTime - metadata.startTime;
    metadata.selectedWorker = workerId;

    if (error) {
      metadata.finalError = error.message;
    }

    return metadata;
  }

  /**
   * Get request metrics
   */
  public getRequestMetrics(requestId: string): RequestMetadata | null {
    return this.requestMetrics.get(requestId) || null;
  }

  /**
   * Get all active request metrics
   */
  public getAllRequestMetrics(): RequestMetadata[] {
    return Array.from(this.requestMetrics.values());
  }

  /**
   * Clear old metrics (cleanup)
   */
  private cleanupOldMetrics(maxAgeMs: number = 300000): void {
    const now = Date.now();
    for (const [requestId, metadata] of this.requestMetrics.entries()) {
      if (metadata.endTime && now - metadata.endTime > maxAgeMs) {
        this.requestMetrics.delete(requestId);
      }
    }
  }

  /**
   * Get cluster status
   */
  getClusterStatus(): ClusterStatus {
    const uptime = Date.now() - this.startTime;

    return {
      controller: {
        version: '0.13.0',
        uptime,
        mode: 'controller',
        state: this.state,
      },
      workers: {
        total: this.workerRegistry.getWorkerCount(),
        online: this.workerRegistry.getOnlineWorkerCount(),
        offline: this.workerRegistry.getOfflineWorkers().length,
      },
      requests: {
        active: this.activeRequests.size,
        total: this.totalRequests,
      },
    };
  }
}
