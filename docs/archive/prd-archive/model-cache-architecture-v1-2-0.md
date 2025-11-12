# Model Caching Architecture – kr-serve-mlx v1.2.0

**Author:** Avery (Architecture)  
**Date:** 2025-03-17  
**Status:** Draft for implementation planning  
**Goal:** Design the v1.2.0 caching runway that unlocks sub-second warm loads, predictable memory usage, and observability for model lifecycle operations.

---

## 1. Problem & Objectives

Model loads dominate p95 latency and cost ~25–40 seconds when bypassing the disk cache. Phase 2 introduced ad-hoc “keep N handles loaded” logic and a disk artifact cache, but we lack coordinated cache tiers, eviction controls, and observability. As we scale to larger model menus and shared deployments, we must:

1. Guarantee deterministic memory bounds with automated eviction.
2. Shorten cold-start paths via multi-level cache promotion/demotion.
3. Support proactive warmup + preloading for high-demand models.
4. Track hit rates and load times to enforce SLOs.
5. Provide governed invalidation so stale or oversized artifacts do not accumulate.

Functional asks from the v1.2.0 planning brief:

1. Multi-level caching (memory + disk)
2. LRU eviction with size limits
3. Model warmup on startup
4. Cache preloading for popular models
5. Cache invalidation strategies
6. Performance metrics (hit rate, load time)

---

## 2. Current State (Baseline v1.1.x)

- **Memory tier:** `ModelManager` keeps loaded handles in a `Map`; eviction is count-based and only fires once `max_cached_models` is reached. No awareness of true memory cost.
- **Disk tier:** `ModelArtifactCache` stores HuggingFace artifacts with an index and LRU eviction. No coordination with memory tier. Preload list exists in config but is unused.
- **Warmup:** `ModelManager.warmupModels` loads configured IDs but leaves them fully resident; no demotion or failure isolation.
- **Invalidation:** None beyond disk LRU. Entries never expire by age or schema version.
- **Metrics:** Access timestamps in TS and hit/miss counters inside the artifact cache JSON, but nothing exported to telemetry.

---

## 3. Proposed Multi-Level Caching Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        ModelCacheController (TS)                            │
│  ┌──────────────────────┐   ┌───────────────────────┐   ┌────────────────┐ │
│  │ MemoryCacheLayer     │   │ ArtifactCacheAdapter  │   │ PreloadScheduler│ │
│  │ (hot handles)        │   │ (wraps ModelArtifact) │   │ (background)    │ │
│  └──────────┬───────────┘   └─────────┬─────────────┘   └───────┬────────┘ │
│             │                         │                          │          │
│     (1) hit?│ yes           (2) hit?   │ yes                    │schedule   │
│             ▼                         ▼                          ▼          │
│       Return handle            Hand off local path          Prefetch queue │
│             │                         │                          │          │
│             │ no                      │ no                       │          │
│             ▼                         ▼                          │          │
│        Trigger load  ───────────► Python loader ◄───────────────┘          │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Controller Responsibilities

- Single entry point for `loadModel`, `warmup`, and `preload`.
- Maintains cache metadata (sizes, timestamps, health) in memory.
- Promotes models between tiers: disk → memory, memory → disk (demote).
- Publishes metrics and emits events (`cache.hit`, `cache.eviction`, `cache.preload`).

### 3.2 Cache Layers

**Layer 0 – Active Runtime Handles**
- `python/models/loader.py` returns `memory_usage_bytes`, `tensor_bytes`, and `graph_bytes`.
- `ModelManager` treats this as the HOT tier; entries remain ready to serve requests instantly.

**Layer 1 – Memory Cache Layer (new)**
- Tracks handles + calculated memory footprint.
- LRU keyed by `cacheKey` (model id + revision + quantization).
- Weighted eviction: total footprint must stay ≤ configurable `model.memory_cache.max_memory_mb`.
- Supports demotion hooks: before eviction, ensures artifacts exist on disk (promote to warm) and then calls `unload_model`.

**Layer 2 – Disk Artifact Cache (enhanced)**
- Reuse existing `ModelArtifactCache`, but surface as an adapter with:
  - TTL enforcement using `cache.max_age_days`.
  - Schema version + origin fingerprint to bust stale entries.
  - Background “compaction” task to prune invalidated entries outside hot path.

### 3.3 Load Path

