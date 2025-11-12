# Phase 2 Week 3: Controller Integration - PRD

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 3 of 13 (Week 6 overall)
**Status**: Ready for Implementation
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Executive Summary

**Goal**: Integrate Phase 2 Week 1 components (RetryHandler, CircuitBreaker, TimeoutHandler) into the ControllerNode request flow to enable production-grade reliability and automatic failover.

**Impact**:
- 95% → 99%+ success rate through automatic retry
- Eliminate wasted requests on unhealthy workers via circuit breakers
- Prevent hanging requests with configurable timeouts
- Complete request routing with comprehensive error handling

**Scope**:
- Integrate RetryHandler into request routing pipeline
- Integrate CircuitBreaker for worker health tracking
- Integrate TimeoutHandler for all request types
- Add comprehensive request routing tests
- Update error handling and logging

---

## Table of Contents

- [Background](#background)
- [Goals & Non-Goals](#goals--non-goals)
- [Technical Design](#technical-design)
- [Implementation Details](#implementation-details)
- [Testing Strategy](#testing-strategy)
- [Success Criteria](#success-criteria)
- [Risks & Mitigations](#risks--mitigations)

---

## Background

### Context

Phase 2 Week 1 delivered standalone reliability components:
- **RetryHandler**: Automatic retry with exponential backoff
- **CircuitBreaker**: Per-worker health state machine
- **TimeoutHandler**: Request timeout enforcement

These components are currently **not integrated** into the actual request flow. Week 3 focuses on integrating them into ControllerNode to enable production-ready reliability.

### Current State

**ControllerNode Request Flow** (src/distributed/controller/controller-node.ts):
```typescript
async handleInferenceRequest(request: InferenceRequest) {
  // 1. Load balancer selects worker
  const worker = this.loadBalancer.selectWorker(workers, request, sessionId);

  // 2. Send request to worker via NATS
  const response = await this.nats.request(subject, payload);

  // 3. Return response
  return response;
}
```

**Problems**:
- ❌ No retry on worker failure
- ❌ No circuit breaker protection
- ❌ No timeout enforcement
- ❌ No health-based worker selection
- ❌ Limited error handling

### Desired State

**Integrated Request Flow**:
```typescript
async handleInferenceRequest(request: InferenceRequest) {
  // 1. Check circuit breaker before selecting worker
  const availableWorkers = this.filterHealthyWorkers(workers);

  // 2. Select worker with session affinity (Week 1)
  const worker = this.loadBalancer.selectWorker(availableWorkers, request, sessionId);

  // 3. Execute with retry and timeout
  const response = await this.retryHandler.executeWithRetry(request, async (req) => {
    return await this.timeoutHandler.withTimeout(
      this.sendRequestToWorker(worker, req),
      this.getTimeoutMs(req)
    );
  });

  // 4. Update circuit breaker state
  this.updateWorkerHealth(worker, response);

  return response;
}
```

---

## Goals & Non-Goals

### Goals

**Primary Goals**:
1. ✅ Integrate RetryHandler into all inference request paths
2. ✅ Integrate CircuitBreaker for worker health tracking
3. ✅ Integrate TimeoutHandler for buffered and streaming requests
4. ✅ Add comprehensive request routing tests (10+ integration tests)
5. ✅ Update error handling with proper error codes and logging

**Secondary Goals**:
1. ✅ Add request routing metrics (retry count, circuit breaker trips, timeouts)
2. ✅ Implement graceful degradation under failure scenarios
3. ✅ Update API server with new error responses

### Non-Goals

1. ❌ Worker-side integration (that's Week 4)
2. ❌ Performance optimization (that's Week 5)
3. ❌ Load testing (that's Week 5)
4. ❌ New reliability features beyond Week 1 components

---

## Technical Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      API Server (HTTP/WS)                    │
│  POST /v1/chat/completions, WS /v1/stream                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      ControllerNode                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         handleInferenceRequest(request)              │    │
│  │                                                       │    │
│  │  1. Get session ID (if present)                      │    │
│  │  2. Filter workers by circuit breaker ✨ NEW         │    │
│  │  3. Select worker (SmartLoadBalancer)               │    │
│  │  4. Execute with retry + timeout ✨ NEW              │    │
│  │  5. Update circuit breaker state ✨ NEW              │    │
│  │  6. Return response                                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  Components:                                                  │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ CircuitBreaker│  │ RetryHandler │  │ TimeoutHandler  │  │
│  │   Manager     │  │              │  │                 │  │
│  └───────────────┘  └──────────────┘  └─────────────────┘  │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼ NATS
┌─────────────────────────────────────────────────────────────┐
│                       WorkerNode(s)                          │
└─────────────────────────────────────────────────────────────┘
```

### Component Integration

#### 1. CircuitBreaker Manager Integration

**Purpose**: Track per-worker health and exclude unhealthy workers from selection.

**Implementation**:
```typescript
export class ControllerNode {
  private circuitBreakerManager: CircuitBreakerManager;

  constructor(options: ControllerNodeOptions) {
    // Initialize circuit breaker manager
    if (this.config.requestRouting.circuitBreaker.enabled) {
      this.circuitBreakerManager = new CircuitBreakerManager({
        failureThreshold: this.config.requestRouting.circuitBreaker.failureThreshold,
        successThreshold: this.config.requestRouting.circuitBreaker.successThreshold,
        timeoutMs: this.config.requestRouting.circuitBreaker.timeoutMs,
      });
    }
  }

  /**
   * Filter workers by circuit breaker state
   */
  private filterHealthyWorkers(workers: WorkerInfo[]): WorkerInfo[] {
    if (!this.circuitBreakerManager) return workers;

    return workers.filter((worker) => {
      const canMakeRequest = this.circuitBreakerManager.canMakeRequest(worker.workerId);

      if (!canMakeRequest) {
        this.logger.debug('Worker excluded by circuit breaker', {
          workerId: worker.workerId,
          state: this.circuitBreakerManager.getState(worker.workerId),
        });
      }

      return canMakeRequest;
    });
  }

  /**
   * Update circuit breaker after request
   */
  private updateCircuitBreaker(workerId: string, success: boolean): void {
    if (!this.circuitBreakerManager) return;

    if (success) {
      this.circuitBreakerManager.recordSuccess(workerId);
    } else {
      this.circuitBreakerManager.recordFailure(workerId);
    }
  }
}
```

#### 2. RetryHandler Integration

**Purpose**: Automatically retry failed requests on different workers.

**Implementation**:
```typescript
export class ControllerNode {
  private retryHandler: RetryHandler;

  constructor(options: ControllerNodeOptions) {
    // Initialize retry handler
    if (this.config.requestRouting.retry.enabled) {
      this.retryHandler = new RetryHandler({
        maxRetries: this.config.requestRouting.retry.maxRetries,
        retryDelayMs: this.config.requestRouting.retry.retryDelayMs,
        exponentialBackoff: true,
        maxDelayMs: 1000,
      });
    }
  }

  /**
   * Execute request with retry
   */
  private async executeWithRetry(
    request: InferenceRequest,
    sessionId?: string
  ): Promise<any> {
    if (!this.retryHandler) {
      // No retry configured, execute directly
      return await this.executeSingleRequest(request, sessionId);
    }

    return await this.retryHandler.executeWithRetry(request, async (req, excludedWorkers) => {
      // Get workers excluding failed ones
      const allWorkers = this.workerRegistry.getOnlineWorkers();
      const healthyWorkers = this.filterHealthyWorkers(allWorkers);
      const availableWorkers = healthyWorkers.filter(
        (w) => !excludedWorkers.has(w.workerId)
      );

      if (availableWorkers.length === 0) {
        throw new Error('No available workers for retry');
      }

      // Select worker and execute
      const worker = this.loadBalancer.selectWorker(availableWorkers, req, sessionId);
      return await this.sendRequestToWorker(worker, req);
    });
  }
}
```

#### 3. TimeoutHandler Integration

**Purpose**: Enforce timeouts on all requests to prevent hanging.

**Implementation**:
```typescript
export class ControllerNode {
  private timeoutHandler: TimeoutHandler;

  constructor(options: ControllerNodeOptions) {
    // Initialize timeout handler
    this.timeoutHandler = new TimeoutHandler({
      standardTimeoutMs: this.config.requestRouting.timeoutMs,
      streamingTimeoutMs: this.config.requestRouting.streamingTimeoutMs,
    });
  }

  /**
   * Send request with timeout
   */
  private async sendRequestToWorker(
    worker: WorkerInfo,
    request: InferenceRequest
  ): Promise<any> {
    const isStreaming = request.stream === true;
    const timeoutMs = isStreaming
      ? this.config.requestRouting.streamingTimeoutMs
      : this.config.requestRouting.timeoutMs;

    try {
      const response = await this.timeoutHandler.withTimeout(
        this.nats.request(`inference.${worker.workerId}`, request),
        timeoutMs,
        `Request timeout for worker ${worker.workerId}`
      );

      // Success - update circuit breaker
      this.updateCircuitBreaker(worker.workerId, true);

      return response;
    } catch (error) {
      // Failure - update circuit breaker
      this.updateCircuitBreaker(worker.workerId, false);

      // Re-throw for retry handler
      throw error;
    }
  }
}
```

### Complete Request Flow

**Buffered Request Flow**:
```typescript
async handleBufferedRequest(request: InferenceRequest): Promise<InferenceResponse> {
  const sessionId = request.sessionId;

  // Execute with retry + timeout
  const response = await this.executeWithRetry(request, sessionId);

  return response;
}
```

**Streaming Request Flow**:
```typescript
async handleStreamingRequest(request: InferenceRequest): Promise<ReadableStream> {
  const sessionId = request.sessionId;

  // Execute with retry + timeout (returns stream)
  const stream = await this.executeWithRetry(request, sessionId);

  return stream;
}
```

---

## Implementation Details

### Phase 1: CircuitBreaker Integration (Day 1)

**Files to Modify**:
1. `src/distributed/controller/controller-node.ts`
   - Add circuitBreakerManager property
   - Add filterHealthyWorkers() method
   - Add updateCircuitBreaker() method
   - Integrate into request flow

**Code Changes** (~100 lines):
```typescript
// Add to constructor
if (this.config.cluster.requestRouting.circuitBreaker.enabled) {
  this.circuitBreakerManager = new CircuitBreakerManager({
    failureThreshold: this.config.cluster.requestRouting.circuitBreaker.failureThreshold,
    successThreshold: this.config.cluster.requestRouting.circuitBreaker.successThreshold,
    timeoutMs: this.config.cluster.requestRouting.circuitBreaker.timeoutMs,
  });

  this.logger.info('Circuit breaker enabled', {
    failureThreshold: this.config.cluster.requestRouting.circuitBreaker.failureThreshold,
  });
}

// Add filter method
private filterHealthyWorkers(workers: WorkerInfo[]): WorkerInfo[] {
  if (!this.circuitBreakerManager) return workers;

  const healthy = workers.filter((w) =>
    this.circuitBreakerManager!.canMakeRequest(w.workerId)
  );

  const filtered = workers.length - healthy.length;
  if (filtered > 0) {
    this.logger.warn('Workers filtered by circuit breaker', {
      total: workers.length,
      healthy: healthy.length,
      filtered,
    });
  }

  return healthy;
}

// Add update method
private updateCircuitBreaker(workerId: string, success: boolean): void {
  if (!this.circuitBreakerManager) return;

  if (success) {
    this.circuitBreakerManager.recordSuccess(workerId);
  } else {
    this.circuitBreakerManager.recordFailure(workerId);

    const state = this.circuitBreakerManager.getState(workerId);
    if (state === CircuitState.OPEN) {
      this.logger.warn('Circuit breaker opened for worker', { workerId });
    }
  }
}
```

### Phase 2: RetryHandler Integration (Day 2)

**Files to Modify**:
1. `src/distributed/controller/controller-node.ts`
   - Add retryHandler property
   - Add executeWithRetry() method
   - Update request handling to use retry

**Code Changes** (~150 lines):
```typescript
// Add to constructor
if (this.config.cluster.requestRouting.retry.enabled) {
  this.retryHandler = new RetryHandler({
    maxRetries: this.config.cluster.requestRouting.retry.maxRetries,
    retryDelayMs: this.config.cluster.requestRouting.retry.retryDelayMs,
    exponentialBackoff: true,
    maxDelayMs: 1000,
    retryableErrors: this.config.cluster.requestRouting.retry.retryOnErrors,
  });

  this.logger.info('Retry handler enabled', {
    maxRetries: this.config.cluster.requestRouting.retry.maxRetries,
  });
}

// Add retry execution method
private async executeWithRetry(
  request: InferenceRequest,
  sessionId?: string
): Promise<any> {
  if (!this.retryHandler) {
    return await this.executeSingleRequest(request, sessionId);
  }

  return await this.retryHandler.executeWithRetry(
    request,
    async (req, excludedWorkers) => {
      const allWorkers = this.workerRegistry.getOnlineWorkers();
      const healthyWorkers = this.filterHealthyWorkers(allWorkers);
      const availableWorkers = healthyWorkers.filter(
        (w) => !excludedWorkers.has(w.workerId)
      );

      if (availableWorkers.length === 0) {
        throw new ControllerError(
          'NO_WORKERS_AVAILABLE',
          'No workers available for request (all excluded or offline)'
        );
      }

      const worker = this.loadBalancer.selectWorker(availableWorkers, req, sessionId);
      return await this.sendRequestToWorker(worker, req);
    }
  );
}

// Helper for single request
private async executeSingleRequest(
  request: InferenceRequest,
  sessionId?: string
): Promise<any> {
  const allWorkers = this.workerRegistry.getOnlineWorkers();
  const healthyWorkers = this.filterHealthyWorkers(allWorkers);

  if (healthyWorkers.length === 0) {
    throw new ControllerError('NO_WORKERS_AVAILABLE', 'No healthy workers available');
  }

  const worker = this.loadBalancer.selectWorker(healthyWorkers, request, sessionId);
  return await this.sendRequestToWorker(worker, request);
}
```

### Phase 3: TimeoutHandler Integration (Day 3)

**Files to Modify**:
1. `src/distributed/controller/controller-node.ts`
   - Add timeoutHandler property
   - Update sendRequestToWorker() with timeout
   - Handle timeout errors

**Code Changes** (~80 lines):
```typescript
// Add to constructor
this.timeoutHandler = new TimeoutHandler({
  standardTimeoutMs: this.config.cluster.requestRouting.timeoutMs,
  streamingTimeoutMs: this.config.cluster.requestRouting.streamingTimeoutMs,
});

this.logger.info('Timeout handler initialized', {
  standard: this.config.cluster.requestRouting.timeoutMs,
  streaming: this.config.cluster.requestRouting.streamingTimeoutMs,
});

// Update sendRequestToWorker
private async sendRequestToWorker(
  worker: WorkerInfo,
  request: InferenceRequest
): Promise<any> {
  const isStreaming = request.stream === true;
  const timeoutMs = isStreaming
    ? this.config.cluster.requestRouting.streamingTimeoutMs
    : this.config.cluster.requestRouting.timeoutMs;

  this.logger.debug('Sending request to worker', {
    workerId: worker.workerId,
    requestId: request.requestId,
    streaming: isStreaming,
    timeoutMs,
  });

  try {
    const response = await this.timeoutHandler.withTimeout(
      this.nats.request(`inference.${worker.workerId}`, request),
      timeoutMs,
      `Request timeout (${timeoutMs}ms) for worker ${worker.workerId}`
    );

    this.updateCircuitBreaker(worker.workerId, true);

    this.logger.debug('Request succeeded', {
      workerId: worker.workerId,
      requestId: request.requestId,
    });

    return response;
  } catch (error) {
    this.updateCircuitBreaker(worker.workerId, false);

    this.logger.error('Request failed', {
      workerId: worker.workerId,
      requestId: request.requestId,
      error: (error as Error).message,
    });

    throw error;
  }
}
```

### Phase 4: Error Handling & Metrics (Day 4)

**New Error Types**:
```typescript
export enum ControllerErrorCode {
  NO_WORKERS_AVAILABLE = 'NO_WORKERS_AVAILABLE',
  WORKER_TIMEOUT = 'WORKER_TIMEOUT',
  WORKER_UNAVAILABLE = 'WORKER_UNAVAILABLE',
  ALL_RETRIES_EXHAUSTED = 'ALL_RETRIES_EXHAUSTED',
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  REQUEST_VALIDATION_FAILED = 'REQUEST_VALIDATION_FAILED',
}

export class ControllerError extends Error {
  constructor(
    public code: ControllerErrorCode,
    message: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'ControllerError';
  }
}
```

**Metrics to Add**:
```typescript
interface RequestMetrics {
  retryCount: number;
  circuitBreakerTrips: number;
  timeouts: number;
  failedWorkers: string[];
  selectedWorker: string;
  totalDurationMs: number;
}
```

---

## Testing Strategy

### Unit Tests

**Test Files**:
1. `tests/unit/distributed/controller/controller-integration.test.ts` (10+ tests)

**Test Cases**:
- Circuit breaker filters unhealthy workers
- Retry handler retries on failure
- Timeout handler enforces timeouts
- Error handling propagates correct error codes
- Metrics are collected correctly

### Integration Tests

**Test Files**:
1. `tests/integration/distributed/controller/request-routing.test.ts` (12+ tests)

**Test Scenarios**:
1. **Successful Request** - Request succeeds on first try
2. **Retry on Failure** - Worker fails, retry succeeds on different worker
3. **All Retries Exhausted** - All retries fail, error returned
4. **Circuit Breaker Opens** - Worker fails repeatedly, circuit opens
5. **Circuit Breaker Recovery** - Circuit half-opens, request succeeds, circuit closes
6. **Request Timeout** - Request times out, timeout error returned
7. **No Workers Available** - All workers offline, error returned
8. **Session Affinity with Retry** - Session worker fails, retry on new worker, session updates
9. **Concurrent Requests** - Multiple requests handled concurrently
10. **Mixed Success/Failure** - Some requests succeed, some fail
11. **Streaming Request** - Streaming request with retry and timeout
12. **Buffered Request** - Buffered request with retry and timeout

**Example Test**:
```typescript
it('should retry on worker failure and succeed on different worker', async () => {
  const cluster = new TestCluster({ workerCount: 2 });
  await cluster.start();

  const client = new HttpClient(cluster.getApiUrl());

  // Simulate worker 1 failure
  await cluster.getWorker(0).simulateError();

  // Send request
  const response = await client.chatCompletion({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    messages: [{ role: 'user', content: 'Hello' }],
  });

  expect(response.choices[0].message.content).toBeTruthy();
  expect(response.metadata.retryCount).toBe(1);
  expect(response.metadata.selectedWorker).toBe(cluster.getWorker(1).getWorkerId());

  await cluster.stop();
});
```

---

## Success Criteria

### Functional Requirements

- ✅ Circuit breaker filters unhealthy workers before selection
- ✅ Retry handler retries failed requests up to configured max
- ✅ Timeout handler enforces timeouts on all requests
- ✅ Error handling returns proper error codes and messages
- ✅ Metrics track retries, timeouts, circuit breaker state
- ✅ Session affinity works with retry (session updates on failover)

### Performance Requirements

- ✅ Circuit breaker decision overhead: <1ms
- ✅ Retry overhead: <100ms per retry
- ✅ Timeout enforcement overhead: <5ms
- ✅ No performance degradation on happy path
- ✅ Graceful degradation under failure

### Quality Requirements

- ✅ Integration tests: 12+ tests passing (>95% success)
- ✅ Unit tests: 10+ tests passing
- ✅ TypeScript: 0 errors in controller code
- ✅ ESLint: 0 errors/warnings
- ✅ Logging: Comprehensive logs for debugging
- ✅ Documentation: Updated with new error codes

---

## Risks & Mitigations

### Risk 1: Retry Amplification

**Risk**: Retries could amplify load on healthy workers if many workers fail.

**Mitigation**:
- Limit max retries to 2
- Use exponential backoff
- Circuit breaker prevents retrying on known-bad workers

### Risk 2: Circuit Breaker False Positives

**Risk**: Circuit breaker might incorrectly mark healthy workers as unhealthy.

**Mitigation**:
- Tune failure threshold (default: 5 failures)
- Implement half-open state for recovery testing
- Monitor circuit breaker metrics

### Risk 3: Timeout Too Aggressive

**Risk**: Timeout might be too short for large model inference.

**Mitigation**:
- Separate timeouts for buffered (30s) and streaming (60s)
- Make timeouts configurable
- Log timeout events for tuning

### Risk 4: Session Affinity Lost on Failover

**Risk**: Session affinity breaks when session worker fails.

**Mitigation**:
- Update session registry on failover
- Log session failover events
- Document KV cache loss on failover

---

## Configuration

### cluster.yaml Updates

```yaml
cluster:
  requestRouting:
    retry:
      enabled: true
      maxRetries: 2
      retryDelayMs: 100
      retryOnErrors:
        - WORKER_TIMEOUT
        - WORKER_UNAVAILABLE
        - WORKER_OVERLOADED

    circuitBreaker:
      enabled: true
      failureThreshold: 5
      successThreshold: 2
      timeoutMs: 30000

    timeoutMs: 30000           # 30s for buffered
    streamingTimeoutMs: 60000  # 60s for streaming
```

---

## Timeline

**Total Duration**: 5 days (1 week)

- **Day 1**: CircuitBreaker integration
- **Day 2**: RetryHandler integration
- **Day 3**: TimeoutHandler integration
- **Day 4**: Error handling & metrics
- **Day 5**: Integration tests & documentation

---

## Dependencies

**Phase 2 Week 1** (Complete):
- ✅ SessionRegistry
- ✅ RetryHandler
- ✅ CircuitBreaker
- ✅ TimeoutHandler
- ✅ TestCluster & HttpClient

**Phase 1** (Complete):
- ✅ ControllerNode
- ✅ WorkerRegistry
- ✅ SmartLoadBalancer
- ✅ NATS client

---

## Deliverables

### Code (330+ lines)
- CircuitBreaker integration (~100 lines)
- RetryHandler integration (~150 lines)
- TimeoutHandler integration (~80 lines)

### Tests (800+ lines)
- Unit tests (10+ tests, ~300 lines)
- Integration tests (12+ tests, ~500 lines)

### Documentation
- Error code documentation
- Configuration guide
- Integration test guide
- Week 3 summary report

---

**Document Version**: 1.0.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready for Implementation
