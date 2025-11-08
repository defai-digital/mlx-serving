# Phase 3 Implementation Guide: Production Hardening

mlx-serving Performance Optimization Phase 3 — Production-grade infrastructure for sustained 120–150% throughput at high concurrency.

---

## 1. Executive Summary

Phase 3 hardens mlx-serving for production at scale by introducing four specialized subsystems: **ConnectionPool** (persistent IPC connection reuse), **StreamingController** (chunk-aware backpressure), **ModelLifecycleManager** (memory-efficient auto-unload), and **RollingRestartCoordinator** (zero-downtime upgrades). Together, these components eliminate connection overhead, prevent head-of-line blocking, reduce idle memory footprint, and enable rolling restarts without dropped requests—enabling sustained 120–150% of mlx-engine throughput at 100+ concurrent users while maintaining 100% request success rate.

---

## 2. Component Specifications

### 2.1 ConnectionPool

**Purpose**: Reuse persistent Python IPC/HTTP connections across requests instead of creating new ones per RPC call. Eliminates handshake overhead and improves utilization of the Python worker pool.

**Key Features**:
- Maintain warm pool of named pipes (IPC) or HTTP sockets per worker
- Health checks via heartbeat frames every 5s (configurable)
- Auto-replacement of dead connections with exponential backoff
- Leak detection: warn if pool size exceeds threshold for 60s
- Metrics: connection reuse rate, pool utilization, leak events
- Support for multiple connection strategies (IPC, HTTP, Unix socket)

**Configuration Interface**:
```typescript
interface ConnectionPoolConfig {
  enabled: boolean;
  strategy: 'ipc' | 'http' | 'unix-socket';  // Default: 'ipc'
  poolSize: number;                           // Per worker (default: 10)
  minPoolSize: number;                        // Min warm connections (default: 2)
  healthCheckIntervalMs: number;              // Heartbeat interval (default: 5000)
  connectionTimeoutMs: number;                // Timeout for new connection (default: 5000)
  maxLeakDetectionMs: number;                 // Leak warning threshold (default: 60000)
  idleTimeoutMs: number;                      // Close idle > N ms (default: 300000)
  logger?: Logger;
}
```

**Public API Signatures**:
```typescript
// Core lifecycle
connect(): Promise<Connection>;               // Acquire connection from pool
release(conn: Connection): void;              // Return connection to pool (or close if dead)
destroy(): Promise<void>;                     // Close all connections

// Health & diagnostics
getPoolStatus(): PoolStatus;                  // { utilization, activeCount, idleCount }
getConnectionMetrics(): ConnectionMetrics;    // { reuseRate, avgLifetime, leakEvents }
forceHealthCheck(): Promise<HealthCheckResult>;
```

**Integration Points**:
- **RuntimeRouter** (Phase 2): Request routing selects a worker, then ConnectionPool hands out a connection
- **JSONRPCTransport** (Phase 1): Uses pooled connections instead of creating per-request
- **CircuitBreaker** (Phase 2): Marks pooled connections dead on failures; pool auto-replaces

**Success Criteria**:
- Connection reuse rate > 90% under sustained load (100+ concurrent)
- Zero connection leaks after 10K requests
- Pool health check latency < 50ms (P95)

---

### 2.2 StreamingController

**Purpose**: Aggregate incoming tokens into 64KB chunks, implement buffer-aware backpressure, and prevent head-of-line blocking when consumers are slow. Decouples producer (Python worker) from consumer (client).

**Key Features**:
- Chunk aggregation: buffer tokens until 64KB boundary or timeout (100ms)
- Backpressure signaling: pause token production if client falls behind
- Flow control: track unacked chunks, enforce max_unacked_chunks limit
- Slow consumer detection: warn if chunk delivery latency > 1s
- Automatic resume: restart token flow when client catches up
- Per-stream metrics: throughput (tok/s), latency percentiles, cancellation rates