1. `ModelCacheController.ensureModel(cacheKey, options)` invoked from `ModelManager.loadModel`.
2. Check MemoryCacheLayer. On hit: update access metadata, increment `memory_hits`, return handle.
3. If not in memory, probe ArtifactCacheAdapter:
   - On hit: pass `artifactPath` to Python loader, mark `disk_hits`.
   - On miss: proceed to remote download (handled by loader/HuggingFace), mark `disk_misses`.
4. After loading, register handle with memory layer (will evict as needed) and optionally persist artifacts when we had a disk miss.

---

## 4. LRU & Capacity Management

### 4.1 Memory LRU
- Replace `max_cached_models` count with `max_memory_mb` and `max_handles`.
- Maintain `MemoryEntry { handle, lastAccess, estimatedBytes, pinned }`.
- Eviction order excludes `pinned` warmups unless override flag set.
- Eviction threshold: if `currentBytes + incoming > max_memory_mb`, iteratively evict oldest non-pinned entries. Each eviction:
  - Emits `cache.eviction` metric with reason.
  - Calls `unload_model`.
  - Removes entry from LRU map.

### 4.2 Disk Eviction
- Augment `ModelArtifactCache.evictIfNeeded` to consider:
  - `max_age_days`, removing entries beyond TTL.
  - `pinned` flag for preloaded models (evict last).
  - Optionally incorporate LFU counters when we add support.
- Store `source_commit` or `etag` in metadata to detect remote updates.

---

## 5. Warmup & Preloading Strategy

### 5.1 Startup Warmup Modes
- `memory_cache.warmup_on_start` becomes structured:
  ```yaml
  warmup_on_start:
    - id: mlx-community/Llama-3.2-3B-Instruct-4bit
      mode: retain   # keep in memory (hot)
    - id: mlx-community/Qwen2.5-1.5B
      mode: park     # load once, then demote to disk
  ```
- Controller executes warmup after caches initialize, using configurable concurrency (`model.memory_cache.warmup_concurrency`).
- Warmup tasks record duration, success/failure, and optionally demote handles post-warmup for `park` mode.

### 5.2 Preload Scheduler
- New `PreloadScheduler` runs on startup + periodic interval (default hourly).
- Sources of preload candidates:
  1. `cache.preload_models` static list.
  2. Top-N models by 7-day request count (persisted in `cache_stats.json`).
  3. Manual API (`POST /v1/cache/preload`).
- Scheduler ensures artifact directory exists (download if missing) without loading into memory unless flagged.
- Uses lightweight task queue with cancellation if disk near capacity.

---

## 6. Invalidation Strategy

| Trigger                       | Action                                                        | Notes                                   |
|------------------------------|---------------------------------------------------------------|-----------------------------------------|
| TTL expiry (`max_age_days`)  | Mark entry `stale`, remove during next eviction or preload    | Graceful, avoids hot-path blocking      |
| Source fingerprint mismatch  | Detect changed `revision`, `sha`, or `quantization` → invalidate old entry, fetch new | Requires metadata enrichment upstream |
| Manual bust (`cache invalidate`) | CLI + API to remove memory + disk entries for a cache key   | Use for emergency refresh               |
| Memory pressure              | Demote to disk (retain artifacts)                             | Controlled by Memory LRU thresholds     |
| Artifact corruption          | Existing validation augmented with checksum verification      | Emits `cache.corruption` metric         |

- Invalidations publish events -> metrics -> optional webhooks for fleet coordination.
- Need idempotent deletion to avoid race conditions with in-flight loads.

---

## 7. Metrics & Observability

Leverage ADR-011 (OpenTelemetry) to expose:

- Counters: `memory_cache_hits_total`, `memory_cache_misses_total`, `disk_cache_hits_total`, `disk_cache_misses_total`, `model_cache_evictions_total`, `model_cache_invalidations_total`, `model_preload_jobs_total`.
- Gauges: `model_cache_memory_bytes`, `model_cache_handles`, `disk_cache_size_bytes`, `disk_cache_entries`.
- Histograms: `model_load_duration_ms`, `cache_warmup_duration_ms`, `cache_lookup_duration_ms`.
- Derived metrics: `memory_cache_hit_rate`, `disk_cache_hit_rate`.
- Tracing: annotate load spans with cache tier outcomes and eviction details.

Expose metrics via existing telemetry exporter and add CLI command `kr-serve cache stats`.

---

## 8. Configuration Updates

