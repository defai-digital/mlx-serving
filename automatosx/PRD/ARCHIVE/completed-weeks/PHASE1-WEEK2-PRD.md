# Phase 1 Week 2: Worker Node Implementation - Product Requirements

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 1 - Foundation
**Week**: Week 2 of 13
**Duration**: 5 working days
**Status**: Ready to Start
**Version**: 1.0.0
**Date**: 2025-11-09

---

## Executive Summary

Week 2 implements the Worker Node, the core component that executes inference tasks in the distributed system. By end of week, we will have a fully functional worker that registers with the cluster, receives inference requests via NATS, executes them using mlx-serving Engine, and streams results back.

**Goal**: Production-ready Worker Node with inference execution and cluster integration

**Success Criteria**:
- ✅ Worker registers with cluster via NATS
- ✅ Worker sends periodic heartbeats with metrics
- ✅ Worker receives and executes inference requests
- ✅ Worker streams tokens back via NATS
- ✅ Hardware detection integrated
- ✅ All unit tests passing (>90% coverage)
- ✅ Integration tests with real NATS + Engine passing
- ✅ Documentation complete

---

## Table of Contents

1. [Background](#background)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Technical Specifications](#technical-specifications)
4. [Architecture](#architecture)
5. [API Design](#api-design)
6. [Worker Lifecycle](#worker-lifecycle)
7. [Testing Strategy](#testing-strategy)
8. [Success Metrics](#success-metrics)
9. [Dependencies](#dependencies)
10. [Risk Assessment](#risk-assessment)

---

## Background

### Current State

**Week 1 Completed**:
- ✅ NATS client with pub/sub and request/reply
- ✅ Message type schemas (Zod validation)
- ✅ Configuration loader
- ✅ Embedded NATS server support

**Week 2 Focus**: Build Worker Node on top of Week 1 infrastructure

### Worker Node Role

The Worker Node is responsible for:
1. **Registration**: Announce itself to the cluster with hardware capabilities
2. **Heartbeat**: Send periodic status updates (CPU, GPU, memory, active requests)
3. **Task Execution**: Receive inference requests and execute using mlx-serving Engine
4. **Response Streaming**: Stream generated tokens back to controller
5. **Model Management**: Load/unload models as requested
6. **Health Monitoring**: Report health status and handle errors gracefully

---

## Goals and Non-Goals

### Goals (Week 2)

✅ **Must Have (P0)**:
1. Worker Node class with lifecycle management
2. Worker registration on startup (NATS message)
3. Periodic heartbeat with real metrics (CPU, GPU, memory)
4. Inference request handler (subscribe to worker-specific topic)
5. Token streaming back to controller via NATS
6. Integration with mlx-serving Engine
7. Hardware detection integration (from existing code)
8. Model loading/unloading support
9. Error handling and graceful degradation
10. Comprehensive tests (unit + integration)

✅ **Should Have (P1)**:
1. Configurable worker ID (auto-generate if not provided)
2. Configurable heartbeat interval
3. Request queue for concurrent requests
4. Request timeout handling
5. Metrics collection (latency, throughput, error rate)
6. Graceful shutdown (drain requests before exit)

✅ **Nice to Have (P2)**:
1. Worker tags for categorization (e.g., "production", "development")
2. Worker priority levels
3. Request queueing with backpressure
4. Model preloading on startup
5. Prometheus metrics export

### Non-Goals (Week 2)

❌ **Out of Scope**:
1. Controller Node implementation (Week 3)
2. Load balancing strategies (Phase 2)
3. Web dashboard (Phase 3)
4. Advanced features (sticky sessions, A/B testing - Phase 5)
5. Production deployment (Phase 4)
6. Multi-worker coordination (Week 3)

---

## Technical Specifications

### Worker Node Requirements

#### 1. Worker Registration

**Requirements**:
- Send registration message on startup
- Include complete hardware profile (chip model, GPU cores, memory)
- Include capabilities (max concurrent, supported model tiers)
- Include worker metadata (hostname, IP, port)
- Retry registration on failure

**Message Format** (from Week 1):
```typescript
interface WorkerRegistration {
  workerId: string;           // UUID or configured ID
  hostname: string;           // os.hostname()
  ip: string;                 // Local network IP
  port: number;               // Worker port (default: 8080)
  hardware: HardwareProfile;  // From hardware-detector.ts
  capabilities: {
    maxConcurrent: number;    // From concurrency-auto-tuner.ts
    supportedModelTiers: ModelTier[];
    availableMemoryGB: number;
  };
  status: 'online' | 'offline' | 'degraded';
  timestamp: number;
}
```

**NATS Topic**: `worker.register`

**API**:
```typescript
class WorkerNode {
  async register(): Promise<void>;
  private buildRegistrationMessage(): WorkerRegistration;
}
```

#### 2. Heartbeat System

**Requirements**:
- Send heartbeat every 5 seconds (configurable)
- Include real-time metrics (CPU, GPU, memory usage)
- Include current request count
- Include loaded models
- Stop heartbeat on shutdown

**Message Format**:
```typescript
interface WorkerHeartbeat {
  workerId: string;
  status: 'online' | 'offline' | 'degraded';
  metrics: {
    cpuUsagePercent: number;      // 0-100
    memoryUsedGB: number;          // Current usage
    gpuUtilizationPercent: number; // 0-100 (future)
    activeRequests: number;        // Current executing
    totalRequestsHandled: number;  // Lifetime counter
    avgLatencyMs: number;          // Rolling average
    modelsLoaded: string[];        // Model IDs
  };
  timestamp: number;
}
```

**NATS Topic**: `worker.heartbeat`

**API**:
```typescript
class WorkerNode {
  private startHeartbeat(): void;
  private stopHeartbeat(): void;
  private async collectMetrics(): Promise<WorkerMetrics>;
  private getCpuUsage(): number;
  private getMemoryUsage(): number;
  private getGpuUtilization(): number;
}
```

#### 3. Inference Request Handler

**Requirements**:
- Subscribe to worker-specific NATS topic: `worker.{workerId}.inference`
- Parse and validate inference request
- Load model if not loaded
- Execute generation using mlx-serving Engine
- Stream tokens back via NATS
- Handle errors gracefully
- Track request metrics

**Request Format**:
```typescript
interface InferenceRequest {
  requestId: string;       // UUID
  modelId: string;         // HuggingFace model ID
  prompt: string;          // User prompt
  maxTokens?: number;      // Default: 100
  temperature?: number;    // Default: 0.7
  topP?: number;           // Default: 0.9
  sessionId?: string;      // For sticky sessions (optional)
}
```

**Response Formats**:
```typescript
// Token chunk
interface TokenResponse {
  requestId: string;
  type: 'token';
  token: string;
  index: number;
}

// Completion
interface DoneResponse {
  requestId: string;
  type: 'done';
  totalTokens: number;
  latencyMs: number;
}

// Error
interface ErrorResponse {
  requestId: string;
  type: 'error';
  error: string;
  code: string;
}
```

**NATS Topics**:
- Request: `worker.{workerId}.inference` (subscribe)
- Response: `response.{requestId}` (publish)

**API**:
```typescript
class WorkerNode {
  private async subscribeToInferenceRequests(): Promise<void>;
  private async handleInferenceRequest(req: InferenceRequest): Promise<void>;
  private async loadModelIfNeeded(modelId: string): Promise<void>;
  private async executeInference(req: InferenceRequest): Promise<void>;
  private async streamTokens(requestId: string, stream: ReadableStream): Promise<void>;
}
```

#### 4. Integration with mlx-serving Engine

**Requirements**:
- Initialize Engine instance on worker startup
- Use existing Engine API (no modifications)
- Load models using `engine.loadModel()`
- Generate using `engine.generate()`
- Track loaded models
- Handle Engine errors

**Integration Points**:
```typescript
import { Engine } from '@/api/engine.js';
import type { GenerateParams } from '@/types/generators.js';

class WorkerNode {
  private engine: Engine;

  constructor(config: ClusterConfig) {
    // Initialize mlx-serving engine
    this.engine = new Engine(config.runtime);
  }

  private async loadModelIfNeeded(modelId: string): Promise<void> {
    const loaded = this.engine.getLoadedModels();
    if (!loaded.includes(modelId)) {
      await this.engine.loadModel({ model: modelId });
    }
  }

  private async executeInference(req: InferenceRequest): Promise<ReadableStream> {
    const params: GenerateParams = {
      model: req.modelId,
      prompt: req.prompt,
      maxTokens: req.maxTokens ?? 100,
      temperature: req.temperature ?? 0.7,
      topP: req.topP ?? 0.9,
    };

    return await this.engine.generate(params);
  }
}
```

#### 5. Metrics Collection

**Requirements**:
- Track request count (total, success, error)
- Track latency (min, max, avg, p50, p95, p99)
- Track throughput (tokens/second)
- Track model usage
- Rolling window (last 1000 requests)

**Metrics Structure**:
```typescript
interface WorkerMetrics {
  requests: {
    total: number;
    success: number;
    error: number;
  };
  latency: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  throughput: {
    tokensPerSecond: number;
    requestsPerSecond: number;
  };
  models: Record<string, {
    requestCount: number;
    avgLatency: number;
  }>;
}
```

**API**:
```typescript
class MetricsCollector {
  recordRequest(latencyMs: number, tokensGenerated: number, modelId: string): void;
  recordError(error: Error): void;
  getMetrics(): WorkerMetrics;
  reset(): void;
}
```

---

## Architecture

### File Structure (Week 2)

```
src/distributed/
├── worker/
│   ├── worker-node.ts           # Main Worker Node class (P0)
│   ├── metrics-collector.ts     # Metrics tracking (P0)
│   ├── hardware-reporter.ts     # Hardware detection wrapper (P0)
│   └── request-handler.ts       # Inference request processing (P1)
│
├── nats/                         # From Week 1
│   ├── client.ts
│   ├── embedded-server.ts
│   └── ...
│
├── types/                        # From Week 1
│   ├── messages.ts
│   ├── config.ts
│   └── index.ts
│
├── config/                       # From Week 1
│   └── loader.ts
│
├── utils/                        # From Week 1
│   ├── logger.ts
│   └── errors.ts
│
└── index.ts

scripts/
├── start-worker.ts              # Worker startup script (P0)
└── test-worker.ts               # Manual worker testing (P1)

tests/
├── unit/
│   └── distributed/
│       ├── worker-node.test.ts        # Worker unit tests
│       ├── metrics-collector.test.ts  # Metrics tests
│       └── hardware-reporter.test.ts  # Hardware tests
│
└── integration/
    └── distributed/
        ├── worker-registration.test.ts  # Registration flow
        ├── worker-heartbeat.test.ts     # Heartbeat flow
        └── worker-inference.test.ts     # Full inference flow
```

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Worker Node                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Lifecycle Management                                   │ │
│  │ - start() → register() → heartbeat loop → ready       │ │
│  │ - stop() → drain requests → disconnect → exit         │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │ Registration    │  │ Heartbeat        │  │ Request    │ │
│  │ - Once on start │  │ - Every 5s       │  │ Handler    │ │
│  │ - Hardware info │  │ - Real metrics   │  │ - Inference│ │
│  └─────────────────┘  └──────────────────┘  └────────────┘ │
│           │                    │                    │        │
│           ▼                    ▼                    ▼        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                     NatsClient                         │ │
│  │ publish('worker.register', registration)              │ │
│  │ publish('worker.heartbeat', heartbeat)                │ │
│  │ subscribe('worker.{id}.inference', handler)           │ │
│  │ publish('response.{reqId}', tokens)                   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     NATS Server                              │
│  Topics:                                                     │
│  - worker.register      (worker → cluster)                  │
│  - worker.heartbeat     (worker → cluster)                  │
│  - worker.*.inference   (cluster → worker)                  │
│  - response.*           (worker → cluster)                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  mlx-serving Engine                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ - loadModel(modelId)                                   │ │
│  │ - generate(params) → ReadableStream<string>            │ │
│  │ - getLoadedModels() → string[]                         │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Python Runtime (JSON-RPC)                              │ │
│  │ - MLX model inference                                  │ │
│  │ - Token streaming                                      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Worker Lifecycle State Machine

```
┌──────────┐
│  IDLE    │
└──────────┘
     │
     │ start()
     ▼
┌──────────┐
│CONNECTING│ ← Connect to NATS
└──────────┘
     │
     │ connected
     ▼
┌──────────┐
│REGISTERING│ ← Send registration message
└──────────┘
     │
     │ registered
     ▼
┌──────────┐
│  READY   │ ← Heartbeat loop + inference handler active
└──────────┘
     │
     │ stop()
     ▼
┌──────────┐
│ DRAINING │ ← Wait for active requests to complete
└──────────┘
     │
     │ drained
     ▼
┌──────────┐
│ STOPPED  │ ← Disconnect from NATS, exit
└──────────┘
```

---

## API Design

### WorkerNode Class

```typescript
import { NatsClient } from '@/distributed/nats/client.js';
import { Engine } from '@/api/engine.js';
import { ClusterConfig } from '@/distributed/types/config.js';
import { WorkerRegistration, WorkerHeartbeat, InferenceRequest } from '@/distributed/types/messages.js';

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
  workerId?: string;  // Auto-generate if not provided
}

export class WorkerNode {
  private state: WorkerState;
  private workerId: string;
  private nats: NatsClient;
  private engine: Engine;
  private config: ClusterConfig;
  private heartbeatInterval?: NodeJS.Timeout;
  private activeRequests: number;
  private metrics: MetricsCollector;

  constructor(options: WorkerNodeOptions);

  // Lifecycle
  async start(): Promise<void>;
  async stop(): Promise<void>;
  getState(): WorkerState;
  getWorkerId(): string;

  // Registration & Heartbeat
  private async register(): Promise<void>;
  private startHeartbeat(): void;
  private stopHeartbeat(): void;
  private async collectMetrics(): Promise<WorkerMetrics>;

  // Inference
  private async subscribeToInferenceRequests(): Promise<void>;
  private async handleInferenceRequest(req: InferenceRequest): Promise<void>;
  private async loadModelIfNeeded(modelId: string): Promise<void>;
  private async executeInference(req: InferenceRequest): Promise<void>;
  private async streamTokens(requestId: string, stream: ReadableStream): Promise<void>;

  // Utilities
  private getLocalIp(): string;
  private getCpuUsage(): Promise<number>;
  private getMemoryUsage(): number;
  private getGpuUtilization(): number;
}
```

### MetricsCollector Class

```typescript
export class MetricsCollector {
  private requests: Array<{ latencyMs: number; tokensGenerated: number; modelId: string; timestamp: number }>;
  private errors: Array<{ error: Error; timestamp: number }>;
  private readonly maxSamples: number;

  constructor(maxSamples?: number);

  recordRequest(latencyMs: number, tokensGenerated: number, modelId: string): void;
  recordError(error: Error): void;
  getMetrics(): WorkerMetrics;
  getAverageLatency(): number;
  getThroughput(): number;
  getErrorRate(): number;
  reset(): void;
}
```

### HardwareReporter Class

```typescript
import { detectHardware, HardwareProfile } from '@/core/hardware-detector.js';
import { recommendConcurrency } from '@/core/concurrency-auto-tuner.js';

export class HardwareReporter {
  private hardware: HardwareProfile;
  private capabilities: WorkerCapabilities;

  constructor();

  getHardwareProfile(): HardwareProfile;
  getCapabilities(): WorkerCapabilities;
  getCpuUsage(): Promise<number>;
  getMemoryUsage(): number;
  getGpuUtilization(): number;
}
```

---

## Worker Lifecycle

### Startup Sequence

```typescript
// scripts/start-worker.ts
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { loadClusterConfig } from '@/distributed/config/loader.js';

async function main() {
  // 1. Load configuration
  const config = await loadClusterConfig('config/cluster.yaml');

  // 2. Create worker instance
  const worker = new WorkerNode({ config });

  // 3. Start worker (async)
  await worker.start();
  // ↓
  // - Connect to NATS
  // - Detect hardware
  // - Initialize Engine
  // - Send registration
  // - Start heartbeat
  // - Subscribe to inference requests
  // ↓
  // Worker is now READY

  console.log(`Worker ${worker.getWorkerId()} is ready`);

  // 4. Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down...');
    await worker.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

### Shutdown Sequence

```typescript
async stop(): Promise<void> {
  this.logger.info('Stopping worker');
  this.state = WorkerState.DRAINING;

  // 1. Stop accepting new requests
  this.stopHeartbeat();

  // 2. Wait for active requests to complete (max 30s)
  const maxWait = 30000;
  const startTime = Date.now();

  while (this.activeRequests > 0 && Date.now() - startTime < maxWait) {
    this.logger.info(`Waiting for ${this.activeRequests} active requests to complete`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (this.activeRequests > 0) {
    this.logger.warn(`Force shutdown with ${this.activeRequests} requests still active`);
  }

  // 3. Disconnect from NATS
  await this.nats.disconnect();

  // 4. Cleanup
  this.state = WorkerState.STOPPED;
  this.logger.info('Worker stopped');
}
```

---

## Testing Strategy

### Unit Tests (tests/unit/distributed/)

**Coverage Target**: >90%

**Test Files**:

1. **worker-node.test.ts**:
   - Worker lifecycle (start/stop)
   - State transitions
   - Registration message format
   - Heartbeat timing
   - Error handling

2. **metrics-collector.test.ts**:
   - Request recording
   - Error recording
   - Metric calculations (avg, p50, p95, p99)
   - Rolling window behavior
   - Throughput calculation

3. **hardware-reporter.test.ts**:
   - Hardware detection integration
   - CPU usage calculation
   - Memory usage calculation
   - Capabilities generation

### Integration Tests (tests/integration/distributed/)

**Test Files**:

1. **worker-registration.test.ts**:
   - Worker registers on startup
   - Registration message received by NATS
   - Hardware info correct
   - Capabilities correct

2. **worker-heartbeat.test.ts**:
   - Heartbeat sent every 5 seconds
   - Metrics updated in heartbeat
   - Heartbeat stops on shutdown

3. **worker-inference.test.ts**:
   - Full end-to-end inference flow
   - Request received via NATS
   - Model loaded
   - Tokens streamed back
   - Metrics updated

**Example Integration Test**:

```typescript
// tests/integration/distributed/worker-inference.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { NatsClient } from '@/distributed/nats/client.js';
import type { InferenceRequest, StreamingResponse } from '@/distributed/types/messages.js';

describe('Worker Inference (Integration)', () => {
  let worker: WorkerNode;
  let client: NatsClient;

  beforeAll(async () => {
    // Start worker
    worker = new WorkerNode({
      config: await loadClusterConfig('config/cluster.yaml'),
    });
    await worker.start();

    // Connect test client
    client = new NatsClient();
    await client.connect({ mode: 'embedded' });
  });

  afterAll(async () => {
    await worker.stop();
    await client.disconnect();
  });

  it('should execute inference request end-to-end', async () => {
    const requestId = 'test-req-123';
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    // Collect response tokens
    const tokens: string[] = [];
    let done = false;

    // Subscribe to response
    await client.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'token') {
        tokens.push(msg.token);
      } else if (msg.type === 'done') {
        done = true;
      }
    });

    // Send inference request
    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Hello, how are you?',
      maxTokens: 10,
      temperature: 0.7,
    };

    await client.publish(`worker.${worker.getWorkerId()}.inference`, request);

    // Wait for completion (max 30s)
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (done) {
          clearInterval(interval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 30000);
    });

    // Verify response
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.length).toBeLessThanOrEqual(10);
    expect(done).toBe(true);
  });
});
```

---

## Success Metrics

### Functional Requirements

- ✅ **FR1**: Worker registers on startup with correct hardware info
- ✅ **FR2**: Worker sends heartbeat every 5 seconds
- ✅ **FR3**: Worker receives inference requests via NATS
- ✅ **FR4**: Worker executes inference using Engine
- ✅ **FR5**: Worker streams tokens back via NATS
- ✅ **FR6**: Worker handles errors gracefully
- ✅ **FR7**: Worker shuts down gracefully

### Performance Requirements

- ✅ **PR1**: Registration completes in <2s
- ✅ **PR2**: Heartbeat overhead <10ms
- ✅ **PR3**: Request handling overhead <50ms
- ✅ **PR4**: Token streaming latency <10ms per token
- ✅ **PR5**: Supports 3+ concurrent requests (30B models)

### Quality Requirements

- ✅ **QR1**: Unit test coverage >90%
- ✅ **QR2**: All integration tests pass
- ✅ **QR3**: No TypeScript errors (strict mode)
- ✅ **QR4**: No ESLint errors/warnings
- ✅ **QR5**: Documentation complete
- ✅ **QR6**: Graceful error handling (no crashes)

### Validation Checklist

**End of Week 2**:
- [ ] Worker registers successfully ✅
- [ ] Heartbeat sends every 5s ✅
- [ ] Inference requests work ✅
- [ ] Tokens stream correctly ✅
- [ ] Metrics collected ✅
- [ ] Unit tests: >90% coverage ✅
- [ ] Integration tests: All passing ✅
- [ ] TypeScript: 0 errors ✅
- [ ] ESLint: 0 errors/warnings ✅
- [ ] Documentation: Complete ✅

---

## Dependencies

### Internal Dependencies (from Week 1)

- `src/distributed/nats/client.ts` - NATS client
- `src/distributed/types/messages.ts` - Message schemas
- `src/distributed/config/loader.ts` - Configuration
- `src/distributed/utils/logger.ts` - Logging
- `src/distributed/utils/errors.ts` - Errors

### Internal Dependencies (existing mlx-serving)

- `src/api/engine.ts` - mlx-serving Engine
- `src/core/hardware-detector.ts` - Hardware detection
- `src/core/concurrency-auto-tuner.ts` - Concurrency recommendations
- `src/types/generators.ts` - Generator types

### External Dependencies

- `nats` - NATS client (from Week 1)
- `uuid` - UUID generation (from Week 1)
- `os` - CPU/memory metrics
- Node.js `child_process` - For hardware detection

---

## Risk Assessment

### Technical Risks

**Risk 1: Engine Integration Complexity**
- **Likelihood**: Medium
- **Impact**: High (core functionality)
- **Mitigation**: Use existing Engine API, comprehensive testing, mock Engine in unit tests

**Risk 2: Metrics Collection Overhead**
- **Likelihood**: Low
- **Impact**: Medium (performance degradation)
- **Mitigation**: Async collection, sampling, benchmarks

**Risk 3: Concurrent Request Handling**
- **Likelihood**: Medium
- **Impact**: High (GPU crashes on 30B models)
- **Mitigation**: Use existing concurrency limiter, queue requests, integration tests

**Risk 4: Network Reliability**
- **Likelihood**: Low
- **Impact**: Medium (lost messages)
- **Mitigation**: NATS reconnection, request timeouts, error handling

### Operational Risks

**Risk 5: Worker Crash Recovery**
- **Likelihood**: Medium
- **Impact**: Medium (requests fail)
- **Mitigation**: Graceful shutdown, drain requests, health monitoring

**Risk 6: Model Loading Failures**
- **Likelihood**: Low
- **Impact**: Medium (requests fail)
- **Mitigation**: Error handling, retry logic, fallback

---

## Acceptance Criteria

### Definition of Done (Week 2)

A feature is "done" when:
1. ✅ Code written and reviewed
2. ✅ Unit tests written (>90% coverage)
3. ✅ Integration tests written and passing
4. ✅ TypeScript compiles with no errors
5. ✅ ESLint passes with no errors/warnings
6. ✅ Documentation written (JSDoc + markdown)
7. ✅ Manual testing successful
8. ✅ Performance targets met

### Week 2 Deliverables

**Code**:
- [ ] `src/distributed/worker/worker-node.ts` (500+ lines)
- [ ] `src/distributed/worker/metrics-collector.ts` (200+ lines)
- [ ] `src/distributed/worker/hardware-reporter.ts` (150+ lines)
- [ ] `scripts/start-worker.ts` (100+ lines)

**Tests**:
- [ ] Unit tests (600+ lines)
- [ ] Integration tests (400+ lines)

**Documentation**:
- [ ] Worker API documentation (JSDoc)
- [ ] Worker startup guide (markdown)
- [ ] Troubleshooting guide (markdown)

**Validation**:
- [ ] All tests passing ✅
- [ ] Manual end-to-end test successful ✅
- [ ] Performance benchmarks complete ✅

---

## Appendix

### A. Worker Configuration Example

```yaml
# config/cluster.yaml
cluster:
  mode: worker  # Worker-only mode

  nats:
    mode: external
    server_url: "nats://192.168.1.100:4222"

  worker:
    worker_id: null  # Auto-generate
    port: 8080

  discovery:
    enabled: true
    heartbeat_interval_ms: 5000
    offline_timeout_ms: 15000

  # mlx-serving runtime config (inherited)
  runtime:
    model_concurrency_limiter:
      enabled: true
      tier_limits:
        '30B+':
          max_concurrent: 3
          queue_depth: 25
```

### B. Manual Testing Script

```bash
# scripts/test-worker.sh

# 1. Start NATS server
nats-server --port 4222 --http_port 8222 &
NATS_PID=$!

# 2. Subscribe to worker messages (in separate terminal)
nats sub "worker.>" &
SUB_PID=$!

# 3. Start worker
npx tsx scripts/start-worker.ts &
WORKER_PID=$!

# Wait for registration
sleep 2

# 4. Send test inference request
node -e "
const { NatsClient } = require('./dist/distributed/nats/client.js');

async function test() {
  const client = new NatsClient();
  await client.connect({ mode: 'external', serverUrl: 'nats://localhost:4222' });

  // Subscribe to response
  await client.subscribe('response.test-123', (msg) => {
    console.log('Response:', msg);
  });

  // Send request
  await client.publish('worker.*.inference', {
    requestId: 'test-123',
    modelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'Hello, world!',
    maxTokens: 10,
  });

  setTimeout(() => process.exit(0), 30000);
}

test().catch(console.error);
"

# 5. Cleanup
kill $WORKER_PID $SUB_PID $NATS_PID
```

### C. Troubleshooting Guide

**Problem**: Worker fails to register

**Solution**:
1. Check NATS server is running: `nats-server --version`
2. Check NATS connection: `nats pub test "hello"`
3. Check worker logs for errors
4. Verify config file: `cat config/cluster.yaml`

**Problem**: Inference requests timeout

**Solution**:
1. Check model is loaded: Check worker logs
2. Check GPU availability: `system_profiler SPDisplaysDataType`
3. Check concurrent requests: Not exceeding max_concurrent
4. Check NATS latency: Run performance benchmarks

**Problem**: High memory usage

**Solution**:
1. Check loaded models: Worker logs show loaded models
2. Reduce concurrent requests: Lower max_concurrent in config
3. Enable model unloading: After idle period
4. Monitor with: `top -pid <worker-pid>`

---

**Document Version**: 1.0
**Last Updated**: 2025-11-09
**Author**: Claude Code
**Status**: Ready for Implementation
