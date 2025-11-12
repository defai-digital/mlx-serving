# mlx-serving Performance Optimization Action Plan

**Author:** Avery (Senior Software Architect)  
**Date:** 2025-??-?? (update when published)  
**Catchphrase:** “Great architecture is invisible - it enables teams, evolves gracefully, and pays dividends over decades.”

---

## 1. Context & Objectives
- **Current state:** mlx-serving delivers ~96 % throughput vs. mlx-engine because IPC overhead, single Python worker saturation, and lack of reuse across similar requests keep GPU utilization <80 %.
- **Target:** Unlock TypeScript-side orchestration advantages to reach **120‑150 %** of mlx-engine throughput while preserving reliability and developer ergonomics.
- **Scope:** Node.js front end, JSON-RPC bridge, Python MLX runtime (gpu_scheduler, generator). Out-of-scope for this wave: model architecture changes or training-time optimizations.
- **Constraints:** Maintain Service-Oriented Engine (ADR-011), ES module discipline (ADR-002), strict TypeScript (ADR-003), and security posture (ADR-004). All optimizations must be gated via config for progressive rollout.

---

## 2. Performance Targets & KPIs
| Metric | Baseline | Target | Notes |
| --- | --- | --- | --- |
| Tokens/sec @ 8 concurrent prompts (Gemma 7B) | 120 tok/s | 150-180 tok/s | Driven by adaptive batching + dedup |
| Median TTFT | 850 ms | <650 ms | Improved coalescing + warm models |
| GPU utilization | 68 % | 85 %+ | Multi-worker routing + pooling |
| Tail latency (p95) | 2.8 s | <2.0 s | Retry + backpressure |
| Crash-free sessions | 99.2 % | ≥99.7 % | Requires rollback-ready toggles |

KPIs measured via `benchmarks/throughput.ts` (Node harness) and `benchmarks/python/loadgen.py` (Python stress) plus Otel spans in `src/telemetry/otel.ts`.

---

## 3. Architecture Guardrails
1. **Document-first:** Each optimization ties to an ADR (primary responsibility). ADRs remain PROPOSED until validated in soak tests, then promoted into `.automatosx/abilities/our-architecture-decisions.md`.
2. **Layered ownership:** Node orchestrates caching/routing; Python owns GPU execution; JSON-RPC stays transport-agnostic.
3. **Feature flags everywhere:** New code paths default-off, toggled via `config/runtime.yaml` and env overrides to enable canarying.
4. **Observability parity:** Every optimization exports metrics + structured logs before rollout.
5. **Safe-to-disable:** Rollback must be a config flip + runtime reload (no code rollback) per governance.

---

## 4. ADR Backlog (Proposed)
| ADR | Phase | Title | Decision Snapshot | Dependencies |
| --- | --- | --- | --- | --- |
| ADR-012 | 1 | Request Deduplication Layer | Introduce in-memory TTL cache mapping `(model_id, prompt, params)` → pending Promise to collapse identical work. | Depends on `src/core/generate-batcher.ts` hooks. |
| ADR-013 | 1 | Prompt Result Cache | LRU cache (10k entries, size-aware) storing normalized prompt fingerprints + outputs for reuse beyond dedup window. | Builds on ADR-012 cache infra. |
| ADR-014 | 1 | Request Coalescing Registry | Track in-flight generations by semantic key so multiple clients stream from one backend invocation. | Extends StreamRegistry + SSE multiplexer. |
| ADR-015 | 2 | Multi-Worker Runtime Router | Run N Python workers and route via round-robin/least-busy router with health probes. | Requires connection pooling (ADR-018) later but can start with independent processes. |
| ADR-016 | 2 | Adaptive Batching Controller | Port adaptive controller (EMA-based, dynamic batch size 2‑16) into `python/models/adaptive_controller.py` and expose tuning knobs via JSON-RPC. | Requires stable telemetry feedback loop. |
| ADR-017 | 2 | Smart Retry & Circuit Guard | Layer exponential backoff, jitter, and circuit breaker states for generation path (beyond existing JSON-RPC generic policy). | Builds on ADR-014 instrumentation. |
| ADR-018 | 3 | Python Connection Pooling | Reuse warm Python runtimes rather than respawn; maintain pool keyed by model/gpu affinity. | Assumes ADR-015 baseline routing. |
| ADR-019 | 3 | Streaming Optimizations | Improve SSE chunking, apply backpressure-aware writer, and surface flow control to clients. | Leverages StreamRegistry metrics, ADR-014 dedup streams. |
| ADR-020 | 3 | Memory Lifecycle Automation | Idle-unload + prefetch scheduler to manage GPU VRAM proactively. | Requires telemetry on per-model usage + config to predict load. |

