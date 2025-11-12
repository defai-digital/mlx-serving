# Phase 1 Week 1: NATS Foundation - Product Requirements

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 1 - Foundation
**Week**: Week 1 of 13
**Duration**: 5 working days
**Status**: Ready to Start
**Version**: 1.0.0
**Date**: 2025-11-09

---

## Executive Summary

Week 1 establishes the foundational messaging infrastructure for the distributed inference system. By end of week, we will have a production-ready NATS client wrapper, type-safe message schemas, and configuration management.

**Goal**: NATS messaging foundation with type safety and configuration management

**Success Criteria**:
- ✅ NATS client connects to embedded/external server
- ✅ Type-safe pub/sub messaging working
- ✅ Configuration loaded and validated with Zod
- ✅ All unit tests passing (>90% coverage)
- ✅ Integration tests with real NATS server passing
- ✅ Documentation complete

---

## Table of Contents

1. [Background](#background)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Technical Specifications](#technical-specifications)
4. [Architecture](#architecture)
5. [API Design](#api-design)
6. [Configuration Schema](#configuration-schema)
7. [Testing Strategy](#testing-strategy)
8. [Success Metrics](#success-metrics)
9. [Dependencies](#dependencies)
10. [Risk Assessment](#risk-assessment)

---

## Background

### Current State

mlx-serving is a single-node TypeScript/Python inference engine. We need to add distributed capabilities to enable multi-Mac clusters.

**Existing Infrastructure**:
- ✅ Hardware detection (`src/core/hardware-detector.ts`)
- ✅ Concurrency management (`src/core/model-concurrency-limiter.ts`)
- ✅ Zod validation throughout codebase
- ✅ TypeScript strict mode
- ✅ Vitest testing framework

### Why NATS?

**Alternatives Considered**:
1. **gRPC**: Used by exo-explore, but complex for centralized architecture
2. **RabbitMQ**: Heavy, requires separate server, overkill for our use case
3. **Redis Pub/Sub**: Limited features, no JetStream persistence
4. **NATS**: Modern, lightweight, built-in monitoring, JetStream, perfect for our needs

**NATS Advantages**:
- Lightweight (single binary, <50MB)
- Modern pub/sub patterns
- Request/reply for RPC
- JetStream for persistence
- Built-in monitoring (Prometheus metrics)
- Can run embedded or external
- Excellent TypeScript client

---

## Goals and Non-Goals

### Goals (Week 1)

✅ **Must Have (P0)**:
1. NATS client wrapper class with connection management
2. Type-safe publish/subscribe methods
3. Request/reply (RPC-style) support
4. Embedded NATS server support
5. External NATS server connection support
6. Zod schemas for all message types
7. Configuration loader with validation
8. Comprehensive error handling
9. Unit tests (>90% coverage)
10. Integration tests with real NATS

✅ **Should Have (P1)**:
1. Automatic reconnection on connection loss
2. Connection health monitoring
3. Message serialization helpers (JSON, String)
4. TypeScript generics for type safety
5. Graceful shutdown handling
6. Debug logging

✅ **Nice to Have (P2)**:
1. Connection pooling
2. Message compression
3. Performance benchmarks
4. Prometheus metrics for NATS client

### Non-Goals (Week 1)

❌ **Out of Scope**:
1. Worker/Controller implementation (Week 2-3)
2. Load balancing (Phase 2)
3. Web dashboard (Phase 3)
4. JetStream persistence (Phase 4)
5. Authentication (Phase 4)
6. Production deployment (Phase 4)

---

## Technical Specifications

### NATS Client Requirements

#### 1. Connection Management

**Requirements**:
- Connect to embedded NATS server (spawned as child process)
- Connect to external NATS server (URL provided in config)
- Handle connection failures gracefully
- Automatic reconnection with exponential backoff
- Emit connection state events (connected, disconnected, reconnecting)

**API**:
```typescript
interface NatsClientOptions {
  mode: 'embedded' | 'external';
  serverUrl?: string;          // Required for external mode
  embeddedPort?: number;       // Default: 4222
  user?: string;               // Optional authentication
  password?: string;           // Optional authentication
  reconnect?: boolean;         // Default: true
  maxReconnectAttempts?: number; // Default: 10
  reconnectTimeWait?: number;  // Default: 2000ms
}

class NatsClient {
  async connect(options: NatsClientOptions): Promise<void>;
  async disconnect(): Promise<void>;
  isConnected(): boolean;
  getConnectionState(): ConnectionState;
  on(event: 'connected' | 'disconnected' | 'error', handler: Function): void;
}
```

#### 2. Pub/Sub Messaging

**Requirements**:
- Publish messages to subjects (topics)
- Subscribe to subjects with callback
- Type-safe message payloads using generics
- JSON serialization/deserialization
- Subscription management (unsubscribe)
- Wildcard subscriptions support

**API**:
```typescript
class NatsClient {
  // Publish
  async publish<T>(subject: string, data: T): Promise<void>;

  // Subscribe
  async subscribe<T>(
    subject: string,
    callback: (data: T) => void | Promise<void>
  ): Promise<Subscription>;

  // Unsubscribe
  async unsubscribe(subscription: Subscription): Promise<void>;
}
```

#### 3. Request/Reply (RPC)

**Requirements**:
- Send request and wait for reply
- Timeout support
- Type-safe request/response payloads
- Multiple concurrent requests supported

**API**:
```typescript
class NatsClient {
  async request<Req, Res>(
    subject: string,
    data: Req,
    options?: { timeout?: number }
  ): Promise<Res>;

  async reply<Req, Res>(
    subject: string,
    handler: (data: Req) => Promise<Res> | Res
  ): Promise<void>;
}
```

#### 4. Embedded NATS Server

**Requirements**:
- Spawn `nats-server` binary as child process
- Monitor process health
- Capture stdout/stderr for debugging
- Graceful shutdown
- Port conflict detection

**API**:
```typescript
class EmbeddedNatsServer {
  async start(options: EmbeddedServerOptions): Promise<void>;
  async stop(): Promise<void>;
  isRunning(): boolean;
  getPort(): number;
  getLogs(): string[];
}

interface EmbeddedServerOptions {
  port?: number;          // Default: 4222
  httpPort?: number;      // Default: 8222 (monitoring)
  jetstream?: boolean;    // Default: false
  storeDir?: string;      // JetStream store directory
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}
```

---

### Message Type System

#### Core Message Types

All message types defined with Zod schemas for runtime validation:

```typescript
// 1. Worker Registration
const WorkerRegistrationSchema = z.object({
  workerId: z.string().uuid(),
  hostname: z.string(),
  ip: z.string().ip(),
  port: z.number().int().min(1024).max(65535),
  hardware: HardwareProfileSchema,  // From existing hardware-detector.ts
  capabilities: z.object({
    maxConcurrent: z.number().int().positive(),
    supportedModelTiers: z.array(ModelTierSchema),
    availableMemoryGB: z.number().positive(),
  }),
  status: z.enum(['online', 'offline', 'degraded']),
  timestamp: z.number().int().positive(),
});

// 2. Worker Heartbeat
const WorkerHeartbeatSchema = z.object({
  workerId: z.string().uuid(),
  status: z.enum(['online', 'offline', 'degraded']),
  metrics: z.object({
    cpuUsagePercent: z.number().min(0).max(100),
    memoryUsedGB: z.number().nonnegative(),
    gpuUtilizationPercent: z.number().min(0).max(100),
    activeRequests: z.number().int().nonnegative(),
    totalRequestsHandled: z.number().int().nonnegative(),
    avgLatencyMs: z.number().nonnegative(),
    modelsLoaded: z.array(z.string()),
  }),
  timestamp: z.number().int().positive(),
});

// 3. Inference Request
const InferenceRequestSchema = z.object({
  requestId: z.string().uuid(),
  modelId: z.string(),
  prompt: z.string(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  sessionId: z.string().uuid().optional(),  // For sticky sessions
});

// 4. Streaming Response
const StreamingResponseSchema = z.discriminatedUnion('type', [
  z.object({
    requestId: z.string().uuid(),
    type: z.literal('token'),
    token: z.string(),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    requestId: z.string().uuid(),
    type: z.literal('done'),
    totalTokens: z.number().int().positive(),
    latencyMs: z.number().nonnegative(),
  }),
  z.object({
    requestId: z.string().uuid(),
    type: z.literal('error'),
    error: z.string(),
    code: z.string(),
  }),
]);
```

#### Type Inference

```typescript
// Export TypeScript types from Zod schemas
export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>;
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;
export type StreamingResponse = z.infer<typeof StreamingResponseSchema>;
```

---

### Configuration Schema

#### Cluster Configuration (cluster.yaml)

```yaml
cluster:
  # Node mode
  mode: "dual"  # "controller" | "worker" | "dual"

  # NATS configuration
  nats:
    mode: "embedded"  # "embedded" | "external"

    # External server settings
    server_url: "nats://localhost:4222"
    user: null
    password: null

    # Embedded server settings
    embedded:
      port: 4222
      http_port: 8222
      jetstream:
        enabled: false
        store_dir: ".nats/jetstream"
      log_level: "info"

    # Client settings
    reconnect: true
    max_reconnect_attempts: 10
    reconnect_time_wait: 2000

  # Controller settings (only if mode=controller or dual)
  controller:
    bind_address: "0.0.0.0"
    port: 8080
    dashboard_port: 8081

  # Worker settings (only if mode=worker or dual)
  worker:
    port: 8080
    worker_id: null  # Auto-generated if null

  # Discovery settings
  discovery:
    enabled: true
    heartbeat_interval_ms: 5000
    offline_timeout_ms: 15000

  # Static workers (pre-configured)
  workers:
    static: []

  # Load balancing
  load_balancing:
    strategy: "round_robin"
    sticky_sessions: false

  # Logging
  logging:
    level: "info"
    format: "json"
    file: null
```

#### Zod Schema for Configuration

```typescript
const ClusterConfigSchema = z.object({
  cluster: z.object({
    mode: z.enum(['controller', 'worker', 'dual']),

    nats: z.object({
      mode: z.enum(['embedded', 'external']),
      server_url: z.string().url().optional(),
      user: z.string().optional(),
      password: z.string().optional(),

      embedded: z.object({
        port: z.number().int().min(1024).max(65535).default(4222),
        http_port: z.number().int().min(1024).max(65535).default(8222),
        jetstream: z.object({
          enabled: z.boolean().default(false),
          store_dir: z.string().default('.nats/jetstream'),
        }).optional(),
        log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      }).optional(),

      reconnect: z.boolean().default(true),
      max_reconnect_attempts: z.number().int().positive().default(10),
      reconnect_time_wait: z.number().int().positive().default(2000),
    }),

    controller: z.object({
      bind_address: z.string().default('0.0.0.0'),
      port: z.number().int().min(1024).max(65535).default(8080),
      dashboard_port: z.number().int().min(1024).max(65535).default(8081),
    }).optional(),

    worker: z.object({
      port: z.number().int().min(1024).max(65535).default(8080),
      worker_id: z.string().uuid().optional(),
    }).optional(),

    discovery: z.object({
      enabled: z.boolean().default(true),
      heartbeat_interval_ms: z.number().int().positive().default(5000),
      offline_timeout_ms: z.number().int().positive().default(15000),
    }),

    workers: z.object({
      static: z.array(z.object({
        ip: z.string().ip(),
        port: z.number().int().min(1024).max(65535),
        name: z.string(),
        priority: z.number().int().min(0).max(100).default(50),
      })).default([]),
    }),

    load_balancing: z.object({
      strategy: z.enum(['round_robin', 'least_loaded', 'hardware_aware']).default('round_robin'),
      sticky_sessions: z.boolean().default(false),
    }),

    logging: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      format: z.enum(['json', 'text']).default('json'),
      file: z.string().optional(),
    }),
  }),
});

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
```

---

## Architecture

### File Structure (Week 1)

```
src/distributed/
├── nats/
│   ├── client.ts              # NatsClient class
│   ├── embedded-server.ts     # EmbeddedNatsServer class
│   ├── connection-manager.ts  # Connection state management
│   └── serializers.ts         # Message serialization helpers
│
├── types/
│   ├── messages.ts            # Message Zod schemas + types
│   ├── config.ts              # Configuration Zod schemas + types
│   └── index.ts               # Barrel exports
│
├── config/
│   ├── loader.ts              # Configuration file loader
│   ├── validator.ts           # Configuration validation
│   └── defaults.ts            # Default configuration values
│
├── utils/
│   ├── logger.ts              # Structured logging utility
│   └── errors.ts              # Custom error classes
│
└── index.ts                   # Main barrel export

config/
└── cluster.yaml               # Default cluster configuration

tests/
├── unit/
│   └── distributed/
│       ├── nats-client.test.ts
│       ├── embedded-server.test.ts
│       ├── message-schemas.test.ts
│       └── config-loader.test.ts
│
└── integration/
    └── distributed/
        ├── nats-connection.test.ts
        └── message-roundtrip.test.ts
```

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│  (Worker/Controller nodes - implemented in Week 2-3)         │
└─────────────────────────────────────────────────────────────┘
                            ↓ uses
┌─────────────────────────────────────────────────────────────┐
│                       NatsClient                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ - connect(options)                                     │ │
│  │ - publish<T>(subject, data)                           │ │
│  │ - subscribe<T>(subject, callback)                     │ │
│  │ - request<Req, Res>(subject, data, timeout)           │ │
│  │ - disconnect()                                         │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
           ↓ uses                              ↓ uses
┌─────────────────────────┐      ┌──────────────────────────┐
│  ConnectionManager      │      │  Message Serializers     │
│  - Reconnection logic   │      │  - JSON encode/decode    │
│  - Health monitoring    │      │  - Schema validation     │
│  - State management     │      │  - Type safety          │
└─────────────────────────┘      └──────────────────────────┘
           ↓ manages
┌─────────────────────────────────────────────────────────────┐
│               NATS Server (embedded or external)             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Embedded Mode:                                         │ │
│  │   EmbeddedNatsServer spawns nats-server binary        │ │
│  │   Manages process lifecycle                            │ │
│  │                                                         │ │
│  │ External Mode:                                          │ │
│  │   Connects to existing NATS server                     │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## API Design

### NatsClient API

```typescript
import { NatsClient } from '@/distributed/nats/client.js';
import type { WorkerRegistration, WorkerHeartbeat } from '@/distributed/types/messages.js';

// 1. Connect to embedded NATS server
const client = new NatsClient();
await client.connect({
  mode: 'embedded',
  embeddedPort: 4222,
});

// 2. Publish message
await client.publish<WorkerRegistration>('worker.register', {
  workerId: 'worker-123',
  hostname: 'mac-studio-1',
  // ... other fields
});

// 3. Subscribe to messages
const sub = await client.subscribe<WorkerHeartbeat>(
  'worker.heartbeat',
  async (heartbeat) => {
    console.log(`Heartbeat from ${heartbeat.workerId}`);
  }
);

// 4. Request/Reply (RPC)
const response = await client.request<InferenceRequest, InferenceResponse>(
  'worker.worker-123.inference',
  { requestId: 'req-456', prompt: 'Hello', modelId: 'llama-3' },
  { timeout: 5000 }
);

// 5. Disconnect
await client.disconnect();
```

### Configuration Loader API

```typescript
import { loadClusterConfig } from '@/distributed/config/loader.js';

// Load and validate configuration
const config = await loadClusterConfig('config/cluster.yaml');
// Type: ClusterConfig (fully validated)

// Access config
console.log(config.cluster.mode);          // 'dual'
console.log(config.cluster.nats.mode);     // 'embedded'
console.log(config.cluster.nats.embedded?.port); // 4222
```

### Error Handling

```typescript
import {
  NatsConnectionError,
  NatsTimeoutError,
  ConfigValidationError
} from '@/distributed/utils/errors.js';

try {
  await client.connect({ mode: 'external', serverUrl: 'nats://invalid:4222' });
} catch (error) {
  if (error instanceof NatsConnectionError) {
    console.error('Failed to connect to NATS:', error.message);
    // Retry logic
  }
}

try {
  const response = await client.request('worker.1.inference', data, { timeout: 1000 });
} catch (error) {
  if (error instanceof NatsTimeoutError) {
    console.error('Request timed out');
    // Fallback to another worker
  }
}
```

---

## Configuration Schema

See [Configuration Schema](#configuration-schema) section above for full YAML example and Zod schema.

**Key Configuration Points**:
1. **Mode Selection**: Controller, Worker, or Dual
2. **NATS Mode**: Embedded (simple) or External (production)
3. **Connection Settings**: Reconnect, timeouts, retries
4. **Discovery**: Heartbeat intervals, offline detection
5. **Logging**: Level, format, file output

---

## Testing Strategy

### Unit Tests (tests/unit/distributed/)

**Coverage Target**: >90%

**Test Files**:

1. **nats-client.test.ts**:
   - Connection management
   - Publish/subscribe
   - Request/reply
   - Error handling
   - Reconnection logic
   - Graceful shutdown

2. **embedded-server.test.ts**:
   - Server startup/shutdown
   - Process monitoring
   - Port conflict detection
   - Log capture
   - Health checks

3. **message-schemas.test.ts**:
   - Schema validation (valid inputs)
   - Schema validation (invalid inputs)
   - Type inference correctness
   - Edge cases (nulls, undefined, empty strings)

4. **config-loader.test.ts**:
   - YAML parsing
   - Schema validation
   - Default values
   - Environment variable interpolation
   - Error messages on invalid config

**Example Test**:

```typescript
// tests/unit/distributed/nats-client.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NatsClient } from '@/distributed/nats/client.js';

describe('NatsClient', () => {
  let client: NatsClient;

  beforeEach(() => {
    client = new NatsClient();
  });

  afterEach(async () => {
    await client.disconnect();
  });

  it('should connect to embedded NATS server', async () => {
    await client.connect({ mode: 'embedded' });
    expect(client.isConnected()).toBe(true);
  });

  it('should publish and receive messages', async () => {
    await client.connect({ mode: 'embedded' });

    const received: string[] = [];
    await client.subscribe<string>('test.subject', (msg) => {
      received.push(msg);
    });

    await client.publish('test.subject', 'Hello NATS');

    // Wait for message delivery
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(received).toEqual(['Hello NATS']);
  });

  it('should handle connection failures gracefully', async () => {
    await expect(
      client.connect({ mode: 'external', serverUrl: 'nats://invalid:9999' })
    ).rejects.toThrow(NatsConnectionError);
  });

  it('should support request/reply pattern', async () => {
    await client.connect({ mode: 'embedded' });

    // Setup reply handler
    await client.reply<string, string>('echo', async (msg) => {
      return `Echo: ${msg}`;
    });

    // Send request
    const response = await client.request<string, string>('echo', 'Hello');
    expect(response).toBe('Echo: Hello');
  });
});
```

### Integration Tests (tests/integration/distributed/)

**Test Files**:

1. **nats-connection.test.ts**:
   - Connect to real NATS server
   - Verify pub/sub with actual network
   - Test reconnection on server restart
   - Measure latency

2. **message-roundtrip.test.ts**:
   - Send all message types
   - Verify serialization/deserialization
   - Check schema validation
   - Measure throughput

**Example Integration Test**:

```typescript
// tests/integration/distributed/nats-connection.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NatsClient } from '@/distributed/nats/client.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';

describe('NATS Connection (Integration)', () => {
  let server: EmbeddedNatsServer;
  let client1: NatsClient;
  let client2: NatsClient;

  beforeAll(async () => {
    // Start real NATS server
    server = new EmbeddedNatsServer();
    await server.start({ port: 14222 });

    // Connect two clients
    client1 = new NatsClient();
    client2 = new NatsClient();
    await client1.connect({ mode: 'external', serverUrl: 'nats://localhost:14222' });
    await client2.connect({ mode: 'external', serverUrl: 'nats://localhost:14222' });
  });

  afterAll(async () => {
    await client1.disconnect();
    await client2.disconnect();
    await server.stop();
  });

  it('should route messages between clients', async () => {
    const received: string[] = [];

    // Client 2 subscribes
    await client2.subscribe<string>('test.channel', (msg) => {
      received.push(msg);
    });

    // Client 1 publishes
    await client1.publish('test.channel', 'Message 1');
    await client1.publish('test.channel', 'Message 2');

    // Wait for delivery
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(received).toEqual(['Message 1', 'Message 2']);
  });

  it('should measure message latency', async () => {
    const latencies: number[] = [];

    await client2.reply<string, string>('ping', async (msg) => {
      return 'pong';
    });

    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await client1.request<string, string>('ping', 'ping');
      const end = performance.now();
      latencies.push(end - start);
    }

    const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;
    console.log(`Average NATS latency: ${avgLatency.toFixed(2)}ms`);

    // Assert latency is reasonable (<50ms for local NATS)
    expect(avgLatency).toBeLessThan(50);
  });
});
```

---

## Success Metrics

### Functional Requirements

- ✅ **FR1**: NATS client connects to embedded server in <1s
- ✅ **FR2**: NATS client connects to external server in <1s
- ✅ **FR3**: Publish/subscribe works with type safety
- ✅ **FR4**: Request/reply pattern works with timeout
- ✅ **FR5**: Configuration loader validates YAML correctly
- ✅ **FR6**: All message schemas validate correctly
- ✅ **FR7**: Reconnection works on connection loss

### Performance Requirements

- ✅ **PR1**: Message latency <10ms for local NATS
- ✅ **PR2**: Throughput >10,000 msgs/sec for local NATS
- ✅ **PR3**: Embedded server starts in <2s
- ✅ **PR4**: Configuration loads in <100ms
- ✅ **PR5**: Memory usage <50MB for client

### Quality Requirements

- ✅ **QR1**: Unit test coverage >90%
- ✅ **QR2**: All integration tests pass
- ✅ **QR3**: No TypeScript errors (strict mode)
- ✅ **QR4**: No ESLint errors/warnings
- ✅ **QR5**: Documentation complete for all APIs
- ✅ **QR6**: Error messages are clear and actionable

### Validation Checklist

**End of Week 1**:
- [ ] NATS client connects to embedded server ✅
- [ ] NATS client connects to external server ✅
- [ ] Publish/subscribe works ✅
- [ ] Request/reply works ✅
- [ ] Configuration loader works ✅
- [ ] All message schemas defined ✅
- [ ] Unit tests: >90% coverage ✅
- [ ] Integration tests: All passing ✅
- [ ] TypeScript: 0 errors ✅
- [ ] ESLint: 0 errors/warnings ✅
- [ ] Documentation: Complete ✅
- [ ] Performance benchmarks: Meet targets ✅

---

## Dependencies

### NPM Packages (New)

```json
{
  "dependencies": {
    "nats": "^2.20.0",           // NATS client for Node.js
    "uuid": "^9.0.1",            // UUID generation
    "yaml": "^2.3.4"             // YAML parsing
  },
  "devDependencies": {
    "@types/uuid": "^9.0.7"      // UUID type definitions
  }
}
```

### System Dependencies

1. **nats-server**: NATS server binary
   ```bash
   brew install nats-server
   ```

2. **Node.js 22+**: Already required

3. **TypeScript 5.3+**: Already required

### Internal Dependencies

- `src/core/hardware-detector.ts` (existing)
- `src/types/concurrency.ts` (existing)
- Vitest testing framework (existing)
- Zod validation library (existing)

---

## Risk Assessment

### Technical Risks

**Risk 1: NATS Server Installation**
- **Likelihood**: Medium
- **Impact**: High (blocks Week 1)
- **Mitigation**: Provide installation script, Docker alternative, embedded mode

**Risk 2: NATS Client Learning Curve**
- **Likelihood**: Medium
- **Impact**: Medium (slower development)
- **Mitigation**: Provide code examples, wrapper abstractions, comprehensive docs

**Risk 3: Message Serialization Bugs**
- **Likelihood**: Low
- **Impact**: High (data corruption)
- **Mitigation**: Zod validation on all messages, integration tests, type safety

**Risk 4: Connection Reliability**
- **Likelihood**: Low
- **Impact**: Medium (reconnection needed)
- **Mitigation**: Automatic reconnection, exponential backoff, health monitoring

### Operational Risks

**Risk 5: Configuration Complexity**
- **Likelihood**: Medium
- **Impact**: Low (user confusion)
- **Mitigation**: Sensible defaults, validation errors, documentation

**Risk 6: Performance Bottleneck**
- **Likelihood**: Low
- **Impact**: Medium (high latency)
- **Mitigation**: Performance benchmarks, use embedded NATS for local clusters

---

## Acceptance Criteria

### Definition of Done (Week 1)

A feature is "done" when:
1. ✅ Code written and reviewed
2. ✅ Unit tests written (>90% coverage)
3. ✅ Integration tests written and passing
4. ✅ TypeScript compiles with no errors
5. ✅ ESLint passes with no errors/warnings
6. ✅ Documentation written (JSDoc + markdown)
7. ✅ Performance benchmarks meet targets
8. ✅ Manual testing successful

### Week 1 Deliverables

**Code**:
- [ ] `src/distributed/nats/client.ts` (300+ lines)
- [ ] `src/distributed/nats/embedded-server.ts` (200+ lines)
- [ ] `src/distributed/types/messages.ts` (200+ lines)
- [ ] `src/distributed/types/config.ts` (150+ lines)
- [ ] `src/distributed/config/loader.ts` (150+ lines)
- [ ] `src/distributed/utils/logger.ts` (100+ lines)
- [ ] `src/distributed/utils/errors.ts` (50+ lines)

**Tests**:
- [ ] Unit tests (500+ lines)
- [ ] Integration tests (300+ lines)

**Documentation**:
- [ ] API documentation (JSDoc)
- [ ] Configuration guide (markdown)
- [ ] Quick start guide (markdown)

**Validation**:
- [ ] All tests passing ✅
- [ ] Performance benchmarks complete ✅
- [ ] Manual end-to-end test successful ✅

---

## Appendix

### A. NATS Server Installation Guide

**macOS**:
```bash
brew install nats-server
nats-server --version
```

**Linux**:
```bash
curl -L https://github.com/nats-io/nats-server/releases/latest/download/nats-server-linux-amd64.tar.gz | tar xz
sudo mv nats-server /usr/local/bin/
nats-server --version
```

**Docker**:
```bash
docker pull nats:latest
docker run -p 4222:4222 -p 8222:8222 nats:latest
```

### B. NATS Topics Naming Convention

**Convention**: `<entity>.<action>` or `<entity>.<workerId>.<action>`

**Examples**:
- `worker.register` - Worker registration broadcast
- `worker.heartbeat` - Worker heartbeat broadcast
- `worker.worker-123.inference` - Inference request to specific worker
- `response.req-456` - Response to specific request
- `cluster.announce` - Cluster-wide announcements

### C. Example End-to-End Test

```typescript
// Manual test script: scripts/test-nats.ts
import { NatsClient } from '../src/distributed/nats/client.js';

async function main() {
  console.log('Starting NATS end-to-end test...\n');

  // 1. Connect
  const client = new NatsClient();
  console.log('Connecting to embedded NATS server...');
  await client.connect({ mode: 'embedded' });
  console.log('✅ Connected\n');

  // 2. Pub/Sub
  console.log('Testing pub/sub...');
  let received = false;
  await client.subscribe<string>('test.subject', (msg) => {
    console.log(`✅ Received: ${msg}`);
    received = true;
  });

  await client.publish('test.subject', 'Hello NATS!');
  await new Promise(resolve => setTimeout(resolve, 100));

  if (!received) {
    throw new Error('❌ Message not received');
  }
  console.log('✅ Pub/sub working\n');

  // 3. Request/Reply
  console.log('Testing request/reply...');
  await client.reply<string, string>('echo', async (msg) => {
    return `Echo: ${msg}`;
  });

  const response = await client.request<string, string>('echo', 'Test');
  console.log(`✅ Response: ${response}\n`);

  // 4. Disconnect
  console.log('Disconnecting...');
  await client.disconnect();
  console.log('✅ Disconnected\n');

  console.log('All tests passed! ✅');
}

main().catch(console.error);
```

**Run**:
```bash
npx tsx scripts/test-nats.ts
```

---

**Document Version**: 1.0
**Last Updated**: 2025-11-09
**Author**: Claude Code
**Status**: Ready for Implementation
