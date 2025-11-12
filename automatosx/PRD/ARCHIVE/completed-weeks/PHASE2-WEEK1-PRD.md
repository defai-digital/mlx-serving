# Phase 2 Week 1: Integration Testing & Advanced Routing - Product Requirements

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 1 of 13 (Week 4 overall)
**Duration**: 5 working days
**Status**: Ready to Start
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Executive Summary

Week 1 of Phase 2 focuses on validating the distributed system through comprehensive integration testing and enhancing the routing layer with advanced features. By end of week, we will have a battle-tested cluster with sticky sessions, retry logic, and complete end-to-end test coverage.

**Goal**: Production-grade reliability through integration testing and advanced routing features

**Success Criteria**:
- ✅ Full integration test suite (controller + workers + NATS)
- ✅ Sticky sessions for KV cache reuse (40-60% latency improvement)
- ✅ Retry logic with automatic failover
- ✅ Circuit breaker for unhealthy workers
- ✅ Request timeout handling
- ✅ Connection pooling for NATS
- ✅ All integration tests passing (>95% success rate)
- ✅ Performance benchmarks complete

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
- ✅ NATS messaging foundation (Week 1)
- ✅ Worker Node with model skills (Week 2)
- ✅ Controller Node with smart routing (Week 3)
- ✅ REST API (OpenAI-compatible)
- ✅ WebSocket streaming
- ✅ Unit tests (41/41 passing)

**Current Gaps**:
- ❌ No integration tests with real workers
- ❌ No sticky session support (KV cache not reused)
- ❌ No retry logic (requests fail immediately)
- ❌ No circuit breaker (unhealthy workers get requests)
- ❌ Limited connection management
- ❌ Basic error handling only

**Phase 2 Week 1 Focus**: Fill these gaps with production-grade features

---

## Goals and Non-Goals

### Goals (Week 1)

✅ **Must Have (P0)**:
1. **Integration Testing Suite**
   - Controller + Worker integration tests (8+ tests)
   - Request routing tests with real inference (10+ tests)
   - End-to-end cluster tests (10+ tests)
   - Performance benchmark tests

2. **Sticky Sessions (Session Affinity)**
   - Route requests with same sessionId to same worker
   - Enable KV cache reuse (40-60% latency reduction)
   - Configurable session TTL
   - Session routing in SmartLoadBalancer

3. **Advanced Request Routing**
   - Retry logic (automatic failover to different worker)
   - Configurable retry count and timeout
   - Circuit breaker for unhealthy workers
   - Request timeout handling

4. **Connection Management**
   - NATS connection pooling
   - Connection health monitoring
   - Automatic reconnection

✅ **Should Have (P1)**:
1. Request queueing with backpressure
2. Worker health scoring (success rate, latency)
3. Graceful worker drain (stop accepting new requests)
4. Request-level metrics (detailed telemetry)
5. Integration test reporting

✅ **Nice to Have (P2)**:
1. Request priority levels
2. Worker affinity based on model type
3. Predictive load balancing
4. Request deduplication at controller level

### Non-Goals (Week 1)

❌ **Out of Scope**:
1. Web dashboard (Phase 3)
2. Prometheus metrics (Phase 3)
3. Auto-scaling (Phase 4)
4. Multi-controller coordination (Future)
5. Model pre-warming (Phase 2 Week 2)
6. Advanced batching strategies (Phase 2 Week 3)

---

## Technical Specifications

### 1. Integration Testing Suite

**Requirements**:
- Test controller + real workers + real NATS server
- Test full request routing flow with inference
- Test worker failure scenarios
- Test cluster scaling (add/remove workers)
- Test concurrent requests (load testing)
- Performance benchmarks

**Test Categories**:

#### Category 1: Controller-Worker Integration
```typescript
// tests/integration/distributed/controller/controller-worker.test.ts

describe('Controller-Worker Integration', () => {
  it('should register worker on startup')
  it('should receive worker heartbeats')
  it('should update worker metrics from heartbeat')
  it('should detect offline workers after timeout')
  it('should re-register worker after restart')
  it('should handle worker with no models')
  it('should handle worker registration failure')
  it('should handle concurrent worker registrations')
});
```