**Configuration Interface**:
```typescript
interface StreamingControllerConfig {
  enabled: boolean;
  chunkSizeBytes: number;                     // Aggregation boundary (default: 65536)
  chunkTimeoutMs: number;                     // Max wait for chunk (default: 100)
  maxUnackedChunks: number;                   // Backpressure threshold (default: 100)
  ackTimeoutMs: number;                       // Timeout waiting for ACK (default: 5000)
  slowConsumerThresholdMs: number;            // Warn if latency > N (default: 1000)
  metricsExportIntervalMs: number;            // Metric export freq (default: 10000)
  logger?: Logger;
}
```

**Public API Signatures**:
```typescript
// Core operations
registerStream(streamId: string, consumer: StreamConsumer): void;
enqueueToken(streamId: string, token: Token): Promise<void>;  // May block on backpressure
ackChunk(streamId: string, chunkId: string): void;           // Client confirms receipt
unregisterStream(streamId: string): void;                     // Cleanup after completion

// Diagnostics
getStreamStatus(streamId: string): StreamStatus;             // { queuedTokens, ackedChunks, latencyP95 }
getControllerMetrics(): ControllerMetrics;                   // { avgChunkSize, backpressureEvents, slowConsumers }
```

**Integration Points**:
- **GenerateBatcher** (Phase 1): After batch completes, tokens flow through StreamingController
- **StreamRegistry** (Phase 1): Registers consumers and signals when client closes
- **RuntimeRouter** (Phase 2): Maps streams to workers; pools report consumer backpressure upward

**Success Criteria**:
- P95 chunk delivery latency < 120ms under 100 concurrent streams
- Zero head-of-line blocking (verified by per-stream latency fairness)
- Backpressure events < 1% of chunks (normal operation)

---

### 2.3 ModelLifecycleManager

**Purpose**: Automatically unload idle models from GPU memory after configurable timeout, and predictively pre-warm frequently accessed models. Reduces memory footprint and improves latency for warm-start requests.

**Key Features**:
- Idle detection: track model access timestamps, unload if unused > timeout (default: 5min)
- Predictive prefetch: analyze request patterns, pre-load likely-next models during idle periods
- LRU warmup: keep N most-recently-used models hot (default: 5)
- Graceful unload: drains in-flight requests before unloading model
- Metrics: load times (cold/warm), unload events, prefetch hit rate, memory usage
- Per-model overrides: some models can be pinned (never unload)

**Configuration Interface**:
```typescript
interface ModelLifecycleManagerConfig {
  enabled: boolean;
  idleTimeoutMs: number;                      // Unload if unused > N (default: 300000)
  maxLoadedModels: number;                    // Max models in memory (default: 5)
  prefetchEnabled: boolean;                   // Enable predictive prefetch (default: true)
  prefetchMinConfidence: number;              // Min confidence to prefetch (default: 0.7)
  warmupsOnStartup: string[];                 // Models to preload on engine start
  pinnedModels: string[];                     // Models never to unload
  drainTimeoutMs: number;                     // Max time to drain requests (default: 30000)
  logger?: Logger;
}
```

**Public API Signatures**:
```typescript
// Lifecycle operations
markModelAccessed(modelId: string): void;     // Signal model was just used
preloadModel(modelId: string): Promise<void>; // Eagerly load model
unloadModel(modelId: string): Promise<void>;  // Force unload (drains first)
startWarmupCycle(): Promise<void>;            // Warm up startup models

// Diagnostics
getModelStatus(modelId: string): ModelStatus; // { loaded, lastAccessedMs, inFlightRequests }
getLifecycleMetrics(): LifecycleMetrics;      // { avgColdLoadMs, avgWarmLoadMs, unloadCount, prefetchHitRate }
getPrefetchPredictions(): Prediction[];       // Top 5 likely-next models
```

**Integration Points**:
- **ModelManager** (Phase 1): After model.load(), lifecycle manager tracks it and schedules unloads
- **RuntimeRouter** (Phase 2): Calls markModelAccessed() when routing request to model
- **StreamRegistry** (Phase 1): Notifies lifecycle manager when stream completes (in-flight count updates)