```yaml
model:
  memory_cache:
    enabled: true
    max_handles: 6               # optional upper bound
    max_memory_mb: 20000         # total RAM budget for hot tier
    warmup_concurrency: 2
    warmup_on_start:
      - id: example/model
        mode: retain             # retain | park | async
    track_stats: true
cache:
  preload_models:
    - id: example/model
      priority: high             # informs scheduler order
      retain_hot: false
  ttl_days: 30                   # rename max_age_days
  validate_on_startup: true
telemetry:
  metrics:
    enable_model_cache: true
```

- Introduce `model.memory_cache.pin_patterns` (glob list) to prevent eviction of critical models.
- Persist derived stats in `.kr-mlx-cache/cache_stats.json`.

---

## 9. File & Module Plan

```
src/core/cache/
  model-cache-controller.ts        # orchestration logic
  memory-cache-layer.ts            # weighted LRU
  preload-scheduler.ts             # periodic artifact prefetch
  metrics.ts                       # OTEL integration helpers
  types.ts                         # shared cache interfaces

src/core/model-manager.ts          # integrate controller, remove ad-hoc LRU
src/core/model-artifact-cache.ts   # extend for TTL + fingerprints + pinning
src/api/routes/cache.ts            # optional REST endpoints
src/cli/commands/cache/*           # CLI tooling (invalidate, stats, warmup)

python/models/loader.py            # return memory usage + optional preload mode
python/models/cache.py (new)       # helpers (checksum, metadata serialization)
python/runtime.py                  # expose preload + invalidation RPCs
tests/unit/cache/*                 # new unit coverage
docs/architecture/model-cache.md   # developer docs (link to this PRD)
```

---

## 10. Integration & Delivery Plan

| Phase | Scope | Key Deliverables | Owners |
|-------|-------|------------------|--------|
| **P0 – Foundations (Week 1)** | Refactor ModelManager to delegate caching to controller | Controller skeleton, updated load path, baseline metrics instrumentation | Core eng |
| **P1 – Memory Tier (Week 2)** | Weighted LRU with `max_memory_mb`, warmup refactor | MemoryCacheLayer, eviction tests, telemetry gauges | Core eng + QA |
| **P2 – Disk Enhancements (Week 3)** | TTL, fingerprinting, preload adapter | Artifact cache mutations, CLI invalidate, preload scheduler MVP | Core eng + DevOps |
| **P3 – Warmup & Preload (Week 4)** | Startup warmup modes, popularity-based preloading | Warmup concurrency, metrics dashboards, docs | Core eng + Product |
| **P4 – Hardening (Week 5)** | Stress + chaos tests, rollout playbook | Load/perf benchmarks, failure injection, migration checklist | Core eng + Quality |

### Testing & Validation
- Unit tests for cache controller, eviction, preload scheduling.
- Integration tests covering warmup, demotion, invalidation flows (TypeScript + Python).
- Performance benchmarks measuring cold vs warm load deltas, RAM usage.
- Chaos tests: simulate disk corruption, Python restart, concurrent invalidations.

### Rollout Considerations
- Feature flag `cache.multi_level.enabled` for canary deployments.
- Provide migration script to convert existing cache index to new schema (TTLs, fingerprints).
- Document operator runbooks for cache stats, invalidation, and preload tuning.

---

## 11. Risks & Mitigations

- **Memory estimation inaccuracies** → Capture actual bytes from Python loader and adjust after every load; add safety margin (configurable).
- **Evicting in-use models** → Track active sessions; mark handles “busy” until generation completes, skip eviction until idle.
- **Preload storms on shared disk** → Rate-limit scheduler, respect max concurrent downloads, integrate with disk health check.
- **Stale artifact references** after demotion → Link demoted handles to artifact hash; invalidate memory handle if disk entry disappears.
- **Operational visibility** → Ship default Grafana dashboard + CLI summary to ensure teams adopt metrics.

---

## 12. Open Questions

1. Do we need cross-instance coordination to avoid redundant preloads in a clustered deployment? (If yes, consider Redis-based lease.)
2. Should we expose a gRPC/HTTP endpoint for external cache hints (e.g., product scheduling popular models)?
3. What is the acceptable warmup budget during startup? Need confirmation from ops to size concurrency + timeout defaults.
4. Do we require compression for disk cache in v1.2.0, or can it remain on the backlog until after multi-level foundation ships?

---

**Next Steps**
- Socialize this design with core engineering + ops in weekly architecture review.
- On approval, raise ADR-012 and create epics aligning with the phase plan.
- Prepare telemetry dashboard requirements for observability team.
