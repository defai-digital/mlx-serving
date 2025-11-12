# Phase 2 Week 2: Day-by-Day Action Plan - Model Pre-warming & Advanced Batching

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 2 of 13 (Week 5 overall)
**Duration**: 5 working days (Monday-Friday)
**Status**: Ready to Execute
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Overview

This document provides a **detailed, hour-by-hour breakdown** of Phase 2 Week 2 implementation tasks. Each day includes specific goals, tasks, complete code implementations, validation steps, and success criteria.

**Week Goal**: Maximize inference performance through model pre-warming and continuous batching

**Estimated Hours**: 40 hours (8 hours/day × 5 days)

**Prerequisites**:
- ✅ Phase 1 complete (distributed infrastructure)
- ✅ Phase 2 Week 1 complete (integration tests, sticky sessions, retry logic)

---

## Table of Contents

- [Day 1 (Monday): Model Pre-warming System](#day-1-monday)
- [Day 2 (Tuesday): Continuous Batching Infrastructure](#day-2-tuesday)
- [Day 3 (Wednesday): Request Queueing & Priority](#day-3-wednesday)
- [Day 4 (Thursday): Resource Management & Limits](#day-4-thursday)
- [Day 5 (Friday): Performance Benchmarks & Optimization](#day-5-friday)

---

# Day 1 (Monday)

## Goal

Implement model pre-warming system to eliminate cold-start latency.

## Time Allocation

- **Morning (4h)**: ModelPreWarmer implementation (8:00 AM - 12:00 PM)
- **Afternoon (4h)**: Worker integration + testing (1:00 PM - 5:00 PM)

---

## Task 1.1: ModelPreWarmer Implementation (4 hours)

**Objective**: Create system to pre-load models on worker startup

**Priority**: P0 (Must Have)

**File**: `src/distributed/worker/model-prewarmer.ts`

### Implementation

```typescript
/**
 * Model Pre-Warmer
 * Pre-loads models on worker startup to eliminate cold-start latency
 */

import { Engine } from '@/api/engine.js';
import { createLogger, Logger } from '../utils/logger.js';

export type PreWarmPriority = 'high' | 'medium' | 'low';

export interface PreWarmModelConfig {
  model: string;
  priority: PreWarmPriority;
}

export interface PreWarmConfig {
  enabled: boolean;
  models: PreWarmModelConfig[];
  timeoutPerModelMs: number;
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
  errors: Array<{ model: string; error: string }>;
}

export class ModelPreWarmer {
  private status: PreWarmStatus;
  private logger: Logger;
  private aborted: boolean = false;

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
      errors: [],
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

    if (this.config.models.length === 0) {
      this.logger.info('No models to pre-warm');
      return;
    }

    this.status.startedAt = Date.now();
    this.status.total = this.config.models.length;

    // Sort by priority (high → medium → low)
    const sorted = this.sortByPriority(this.config.models);

    this.logger.info('Starting model pre-warming', {
      models: sorted.length,
      parallel: this.config.parallel,
      mode: this.config.parallel ? 'parallel' : 'sequential',
    });

    try {
      if (this.config.parallel) {
        await this.warmParallel(sorted);
      } else {
        await this.warmSequential(sorted);
      }
    } catch (error) {
      this.logger.error('Pre-warming interrupted', {
        error: (error as Error).message,
      });
    }

    this.status.completedAt = Date.now();
    const duration = this.status.completedAt - this.status.startedAt;

    this.logger.info('Pre-warming complete', {
      total: this.status.total,
      completed: this.status.completed,
      failed: this.status.failed,
      durationMs: duration,
      successRate: ((this.status.completed / this.status.total) * 100).toFixed(1) + '%',
    });
  }

  /**
   * Warm models sequentially (recommended for GPU stability)
   */
  private async warmSequential(models: PreWarmModelConfig[]): Promise<void> {
    for (const { model, priority } of models) {
      if (this.aborted) {
        this.logger.info('Pre-warming aborted');
        break;
      }

      await this.warmModel(model, priority);
    }
  }

  /**
   * Warm models in parallel (faster but may cause GPU issues)
   */
  private async warmParallel(models: PreWarmModelConfig[]): Promise<void> {
    const promises = models.map(({ model, priority }) =>
      this.warmModel(model, priority)
    );
    await Promise.allSettled(promises);
  }

  /**
   * Warm single model
   */
  private async warmModel(modelId: string, priority: PreWarmPriority): Promise<void> {
    this.status.inProgress = modelId;
    const startTime = Date.now();

    this.logger.info('Warming model', { modelId, priority });

    try {
      // Step 1: Load model with timeout
      await this.withTimeout(
        this.engine.loadModel({ model: modelId }),
        this.config.timeoutPerModelMs,
        `Loading ${modelId} timeout`
      );

      // Step 2: Generate short warmup sequence (warms Metal GPU)
      await this.withTimeout(
        this.generateWarmup(modelId),
        5000,
        `Warmup generation timeout`
      );

      const duration = Date.now() - startTime;
      this.status.completed++;

      this.logger.info('Model warmed successfully', {
        modelId,
        priority,
        durationMs: duration,
      });
    } catch (error) {
      this.status.failed++;
      const errorMessage = (error as Error).message;

      this.logger.error('Model warming failed', {
        modelId,
        priority,
        error: errorMessage,
      });

      this.status.errors.push({
        model: modelId,
        error: errorMessage,
      });
    } finally {
      this.status.inProgress = null;
    }
  }

  /**
   * Generate short warmup sequence to warm up Metal GPU
   */
  private async generateWarmup(modelId: string): Promise<void> {
    try {
      const stream = await this.engine.generate({
        model: modelId,
        prompt: 'Hello',  // Simple prompt
        maxTokens: 1,     // Just 1 token to warm up
        temperature: 0.7,
      });

      // Consume the stream
      const reader = stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // Warmup generation failed, but model is loaded
      this.logger.warn('Warmup generation failed', {
        modelId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Execute promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string = 'Operation timeout'
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      ),
    ]);
  }

  /**
   * Sort models by priority
   */
  private sortByPriority(models: PreWarmModelConfig[]): PreWarmModelConfig[] {
    const priorityOrder: Record<PreWarmPriority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    return [...models].sort((a, b) => {
      const aPriority = priorityOrder[a.priority];
      const bPriority = priorityOrder[b.priority];
      return aPriority - bPriority;
    });
  }

  /**
   * Get pre-warming status
   */
  getStatus(): PreWarmStatus {
    return {
      ...this.status,
      errors: [...this.status.errors],
    };
  }

  /**
   * Check if pre-warming is complete
   */
  isComplete(): boolean {
    return this.status.completedAt !== null;
  }

  /**
   * Get completion percentage (0-100)
   */
  getProgress(): number {
    if (this.status.total === 0) return 100;

    const processed = this.status.completed + this.status.failed;
    return Math.round((processed / this.status.total) * 100);
  }

  /**
   * Check if any models were successfully warmed
   */
  hasWarmModels(): boolean {
    return this.status.completed > 0;
  }

  /**
   * Get list of successfully warmed models
   */
  getWarmedModels(): string[] {
    // This requires tracking which models succeeded
    // For now, return empty array (could be enhanced)
    return [];
  }

  /**
   * Abort pre-warming (for graceful shutdown)
   */
  abort(): void {
    this.aborted = true;
    this.logger.info('Pre-warming abort requested');
  }
}
```

**Unit Test**: `tests/unit/distributed/worker/model-prewarmer.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelPreWarmer } from '@/distributed/worker/model-prewarmer.js';
import type { Engine } from '@/api/engine.js';

describe('ModelPreWarmer', () => {
  let mockEngine: Engine;
  let prewarmer: ModelPreWarmer;

  beforeEach(() => {
    mockEngine = {
      loadModel: vi.fn().mockResolvedValue(undefined),
      generate: vi.fn().mockResolvedValue({
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
          releaseLock: vi.fn(),
        }),
      }),
    } as any;
  });

  it('should skip pre-warming when disabled', async () => {
    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: false,
      models: [{ model: 'test-model', priority: 'high' }],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    expect(mockEngine.loadModel).not.toHaveBeenCalled();
  });

  it('should warm models sequentially', async () => {
    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: true,
      models: [
        { model: 'model-1', priority: 'high' },
        { model: 'model-2', priority: 'medium' },
      ],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    expect(mockEngine.loadModel).toHaveBeenCalledTimes(2);
    expect(prewarmer.isComplete()).toBe(true);
    expect(prewarmer.getProgress()).toBe(100);
  });

  it('should sort models by priority', async () => {
    const loadOrder: string[] = [];

    mockEngine.loadModel = vi.fn().mockImplementation(async (options: any) => {
      loadOrder.push(options.model);
    });

    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: true,
      models: [
        { model: 'low-priority', priority: 'low' },
        { model: 'high-priority', priority: 'high' },
        { model: 'medium-priority', priority: 'medium' },
      ],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    expect(loadOrder).toEqual(['high-priority', 'medium-priority', 'low-priority']);
  });

  it('should handle model loading failure', async () => {
    mockEngine.loadModel = vi.fn().mockRejectedValue(new Error('Model not found'));

    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: true,
      models: [{ model: 'invalid-model', priority: 'high' }],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    const status = prewarmer.getStatus();
    expect(status.failed).toBe(1);
    expect(status.completed).toBe(0);
    expect(status.errors.length).toBe(1);
  });

  it('should handle timeout', async () => {
    mockEngine.loadModel = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10000))
    );

    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: true,
      models: [{ model: 'slow-model', priority: 'high' }],
      timeoutPerModelMs: 100, // Very short timeout
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    const status = prewarmer.getStatus();
    expect(status.failed).toBe(1);
    expect(status.errors[0].error).toContain('timeout');
  });

  it('should calculate progress correctly', async () => {
    prewarmer = new ModelPreWarmer(mockEngine, {
      enabled: true,
      models: [
        { model: 'model-1', priority: 'high' },
        { model: 'model-2', priority: 'high' },
        { model: 'model-3', priority: 'high' },
        { model: 'model-4', priority: 'high' },
      ],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    });

    await prewarmer.warmModels();

    expect(prewarmer.getProgress()).toBe(100);
    expect(prewarmer.isComplete()).toBe(true);
  });
});
```

**Success Criteria**:
- ✅ ModelPreWarmer implemented
- ✅ Sequential and parallel loading supported
- ✅ Priority ordering works
- ✅ Timeout handling works
- ✅ Unit tests passing (7+ tests)

---

## Task 1.2: Worker Integration (4 hours)

**Objective**: Integrate pre-warmer into WorkerNode

**File**: `src/distributed/worker/worker-node.ts` (update)

### Implementation Changes

```typescript
export class WorkerNode {
  private preWarmer?: ModelPreWarmer;

  async start(): Promise<void> {
    this.logger.info('Starting worker node');
    this.state = WorkerState.CONNECTING;

    // 1. Connect to NATS
    await this.nats.connect(this.natsConfig);
    this.logger.info('Connected to NATS');

    // 2. Initialize pre-warmer
    if (this.config.cluster.worker.pre_warming?.enabled) {
      this.preWarmer = new ModelPreWarmer(
        this.engine,
        this.config.cluster.worker.pre_warming
      );

      this.logger.info('Pre-warmer initialized', {
        models: this.config.cluster.worker.pre_warming.models.length,
      });
    }

    // 3. Determine when to register
    const registerWhen =
      this.config.cluster.worker.pre_warming?.register_when || 'warming';
    const shouldRegisterBeforeWarm = registerWhen === 'warming';

    // 4. Register early if configured
    if (shouldRegisterBeforeWarm) {
      this.state = WorkerState.REGISTERING;
      await this.register();
      this.logger.info('Registered with controller (pre-warming in background)');
    }

    // 5. Start pre-warming
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
        await this.register();
        this.logger.info('Registered with controller (pre-warming complete)');
      }
    } else {
      // No pre-warming, register immediately
      this.state = WorkerState.REGISTERING;
      await this.register();
    }

    // 6. Continue normal startup
    this.startHeartbeat();
    await this.subscribeToInferenceRequests();

    this.state = WorkerState.READY;
    this.logger.info('Worker node ready', {
      workerId: this.workerId,
      preWarmStatus: this.preWarmer?.getStatus(),
    });
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

  async stop(): Promise<void> {
    this.logger.info('Stopping worker node');

    // Abort pre-warming if in progress
    if (this.preWarmer && !this.preWarmer.isComplete()) {
      this.preWarmer.abort();
    }

    // Continue with normal shutdown
    // ... existing shutdown code ...
  }
}
```

**Integration Test**: `tests/integration/distributed/worker/prewarming.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { loadClusterConfig } from '@/distributed/config/loader.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

describe('Worker Pre-warming Integration', () => {
  let worker: WorkerNode;
  let config: ClusterConfig;

  beforeAll(async () => {
    config = await loadClusterConfig('config/cluster.yaml');

    // Enable pre-warming for test
    config.cluster.worker.pre_warming = {
      enabled: true,
      models: [
        { model: 'mlx-community/Llama-3.2-3B-Instruct-4bit', priority: 'high' },
      ],
      timeoutPerModelMs: 30000,
      parallel: false,
      registerWhen: 'warming',
    };
  });

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  it('should start worker with pre-warming', async () => {
    worker = new WorkerNode({ config });

    await worker.start();

    expect(worker.getState()).toBe('ready');

    const preWarmStatus = worker.getPreWarmStatus();
    expect(preWarmStatus).toBeDefined();
    expect(preWarmStatus.enabled).toBe(true);
  }, 60000); // 60s timeout for pre-warming

  it('should complete pre-warming', async () => {
    // Wait for pre-warming to complete
    await new Promise((resolve) => setTimeout(resolve, 35000)); // 35s

    const preWarmStatus = worker.getPreWarmStatus();
    expect(preWarmStatus.complete).toBe(true);
    expect(preWarmStatus.progress).toBe(100);
    expect(preWarmStatus.completed).toBeGreaterThan(0);
  }, 40000);
});
```

**Success Criteria**:
- ✅ Worker integrates pre-warmer
- ✅ Two registration modes work (warming/complete)
- ✅ Background pre-warming works
- ✅ Integration test passing

---

# Days 2-5 Summary

## Day 2 (Tuesday): Continuous Batching

**Morning**: ContinuousBatcher implementation
**Afternoon**: Worker integration + batching tests

**Deliverables**:
- `src/distributed/worker/continuous-batcher.ts` (400+ lines)
- Batch metrics and monitoring
- Tests for batching logic

## Day 3 (Wednesday): Request Queueing

**Morning**: RequestQueue implementation
**Afternoon**: Priority queueing + integration

**Deliverables**:
- `src/distributed/worker/request-queue.ts` (250+ lines)
- Priority support (high/medium/low)
- Queue depth monitoring

## Day 4 (Thursday): Resource Management

**Morning**: ResourceManager implementation
**Afternoon**: Memory limits + graceful degradation

**Deliverables**:
- `src/distributed/worker/resource-manager.ts` (200+ lines)
- Memory monitoring
- Request rejection under pressure

## Day 5 (Friday): Performance Benchmarks

**Morning**: Benchmark tests
**Afternoon**: Optimization + documentation

**Deliverables**:
- `tests/integration/distributed/performance/prewarming-benchmark.test.ts`
- `tests/integration/distributed/performance/batching-benchmark.test.ts`
- Performance report
- Week summary

---

## Week Deliverables Checklist

### Code Deliverables
- [ ] ModelPreWarmer (300+ lines)
- [ ] ContinuousBatcher (400+ lines)
- [ ] RequestQueue (250+ lines)
- [ ] ResourceManager (200+ lines)
- [ ] Worker integration updates (200+ lines)

### Test Deliverables
- [ ] Unit tests (20+ tests)
- [ ] Integration tests (10+ tests)
- [ ] Performance benchmarks (5+ tests)

### Documentation Deliverables
- [ ] Pre-warming configuration guide
- [ ] Batching optimization guide
- [ ] Resource management guide
- [ ] Performance benchmark report

### Validation
- [ ] Cold-start latency reduced 90%
- [ ] Throughput improved 2-3x
- [ ] All tests passing
- [ ] TypeScript: 0 errors
- [ ] ESLint: 0 errors/warnings

---

## Success Metrics

### Functional
- ✅ Pre-warming eliminates cold-start
- ✅ Batching improves throughput
- ✅ Queueing prevents overload
- ✅ Resource limits prevent OOM

### Performance
- ✅ Cold-start: 2000ms → 200ms (90% reduction)
- ✅ Throughput: 2-3x improvement
- ✅ Memory overhead: <10%

### Quality
- ✅ Unit tests: >90% coverage
- ✅ Integration tests: All passing
- ✅ TypeScript: 0 errors
- ✅ Documentation: Complete

---

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready to Execute