**Success Criteria**:
- Idle model unload success rate 100% (no crashes)
- Warmup hit rate > 80% for top-5 models (verified via metrics)
- Memory footprint reduction 40–60% vs static pinning on large model sets (5+ models)
- Cold load latency vs warm load latency ratio < 2.5x

---

### 2.4 RollingRestartCoordinator

**Purpose**: Enable zero-downtime worker restarts by gracefully draining in-flight requests before replacing a worker, with coordinated startup of replacement. Prevents dropped requests during rolling upgrades.

**Key Features**:
- Drain phase: pause new requests to worker, allow in-flight to complete (timeout: 30s)
- Health gate: verify replacement worker is healthy before removing old one
- Request replay: if drain timeout, optional replay on new worker or fallback
- Coordinated startup: new worker waits for old one to fully drain before accepting traffic
- Metrics: drain time (per worker), timeout count, request replay rate, downtime (should be 0)
- Watchdog: ensure never below N active workers (circuit breaks restart if breached)

**Configuration Interface**:
```typescript
interface RollingRestartCoordinatorConfig {
  enabled: boolean;
  drainTimeoutMs: number;                     // Max time per worker (default: 30000)
  minActiveWorkers: number;                   // Safety minimum (default: 1)
  preflightCheckEnabled: boolean;             // Health check before removing old (default: true)
  preflightTimeoutMs: number;                 // Preflight deadline (default: 5000)
  requestReplayEnabled: boolean;              // Replay on new worker if timeout (default: true)
  maxReplayAttempts: number;                  // Replay retry limit (default: 1)
  watchdogIntervalMs: number;                 // Enforce min workers (default: 5000)
  logger?: Logger;
}
```

**Public API Signatures**:
```typescript
// Restart orchestration
initiateRollingRestart(): Promise<RestartResult>;           // Start coordinated restart
drainWorker(workerId: string): Promise<DrainResult>;        // Drain single worker
checkWorkerHealth(workerId: string): Promise<HealthStatus>; // Preflight check

// Diagnostics
getRestartStatus(): RestartStatus;            // { phase, completedWorkers, activeWorkers, timeElapsed }
getCoordinatorMetrics(): CoordinatorMetrics;  // { totalRestarts, avgDrainTime, timeoutCount, dropCount }
getWorkerDrainStatus(workerId: string): DrainStatus; // { queuedRequests, drained, timeoutAt }
```

**Integration Points**:
- **PythonRuntimeManager** (Phase 2): Calls initiateRollingRestart() to spawn replacement worker
- **RuntimeRouter** (Phase 2): Respects worker drain status; stops sending new requests to draining worker
- **CircuitBreaker** (Phase 2): Marks draining worker as temporarily unavailable
- **StreamRegistry** (Phase 1): Tracks in-flight stream count per worker

**Success Criteria**:
- Zero dropped requests during rolling restart (verified via request logging)
- P50 drain time < 5s, P95 < 15s under 100 concurrent load
- Failover time < 2s (time between removing old worker and new worker accepting traffic)
- Watchdog prevents dip below min_active_workers (verified via metrics)

---

## 3. Architecture Overview

### 3.1 Component Interaction

**Request Flow with Phase 3**:

```
Client Request
    ↓
[StreamRegistry] → Request dedup/coalesce (Phase 1) → Adaptive batcher (Phase 2)
    ↓
[RuntimeRouter] → Select worker (Phase 2) → Check worker health
    ↓
[ConnectionPool] → Get or create pooled connection
    ↓
[JSONRPCTransport] → Send RPC via pooled conn → Python worker
    ↓
[GenerateBatcher] → Batch response tokens (Phase 1)
    ↓
[StreamingController] → Aggregate → 64KB chunks → Backpressure control
    ↓
[ModelLifecycleManager] → Mark model accessed → Schedule prefetch
    ↓
Client receives streaming chunks
    ↓
[RollingRestartCoordinator] (async) → Monitor in-flight, schedule unload if idle
```

### 3.2 Integration with Phase 1 & 2

**Phase 1 Dependencies**:
- ConnectionPool uses JSONRPCTransport (replaced per-call creation with pooled reuse)
- StreamingController feeds tokens from GenerateBatcher into 64KB chunked output
- ModelLifecycleManager tracks model loads triggered by ModelManager

