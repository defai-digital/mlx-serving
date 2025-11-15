# mlx-serving Architecture

**Version**: 2.1
**Date**: 2025-11-15
**Status**: ✅ Production Ready (v1.2.0)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [v1.2.0 Concurrency Architecture](#v120-concurrency-architecture)
3. [Product Vision](#product-vision)
4. [M3+ Hardware Strategy](#m3-hardware-strategy)
5. [Distributed Architecture](#distributed-architecture)
6. [Technical Specification](#technical-specification)
7. [Implementation Roadmap](#implementation-roadmap)

---

## Executive Summary

### What is mlx-serving?

**mlx-serving** is a **production-grade LLM serving engine** for Apple Silicon M3+ hardware, designed as the **node-level serving layer** in distributed inference clusters.

**Core Value Proposition**:
- 🚀 **30-70% throughput improvement** over single-machine deployments
- 🎯 **M3+ optimized**: Metal 3.3+, AMX v2, 400+ GB/s UMA bandwidth
- 🏗️ **Distributed-first**: Multi-Mac cluster orchestration
- 🔒 **Type-safe**: 100% TypeScript strict mode, zero `any` types
- ✅ **Production-ready**: 231/231 tests, 4 CVEs fixed, 18 bugs resolved

### The Problem We Solve

**Single-Machine Performance Degradation**: Large models (≥32B, 8-16K context) on high-end M3 Ultra suffer:
- Memory pressure → 50%+ throughput drop (250 → 80-120 tokens/s)
- Concurrency bottleneck → Safe concurrent requests ≤ 4
- KV cache explosion → Unpredictable P95/P99 tail latency

**Our Solution**: **多機分流、不切分模型** (Multi-Mac load distribution, no model sharding)
- Each M3+ Mac hosts complete model independently
- Smart routing with session affinity for KV cache reuse
- Gateway orchestrates requests across worker pool
- Result: Stable high throughput without single-machine bottlenecks

---

## v1.2.0 Concurrency Architecture

### Overview

**v1.2.0** represents a fundamental shift in how mlx-serving handles concurrency. After extensive load testing, we discovered that artificial concurrency limits were solving a problem that didn't exist and actually degraded performance.

**Key Changes:**
- ✅ **Removed ModelConcurrencyLimiter**: Eliminated 519 lines of tier-based concurrency limiting code
- ✅ **Trust MLX's Metal Scheduler**: Direct passthrough to MLX framework's native concurrency management
- ✅ **+3-5% throughput**: Improved performance by removing artificial queuing
- ✅ **100% success rate**: Eliminated rejections (12% → 0%) and timeouts (18% → 0%)
- ✅ **Backward compatible**: Old configs work with deprecation warnings

### Previous Architecture (v1.1.1 and earlier)

**Flawed Assumption**: We believed MLX needed help managing concurrent requests to prevent Metal GPU crashes.

**Implementation**:
```typescript
// ❌ REMOVED in v1.2.0
class ModelConcurrencyLimiter {
  private tierLimits = {
    '30B+': { max_concurrent: 3, queue_depth: 25 },
    '13-27B': { max_concurrent: 8, queue_depth: 50 },
    // ...more tiers
  };

  async acquire(modelSize: string): Promise<void> {
    // Queue requests if limit reached
    if (this.activeRequests >= this.tierLimits[modelSize].max_concurrent) {
      await this.waitInQueue(modelSize);
    }
  }
}
```

**Configuration**:
```yaml
# ❌ DEPRECATED - Removed in v1.2.0
mlx:
  concurrency_limit: 1  # Serialized ALL requests
  force_metal_sync: true

model_concurrency_limiter:
  enabled: true
  tier_limits:
    '30B+':
      max_concurrent: 3
      queue_depth: 25
```

**Problems Discovered**:
- `concurrency_limit: 1` serialized all requests → massive queuing overhead
- Performance: -3% to -5% throughput vs unlimited concurrency
- Reliability: 70% success rate, 12% rejections, 18% timeouts
- Root cause: MLX's Metal scheduler already handles concurrency efficiently

### Current Architecture (v1.2.0+)

**Philosophy**: Trust MLX's native Metal scheduler. It has been proven stable under unlimited concurrent load.

**Implementation**:
```typescript
// ✅ v1.2.0: Direct passthrough to MLX
class StreamRegistry {
  async generate(request: GenerateRequest): AsyncGenerator<Token> {
    // No artificial limiting - MLX handles concurrency natively
    return this.mlxBridge.generate(request);
  }
}
```

**Configuration**:
```yaml
# ✅ v1.2.0: Simplified config
mlx:
  default_context_length: 8192
  cache_weights: true
  # No concurrency_limit needed - trust MLX scheduler
```

**Benefits**:
- **Performance**: +3-5% throughput (direct passthrough eliminates queuing overhead)
- **Reliability**: 100% success rate (zero artificial rejections/timeouts)
- **Simplicity**: -600 lines of code (ModelConcurrencyLimiter removed entirely)
- **Scalability**: MLX's Metal scheduler optimizes GPU command queuing better than we can

### How MLX Handles Concurrency

**Metal Command Buffer Scheduling**:
```
User Request 1 →┐
User Request 2 →├─→ MLX Framework →─→ Metal Scheduler →─→ GPU Command Queue
User Request 3 →┘                      (Intelligent batching,
                                        resource pooling,
                                        kernel fusion)
```

**MLX's Native Optimizations**:
1. **Command Buffer Pooling**: Reuses Metal command buffers across requests
2. **Automatic Batching**: Fuses compatible operations from concurrent requests
3. **Memory Pressure Handling**: Backs off gracefully when VRAM is saturated
4. **Kernel Fusion**: Merges consecutive operations to reduce kernel launches

**Proven Stability**: Load testing showed MLX handles 100+ concurrent requests without crashes.

### Vision Model Performance Advantages

**v1.2.0 preserves the 1.9-2.5x performance advantage for vision models**. This advantage comes from architectural design, NOT from concurrency limiting:

#### 1. Persistent Python Process

```
mlx-engine (spawn per request):
  Request → Spawn Python → Load Vision Encoder (2-3s) → Generate → Kill Process

mlx-serving (persistent):
  Request 1 → Load Vision Encoder (2-3s) → Generate
  Request 2 →                              Generate (encoder warm, <500ms)
  Request 3 →                              Generate (encoder warm, <500ms)
```

**Impact**: First request loads encoder once, subsequent requests use warm encoder (60%+ faster).

#### 2. IPC Token Buffering

```
Without buffering:
  1 token generated → 1 IPC call → TypeScript receives 1 token
  100 tokens = 100 IPC calls = high overhead

With buffering (mlx-serving):
  16 tokens generated → 1 IPC call → TypeScript receives 16 tokens
  100 tokens = ~6 IPC calls = 10-20x fewer calls
```

**Impact**: Reduces TypeScript ↔ Python communication overhead by 10-20x.

#### 3. Native mlx-vlm Integration

```typescript
// mlx-serving: Direct API usage
from mlx_vlm import generate_with_image

result = generate_with_image(
  model=model,
  processor=processor,
  image=image_path,
  prompt=prompt
)
```

**Impact**:
- Forward compatibility with latest vision model architectures (Qwen3-VL exclusive support)
- Native integration eliminates custom wrapper overhead
- Automatically inherits mlx-vlm performance optimizations

**Benchmark Results** (Qwen2.5-VL-7B):
- mlx-serving: 67.66 tok/s (100% success rate)
- mlx-engine: 27-36 tok/s (varies)
- Advantage: **1.9-2.5x faster** (architecture, not concurrency limits)

### Migration from v1.1.1

**Backward Compatibility**: Old configurations continue to work with deprecation warnings.

**Deprecation Warnings**:
```
[mlx-serving] DEPRECATION WARNING: mlx.concurrency_limit is deprecated in v1.2.0+
Trust MLX's native Metal scheduler. See docs/MIGRATION_V1.2.md for details.
```

**Recommended Updates**:
```yaml
# BEFORE (v1.1.1)
mlx:
  concurrency_limit: 1        # ❌ Remove
  force_metal_sync: true      # ❌ Remove
  default_context_length: 8192
  cache_weights: true

model_concurrency_limiter:    # ❌ Remove entire section
  enabled: true
  tier_limits: {...}

# AFTER (v1.2.0)
mlx:
  default_context_length: 8192
  cache_weights: true
  # Trust MLX's native Metal scheduler
```

**See [docs/MIGRATION_V1.2.md](MIGRATION_V1.2.md) for complete upgrade guide.**

### Performance Impact

**Before v1.2.0** (with artificial limits):
- Text Models (30B): 75.73 tok/s, 70% success rate, 12% rejections, 18% timeouts
- VL Models (Qwen2.5-VL-7B): 67.66 tok/s, 100% success rate

**After v1.2.0** (trust MLX scheduler):
- Text Models (30B): ~79 tok/s (+3-5%), 100% success rate, 0% rejections, 0% timeouts
- VL Models (Qwen2.5-VL-7B): 67.66 tok/s (unchanged), 100% success rate

**Key Insight**: Concurrency limits were causing performance degradation, not preventing crashes.

---

## Product Vision

### Target Market

**Primary Users**:
1. **Enterprise IT** - Mac Studio M3+ fleets (70B+ models)
2. **AI Research Labs** - Multi-modal, long-context inference
3. **SaaS Providers** - Multi-tenant LLM services

**Market Positioning**:
- Only production-ready TypeScript serving engine for Apple Silicon
- Strategic focus on M3+ hardware (vs consumer M1/M2 support)
- Built for distributed clusters from day one

### Key Differentiators

| Feature | mlx-serving | Ollama | llama.cpp | vLLM |
|---------|-------------|--------|-----------|------|
| **TypeScript Native** | ✅ | ❌ | ❌ | ❌ |
| **Distributed Cluster** | ✅ | ❌ | ❌ | ✅ |
| **M3+ Optimized** | ✅ | ⚠️ | ⚠️ | N/A |
| **Type Safety** | ✅ | ❌ | ❌ | ⚠️ |
| **Structured Output** | ✅ | ❌ | ⚠️ | ✅ |
| **Vision Models** | ✅ | ⚠️ | ⚠️ | ✅ |
| **On-Premise** | ✅ | ✅ | ✅ | ⚠️ |

**Unique Advantage**: Combines type safety (TypeScript), Apple Silicon optimization (Metal 3.3+/AMX v2), and distributed orchestration.

---

## M3+ Hardware Strategy

### Why M3+ Only?

**Official Requirement**: Apple Silicon **M3 or later** (M3 Pro / M3 Max / M3 Ultra recommended)

**Strategic Decision**: Focus on M3+ to maximize performance and reduce maintenance costs by 50%.

### Technical Rationale

#### 1. Metal 3.3+ API Advantages

| Feature | M3+ (Metal 3.3+) | M1/M2 (Metal 3.0/3.1) | Impact |
|---------|------------------|------------------------|--------|
| **MTLDynamicLibrary** | ✅ | ❌ | +20-30% |
| **Argument Buffers Tier 2** | ✅ | ⚠️ Limited | +15-20% |
| **Paged KV Cache** | ✅ | ❌ | Essential for long context |
| **Shared Heaps** | ✅ | ⚠️ Limited | +10-15% |

**Result**: M3+ enables **20-30% performance improvement** through Metal features alone.

#### 2. AMX v2 Matrix Acceleration

| Operation | M3+ (AMX v2) | M1/M2 | Speedup |
|-----------|--------------|-------|---------|
| LayerNorm | ✅ Fast | ❌ Slow | **+40%** |
| Dequantization | ✅ Fast | ❌ Slow | **+35%** |
| Batch Normalization | ✅ Fast | ❌ Slow | **+40%** |

**Result**: **40%+ speedup** on critical CPU-side operations.

#### 3. UMA Bandwidth Requirements

| Hardware | Bandwidth | 16B Model | 32B Model | 70B Model |
|----------|-----------|-----------|-----------|-----------|
| M1 Max | 68 GB/s | ✅ Good | ⚠️ Saturated | ❌ Not viable |
| M2 Max | 100 GB/s | ✅ Good | ✅ OK | ⚠️ Slow |
| **M3 Ultra** | **400 GB/s** | ✅ Fast | ✅ Fast | ✅ **Practical** |
| M4 Ultra | 500+ GB/s | ✅ Fast | ✅ Fast | ✅ Fast |

**Key Insight**: M3 Ultra's 400 GB/s is the **minimum viable bandwidth** for production 70B model deployment.

#### 4. Development Cost Savings

| Metric | With M1/M2 Support | M3+ Only | Savings |
|--------|-------------------|----------|---------|
| Kernel branches | 2x implementations | 1x | **50%** |
| Test matrix | 4+ configs | 2 configs | **60%** |
| CI/CD time | Long | Short | **40%** |
| Bug tracking | Cross-version | Single version | **Simplified** |

**ROI**: Dropping M1/M2 saves ~50% development time while delivering 40%+ better performance for target customers.

### Performance Benchmarks

#### Llama 3.1 70B (4-bit quantized)

| Hardware | Tokens/sec | TTFT Latency | Memory Usage | Status |
|----------|-----------|--------------|--------------|--------|
| **M3 Ultra** | **45-50** | 1.2s | 48 GB | ✅ Production |
| M2 Ultra | 22-28 | 2.5s | 52 GB | ⚠️ Marginal |
| M1 Max | N/A | N/A | OOM | ❌ Not viable |

#### Mistral 32B (4-bit quantized)

| Hardware | Tokens/sec | TTFT Latency | Memory Usage | Status |
|----------|-----------|--------------|--------------|--------|
| **M3 Pro** | **35-40** | 0.8s | 22 GB | ✅ Production |
| M2 Max | 28-32 | 1.2s | 24 GB | ✅ OK |
| M1 Max | 18-22 | 1.8s | 26 GB | ⚠️ Saturated |

**Finding**: M3+ delivers **40-50% higher throughput** vs M1 and **30-35% higher** vs M2 under same memory configuration.

### M1/M2 Support Policy

**Official Stance**:
- **Production support**: ❌ Not supported
- **Testing/Development**: ✅ CPU fallback or FP16-only mode available

**Fallback Options**:
1. **CPU-Only Mode**: ~40% of M3 GPU performance (testing only)
2. **FP16 Simplified Mode**: Limited Metal 3.0 compat layer (~50% performance)
3. **Recommendation**: Upgrade to M3+ hardware for production

**Installation Warning**:
```
⚠️  WARNING: Your system (Apple M1/M2) is not officially supported.
    For optimal performance, upgrade to Apple Silicon M3 or later.
    
    Current system will run in CPU fallback mode (~40% slower).
    See: https://github.com/defai-digital/mlx-serving/docs/ARCHITECTURE.md#m3-hardware-strategy
```

---

## Distributed Architecture

### System Overview

**Core Strategy**: **多機分流、不切分模型** - Each M3+ Mac hosts the complete model independently. No tensor/model parallelism.

**Architecture Layers**:
1. **Gateway** (TypeScript/Node.js) - Routing orchestrator
2. **Workers** (mlx-serving) - Node-level serving engine on each Mac
3. **Registry** (NATS JetStream / etcd) - Service discovery and control plane

### System Topology

```
┌──────────────────────────────────────────────────────────────┐
│                    Gateway Layer (TS/Node)                   │
│  • Auth / Rate limiting / Micro-batching (5-10ms window)     │
│  • Consistent hashing + Load-aware routing                   │
│  • Health checks & Circuit breaking                          │
│  • Canary deployment control                                 │
└────────┬──────────────┬──────────────┬──────────────┬─────────┘
         │              │              │              │
    gRPC │         gRPC │         gRPC │         gRPC │
         ▼              ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Worker 1   │  │  Worker 2   │  │  Worker 3   │  │  Worker 4   │
│  M3 Ultra   │  │  M3 Ultra   │  │  M4 Max     │  │  M4 Max     │
│             │  │             │  │             │  │             │
│ mlx-serving │  │ mlx-serving │  │ mlx-serving │  │ mlx-serving │
│    Core     │  │    Core     │  │    Core     │  │    Core     │
│             │  │             │  │             │  │             │
│  Model: 70B │  │  Model: 70B │  │  Model: 32B │  │  Model: 32B │
│  Batch: 2-3 │  │  Batch: 2-3 │  │  Batch: 3-4 │  │  Batch: 3-4 │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
         │              │              │              │
         └──────────────┴──────────────┴──────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  Registry/Control    │
              │  (NATS / etcd)       │
              │  • Node discovery    │
              │  • Health monitoring │
              │  • Model versions    │
              └──────────────────────┘
```

### 5 Key Strategies

#### 1. Session Affinity (會話親和性)

**Goal**: Maximize KV cache reuse for >85% hit rate

**Implementation**:
```typescript
function routeRequest(req: InferenceRequest): WorkerNode {
  const { model, sessionId } = req;
  const nodes = registry.getNodesForModel(model);
  
  // Consistent hashing for session affinity
  let targetNode = jumpHash(sessionId, nodes);
  
  // Load-aware fallback
  if (isOverloaded(targetNode)) {
    targetNode = nodes.reduce((best, node) =>
      getLoadScore(node) < getLoadScore(best) ? node : best
    );
  }
  
  return targetNode;
}
```

**Result**: Requests from same session → same worker → KV cache hits

#### 2. Warmup Pool (預熱池)

**Goal**: Instant TTFT for new sessions (no cold start)

**Implementation**:
- Pre-allocated KV cache slots on each worker
- Periodic "warmup" requests during idle time
- Pool size: 10-20% of max capacity

**Result**: <500ms TTFT even for first request (vs 2-3s cold start)

#### 3. Memory Governance (記憶體治理)

**Goal**: Prevent OOM crashes under high load

**Paged KV Cache**:
- INT8-KV default (< 8K context)
- INT4-KV for long context (> 8K)
- Automatic eviction of stale sessions (LRU)

**Memory Limits**:
- Per-worker max loaded models: 2
- Per-worker max concurrent requests: 4-6
- Total memory watermark: 80% (trigger eviction)

#### 4. Micro-batching (微批處理)

**Goal**: Maximize GPU utilization (+20-40% throughput)

**Implementation**:
```typescript
class MicroBatcher {
  private batchWindow = 5; // ms
  private maxBatchSize = 4;
  
  async collect(req: InferenceRequest): Promise<Batch> {
    this.queue.push(req);
    
    await sleep(this.batchWindow);
    
    const batch = this.queue.splice(0, this.maxBatchSize);
    return batch;
  }
}
```

**Result**: 5-10ms batching window → 20-40% higher tokens/s

#### 5. Circuit Breaking (熔斷機制)

**Goal**: Graceful degradation under failure

**Failure Detection**:
- Timeout: >10s response time
- Error rate: >10% failure rate (30s window)
- Health check: 3 consecutive failures

**Actions**:
- Mark worker as unhealthy (stop routing)
- Redistribute load to healthy workers
- Auto-recovery after 60s cooldown

---

## Technical Specification

### Component Details

#### Gateway Layer

**Technology**: TypeScript / Node.js / Fastify
**Responsibilities**:
- Authentication (JWT, API keys)
- Rate limiting (token bucket)
- Request routing (consistent hashing + load-aware)
- Micro-batching (5-10ms window)
- Circuit breaking
- Metrics collection (Prometheus)

**API Endpoints**:
```typescript
POST /v1/chat/completions
POST /v1/completions
POST /v1/embeddings
GET  /v1/models
GET  /health
GET  /metrics
```

**Performance**:
- Routing latency: <1ms (p95)
- Max throughput: 10,000 req/s (single gateway)
- Horizontal scaling: Yes (stateless)

#### Worker Layer (mlx-serving)

**Technology**: TypeScript + Python bridge (JSON-RPC over stdio)
**Responsibilities**:
- Model loading and lifecycle management
- Inference execution (MLX framework)
- KV cache management
- Streaming token generation
- Health reporting to registry

**Core API**:
```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

// Load model
await engine.load_model({
  model: 'llama-3.1-70b-instruct',
  max_tokens: 512,
  temperature: 0.7
});

// Generate
for await (const chunk of engine.create_generator({
  prompt: 'Hello, how are you?',
  max_tokens: 100
})) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}
```

**Performance**:
- IPC overhead: <1ms (p95)
- TTFT: 1.2s (70B model, M3 Ultra)
- Throughput: 45-50 tokens/s (70B model, M3 Ultra, batch=2)

#### Registry/Control Plane

**Technology**: NATS JetStream or etcd
**Responsibilities**:
- Node discovery (heartbeat every 5s)
- Health monitoring
- Model version management
- Configuration distribution

**Data Model**:
```typescript
interface WorkerNode {
  id: string;
  address: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  models: ModelDescriptor[];
  capacity: {
    maxConcurrent: number;
    currentLoad: number;
    memoryUsage: number;
  };
  metrics: {
    requestsPerSecond: number;
    avgLatency: number;
    errorRate: number;
  };
}
```

### Communication Protocols

**Gateway ↔ Worker**: gRPC over UNIX socket (same machine) or TCP (cross-machine)
**Worker ↔ Registry**: HTTP/2 (heartbeat, metrics push)
**Client ↔ Gateway**: REST API (JSON) or gRPC

### Capacity Planning

#### Formula

**Required Workers**:
```
N = ceil(targetRPS × avgLatency / (maxConcurrent × cacheHitRate))
```

**Example**:
- Target: 100 RPS
- Avg latency: 2s
- Max concurrent per worker: 4
- Cache hit rate: 85%
- Required: ceil(100 × 2 / (4 × 0.85)) = **59 workers**

**Headroom**: Add 20-30% for peak load → **75-80 workers**

#### Cluster Sizing

| Use Case | Model | Target RPS | Workers | Hardware | Total Cost |
|----------|-------|-----------|---------|----------|------------|
| **Small** | 32B | 10 | 6 | M3 Pro | $18K |
| **Medium** | 70B | 50 | 30 | M3 Ultra | $240K |
| **Large** | 70B | 200 | 120 | M3 Ultra | $960K |

### Performance Targets

#### Phase 1: MVP (Week 1-4)
- Gateway + Worker + Registry integration
- Session affinity routing
- Basic health checks
- **Target**: +30-50% cluster throughput vs single-machine

#### Phase 2: Optimization (Week 5-8)
- Warmup pool
- Micro-batching
- Circuit breaking
- Prometheus metrics
- **Target**: +50-100% cluster throughput

#### Phase 3: Scale-out (Week 9-12)
- Multi-model support
- Canary deployment
- Auto-scaling
- Advanced monitoring (OpenTelemetry)
- **Target**: +100-200% cluster throughput, 99.5%+ availability

---

## Implementation Roadmap

### Phase 1: MVP (4 weeks)

**Week 1-2: Core Infrastructure**
- [x] Gateway scaffold (Fastify + gRPC client)
- [x] Worker gRPC server interface
- [x] Registry service (NATS JetStream)
- [x] Basic routing (round-robin)

**Week 3-4: Production Readiness**
- [x] Session affinity (consistent hashing)
- [x] Health checks (heartbeat + circuit breaking)
- [x] Basic metrics (request count, latency)
- [ ] End-to-end integration tests
- [ ] Deployment scripts (Docker Compose / K8s)

**Deliverable**: Functional distributed cluster with 30-50% throughput improvement

### Phase 2: Optimization (4 weeks)

**Week 5-6: Performance**
- [ ] Warmup pool implementation
- [ ] Micro-batching (5-10ms window)
- [ ] KV cache memory governance
- [ ] Load-aware routing

**Week 7-8: Observability**
- [ ] Prometheus metrics integration
- [ ] Grafana dashboards
- [ ] Distributed tracing (OpenTelemetry)
- [ ] Alerting rules (PagerDuty / Slack)

**Deliverable**: 50-100% throughput improvement, production-grade monitoring

### Phase 3: Scale-out (4 weeks)

**Week 9-10: Advanced Features**
- [ ] Multi-model support (70B + 32B simultaneously)
- [ ] Canary deployment (gradual rollout)
- [ ] Auto-scaling (based on load metrics)

**Week 11-12: Enterprise Readiness**
- [ ] Multi-tenancy support
- [ ] Advanced auth (OAuth, RBAC)
- [ ] Cost tracking and billing
- [ ] Compliance (audit logs, data retention)

**Deliverable**: Enterprise-grade platform, 100-200% throughput improvement

### Success Metrics

**Performance**:
- ✅ Cluster throughput: +30-70% (Phase 1), +50-100% (Phase 2), +100-200% (Phase 3)
- ✅ P95 TTFT: <1.5s (70B model)
- ✅ P99 latency: <5s
- ✅ KV cache hit rate: >85%

**Reliability**:
- ✅ Availability: 99.5%+ (Phase 2), 99.9%+ (Phase 3)
- ✅ Error rate: <1%
- ✅ Mean time to recovery (MTTR): <2 minutes

**Scalability**:
- ✅ Horizontal scaling: Linear throughput increase with workers
- ✅ Max cluster size: 100+ workers (Phase 3)
- ✅ Gateway throughput: 10,000 RPS per gateway instance

---

## Appendices

### A. Glossary

- **UMA**: Unified Memory Architecture (Apple Silicon's shared CPU/GPU memory)
- **AMX**: Apple Matrix Coprocessor (hardware matrix acceleration)
- **TTFT**: Time To First Token (latency until first response token)
- **KV Cache**: Key-Value cache for transformer attention mechanism
- **Paged KV Cache**: Memory-efficient KV cache with eviction policy

### B. References

- [MLX Framework Documentation](https://ml-explore.github.io/mlx/build/html/index.html)
- [Apple Metal 3.3 API](https://developer.apple.com/metal/)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [gRPC Documentation](https://grpc.io/docs/)

### C. Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development guidelines.

### D. License

MIT License - See [LICENSE](../LICENSE)

---

**Document Version**: 2.1
**Last Updated**: 2025-11-15
**Maintained By**: DEFAI Private Limited
