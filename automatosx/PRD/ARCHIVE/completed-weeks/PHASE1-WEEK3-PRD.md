# Phase 1 Week 3: Controller Node Implementation - Product Requirements

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 1 - Foundation
**Week**: Week 3 of 13
**Duration**: 5 working days
**Status**: Ready to Start
**Version**: 2.0.0 (Smart Routing Architecture)
**Date**: 2025-11-10

---

## Executive Summary

Week 3 implements the Controller Node, the central coordinator for the distributed inference system. By end of week, we will have a fully functional controller that manages workers, routes requests, and provides a unified API endpoint for clients.

**Goal**: Production-ready Controller Node with worker management and request routing

**Success Criteria**:
- ✅ Controller maintains worker registry (online/offline detection)
- ✅ Controller routes inference requests to workers
- ✅ Controller aggregates streaming responses
- ✅ Round-robin load balancing works
- ✅ REST API endpoint (OpenAI-compatible)
- ✅ WebSocket endpoint for streaming
- ✅ All unit tests passing (>90% coverage)
- ✅ Integration tests with real workers passing
- ✅ Documentation complete

---

## Table of Contents

1. [Background](#background)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Technical Specifications](#technical-specifications)
4. [Architecture](#architecture)
5. [API Design](#api-design)
6. [Controller Lifecycle](#controller-lifecycle)
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

**Week 2 Completed**:
- ✅ Worker Node with registration and heartbeat
- ✅ Inference request handler
- ✅ Token streaming
- ✅ Metrics collection

**Week 3 Focus**: Build Controller Node to orchestrate workers

### Controller Node Role

The Controller Node is responsible for:
1. **Worker Registry**: Maintain list of available workers with their model capabilities (skills)
2. **Worker Discovery**: Accept worker registrations (workers discover and register with controller)
3. **Health Monitoring**: Track worker heartbeats, mark offline workers
4. **Smart Request Routing**: Select worker based on:
   - **Skills**: Which models the worker can serve (from local model folder)
   - **Hardware**: Worker's hardware capabilities (GPU memory, cores, etc.)
   - **Load**: Current worker utilization and active requests
5. **Response Aggregation**: Forward streaming responses to clients
6. **API Gateway**: Provide unified REST/WebSocket endpoint
7. **Cluster Coordination**: Broadcast cluster-wide messages

---

## Goals and Non-Goals

### Goals (Week 3)

✅ **Must Have (P0)**:
1. Controller Node class with lifecycle management
2. Worker registry (add/remove/update workers with skills)
3. Worker discovery via NATS (workers self-register with model skills)
4. Heartbeat monitoring (subscribe to worker.heartbeat)
5. Offline detection (mark workers offline after timeout)
6. Smart request routing (skills + hardware + load aware)
7. Response streaming (forward tokens from worker to client)
8. Smart load balancing (filter by skills, hardware, load)
9. REST API endpoint (POST /v1/chat/completions)
10. WebSocket endpoint for streaming
11. Comprehensive tests (unit + integration)

✅ **Should Have (P1)**:
1. Cluster status endpoint (GET /api/cluster/status)
2. Worker list endpoint (GET /api/cluster/workers)
3. Worker details endpoint (GET /api/cluster/workers/:id)
4. Request timeout handling
5. Error handling and graceful degradation
6. Graceful shutdown (wait for active requests)
7. Worker capability query endpoints

✅ **Nice to Have (P2)**:
1. Worker priority support
2. Worker tagging (production, development)
3. Request queueing
4. Rate limiting
5. CORS support
6. API key authentication

### Non-Goals (Week 3)

❌ **Out of Scope**:
1. Sticky sessions (Phase 2)
2. Advanced model pre-loading strategies (Phase 2)
3. Web dashboard (Phase 3)
4. Prometheus metrics (Phase 4)
5. Production deployment (Phase 4)
6. Multi-controller coordination (Future)
7. Auto-scaling workers (Future)

---

## Technical Specifications

### Controller Node Requirements

#### 1. Worker Registry

**Requirements**:
- Store worker information (id, hostname, IP, hardware, capabilities)
- Track worker status (online, offline, degraded)
- Track last heartbeat timestamp
- Track worker metrics (CPU, GPU, memory, active requests)
- Support adding/removing/updating workers

**Data Structure**:
```typescript
interface WorkerInfo {
  workerId: string;
  hostname: string;
  ip: string;
  port: number;
  hardware: HardwareProfile;
  capabilities: WorkerCapabilities;
  skills: ModelSkills;  // NEW: Which models this worker can serve
  status: 'online' | 'offline' | 'degraded';
  metrics?: WorkerMetrics;
  lastHeartbeat: number;
  registeredAt: number;
  priority?: number;
  tags?: string[];
}

interface ModelSkills {
  // Models discovered from worker's local "model" folder
  availableModels: string[];  // e.g., ["mlx-community/Llama-3.2-3B-Instruct-4bit"]
  modelPaths: Record<string, string>;  // model name → local path
  totalModelSize: number;  // Total size in bytes
  lastScanned: number;  // Timestamp of last model folder scan
}

class WorkerRegistry {
  private workers: Map<string, WorkerInfo>;

  addWorker(registration: WorkerRegistration): void;
  updateWorker(heartbeat: WorkerHeartbeat): void;
  removeWorker(workerId: string): void;
  getWorker(workerId: string): WorkerInfo | undefined;
  getAllWorkers(): WorkerInfo[];
  getOnlineWorkers(): WorkerInfo[];
  getOfflineWorkers(): WorkerInfo[];
  markOffline(workerId: string): void;
}
```

**API**:
```typescript
class ControllerNode {
  private workerRegistry: WorkerRegistry;

  // Worker management
  private handleWorkerRegistration(msg: WorkerRegistration): void;
  private handleWorkerHeartbeat(msg: WorkerHeartbeat): void;
  private detectOfflineWorkers(): void;

  // Query methods
  getWorkerCount(): number;
  getOnlineWorkerCount(): number;
  getWorker(workerId: string): WorkerInfo | undefined;
  getAllWorkers(): WorkerInfo[];
}
```

#### 2. Worker Discovery (Worker-Initiated)

**Architecture**: Workers discover and register with the controller (not the other way around)

**Requirements**:
- Controller subscribes to `worker.register` NATS topic
- Controller subscribes to `worker.heartbeat` NATS topic
- Workers find controller via config (controller IP address)
- Workers scan local "model" folder to discover available models
- Workers announce skills (available models) during registration
- Controller processes registration and adds to registry with skills
- Controller updates worker metrics from heartbeat messages

**Worker Registration Flow**:
```
1. Worker starts → reads controller IP from config
2. Worker scans local "model" folder → discovers available models
3. Worker connects to NATS
4. Worker publishes to "worker.register" with:
   - Worker ID, hostname, IP, hardware
   - Skills: { availableModels: [...], modelPaths: {...} }
5. Controller receives registration → adds to registry with skills
```

**NATS Topics**:
- `worker.register` - Worker registration (includes model skills)
- `worker.heartbeat` - Worker heartbeat (includes metrics + load)

**API**:
```typescript
class ControllerNode {
  private async subscribeToWorkerEvents(): Promise<void>;
  private handleWorkerRegistration(msg: WorkerRegistration): void;
  private handleWorkerHeartbeat(msg: WorkerHeartbeat): void;
}
```

#### 3. Health Monitoring

**Requirements**:
- Check worker heartbeats every 5 seconds
- Mark workers offline after 15 seconds (3 missed heartbeats)
- Broadcast worker status changes
- Support manual health checks

**API**:
```typescript
class ControllerNode {
  private startHealthMonitoring(): void;
  private stopHealthMonitoring(): void;
  private detectOfflineWorkers(): void;
  private checkWorkerHealth(workerId: string): Promise<boolean>;
}
```

#### 4. Request Routing

**Requirements**:
- Accept inference requests from clients
- Select worker using load balancing strategy
- Forward request to worker via NATS
- Subscribe to response stream
- Forward tokens to client
- Handle worker failures (retry on another worker)

**Message Flow**:
```
Client → Controller (HTTP/WS)
Controller → Worker (NATS: worker.{id}.inference)
Worker → Controller (NATS: response.{requestId})
Controller → Client (HTTP/WS streaming)
```

**API**:
```typescript
class ControllerNode {
  async handleInferenceRequest(req: InferenceRequest): Promise<ReadableStream>;
  private selectWorker(request: InferenceRequest): WorkerInfo;
  private forwardRequest(worker: WorkerInfo, request: InferenceRequest): Promise<void>;
  private subscribeToResponse(requestId: string): Promise<ReadableStream>;
}
```

#### 5. Smart Load Balancing (Skills + Hardware + Load)

**Requirements**:
- **Phase 1**: Filter workers by skills (which models they can serve)
- **Phase 2**: Consider hardware capabilities (GPU memory, cores)
- **Phase 3**: Consider current load (active requests, utilization)
- Fall back to round-robin among eligible workers
- Skip offline workers
- Handle case when no workers have required skills

**3-Phase Selection Algorithm**:
```typescript
class SmartLoadBalancer {
  private currentIndex = 0;

  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    const onlineWorkers = workers.filter(w => w.status === 'online');

    if (onlineWorkers.length === 0) {
      throw new Error('No workers available');
    }

    // Phase 1: Filter by skills (can serve this model?)
    const skilledWorkers = onlineWorkers.filter(w =>
      w.skills.availableModels.includes(request.model)
    );

    if (skilledWorkers.length === 0) {
      throw new Error(`No workers can serve model: ${request.model}`);
    }

    // Phase 2: Filter by hardware (enough GPU memory?)
    const capableWorkers = skilledWorkers.filter(w => {
      // Check if worker has enough GPU memory for this model
      const estimatedMemory = this.estimateModelMemory(request.model);
      return w.hardware.gpuMemoryGB >= estimatedMemory;
    });

    const eligibleWorkers = capableWorkers.length > 0
      ? capableWorkers
      : skilledWorkers;

    // Phase 3: Sort by load (prefer less loaded workers)
    const sortedByLoad = eligibleWorkers.sort((a, b) => {
      const loadA = a.metrics?.requests.active || 0;
      const loadB = b.metrics?.requests.active || 0;
      return loadA - loadB;
    });

    // Select least loaded worker (or round-robin among tied workers)
    const minLoad = sortedByLoad[0].metrics?.requests.active || 0;
    const leastLoadedWorkers = sortedByLoad.filter(w =>
      (w.metrics?.requests.active || 0) === minLoad
    );

    // Round-robin among least loaded workers
    const selected = leastLoadedWorkers[this.currentIndex % leastLoadedWorkers.length];
    this.currentIndex++;

    return selected;
  }

  private estimateModelMemory(modelName: string): number {
    // Rough estimates based on model size
    if (modelName.includes('3B')) return 4;
    if (modelName.includes('7B')) return 8;
    if (modelName.includes('13B')) return 16;
    if (modelName.includes('30B')) return 32;
    return 8; // Default
  }
}
```

**Selection Priority**:
1. ✅ **Skills**: Worker must have the requested model
2. ✅ **Hardware**: Worker should have enough GPU memory (preferred)
3. ✅ **Load**: Prefer worker with fewer active requests
4. ✅ **Round-robin**: Break ties with round-robin

#### 6. REST API (OpenAI-Compatible)

**Requirements**:
- POST /v1/chat/completions (OpenAI-compatible)
- GET /api/cluster/status (cluster information)
- GET /api/cluster/workers (list all workers)
- GET /api/cluster/workers/:id (worker details)
- GET /health (health check)
- Support streaming responses (SSE format)

**Endpoint Specifications**:

**POST /v1/chat/completions**:
```typescript
// Request
{
  "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
  "messages": [
    { "role": "user", "content": "Hello, how are you?" }
  ],
  "max_tokens": 100,
  "temperature": 0.7,
  "stream": true
}

// Response (streaming)
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":"!"}}]}
...
data: [DONE]
```

**GET /api/cluster/status**:
```typescript
{
  "controller": {
    "version": "0.13.0",
    "uptime": 86400000,
    "mode": "controller"
  },
  "workers": {
    "total": 3,
    "online": 3,
    "offline": 0
  },
  "requests": {
    "active": 5,
    "total": 1234,
    "successRate": 0.998
  }
}
```

**GET /api/cluster/workers**:
```typescript
[
  {
    "workerId": "worker-123",
    "hostname": "mac-studio-1",
    "ip": "192.168.1.101",
    "status": "online",
    "hardware": { ... },
    "metrics": { ... }
  },
  ...
]
```

#### 7. WebSocket Endpoint

**Requirements**:
- Support WebSocket connections for streaming
- Handle multiple concurrent connections
- Stream tokens in real-time
- Support connection keep-alive

**WebSocket Protocol**:
```typescript
// Client sends
{
  "type": "inference",
  "data": {
    "model": "...",
    "prompt": "...",
    "maxTokens": 100
  }
}

// Server sends
{ "type": "token", "data": { "token": "Hello", "index": 0 } }
{ "type": "token", "data": { "token": " world", "index": 1 } }
{ "type": "done", "data": { "totalTokens": 10, "latencyMs": 2000 } }
```

---

## Architecture

### File Structure (Week 3)

```
src/distributed/
├── controller/
│   ├── controller-node.ts       # Main Controller Node class (P0)
│   ├── worker-registry.ts       # Worker management (P0)
│   ├── api-server.ts            # REST API server (P0)
│   ├── ws-server.ts             # WebSocket server (P1)
│   └── load-balancers/
│       └── smart-load-balancer.ts  # Smart balancer (skills + hardware + load) (P0)
│
├── worker/                       # From Week 2
│   ├── worker-node.ts
│   ├── metrics-collector.ts
│   └── hardware-reporter.ts
│
├── nats/                         # From Week 1
│   ├── client.ts
│   └── ...
│
├── types/                        # From Week 1
│   ├── messages.ts
│   ├── config.ts
│   └── index.ts
│
└── index.ts

scripts/
├── start-controller.ts          # Controller startup script (P0)
├── start-worker.ts              # From Week 2
└── test-cluster.ts              # Manual cluster testing (P1)

tests/
├── unit/
│   └── distributed/
│       ├── controller-node.test.ts
│       ├── worker-registry.test.ts
│       ├── smart-load-balancer.test.ts
│       └── api-server.test.ts
│
└── integration/
    └── distributed/
        ├── controller-worker.test.ts    # Controller + Worker
        ├── request-routing.test.ts      # Full routing flow
        └── cluster-e2e.test.ts          # End-to-end cluster
```

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ HTTP Client / WebSocket Client                         │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ HTTP/WS
┌─────────────────────────────────────────────────────────────┐
│                      Controller Node                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ API Server (Express.js)                                │  │
│  │ - POST /v1/chat/completions                            │  │
│  │ - GET /api/cluster/status                              │  │
│  │ - WebSocket /ws                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Request Router                                         │  │
│  │ 1. Select Worker (Round-robin)                         │  │
│  │ 2. Forward Request via NATS                            │  │
│  │ 3. Subscribe to Response                               │  │
│  │ 4. Stream to Client                                    │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Worker Registry                                        │  │
│  │ Workers: Map<workerId, WorkerInfo>                     │  │
│  │ - worker-1: online (M3 Max, 3 active)                 │  │
│  │ - worker-2: online (M4 Pro, 1 active)                 │  │
│  │ - worker-3: offline (timeout)                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ NATS Client                                            │  │
│  │ Subscribe: worker.register, worker.heartbeat           │  │
│  │ Publish: worker.{id}.inference                         │  │
│  │ Subscribe: response.{requestId}                        │  │
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
│  │  (M3 Max)    │  │  (M4 Pro)    │  │  (M4 Base)   │      │
│  │  Online      │  │  Online      │  │  Offline     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### Controller Lifecycle State Machine

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
│REGISTERING│ ← Load static workers, subscribe to events
└──────────┘
     │
     │ registered
     ▼
┌──────────┐
│  STARTING│ ← Start API server, health monitoring
└──────────┘
     │
     │ ready
     ▼
┌──────────┐
│  READY   │ ← Accept requests, route to workers
└──────────┘
     │
     │ stop()
     ▼
┌──────────┐
│ DRAINING │ ← Wait for active requests (max 30s)
└──────────┘
     │
     │ drained
     ▼
┌──────────┐
│ STOPPING │ ← Stop API server, disconnect NATS
└──────────┘
     │
     │ stopped
     ▼
┌──────────┐
│ STOPPED  │
└──────────┘
```

---

## API Design

### ControllerNode Class

```typescript
import { NatsClient } from '@/distributed/nats/client.js';
import { WorkerRegistry } from './worker-registry.js';
import { SmartLoadBalancer } from './load-balancers/smart-load-balancer.js';
import { ApiServer } from './api-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import type { WorkerRegistration, WorkerHeartbeat, InferenceRequest } from '@/distributed/types/messages.js';

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

export interface ControllerNodeOptions {
  config: ClusterConfig;
}

export class ControllerNode {
  private state: ControllerState;
  private nats: NatsClient;
  private workerRegistry: WorkerRegistry;
  private loadBalancer: LoadBalancer;
  private apiServer: ApiServer;
  private config: ClusterConfig;
  private healthCheckInterval?: NodeJS.Timeout;
  private activeRequests: Map<string, ActiveRequest>;

  constructor(options: ControllerNodeOptions);

  // Lifecycle
  async start(): Promise<void>;
  async stop(): Promise<void>;
  getState(): ControllerState;

  // Worker Management
  private async subscribeToWorkerEvents(): Promise<void>;
  private handleWorkerRegistration(msg: WorkerRegistration): void;
  private handleWorkerHeartbeat(msg: WorkerHeartbeat): void;
  private startHealthMonitoring(): void;
  private stopHealthMonitoring(): void;
  private detectOfflineWorkers(): void;

  // Request Routing
  async handleInferenceRequest(req: InferenceRequest): Promise<ReadableStream>;
  private selectWorker(request: InferenceRequest): WorkerInfo;
  private forwardRequest(worker: WorkerInfo, request: InferenceRequest): Promise<void>;
  private subscribeToResponse(requestId: string): Promise<ReadableStream>;

  // Query Methods
  getWorkerCount(): number;
  getOnlineWorkerCount(): number;
  getWorker(workerId: string): WorkerInfo | undefined;
  getAllWorkers(): WorkerInfo[];
  getClusterStatus(): ClusterStatus;
}
```

### WorkerRegistry Class

```typescript
export interface WorkerInfo {
  workerId: string;
  hostname: string;
  ip: string;
  port: number;
  hardware: HardwareProfile;
  capabilities: WorkerCapabilities;
  skills: ModelSkills;  // NEW: Which models this worker can serve
  status: 'online' | 'offline' | 'degraded';
  metrics?: WorkerMetrics;
  lastHeartbeat: number;
  registeredAt: number;
  priority?: number;
  tags?: string[];
}

export interface ModelSkills {
  availableModels: string[];
  modelPaths: Record<string, string>;
  totalModelSize: number;
  lastScanned: number;
}

export class WorkerRegistry {
  private workers: Map<string, WorkerInfo>;
  private logger: Logger;

  constructor();

  // Worker management
  addWorker(registration: WorkerRegistration): void;
  updateWorker(heartbeat: WorkerHeartbeat): void;
  removeWorker(workerId: string): void;
  markOffline(workerId: string): void;

  // Query methods
  getWorker(workerId: string): WorkerInfo | undefined;
  getAllWorkers(): WorkerInfo[];
  getOnlineWorkers(): WorkerInfo[];
  getOfflineWorkers(): WorkerInfo[];
  getWorkerCount(): number;
  getOnlineWorkerCount(): number;
  hasWorker(workerId: string): boolean;

  // Utilities
  clear(): void;
}
```

### SmartLoadBalancer Class (Skills + Hardware + Load Aware)

```typescript
export interface LoadBalancer {
  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo;
}

export class SmartLoadBalancer implements LoadBalancer {
  private currentIndex = 0;

  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    const onlineWorkers = workers.filter(w => w.status === 'online');

    if (onlineWorkers.length === 0) {
      throw new Error('No online workers available');
    }

    // Phase 1: Filter by skills (can serve this model?)
    const skilledWorkers = onlineWorkers.filter(w =>
      w.skills.availableModels.includes(request.model)
    );

    if (skilledWorkers.length === 0) {
      throw new Error(`No workers can serve model: ${request.model}`);
    }

    // Phase 2: Filter by hardware (enough GPU memory?)
    const capableWorkers = skilledWorkers.filter(w => {
      const estimatedMemory = this.estimateModelMemory(request.model);
      return w.hardware.gpuMemoryGB >= estimatedMemory;
    });

    const eligibleWorkers = capableWorkers.length > 0
      ? capableWorkers
      : skilledWorkers;

    // Phase 3: Sort by load (prefer less loaded workers)
    const sortedByLoad = eligibleWorkers.sort((a, b) => {
      const loadA = a.metrics?.requests.active || 0;
      const loadB = b.metrics?.requests.active || 0;
      return loadA - loadB;
    });

    // Select least loaded worker (round-robin among tied)
    const minLoad = sortedByLoad[0].metrics?.requests.active || 0;
    const leastLoadedWorkers = sortedByLoad.filter(w =>
      (w.metrics?.requests.active || 0) === minLoad
    );

    const selected = leastLoadedWorkers[this.currentIndex % leastLoadedWorkers.length];
    this.currentIndex++;

    return selected;
  }

  private estimateModelMemory(modelName: string): number {
    if (modelName.includes('3B')) return 4;
    if (modelName.includes('7B')) return 8;
    if (modelName.includes('13B')) return 16;
    if (modelName.includes('30B')) return 32;
    return 8;
  }

  reset(): void {
    this.currentIndex = 0;
  }
}
```

### ApiServer Class

```typescript
import express, { Application } from 'express';
import { ControllerNode } from './controller-node.js';

export class ApiServer {
  private app: Application;
  private controller: ControllerNode;
  private server?: any;

  constructor(controller: ControllerNode, config: ClusterConfig);

  async start(): Promise<void>;
  async stop(): Promise<void>;
  isRunning(): boolean;

  private setupRoutes(): void;
  private handleChatCompletions(req: express.Request, res: express.Response): Promise<void>;
  private handleClusterStatus(req: express.Request, res: express.Response): void;
  private handleWorkersList(req: express.Request, res: express.Response): void;
  private handleWorkerDetails(req: express.Request, res: express.Response): void;
}
```

---

## Controller Lifecycle

### Startup Sequence

```typescript
// scripts/start-controller.ts
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { loadClusterConfig } from '@/distributed/config/loader.js';

async function main() {
  // 1. Load configuration
  const config = await loadClusterConfig('config/cluster.yaml');

  // 2. Create controller instance
  const controller = new ControllerNode({ config });

  // 3. Start controller (async)
  await controller.start();
  // ↓
  // - Connect to NATS
  // - Subscribe to worker events (register, heartbeat)
  // - Workers will discover and register themselves
  // - Start health monitoring
  // - Start API server
  // ↓
  // Controller is now READY

  console.log('Controller is ready');
  console.log(`API: http://localhost:${config.cluster.controller.port}`);

  // 4. Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down...');
    await controller.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

### Shutdown Sequence

```typescript
async stop(): Promise<void> {
  this.logger.info('Stopping controller');
  this.state = ControllerState.DRAINING;

  // 1. Stop accepting new requests
  this.stopHealthMonitoring();

  // 2. Wait for active requests to complete (max 30s)
  const maxWait = 30000;
  const startTime = Date.now();

  while (this.activeRequests.size > 0 && Date.now() - startTime < maxWait) {
    this.logger.info(`Waiting for ${this.activeRequests.size} active requests to complete`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (this.activeRequests.size > 0) {
    this.logger.warn(`Force shutdown with ${this.activeRequests.size} requests still active`);
  }

  // 3. Stop API server
  this.state = ControllerState.STOPPING;
  await this.apiServer.stop();

  // 4. Disconnect from NATS
  await this.nats.disconnect();

  // 5. Cleanup
  this.state = ControllerState.STOPPED;
  this.logger.info('Controller stopped');
}
```

---

## Testing Strategy

### Unit Tests (tests/unit/distributed/)

**Coverage Target**: >90%

**Test Files**:

1. **controller-node.test.ts**:
   - Controller lifecycle (start/stop)
   - State transitions
   - Worker event handling
   - Request routing
   - Error handling

2. **worker-registry.test.ts**:
   - Add/remove/update workers
   - Worker status tracking
   - Online/offline detection
   - Query methods

3. **smart-load-balancer.test.ts**:
   - Worker selection by skills
   - Hardware-based filtering (GPU memory)
   - Load-based selection (prefer less loaded)
   - Round-robin among tied workers
   - Edge cases (no workers, no skilled workers)

4. **api-server.test.ts**:
   - Route handling
   - Request validation
   - Response formatting
   - Error responses

### Integration Tests (tests/integration/distributed/)

**Test Files**:

1. **controller-worker.test.ts**:
   - Controller + 1 Worker
   - Worker registration
   - Heartbeat monitoring
   - Offline detection

2. **request-routing.test.ts**:
   - Full request routing flow
   - Controller → Worker → Response
   - Token streaming
   - Error handling

3. **cluster-e2e.test.ts**:
   - Complete cluster (Controller + 3 Workers)
   - Round-robin distribution
   - Worker failure handling
   - Load balancing verification

**Example Integration Test**:

```typescript
// tests/integration/distributed/cluster-e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import fetch from 'node-fetch';

describe('Cluster End-to-End', () => {
  let controller: ControllerNode;
  let workers: WorkerNode[];

  beforeAll(async () => {
    // Start controller
    controller = new ControllerNode({
      config: await loadClusterConfig('config/cluster.yaml'),
    });
    await controller.start();

    // Start 3 workers
    workers = [];
    for (let i = 0; i < 3; i++) {
      const worker = new WorkerNode({
        config: await loadClusterConfig('config/cluster.yaml'),
      });
      await worker.start();
      workers.push(worker);
    }

    // Wait for workers to register
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    for (const worker of workers) {
      await worker.stop();
    }
    await controller.stop();
  });

  it('should route requests to workers based on skills', async () => {
    // Send 6 requests for a model that all workers can serve
    const promises = [];
    for (let i = 0; i < 6; i++) {
      const promise = fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
          messages: [{ role: 'user', content: `Request ${i}` }],
          max_tokens: 5,
          stream: false,
        }),
      });
      promises.push(promise);
    }

    const responses = await Promise.all(promises);

    // Verify all succeeded
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    // Verify smart distribution
    // Workers with the required model should have handled requests
    const workers = controller.getAllWorkers();
    const skilledWorkers = workers.filter(w =>
      w.skills.availableModels.includes('mlx-community/Llama-3.2-3B-Instruct-4bit')
    );

    for (const worker of skilledWorkers) {
      // Should have processed some requests
      expect(worker.metrics?.requests.total).toBeGreaterThan(0);
    }
  });

  it('should reject requests when no worker has required model', async () => {
    // Send request for model that no worker has
    const response = await fetch('http://localhost:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mlx-community/NonExistentModel-70B',
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5,
        stream: false,
      }),
    });

    expect(response.status).toBe(503); // Service Unavailable
  });

  it('should handle worker failure gracefully', async () => {
    // Stop one worker
    await workers[0].stop();

    // Wait for offline detection
    await new Promise(resolve => setTimeout(resolve, 20000)); // >15s timeout

    // Send request (should route to remaining 2 workers)
    const response = await fetch('http://localhost:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5,
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
  });
});
```

---

## Success Metrics

### Functional Requirements

- ✅ **FR1**: Controller maintains worker registry
- ✅ **FR2**: Controller detects online/offline workers
- ✅ **FR3**: Controller routes requests to workers based on skills
- ✅ **FR4**: Smart load balancing works (skills + hardware + load)
- ✅ **FR5**: Streaming responses work
- ✅ **FR6**: REST API works (OpenAI-compatible)
- ✅ **FR7**: Controller shuts down gracefully

### Performance Requirements

- ✅ **PR1**: Worker registration processed in <100ms
- ✅ **PR2**: Request routing overhead <50ms
- ✅ **PR3**: Offline detection within 15s
- ✅ **PR4**: Supports 100+ concurrent requests
- ✅ **PR5**: API response time <100ms (excluding inference)

### Quality Requirements

- ✅ **QR1**: Unit test coverage >90%
- ✅ **QR2**: All integration tests pass
- ✅ **QR3**: No TypeScript errors (strict mode)
- ✅ **QR4**: No ESLint errors/warnings
- ✅ **QR5**: Documentation complete
- ✅ **QR6**: Graceful error handling

### Validation Checklist

**End of Week 3**:
- [ ] Controller registers workers with skills ✅
- [ ] Health monitoring works ✅
- [ ] Smart request routing works (skills + hardware + load) ✅
- [ ] Model capability filtering works ✅
- [ ] REST API works ✅
- [ ] Streaming works ✅
- [ ] Unit tests: >90% coverage ✅
- [ ] Integration tests: All passing ✅
- [ ] TypeScript: 0 errors ✅
- [ ] ESLint: 0 errors/warnings ✅
- [ ] Documentation: Complete ✅

---

## Dependencies

### Internal Dependencies (from Week 1-2)

- `src/distributed/nats/client.ts` - NATS client
- `src/distributed/types/messages.ts` - Message schemas
- `src/distributed/config/loader.ts` - Configuration
- `src/distributed/utils/logger.ts` - Logging
- `src/distributed/utils/errors.ts` - Errors
- `src/distributed/worker/worker-node.ts` - Worker (for testing)

### External Dependencies

- `express` - HTTP server
- `ws` - WebSocket server
- `cors` - CORS middleware
- `nats` - NATS client (from Week 1)
- `uuid` - UUID generation (from Week 1)

### New Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/cors": "^2.8.17",
    "node-fetch": "^3.3.2"
  }
}
```

---

## Risk Assessment

### Technical Risks

**Risk 1: Worker Registry Synchronization**
- **Likelihood**: Medium
- **Impact**: High (stale worker info)
- **Mitigation**: Heartbeat monitoring, offline detection, registry updates

**Risk 2: Request Routing Failures**
- **Likelihood**: Medium
- **Impact**: High (requests fail)
- **Mitigation**: Retry logic, worker selection fallback, error handling

**Risk 3: Streaming Response Complexity**
- **Likelihood**: Medium
- **Impact**: Medium (broken streams)
- **Mitigation**: NATS reliable messaging, timeout handling, client disconnect detection

**Risk 4: Concurrent Request Handling**
- **Likelihood**: Low
- **Impact**: Medium (performance degradation)
- **Mitigation**: Async/await patterns, backpressure handling, benchmarks

### Operational Risks

**Risk 5: API Server Crashes**
- **Likelihood**: Low
- **Impact**: High (cluster unavailable)
- **Mitigation**: Error handling, health checks, graceful shutdown

**Risk 6: NATS Connection Loss**
- **Likelihood**: Low
- **Impact**: High (cluster unusable)
- **Mitigation**: Reconnection logic, connection monitoring, fallback

---

## Acceptance Criteria

### Definition of Done (Week 3)

A feature is "done" when:
1. ✅ Code written and reviewed
2. ✅ Unit tests written (>90% coverage)
3. ✅ Integration tests written and passing
4. ✅ TypeScript compiles with no errors
5. ✅ ESLint passes with no errors/warnings
6. ✅ Documentation written (JSDoc + markdown)
7. ✅ Manual testing successful
8. ✅ Performance targets met

### Week 3 Deliverables

**Code**:
- [ ] `src/distributed/controller/controller-node.ts` (600+ lines)
- [ ] `src/distributed/controller/worker-registry.ts` (250+ lines)
- [ ] `src/distributed/controller/api-server.ts` (400+ lines)
- [ ] `src/distributed/controller/load-balancers/smart-load-balancer.ts` (100+ lines)
- [ ] `scripts/start-controller.ts` (100+ lines)

**Tests**:
- [ ] Unit tests (700+ lines)
- [ ] Integration tests (500+ lines)

**Documentation**:
- [ ] Controller API documentation (JSDoc)
- [ ] REST API documentation (OpenAPI spec)
- [ ] Cluster setup guide (markdown)

**Validation**:
- [ ] All tests passing ✅
- [ ] Manual cluster test successful ✅
- [ ] Performance benchmarks complete ✅

---

## Appendix

### A. Controller Configuration Example

```yaml
# config/cluster.yaml
cluster:
  mode: controller  # or "worker" or "both"

  controller:
    enabled: false  # Default: disabled (set to true to enable controller mode)
    bind_address: "0.0.0.0"
    port: 8080
    dashboard_port: 8081  # Future use
    api:
      cors_enabled: true
      cors_origins: ["*"]
      rate_limit:
        enabled: false  # Not implemented in Week 3

  nats:
    mode: external
    server_url: "nats://localhost:4222"

  discovery:
    enabled: true
    heartbeat_interval_ms: 5000
    offline_timeout_ms: 15000
    controller_ip: "192.168.1.100"  # Workers use this to find controller

  load_balancing:
    strategy: "smart"  # Skills + Hardware + Load aware
    fallback_strategy: "round_robin"

# Example Worker Configuration
# Workers read controller_ip from config and register themselves
# Workers scan local "model" folder to discover available models
# No need to pre-configure worker IPs in controller config
```

### B. OpenAPI Specification

```yaml
openapi: 3.0.0
info:
  title: mlx-serving Distributed Inference API
  version: 0.13.0
paths:
  /v1/chat/completions:
    post:
      summary: Create chat completion
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                model:
                  type: string
                messages:
                  type: array
                  items:
                    type: object
                    properties:
                      role:
                        type: string
                      content:
                        type: string
                max_tokens:
                  type: integer
                temperature:
                  type: number
                stream:
                  type: boolean
      responses:
        '200':
          description: Successful response
          content:
            text/event-stream:
              schema:
                type: string

  /api/cluster/status:
    get:
      summary: Get cluster status
      responses:
        '200':
          description: Cluster status
          content:
            application/json:
              schema:
                type: object

  /api/cluster/workers:
    get:
      summary: List all workers
      responses:
        '200':
          description: List of workers
          content:
            application/json:
              schema:
                type: array
```

### C. Manual Testing Script

```bash
# scripts/test-cluster.sh

# 1. Start NATS server
echo "Starting NATS server..."
nats-server --port 4222 --http_port 8222 &
NATS_PID=$!
sleep 2

# 2. Start controller
echo "Starting controller..."
npx tsx scripts/start-controller.ts &
CONTROLLER_PID=$!
sleep 2

# 3. Start 3 workers
echo "Starting workers..."
npx tsx scripts/start-worker.ts &
WORKER1_PID=$!
sleep 1

npx tsx scripts/start-worker.ts &
WORKER2_PID=$!
sleep 1

npx tsx scripts/start-worker.ts &
WORKER3_PID=$!
sleep 2

# 4. Check cluster status
echo "Checking cluster status..."
curl http://localhost:8080/api/cluster/status | jq .

# 5. Send test request
echo "Sending test request..."
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 10,
    "stream": true
  }'

# 6. Cleanup
echo "Cleaning up..."
kill $WORKER3_PID $WORKER2_PID $WORKER1_PID $CONTROLLER_PID $NATS_PID
```

---

**Document Version**: 2.0 (Updated with Smart Routing Architecture)
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready for Implementation

**Changelog v2.0**:
- ✅ Added worker skill-based routing (workers announce available models)
- ✅ Replaced round-robin with smart load balancer (skills + hardware + load)
- ✅ Workers discover controller (no static worker configuration needed)
- ✅ Controller enable/disable flag in config (default: disabled)
- ✅ Workers scan local "model" folder to determine capabilities
- ✅ Smart routing considers GPU memory and worker load