#### Category 2: Request Routing
```typescript
// tests/integration/distributed/controller/request-routing.test.ts

describe('Request Routing Integration', () => {
  it('should route request to worker with model')
  it('should stream tokens back to client')
  it('should handle non-streaming requests')
  it('should route to least loaded worker')
  it('should reject request when no worker has model')
  it('should handle worker failure during request')
  it('should retry on worker failure')
  it('should timeout long-running requests')
  it('should handle concurrent requests')
  it('should route based on session affinity')
});
```

#### Category 3: End-to-End Cluster
```typescript
// tests/integration/distributed/controller/cluster-e2e.test.ts

describe('Cluster End-to-End', () => {
  it('should start cluster with 3 workers')
  it('should distribute load across workers')
  it('should handle worker addition dynamically')
  it('should handle worker removal gracefully')
  it('should maintain service during worker failure')
  it('should recover from all workers offline')
  it('should handle burst traffic (100 concurrent)')
  it('should respect sticky sessions')
  it('should track cluster-wide metrics')
  it('should provide accurate cluster status')
});
```

#### Category 4: Performance Benchmarks
```typescript
// tests/integration/distributed/performance/benchmark.test.ts

describe('Performance Benchmarks', () => {
  it('should measure end-to-end latency (p50, p95, p99)')
  it('should measure throughput (requests/sec)')
  it('should measure sticky session benefit (latency reduction)')
  it('should measure routing overhead')
  it('should measure concurrent request capacity')
  it('should compare with standalone worker')
});
```

**Test Environment**:
- Use embedded NATS server or local NATS
- Use 3 worker nodes with small models (Llama-3.2-3B-Instruct-4bit)
- Run on Apple Silicon (M3+ required)
- Use max_tokens=5-10 for speed
- Proper cleanup in afterAll hooks

---

### 2. Sticky Sessions (Session Affinity)

**Purpose**: Route requests with same sessionId to same worker to enable KV cache reuse

**Performance Impact**:
- First request: Normal latency (e.g., 2000ms for 100 tokens)
- Subsequent requests: 40-60% faster (e.g., 800-1200ms) due to KV cache reuse
- Critical for chat applications (multi-turn conversations)

**API Changes**:

#### Request Format
```typescript
interface InferenceRequest {
  requestId: string;
  modelId: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;  // NEW: Optional session ID for affinity
}
```

#### Session Registry
```typescript
// src/distributed/controller/session-registry.ts

export interface SessionInfo {
  sessionId: string;
  workerId: string;
  createdAt: number;
  lastUsed: number;
  requestCount: number;
}

export class SessionRegistry {
  private sessions: Map<string, SessionInfo>;
  private readonly ttl: number;  // Default: 30 minutes

  constructor(ttl?: number);

  // Session management
  registerSession(sessionId: string, workerId: string): void;
  getSessionWorker(sessionId: string): string | undefined;
  touchSession(sessionId: string): void;
  removeSession(sessionId: string): void;
  cleanupExpiredSessions(): void;

  // Query methods
  getSession(sessionId: string): SessionInfo | undefined;
  getAllSessions(): SessionInfo[];
  getSessionCount(): number;
  getSessionsForWorker(workerId: string): SessionInfo[];
}
```

#### Load Balancer Changes
```typescript
// src/distributed/controller/load-balancers/smart-load-balancer.ts

export class SmartLoadBalancer {
  private sessionRegistry: SessionRegistry;

  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    // Phase 0: Check for session affinity
    if (request.sessionId) {
      const sessionWorker = this.sessionRegistry.getSessionWorker(request.sessionId);

      if (sessionWorker) {
        const worker = workers.find(w => w.workerId === sessionWorker);

        if (worker && worker.status === 'online') {
          // Session worker is online, use it
          this.sessionRegistry.touchSession(request.sessionId);
          return worker;
        } else {
          // Session worker is offline, remove session and continue
          this.sessionRegistry.removeSession(request.sessionId);
        }
      }
    }

    // Phase 1-3: Standard smart selection (skills + hardware + load)
    const selected = this.standardSelection(workers, request);

    // Register new session if provided
    if (request.sessionId) {
      this.sessionRegistry.registerSession(request.sessionId, selected.workerId);
    }

    return selected;
  }
}
```

