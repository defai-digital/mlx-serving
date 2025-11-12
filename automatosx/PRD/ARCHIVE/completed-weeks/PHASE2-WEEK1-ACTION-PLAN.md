# Phase 2 Week 1: Day-by-Day Action Plan - Integration Testing & Advanced Routing

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 1 of 13 (Week 4 overall)
**Duration**: 5 working days (Monday-Friday)
**Status**: Ready to Execute
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Overview

This document provides a **detailed, hour-by-hour breakdown** of Phase 2 Week 1 implementation tasks. Each day includes specific goals, tasks, complete code implementations, validation steps, and success criteria.

**Week Goal**: Validate distributed system through integration testing and add advanced routing features

**Estimated Hours**: 40 hours (8 hours/day × 5 days)

**Prerequisites**:
- ✅ Phase 1 Week 1 complete (NATS foundation)
- ✅ Phase 1 Week 2 complete (Worker Node)
- ✅ Phase 1 Week 3 complete (Controller Node)

---

## Table of Contents

- [Day 1 (Monday): Integration Test Infrastructure](#day-1-monday)
- [Day 2 (Tuesday): Sticky Sessions & Session Registry](#day-2-tuesday)
- [Day 3 (Wednesday): Retry Logic & Circuit Breaker](#day-3-wednesday)
- [Day 4 (Thursday): Connection Pooling & Timeout Handling](#day-4-thursday)
- [Day 5 (Friday): Performance Benchmarks & Documentation](#day-5-friday)

---

# Day 1 (Monday)

## Goal

Build integration test infrastructure and implement first set of controller-worker integration tests.

## Time Allocation

- **Morning (4h)**: Test infrastructure + test helpers (8:00 AM - 12:00 PM)
- **Afternoon (4h)**: Controller-Worker integration tests (1:00 PM - 5:00 PM)

---

## Task 1.1: Integration Test Infrastructure (2 hours)

**Objective**: Create test utilities for integration testing

**Priority**: P0 (Must Have)

**File**: `tests/integration/helpers/test-cluster.ts`

### Implementation

```typescript
/**
 * Test Cluster Helper
 * Utilities for integration testing with real controller and workers
 */

import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { loadClusterConfig } from '@/distributed/config/loader.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import { createLogger } from '@/distributed/utils/logger.js';

const logger = createLogger('TestCluster');

export interface TestClusterOptions {
  workerCount: number;
  natsPort?: number;
  controllerPort?: number;
  enableNats?: boolean;
}

export class TestCluster {
  private natsServer?: EmbeddedNatsServer;
  private controller?: ControllerNode;
  private workers: WorkerNode[] = [];
  private config?: ClusterConfig;

  constructor(private options: TestClusterOptions) {}

  /**
   * Start the test cluster
   */
  async start(): Promise<void> {
    logger.info('Starting test cluster', {
      workerCount: this.options.workerCount,
      natsPort: this.options.natsPort,
    });

    // 1. Load config
    this.config = await loadClusterConfig('config/cluster.yaml');

    // Override ports if provided
    if (this.options.natsPort) {
      this.config.cluster.nats.embedded_server_port = this.options.natsPort;
    }
    if (this.options.controllerPort) {
      this.config.cluster.controller.port = this.options.controllerPort;
    }

    // 2. Start NATS server
    if (this.options.enableNats !== false) {
      this.natsServer = new EmbeddedNatsServer();
      await this.natsServer.start({
        port: this.options.natsPort || 4222,
        logFile: undefined,
      });
      logger.info('NATS server started', { port: this.natsServer.getPort() });

      // Wait for NATS to be ready
      await this.delay(1000);
    }

    // 3. Start controller
    this.controller = new ControllerNode({ config: this.config });
    await this.controller.start();
    logger.info('Controller started');

    // Wait for controller to be ready
    await this.delay(1000);

    // 4. Start workers
    for (let i = 0; i < this.options.workerCount; i++) {
      const worker = new WorkerNode({ config: this.config });
      await worker.start();
      this.workers.push(worker);
      logger.info(`Worker ${i + 1} started`, { workerId: worker.getWorkerId() });

      // Small delay between workers
      await this.delay(500);
    }

    // 5. Wait for all workers to register
    await this.delay(2000);

    logger.info('Test cluster started successfully', {
      controller: this.controller.getState(),
      workers: this.workers.length,
    });
  }

  /**
   * Stop the test cluster
   */
  async stop(): Promise<void> {
    logger.info('Stopping test cluster');

    // 1. Stop workers
    for (const worker of this.workers) {
      try {
        await worker.stop();
      } catch (error) {
        logger.error('Error stopping worker', error as Error);
      }
    }

    // 2. Stop controller
    if (this.controller) {
      try {
        await this.controller.stop();
      } catch (error) {
        logger.error('Error stopping controller', error as Error);
      }
    }

    // 3. Stop NATS
    if (this.natsServer) {
      try {
        await this.natsServer.stop();
      } catch (error) {
        logger.error('Error stopping NATS', error as Error);
      }
    }

    logger.info('Test cluster stopped');
  }

  /**
   * Get controller instance
   */
  getController(): ControllerNode {
    if (!this.controller) {
      throw new Error('Controller not started');
    }
    return this.controller;
  }

  /**
   * Get worker instances
   */
  getWorkers(): WorkerNode[] {
    return this.workers;
  }

  /**
   * Get worker by index
   */
  getWorker(index: number): WorkerNode {
    if (index < 0 || index >= this.workers.length) {
      throw new Error(`Worker index ${index} out of range`);
    }
    return this.workers[index];
  }

  /**
   * Wait for condition
   */
  async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number = 10000,
    checkIntervalMs: number = 100
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await Promise.resolve(condition());
      if (result) return;

      await this.delay(checkIntervalMs);
    }

    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get cluster config
   */
  getConfig(): ClusterConfig {
    if (!this.config) {
      throw new Error('Config not loaded');
    }
    return this.config;
  }

  /**
   * Get controller API URL
   */
  getApiUrl(): string {
    const port = this.options.controllerPort || 8080;
    return `http://localhost:${port}`;
  }
}
```

**File**: `tests/integration/helpers/http-client.ts`

```typescript
/**
 * HTTP Client Helper
 * Utilities for making HTTP requests to controller API
 */

import fetch from 'node-fetch';

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  session_id?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: string;
      content: string;
    };
    delta?: {
      content: string;
    };
    finish_reason: string | null;
  }>;
}

