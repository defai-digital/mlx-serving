/**
 * Worker Node
 *
 * Main worker class with lifecycle management, registration, heartbeat,
 * and inference execution.
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import { EventEmitter } from 'events';
import { NatsClient } from '../nats/client.js';
import { Engine } from '@/api/engine.js';
import type { ClusterConfig } from '../types/config.js';
import type {
  WorkerRegistration,
  WorkerHeartbeat,
  InferenceRequest,
  StreamingTokenResponse,
  StreamingDoneResponse,
  StreamingErrorResponse,
  ModelSkills,
} from '../types/messages.js';
import { HardwareReporter } from './hardware-reporter.js';
import { MetricsCollector } from './metrics-collector.js';
import { ModelScanner } from './model-scanner.js';
import { ModelPreWarmer } from './model-prewarmer.js';
import { ResourceManager, type ResourceLimitsConfig } from './resource-manager.js';
import { RequestQueue, RequestPriority, type QueueConfig } from './request-queue.js';
import { ContinuousBatcher, type BatcherConfig } from './continuous-batcher.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { WorkerError, ControllerErrorCode } from '../utils/errors.js';

export enum WorkerState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  REGISTERING = 'registering',
  READY = 'ready',
  DRAINING = 'draining',
  STOPPED = 'stopped',
}

export interface WorkerNodeOptions {
  config: ClusterConfig;
  workerId?: string;
  runtimeConfig?: any; // Runtime config for Engine (separate from cluster config)
}

/**
 * Worker Node
 *
 * Implements complete worker lifecycle:
 * 1. Connect to NATS
 * 2. Register with cluster (hardware info + skills)
 * 3. Start heartbeat loop (every 5s)
 * 4. Subscribe to inference requests
 * 5. Execute inference and stream tokens
 * 6. Graceful shutdown on stop
 */
export class WorkerNode extends EventEmitter {
  private state: WorkerState = WorkerState.IDLE;
  private readonly workerId: string;
  private readonly nats: NatsClient;
  private readonly engine: Engine;
  private readonly config: ClusterConfig;
  private readonly logger: Logger;
  private readonly hardwareReporter: HardwareReporter;
  private readonly metricsCollector: MetricsCollector;
  private readonly modelScanner: ModelScanner;
  private preWarmer?: ModelPreWarmer;