**Configuration**:
```yaml
# config/cluster.yaml
cluster:
  load_balancing:
    strategy: smart
    session_affinity:
      enabled: true
      ttl_minutes: 30
      cleanup_interval_ms: 60000
```

**REST API Changes**:
```typescript
// POST /v1/chat/completions
{
  "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
  "messages": [...],
  "session_id": "user-123-conversation-456"  // NEW: Optional
}
```

---

### 3. Advanced Request Routing

#### 3.1 Retry Logic

**Purpose**: Automatically retry failed requests on different workers

**Implementation**:
```typescript
// src/distributed/controller/retry-handler.ts

export interface RetryConfig {
  maxRetries: number;      // Default: 2
  retryDelayMs: number;    // Default: 100ms
  retryOnErrors: string[]; // Error codes to retry
  excludeWorker: boolean;  // Exclude failed worker from retry
}

export class RetryHandler {
  constructor(
    private controller: ControllerNode,
    private config: RetryConfig
  ) {}

  async executeWithRetry(
    request: InferenceRequest,
    attemptNumber: number = 0
  ): Promise<ReadableStream> {
    try {
      return await this.controller.handleInferenceRequest(request);
    } catch (error) {
      if (this.shouldRetry(error, attemptNumber)) {
        // Exclude failed worker from retry
        if (this.config.excludeWorker) {
          this.controller.excludeWorkerFromRequest(request.requestId);
        }

        // Wait before retry
        await this.delay(this.config.retryDelayMs);

        // Retry
        return this.executeWithRetry(request, attemptNumber + 1);
      }

      throw error;
    }
  }

  private shouldRetry(error: unknown, attemptNumber: number): boolean {
    if (attemptNumber >= this.config.maxRetries) return false;

    // Check if error is retryable
    if (error instanceof WorkerError) {
      return this.config.retryOnErrors.includes(error.code);
    }

    return false;
  }
}
```

**Error Codes**:
- `WORKER_TIMEOUT` - Worker didn't respond in time (retryable)
- `WORKER_UNAVAILABLE` - Worker is offline (retryable)
- `WORKER_OVERLOADED` - Worker has too many requests (retryable)
- `MODEL_NOT_FOUND` - No worker has model (not retryable)
- `VALIDATION_ERROR` - Invalid request (not retryable)

**Configuration**:
```yaml
cluster:
  request_routing:
    retry:
      enabled: true
      max_retries: 2
      retry_delay_ms: 100
      retry_on_errors:
        - WORKER_TIMEOUT
        - WORKER_UNAVAILABLE
        - WORKER_OVERLOADED
```

#### 3.2 Circuit Breaker

**Purpose**: Stop sending requests to unhealthy workers

**Implementation**:
```typescript
// src/distributed/controller/circuit-breaker.ts

export enum CircuitState {
  CLOSED = 'closed',    // Normal operation
  OPEN = 'open',        // Worker unhealthy, reject requests
  HALF_OPEN = 'half_open'  // Testing if worker recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Default: 5 failures
  successThreshold: number;    // Default: 2 successes
  timeout: number;             // Default: 30s
  halfOpenRequests: number;    // Default: 1
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;

  constructor(
    private workerId: string,
    private config: CircuitBreakerConfig
  ) {}

  canAcceptRequest(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.OPEN) {
      // Check if timeout passed
      if (Date.now() - this.lastFailureTime > this.config.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        return true;
      }
      return false;
    }
    if (this.state === CircuitState.HALF_OPEN) {
      // Allow limited requests to test recovery
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
      }
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
```

**Integration**:
```typescript
// WorkerRegistry tracks circuit breakers per worker
export class WorkerRegistry {
  private circuitBreakers: Map<string, CircuitBreaker>;

  canAcceptRequest(workerId: string): boolean {
    const breaker = this.circuitBreakers.get(workerId);
    return breaker ? breaker.canAcceptRequest() : true;
  }

  recordRequestSuccess(workerId: string): void {
    this.circuitBreakers.get(workerId)?.recordSuccess();
  }

  recordRequestFailure(workerId: string): void {
    this.circuitBreakers.get(workerId)?.recordFailure();
  }
}
```

#### 3.3 Request Timeout