**Phase 2 Dependencies**:
- ConnectionPool manages one pool per RuntimeRouter-selected worker
- StreamingController receives worker assignment from RuntimeRouter
- RollingRestartCoordinator coordinates with PythonRuntimeManager for worker lifecycle
- ModelLifecycleManager marks models accessed per RuntimeRouter routing decision

**Phase 3 Cross-Component**:
- ConnectionPool ← → StreamingController: pooled conn reports backpressure to producer
- RollingRestartCoordinator ← → StreamRegistry: draining worker checks stream count
- ModelLifecycleManager ← → RuntimeRouter: prefetch triggers model preload before request arrives

### 3.3 Timing & Sequencing

- **Startup**: Engine loads config, starts ModelLifecycleManager warmup, initializes ConnectionPool min pool size per worker
- **Request arrival**: StreamRegistry dedupe (Phase 1) → adaptive batch (Phase 2) → RuntimeRouter picks worker → ConnectionPool handout → RPC → token stream → StreamingController → client chunks
- **Idle period**: ModelLifecycleManager scans last-access timestamps, unloads candidates, prefetches top-5 likely next
- **Upgrade**: Admin triggers RollingRestartCoordinator → drains each worker sequentially → preflight checks new worker → removes old → repeat until all workers replaced

---

## 4. Configuration Schema

### 4.1 `runtime.yaml` Additions (Phase 3)

```yaml
# Phase 3: Connection Pooling
connection_pool:
  enabled: true                    # Enable persistent connection reuse
  strategy: 'ipc'                  # 'ipc' | 'http' | 'unix-socket'
  pool_size: 10                    # Connections per worker
  min_pool_size: 2                 # Min warm connections
  health_check_interval_ms: 5000   # Heartbeat frequency
  connection_timeout_ms: 5000      # New connection deadline
  max_leak_detection_ms: 60000     # Leak warning threshold (1 minute)
  idle_timeout_ms: 300000          # Close idle > 5 minutes

# Phase 3: Streaming Optimizations
streaming_controller:
  enabled: true                    # Enable chunk aggregation & backpressure
  chunk_size_bytes: 65536          # 64KB aggregation boundary
  chunk_timeout_ms: 100            # Max wait for chunk
  max_unacked_chunks: 100          # Backpressure threshold
  ack_timeout_ms: 5000             # ACK deadline
  slow_consumer_threshold_ms: 1000 # Slow consumer warning
  metrics_export_interval_ms: 10000

# Phase 3: Model Lifecycle Management
model_lifecycle_manager:
  enabled: true                    # Enable auto-unload & prefetch
  idle_timeout_ms: 300000          # Unload if unused > 5 minutes
  max_loaded_models: 5             # Max models in memory (LRU)
  prefetch_enabled: true           # Predictive prefetching
  prefetch_min_confidence: 0.7     # Confidence threshold
  warmup_on_startup:               # Models to preload on engine start
    - 'mlx-community/gemma-3-4b-it-qat-4bit'
    - 'mlx-community/gemma-3-27b-it-qat-4bit'
  pinned_models: []                # Models never to unload (optional)
  drain_timeout_ms: 30000          # Max time to drain requests (30s)

# Phase 3: Zero-Downtime Restarts
rolling_restart_coordinator:
  enabled: true                    # Enable coordinated restarts
  drain_timeout_ms: 30000          # Max drain time per worker (30s)
  min_active_workers: 1            # Safety minimum active workers
  preflight_check_enabled: true    # Health check before switchover
  preflight_timeout_ms: 5000       # Preflight deadline (5s)
  request_replay_enabled: true     # Replay on new worker if drain timeout
  max_replay_attempts: 1           # Max replays per request
  watchdog_interval_ms: 5000       # Min worker enforcement frequency (5s)
```

### 4.2 Environment Overrides

