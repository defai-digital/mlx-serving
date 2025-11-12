# Implementation Action Plan: mlx-serving Distributed Inference

**Status**: Ready for Implementation
**Version**: 1.0.0
**Date**: 2025-11-09
**Estimated Duration**: 11-13 weeks
**Dependencies**: [DISTRIBUTED-INFERENCE-PRD.md](./DISTRIBUTED-INFERENCE-PRD.md)

---

## Overview

This action plan provides step-by-step implementation guidance for building the mlx-serving distributed inference system. It breaks down the 5 phases from the PRD into concrete, actionable tasks with time estimates and validation criteria.

---

## Phase 1: Foundation (Weeks 1-3)

**Goal**: Basic controller/worker architecture with NATS messaging

### Task 1.1: NATS Integration (4 days)

**Files to create**:
- `src/distributed/nats-client.ts` - NATS client wrapper
- `src/distributed/types.ts` - Message types and interfaces
- `src/distributed/config-loader.ts` - Cluster config parsing

**Implementation**:

```typescript
// src/distributed/nats-client.ts
import { connect, NatsConnection, StringCodec, JSONCodec, Subscription } from 'nats';
import { ClusterConfig } from './types.js';

export class NatsClient {
  private nc?: NatsConnection;
  private sc = StringCodec();
  private jc = JSONCodec();

  async connect(config: ClusterConfig['nats']): Promise<void> {
    try {
      if (config.embedded) {
        // Start embedded NATS server
        await this.startEmbeddedNats();
        this.nc = await connect({ servers: 'localhost:4222' });
      } else {
        // Connect to external NATS server
        this.nc = await connect({
          servers: config.server_url,
          user: config.user,
          pass: config.password,
          name: config.cluster_name,
        });
      }

      console.log(`Connected to NATS: ${this.nc.getServer()}`);
    } catch (error) {
      console.error('Failed to connect to NATS:', error);
      throw error;
    }
  }

  async publish<T>(subject: string, data: T): Promise<void> {
    if (!this.nc) throw new Error('Not connected to NATS');
    await this.nc.publish(subject, this.jc.encode(data));
  }

  async subscribe<T>(subject: string, callback: (data: T) => void | Promise<void>): Promise<Subscription> {
    if (!this.nc) throw new Error('Not connected to NATS');

    const sub = this.nc.subscribe(subject);

    (async () => {
      for await (const msg of sub) {
        try {
          const data = this.jc.decode(msg.data) as T;
          await callback(data);
        } catch (error) {
          console.error(`Error processing message on ${subject}:`, error);
        }
      }
    })();

    return sub;
  }

  async request<Req, Res>(subject: string, data: Req, timeout = 5000): Promise<Res> {
    if (!this.nc) throw new Error('Not connected to NATS');

    const msg = await this.nc.request(subject, this.jc.encode(data), { timeout });
    return this.jc.decode(msg.data) as Res;
  }

  async close(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      this.nc = undefined;
    }
  }

  private async startEmbeddedNats(): Promise<void> {
    // Use nats-server binary or nats.js embedded server
    const { spawn } = await import('child_process');
    const natsProcess = spawn('nats-server', [
      '--port', '4222',
      '--http_port', '8222',
    ]);

    natsProcess.stdout?.on('data', (data) => {
      console.log(`NATS: ${data}`);
    });

    natsProcess.stderr?.on('data', (data) => {
      console.error(`NATS Error: ${data}`);
    });

    // Wait for NATS to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
```

**Validation**:
```bash
# Test NATS connection
npx tsx src/distributed/test-nats.ts

# Expected output:
# ✅ Connected to NATS: localhost:4222
# ✅ Published test message
# ✅ Received test message
```

---

### Task 1.2: Worker Node Implementation (5 days)

**Files to create**:
- `src/distributed/worker-node.ts` - Worker implementation
- `src/distributed/hardware-reporter.ts` - Hardware detection wrapper
- `scripts/start-worker.ts` - Worker startup script

**Implementation**:

```typescript
// src/distributed/worker-node.ts
import { NatsClient } from './nats-client.js';
import { Engine } from '../api/engine.js';
import { detectHardware } from '../core/hardware-detector.js';
import { WorkerRegistration, WorkerHeartbeat, InferenceRequest } from './types.js';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

export class WorkerNode {
  private workerId: string;
  private nats: NatsClient;
  private engine: Engine;
  private hardware: HardwareProfile;
  private heartbeatInterval?: NodeJS.Timeout;
  private activeRequests = 0;
  private totalRequests = 0;
  private latencies: number[] = [];

  constructor(
    private config: ClusterConfig,
    workerId?: string
  ) {
    this.workerId = workerId || `worker_${uuidv4().substring(0, 8)}`;
    this.nats = new NatsClient();
  }

  async start(): Promise<void> {
    console.log(`Starting worker: ${this.workerId}`);

    // 1. Connect to NATS
    await this.nats.connect(this.config.nats);

    // 2. Detect hardware
    this.hardware = detectHardware();
    console.log(`Hardware detected: ${this.hardware.chipModel} (${this.hardware.gpuCores} GPU cores)`);

    // 3. Initialize mlx-serving engine
    this.engine = new Engine(this.config.runtime);
    console.log('Engine initialized');

    // 4. Publish registration
    await this.register();

    // 5. Start heartbeat
    this.startHeartbeat();

    // 6. Subscribe to inference requests
    await this.subscribeToInferenceRequests();

    console.log(`Worker ${this.workerId} is online and ready`);
  }

  private async register(): Promise<void> {
    const registration: WorkerRegistration = {
      workerId: this.workerId,
      hostname: os.hostname(),
      ip: this.getLocalIp(),
      port: this.config.worker?.port || 8080,
      hardware: this.hardware,
      capabilities: {
        maxConcurrent: this.getMaxConcurrent(),
        supportedModelTiers: ['30B+', '13-27B', '7-13B', '3-7B', '<3B'],
        availableMemoryGB: this.hardware.unifiedMemoryGB * 0.8,
      },
      status: 'online',
      timestamp: Date.now(),
    };

    await this.nats.publish('worker.register', registration);
    console.log('Registration published');
  }

  private startHeartbeat(): void {
    const interval = this.config.discovery?.heartbeat_interval_ms || 5000;

    this.heartbeatInterval = setInterval(async () => {
      const heartbeat: WorkerHeartbeat = {
        workerId: this.workerId,
        status: 'online',
        metrics: await this.collectMetrics(),
        timestamp: Date.now(),
      };

      await this.nats.publish('worker.heartbeat', heartbeat);
    }, interval);
  }

  private async subscribeToInferenceRequests(): Promise<void> {
    await this.nats.subscribe<InferenceRequest>(
      `worker.${this.workerId}.inference`,
      async (request) => {
        await this.handleInferenceRequest(request);
      }
    );

    console.log(`Subscribed to: worker.${this.workerId}.inference`);
  }

  private async handleInferenceRequest(request: InferenceRequest): Promise<void> {
    this.activeRequests++;
    this.totalRequests++;
    const startTime = Date.now();

    try {
      console.log(`Processing request ${request.requestId} for model ${request.modelId}`);

      // Load model if not loaded
      const loadedModels = this.engine.getLoadedModels();
      if (!loadedModels.includes(request.modelId)) {
        console.log(`Loading model: ${request.modelId}`);
        await this.engine.loadModel({
          model: request.modelId,
        });
      }

      // Generate response
      const stream = await this.engine.generate({
        model: request.modelId,
        prompt: request.prompt,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });

      // Stream tokens back via NATS
      const reader = stream.getReader();
      let tokenIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Publish token
        await this.nats.publish(`response.${request.requestId}`, {
          requestId: request.requestId,
          type: 'token',
          token: value,
          index: tokenIndex++,
        });
      }

      // Publish completion
      const latency = Date.now() - startTime;
      this.latencies.push(latency);
      if (this.latencies.length > 100) this.latencies.shift();

      await this.nats.publish(`response.${request.requestId}`, {
        requestId: request.requestId,
        type: 'done',
        totalTokens: tokenIndex,
        latencyMs: latency,
      });

      console.log(`Completed request ${request.requestId} in ${latency}ms`);
    } catch (error) {
      console.error(`Error processing request ${request.requestId}:`, error);

      await this.nats.publish(`response.${request.requestId}`, {
        requestId: request.requestId,
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'INFERENCE_ERROR',
      });
    } finally {
      this.activeRequests--;
    }
  }

  private async collectMetrics(): Promise<WorkerMetrics> {
    return {
      cpuUsagePercent: await this.getCpuUsage(),
      memoryUsedGB: await this.getMemoryUsage(),
      gpuUtilizationPercent: 0,  // TODO: Implement Metal GPU monitoring
      activeRequests: this.activeRequests,
      totalRequestsHandled: this.totalRequests,
      avgLatencyMs: this.getAvgLatency(),
      modelsLoaded: this.engine.getLoadedModels(),
    };
  }

  private getMaxConcurrent(): number {
    // Use existing concurrency auto-tuner
    const tier = this.determineWorkerTier();
    const recommendations = recommendConcurrency(this.hardware);
    return recommendations[tier].maxConcurrent;
  }

  private determineWorkerTier(): ModelTier {
    // Determine tier based on hardware
    if (this.hardware.gpuCores >= 30 && this.hardware.unifiedMemoryGB >= 64) {
      return '30B+';
    } else if (this.hardware.gpuCores >= 20 && this.hardware.unifiedMemoryGB >= 32) {
      return '13-27B';
    } else if (this.hardware.gpuCores >= 15 && this.hardware.unifiedMemoryGB >= 16) {
      return '7-13B';
    } else {
      return '3-7B';
    }
  }

  private getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  private async getCpuUsage(): Promise<number> {
    // Simplified CPU usage (average load)
    const cpus = os.cpus();
    const usage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b);
      const idle = cpu.times.idle;
      return acc + (1 - idle / total);
    }, 0);
    return (usage / cpus.length) * 100;
  }

  private async getMemoryUsage(): Promise<number> {
    const total = os.totalmem();
    const free = os.freemem();
    return (total - free) / (1024 * 1024 * 1024);  // GB
  }

  private getAvgLatency(): number {
    if (this.latencies.length === 0) return 0;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  async stop(): Promise<void> {
    console.log(`Stopping worker: ${this.workerId}`);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    await this.nats.close();
    console.log('Worker stopped');
  }
}

// scripts/start-worker.ts
import { WorkerNode } from '../src/distributed/worker-node.js';
import { loadClusterConfig } from '../src/distributed/config-loader.js';

async function main() {
  const config = await loadClusterConfig('config/cluster.yaml');
  const worker = new WorkerNode(config);

  await worker.start();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down...');
    await worker.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down...');
    await worker.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

**Validation**:
```bash
# Start worker
npx tsx scripts/start-worker.ts