**Purpose**: Prevent hanging requests

**Implementation**:
```typescript
// src/distributed/controller/timeout-handler.ts

export class TimeoutHandler {
  async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      this.timeout(timeoutMs)
    ]);
  }

  private async timeout(ms: number): Promise<never> {
    await new Promise(resolve => setTimeout(resolve, ms));
    throw new TimeoutError(`Request timeout after ${ms}ms`, ms);
  }
}
```

**Configuration**:
```yaml
cluster:
  request_routing:
    timeout_ms: 30000  # 30 seconds
    streaming_timeout_ms: 60000  # 60 seconds for streaming
```

---

### 4. Connection Pooling

**Purpose**: Optimize NATS connection management

**Implementation**:
```typescript
// src/distributed/nats/connection-pool.ts

export interface ConnectionPoolConfig {
  minConnections: number;    // Default: 2
  maxConnections: number;    // Default: 10
  idleTimeoutMs: number;     // Default: 60000 (1 minute)
  acquireTimeoutMs: number;  // Default: 5000 (5 seconds)
}

export class NatsConnectionPool {
  private availableConnections: NatsClient[] = [];
  private activeConnections: Set<NatsClient> = new Set();
  private waitingRequests: Array<(client: NatsClient) => void> = [];

  constructor(
    private config: ConnectionPoolConfig,
    private natsConfig: NatsClientOptions
  ) {}

  async initialize(): Promise<void> {
    // Create min connections
    for (let i = 0; i < this.config.minConnections; i++) {
      await this.createConnection();
    }
  }

  async acquire(): Promise<NatsClient> {
    // Try to get available connection
    if (this.availableConnections.length > 0) {
      const client = this.availableConnections.pop()!;
      this.activeConnections.add(client);
      return client;
    }

    // Try to create new connection if below max
    if (this.getTotalConnections() < this.config.maxConnections) {
      const client = await this.createConnection();
      this.activeConnections.add(client);
      return client;
    }

    // Wait for available connection
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection acquire timeout'));
      }, this.config.acquireTimeoutMs);

      this.waitingRequests.push((client) => {
        clearTimeout(timeout);
        resolve(client);
      });
    });
  }

  release(client: NatsClient): void {
    this.activeConnections.delete(client);

    // Check for waiting requests
    if (this.waitingRequests.length > 0) {
      const waiter = this.waitingRequests.shift()!;
      this.activeConnections.add(client);
      waiter(client);
    } else {
      this.availableConnections.push(client);
    }
  }

  private async createConnection(): Promise<NatsClient> {
    const client = new NatsClient();
    await client.connect(this.natsConfig);
    return client;
  }

  private getTotalConnections(): number {
    return this.availableConnections.length + this.activeConnections.size;
  }
}
```

---

## Architecture

### Enhanced System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ HTTP/WS
┌─────────────────────────────────────────────────────────────┐
│                      Controller Node                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ API Server (Express.js)                                │  │
│  │ - POST /v1/chat/completions (with session_id)         │  │
│  │ - Retry Handler (2 retries, 100ms delay)              │  │
│  │ - Timeout Handler (30s default)                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Request Router (Enhanced)                              │  │
│  │ 1. Session Affinity Check (SessionRegistry)           │  │
│  │ 2. Smart Worker Selection (Skills+Hardware+Load)      │  │
│  │ 3. Circuit Breaker Check (per worker)                 │  │
│  │ 4. Execute with Retry (2 attempts)                    │  │
│  │ 5. Execute with Timeout (30s)                         │  │
│  │ 6. Record Success/Failure (Circuit Breaker)           │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Session Registry                                       │  │
│  │ Sessions: Map<sessionId, workerId>                    │  │
│  │ - session-123 → worker-1                              │  │
│  │ - session-456 → worker-2                              │  │
│  │ TTL: 30 minutes                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Worker Registry (with Circuit Breakers)               │  │
│  │ Workers: Map<workerId, WorkerInfo + CircuitBreaker>  │  │
│  │ - worker-1: CLOSED (healthy)                          │  │
│  │ - worker-2: HALF_OPEN (testing recovery)             │  │
│  │ - worker-3: OPEN (unhealthy, no requests)            │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ NATS Connection Pool                                   │  │
│  │ Available: [conn1, conn2]                             │  │
│  │ Active: {conn3, conn4, conn5}                         │  │
│  │ Min: 2, Max: 10                                        │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ NATS
┌─────────────────────────────────────────────────────────────┐
│                       NATS Server                             │
│  Topics:                                                      │
│  - worker.register      (workers → controller)               │
│  - worker.heartbeat     (workers → controller)               │
│  - worker.*.inference   (controller → workers)               │
│  - response.*           (workers → controller)               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ NATS
┌─────────────────────────────────────────────────────────────┐
│                        Worker Nodes                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Worker 1    │  │  Worker 2    │  │  Worker 3    │      │
│  │  (Healthy)   │  │  (Recovering)│  │  (Unhealthy) │      │
│  │  Circuit:    │  │  Circuit:    │  │  Circuit:    │      │
│  │  CLOSED      │  │  HALF_OPEN   │  │  OPEN        │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## Success Metrics

