# Product Requirements Document: mlx-serving Distributed Inference System

**Project**: mlx-serving Distributed (Mac-Only)
**Version**: 1.0.0
**Date**: 2025-11-09
**Status**: Planning Phase
**Target Release**: Q1 2026

---

## Executive Summary

This PRD defines a distributed inference system for mlx-serving that enables multiple Mac devices to collaborate on LLM inference workloads. Unlike exo-explore's peer-to-peer layer-splitting approach, this system uses a **controller/worker architecture** for **task-level distribution** with **NATS messaging** and **Mac-only optimization**.

**Key Differentiators from exo-explore:**
- **Task distribution** (not layer splitting) - each worker handles complete inference requests
- **Centralized coordination** (not P2P) - single controller orchestrates all workers
- **Mac-only optimization** - MLX/Metal native, Apple Silicon hardware awareness
- **NATS messaging** - modern pub/sub with monitoring and persistence
- **Web dashboard** - real-time visualization of cluster state and performance

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Architecture Overview](#architecture-overview)
4. [Detailed Design](#detailed-design)
5. [Configuration](#configuration)
6. [Web Dashboard](#web-dashboard)
7. [NATS Integration](#nats-integration)
8. [API Specification](#api-specification)
9. [Implementation Phases](#implementation-phases)
10. [Success Metrics](#success-metrics)
11. [Risk Assessment](#risk-assessment)
12. [Appendix](#appendix)

---

## Problem Statement

### Current Limitations

1. **Single-device bottleneck**: mlx-serving runs on one Mac, limiting throughput to that device's capacity
2. **Underutilized resources**: Users with multiple Macs cannot pool their GPU resources
3. **No horizontal scaling**: Cannot add more Macs to increase capacity
4. **No load distribution**: Heavy workloads overwhelm single device

### User Scenarios

**Scenario 1: AI Development Team**
- 5 developers with MacBook Pros (M3 Max/M4 Pro mix)
- Want to share GPU resources for model testing
- Need unified API endpoint for all team members
- Desire visibility into cluster utilization

**Scenario 2: Home Lab Setup**
- User has Mac Studio (M2 Ultra) + 2x MacBook Pro (M3 Pro)
- Wants to maximize throughput for personal projects
- Needs automatic failover if one device goes offline
- Requires minimal configuration overhead

**Scenario 3: Production Deployment**
- Company runs inference service for internal tools
- Has 10 Mac Minis (M4) in rack mount
- Needs centralized management and monitoring
- Requires hardware-aware load balancing (send large models to powerful devices)

---

## Goals and Non-Goals

### Goals

✅ **P0 (Must Have)**:
1. Controller/worker architecture with centralized coordination
2. IP-based configuration file for static worker discovery
3. Auto-discovery of workers (detect online/offline without controller restart)
4. Controller can also function as worker (dual mode)
5. NATS messaging for all inter-node communication
6. Web dashboard showing workers, IPs, GPU models, utilization
7. Mac-only support with MLX/Metal optimization
8. Task-level distribution (each worker handles complete requests)
9. Hardware-aware load balancing (consider M1-M5 capabilities)
10. Backward compatibility with single-node mlx-serving

✅ **P1 (Should Have)**:
1. Multiple load balancing strategies (round-robin, least-loaded, hardware-aware)
2. Graceful degradation on worker failure
3. Worker health monitoring with heartbeat
4. Historical metrics collection and visualization
5. Multi-turn conversation sticky sessions
6. Model caching coordination across workers

✅ **P2 (Nice to Have)**:
1. Distributed model loading (avoid redundant downloads)
2. Cross-worker KV cache sharing (future, when MLX-LM supports)
3. Dynamic model migration (move loaded models between workers)
4. A/B testing support (route % of traffic to experimental workers)
5. Geographic affinity (prefer local workers for lower latency)

### Non-Goals

❌ **Out of Scope**:
1. **Linux/Windows support** - Mac-only for now
2. **Layer-level model splitting** - too complex for v1, may revisit later
3. **P2P architecture** - centralized controller is simpler
4. **Cloud deployment** - focused on local network clusters
5. **Multi-tenancy** - single organization use case
6. **Fine-tuning distribution** - inference only
7. **Custom NATS server** - use existing NATS infrastructure

---

## Architecture Overview

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                         NATS Server                              │
│                  (pub/sub, request/reply)                        │
└─────────────────────────────────────────────────────────────────┘
         ↑                    ↑                    ↑
         │                    │                    │
         ├────────────────────┼────────────────────┤
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Controller     │  │    Worker 1      │  │    Worker 2      │
│  (Mac Studio)    │  │  (MacBook Pro)   │  │  (Mac Mini)      │
│                  │  │                  │  │                  │
│ • Task Router    │  │ • mlx-serving    │  │ • mlx-serving    │
│ • Load Balancer  │  │ • Task Executor  │  │ • Task Executor  │
│ • Health Monitor │  │ • Status Reporter│  │ • Status Reporter│
│ • Web Dashboard  │  │ • Hardware Info  │  │ • Hardware Info  │
│ • Worker Registry│  │                  │  │                  │
│                  │  │ M3 Max           │  │ M4 Base          │
│ (Can also work   │  │ 96GB RAM         │  │ 32GB RAM         │
│  as Worker)      │  │ 40-core GPU      │  │ 10-core GPU      │
└──────────────────┘  └──────────────────┘  └──────────────────┘
         ↑
         │
    HTTP/WS
         │
         ▼
┌──────────────────┐
│   Client Apps    │
│                  │
│ • REST API       │
│ • WebSocket      │
│ • Dashboard UI   │
└──────────────────┘
```

### Component Responsibilities

#### Controller Node
1. **Task Routing**: Accepts inference requests, selects worker, forwards task
2. **Load Balancing**: Implements round-robin, least-loaded, hardware-aware strategies
3. **Worker Registry**: Maintains list of available workers with capabilities
4. **Health Monitoring**: Tracks worker heartbeats, marks offline workers
5. **Web Dashboard**: Serves real-time UI for cluster visualization
6. **API Gateway**: Exposes unified REST/WebSocket endpoint for clients
7. **Configuration Management**: Reads config file, manages cluster state
8. **Optional Worker Mode**: Can also execute inference tasks locally

#### Worker Node
1. **Task Execution**: Runs mlx-serving to handle inference requests
2. **Status Reporting**: Publishes heartbeat with hardware info and utilization
3. **Hardware Detection**: Reports chip model, GPU cores, memory, current load
4. **Model Management**: Loads/unloads models as directed by controller
5. **Result Streaming**: Streams tokens back via NATS to controller
6. **Health Checks**: Responds to controller health probes

#### NATS Server
1. **Message Bus**: Pub/sub topics for worker discovery and status
2. **Request/Reply**: RPC-style communication for inference tasks
3. **JetStream**: Persistent storage for metrics and historical data
4. **Monitoring**: Built-in metrics for message rates, latency, connections

---

## Detailed Design

### 1. Worker Discovery & Registration

#### Static Configuration (config/cluster.yaml)

```yaml
cluster:
  mode: controller  # or "worker" or "dual"

  controller:
    bind_address: "0.0.0.0"
    port: 8080
    dashboard_port: 8081

  nats:
    server_url: "nats://192.168.1.100:4222"
    # Or use embedded NATS server
    embedded: true
    cluster_name: "mlx-cluster"

  workers:
    # Static workers (always expected)
    - ip: "192.168.1.101"
      port: 8080
      name: "mac-studio-1"
      priority: 100  # Higher = preferred for large models

    - ip: "192.168.1.102"
      port: 8080
      name: "macbook-pro-1"
      priority: 80

    - ip: "192.168.1.103"
      port: 8080
      name: "mac-mini-1"
      priority: 50

  discovery:
    enabled: true  # Auto-discover additional workers
    method: "nats"  # "nats", "mdns", or "both"
    heartbeat_interval_ms: 5000
    offline_timeout_ms: 15000  # Mark offline after 3 missed heartbeats

  load_balancing:
    strategy: "hardware_aware"  # "round_robin", "least_loaded", "hardware_aware"
    sticky_sessions: true  # Route multi-turn conversations to same worker
    session_ttl_ms: 300000  # 5 minutes

  models:
    # Model placement hints
    tier_preferences:
      '30B+':
        min_gpu_cores: 30
        min_memory_gb: 64
        preferred_chips: ["M3 Max", "M3 Ultra", "M4 Max", "M4 Ultra"]

      '13-27B':
        min_gpu_cores: 20
        min_memory_gb: 32
        preferred_chips: ["M3 Pro", "M3 Max", "M4 Pro", "M4 Max"]
```

#### Dynamic Discovery Flow

```typescript
// Worker startup sequence
class WorkerNode {
  async start() {
    // 1. Connect to NATS
    await this.connectNats();

    // 2. Detect hardware
    const hardware = detectHardware();  // From existing hardware-detector.ts

    // 3. Initialize mlx-serving
    this.engine = new Engine(this.config);

    // 4. Publish registration message
    await this.publishRegistration({
      workerId: this.workerId,
      hostname: os.hostname(),
      ip: this.getLocalIp(),
      port: this.port,
      hardware: hardware,
      capabilities: {
        maxConcurrent: this.getMaxConcurrent(hardware),
        supportedModels: this.getSupportedModels(hardware),
        availableMemoryGB: hardware.unifiedMemoryGB * 0.8,  // Reserve 20%
      },
      status: 'online',
      timestamp: Date.now(),
    });

    // 5. Start heartbeat loop
    this.startHeartbeat();

    // 6. Subscribe to task queue
    await this.subscribeToTasks();
  }

  private startHeartbeat() {
    setInterval(async () => {
      const metrics = await this.collectMetrics();
      await this.nats.publish('worker.heartbeat', {
        workerId: this.workerId,
        status: 'online',
        metrics: metrics,
        timestamp: Date.now(),
      });
    }, 5000);
  }

  private async collectMetrics() {
    return {
      cpuUsagePercent: await this.getCpuUsage(),
      memoryUsedGB: await this.getMemoryUsage(),
      gpuUtilizationPercent: await this.getGpuUtilization(),
      activeRequests: this.activeRequestCount,
      totalRequestsHandled: this.totalRequests,
      avgLatencyMs: this.getAvgLatency(),
      modelsLoaded: this.engine.getLoadedModels(),
    };
  }
}

// Controller discovery handler
class ControllerNode {
  private workers = new Map<string, WorkerInfo>();

  async start() {
    await this.connectNats();

    // Subscribe to worker registrations
    await this.nats.subscribe('worker.register', (msg) => {
      this.handleWorkerRegistration(msg.data);
    });

    // Subscribe to heartbeats
    await this.nats.subscribe('worker.heartbeat', (msg) => {
      this.handleWorkerHeartbeat(msg.data);
    });

    // Start offline detection
    this.startOfflineDetection();

    // Load static workers from config
    this.loadStaticWorkers();

    // Start API server
    this.startApiServer();

    // Start dashboard
    this.startDashboard();
  }

  private handleWorkerRegistration(data: WorkerRegistration) {
    console.log(`Worker registered: ${data.workerId} (${data.hostname})`);

    this.workers.set(data.workerId, {
      ...data,
      lastHeartbeat: Date.now(),
      status: 'online',
      metrics: null,
    });

    // Broadcast to dashboard
    this.broadcastToUI('worker_online', data);
  }

  private handleWorkerHeartbeat(data: WorkerHeartbeat) {
    const worker = this.workers.get(data.workerId);
    if (!worker) {
      console.warn(`Heartbeat from unknown worker: ${data.workerId}`);
      return;
    }

    worker.lastHeartbeat = Date.now();
    worker.status = 'online';
    worker.metrics = data.metrics;

    // Update dashboard
    this.broadcastToUI('worker_update', worker);
  }

  private startOfflineDetection() {
    setInterval(() => {
      const now = Date.now();
      const timeout = this.config.discovery.offline_timeout_ms;

      for (const [workerId, worker] of this.workers) {
        if (worker.status === 'online' && now - worker.lastHeartbeat > timeout) {
          console.warn(`Worker offline: ${workerId}`);
          worker.status = 'offline';
          this.broadcastToUI('worker_offline', { workerId });
        }
      }
    }, 5000);
  }
}
```

### 2. Task Distribution

#### Load Balancing Strategies

**Strategy 1: Round-Robin**
```typescript
class RoundRobinBalancer implements LoadBalancer {
  private currentIndex = 0;

  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    const onlineWorkers = workers.filter(w => w.status === 'online');
    if (onlineWorkers.length === 0) throw new Error('No workers available');

    const selected = onlineWorkers[this.currentIndex % onlineWorkers.length];
    this.currentIndex++;
    return selected;
  }
}
```

**Strategy 2: Least-Loaded**
```typescript
class LeastLoadedBalancer implements LoadBalancer {
  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    const onlineWorkers = workers.filter(w => w.status === 'online');
    if (onlineWorkers.length === 0) throw new Error('No workers available');

    // Sort by active requests (ascending)
    const sorted = onlineWorkers.sort((a, b) => {
      const loadA = a.metrics?.activeRequests || 0;
      const loadB = b.metrics?.activeRequests || 0;
      return loadA - loadB;
    });

    return sorted[0];
  }
}
```

**Strategy 3: Hardware-Aware (Recommended)**
```typescript
class HardwareAwareBalancer implements LoadBalancer {
  selectWorker(workers: WorkerInfo[], request: InferenceRequest): WorkerInfo {
    const onlineWorkers = workers.filter(w => w.status === 'online');
    if (onlineWorkers.length === 0) throw new Error('No workers available');

    // Determine model tier
    const modelTier = this.getModelTier(request.modelId);

    // Filter workers that meet minimum requirements
    const capable = onlineWorkers.filter(w =>
      this.meetsRequirements(w.hardware, modelTier)
    );

    if (capable.length === 0) {
      console.warn(`No workers meet requirements for ${modelTier}, using best available`);
      return this.selectBestAvailable(onlineWorkers);
    }

    // Score each worker (higher = better)
    const scored = capable.map(w => ({
      worker: w,
      score: this.calculateScore(w, modelTier, request),
    }));

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    return scored[0].worker;
  }

  private calculateScore(worker: WorkerInfo, modelTier: ModelTier, request: InferenceRequest): number {
    let score = 0;

    // Hardware capability (0-100)
    score += this.getHardwareScore(worker.hardware);

    // Current load (inverse, 0-50)
    const loadPenalty = (worker.metrics?.activeRequests || 0) * 5;
    score += Math.max(0, 50 - loadPenalty);

    // Model already loaded? (+30 bonus)
    if (worker.metrics?.modelsLoaded?.includes(request.modelId)) {
      score += 30;
    }

    // Static priority from config (0-20)
    score += (worker.priority || 50) / 5;

    // GPU utilization penalty (0-20)
    const gpuPenalty = (worker.metrics?.gpuUtilizationPercent || 0) / 5;
    score -= gpuPenalty;

    return score;
  }

  private getHardwareScore(hardware: HardwareProfile): number {
    const chipScore = {
      'M1': 10, 'M1 Pro': 20, 'M1 Max': 30, 'M1 Ultra': 40,
      'M2': 15, 'M2 Pro': 25, 'M2 Max': 35, 'M2 Ultra': 45,
      'M3': 20, 'M3 Pro': 30, 'M3 Max': 40, 'M3 Ultra': 50,
      'M4': 25, 'M4 Pro': 35, 'M4 Max': 45, 'M4 Ultra': 55,
      'M5': 30, 'M5 Pro': 40, 'M5 Max': 50, 'M5 Ultra': 60,
    };

    const base = chipScore[hardware.chipModel] || 10;
    const gpuBonus = hardware.gpuCores / 2;  // 40 cores = +20
    const memBonus = hardware.unifiedMemoryGB / 4;  // 64GB = +16

    return base + gpuBonus + memBonus;
  }
}
```

#### Sticky Sessions for Multi-Turn Conversations

```typescript
class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private readonly SESSION_TTL = 5 * 60 * 1000;  // 5 minutes

  getWorkerForSession(sessionId: string, workers: WorkerInfo[]): WorkerInfo | null {
    const session = this.sessions.get(sessionId);

    if (!session) return null;

    // Check if session expired
    if (Date.now() - session.lastActivity > this.SESSION_TTL) {
      this.sessions.delete(sessionId);
      return null;
    }

    // Check if assigned worker still online
    const worker = workers.find(w => w.workerId === session.workerId);
    if (!worker || worker.status !== 'online') {
      this.sessions.delete(sessionId);
      return null;
    }

    // Update last activity
    session.lastActivity = Date.now();
    return worker;
  }

  createSession(sessionId: string, workerId: string) {
    this.sessions.set(sessionId, {
      sessionId,
      workerId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }
}
```

#### Request Flow

```typescript
class ControllerNode {
  async handleInferenceRequest(req: InferenceRequest): Promise<ReadableStream> {
    // 1. Session affinity check
    let worker: WorkerInfo | null = null;
    if (req.sessionId && this.config.load_balancing.sticky_sessions) {
      worker = this.sessionManager.getWorkerForSession(req.sessionId, Array.from(this.workers.values()));
    }

    // 2. Load balancing
    if (!worker) {
      worker = this.loadBalancer.selectWorker(Array.from(this.workers.values()), req);

      // Create session if needed
      if (req.sessionId) {
        this.sessionManager.createSession(req.sessionId, worker.workerId);
      }
    }

    console.log(`Routing request to worker: ${worker.workerId} (${worker.hostname})`);

    // 3. Forward request via NATS
    const requestId = this.generateRequestId();
    const subject = `worker.${worker.workerId}.inference`;

    // Create response stream
    const stream = new ReadableStream({
      start: async (controller) => {
        // Subscribe to response tokens
        const sub = await this.nats.subscribe(`response.${requestId}`, (msg) => {
          if (msg.data.type === 'token') {
            controller.enqueue(msg.data.token);
          } else if (msg.data.type === 'done') {
            controller.close();
            sub.unsubscribe();
          } else if (msg.data.type === 'error') {
            controller.error(new Error(msg.data.error));
            sub.unsubscribe();
          }
        });

        // Send request
        await this.nats.publish(subject, {
          requestId,
          ...req,
        });

        // Set timeout
        setTimeout(() => {
          if (!controller.closed) {
            controller.error(new Error('Worker timeout'));
            sub.unsubscribe();
          }
        }, 120000);  // 2 minute timeout
      },
    });

    return stream;
  }
}
```

---

## Configuration

### Example Cluster Configuration

**config/cluster.yaml**:
```yaml
cluster:
  # Node mode: "controller", "worker", or "dual"
  mode: dual

  controller:
    bind_address: "0.0.0.0"
    port: 8080
    dashboard_port: 8081
    api:
      cors_enabled: true
      cors_origins: ["*"]
      rate_limit:
        enabled: true
        requests_per_minute: 100

  nats:
    # Use external NATS server
    server_url: "nats://192.168.1.100:4222"

    # Or use embedded NATS server (simpler for small clusters)
    embedded: false

    cluster_name: "mlx-cluster"

    # NATS credentials (optional)
    user: "mlx_user"
    password: "${NATS_PASSWORD}"  # From env var

    # JetStream for persistence (optional)
    jetstream:
      enabled: true
      store_dir: ".nats/jetstream"

  workers:
    # Static worker definitions
    static:
      - ip: "192.168.1.101"
        port: 8080
        name: "mac-studio-1"
        priority: 100
        tags: ["production", "high-memory"]

      - ip: "192.168.1.102"
        port: 8080
        name: "macbook-pro-1"
        priority: 80
        tags: ["production"]

      - ip: "192.168.1.103"
        port: 8080
        name: "mac-mini-1"
        priority: 50
        tags: ["development"]

  discovery:
    enabled: true
    method: "nats"  # "nats", "mdns", or "both"

    # Heartbeat settings
    heartbeat_interval_ms: 5000
    offline_timeout_ms: 15000  # 3 missed heartbeats

    # Auto-registration
    allow_dynamic_workers: true
    require_authentication: false  # Set true for production

  load_balancing:
    strategy: "hardware_aware"  # "round_robin", "least_loaded", "hardware_aware"

    # Sticky sessions for multi-turn conversations
    sticky_sessions: true
    session_ttl_ms: 300000  # 5 minutes

    # Worker selection
    prefer_model_loaded: true  # Prefer workers with model already loaded
    avoid_overloaded: true     # Skip workers over 80% capacity

  models:
    # Model tier requirements (from existing concurrency.ts)
    tier_preferences:
      '30B+':
        min_gpu_cores: 30
        min_memory_gb: 64
        preferred_chips: ["M3 Max", "M3 Ultra", "M4 Max", "M4 Ultra", "M5 Max", "M5 Ultra"]

      '13-27B':
        min_gpu_cores: 20
        min_memory_gb: 32
        preferred_chips: ["M3 Pro", "M3 Max", "M4 Pro", "M4 Max", "M5 Pro", "M5 Max"]

      '7-13B':
        min_gpu_cores: 15
        min_memory_gb: 16
        preferred_chips: ["M3", "M3 Pro", "M4", "M4 Pro", "M5", "M5 Pro"]

      '3-7B':
        min_gpu_cores: 10
        min_memory_gb: 8

      '<3B':
        min_gpu_cores: 8
        min_memory_gb: 8

    # Model caching strategy
    cache_coordination:
      enabled: true
      strategy: "distributed"  # "distributed" or "independent"
      max_cache_gb_per_worker: 50

  monitoring:
    metrics:
      enabled: true
      export_interval_ms: 10000
      prometheus_port: 9090

    logging:
      level: "info"  # "debug", "info", "warn", "error"
      format: "json"
      file: "logs/cluster.log"

  dashboard:
    enabled: true
    port: 8081
    refresh_interval_ms: 2000
    historical_metrics_ttl_hours: 24
```

---

## Web Dashboard

### Features

1. **Cluster Overview**:
   - Total workers (online/offline)
   - Aggregate throughput (tokens/sec)
   - Active requests
   - Total requests handled (last 24h)

2. **Worker List**:
   - Worker name/hostname
   - IP address
   - Status (online/offline/degraded)
   - Hardware info (chip model, GPU cores, memory)
   - Current load (CPU/GPU/Memory %)
   - Active requests
   - Models loaded
   - Uptime

3. **Real-Time Metrics**:
   - Requests per second (time series graph)
   - Average latency (time series graph)
   - Token throughput (time series graph)
   - Error rate

4. **Request Log**:
   - Request ID
   - Model
   - Worker assigned
   - Latency
   - Tokens generated
   - Status (success/error)

### UI Mockup

```
┌─────────────────────────────────────────────────────────────────┐
│  mlx-serving Cluster Dashboard                     ⚙️  🔄  👤   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Cluster Overview                                                │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │   Workers    │  Throughput  │   Requests   │  Avg Latency │  │
│  │   3 online   │  45.2 tok/s  │   127 active │   2.3s       │  │
│  │   0 offline  │              │   8,432 /24h │              │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Throughput (tokens/sec)                                   │ │
│  │  50 ┤                                                    ╭─ │ │
│  │  40 ┤                                         ╭──────────╯  │ │
│  │  30 ┤                              ╭──────────╯             │ │
│  │  20 ┤                  ╭───────────╯                        │ │
│  │  10 ┤      ╭───────────╯                                    │ │
│  │   0 ┴──────┴────────────────────────────────────────────── │ │
│  │     12:00   12:05   12:10   12:15   12:20   12:25         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Workers                                        [+ Add Worker]   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 🟢 mac-studio-1      192.168.1.101:8080                    │ │
│  │    M3 Max • 96GB • 40 GPU cores                            │ │
│  │    CPU: 45%  GPU: 78%  Memory: 62GB/96GB                   │ │
│  │    Active: 3 requests  Models: Qwen3-30B (loaded)          │ │
│  │    Uptime: 2d 5h 32m   Total: 4,283 requests               │ │
│  │    ────────────────────────────────────────────────────── │ │
│  │                                                              │ │
│  │ 🟢 macbook-pro-1     192.168.1.102:8080                    │ │
│  │    M4 Pro • 32GB • 20 GPU cores                            │ │
│  │    CPU: 32%  GPU: 65%  Memory: 18GB/32GB                   │ │
│  │    Active: 2 requests  Models: Llama-3.2-7B (loaded)       │ │
│  │    Uptime: 1d 12h 8m   Total: 2,849 requests               │ │
│  │    ────────────────────────────────────────────────────── │ │
│  │                                                              │ │
│  │ 🟢 mac-mini-1        192.168.1.103:8080                    │ │
│  │    M4 • 16GB • 10 GPU cores                                │ │
│  │    CPU: 18%  GPU: 42%  Memory: 9GB/16GB                    │ │
│  │    Active: 1 request   Models: Gemma-2-3B (loaded)         │ │
│  │    Uptime: 6h 15m      Total: 1,300 requests               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Recent Requests                                 [View All]      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ ID: req_abc123  Model: Qwen3-30B   Worker: mac-studio-1   │ │
│  │ Latency: 2.8s   Tokens: 150        Status: ✅ Success      │ │
│  │ ────────────────────────────────────────────────────────── │ │
│  │ ID: req_def456  Model: Llama-7B    Worker: macbook-pro-1  │ │
│  │ Latency: 1.2s   Tokens: 85         Status: ✅ Success      │ │
│  │ ────────────────────────────────────────────────────────── │ │
│  │ ID: req_ghi789  Model: Gemma-3B    Worker: mac-mini-1     │ │
│  │ Latency: 0.8s   Tokens: 50         Status: ✅ Success      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

- **Frontend**: React + TypeScript
- **Real-time Updates**: WebSocket (or Server-Sent Events)
- **Charting**: Recharts or Chart.js
- **Styling**: Tailwind CSS
- **Backend**: Express.js endpoint on controller node

### API Endpoints for Dashboard

```typescript
// Dashboard API
GET /api/dashboard/overview
Response: {
  workers: { total: 3, online: 3, offline: 0 },
  throughput: { current: 45.2, avg24h: 38.7 },
  requests: { active: 127, total24h: 8432 },
  latency: { current: 2.3, avg24h: 2.1 },
}

GET /api/dashboard/workers
Response: [{
  workerId: "worker_001",
  hostname: "mac-studio-1",
  ip: "192.168.1.101",
  port: 8080,
  status: "online",
  hardware: {
    chipModel: "M3 Max",
    gpuCores: 40,
    unifiedMemoryGB: 96,
  },
  metrics: {
    cpuUsagePercent: 45,
    gpuUtilizationPercent: 78,
    memoryUsedGB: 62,
    activeRequests: 3,
    totalRequests: 4283,
    avgLatencyMs: 2300,
    modelsLoaded: ["mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit"],
  },
  uptime: 186120000,  // ms
  lastHeartbeat: 1699564823000,
}]

GET /api/dashboard/metrics/timeseries?metric=throughput&duration=1h
Response: {
  metric: "throughput",
  unit: "tokens/sec",
  points: [
    { timestamp: 1699564800000, value: 42.3 },
    { timestamp: 1699564860000, value: 45.1 },
    ...
  ]
}

GET /api/dashboard/requests?limit=50&status=success
Response: [{
  requestId: "req_abc123",
  modelId: "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit",
  workerId: "worker_001",
  latencyMs: 2800,
  tokensGenerated: 150,
  status: "success",
  timestamp: 1699564823000,
}]

WebSocket /ws/dashboard
Events:
- worker_online: { workerId, hostname, ... }
- worker_offline: { workerId }
- worker_update: { workerId, metrics }
- request_started: { requestId, modelId, workerId }
- request_completed: { requestId, latency, tokens, status }
- metrics_update: { throughput, latency, activeRequests }
```

---

## NATS Integration

### NATS Topics

```typescript
// Worker registration & discovery
'worker.register'           // Worker → Controller (worker registration)
'worker.heartbeat'          // Worker → Controller (periodic heartbeat)
'worker.*.inference'        // Controller → Worker (inference request)
'response.*'                // Worker → Controller (streaming response)

// Model management
'model.load'                // Controller → Worker (load model command)
'model.unload'              // Controller → Worker (unload model command)
'model.status'              // Worker → Controller (model status update)

// Health & monitoring
'health.check'              // Controller → Worker (health probe)
'health.response'           // Worker → Controller (health response)
'metrics.report'            // Worker → Controller (detailed metrics)

// Cluster coordination
'cluster.announce'          // Controller → All (cluster state change)
'cluster.shutdown'          // Controller → All (graceful shutdown)
```

### Message Formats

**Worker Registration**:
```json
{
  "workerId": "worker_001",
  "hostname": "mac-studio-1",
  "ip": "192.168.1.101",
  "port": 8080,
  "hardware": {
    "chipModel": "M3 Max",
    "chipGeneration": 3,
    "variant": "Max",
    "gpuCores": 40,
    "cpuCores": 16,
    "performanceCores": 12,
    "efficiencyCores": 4,
    "unifiedMemoryGB": 96,
    "metalVersion": "3.3",
    "osVersion": "Darwin 25.1.0"
  },
  "capabilities": {
    "maxConcurrent": 3,
    "supportedModelTiers": ["30B+", "13-27B", "7-13B", "3-7B", "<3B"],
    "availableMemoryGB": 76.8
  },
  "status": "online",
  "timestamp": 1699564823000
}
```

**Heartbeat**:
```json
{
  "workerId": "worker_001",
  "status": "online",
  "metrics": {
    "cpuUsagePercent": 45,
    "memoryUsedGB": 62,
    "gpuUtilizationPercent": 78,
    "activeRequests": 3,
    "totalRequestsHandled": 4283,
    "avgLatencyMs": 2300,
    "modelsLoaded": ["mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit"]
  },
  "timestamp": 1699564829000
}
```

**Inference Request**:
```json
{
  "requestId": "req_abc123",
  "modelId": "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit",
  "prompt": "What is machine learning?",
  "maxTokens": 100,
  "temperature": 0.7,
  "sessionId": "session_xyz789"  // Optional for sticky sessions
}
```

**Streaming Response**:
```json
// Token chunk
{
  "requestId": "req_abc123",
  "type": "token",
  "token": "Machine",
  "index": 0
}

// Completion
{
  "requestId": "req_abc123",
  "type": "done",
  "totalTokens": 150,
  "latencyMs": 2800
}

// Error
{
  "requestId": "req_abc123",
  "type": "error",
  "error": "Model not loaded",
  "code": "MODEL_NOT_LOADED"
}
```

### NATS Configuration

**Option 1: Embedded NATS Server** (Simpler for small clusters)
```typescript
import { connect, NatsConnection } from 'nats';

class EmbeddedNatsServer {
  async start() {
    // Use nats-server as subprocess
    const natsProcess = spawn('nats-server', [
      '--port', '4222',
      '--http_port', '8222',
      '--cluster_name', 'mlx-cluster',
      '--jetstream',
    ]);

    // Wait for startup
    await this.waitForReady('localhost:4222');

    // Connect
    this.nc = await connect({ servers: 'localhost:4222' });
  }
}
```

**Option 2: External NATS Server** (Recommended for production)
```bash
# Install NATS server
brew install nats-server

# Start with JetStream
nats-server \
  --port 4222 \
  --http_port 8222 \
  --cluster_name mlx-cluster \
  --jetstream \
  --store_dir .nats/jetstream

# With authentication
nats-server \
  --config nats-server.conf
```

**nats-server.conf**:
```
port: 4222
http_port: 8222

cluster {
  name: "mlx-cluster"
}

jetstream {
  store_dir: ".nats/jetstream"
  max_memory_store: 1GB
  max_file_store: 10GB
}

authorization {
  users = [
    { user: "mlx_user", password: "$2a$11$..." }
  ]
}

logging {
  debug: false
  trace: false
  logtime: true
  logfile: "logs/nats.log"
}
```

---

## API Specification

### REST API (Controller)

**Inference Endpoint** (OpenAI-compatible):
```http
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit",
  "messages": [
    { "role": "user", "content": "What is machine learning?" }
  ],
  "max_tokens": 100,
  "temperature": 0.7,
  "stream": true,
  "session_id": "optional_session_id"  // For sticky sessions
}

Response (streaming):
data: {"choices":[{"delta":{"content":"Machine"}}]}
data: {"choices":[{"delta":{"content":" learning"}}]}
...
data: [DONE]
```

**Cluster Management**:
```http
GET /api/cluster/status
Response: {
  "controller": {
    "version": "0.13.0",
    "uptime": 186120000,
    "mode": "dual"
  },
  "workers": {
    "total": 3,
    "online": 3,
    "offline": 0
  },
  "models": {
    "loaded": ["Qwen3-30B", "Llama-7B", "Gemma-3B"]
  },
  "requests": {
    "active": 5,
    "total": 8432,
    "successRate": 0.998
  }
}

GET /api/cluster/workers
Response: [ /* array of WorkerInfo */ ]

GET /api/cluster/workers/:workerId
Response: { /* WorkerInfo */ }

POST /api/cluster/workers/:workerId/load-model
Request: {
  "modelId": "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit"
}
Response: { "status": "loading" }

POST /api/cluster/workers/:workerId/unload-model
Request: {
  "modelId": "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit"
}
Response: { "status": "unloading" }
```

### Worker API

**Health Check**:
```http
GET /health
Response: {
  "status": "healthy",
  "workerId": "worker_001",
  "uptime": 86400000,
  "metrics": { /* current metrics */ }
}
```

**Metrics**:
```http
GET /metrics
Response: (Prometheus format)
# HELP mlx_worker_active_requests Current active requests
# TYPE mlx_worker_active_requests gauge
mlx_worker_active_requests{worker_id="worker_001"} 3

# HELP mlx_worker_total_requests Total requests handled
# TYPE mlx_worker_total_requests counter
mlx_worker_total_requests{worker_id="worker_001"} 4283
```

---

## Implementation Phases

### Phase 1: Foundation (2-3 weeks)

**Goal**: Basic controller/worker architecture with NATS messaging

**Tasks**:
1. ✅ NATS client integration (use `nats` npm package)
2. ✅ Worker registration and heartbeat
3. ✅ Controller worker registry
4. ✅ Basic load balancing (round-robin)
5. ✅ Request forwarding via NATS
6. ✅ Streaming response handling
7. ✅ Config file parsing (cluster.yaml)
8. ✅ Unit tests for core components

**Deliverables**:
- Working controller node
- Working worker node
- Basic cluster with 2+ workers
- Manual testing successful

**Validation**:
- Start controller + 2 workers
- Send inference request
- Verify round-robin distribution
- Check worker heartbeats

---

### Phase 2: Load Balancing & Discovery (2 weeks)

**Goal**: Advanced load balancing and auto-discovery

**Tasks**:
1. ✅ Least-loaded balancer
2. ✅ Hardware-aware balancer
3. ✅ Sticky sessions for conversations
4. ✅ Auto-discovery via NATS
5. ✅ Offline detection
6. ✅ Graceful degradation on worker failure
7. ✅ Integration tests

**Deliverables**:
- 3 load balancing strategies
- Dynamic worker discovery
- Session management
- Failover handling

**Validation**:
- Add worker dynamically (no controller restart)
- Kill worker, verify failover
- Multi-turn conversation stays on same worker
- Hardware-aware routing prefers capable workers

---

### Phase 3: Web Dashboard (2 weeks)

**Goal**: Real-time cluster visualization

**Tasks**:
1. ✅ Dashboard backend API
2. ✅ React frontend with Tailwind
3. ✅ WebSocket real-time updates
4. ✅ Worker list view
5. ✅ Metrics time series graphs
6. ✅ Request log view
7. ✅ Responsive design

**Deliverables**:
- Functional web dashboard on port 8081
- Real-time metrics updates
- Worker management UI

**Validation**:
- Dashboard shows all workers
- Metrics update every 2 seconds
- Add/remove worker reflects in UI
- Time series graphs render correctly

---

### Phase 4: Production Readiness (2 weeks)

**Goal**: Monitoring, metrics, and reliability

**Tasks**:
1. ✅ Prometheus metrics export
2. ✅ Structured logging (JSON format)
3. ✅ Error handling and retry logic
4. ✅ Authentication (optional)
5. ✅ Rate limiting
6. ✅ Security hardening
7. ✅ Documentation
8. ✅ End-to-end tests

**Deliverables**:
- Production-grade error handling
- Complete documentation
- Deployment guide
- Security audit

**Validation**:
- Load test with 100 concurrent requests
- Network partition recovery
- Worker crash recovery
- Metrics exported to Prometheus

---

### Phase 5: Advanced Features (3-4 weeks)

**Goal**: Distributed caching, model coordination

**Tasks**:
1. ✅ Model cache coordination
2. ✅ Distributed model loading
3. ✅ Cross-worker KV cache (future)
4. ✅ A/B testing support
5. ✅ Geographic affinity
6. ✅ Advanced metrics (SLOs, percentiles)
7. ✅ Canary deployments for workers

**Deliverables**:
- Coordinated model caching
- Advanced routing strategies
- Performance optimizations

**Validation**:
- Model loaded once, shared across cluster
- A/B test routes 10% to experimental worker
- SLO metrics tracked and reported

---

## Success Metrics

### Performance Metrics

1. **Throughput**:
   - Target: 2-5x throughput vs single node (depending on cluster size)
   - Measurement: Total tokens/sec across all workers

2. **Latency**:
   - Target: <100ms routing overhead (controller → worker)
   - Target: <10ms NATS message latency
   - Measurement: End-to-end latency vs single-node baseline

3. **Scalability**:
   - Target: Linear scaling up to 10 workers
   - Target: Sub-linear scaling 10-50 workers (network overhead)
   - Measurement: Throughput vs worker count

4. **Availability**:
   - Target: 99.9% uptime (single worker failure doesn't affect cluster)
   - Target: <5s failover time on worker crash
   - Measurement: Uptime monitoring + failure injection tests

### Operational Metrics

1. **Discovery Time**:
   - Target: <5s for worker to join cluster
   - Measurement: Time from worker start to first request routed

2. **Failover Time**:
   - Target: <5s to detect offline worker and reroute
   - Measurement: Time from worker crash to successful request reroute

3. **Dashboard Responsiveness**:
   - Target: <2s initial load
   - Target: <200ms metric updates
   - Measurement: Browser performance profiling

### User Satisfaction Metrics

1. **Ease of Setup**:
   - Target: <10 minutes to deploy 3-node cluster
   - Measurement: User testing + documentation feedback

2. **Configuration Simplicity**:
   - Target: <20 lines of YAML for basic cluster
   - Measurement: Config file size + user feedback

3. **Observability**:
   - Target: All cluster state visible in dashboard
   - Measurement: User testing + feature completeness audit

---

## Risk Assessment

### Technical Risks

**Risk 1: NATS Message Latency** (Medium)
- **Impact**: High latency reduces throughput gains
- **Likelihood**: Medium (NATS typically <5ms, but network issues possible)
- **Mitigation**:
  - Use embedded NATS for local clusters
  - Benchmark NATS overhead extensively
  - Fallback to direct HTTP if NATS unavailable

**Risk 2: Network Partitions** (High)
- **Impact**: Workers isolated from controller, cluster split-brain
- **Likelihood**: Low (local network usually stable)
- **Mitigation**:
  - Implement split-brain detection
  - Use NATS JetStream for persistence
  - Graceful degradation to standalone mode

**Risk 3: Worker Overload** (Medium)
- **Impact**: Worker crashes under load, affects reliability
- **Likelihood**: Medium (poor load balancing or burst traffic)
- **Mitigation**:
  - Implement queue depth limits per worker
  - Circuit breaker pattern
  - Reject requests when over capacity

**Risk 4: Model Loading Coordination** (Low)
- **Impact**: All workers download same 30GB model simultaneously
- **Likelihood**: Low (only on first load)
- **Mitigation**:
  - Distributed cache implementation (Phase 5)
  - Staggered loading
  - Pre-load models on worker startup

### Operational Risks

**Risk 5: Configuration Complexity** (Medium)
- **Impact**: Users struggle to configure clusters
- **Likelihood**: Medium (distributed systems are complex)
- **Mitigation**:
  - Sensible defaults
  - Auto-detection where possible
  - Comprehensive documentation + examples
  - Setup wizard in dashboard

**Risk 6: Monitoring Blind Spots** (Low)
- **Impact**: Issues not visible in dashboard, hard to debug
- **Likelihood**: Low (extensive metrics planned)
- **Mitigation**:
  - Comprehensive metrics from day 1
  - Structured logging
  - Prometheus integration
  - Debug mode for detailed traces

---

## Appendix

### A. Comparison: mlx-serving Distributed vs exo-explore

| Feature | exo-explore | mlx-serving Distributed |
|---------|-------------|------------------------|
| **Architecture** | P2P (peer-to-peer) | Centralized (controller/worker) |
| **Distribution Strategy** | Layer splitting | Task distribution |
| **Platforms** | Mac, Linux, Mobile | Mac-only |
| **Messaging** | gRPC | NATS |
| **Discovery** | UDP, Tailscale, mDNS | NATS discovery, mDNS |
| **Load Balancing** | Ring memory weighted | Round-robin, least-loaded, hardware-aware |
| **Dashboard** | Basic tinychat UI | Full-featured web dashboard |
| **Configuration** | Env vars only | YAML config + env vars |
| **Model Placement** | Automatic layer split | Hardware-aware task routing |
| **Use Case** | Run models larger than any single device | Maximize throughput across multiple devices |
| **Complexity** | High (P2P coordination) | Medium (centralized control) |
| **Scalability** | Up to ~10 devices | Up to ~50 devices |

**When to use exo-explore**:
- Need to run models too large for any single device
- Want true P2P with no single point of failure
- Need mobile device support

**When to use mlx-serving Distributed**:
- Want maximum throughput, not maximum model size
- Prefer centralized management and monitoring
- Mac-only environment
- Need production-grade observability

### B. Hardware Requirements

**Controller Node** (Recommended):
- Mac Studio M2 Ultra or Mac Studio M3 Max
- 64GB+ unified memory
- 1TB+ SSD (for model cache)
- Gigabit Ethernet (10GbE recommended for >10 workers)

**Worker Node** (Minimum):
- Any Apple Silicon Mac (M1 or newer)
- 16GB+ unified memory
- 256GB+ SSD
- Gigabit Ethernet

**Network**:
- Gigabit Ethernet recommended (WiFi works but higher latency)
- <5ms latency between nodes
- Dedicated VLAN for cluster traffic (optional, recommended for production)

### C. Example Deployment Scenarios

**Scenario 1: Small Team (3-5 developers)**
```yaml
# Setup: 1 Mac Studio (controller+worker) + 4 MacBook Pros (workers)
cluster:
  mode: dual  # Mac Studio is both controller and worker
  nats:
    embedded: true  # Simpler for small cluster
  discovery:
    enabled: true
    method: "mdns"  # Auto-discover on local network
  load_balancing:
    strategy: "least_loaded"  # Fair distribution
```

**Scenario 2: Production Deployment (10+ Mac Minis)**
```yaml
# Setup: 1 dedicated controller + 10 worker Mac Minis
cluster:
  mode: controller  # Dedicated controller (doesn't run inference)
  nats:
    server_url: "nats://192.168.10.100:4222"  # External NATS server
    jetstream:
      enabled: true  # Persistence for metrics
  discovery:
    enabled: true
    method: "nats"
    require_authentication: true
  load_balancing:
    strategy: "hardware_aware"  # Route by model size
  monitoring:
    prometheus_port: 9090  # Export to Prometheus
```

**Scenario 3: Hybrid (Controller can help with small models)**
```yaml
# Setup: 1 Mac Studio (controller+worker for <7B) + 2 Mac Studios (30B workers)
cluster:
  mode: dual
  load_balancing:
    strategy: "hardware_aware"
  models:
    tier_preferences:
      '30B+':
        preferred_workers: ["mac-studio-2", "mac-studio-3"]  # Heavy models
      '<7B':
        preferred_workers: ["mac-studio-1"]  # Controller handles small models
```

### D. Migration from Single-Node mlx-serving

**Step 1: Install distributed components** (no breaking changes):
```bash
npm install  # Includes new distributed modules
```

**Step 2: Create cluster config**:
```bash
cp config/cluster.example.yaml config/cluster.yaml
# Edit config/cluster.yaml
```

**Step 3: Start controller**:
```bash
npm run cluster:controller
# Or: npx tsx src/distributed/controller.ts
```

**Step 4: Start workers** (on other Macs):
```bash
npm run cluster:worker
# Or: npx tsx src/distributed/worker.ts
```

**Step 5: Update client code** (optional, backward compatible):
```typescript
// Old (still works):
const engine = new Engine();

// New (distributed-aware):
const engine = new DistributedEngine({
  controllerUrl: 'http://192.168.1.100:8080',
});
```

**Key Points**:
- ✅ Backward compatible: existing code works unchanged
- ✅ Opt-in: distributed features enabled via config
- ✅ Gradual migration: run single-node and distributed simultaneously
- ✅ Zero downtime: controller+workers can be added to running deployment

### E. Technology Stack Summary

**Core Dependencies**:
- `nats` (v2.20+) - NATS client for Node.js
- `express` (v4.18+) - HTTP server for dashboard API
- `ws` (v8.16+) - WebSocket server for real-time updates
- `prom-client` (v15.1+) - Prometheus metrics export
- `zod` (v3.22+) - Config validation
- `yaml` (v2.3+) - Config file parsing

**Frontend Dependencies** (Dashboard):
- `react` (v18.2+) - UI framework
- `recharts` (v2.10+) - Time series graphs
- `tailwindcss` (v3.4+) - Styling
- `socket.io-client` (v4.7+) - WebSocket client

**Development Dependencies**:
- `vitest` (v1.0+) - Testing
- `tsx` (v4.7+) - TypeScript execution
- `eslint` (v8.56+) - Linting
- `typescript` (v5.3+) - Type checking

**External Services**:
- NATS Server (v2.10+) - Message broker (optional, can use embedded)
- Prometheus (optional) - Metrics collection
- Grafana (optional) - Metrics visualization

---

## Conclusion

This PRD defines a **centralized distributed inference system** for mlx-serving that prioritizes **ease of use**, **observability**, and **Mac-specific optimization** over the P2P complexity of exo-explore.

**Key Advantages**:
1. ✅ **Simpler architecture**: Centralized control easier to understand and debug
2. ✅ **Better observability**: Web dashboard shows entire cluster state
3. ✅ **Mac-optimized**: Hardware-aware routing leverages M1-M5 capabilities
4. ✅ **Production-ready**: NATS messaging, Prometheus metrics, structured logging
5. ✅ **Backward compatible**: Works with existing mlx-serving code

**Next Steps**:
1. Review and approve PRD
2. Create detailed implementation plan for Phase 1
3. Set up development environment with NATS
4. Begin controller/worker implementation

**Timeline**: 11-13 weeks total (2.5-3 months)

**Team**: 1-2 engineers full-time

**Launch Target**: Q1 2026 (Beta: January, GA: March)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-09
**Author**: Claude Code
**Status**: Awaiting Approval
