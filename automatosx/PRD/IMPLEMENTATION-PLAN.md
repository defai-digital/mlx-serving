# mlx-serving Performance Optimization - Implementation Plan

**Version**: 1.0
**Date**: 2025-11-07
**Status**: Ready for Execution
**Target**: 120-150% of mlx-engine performance

---

## Executive Summary

This implementation plan translates the PRD and Architecture Plan into actionable tasks across 3 phases over 24 days. Each phase delivers measurable performance improvements while maintaining 100% reliability.

**Current State**: 96% performance parity (Qwen3-30B: 87.73 tok/s vs mlx-engine's 90.99 tok/s)
**Target State**: 120-150% performance with production-grade features
**Approach**: Incremental delivery with feature flags, comprehensive testing, and rollback safety

---

## Phase 0: Preparation (Days 0-1) - FOUNDATION

### Goal
Set up infrastructure for safe, measurable optimization rollout.

### Tasks

#### Day 0: Configuration & Baseline
- [ ] **Task 0.1**: Create configuration infrastructure
  - File: `config/runtime.yaml`
  - Add schema validation: `config/schema/runtime.schema.json`
  - Update loader: `src/config/loader.ts`
  - Add env mapping: `src/config/env.ts`
  - **Acceptance**: Config loads with default safe values
  - **Time**: 2 hours

- [ ] **Task 0.2**: Capture performance baseline
  - Run: `npm run bench:throughput -- --models gemma-2-27b-it-4bit,qwen3-30b`
  - Save: `benchmarks/results/baseline-2025-11-07.json`
  - Document: GPU utilization, TTFT, P95/P99 latency, tok/s
  - **Acceptance**: Reproducible baseline established
  - **Time**: 1 hour

- [ ] **Task 0.3**: Set up observability infrastructure
  - Update: `src/telemetry/otel.ts` with new metric definitions
  - Add counters: `mlx_cache_hits`, `mlx_cache_misses`
  - Add histograms: `mlx_batch_size`, `mlx_batch_latency_ms`
  - Add gauges: `mlx_worker_active`, `mlx_connection_pool_available`
  - **Acceptance**: Metrics export to stdout/Prometheus
  - **Time**: 2 hours

#### Day 1: Testing & Documentation Setup
- [ ] **Task 0.4**: Create test infrastructure
  - Update: `package.json` with `test:perf-phase1` script
  - Create: `tests/fixtures/benchmark-prompts.ts` (standardized test prompts)
  - Create: `tests/helpers/performance-assertions.ts` (metric validators)
  - **Acceptance**: Test framework ready for Phase 1
  - **Time**: 2 hours

- [ ] **Task 0.5**: Set up feature flag system
  - Update: `src/config/runtime.ts` with `FeatureFlags` interface
  - Add runtime toggle support via environment variables
  - Create: `docs/operations/feature-flags.md` (runbook)
  - **Acceptance**: Can toggle features without code changes
  - **Time**: 2 hours

- [ ] **Task 0.6**: Create ADR template and initial ADRs
  - Create: `docs/architecture/adr/template.md`
  - Write: `docs/architecture/adr/ADR-012-request-deduplication.md` (PROPOSED)
  - Write: `docs/architecture/adr/ADR-013-prompt-cache.md` (PROPOSED)
  - Write: `docs/architecture/adr/ADR-014-request-coalescing.md` (PROPOSED)
  - **Acceptance**: ADRs ready for review
  - **Time**: 3 hours

**Phase 0 Exit Criteria**:
- ✅ Configuration system with schema validation
- ✅ Performance baseline captured and documented
- ✅ Observability metrics defined and exporting
- ✅ Test infrastructure ready
- ✅ Feature flags system operational
- ✅ ADRs written and under review

**Total Time**: 12 hours (1.5 days)

---

## Phase 1: Quick Wins (Days 2-3) - CACHING LAYER

### Goal
+10-30% throughput for duplicate-heavy workloads via TypeScript-side caching.

### Pre-flight Checklist
- [ ] Phase 0 complete with all exit criteria met
- [ ] ADRs 012-014 reviewed and approved
- [ ] Feature flags documented in runbook

### Implementation Tasks

#### Day 2 Morning: Request Deduplication (ADR-012)
- [ ] **Task 1.1**: Core deduplication logic
  - **Create**: `src/core/request-deduplicator.ts`
  ```typescript
  export interface RequestDeduplicator {
    get(key: string): Promise<GenerationResult> | undefined;
    set(key: string, promise: Promise<GenerationResult>): void;
    delete(key: string): void;
    size(): number;
    clear(): void;
  }
  ```
  - Implement TTL map with automatic eviction
  - Use SHA256 hash of `(model_id, prompt, params)` as key
  - Max entries configurable (default: 1000)
  - **Acceptance**: Unit tests pass with 100% coverage
  - **Time**: 3 hours
  - **Files**: `src/core/request-deduplicator.ts`, `tests/core/request-deduplicator.test.ts`

- [ ] **Task 1.2**: Integrate with generate-batcher
  - **Update**: `src/core/generate-batcher.ts`
  - Wrap `enqueue()` to check deduplicator first
  - Share Promise across duplicate requests
  - Handle rejection propagation (delete cache entry on error)
  - **Acceptance**: Integration tests show dedupe working
  - **Time**: 2 hours
  - **Files**: `src/core/generate-batcher.ts`, `tests/integration/generate-dedup.test.ts`

#### Day 2 Afternoon: Prompt Cache (ADR-013)
- [ ] **Task 1.3**: LRU cache implementation
  - **Create**: `src/core/prompt-cache.ts`
  ```typescript
  export interface PromptCache {
    get(fingerprint: string): CacheEntry | undefined;
    set(fingerprint: string, entry: CacheEntry): void;
    has(fingerprint: string): boolean;
    size(): number;
    stats(): CacheStats;
  }
  ```
  - Size-aware LRU (track tokens + bytes)
  - Configurable capacity (default: 10,000 entries)
  - TTL support (default: 5 minutes)
  - Optional persistence to `automatosx/tmp/prompt-cache.json`
  - **Acceptance**: Cache eviction works correctly under memory pressure
  - **Time**: 3 hours
  - **Files**: `src/core/prompt-cache.ts`, `tests/core/prompt-cache.test.ts`

- [ ] **Task 1.4**: Integrate prompt cache with generation service
  - **Update**: `src/core/generation-service.ts`
  - Check cache before Python call
  - Store successful completions
  - Add HTTP header: `x-mlx-cache-hit: true/false`
  - Emit metrics: `mlx_cache_hits`, `mlx_cache_misses`
  - **Acceptance**: Cache hit returns without Python call
  - **Time**: 2 hours
  - **Files**: `src/core/generation-service.ts`, `tests/integration/prompt-cache.test.ts`

#### Day 3 Morning: Request Coalescing (ADR-014)
- [ ] **Task 1.5**: Coalescing registry
  - **Create**: `src/core/coalescing-registry.ts`
  ```typescript
  export interface CoalescingRegistry {
    register(key: string, streamController: StreamController): void;
    getSubscribers(key: string): StreamController[];
    unregister(key: string): void;
    attachSubscriber(key: string, subscriber: StreamController): boolean;
  }
  ```
  - Map of in-flight request keys to shared stream controllers
  - Support multiple subscribers per key
  - Automatic cleanup on completion
  - **Acceptance**: Multiple subscribers receive same stream
  - **Time**: 3 hours
  - **Files**: `src/core/coalescing-registry.ts`, `tests/core/coalescing-registry.test.ts`

- [ ] **Task 1.6**: SSE stream multiplexing
  - **Update**: `src/core/stream-registry.ts`
  - Add `attachSubscriber(requestKey, streamId)` method
  - Clone SSE stream with ReadableStream.tee()
  - Add SSE event metadata: `sharedFromRequestId`
  - **Acceptance**: Late subscribers receive full stream
  - **Time**: 2 hours
  - **Files**: `src/core/stream-registry.ts`, `tests/integration/stream-coalescing.test.ts`

#### Day 3 Afternoon: Configuration & Testing
- [ ] **Task 1.7**: Configuration integration
  - **Update**: `config/runtime.yaml`
  ```yaml
  request_deduplication:
    enabled: false  # Feature flag
    ttl_ms: 1000
    max_entries: 1000
    max_payload_kb: 512

  prompt_cache:
    enabled: false  # Feature flag
    max_entries: 10000
    ttl_ms: 300000  # 5 minutes
    max_bytes: 104857600  # 100MB
    persistence: false

  request_coalescing:
    enabled: false  # Feature flag
    buffer_size_kb: 64
  ```
  - **Update**: `src/types/config.ts` with TypeScript types
  - **Update**: `src/config/loader.ts` with validation
  - **Acceptance**: Config loads and validates correctly
  - **Time**: 1 hour

- [ ] **Task 1.8**: Comprehensive testing
  - **Create**: `benchmarks/dedup_profile.ts` (load test)
  - **Create**: `tests/integration/phase1-end-to-end.test.ts`
  - Run benchmark: Gemma 2 27B with 20 identical prompts
  - Validate: >50% cache hit rate, 2x speedup on duplicates
  - **Acceptance**: All tests pass, benchmarks show improvement
  - **Time**: 3 hours

- [ ] **Task 1.9**: Documentation & runbook
  - **Update**: `docs/operations/feature-flags.md`
  - **Create**: `docs/operations/phase1-rollout.md` (step-by-step guide)
  - Document rollback procedure
  - **Acceptance**: Ops team can enable/disable features
  - **Time**: 1 hour

**Phase 1 Exit Criteria**:
- ✅ Request deduplication working with <1ms overhead
- ✅ Prompt cache achieving >80% hit rate on duplicate workloads
- ✅ Request coalescing merging identical concurrent requests (N→1)
- ✅ Benchmark shows ≥110% tok/s vs baseline for duplicate-heavy tests
- ✅ 100% test coverage for new modules
- ✅ Feature flags documented and tested
- ✅ ADRs 012-014 promoted to ACCEPTED status
- ✅ Zero regressions on non-duplicate workloads

**Total Time**: 20 hours (2.5 days)

---

## Phase 2: Advanced Scaling (Days 4-10) - MULTI-WORKER

### Goal
+5-15% overall throughput via multi-worker routing and adaptive batching.

### Pre-flight Checklist
- [ ] Phase 1 complete and running in production for 24h without issues
- [ ] Phase 1 benchmarks validated (≥110% for duplicate workloads)
- [ ] ADRs 015-017 reviewed and approved

### Implementation Tasks

#### Day 4-5: Multi-Worker Routing (ADR-015)
- [ ] **Task 2.1**: Python runtime manager refactor
  - **Update**: `src/bridge/python-runtime-manager.ts`
  - Support worker pool: `PythonWorker[]`
  - Add worker lifecycle: spawn, health check, restart, shutdown
  - Implement heartbeat protocol (JSON over stderr)
  - **Acceptance**: Can spawn/manage N workers independently
  - **Time**: 6 hours
  - **Files**: `src/bridge/python-runtime-manager.ts`, `tests/bridge/worker-lifecycle.test.ts`

- [ ] **Task 2.2**: Runtime router implementation
  - **Create**: `src/core/runtime-router.ts`
  ```typescript
  export type RoutingStrategy = 'round-robin' | 'least-busy' | 'latency-aware';

  export interface RuntimeRouter {
    route(request: GenerationRequest): PythonWorker;
    getWorkerStats(): WorkerStats[];
    markUnhealthy(workerId: string): void;
  }
  ```
  - Implement round-robin (default)
  - Implement least-busy (queue depth based)
  - Add health probe integration
  - **Acceptance**: Requests evenly distributed across workers
  - **Time**: 6 hours
  - **Files**: `src/core/runtime-router.ts`, `tests/core/runtime-router.test.ts`

- [ ] **Task 2.3**: Python worker updates
  - **Update**: `python/runtime.py`
  - Accept `--worker-id` CLI argument
  - Emit heartbeat every 5s: `{"type":"heartbeat","worker_id":"w1","queue_depth":3}`
  - Support graceful shutdown signal
  - **Acceptance**: Workers report health correctly
  - **Time**: 4 hours
  - **Files**: `python/runtime.py`, `tests/python/test_worker_heartbeat.py`

#### Day 6-7: Adaptive Batching (ADR-016)
- [ ] **Task 2.4**: Port adaptive controller from kr-serve-mlx
  - **Create**: `python/models/adaptive_controller.py`
  ```python
  class AdaptiveController:
      def __init__(self, target_latency_ms=50, min_batch=2, max_batch=16):
          self.ema_latency = 0.0
          self.alpha = 0.2
          self.current_batch_size = min_batch

      def adjust(self, batch_stats: BatchStats) -> int:
          # EMA smoothing + PID-like adjustment
          ...
  ```
  - Implement EMA-based latency tracking
  - Dynamic batch size adjustment (2-16)
  - Per-model tuning support
  - **Acceptance**: Batch size adjusts based on latency feedback
  - **Time**: 6 hours
  - **Files**: `python/models/adaptive_controller.py`, `tests/python/test_adaptive_controller.py`

- [ ] **Task 2.5**: Integrate with generate-batcher
  - **Update**: `src/core/generate-batcher.ts`
  - Add `adaptive_sizing: boolean` config
  - Expose telemetry channel for batch stats
  - Add JSON-RPC method: `config.updateAdaptiveTargets`
  - **Acceptance**: Batch size adapts to load dynamically
  - **Time**: 5 hours
  - **Files**: `src/core/generate-batcher.ts`, `tests/integration/adaptive-batching.test.ts`

#### Day 8-9: Smart Retry Logic (ADR-017)
- [ ] **Task 2.6**: Retry policy implementation
  - **Create**: `src/core/retry-policy.ts`
  ```typescript
  export interface RetryPolicy {
    shouldRetry(error: Error, attempt: number): boolean;
    getDelay(attempt: number): number;
    recordSuccess(): void;
    recordFailure(): void;
    getCircuitState(): 'closed' | 'open' | 'half-open';
  }
  ```
  - Exponential backoff with jitter
  - Circuit breaker (open after N failures)
  - Half-open retry attempts
  - **Acceptance**: Transient failures recover automatically
  - **Time**: 6 hours
  - **Files**: `src/core/retry-policy.ts`, `tests/core/retry-policy.test.ts`

- [ ] **Task 2.7**: Integrate with generation service
  - **Update**: `src/core/generation-service.ts`
  - Wrap Python calls with retry policy
  - Add idempotency tokens for retries
  - Emit metrics: `mlx_retry_attempts`, `mlx_circuit_state`
  - **Acceptance**: Retries work without duplicate side effects
  - **Time**: 4 hours
  - **Files**: `src/core/generation-service.ts`, `tests/integration/retry-integration.test.ts`

#### Day 10: Testing & Validation
- [ ] **Task 2.8**: Chaos testing
  - **Create**: `scripts/failure_inject.sh`
  - Test: Worker crash mid-request (kill -9)
  - Test: Slow worker (network latency simulation)
  - Test: Worker OOM (memory limit)
  - **Acceptance**: System recovers gracefully from all failure modes
  - **Time**: 4 hours

- [ ] **Task 2.9**: Performance benchmarking
  - Run: Mixed workload benchmark (Qwen3-30B, 100 requests, 10 concurrent)
  - Measure: Throughput, P95/P99 latency, worker utilization
  - Validate: ≥105% tok/s vs baseline
  - **Acceptance**: Performance targets met, no regressions
  - **Time**: 3 hours

- [ ] **Task 2.10**: Configuration & documentation
  - **Update**: `config/runtime.yaml` with Phase 2 settings
  ```yaml
  python_runtime:
    workers:
      - id: w1
        gpu: 0
        models: ["*"]
      - id: w2
        gpu: 0
        models: ["*"]
    routing_strategy: round-robin  # or least-busy

  generate_batcher:
    adaptive_sizing: true
    target_latency_ms: 50
    min_batch_size: 2
    max_batch_size: 16

  generation_retry:
    enabled: true
    max_attempts: 3
    base_delay_ms: 100
    max_delay_ms: 5000
    jitter: 0.2
    circuit_threshold: 5
  ```
  - **Update**: `docs/operations/phase2-rollout.md`
  - **Acceptance**: Ops team trained on multi-worker operations
  - **Time**: 2 hours

**Phase 2 Exit Criteria**:
- ✅ Multi-worker routing operational with 2-4 workers
- ✅ Adaptive batching adjusting dynamically (2-16 batch size)
- ✅ Smart retry recovering from transient failures
- ✅ Benchmark shows ≥105% tok/s vs baseline (mixed workload)
- ✅ Chaos tests pass (worker crashes, slow workers, OOM)
- ✅ Worker health monitoring dashboard live
- ✅ ADRs 015-017 promoted to ACCEPTED status
- ✅ Zero increase in P95 latency

**Total Time**: 46 hours (5.75 days)

---

## Phase 3: Production Hardening (Days 11-24) - OPTIMIZATION

### Goal
+10-20% throughput at high concurrency with production-grade features.

### Pre-flight Checklist
- [ ] Phase 2 complete and stable in production for 48h
- [ ] Phase 2 benchmarks validated (≥105% overall throughput)
- [ ] ADRs 018-020 reviewed and approved
- [ ] Staging environment ready for 72h soak test

### Implementation Tasks

#### Day 11-13: Connection Pooling (ADR-018)
- [ ] **Task 3.1**: JSON-RPC transport pooling
  - **Update**: `src/bridge/jsonrpc-transport.ts`
  - Maintain pool of stdio connections per worker
  - Implement connection reuse protocol
  - Add keepalive ping/pong
  - Leak detection and auto-recovery
  - **Acceptance**: Connections reused >90% of time
  - **Time**: 8 hours
  - **Files**: `src/bridge/jsonrpc-transport.ts`, `tests/bridge/connection-pool.test.ts`

- [ ] **Task 3.2**: Python runtime pooling support
  - **Update**: `python/runtime.py`
  - Support connection handshake protocol
  - Graceful idle timeout (don't exit)
  - Connection state management
  - **Acceptance**: Python process stays warm between requests
  - **Time**: 6 hours
  - **Files**: `python/runtime.py`, `tests/python/test_connection_pool.py`

#### Day 14-16: Streaming Optimizations (ADR-019)
- [ ] **Task 3.3**: Backpressure-aware SSE writer
  - **Update**: `src/core/stream-registry.ts`
  - Implement backpressure detection
  - Chunk aggregator (respect 64KB boundary)
  - Flow control for slow clients
  - **Acceptance**: Slow clients don't block fast ones
  - **Time**: 8 hours
  - **Files**: `src/core/stream-registry.ts`, `tests/integration/streaming-backpressure.test.ts`

- [ ] **Task 3.4**: SSE optimization in HTTP layer
  - **Update**: `src/cli/server.ts`
  - Batch tokens into 20ms frames when client lags
  - Optimize SSE flush frequency
  - Add SSE event metadata: `backpressure: true`
  - **Acceptance**: SSE throughput increased, no blocking
  - **Time**: 6 hours
  - **Files**: `src/cli/server.ts`, `tests/integration/sse-optimization.test.ts`

#### Day 17-20: Memory Management (ADR-020)
- [ ] **Task 3.5**: GPU scheduler memory tracking
  - **Update**: `python/gpu_scheduler.py`
  - Track per-model idle time
  - Monitor GPU VRAM usage (via MLX)
  - Implement idle-unload timer
  - Prefetch queue for predicted models
  - **Acceptance**: Idle models unload after timeout
  - **Time**: 10 hours
  - **Files**: `python/gpu_scheduler.py`, `tests/python/test_memory_policy.py`

- [ ] **Task 3.6**: Model lifecycle service
  - **Create**: `src/services/model-lifecycle-service.ts`
  ```typescript
  export interface ModelLifecycleService {
    trackUsage(modelId: string): void;
    getUsageStats(): ModelUsageStats[];
    prefetch(modelId: string): Promise<void>;
    unload(modelId: string): Promise<void>;
  }
  ```
  - Usage histogram tracking
  - Predictive prefetch (ML-based or heuristic)
  - Expose admin API: `model.prefetch`, `model.unload`
  - **Acceptance**: Hot models stay loaded, cold ones unload
  - **Time**: 8 hours
  - **Files**: `src/services/model-lifecycle-service.ts`, `tests/services/model-lifecycle.test.ts`

#### Day 21-22: Zero-Downtime Restarts
- [ ] **Task 3.7**: Rolling worker upgrades
  - **Update**: `src/bridge/python-runtime-manager.ts`
  - Implement draining protocol (stop accepting new requests)
  - Rolling restart with redundancy check
  - Watchdog: ensure N workers always available
  - **Acceptance**: Can restart workers with zero request drops
  - **Time**: 8 hours
  - **Files**: `src/bridge/python-runtime-manager.ts`, `tests/integration/rolling-restart.test.ts`

- [ ] **Task 3.8**: Graceful degradation
  - **Update**: `src/core/generation-service.ts`
  - Fallback to cached responses on worker unavailability
  - Downscale batch size under load
  - Rate limiting per client
  - **Acceptance**: System degrades gracefully under extreme load
  - **Time**: 6 hours
  - **Files**: `src/core/generation-service.ts`, `tests/integration/graceful-degradation.test.ts`

#### Day 23-24: Final Testing & Documentation
- [ ] **Task 3.9**: Soak testing
  - **Create**: `benchmarks/soak_runner.ts`
  - Run: 72-hour test at production load (100 concurrent users)
  - Monitor: Memory leaks, connection leaks, CPU usage
  - Validate: Throughput stable, no degradation over time
  - **Acceptance**: 72h soak passes with zero incidents
  - **Time**: 72h (automated, 3h setup)

- [ ] **Task 3.10**: High-concurrency benchmark
  - Run: Qwen3-30B, 100 concurrent users, 200 requests
  - Measure: Throughput, P95/P99 latency, GPU utilization
  - Validate: ≥120% tok/s vs baseline, P95 < 120ms
  - **Acceptance**: Performance targets met
  - **Time**: 4 hours

- [ ] **Task 3.11**: Production runbook
  - **Create**: `docs/operations/production-runbook.md`
  - Document: All feature flags and their impact
  - Document: Monitoring dashboards and alerts
  - Document: Troubleshooting common issues
  - Document: Rollback procedures
  - **Acceptance**: Ops team can run production confidently
  - **Time**: 6 hours

- [ ] **Task 3.12**: Final configuration
  - **Update**: `config/runtime.yaml` with production-ready defaults
  ```yaml
  python_runtime:
    connection_pool:
      enabled: true
      min_connections: 2
      max_connections: 10
      idle_timeout_ms: 60000
      warm_on_startup: true

  streaming:
    optimized_writer: true
    chunk_size_kb: 64
    frame_interval_ms: 20
    backpressure_threshold: 5

  model:
    memory_policy:
      enabled: true
      idle_timeout_sec: 300  # 5 minutes
      prefetch_window_sec: 30
      max_prefetch_per_gpu: 2
  ```
  - **Acceptance**: Configuration validated and documented
  - **Time**: 2 hours

**Phase 3 Exit Criteria**:
- ✅ Connection pooling achieving >90% reuse rate
- ✅ Streaming optimizations handling slow clients gracefully
- ✅ Memory management auto-unloading idle models
- ✅ Zero-downtime restarts working in production
- ✅ 72h soak test passed with zero incidents
- ✅ High-concurrency benchmark: ≥120% tok/s, P95 < 120ms
- ✅ Production runbook complete and validated
- ✅ ADRs 018-020 promoted to ACCEPTED status
- ✅ All feature flags documented and tested

**Total Time**: 71 hours (8.9 days) + 72h automated soak

---

## Risk Mitigation & Rollback

### Feature Flag Emergency Rollback

**If issues detected in production**:

1. **Phase 1 Issues** (Caching):
   ```yaml
   request_deduplication.enabled: false
   prompt_cache.enabled: false
   request_coalescing.enabled: false
   ```
   - Impact: System reverts to Phase 0 baseline
   - Recovery time: < 1 minute (config reload)

2. **Phase 2 Issues** (Multi-worker):
   ```yaml
   python_runtime.workers: [{ id: w1, gpu: 0, models: ["*"] }]  # Single worker
   generate_batcher.adaptive_sizing: false
   generation_retry.enabled: false
   ```
   - Impact: Single worker mode, static batching
   - Recovery time: < 5 minutes (worker restart)

3. **Phase 3 Issues** (Production features):
   ```yaml
   python_runtime.connection_pool.enabled: false
   streaming.optimized_writer: false
   model.memory_policy.enabled: false
   ```
   - Impact: Spawn-per-request, basic streaming
   - Recovery time: < 1 minute (config reload)

### Canary Deployment Strategy

1. **10% Traffic** (Day 1 of each phase):
   - Route 10% of requests to new features
   - Monitor metrics for anomalies
   - Rollback if error rate > 0.1%

2. **50% Traffic** (Day 2):
   - Increase to 50% if 10% stable for 24h
   - Monitor P95/P99 latency
   - Rollback if latency increases > 20%

3. **100% Traffic** (Day 3):
   - Full rollout if 50% stable for 24h
   - Keep rollback ready for 7 days

### Monitoring Alerts

**Critical** (page on-call):
- Worker heartbeat missing > 10s
- Circuit breaker open > 1 minute
- Error rate > 1%
- P95 latency > 3s

**Warning** (Slack notification):
- Cache error rate > 0.1%
- Connection pool exhaustion
- SSE backpressure events > 5/min
- Memory policy unload failures

---

## Success Metrics & Validation

### Phase 1 Success
- [ ] Request deduplication: >50% cache hit rate on duplicate workloads
- [ ] Prompt cache: >80% hit rate after warm-up
- [ ] Request coalescing: N→1 merge ratio >2.0 for identical requests
- [ ] Benchmark: ≥110% tok/s vs baseline (duplicate-heavy test)
- [ ] Overhead: <1ms added latency per request

### Phase 2 Success
- [ ] Multi-worker: Requests evenly distributed (±10% variance)
- [ ] Adaptive batching: Batch size adjusts between 2-16 based on load
- [ ] Smart retry: >95% success rate after retry
- [ ] Benchmark: ≥105% tok/s vs baseline (mixed workload)
- [ ] Worker utilization: >80% across all workers

### Phase 3 Success
- [ ] Connection pooling: >90% connection reuse rate
- [ ] Streaming: Zero blocking for slow clients
- [ ] Memory management: Models unload after 5min idle
- [ ] Zero-downtime: Restart with 0 dropped requests
- [ ] Benchmark: ≥120% tok/s at 100 concurrent users, P95 < 120ms

---

## Timeline Summary

| Phase | Duration | Start Day | End Day | Key Deliverables |
|-------|----------|-----------|---------|------------------|
| Phase 0 | 1.5 days | Day 0 | Day 1 | Config, baseline, observability, test infrastructure |
| Phase 1 | 2.5 days | Day 2 | Day 3 | Request dedup, prompt cache, coalescing |
| Phase 2 | 5.75 days | Day 4 | Day 10 | Multi-worker, adaptive batching, retry logic |
| Phase 3 | 8.9 days | Day 11 | Day 24 | Connection pooling, streaming, memory mgmt |
| **Total** | **18.65 days** | | | **+ 3 days soak** = **~22 days** |

**Critical Path**:
- Days 0-1: Foundation (blocking for all phases)
- Days 2-3: Caching (blocking for Phase 2)
- Days 4-10: Multi-worker (blocking for Phase 3)
- Days 11-24: Production hardening

**Parallel Work Opportunities**:
- Documentation can be written in parallel with implementation
- Testing can start as soon as modules are complete
- Chaos testing can run overnight

---

## Resource Requirements

### Engineering Team
- **Backend Engineer** (primary): Full-time, all phases
- **Python Engineer**: Phase 2-3 (adaptive batching, memory mgmt)
- **DevOps Engineer**: Phase 3 (connection pooling, deployment)
- **QA Engineer**: All phases (testing, validation)

### Infrastructure
- **Staging Environment**: 4 GPU instances (for multi-worker testing)
- **Benchmark Server**: Dedicated instance for reproducible tests
- **Monitoring**: Prometheus + Grafana (or equivalent)

### External Dependencies
- MLX library (no changes needed)
- Node.js v18+ (existing)
- Python 3.10+ (existing)

---

## Next Steps (Immediate Actions)

1. **Review & Approval** (Today):
   - [ ] Technical lead reviews implementation plan
   - [ ] Product owner approves timeline
   - [ ] Architecture team approves ADRs 012-014

2. **Kickoff Phase 0** (Tomorrow):
   - [ ] Assign engineers to tasks
   - [ ] Set up project tracking (GitHub Issues or Jira)
   - [ ] Schedule daily standup (15min)
   - [ ] Create Slack channel: `#mlx-serving-optimization`

3. **Week 1 Checkpoint** (Day 5):
   - [ ] Phase 0 complete
   - [ ] Phase 1 complete
   - [ ] Benchmark results shared with stakeholders

4. **Week 2 Checkpoint** (Day 12):
   - [ ] Phase 2 complete
   - [ ] Multi-worker running in staging
   - [ ] Chaos tests passed

5. **Week 3-4 Checkpoint** (Day 24):
   - [ ] Phase 3 complete
   - [ ] 72h soak test passed
   - [ ] Production rollout plan approved

---

## Appendix: Quick Reference

### Configuration File Locations
- `config/runtime.yaml` - Main configuration
- `config/runtime.canary.yaml` - Canary environment config
- `config/schema/runtime.schema.json` - JSON schema validation

### Key Source Files
- **Phase 1**: `src/core/{request-deduplicator,prompt-cache,coalescing-registry}.ts`
- **Phase 2**: `src/core/runtime-router.ts`, `python/models/adaptive_controller.py`
- **Phase 3**: `src/bridge/jsonrpc-transport.ts`, `src/services/model-lifecycle-service.ts`

### Benchmark Commands
```bash
# Baseline
npm run bench:throughput -- --models gemma-2-27b-it-4bit,qwen3-30b --output benchmarks/results/baseline.json

# Phase 1 (duplicate-heavy)
npm run bench:dedup -- --models gemma-2-27b-it-4bit --duplicates 20

# Phase 2 (mixed workload)
npm run bench:mixed -- --models qwen3-30b --concurrent 10 --requests 100

# Phase 3 (high concurrency)
npm run bench:concurrency -- --models qwen3-30b --concurrent 100 --requests 200

# Soak test
npm run bench:soak -- --duration 72h --concurrent 50
```

### Emergency Contacts
- Tech Lead: [Name]
- On-Call Engineer: [Rotation]
- Product Owner: [Name]
- Architecture Team: [Team Channel]

---

**Document Version**: 1.0
**Last Updated**: 2025-11-07
**Next Review**: After Phase 1 completion