Once decisions graduate from PROPOSED, update `.automatosx/abilities/our-architecture-decisions.md` with accepted status, rationale, and consequences.

---

## 5. Phase Roadmap & Implementation Detail

### 5.1 Phase 1 – Quick Wins (1–2 days)
**Objective:** Reduce redundant Python work and improve short-term throughput with TypeScript-side caching while preserving correctness.  
**Exit criteria:** Feature flags in place, unit + integration coverage, soak test @ 30 min with no regressions.

#### Optimization 1: Request Deduplication (ADR-012)
- **Intent:** Collapse identical requests arriving within 1 s into a shared Promise so only one backend inference executes.
- **Implementation Tasks:**
  - `src/core/request-deduplicator.ts` (new): Export `RequestDeduplicator` with TTL map + max entries, keyed by SHA256 hash of `(model_id, prompt, params)`; store `Promise<GenerationResult>`.
  - `src/core/generate-batcher.ts`: Wrap `enqueue()` to consult deduplicator; share streaming responses via `ReadableStream tee` before hitting Python.
  - `src/config/runtime.ts` + `config/runtime.yaml`: Add `request_deduplication` block (enabled, ttl_ms, max_entries, max_payload_kb).
  - `src/types/config.ts`: Extend config types; ensure strict typing.
  - `tests/core/request-deduplicator.test.ts`: Cover TTL eviction, rejection propagation, and memory pressure guard.
- **API Contracts:**
  - Hash key uses canonicalized params (sorted JSON) to guarantee determinism.
  - On error, remove cache entry to avoid poisoning.
- **Testing:**
  - Unit tests for dedupe map race handling.
  - Integration test in `tests/integration/generate-dedup.test.ts` using fake transport to assert only one JSON-RPC call occurs.
  - Load test script in `benchmarks/dedup_profile.ts`.
- **Rollback:** Toggle `request_deduplication.enabled=false` + restart Node process (no Python change).

#### Optimization 2: Prompt Cache (ADR-013)
- **Intent:** Provide longer-lived reuse for identical prompts even after initial completion (10 k entry LRU, TTL configurable).
- **Implementation Tasks:**
  - `src/core/prompt-cache.ts` (new) using size-aware LRU (store approximate tokens + bytes).
  - `src/core/generation-service.ts`: After deduped request resolves, store result metadata (prompt fingerprint, completion, logprobs, metadata).
  - `src/cli/server.ts` / HTTP layer: Add `x-mlx-cache-hit` header + SSE event for observability.
  - `config/runtime.yaml`: `prompt_cache` block (enabled, max_entries, ttl_ms, max_bytes, persistence flag).
  - Optionally persist hot entries in `automatosx/tmp/prompt-cache.json` via WorkspaceManager for warm starts (flag-controlled).
- **API Contracts:** HTTP + JSON-RPC add optional `cacheControl` param to bypass cache for sensitive workloads.
- **Testing:** golden tests ensuring deterministic serialization; performance test verifying LRU does not block event loop (>5 ms).
- **Rollback:** Disable `prompt_cache.enabled`; purge persisted file.

#### Optimization 3: Request Coalescing (ADR-014)
- **Intent:** Share a single Python inference among multiple subscribers even if prompts differ slightly but share prefix? (Scope: identical prompts + sampling params; future partial-match with embeddings is out-of-scope.)
- **Implementation Tasks:**
  - `src/core/coalescing-registry.ts` (new) mapping `requestKey` → shared stream controller.
  - `src/core/stream-registry.ts`: Add `attachSubscriber(requestKey, streamId)` to multiplex SSE events.
  - `src/api/routes/generate.ts`: When new subscriber attaches, if existing stream exists, clone SSE stream and tail output; maintain start-offset metadata.
  - `src/telemetry/bridge.ts`: Emit `coalesced_subscriber_count`.