# Expected output:
# Starting worker: worker_abc12345
# Hardware detected: M3 Max (40 GPU cores)
# Engine initialized
# Registration published
# Subscribed to: worker.worker_abc12345.inference
# Worker worker_abc12345 is online and ready
```

---

### Task 1.3: Controller Node Implementation (6 days)

**Files to create**:
- `src/distributed/controller-node.ts` - Controller implementation
- `src/distributed/load-balancers/round-robin.ts` - Round-robin balancer
- `src/distributed/worker-registry.ts` - Worker state management
- `scripts/start-controller.ts` - Controller startup script

**Implementation**:

```typescript
// src/distributed/controller-node.ts
import { NatsClient } from './nats-client.js';
import { WorkerRegistry } from './worker-registry.js';
import { RoundRobinBalancer } from './load-balancers/round-robin.js';
import { WorkerInfo, InferenceRequest, ClusterConfig } from './types.js';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

export class ControllerNode {
  private nats: NatsClient;
  private workerRegistry: WorkerRegistry;
  private loadBalancer: LoadBalancer;
  private app: express.Application;

  constructor(private config: ClusterConfig) {
    this.nats = new NatsClient();
    this.workerRegistry = new WorkerRegistry(config);
    this.loadBalancer = new RoundRobinBalancer();  // Start with simple round-robin
    this.app = express();
  }