  // Week 4 integration: Resource management, queueing, and batching
  private resourceManager?: ResourceManager;
  private requestQueue?: RequestQueue;
  private batcher?: ContinuousBatcher;
  private batcherRunning = false;
  private pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
  }> = new Map();

  private heartbeatInterval?: NodeJS.Timeout;
  private activeRequests = 0;
  private modelSkills?: ModelSkills;

  constructor(options: WorkerNodeOptions) {
    super();

    this.config = options.config;
    this.workerId = options.workerId || randomUUID();
    this.logger = createLogger(`WorkerNode:${this.workerId.slice(0, 8)}`);

    // Initialize NATS client
    this.nats = new NatsClient();

    // Initialize Engine with runtime config
    this.engine = new Engine(options.runtimeConfig || {});

    // Initialize hardware reporter
    this.hardwareReporter = new HardwareReporter();

    // Initialize metrics collector
    this.metricsCollector = new MetricsCollector(1000);

    // Initialize model scanner (use default 'model' directory)
    this.modelScanner = new ModelScanner('model');

    // Week 4: Initialize ResourceManager if enabled
    if (this.config.worker?.resourceLimits?.enabled) {
      this.resourceManager = new ResourceManager({
        softMemoryLimitGB: this.config.worker.resourceLimits.softMemoryLimitGB || 8,
        hardMemoryLimitGB: this.config.worker.resourceLimits.hardMemoryLimitGB || 10,
        checkIntervalMs: this.config.worker.resourceLimits.checkIntervalMs || 5000,
      });

      this.logger.info('Resource manager initialized', {
        softLimitGB: this.config.worker.resourceLimits.softMemoryLimitGB,
        hardLimitGB: this.config.worker.resourceLimits.hardMemoryLimitGB,
      });
    }

    // Week 4: Initialize RequestQueue if enabled
    if (this.config.worker?.requestQueue?.enabled) {
      this.requestQueue = new RequestQueue({
        maxDepth: this.config.worker.requestQueue.maxDepth || 100,
        backpressureStrategy: this.config.worker.requestQueue.rejectWhenFull
          ? 'reject'
          : 'drop_low_priority',
      });

      this.logger.info('Request queue initialized', {
        maxDepth: this.config.worker.requestQueue.maxDepth,
        rejectWhenFull: this.config.worker.requestQueue.rejectWhenFull,
      });
    }

    // Week 4: Initialize ContinuousBatcher if enabled
    if (this.config.worker?.continuousBatching?.enabled) {
      this.batcher = new ContinuousBatcher(
        {
          minBatchSize: this.config.worker.continuousBatching.minBatchSize || 1,
          maxBatchSize: this.config.worker.continuousBatching.maxBatchSize || 8,
          batchTimeoutMs: this.config.worker.continuousBatching.batchTimeoutMs || 50,
          adaptiveTimeout: this.config.worker.continuousBatching.adaptiveTimeout !== false,
        },
        this.executeBatch.bind(this)
      );

      this.logger.info('Continuous batcher initialized', {
        minBatchSize: this.config.worker.continuousBatching.minBatchSize,
        maxBatchSize: this.config.worker.continuousBatching.maxBatchSize,
      });
    }

    this.logger.info('Worker node created', {
      workerId: this.workerId,
      state: this.state,
      optimizationsEnabled: {
        resourceManager: !!this.resourceManager,
        requestQueue: !!this.requestQueue,
        batcher: !!this.batcher,
      },
    });
  }

  /**
   * Start worker node
   *
   * Lifecycle: IDLE → CONNECTING → REGISTERING → READY
   *           STOPPED → CONNECTING → REGISTERING → READY (restart)
   */
  async start(): Promise<void> {
    if (this.state !== WorkerState.IDLE && this.state !== WorkerState.STOPPED) {
      throw new WorkerError('Worker already started', 'INVALID_STATE');
    }

    this.logger.info('Starting worker node');

    // Reset state if restarting
    if (this.state === WorkerState.STOPPED) {
      this.activeRequests = 0;
      this.pendingRequests.clear();
      this.batcherRunning = false;
      this.logger.info('Worker state reset for restart');
    }

    try {
      // 1. Connect to NATS
      this.state = WorkerState.CONNECTING;
      this.emit('stateChange', this.state);

      await this.nats.connect(this.config.nats);
      this.logger.info('Connected to NATS', {
        server: this.nats.getServerUrl(),
      });

      // 2. Scan models
      this.logger.info('Scanning local models');
      this.modelSkills = await this.modelScanner.scan();
      this.logger.info('Model scan complete', {
        count: this.modelSkills.availableModels.length,
      });

      // 3. Initialize pre-warmer if configured
      if (this.config.worker?.preWarming?.enabled) {
        this.preWarmer = new ModelPreWarmer(
          this.engine,
          this.config.worker.preWarming
        );

        this.logger.info('Pre-warmer initialized', {
          models: this.config.worker.preWarming.models.length,
        });
      }

      // 4. Determine when to register
      const registerWhen = this.config.worker?.preWarming?.registerWhen || 'warming';
      const shouldRegisterBeforeWarm = registerWhen === 'warming';

      // 5. Register early if configured
      if (shouldRegisterBeforeWarm || !this.preWarmer) {
        this.state = WorkerState.REGISTERING;
        this.emit('stateChange', this.state);
        await this.register();
        this.logger.info('Registered with cluster');
      }

      // 6. Start pre-warming
      if (this.preWarmer) {
        if (shouldRegisterBeforeWarm) {
          // Background pre-warming
          this.logger.info('Starting background pre-warming');
          this.preWarmer.warmModels().catch((error) => {
            this.logger.error('Pre-warming error', error);
          });
        } else {
          // Wait for pre-warming before registration
          this.logger.info('Starting pre-warming (blocking)');
          await this.preWarmer.warmModels();

          this.state = WorkerState.REGISTERING;
          this.emit('stateChange', this.state);
          await this.register();
          this.logger.info('Registered with cluster (pre-warming complete)');
        }
      }

      // 7. Week 4: Start resource monitoring if enabled
      if (this.resourceManager) {
        this.resourceManager.start();
        this.logger.info('Resource monitoring started', {
          softLimitGB: this.config.worker?.resourceLimits?.softMemoryLimitGB,
          hardLimitGB: this.config.worker?.resourceLimits?.hardMemoryLimitGB,
        });
      }

      // 8. Week 4: Start batcher loop if enabled
      if (this.batcher && this.requestQueue) {
        this.startBatcherLoop();
        this.logger.info('Batcher loop started');
      }

      // 9. Subscribe to inference requests
      await this.subscribeToInferenceRequests();
      this.logger.info('Subscribed to inference requests');

      // 10. Start heartbeat
      this.startHeartbeat();
      this.logger.info('Heartbeat started');

      // 11. Worker is ready
      this.state = WorkerState.READY;
      this.emit('stateChange', this.state);
      this.emit('ready');

      this.logger.info('Worker node ready', {
        workerId: this.workerId,
        capabilities: this.hardwareReporter.getCapabilities(),
        preWarmStatus: this.preWarmer?.getStatus(),
        optimizationsActive: {
          resourceManager: !!this.resourceManager,
          requestQueue: !!this.requestQueue,
          batcher: !!this.batcher,
        },
      });
    } catch (error) {
      this.state = WorkerState.STOPPED;
      this.emit('stateChange', this.state);
      this.logger.error('Failed to start worker', error as Error);
      throw new WorkerError(
        `Failed to start worker: ${(error as Error).message}`,
        'START_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Stop worker node
   *
   * Lifecycle: READY → DRAINING → STOPPED
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping worker');
    this.state = WorkerState.DRAINING;
    this.emit('stateChange', this.state);

    // 1. Send deregistration message to controller
    try {
      await this.deregister();
      this.logger.info('Deregistration message sent');
    } catch (error) {
      this.logger.error('Failed to send deregistration', error as Error);
    }

    // 2. Abort pre-warming if in progress
    if (this.preWarmer && !this.preWarmer.isComplete()) {
      this.preWarmer.abort();
    }

    // 3. Week 4: Stop batcher loop
    if (this.batcher) {
      this.batcherRunning = false;
      this.logger.info('Batcher loop stopping');
      // Wait for current batch to complete
      await this.sleep(100);
    }

    // 4. Week 4: Stop resource monitoring
    if (this.resourceManager) {
      this.resourceManager.stop();
      this.logger.info('Resource monitoring stopped');
    }

    // 5. Stop heartbeat
    this.stopHeartbeat();

    // 6. Wait for active requests to complete (max 30s)
    const maxWait = 30000;
    const startTime = Date.now();

    while (this.activeRequests > 0 && Date.now() - startTime < maxWait) {
      this.logger.info(`Waiting for ${this.activeRequests} active requests to complete`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.activeRequests > 0) {
      this.logger.warn(`Force shutdown with ${this.activeRequests} requests still active`);
    }

    // 7. Reject any pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      pending.reject(new WorkerError('Worker shutting down', 'WORKER_SHUTDOWN'));
      this.pendingRequests.delete(requestId);
    }

    // 8. Disconnect from NATS
    await this.nats.disconnect();

    // 9. Cleanup
    this.state = WorkerState.STOPPED;
    this.emit('stateChange', this.state);
    this.emit('stopped');
    this.logger.info('Worker stopped');
  }

  /**
   * Get pre-warming status (for heartbeat)
   */
  getPreWarmStatus(): any {
    if (!this.preWarmer) return null;

    return {
      enabled: true,
      progress: this.preWarmer.getProgress(),
      complete: this.preWarmer.isComplete(),
      ...this.preWarmer.getStatus(),
    };
  }

  /**
   * Get current worker state
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Get worker ID
   */
  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Get active request count
   */
  getActiveRequests(): number {
    return this.activeRequests;
  }

  /**
   * Register worker with cluster
   */
  private async register(): Promise<void> {
    const registration = this.buildRegistrationMessage();

    try {
      await this.nats.publish('worker.register', registration);
      this.logger.info('Registration message sent', {
        workerId: this.workerId,
        skillsCount: registration.skills.availableModels.length,
      });
    } catch (error) {
      this.logger.error('Failed to send registration', error as Error);
      throw error;
    }
  }

  /**
   * Deregister worker from cluster
   */
  private async deregister(): Promise<void> {
    try {
      await this.nats.publish('worker.deregister', {
        workerId: this.workerId,
        timestamp: Date.now(),
      });
      this.logger.info('Deregistration message sent', {
        workerId: this.workerId,
      });
    } catch (error) {
      this.logger.error('Failed to send deregistration', error as Error);
      throw error;
    }
  }

  /**
   * Build registration message
   */
  private buildRegistrationMessage(): WorkerRegistration {
    const hardware = this.hardwareReporter.getHardwareProfile();
    const capabilities = this.hardwareReporter.getCapabilities();

    return {
      workerId: this.workerId,
      hostname: os.hostname(),
      ip: this.getLocalIp(),
      port: this.config.worker?.port || 8080,
      skills: this.modelSkills || {
        availableModels: [],
        modelPaths: {},
        totalModelSize: 0,
        lastScanned: Date.now(),
      },
      status: 'online',
      timestamp: Date.now(),
    };
  }

  /**
   * Start heartbeat loop
   */
  private startHeartbeat(): void {
    const interval = this.config.discovery?.heartbeatIntervalMs || 5000;

    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (error) {
        this.logger.error('Failed to send heartbeat', error as Error);
      }
    }, interval);

    this.logger.debug('Heartbeat interval started', { intervalMs: interval });
  }

  /**
   * Stop heartbeat loop
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
      this.logger.debug('Heartbeat interval stopped');
    }
  }

  /**
   * Send heartbeat message
   */
  private async sendHeartbeat(): Promise<void> {
    const metrics = await this.collectMetrics();
    const heartbeat: WorkerHeartbeat = {
      workerId: this.workerId,
      status: this.getWorkerStatus(),
      metrics,
      timestamp: Date.now(),
    };

    await this.nats.publish('worker.heartbeat', heartbeat);
    this.logger.debug('Heartbeat sent', {
      activeRequests: metrics.activeRequests,
      cpuUsage: metrics.cpuUsagePercent,
    });
  }

  /**
   * Collect current metrics
   */
  private async collectMetrics(): Promise<WorkerHeartbeat['metrics']> {
    const collectorMetrics = this.metricsCollector.getMetrics();
    const cpuUsage = await this.hardwareReporter.getCpuUsage();
    const memoryUsage = this.hardwareReporter.getMemoryUsage();
    const gpuUtilization = this.hardwareReporter.getGpuUtilization();
    const loadedModels = this.engine.listModels().map(h => h.descriptor.id);

    return {
      cpuUsagePercent: cpuUsage,
      memoryUsedGB: memoryUsage,
      gpuUtilizationPercent: gpuUtilization,
      activeRequests: this.activeRequests,
      totalRequestsHandled: collectorMetrics.requests.total,
      avgLatencyMs: collectorMetrics.latency.avg,
      modelsLoaded: loadedModels,
    };
  }

  /**
   * Get worker status
   */
  private getWorkerStatus(): 'online' | 'offline' | 'degraded' {
    if (this.state !== WorkerState.READY) return 'offline';

    const errorRate = this.metricsCollector.getErrorRate();
    if (errorRate > 0.2) return 'degraded'; // >20% error rate

    return 'online';
  }

  /**
   * Subscribe to inference requests
   */
  private async subscribeToInferenceRequests(): Promise<void> {
    const subject = `worker.${this.workerId}.inference`;

    await this.nats.subscribe<InferenceRequest>(subject, async (request) => {
      await this.handleInferenceRequest(request);
    });

    this.logger.info('Subscribed to inference topic', { subject });
  }

  // ============================================================================
  // Week 4: Helper Methods
  // ============================================================================

  /**
   * Check if worker can accept new request based on resource limits
   */
  private canAcceptRequest(): boolean {
    if (!this.resourceManager) return true;
    return !this.resourceManager.shouldRejectRequest();
  }

  /**
   * Check if worker is under memory pressure
   */
  private isUnderPressure(): boolean {
    if (!this.resourceManager) return false;
    return this.resourceManager.isUnderPressure();
  }

  /**
   * Determine request priority based on request properties
   */
  private determinePriority(request: InferenceRequest): RequestPriority {
    // Check if request has explicit priority
    if ((request as any).priority) {
      return (request as any).priority as RequestPriority;
    }

    // Buffered requests get higher priority (complete faster)
    if ((request as any).stream === false) {
      return RequestPriority.HIGH;
    }

    // Streaming requests get medium priority
    return RequestPriority.MEDIUM;
  }

  /**
   * Enqueue request and wait for completion
   */
  private async enqueueAndWait(
    request: InferenceRequest,
    priority: RequestPriority
  ): Promise<AsyncIterable<{ type: string; token?: string }>> {
    return new Promise((resolve, reject) => {
      // Store resolve/reject for later
      this.pendingRequests.set(request.requestId, {
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      // Enqueue request
      const enqueued = this.requestQueue!.enqueue(request, priority);

      if (!enqueued) {
        this.pendingRequests.delete(request.requestId);
        reject(new WorkerError(
          'Failed to enqueue request',
          'QUEUE_ERROR'
        ));
        return;
      }

      this.logger.debug('Request enqueued', {
        requestId: request.requestId,
        priority,
        queueDepth: this.requestQueue!.getDepth(),
        pendingCount: this.pendingRequests.size,
      });
    });
  }

  /**
   * Start background batcher loop
   * Continuously dequeues requests and processes them in batches
   */
  private async startBatcherLoop(): Promise<void> {
    if (!this.requestQueue || !this.batcher) return;

    this.batcherRunning = true;
    this.logger.info('Batcher loop starting');

    // Run loop in background
    (async () => {
      while (this.batcherRunning) {
        try {
          const queueDepth = this.requestQueue!.getDepth();

          // No requests in queue, sleep briefly
          if (queueDepth === 0) {
            await this.sleep(10);
            continue;
          }

          // Dequeue batch of requests
          const batchSize = Math.min(
            queueDepth,
            this.config.worker!.continuousBatching!.maxBatchSize || 8
          );

          const requests: InferenceRequest[] = [];
          for (let i = 0; i < batchSize; i++) {
            const request = this.requestQueue!.dequeue();
            if (request) {
              requests.push(request);
            }
          }

          if (requests.length === 0) {
            continue;
          }

          this.logger.debug('Processing batch', {
            batchSize: requests.length,
            remainingInQueue: this.requestQueue!.getDepth(),
          });

          // Enqueue in batcher for processing
          for (const req of requests) {
            await this.batcher!.enqueue(req);
          }

          // Small sleep to allow batcher to process
          await this.sleep(5);
        } catch (error) {
          this.logger.error('Batcher loop error', error as Error);
          await this.sleep(100); // Back off on error
        }
      }

      this.logger.info('Batcher loop stopped');
    })();
  }

  /**
   * Execute batch of requests
   * Called by ContinuousBatcher when a batch is ready
   */
  private async executeBatch(requests: InferenceRequest[]): Promise<any[]> {
    this.logger.debug('Executing batch', {
      batchSize: requests.length,
    });

    const results = [];

    for (const request of requests) {
      try {
        // Load model if needed
        await this.loadModelIfNeeded(request.modelId);

        // Execute inference
        const stream = await this.executeInference(request);

        // Resolve pending promise
        const pending = this.pendingRequests.get(request.requestId);
        if (pending) {
          pending.resolve(stream);
          this.pendingRequests.delete(request.requestId);
        }

        results.push({
          requestId: request.requestId,
          success: true,
          stream,
        });
      } catch (error) {
        this.logger.error('Request failed in batch', error as Error, {
          requestId: request.requestId,
        });

        // Reject pending promise
        const pending = this.pendingRequests.get(request.requestId);
        if (pending) {
          pending.reject(error as Error);
          this.pendingRequests.delete(request.requestId);
        }

        results.push({
          requestId: request.requestId,
          success: false,
          error: error as Error,
        });
      }
    }

    return results;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Request Handling
  // ============================================================================

  /**
   * Handle inference request
   */
  private async handleInferenceRequest(request: InferenceRequest): Promise<void> {
    const startTime = Date.now();
    this.activeRequests++;

    this.logger.info('Inference request received', {
      requestId: request.requestId,
      modelId: request.modelId,
      promptLength: request.prompt.length,
    });

    try {
      // Week 4: Check resource limits before processing
      if (this.resourceManager && !this.canAcceptRequest()) {
        const status = this.resourceManager.getStatus();
        throw new WorkerError(
          `Worker at capacity (memory: ${status.memoryUsedGB.toFixed(2)}GB / ${status.memoryTotalGB.toFixed(2)}GB)`,
          'RESOURCE_LIMIT_EXCEEDED'
        );
      }

      // Week 4: Check queue capacity
      if (this.requestQueue && this.requestQueue.isFull()) {
        throw new WorkerError(
          `Request queue full (depth: ${this.requestQueue.getDepth()})`,
          'QUEUE_FULL'
        );
      }

      // Week 4: If batching enabled, use queue and wait
      if (this.batcher && this.requestQueue) {
        const priority = this.determinePriority(request);
        const stream = await this.enqueueAndWait(request, priority);
        await this.streamTokens(request.requestId, request.modelId, stream, startTime);
      } else {
        // Fallback to direct processing (no batching)
        await this.loadModelIfNeeded(request.modelId);
        const stream = await this.executeInference(request);
        await this.streamTokens(request.requestId, request.modelId, stream, startTime);
      }
    } catch (error) {
      this.logger.error('Inference request failed', error as Error, {
        requestId: request.requestId,
      });

      // Send error response
      const errorResponse: StreamingErrorResponse = {
        requestId: request.requestId,
        type: 'error',
        error: (error as Error).message,
        code: (error as any).code || 'INFERENCE_ERROR',
      };

      await this.nats.publish(`response.${request.requestId}`, errorResponse);

      // Record error
      this.metricsCollector.recordError(error as Error);
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Load model if not already loaded
   */
  private async loadModelIfNeeded(modelId: string): Promise<void> {
    const loadedModels = this.engine.listModels().map(h => h.descriptor.id);

    if (!loadedModels.includes(modelId)) {
      this.logger.info('Loading model', { modelId });
      await this.engine.loadModel({ model: modelId });
      this.logger.info('Model loaded', { modelId });
    }
  }

  /**
   * Execute inference request
   */
  private async executeInference(request: InferenceRequest): Promise<AsyncIterable<{ type: string; token?: string }>> {
    const params = {
      model: request.modelId,
      prompt: request.prompt,
      maxTokens: request.maxTokens ?? 100,
      temperature: request.temperature ?? 0.7,
      topP: request.topP ?? 0.9,
    };

    this.logger.debug('Executing inference', {
      requestId: request.requestId,
      params,
    });

    return this.engine.createGenerator(params);
  }

  /**
   * Stream tokens back to NATS
   */
  private async streamTokens(
    requestId: string,
    modelId: string,
    stream: AsyncIterable<{ type: string; token?: string }>,
    startTime: number,
  ): Promise<void> {
    let tokenIndex = 0;
    let totalTokens = 0;

    try {
      for await (const chunk of stream) {
        // Only process token chunks
        if (chunk.type !== 'token' || !chunk.token) {
          continue;
        }

        // Send token message
        const tokenResponse: StreamingTokenResponse = {
          requestId,
          type: 'token',
          token: chunk.token,
          index: tokenIndex++,
        };

        await this.nats.publish(`response.${requestId}`, tokenResponse);
        totalTokens++;

        this.logger.debug('Token streamed', {
          requestId,
          index: tokenIndex - 1,
        });
      }

      // Send done message
      const latencyMs = Date.now() - startTime;
      const doneResponse: StreamingDoneResponse = {
        requestId,
        type: 'done',
        totalTokens,
        latencyMs,
      };

      await this.nats.publish(`response.${requestId}`, doneResponse);

      // Record metrics
      this.metricsCollector.recordRequest(latencyMs, totalTokens, modelId);

      this.logger.info('Inference complete', {
        requestId,
        totalTokens,
        latencyMs,
      });
    } catch (error) {
      this.logger.error('Streaming error', error as Error, { requestId });
      throw error;
    }
  }

  /**
   * Get local IP address
   */
  private getLocalIp(): string {
    try {
      const interfaces = os.networkInterfaces();
      for (const name in interfaces) {
        const iface = interfaces[name];
        if (!iface) continue;

        for (const alias of iface) {
          if (alias.family === 'IPv4' && !alias.internal) {
            return alias.address;
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to get local IP', error as Error);
    }

    return '127.0.0.1'; // Fallback
  }

  // ============================================================================
  // Week 4: Monitoring Methods
  // ============================================================================

  /**
   * Get resource statistics
   */
  public getResourceStats(): any {
    if (!this.resourceManager) {
      return null;
    }

    const status = this.resourceManager.getStatus();
    return {
      memoryUsedGB: status.memoryUsedGB,
      memoryTotalGB: status.memoryTotalGB,
      memoryUsagePercent: status.memoryUsagePercent,
      underPressure: status.underPressure,
      shouldReject: status.shouldReject,
    };
  }

  /**
   * Get queue statistics
   */
  public getQueueStats(): any {
    if (!this.requestQueue) {
      return null;
    }

    return {
      depth: this.requestQueue.getDepth(),
      isFull: this.requestQueue.isFull(),
      pendingRequests: this.pendingRequests.size,
      stats: this.requestQueue.getStats(),
    };
  }

  /**
   * Get batcher statistics
   */
  public getBatcherStats(): any {
    if (!this.batcher) {
      return null;
    }

    return this.batcher.getStats();
  }

  /**
   * Get comprehensive worker statistics (includes Week 4 optimizations)
   */
  public getWorkerStats(): any {
    return {
      workerId: this.workerId,
      state: this.state,
      activeRequests: this.activeRequests,
      capabilities: this.hardwareReporter.getCapabilities(),
      metrics: this.metricsCollector.getMetrics(),
      resources: this.getResourceStats(),
      queue: this.getQueueStats(),
      batcher: this.getBatcherStats(),
      preWarmStatus: this.preWarmer?.getStatus() || null,
    };
  }
}