### Functional Requirements

- ✅ **FR1**: Integration tests pass (>95% success rate)
- ✅ **FR2**: Sticky sessions work (same sessionId → same worker)
- ✅ **FR3**: Retry logic works (auto-failover on worker failure)
- ✅ **FR4**: Circuit breaker works (stops requests to unhealthy workers)
- ✅ **FR5**: Request timeout works (no hanging requests)
- ✅ **FR6**: Connection pooling works (optimized NATS usage)

### Performance Requirements

- ✅ **PR1**: Sticky sessions reduce latency by 40-60%
- ✅ **PR2**: Retry overhead <100ms
- ✅ **PR3**: Circuit breaker decision time <1ms
- ✅ **PR4**: Connection pool acquire time <50ms
- ✅ **PR5**: End-to-end latency within 10% of standalone worker
- ✅ **PR6**: Cluster handles 100+ concurrent requests

### Quality Requirements

- ✅ **QR1**: Integration test coverage >95% success rate
- ✅ **QR2**: All unit tests still passing
- ✅ **QR3**: TypeScript: 0 errors
- ✅ **QR4**: ESLint: 0 errors/warnings
- ✅ **QR5**: Performance benchmarks documented
- ✅ **QR6**: Graceful degradation under failure

---

## Testing Strategy

### Integration Tests (28+ tests)

1. **Controller-Worker Integration** (8 tests)
2. **Request Routing** (10 tests)
3. **End-to-End Cluster** (10 tests)
4. **Performance Benchmarks** (6+ tests)

### Test Environment

- Real NATS server (embedded or external)
- 3 Worker Nodes with Llama-3.2-3B-Instruct-4bit
- Apple Silicon M3+ required
- Small max_tokens (5-10) for speed

---

## Risk Assessment

### Technical Risks

**Risk 1: Integration Test Flakiness**
- **Likelihood**: Medium
- **Impact**: Medium (CI/CD unreliable)
- **Mitigation**: Proper timeouts, cleanup, retries, isolation

**Risk 2: Sticky Session Collision**
- **Likelihood**: Low
- **Impact**: Medium (poor cache reuse)
- **Mitigation**: UUID sessionIds, TTL cleanup, overflow handling

**Risk 3: Circuit Breaker False Positives**
- **Likelihood**: Medium
- **Impact**: Medium (healthy workers excluded)
- **Mitigation**: Tunable thresholds, half-open testing, monitoring

---

## Appendix

### Configuration Example

```yaml
# config/cluster.yaml
cluster:
  load_balancing:
    strategy: smart
    session_affinity:
      enabled: true
      ttl_minutes: 30
      cleanup_interval_ms: 60000

  request_routing:
    retry:
      enabled: true
      max_retries: 2
      retry_delay_ms: 100
      retry_on_errors:
        - WORKER_TIMEOUT
        - WORKER_UNAVAILABLE

    timeout_ms: 30000
    streaming_timeout_ms: 60000

    circuit_breaker:
      enabled: true
      failure_threshold: 5
      success_threshold: 2
      timeout_ms: 30000

  nats:
    connection_pool:
      enabled: true
      min_connections: 2
      max_connections: 10
      idle_timeout_ms: 60000
```

---

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready for Implementation