  async start(): Promise<void> {
    console.log('Starting controller node');

    // 1. Connect to NATS
    await this.nats.connect(this.config.nats);

    // 2. Subscribe to worker events
    await this.subscribeToWorkerEvents();

    // 3. Load static workers from config
    this.loadStaticWorkers();

    // 4. Start offline detection
    this.startOfflineDetection();

    // 5. Start API server
    this.startApiServer();

    console.log('Controller is online and ready');
  }

  private async subscribeToWorkerEvents(): Promise<void> {
    // Worker registration
    await this.nats.subscribe<WorkerRegistration>('worker.register', (data) => {
      this.workerRegistry.registerWorker(data);
      console.log(`Worker registered: ${data.workerId} (${data.hostname})`);
    });

    // Worker heartbeat
    await this.nats.subscribe<WorkerHeartbeat>('worker.heartbeat', (data) => {
      this.workerRegistry.updateHeartbeat(data);
    });

    console.log('Subscribed to worker events');
  }

  private loadStaticWorkers(): void {
    const staticWorkers = this.config.workers?.static || [];
    for (const worker of staticWorkers) {
      this.workerRegistry.addStaticWorker(worker);
      console.log(`Static worker added: ${worker.name} (${worker.ip})`);
    }
  }

  private startOfflineDetection(): void {
    const timeout = this.config.discovery?.offline_timeout_ms || 15000;

    setInterval(() => {
      const offlineWorkers = this.workerRegistry.detectOfflineWorkers(timeout);
      for (const workerId of offlineWorkers) {
        console.warn(`Worker offline: ${workerId}`);
      }
    }, 5000);
  }

  private startApiServer(): void {
    const port = this.config.controller?.port || 8080;

    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', workers: this.workerRegistry.getOnlineCount() });
    });

    // Cluster status
    this.app.get('/api/cluster/status', (req, res) => {
      res.json({
        controller: {
          version: '0.13.0',
          uptime: process.uptime() * 1000,
          mode: this.config.mode,
        },
        workers: {
          total: this.workerRegistry.getTotalCount(),
          online: this.workerRegistry.getOnlineCount(),
          offline: this.workerRegistry.getOfflineCount(),
        },
      });
    });

    // Workers list
    this.app.get('/api/cluster/workers', (req, res) => {
      res.json(this.workerRegistry.getAllWorkers());
    });

    // Inference endpoint (OpenAI-compatible)
    this.app.post('/v1/chat/completions', async (req, res) => {
      try {
        await this.handleInferenceRequest(req, res);
      } catch (error) {
        console.error('Inference error:', error);
        res.status(500).json({
          error: {
            message: error instanceof Error ? error.message : 'Unknown error',
            type: 'inference_error',
          },
        });
      }
    });

    this.app.listen(port, () => {
      console.log(`API server listening on port ${port}`);
    });
  }

  private async handleInferenceRequest(req: express.Request, res: express.Response): Promise<void> {
    const { model, messages, max_tokens = 100, temperature = 0.7, stream = true } = req.body;

    // Convert messages to prompt (simplified)
    const prompt = messages.map((m: any) => `${m.role}: ${m.content}`).join('\n');

    // Select worker
    const workers = this.workerRegistry.getOnlineWorkers();
    if (workers.length === 0) {
      throw new Error('No workers available');
    }

    const worker = this.loadBalancer.selectWorker(workers, {
      modelId: model,
      prompt,
      maxTokens: max_tokens,
      temperature,
    });

    console.log(`Routing request to worker: ${worker.workerId} (${worker.hostname})`);

    // Forward request via NATS
    const requestId = uuidv4();
    const subject = `worker.${worker.workerId}.inference`;

    // Subscribe to response
    const responseSub = await this.nats.subscribe<any>(`response.${requestId}`, (msg) => {
      if (msg.type === 'token') {
        // Stream token to client (SSE format)
        if (stream) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: msg.token } }] })}\n\n`);
        }
      } else if (msg.type === 'done') {
        if (stream) {
          res.write('data: [DONE]\n\n');
        }
        res.end();
        responseSub.unsubscribe();
      } else if (msg.type === 'error') {
        console.error(`Worker error: ${msg.error}`);
        if (stream) {
          res.write(`data: ${JSON.stringify({ error: msg.error })}\n\n`);
        }
        res.end();
        responseSub.unsubscribe();
      }
    });

    // Set response headers for streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    // Send request to worker
    await this.nats.publish<InferenceRequest>(subject, {
      requestId,
      modelId: model,
      prompt,
      maxTokens: max_tokens,
      temperature,
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: 'Request timeout' })}\n\n`);
        res.end();
        responseSub.unsubscribe();
      }
    }, 120000);
  }

  async stop(): Promise<void> {
    console.log('Stopping controller');
    await this.nats.close();
  }
}
```

**Validation**:
```bash
# Terminal 1: Start controller
npx tsx scripts/start-controller.ts