```yaml
environments:
  production:
    connection_pool:
      pool_size: 20                # Higher concurrency
      health_check_interval_ms: 3000
    model_lifecycle_manager:
      idle_timeout_ms: 600000      # 10 minutes (longer for stable workloads)
      max_loaded_models: 10
    rolling_restart_coordinator:
      drain_timeout_ms: 45000      # 45s (more time for large models)
      min_active_workers: 2        # Never go below 2

  staging:
    rolling_restart_coordinator:
      preflight_check_enabled: true
      request_replay_enabled: true

  development:
    connection_pool:
      pool_size: 2
    model_lifecycle_manager:
      idle_timeout_ms: 60000       # 1 minute for quick iteration
      warmup_on_startup: []
```

---

## 5. Testing Strategy

### 5.1 Unit Tests

| Component | Test Focus | Success Criteria |
|-----------|-----------|------------------|
| **ConnectionPool** | Pool acquire/release, health check timing, leak detection, connection reuse counter | Reuse > 90%, leaks detected < 100ms after threshold, zero race conditions |
| **StreamingController** | Chunk aggregation boundary, backpressure trigger/resume, ACK timeout, slow consumer detection | Chunks ≤ 64KB boundary, backpressure events tracked, timeouts recorded |
| **ModelLifecycleManager** | Idle timeout trigger, prefetch confidence calculation, LRU eviction, drain completion | Unload after TTL ± 5%, prefetch top-5 consistency, drain completes |
| **RollingRestartCoordinator** | Drain sequencing, preflight health checks, min worker enforcement, request replay logic | Drains complete, no below-min violations, replays fail gracefully |

**Example test scenario** (ConnectionPool):
- Spawn worker, acquire 5 connections, verify pool.size == 5
- Release 3 connections, trigger health check, verify reused (reuse counter incremented)
- Simulate connection death, verify auto-replaced, pool.size stays == 5

### 5.2 Integration Tests

| Scenario | Test | Assertion |
|----------|------|-----------|
| **Concurrent streaming under backpressure** | 50 concurrent streams, slow client → backpressure → fast client catchup | No dropped tokens, P95 latency < 120ms after catchup |
| **Model auto-unload with in-flight requests** | Load model, make request, wait idle timeout → unload → new request | New request triggers reload, first request completes correctly |
| **Rolling restart with traffic** | 100 concurrent requests, trigger rolling restart, capture dropcount | Zero dropped requests, all complete successfully |
| **Connection pool leak detection** | Open/close 1K connections without release, observe metrics | Leak event fired at 60s threshold |

**Execution**: Spin up single Python worker + Node.js engine, run load generator, assert metrics.

### 5.3 Load Tests

**Benchmark Suite**:
- **Baseline (no Phase 3)**: 100 concurrent → measure tok/s, P95 latency, success rate
- **Phase 3 enabled**: Same 100 concurrent → expect ≥120% throughput, P95 < 120ms, 100% success
- **Rolling restart under load**: 100 concurrent, trigger rolling restart at T=30s → verify zero dropped requests
- **Model lifecycle** (5+ models): Continuous cycling through 8 models → verify memory stable at max_loaded_models, warmup hit rate > 80%

**Key Metrics**:
```
tokens/sec
P50, P95, P99 latency (ms)
Request success rate (%)
Connection reuse rate (%)
Model unload count / prefetch hit rate (%)
Drain time per worker (ms)
Zero-downtime restart incidents (0 is passing)
```

### 5.4 Chaos Testing

- **Worker crash mid-request**: Verify replayed on new worker or fallback
- **Network jitter on pooled connection**: Verify backpressure triggers, recovery
- **Slow client**: Verify backpressure prevents queue overflow
- **Model memory exhaustion**: Verify LRU eviction works, new models load correctly
- **Rolling restart with tight drain timeout**: Verify requests don't drop, requests don't exceed timeout

---

## 6. Rollout Plan

### 6.1 Phased Enablement

**Week 1**:
1. **Day 1**: Deploy ConnectionPool in shadow mode (collect metrics, no functional impact)
2. **Day 2–3**: Enable ConnectionPool on staging, verify zero connection leaks, reuse > 90%
3. **Day 4–5**: Canary rollout ConnectionPool to 10% of production traffic, monitor error rate