export class HttpClient {
  constructor(private baseUrl: string) {}

  /**
   * POST /v1/chat/completions (buffered)
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  /**
   * POST /v1/chat/completions (streaming)
   */
  async *chatCompletionStream(
    request: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            yield JSON.parse(data) as ChatCompletionResponse;
          } catch (error) {
            // Skip invalid JSON
          }
        }
      }
    }
  }

  /**
   * GET /api/cluster/status
   */
  async getClusterStatus(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/cluster/status`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * GET /api/cluster/workers
   */
  async getWorkers(): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/api/cluster/workers`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * GET /api/cluster/workers/:id
   */
  async getWorker(workerId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/cluster/workers/${workerId}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * GET /health
   */
  async healthCheck(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/health`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }
}
```

**Validation**:
```bash
# These utilities will be used by integration tests
# No direct testing needed, but verify compilation
npx tsc --noEmit tests/integration/helpers/test-cluster.ts
npx tsc --noEmit tests/integration/helpers/http-client.ts
```

---

## Task 1.2: Controller-Worker Integration Tests (6 hours)

**Objective**: Test controller and worker interaction

**Priority**: P0 (Must Have)

**File**: `tests/integration/distributed/controller/controller-worker.test.ts`

### Implementation

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TestCluster } from '../../helpers/test-cluster.js';

describe('Controller-Worker Integration', () => {
  let cluster: TestCluster;

  beforeAll(async () => {
    // Start cluster with 1 worker
    cluster = new TestCluster({
      workerCount: 1,
      natsPort: 4333, // Use different port to avoid conflicts
      controllerPort: 8181,
    });

    await cluster.start();
  }, 30000); // 30s timeout for startup

  afterAll(async () => {
    await cluster.stop();
  }, 10000); // 10s timeout for shutdown

  it('should register worker on startup', async () => {
    const controller = cluster.getController();
    const workers = controller.getAllWorkers();

    expect(workers.length).toBe(1);
    expect(workers[0].status).toBe('online');
    expect(workers[0].skills.availableModels.length).toBeGreaterThan(0);
  });

  it('should receive worker heartbeats', async () => {
    const controller = cluster.getController();
    const worker = controller.getAllWorkers()[0];
    const initialHeartbeat = worker.lastHeartbeat;

    // Wait for next heartbeat (5s interval)
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(worker.workerId);
        return updated ? updated.lastHeartbeat > initialHeartbeat : false;
      },
      10000
    );

    const updated = controller.getWorker(worker.workerId);
    expect(updated?.lastHeartbeat).toBeGreaterThan(initialHeartbeat);
  });

  it('should update worker metrics from heartbeat', async () => {
    const controller = cluster.getController();
    const worker = controller.getAllWorkers()[0];

    // Wait for heartbeat with metrics
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(worker.workerId);
        return updated?.metrics !== undefined;
      },
      10000
    );

    const updated = controller.getWorker(worker.workerId);
    expect(updated?.metrics).toBeDefined();
    expect(updated?.metrics?.requests).toBeDefined();
  });

  it('should detect offline workers after timeout', async () => {
    const controller = cluster.getController();
    const worker = cluster.getWorker(0);

    // Stop worker
    await worker.stop();

    // Wait for offline detection (15s timeout)
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(worker.getWorkerId());
        return updated?.status === 'offline';
      },
      20000
    );

    const updated = controller.getWorker(worker.getWorkerId());
    expect(updated?.status).toBe('offline');
  }, 30000);

  // More tests...
});
```

**Success Criteria**:
- ✅ All 8 tests passing
- ✅ Workers register successfully
- ✅ Heartbeats received
- ✅ Offline detection works

---

# Days 2-5 Summary

Due to length, here's a summary of remaining days:

## Day 2 (Tuesday): Sticky Sessions

**Morning**: SessionRegistry implementation
**Afternoon**: SmartLoadBalancer integration, API changes

**Deliverables**:
- `src/distributed/controller/session-registry.ts` (200+ lines)
- Updated SmartLoadBalancer with session affinity
- Tests for session routing

## Day 3 (Wednesday): Retry Logic & Circuit Breaker

**Morning**: RetryHandler implementation
**Afternoon**: CircuitBreaker implementation

**Deliverables**:
- `src/distributed/controller/retry-handler.ts` (150+ lines)
- `src/distributed/controller/circuit-breaker.ts` (200+ lines)
- Integration with ControllerNode
- Tests for retry and circuit breaker

## Day 4 (Thursday): Connection Pooling & Timeout

**Morning**: NATS connection pool
**Afternoon**: Timeout handling, request routing tests

**Deliverables**:
- `src/distributed/nats/connection-pool.ts` (250+ lines)
- `src/distributed/controller/timeout-handler.ts` (100+ lines)
- Request routing integration tests (10+ tests)

## Day 5 (Friday): Performance Benchmarks & Documentation

**Morning**: Performance benchmark tests
**Afternoon**: End-to-end cluster tests, documentation

**Deliverables**:
- `tests/integration/distributed/performance/benchmark.test.ts` (400+ lines)
- `tests/integration/distributed/controller/cluster-e2e.test.ts` (500+ lines)
- Performance report (markdown)
- Week summary document

---

## Week Deliverables Checklist

### Code Deliverables
- [ ] SessionRegistry (200+ lines)
- [ ] RetryHandler (150+ lines)
- [ ] CircuitBreaker (200+ lines)
- [ ] ConnectionPool (250+ lines)
- [ ] TimeoutHandler (100+ lines)
- [ ] Test helpers (300+ lines)

### Test Deliverables
- [ ] Controller-Worker integration tests (8+ tests)
- [ ] Request routing tests (10+ tests)
- [ ] Cluster E2E tests (10+ tests)
- [ ] Performance benchmarks (6+ tests)
- [ ] Total: 34+ integration tests

### Documentation Deliverables
- [ ] Integration test guide
- [ ] Performance benchmark report
- [ ] Sticky session usage guide
- [ ] Circuit breaker tuning guide

### Validation
- [ ] All integration tests passing (>95% success rate)
- [ ] Sticky sessions working (40-60% latency reduction)
- [ ] Retry logic working (auto-failover)
- [ ] Circuit breaker working (excludes unhealthy workers)
- [ ] TypeScript: 0 errors
- [ ] ESLint: 0 errors/warnings

---

## Success Metrics

### Functional
- ✅ Integration tests pass (>95% success)
- ✅ Sticky sessions work
- ✅ Retry logic works
- ✅ Circuit breaker works
- ✅ Connection pooling works

### Performance
- ✅ Sticky sessions: 40-60% latency reduction
- ✅ Retry overhead: <100ms
- ✅ End-to-end latency: Within 10% of standalone

### Quality
- ✅ Test coverage: >95% success rate
- ✅ TypeScript: 0 errors
- ✅ ESLint: 0 errors/warnings
- ✅ Documentation complete

---

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready to Execute