# Terminal 2: Start worker
npx tsx scripts/start-worker.ts

# Terminal 3: Send test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'

# Expected: Streaming response from worker via controller
```

---

### Task 1.4: Config File & Types (2 days)

**Files to create**:
- `src/distributed/types.ts` - All TypeScript types
- `src/distributed/config-loader.ts` - YAML config loader
- `config/cluster.example.yaml` - Example config

**Implementation**: See PRD Appendix for config examples

**Validation**:
```bash
# Validate config schema
npx tsx src/distributed/test-config.ts

# Expected:
# ✅ Config loaded successfully
# ✅ All required fields present
# ✅ Zod validation passed
```

---

### Task 1.5: Integration Tests (3 days)

**Files to create**:
- `tests/integration/distributed/basic-cluster.test.ts`
- `tests/integration/distributed/worker-discovery.test.ts`
- `tests/integration/distributed/request-routing.test.ts`

**Test scenarios**:
1. ✅ Controller + 1 worker: Send request, receive response
2. ✅ Controller + 2 workers: Verify round-robin distribution
3. ✅ Worker registration: Worker joins, controller detects
4. ✅ Worker heartbeat: Controller receives periodic updates
5. ✅ Offline detection: Kill worker, controller marks offline

**Validation**:
```bash
npm run test:integration -- tests/integration/distributed/

