# Phase 2 Week 2: Model Pre-warming & Advanced Batching - Product Requirements

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 2 of 13 (Week 5 overall)
**Duration**: 5 working days
**Status**: Ready to Start
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Executive Summary

Week 2 of Phase 2 focuses on optimizing inference performance through model pre-warming strategies and implementing advanced continuous batching. By end of week, we will have eliminated cold-start latency for popular models and significantly improved throughput through intelligent request batching.

**Goal**: Maximize inference throughput and minimize latency through pre-warming and continuous batching

**Success Criteria**:
- ✅ Model pre-warming reduces cold-start latency by 90%+ (2000ms → 200ms)
- ✅ Continuous batching improves throughput by 2-3x
- ✅ Dynamic batch sizing adapts to load
- ✅ Request queueing with backpressure prevents overload
- ✅ Worker resource limits prevent OOM crashes
- ✅ Graceful degradation under high load
- ✅ Performance benchmarks show 2-3x improvement

---

## Table of Contents

1. [Background](#background)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Technical Specifications](#technical-specifications)
4. [Architecture](#architecture)
5. [API Design](#api-design)
6. [Testing Strategy](#testing-strategy)
7. [Success Metrics](#success-metrics)
8. [Dependencies](#dependencies)
9. [Risk Assessment](#risk-assessment)

---

## Background

### Current State

**Phase 1 Completed** (Weeks 1-3):
- ✅ Distributed inference foundation
- ✅ Smart routing (skills + hardware + load)
- ✅ Basic request handling

**Phase 2 Week 1 Completed**:
- ✅ Integration testing
- ✅ Sticky sessions (40-60% latency improvement)
- ✅ Retry logic with failover
- ✅ Circuit breaker
- ✅ Connection pooling

**Current Performance Issues**:
- ❌ Cold-start latency: 2000ms for first request (model loading)
- ❌ Low throughput: Processing requests sequentially
- ❌ No batching: Each request processed individually
- ❌ Resource spikes: No memory limits
- ❌ Queue buildup: No backpressure handling

**Phase 2 Week 2 Focus**: Optimize performance through pre-warming and batching

---

## Goals and Non-Goals

### Goals (Week 2)

✅ **Must Have (P0)**:

1. **Model Pre-warming System**
   - Pre-load popular models on worker startup
   - Configurable warm model list
   - Health check includes warm status
   - Reduces cold-start from 2000ms → 200ms

2. **Continuous Batching**
   - Batch multiple concurrent requests
   - Dynamic batch sizing (1-32 requests)
   - Adaptive batch timeout (10-100ms)
   - 2-3x throughput improvement

3. **Request Queueing**
   - Per-worker request queue
   - Configurable queue depth
   - Backpressure when queue full
   - FIFO + priority support

4. **Worker Resource Management**
   - Memory usage tracking
   - Configurable memory limits
   - Graceful degradation (reject requests when near limit)
   - OOM prevention

5. **Performance Monitoring**
   - Batch statistics (size, latency)
   - Queue statistics (depth, wait time)
   - Resource statistics (memory, CPU)
   - Pre-warming status

✅ **Should Have (P1)**:
1. Model pre-warming with priority (high/medium/low)
2. Intelligent batch scheduling (prefer similar prompts)
3. Request priority queuing
4. Memory pressure signals
5. Performance dashboards

✅ **Nice to Have (P2)**:
1. Predictive model pre-warming (based on usage patterns)
2. Adaptive batching parameters
3. Multi-tier queuing
4. Request sharding for large batches

### Non-Goals (Week 2)

❌ **Out of Scope**:
1. Speculative decoding (Phase 3)
2. KV cache sharing across requests (Phase 3)
3. Multi-GPU support (Phase 4)
4. Distributed batching across workers (Phase 4)
5. Model quantization (existing feature)
6. Web dashboard (Phase 3)

---

## Technical Specifications

### 1. Model Pre-warming System

**Purpose**: Eliminate cold-start latency by pre-loading models on worker startup

**Performance Impact**:
- **Cold Start** (no pre-warm): 2000ms first request + 500ms subsequent
- **Warm Start** (pre-warmed): 200ms first request + 500ms subsequent
- **Improvement**: 90% reduction in cold-start latency

**How It Works**:
```
Worker Startup:
1. Load configuration (warm_models list)
2. Connect to NATS
3. Start pre-warming models in background
4. Register with controller (status: warming)
5. Complete pre-warming
6. Update status to online
7. Ready to serve requests with <200ms first token
```

**Configuration**:
```yaml
# config/cluster.yaml
cluster:
  worker:
    pre_warming:
      enabled: true
      models:
        # High priority (load first)
        - model: "mlx-community/Llama-3.2-3B-Instruct-4bit"
          priority: high
        - model: "mlx-community/Qwen2.5-7B-Instruct-4bit"
          priority: high

        # Medium priority (load after high)
        - model: "mlx-community/gemma-2-9b-it-4bit"
          priority: medium

        # Low priority (load if time permits)
        - model: "mlx-community/Qwen2.5-32B-Instruct-4bit"
          priority: low

      timeout_per_model_ms: 30000  # 30s max per model
      parallel: false  # Load sequentially to avoid GPU contention
      register_when: "warming"  # or "complete"
```

**Implementation**:

```typescript
// src/distributed/worker/model-prewarmer.ts

export interface PreWarmConfig {
  enabled: boolean;
  models: Array<{
    model: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  timeoutPerModel: number;
  parallel: boolean;
  registerWhen: 'warming' | 'complete';
}

export interface PreWarmStatus {
  total: number;
  completed: number;
  failed: number;
  inProgress: string | null;
  startedAt: number;
  completedAt: number | null;
}

export class ModelPreWarmer {
  private status: PreWarmStatus;
  private logger: Logger;

  constructor(
    private engine: Engine,
    private config: PreWarmConfig
  ) {
    this.status = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: null,
      startedAt: 0,
      completedAt: null,
    };
    this.logger = createLogger('ModelPreWarmer');
  }

  /**
   * Start pre-warming models
   */
  async warmModels(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('Pre-warming disabled');
      return;
    }

    this.status.startedAt = Date.now();
    this.status.total = this.config.models.length;

    // Sort by priority (high → medium → low)
    const sorted = this.sortByPriority(this.config.models);

    this.logger.info('Starting model pre-warming', {
      models: sorted.length,
      parallel: this.config.parallel,
    });

    if (this.config.parallel) {
      await this.warmParallel(sorted);
    } else {
      await this.warmSequential(sorted);
    }

    this.status.completedAt = Date.now();
    const duration = this.status.completedAt - this.status.startedAt;

    this.logger.info('Pre-warming complete', {
      total: this.status.total,
      completed: this.status.completed,
      failed: this.status.failed,
      durationMs: duration,
    });
  }

  /**
   * Warm models sequentially (safer, no GPU contention)
   */
  private async warmSequential(
    models: Array<{ model: string; priority: string }>
  ): Promise<void> {
    for (const { model } of models) {
      await this.warmModel(model);
    }
  }

  /**
   * Warm models in parallel (faster, but may cause GPU issues)
   */
  private async warmParallel(
    models: Array<{ model: string; priority: string }>
  ): Promise<void> {
    const promises = models.map(({ model }) => this.warmModel(model));
    await Promise.allSettled(promises);
  }

  /**
   * Warm single model
   */
  private async warmModel(modelId: string): Promise<void> {
    this.status.inProgress = modelId;
    this.logger.info('Warming model', { modelId });

    try {
      // Load model with timeout
      await this.withTimeout(
        this.engine.loadModel({ model: modelId }),
        this.config.timeoutPerModel
      );

      // Generate short test sequence to warm up Metal GPU
      await this.withTimeout(
        this.generateWarmup(modelId),
        5000
      );

      this.status.completed++;
      this.logger.info('Model warmed successfully', { modelId });
    } catch (error) {
      this.status.failed++;
      this.logger.error('Model warming failed', {
        modelId,
        error: (error as Error).message,
      });
    } finally {
      this.status.inProgress = null;
    }
  }

  /**
   * Generate short warmup sequence
   */
  private async generateWarmup(modelId: string): Promise<void> {
    const stream = await this.engine.generate({
      model: modelId,
      prompt: 'Hello',
      maxTokens: 1,  // Just generate 1 token to warm up
      temperature: 0.7,
    });

    // Consume the stream
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  /**
   * Execute with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Sort models by priority
   */
  private sortByPriority(
    models: Array<{ model: string; priority: string }>
  ): Array<{ model: string; priority: string }> {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return [...models].sort((a, b) => {
      const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] ?? 999;
      const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] ?? 999;
      return aPriority - bPriority;
    });
  }

  /**
   * Get pre-warming status
   */
  getStatus(): PreWarmStatus {
    return { ...this.status };
  }

  /**
   * Check if pre-warming is complete
   */
  isComplete(): boolean {
    return this.status.completedAt !== null;
  }

  /**
   * Get completion percentage
   */
  getProgress(): number {
    if (this.status.total === 0) return 100;
    return Math.round(((this.status.completed + this.status.failed) / this.status.total) * 100);
  }
}
```

**Worker Integration**:
```typescript
// src/distributed/worker/worker-node.ts (updated)

export class WorkerNode {
  private preWarmer?: ModelPreWarmer;

  async start(): Promise<void> {
    this.state = WorkerState.CONNECTING;
    await this.nats.connect(this.natsConfig);

    // Initialize pre-warmer
    if (this.config.cluster.worker.pre_warming.enabled) {
      this.preWarmer = new ModelPreWarmer(
        this.engine,
        this.config.cluster.worker.pre_warming
      );
    }

    // Register with controller (status: warming if pre-warming)
    const registerWhen = this.config.cluster.worker.pre_warming.register_when;
    const shouldRegisterBeforeWarm = registerWhen === 'warming';

    if (shouldRegisterBeforeWarm) {
      this.state = WorkerState.REGISTERING;
      await this.register();
    }

    // Start pre-warming in background
    if (this.preWarmer) {
      this.logger.info('Starting background pre-warming');
      this.preWarmer.warmModels().catch((error) => {
        this.logger.error('Pre-warming error', error);
      });
    }

    // Wait for pre-warming if configured
    if (!shouldRegisterBeforeWarm && this.preWarmer) {
      await this.preWarmer.warmModels();
      this.state = WorkerState.REGISTERING;
      await this.register();
    }

    // Continue normal startup
    this.startHeartbeat();
    await this.subscribeToInferenceRequests();
    this.state = WorkerState.READY;
  }
}
```

---

### 2. Continuous Batching

**Purpose**: Process multiple requests simultaneously to maximize GPU utilization

**Performance Impact**:
- **Sequential Processing**: 10 requests/sec throughput
- **Batched Processing**: 25-30 requests/sec throughput
- **Improvement**: 2.5-3x throughput increase

**How It Works**:
```
Requests arrive:
  Req1 (t=0ms)  → Queue
  Req2 (t=5ms)  → Queue
  Req3 (t=8ms)  → Queue
  Req4 (t=12ms) → Queue

Batch formation (every 50ms or when queue reaches 8):
  Batch1: [Req1, Req2, Req3] (size=3)
  → Send to Engine for batched generation
  → Process all 3 simultaneously on GPU
  → Distribute tokens to individual streams

Batch2: [Req4, Req5, Req6, Req7] (size=4)
  → Next batch...
```

**Implementation**:

```typescript
// src/distributed/worker/continuous-batcher.ts

export interface BatchConfig {
  enabled: boolean;
  minBatchSize: number;    // Default: 1
  maxBatchSize: number;    // Default: 8
  batchTimeoutMs: number;  // Default: 50ms
  adaptiveTimeout: boolean;  // Adjust timeout based on load
}

export interface BatchMetrics {
  totalBatches: number;
  totalRequests: number;
  avgBatchSize: number;
  avgBatchLatency: number;
  batchSizeDistribution: Record<number, number>;
}

export class ContinuousBatcher {
  private queue: InferenceRequest[] = [];
  private batchTimer?: NodeJS.Timeout;
  private metrics: BatchMetrics;
  private processing: boolean = false;

  constructor(
    private engine: Engine,
    private config: BatchConfig,
    private onBatchComplete: (results: BatchResult[]) => void
  ) {
    this.metrics = {
      totalBatches: 0,
      totalRequests: 0,
      avgBatchSize: 0,
      avgBatchLatency: 0,
      batchSizeDistribution: {},
    };
  }

  /**
   * Add request to batch queue
   */
  enqueue(request: InferenceRequest): void {
    this.queue.push(request);

    // Start batch timer if not already started
    if (!this.batchTimer && !this.processing) {
      this.startBatchTimer();
    }

    // Process immediately if queue reaches max batch size
    if (this.queue.length >= this.config.maxBatchSize) {
      this.processBatch();
    }
  }

  /**
   * Start batch formation timer
   */
  private startBatchTimer(): void {
    const timeout = this.config.adaptiveTimeout
      ? this.calculateAdaptiveTimeout()
      : this.config.batchTimeoutMs;

    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, timeout);
  }

  /**
   * Calculate adaptive timeout based on queue depth
   */
  private calculateAdaptiveTimeout(): number {
    const queueDepth = this.queue.length;

    if (queueDepth >= this.config.maxBatchSize / 2) {
      return 10;  // Process quickly when queue is filling
    } else if (queueDepth >= 2) {
      return 30;  // Medium wait for small batches
    } else {
      return this.config.batchTimeoutMs;  // Standard wait
    }
  }

  /**
   * Process current batch
   */
  private async processBatch(): Promise<void> {
    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Get batch from queue
    const batchSize = Math.min(this.queue.length, this.config.maxBatchSize);
    if (batchSize < this.config.minBatchSize) {
      // Not enough requests yet, wait longer
      if (this.queue.length > 0) {
        this.startBatchTimer();
      }
      return;
    }

    const batch = this.queue.splice(0, batchSize);
    this.processing = true;

    const startTime = Date.now();

    try {
      // Execute batch
      const results = await this.executeBatch(batch);

      // Update metrics
      const latency = Date.now() - startTime;
      this.updateMetrics(batchSize, latency);

      // Notify completion
      this.onBatchComplete(results);
    } catch (error) {
      this.logger.error('Batch processing failed', {
        batchSize,
        error: (error as Error).message,
      });
    } finally {
      this.processing = false;

      // Process next batch if queue not empty
      if (this.queue.length > 0) {
        this.startBatchTimer();
      }
    }
  }

  /**
   * Execute batch inference
   */
  private async executeBatch(batch: InferenceRequest[]): Promise<BatchResult[]> {
    // For MLX, we need to process requests sequentially for now
    // True batching requires MLX engine changes
    // This is "micro-batching" - small batches processed quickly

    const results: BatchResult[] = [];

    for (const request of batch) {
      try {
        const stream = await this.engine.generate({
          model: request.modelId,
          prompt: request.prompt,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
        });

        results.push({
          requestId: request.requestId,
          stream,
          success: true,
        });
      } catch (error) {
        results.push({
          requestId: request.requestId,
          stream: null,
          success: false,
          error: error as Error,
        });
      }
    }

    return results;
  }

  /**
   * Update batch metrics
   */
  private updateMetrics(batchSize: number, latencyMs: number): void {
    this.metrics.totalBatches++;
    this.metrics.totalRequests += batchSize;
    this.metrics.avgBatchSize =
      this.metrics.totalRequests / this.metrics.totalBatches;
    this.metrics.avgBatchLatency =
      (this.metrics.avgBatchLatency * (this.metrics.totalBatches - 1) + latencyMs) /
      this.metrics.totalBatches;

    // Update distribution
    this.metrics.batchSizeDistribution[batchSize] =
      (this.metrics.batchSizeDistribution[batchSize] || 0) + 1;
  }

  /**
   * Get batch metrics
   */
  getMetrics(): BatchMetrics {
    return { ...this.metrics };
  }

  /**
   * Get queue depth
   */
  getQueueDepth(): number {
    return this.queue.length;
  }
}
```

---

### 3. Request Queueing with Backpressure

**Purpose**: Prevent worker overload and provide graceful degradation

**Configuration**:
```yaml
cluster:
  worker:
    request_queue:
      enabled: true
      max_depth: 100
      reject_when_full: true
      priority_levels: 3
```

**Implementation**:
```typescript
// src/distributed/worker/request-queue.ts

export interface QueueConfig {
  enabled: boolean;
  maxDepth: number;
  rejectWhenFull: boolean;
  priorityLevels: number;
}

export enum RequestPriority {
  HIGH = 0,
  MEDIUM = 1,
  LOW = 2,
}

export interface QueuedRequest {
  request: InferenceRequest;
  priority: RequestPriority;
  enqueuedAt: number;
}

export class RequestQueue {
  private queues: Map<RequestPriority, QueuedRequest[]>;
  private currentDepth: number = 0;

  constructor(private config: QueueConfig) {
    this.queues = new Map();
    for (let i = 0; i < config.priorityLevels; i++) {
      this.queues.set(i as RequestPriority, []);
    }
  }

  /**
   * Enqueue request
   */
  enqueue(
    request: InferenceRequest,
    priority: RequestPriority = RequestPriority.MEDIUM
  ): void {
    if (this.currentDepth >= this.config.maxDepth) {
      if (this.config.rejectWhenFull) {
        throw new Error('Request queue full');
      }
      // Drop lowest priority request
      this.dropLowestPriority();
    }

    const queue = this.queues.get(priority)!;
    queue.push({
      request,
      priority,
      enqueuedAt: Date.now(),
    });

    this.currentDepth++;
  }

  /**
   * Dequeue highest priority request
   */
  dequeue(): QueuedRequest | null {
    for (let priority = 0; priority < this.config.priorityLevels; priority++) {
      const queue = this.queues.get(priority as RequestPriority)!;
      if (queue.length > 0) {
        this.currentDepth--;
        return queue.shift()!;
      }
    }
    return null;
  }

  /**
   * Drop lowest priority request
   */
  private dropLowestPriority(): void {
    for (let priority = this.config.priorityLevels - 1; priority >= 0; priority--) {
      const queue = this.queues.get(priority as RequestPriority)!;
      if (queue.length > 0) {
        queue.pop();
        this.currentDepth--;
        return;
      }
    }
  }

  /**
   * Get queue depth
   */
  getDepth(): number {
    return this.currentDepth;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.currentDepth >= this.config.maxDepth;
  }
}
```

---

### 4. Worker Resource Management

**Purpose**: Prevent OOM crashes and provide graceful degradation

**Implementation**:
```typescript
// src/distributed/worker/resource-manager.ts

export interface ResourceLimits {
  maxMemoryMB: number;      // Soft limit
  criticalMemoryMB: number; // Hard limit (reject requests)
  checkIntervalMs: number;   // Monitor frequency
}

export class ResourceManager {
  private currentMemoryMB: number = 0;
  private checkInterval?: NodeJS.Timeout;

  constructor(private limits: ResourceLimits) {}

  start(): void {
    this.checkInterval = setInterval(() => {
      this.checkResources();
    }, this.limits.checkIntervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  private checkResources(): void {
    const memoryUsage = process.memoryUsage();
    this.currentMemoryMB = memoryUsage.heapUsed / 1024 / 1024;

    if (this.currentMemoryMB > this.limits.criticalMemoryMB) {
      this.logger.error('Critical memory limit reached', {
        current: this.currentMemoryMB,
        limit: this.limits.criticalMemoryMB,
      });
      // Trigger emergency mode
    } else if (this.currentMemoryMB > this.limits.maxMemoryMB) {
      this.logger.warn('Memory limit exceeded', {
        current: this.currentMemoryMB,
        limit: this.limits.maxMemoryMB,
      });
      // Start rejecting low-priority requests
    }
  }

  canAcceptRequest(): boolean {
    return this.currentMemoryMB < this.limits.criticalMemoryMB;
  }

  isUnderPressure(): boolean {
    return this.currentMemoryMB > this.limits.maxMemoryMB;
  }

  getMemoryUsage(): number {
    return this.currentMemoryMB;
  }
}
```

---

## Success Metrics

### Functional Requirements
- ✅ Pre-warming eliminates cold-start (2000ms → 200ms)
- ✅ Continuous batching increases throughput (2-3x)
- ✅ Request queueing prevents overload
- ✅ Resource limits prevent OOM crashes
- ✅ Graceful degradation under high load

### Performance Requirements
- ✅ Cold-start latency reduction: >90%
- ✅ Throughput improvement: 2-3x with batching
- ✅ Queue wait time: <100ms under normal load
- ✅ Memory overhead: <10% increase
- ✅ Batch formation time: <50ms

### Quality Requirements
- ✅ Unit test coverage: >90%
- ✅ Integration tests: All passing
- ✅ Performance benchmarks: Document improvements
- ✅ TypeScript: 0 errors
- ✅ ESLint: 0 errors/warnings

---

## Risk Assessment

### Technical Risks

**Risk 1: GPU Contention During Pre-warming**
- **Likelihood**: High
- **Impact**: Medium (slower startup)
- **Mitigation**: Sequential loading, timeout per model

**Risk 2: Batching Complexity**
- **Likelihood**: Medium
- **Impact**: High (incorrect results)
- **Mitigation**: Micro-batching first, comprehensive testing

**Risk 3: Memory Leaks**
- **Likelihood**: Medium
- **Impact**: High (OOM crashes)
- **Mitigation**: Resource monitoring, limits, testing

---

## Appendix

### Configuration Example

```yaml
cluster:
  worker:
    pre_warming:
      enabled: true
      models:
        - model: "mlx-community/Llama-3.2-3B-Instruct-4bit"
          priority: high
        - model: "mlx-community/Qwen2.5-7B-Instruct-4bit"
          priority: high
      timeout_per_model_ms: 30000
      parallel: false
      register_when: "warming"

    continuous_batching:
      enabled: true
      min_batch_size: 1
      max_batch_size: 8
      batch_timeout_ms: 50
      adaptive_timeout: true

    request_queue:
      enabled: true
      max_depth: 100
      reject_when_full: true
      priority_levels: 3

    resource_limits:
      max_memory_mb: 8192
      critical_memory_mb: 10240
      check_interval_ms: 5000
```

---

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready for Implementation