- **API Contracts:** SSE events include `sharedFromRequestId` attribute; JSON response indicates `coalesced: true`.
- **Testing:** Integration tests verifying subscriber receives entire stream even if joining mid-flight (requires buffered replay).
- **Rollback:** Registry feature flag `request_coalescing.enabled`.

### 5.2 Phase 2 – Advanced Enhancements (≈1 week)
**Objective:** Scale backend capacity via multiple Python workers, dynamic batching, and resiliency.
**Exit criteria:** Stable throughput >120 % baseline in staging, automated soak + chaos tests.

#### Optimization 4: Multi-Worker Routing (ADR-015)
- **Implementation Tasks:**
  - `src/bridge/python-runtime-manager.ts`: Support pool of workers defined by `python_runtime.workers` config; manage lifecycle.
  - `src/core/runtime-router.ts` (new) implementing round-robin + least-busy strategies; exposed via `services/runtime-service.ts`.
  - `python/runtime.py`: Accept `--worker-id`, emit heartbeat (JSON) to Node.
  - `python/gpu_scheduler.py`: Support partitioned queues per worker or shared queue with locks.
  - `tests/services/runtime-router.test.ts`: Simulate worker crashes, ensure failover.
- **API Contracts:** JSON-RPC `telemetry.workerStatus` method for health.
- **Config:** `python_runtime.workers: [{id, gpu, models}]`.
- **Rollback:** Set `python_runtime.workers=1`; router collapses to default.

#### Optimization 5: Adaptive Batching (ADR-016)
- **Implementation Tasks:**
  - Port `python/models/adaptive_controller.py` from kr-serve-mlx with EMA smoothing; integrate inside `python/models/generator.py`.
  - `src/core/batch-queue.ts` + `src/core/generate-batcher.ts`: Expose telemetry hooks (batch time, queue latency) via `AdaptiveFeedbackChannel`.
  - `src/telemetry/otel.ts`: Add histogram `mlx.batch.size`.
  - `tests/python/test_adaptive_controller.py`: Validate adjustments vs. simulated latency.
- **API Contracts:** JSON-RPC `config.updateAdaptiveTargets` for runtime tuning.
- **Rollback:** `generate_batcher.adaptive_sizing=false` + fallback to static sizes.

#### Optimization 6: Smart Retry Logic (ADR-017)
- **Implementation Tasks:**
  - `src/core/retry-policy.ts`: Implement exponential backoff with jitter + circuit breaker states for generation-specific errors (OOM, busy GPU).
  - `src/core/generation-service.ts`: Wrap calls with policy; add idempotency tokens.
  - `config/runtime.yaml`: `generation_retry` block (maxAttempts, baseDelayMs, jitter, circuit thresholds).
  - `tests/core/retry-policy.test.ts`: Cover success-after-retry, breaker open/half-open transitions.
  - Update `docs/operability/runbook.md` with failure-handling guidance.
- **Rollback:** Set `generation_retry.enabled=false`; fallback to transport-level policy.

### 5.3 Phase 3 – Production Hardening (≈2 weeks)
**Objective:** Optimize long-running production behavior: connection reuse, streaming efficiency, memory lifecycle automation.
**Exit criteria:** Sustained 150 % throughput on staging; no regressions after 72 h soak; observability dashboards published.

#### Optimization 7: Connection Pooling (ADR-018)
- **Implementation Tasks:**
  - `src/bridge/jsonrpc-transport.ts`: Maintain pool of stdio connections to Python; reuse per worker rather than restart.
  - `python/runtime.py`: Support handshake for pooling (keepalive pings, graceful idle).
  - `src/config/runtime.ts`: `python_runtime.connection_pool` settings (min, max, idleTimeoutMs, warmOnStartup).
  - `tests/bridge/connection-pool.test.ts`: Simulate exhaustion + leak detection.
- **Rollback:** `connection_pool.enabled=false`; fall back to spawn-per-request.

#### Optimization 8: Streaming Optimizations (ADR-019)
- **Implementation Tasks:**
  - `src/core/stream-registry.ts`: Add backpressure-aware writer; chunk aggregator to respect 64 KB boundary.
  - `src/cli/server.ts`: Optimize SSE flush by batching tokens into 20 ms frames when clients lag.
  - `src/telemetry/bridge.ts`: Emit metrics for `sse_backpressure_events`, `avg_chunk_size`.
  - `tests/integration/streaming-backpressure.test.ts`: Use fake slow client to ensure server throttles properly.