**Week 2**:
1. **Day 1**: Deploy StreamingController in shadow mode, collect baseline chunk metrics
2. **Day 2–3**: Enable on staging, verify P95 latency < 120ms, no slow consumer alarms
3. **Day 4–5**: Canary 10% production, monitor slow consumer events

**Week 3**:
1. **Day 1–2**: Deploy ModelLifecycleManager, verify no unload-during-request crashes
2. **Day 3–4**: Staging validation: prefetch hit rate, memory reduction, drain completions
3. **Day 5**: Canary 10% production

**Week 4**:
1. **Day 1–2**: Deploy RollingRestartCoordinator, rehearse in staging with load generator
2. **Day 3**: Canary 10% production under light traffic
3. **Day 4–5**: Canary 25%, run rolling restart during business hours (with on-call)

### 6.2 Success Gates (Each Component)

- **ConnectionPool**: Connection reuse > 90%, leak events == 0, error rate == baseline
- **StreamingController**: P95 latency < 120ms, slow consumer % < 1%, backpressure events nominal
- **ModelLifecycleManager**: Unload success 100%, prefetch hit > 80%, memory reduction 40–60%
- **RollingRestartCoordinator**: Zero dropped requests, drain completes < 30s, downtime == 0

### 6.3 Rollback Triggers

- Error rate spike > 0.5% → rollback component
- P95 latency increase > 20% vs baseline → investigate, rollback if unrelated to expected improvement
- Metric exporter crashes → rollback metrics collection first
- Min active worker violations → immediately rollback RollingRestartCoordinator

### 6.4 Documentation

- **Admin runbooks**: How to enable/disable each component, interpret metrics dashboards
- **Troubleshooting guide**: Common issues (e.g., slow consumer warnings, drain timeouts), remediation steps
- **Metric reference**: What each metric means, healthy ranges, alerting thresholds
- **Feature flags**: Runtime configuration reference with examples

---

## 7. Success Criteria (Phase 3)

| Criterion | Target | Verification |
|-----------|--------|--------------|
| Throughput at 100 concurrent users | ≥120% of mlx-engine | Benchmark: tok/s comparison |
| P95 latency | < 120ms | Load test: percentile histogram |
| Request success rate | 100% | Integration test: zero dropped requests |
| Zero-downtime restart | 0 dropped requests | Chaos test: count during rolling restart |
| Connection reuse rate | > 90% | Metric: pool_reuse_rate_percent |
| Model lifecycle unload success | 100% | Metric: model_unload_count vs crashes |
| Model prefetch hit rate | > 80% for top-5 | Metric: model_prefetch_hit_rate_percent |
| Memory footprint reduction | 40–60% vs static pinning | Compare memory usage 5+ models loaded |

---

## 8. Feature Flags & Runtime Control

All Phase 3 components can be disabled individually via `runtime.yaml`:

```yaml
# Disable single component for troubleshooting
connection_pool:
  enabled: false  # Fall back to per-request connections

streaming_controller:
  enabled: false  # Skip chunk aggregation (larger messages, higher latency)

model_lifecycle_manager:
  enabled: false  # Keep all models loaded (memory penalty)

rolling_restart_coordinator:
  enabled: false  # Manual restart required (downtime expected)
```

**Impact when disabled**:
- ConnectionPool off: Higher IPC latency (per-request handshake)
- StreamingController off: Larger, less frequent chunks (reduced backpressure control)
- ModelLifecycleManager off: Models never auto-unloaded (memory growth over time)
- RollingRestartCoordinator off: Restarts block traffic (downtime unavoidable)

---

## 9. Monitoring & Observability

### 9.1 Key Metrics (Prometheus)