# Expected: All tests pass
```

---

## Phase 2: Load Balancing & Discovery (Weeks 4-5)

### Task 2.1: Least-Loaded Balancer (2 days)

**Files to create**:
- `src/distributed/load-balancers/least-loaded.ts`

**Implementation**: See PRD Section 2 "Detailed Design"

---

### Task 2.2: Hardware-Aware Balancer (3 days)

**Files to create**:
- `src/distributed/load-balancers/hardware-aware.ts`
- `src/distributed/model-tier-detector.ts` - Determine model tier from ID

**Integration**: Use existing `hardware-detector.ts` and `concurrency-auto-tuner.ts`

---

### Task 2.3: Sticky Sessions (2 days)

**Files to create**:
- `src/distributed/session-manager.ts`

**Implementation**: See PRD Section 2 "Sticky Sessions"

---

### Task 2.4: Auto-Discovery (3 days)

**Enhancement**: Improve worker registration to support dynamic discovery without controller restart

**Validation**:
```bash
# Start controller
# Start worker 1
# Start worker 2 (after controller running)
# Verify worker 2 auto-discovered
```

---

## Phase 3: Web Dashboard (Weeks 6-7)

### Task 3.1: Dashboard Backend API (3 days)

**Files to create**:
- `src/distributed/dashboard/api-routes.ts`
- `src/distributed/dashboard/websocket-server.ts`

**Endpoints**: See PRD Section "Web Dashboard"

---

### Task 3.2: React Frontend (7 days)

**Files to create**:
- `src/distributed/dashboard/ui/` - React components
- `src/distributed/dashboard/ui/components/ClusterOverview.tsx`
- `src/distributed/dashboard/ui/components/WorkerList.tsx`
- `src/distributed/dashboard/ui/components/MetricsChart.tsx`
- `src/distributed/dashboard/ui/components/RequestLog.tsx`

**Tech stack**: React + TypeScript + Tailwind + Recharts

---

## Phase 4: Production Readiness (Weeks 8-9)

### Task 4.1: Prometheus Metrics (3 days)

**Files to create**:
- `src/distributed/monitoring/prometheus-exporter.ts`

**Metrics**:
- `mlx_cluster_workers_total`
- `mlx_cluster_workers_online`
- `mlx_cluster_requests_active`
- `mlx_cluster_requests_total`
- `mlx_worker_requests_active`
- `mlx_worker_latency_ms`
- `mlx_worker_throughput_tokens_per_sec`

---

### Task 4.2: Error Handling & Retry (2 days)

**Enhancement**: Add retry logic for failed worker requests

---

### Task 4.3: Security & Auth (2 days)

**Files to create**:
- `src/distributed/auth/api-key-middleware.ts`
- `src/distributed/auth/nats-credentials.ts`

---

### Task 4.4: Documentation (3 days)

**Files to create**:
- `docs/DISTRIBUTED_SETUP.md` - Setup guide
- `docs/DISTRIBUTED_API.md` - API reference
- `docs/DISTRIBUTED_TROUBLESHOOTING.md` - Common issues

---

## Phase 5: Advanced Features (Weeks 10-13)

### Task 5.1: Model Cache Coordination (4 days)

**Goal**: Avoid redundant model downloads across workers

---

### Task 5.2: A/B Testing Support (3 days)

**Goal**: Route % of traffic to experimental workers

---

### Task 5.3: Advanced Metrics (3 days)

**Goal**: SLO tracking, percentiles (p50, p95, p99)

---

## Success Criteria

### Phase 1 Complete ✅
- [ ] Controller + 2 workers cluster functional
- [ ] Request routing works end-to-end
- [ ] Worker discovery and heartbeat working
- [ ] Round-robin load balancing verified
- [ ] All integration tests passing

### Phase 2 Complete ✅
- [ ] 3 load balancing strategies implemented
- [ ] Hardware-aware routing prefers capable workers
- [ ] Sticky sessions keep conversations on same worker
- [ ] Dynamic worker discovery without controller restart

### Phase 3 Complete ✅
- [ ] Web dashboard shows cluster state in real-time
- [ ] Metrics graphs update every 2 seconds
- [ ] Worker management UI functional
- [ ] Dashboard responsive on mobile

### Phase 4 Complete ✅
- [ ] Prometheus metrics exported
- [ ] Error handling covers all failure modes
- [ ] Authentication implemented
- [ ] Documentation complete

### Phase 5 Complete ✅
- [ ] Model cache coordination reduces redundant downloads
- [ ] A/B testing routes traffic correctly
- [ ] SLO metrics tracked and reported

---

## Timeline Summary

| Phase | Duration | Milestone |
|-------|----------|-----------|
| Phase 1 | 3 weeks | Basic cluster working |
| Phase 2 | 2 weeks | Advanced load balancing |
| Phase 3 | 2 weeks | Web dashboard |
| Phase 4 | 2 weeks | Production ready |
| Phase 5 | 3-4 weeks | Advanced features |
| **Total** | **12-13 weeks** | **GA Release** |

---

## Risk Mitigation

### Risk: NATS Complexity
**Mitigation**: Start with embedded NATS, comprehensive examples in docs

### Risk: Worker Failure During Request
**Mitigation**: Implement circuit breaker, retry logic, graceful failover

### Risk: Dashboard Performance
**Mitigation**: Use WebSocket for updates, pagination for logs, caching

### Risk: Configuration Errors
**Mitigation**: Zod validation, sensible defaults, setup wizard

---

## Next Steps

1. **Review PRD and Action Plan** with team
2. **Create GitHub project** with tasks from this plan
3. **Set up development environment**:
   ```bash
   # Install NATS server
   brew install nats-server

   # Install dependencies
   npm install nats uuid
   npm install --save-dev @types/uuid
   ```
4. **Begin Phase 1, Task 1.1** (NATS Integration)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-09
**Author**: Claude Code
**Status**: Ready for Implementation