- **Rollback:** disable `streaming.optimized_writer`.

#### Optimization 9: Memory Management (ADR-020)
- **Implementation Tasks:**
  - `python/gpu_scheduler.py`: Track per-model idle time, GPU VRAM usage; add idle-unload timer + prefetch queue.
  - `python/models/generator.py`: Expose `load_model`, `unload_model` RPC commands; integrate with Node scheduler.
  - `src/services/model-lifecycle-service.ts`: Maintain usage histogram, predict next needed model (prefetch).
  - `config/runtime.yaml`: `model.memory_policy` block (idleTimeoutSec, prefetchWindowSec, maxPrefetchPerGPU).
  - `tests/python/test_memory_policy.py` and `tests/services/model-lifecycle.test.ts`.
- **Rollback:** Set `model.memory_policy.enabled=false`; scheduler reverts to existing manual load/unload.

---

## 6. Code Structure & Module Organization
- **New core utilities:** `src/core/request-deduplicator.ts`, `prompt-cache.ts`, `coalescing-registry.ts`, `retry-policy.ts`, `runtime-router.ts`.
- **Services layer:** Extend `src/services/generation-service.ts`, `runtime-service.ts`, and `model-lifecycle-service.ts` to orchestrate new logic consistent with ADR-011.
- **Bridge layer:** Enhance `src/bridge/jsonrpc-transport.ts` and `python-runtime-manager.ts` for pooling + multi-worker support, keeping IPC code isolated from business logic.
- **Python side:** `python/gpu_scheduler.py`, `python/models/generator.py`, `python/models/adaptive_controller.py`, `python/runtime.py` gain modular controllers with dependency injection for schedulers and memory policy.
- **Docs & config:** `docs/architecture/adr/` (if exists) houses rendered ADRs; `config/runtime.yaml` remains single source for runtime toggles.

---

## 7. API Contracts & Interfaces
- **JSON-RPC Additions:**
  - `generation.registerSubscriber(requestKey)` for coalescing.
  - `telemetry.workerStatus`, `telemetry.batchStats`.
  - `config.updateAdaptiveTargets`, `model.prefetch`, `model.unload`.
- **HTTP/SSE Headers:**
  - `x-mlx-cache-hit`, `x-mlx-coalesced`, `x-mlx-worker-id`.
  - SSE event fields: `sharedFromRequestId`, `cacheState`, `backpressure`.
- **TypeScript Interfaces:**
  - `RequestFingerprint`, `CacheEntry`, `CoalescedStream`.
  - `RuntimeWorkerConfig`, `AdaptiveBatchConfig`, `RetryPolicyConfig`, `MemoryPolicyConfig`.
- **Python Interfaces:**
  - `AdaptiveController.adjust(batch_stats) -> BatchSettings`.
  - `GpuScheduler.reserve(worker_id, model_id)`.
  - `ModelLifecycle.prefetch(model_id, deadline_s)`.

Contracts documented in `docs/api/contracts/perf.md` and validated with JSON schema tests where feasible.

---

## 8. Testing & Quality Strategy
| Phase | Tests | Tooling |
| --- | --- | --- |
| Phase 1 | Unit (dedupe, cache), integration (generate endpoint), load harness (benchmarks/dedup_profile.ts) | Vitest, fake JSON-RPC server |
| Phase 2 | Service-level tests (runtime router, retry), Python pytest for adaptive controller, chaos tests (kill -9 worker) | Vitest + Pytest + `scripts/failure_inject.sh` |
| Phase 3 | Long-running soak (24‑72 h), memory leak detection via `valgrind` equivalent for Python, streaming backpressure tests | `benchmarks/soak_runner.ts`, custom SSE harness |

**CI Gates:**  
- New Vitest suites added to `package.json` `test:perf-plan`.  
- Python tests added to `scripts/run_pytests.sh`.  
- Benchmarks not blocking CI but run nightly with artifact upload.

---