```
# ConnectionPool
mlx_serving_connection_pool_size{worker_id, state=[active|idle]}
mlx_serving_connection_reuse_total{worker_id}
mlx_serving_connection_leak_events_total{worker_id}
mlx_serving_connection_avg_lifetime_seconds{worker_id}

# StreamingController
mlx_serving_streaming_chunk_bytes{quantile, stream_id}
mlx_serving_streaming_backpressure_events_total{stream_id}
mlx_serving_streaming_slow_consumer_events_total{stream_id}
mlx_serving_streaming_ack_latency_milliseconds{quantile}

# ModelLifecycleManager
mlx_serving_model_load_time_ms{model_id, cold_or_warm}
mlx_serving_model_unload_total{model_id, success_or_failure}
mlx_serving_model_memory_bytes{model_id}
mlx_serving_model_prefetch_hit_rate_percent

# RollingRestartCoordinator
mlx_serving_rolling_restart_drain_time_ms{worker_id, quantile}
mlx_serving_rolling_restart_timeout_events_total
mlx_serving_rolling_restart_replay_total{success_or_failure}
mlx_serving_rolling_restart_downtime_seconds_total
```

### 9.2 Alerts

| Alert | Condition | Action |
|-------|-----------|--------|
| High Connection Leak Rate | leak_events > 10/min | Check ConnectionPool config, investigate worker stability |
| Backpressure Excessive | backpressure_events > 5% of chunks | Check client network, consider reducing chunk timeout |
| Model Prefetch Hit Low | hit_rate < 60% for 5 min | Review model access patterns, adjust warmup list |
| Rolling Restart Drain Timeout | drain_time > 30s for any worker | Review in-flight request count, increase timeout or investigate slow requests |
| Min Active Workers Breached | active_workers < min for any period | Immediate rollback, investigate RollingRestartCoordinator |

### 9.3 Grafana Dashboard Panels

- **Connection Pool Status**: Reuse rate (%), active/idle pool sizes, leak event timeline
- **Streaming Health**: Backpressure event frequency, ACK latency P95, slow consumer count
- **Model Lifecycle**: Loaded model count, unload event log, prefetch hit rate, memory usage
- **Rolling Restart Status**: Worker drain times, timeout count, downtime counter (should stay 0)

---

## 10. Future Extensions

- **Phase 4 (future)**: Adaptive chunk sizing (dynamic boundary vs static 64KB), per-client rate limiting
- **Phase 4 (future)**: Predictive model prefetch via ML analysis of request patterns
- **Phase 4 (future)**: Distributed connection pooling across multiple node processes (horizontal scaling)

---

## Appendix A: Component Dependencies Summary

```
ConnectionPool
├─ JSONRPCTransport (reuses pooled connections)
├─ RuntimeRouter (one pool per worker selection)
└─ CircuitBreaker (marks dead connections)

StreamingController
├─ GenerateBatcher (receives tokens to aggregate)
├─ StreamRegistry (registers consumers)
└─ RuntimeRouter (maps streams to workers)

ModelLifecycleManager
├─ ModelManager (tracks model loads)
├─ RuntimeRouter (marks model accessed)
└─ StreamRegistry (in-flight request count per worker)

RollingRestartCoordinator
├─ PythonRuntimeManager (spawns replacement workers)
├─ RuntimeRouter (drains routing to worker)
├─ CircuitBreaker (marks worker unavailable during drain)
└─ StreamRegistry (in-flight count per worker)
```

---

## Appendix B: Glossary

- **Connection Pool**: Persistent IPC/HTTP sockets reused across RPC calls
- **Backpressure**: Signal from consumer to producer to slow down token delivery
- **Head-of-Line Blocking**: First request in queue blocks others (prevented by StreamingController)
- **Idle Timeout**: Duration of inactivity before auto-unloading model from GPU
- **Prefetch**: Proactively loading likely-next models during idle periods
- **Drain**: Gracefully stopping new requests to a worker while completing in-flight ones
- **Rolling Restart**: Sequential worker upgrades without dropped requests (zero-downtime)
- **Watchdog**: Background process ensuring safety invariants (e.g., min_active_workers)
- **TTFT**: Time to First Token (latency from request start to first response chunk)

---

**Document Status**: Phase 3 Specification (2025-11-08)
**Total Expected Implementation**: ~1,500 lines (across 4 modules)
**Target Deployment**: Week 4 of Phase 3 (production canary)