## 9. Rollback & Contingency Strategies
1. **Feature flags:** Each ADR introduces `*.enabled` config plus safe defaults.
2. **Runtime toggles:** `ax config set` or env var overrides allow hot adjustment (Node reload only).
3. **Circuit breakers:** Smart retry (ADR-017) ensures we fail fast when Python misbehaves.
4. **Staged rollout:** Enable features sequentially in canary environment; maintain ability to revert to known-good config file tracked in git (`config/runtime.yaml` + `config/runtime.canary.yaml`).
5. **Versioned ADRs:** Keep PROPOSED status until at least one release proves stability; revert by downgrading config + referencing last known ADR version.

---

## 10. Performance Measurement Methodology
1. **Baseline capture:** Run `npm run bench:throughput -- --models gemma-7b` before any change; store results in `benchmarks/results/<date>-baseline.json`.
2. **Per-phase verification:** After each optimization, rerun targeted benchmark scenario; compare tokens/sec, TTFT, GPU util (collected via `python/gpu_scheduler.py` stats).
3. **Otel traces:** Use `src/telemetry/otel.ts` to emit spans `generation.request` with attributes `cacheHit`, `coalescedSubscribers`, `workerId`, `batchSize`.
4. **Dashboards:** Update Grafana (or Superset) boards to visualize KPI trendlines; share screenshot links in release notes.
5. **Regression alarms:** Set thresholds (e.g., tokens/sec drops >10 % over 15 min) to page via existing alerting pipeline.

---

## 11. Migration Path & Incremental Enablement
1. **Phase 1 features** gated individually; start with dedup (lowest risk) before enabling prompt cache and coalescing.
2. **Phase 2**: Introduce multi-worker router in shadow mode (route read-only health checks) before carrying production load. Adaptive batching toggled per model.
3. **Phase 3**: Connection pooling + streaming optimizations behind separate flags per environment; memory automation limited to non-critical models first.
4. **Release cadence:** Weekly release trains; each includes ADR status update + config template diff. Provide `config/runtime.example.yaml` with recommended toggles per environment.
5. **Backward compatibility:** Maintain ability to run single worker, no cache. New config keys default to safe disables to avoid breaking legacy deployments.

---

## 12. Configuration Management
- **Files:** `config/runtime.yaml` (authoritative), `config/runtime.canary.yaml` (experimental), `config/schema/runtime.schema.json` (add for validation).
- **New blocks:** `request_deduplication`, `prompt_cache`, `request_coalescing`, `python_runtime.workers`, `generation_retry`, `python_runtime.connection_pool`, `streaming`, `model.memory_policy`.
- **Env overrides:** Support `MLX_REQUEST_DEDUP_TTL_MS`, `MLX_WORKER_COUNT`, etc., mapped via `src/config/env.ts`.
- **Validation:** Extend `src/config/loader.ts` to validate ranges (e.g., TTL ≤5000 ms).
- **Secrets:** None added; caches stay in-memory.

---

## 13. Monitoring & Observability Integration
- **Metrics:**  
  - `counter mlx_cache_hits, mlx_cache_misses` (Phase 1).  
  - `histogram mlx_batch_size, mlx_batch_latency_ms` (Phase 2).  
  - `gauge mlx_worker_active, mlx_connection_pool_available`.  
  - `counter mlx_stream_backpressure_events`.  
- **Logs:** Structured logs via pino with `requestKey`, `workerId`, `cacheState`, `retryAttempt`.
- **Tracing:** Ensure spans include correlation IDs from HTTP headers.
- **Dashboards:** Create “mlx-serving perf runway” board with sections per phase metrics.
- **Alerting:**  
  - Cache error rate >1 % triggers warning.  
  - Worker heartbeat missing >10 s triggers critical.  
  - SSE backpressure >5 events/min triggers investigation.

---

## 14. Next Steps Checklist
- [ ] Review ADR drafts with Tony and runtime team; gather go/no-go.
- [ ] Sync with backend/mobile agents if we need delegation for prototype spikes.
- [ ] Implement Phase 1 toggles + tests, land behind feature flags.
- [ ] Update `.automatosx/abilities/our-architecture-decisions.md` once ADRs are accepted post-Phase 1.
- [ ] Schedule Phase 2 design review focusing on multi-worker routing risks.

---

**Great architecture is invisible—once this plan ships, teams should simply notice faster responses, calmer alerts, and more runway for future features.**
