# mlx-serving Performance Optimization Project - Overview

**Created**: 2025-11-07
**Status**: Ready for Implementation
**Timeline**: 22 days
**Target**: 120-150% of mlx-engine performance

---

## 📋 Project Summary

This project will optimize mlx-serving to achieve **120-150% of mlx-engine performance** for production workloads by leveraging TypeScript's superior concurrency, caching, and orchestration capabilities.

**Current State**: 96% performance parity  
**Target State**: 120-150% performance with production-grade features  
**Approach**: 3-phase incremental delivery with feature flags and comprehensive testing

---

## 📚 Documentation Structure

### Core Documents (Read These)

1. **mlx-serving-performance-optimization-prd.md** 📄
   - **Created by**: AutomatosX Product Agent
   - **Purpose**: Product Requirements Document
   - **Audience**: All stakeholders, product, engineering, QA
   - **Key Sections**:
     - Executive Summary
     - Goals & Success Metrics (quantified: 110%, 105%, 120%)
     - User Stories (platform engineers, SREs, product owners, data scientists)
     - Technical Requirements (3 phases)
     - Risk Analysis & Mitigation
     - Testing Strategy
   - **Read this if**: You need to understand business goals, user needs, or success criteria

2. **mlx-serving-performance-optimization-action-plan.md** 🏗️
   - **Created by**: AutomatosX Architecture Agent
   - **Purpose**: Architecture Decision Records & Implementation Guidance
   - **Audience**: Architects, tech leads, senior engineers
   - **Key Sections**:
     - 9 ADRs (ADR-012 through ADR-020)
     - Performance targets & KPIs
     - Code structure & module organization
     - API contracts (TypeScript + Python)
     - Rollback strategies
     - Observability integration
   - **Read this if**: You need architectural context, ADR details, or system design

3. **IMPLEMENTATION-PLAN.md** ⭐ **START HERE**
   - **Created by**: Implementation planning (this session)
   - **Purpose**: Day-by-day actionable task list
   - **Audience**: Engineers implementing the project
   - **Key Sections**:
     - Phase 0 (Days 0-1): Foundation setup
     - Phase 1 (Days 2-3): Caching layer (+10-30%)
     - Phase 2 (Days 4-10): Multi-worker (+5-15%)
     - Phase 3 (Days 11-24): Production hardening (+10-20%)
     - File-level tasks with time estimates
     - Testing requirements per phase
     - Emergency rollback procedures
   - **Read this if**: You're implementing the project (THIS IS YOUR WORK PLAN)

---

## 🎯 Quick Start Guide

### For Engineers (Implementation Team)

**Step 1**: Read IMPLEMENTATION-PLAN.md thoroughly (60 minutes)
**Step 2**: Review mlx-serving-performance-optimization-prd.md sections 1-5 (30 minutes)
**Step 3**: Scan mlx-serving-performance-optimization-action-plan.md ADRs 012-014 (15 minutes)
**Step 4**: Start Phase 0, Task 0.1 from IMPLEMENTATION-PLAN.md

**Your daily workflow**:
```bash
# Morning: Review tasks for the day
less automatosx/PRD/IMPLEMENTATION-PLAN.md

# Work: Complete tasks, check them off
# Evening: Update status, prepare for next day
```

### For Product/Engineering Leads

**Step 1**: Read PRD Executive Summary & Goals (pages 1-3)
**Step 2**: Review success metrics and timeline
**Step 3**: Approve resources and kickoff
**Step 4**: Assign engineers to Phase 0 tasks

### For Architects/Tech Leads

**Step 1**: Read Action Plan sections 1-4 (Context, KPIs, Guardrails, ADRs)
**Step 2**: Review ADRs 012-014 for Phase 1 (approve/modify)
**Step 3**: Provide feedback on module organization
**Step 4**: Monitor implementation, review code

### For QA Engineers

**Step 1**: Read PRD Section 10 (Testing Strategy)
**Step 2**: Review IMPLEMENTATION-PLAN.md testing sections for each phase
**Step 3**: Set up test environments (staging, benchmark server)
**Step 4**: Prepare test automation framework

---

## 🎯 Performance Targets

| Phase | Timeline | Target | Workload | Key Features |
|-------|----------|--------|----------|--------------|
| **Phase 0** | Days 0-1 | Baseline | Setup | Config, observability, baseline capture |
| **Phase 1** | Days 2-3 | **110-130%** | Duplicate-heavy | Request dedup, prompt cache, coalescing |
| **Phase 2** | Days 4-10 | **105-115%** | Mixed | Multi-worker, adaptive batching, retry |
| **Phase 3** | Days 11-24 | **120-150%** | High concurrency | Connection pool, streaming, memory mgmt |

**Current Baseline**: 96% parity
- Qwen3-30B: 87.73 tok/s vs mlx-engine's 90.99 tok/s
- Gemma 2 27B: 19.29 tok/s vs mlx-engine's 20.54 tok/s

---

## 🏗️ Architecture Evolution

### Current (Baseline)
```
TypeScript API (Node.js)
    ↓ JSON-RPC
Python Runtime (1 worker) ← Bottleneck
    ↓ Metal
GPU (Sequential)
```

### After Phase 1 (Caching)
```
TypeScript API + Caching Layer
    ↓ JSON-RPC
Python Runtime (1 worker)
    ↓ Metal
GPU
```

### After Phase 2 (Multi-worker)
```
TypeScript API + Caching
    ↓ Round-robin Router
[Worker 1] [Worker 2] [Worker 3] ...
    ↓ Metal
GPU (Shared, scheduled)
```

### After Phase 3 (Production)
```
TypeScript API + Caching + Connection Pool
    ↓ Routing + Streaming Optimization
Worker Pool + Memory Lifecycle
    ↓ Metal
GPU (80%+ utilization)
```

---

## 🔧 Key Optimizations Summary

### Phase 1: TypeScript Caching Layer
1. **Request Deduplication** (1s TTL)
   - SHA256-keyed cache of `(model_id, prompt, params)`
   - Share Promise across duplicate requests
   - Files: `src/core/request-deduplicator.ts`

2. **Prompt Cache** (LRU 10k entries)
   - Size-aware eviction (tokens + bytes)
   - Longer TTL (5 minutes default)
   - Files: `src/core/prompt-cache.ts`

3. **Request Coalescing**
   - Merge identical concurrent requests
   - N→1 inference, fan-out responses
   - Files: `src/core/coalescing-registry.ts`

### Phase 2: Multi-Worker Scaling
4. **Multi-Worker Routing**
   - Spawn N Python workers
   - Round-robin or least-busy strategy
   - Files: `src/core/runtime-router.ts`, `src/bridge/python-runtime-manager.ts`

5. **Adaptive Batching**
   - Dynamic batch size (2-16)
   - EMA-based latency feedback
   - Files: `python/models/adaptive_controller.py`

6. **Smart Retry Logic**
   - Exponential backoff + jitter
   - Circuit breaker pattern
   - Files: `src/core/retry-policy.ts`

### Phase 3: Production Hardening
7. **Connection Pooling**
   - Reuse Python connections (>90% rate)
   - Warm pool on startup
   - Files: `src/bridge/jsonrpc-transport.ts`

8. **Streaming Optimizations**
   - Backpressure-aware SSE writer
   - Chunk aggregation (64KB boundary)
   - Files: `src/core/stream-registry.ts`

9. **Memory Management**
   - Auto-unload idle models (5min timeout)
   - Predictive prefetch
   - Files: `python/gpu_scheduler.py`, `src/services/model-lifecycle-service.ts`

---

## ✅ Success Criteria Quick Reference

### Phase 1
- [ ] ≥110% tok/s for duplicate workloads
- [ ] >50% cache hit rate (deduplication)
- [ ] >80% cache hit rate (prompt cache)
- [ ] 100% test coverage
- [ ] Zero regressions on non-duplicate workloads

### Phase 2
- [ ] ≥105% tok/s for mixed workloads
- [ ] Workers evenly utilized (±10%)
- [ ] Adaptive batch size adjusting (2-16)
- [ ] >95% success rate after retry
- [ ] Chaos tests pass

### Phase 3
- [ ] ≥120% tok/s at 100 concurrent users
- [ ] P95 latency < 120ms
- [ ] >90% connection reuse rate
- [ ] 72h soak test passed
- [ ] Zero dropped requests during restart

---

## 🚨 Emergency Rollback

### Quick Disable (< 1 minute)
```yaml
# config/runtime.yaml
request_deduplication.enabled: false
prompt_cache.enabled: false
request_coalescing.enabled: false
python_runtime.workers: 1  # Single worker
generate_batcher.adaptive_sizing: false
generation_retry.enabled: false
python_runtime.connection_pool.enabled: false
streaming.optimized_writer: false
model.memory_policy.enabled: false
```

### Or via Environment Variables
```bash
export MLX_REQUEST_DEDUP_ENABLED=false
export MLX_PROMPT_CACHE_ENABLED=false
export MLX_REQUEST_COALESCING_ENABLED=false
export MLX_WORKER_COUNT=1
# ... etc (restart service)
```

---

## 📊 Monitoring & Observability

### Critical Metrics (Phase 1+)
- `mlx_cache_hits`, `mlx_cache_misses` (counter)
- `mlx_dedupe_ratio` (gauge)
- `mlx_prompt_cache_size` (gauge)

### Advanced Metrics (Phase 2+)
- `mlx_batch_size` (histogram)
- `mlx_worker_active` (gauge)
- `mlx_retry_attempts` (counter)
- `mlx_circuit_state` (gauge)

### Production Metrics (Phase 3+)
- `mlx_connection_pool_available` (gauge)
- `mlx_stream_backpressure_events` (counter)
- `mlx_model_lifecycle_unloads` (counter)

### Alerts
**Critical** (page immediately):
- Worker heartbeat missing > 10s
- Error rate > 1%
- P95 latency > 3s

**Warning** (Slack):
- Cache error rate > 0.1%
- Connection pool exhaustion

---

## 👥 Team & Resources

### Engineering Team
- **Backend Engineer** (primary): Full-time, all phases
- **Python Engineer**: Phase 2-3 (adaptive batching, memory mgmt)
- **DevOps Engineer**: Phase 3 (connection pooling, deployment)
- **QA Engineer**: All phases (testing, validation)

### Infrastructure
- **Staging**: 4 GPU instances for multi-worker testing
- **Benchmark Server**: Dedicated instance for reproducible tests
- **Monitoring**: Prometheus + Grafana

### Timeline
- Phase 0: 1.5 days (foundation)
- Phase 1: 2.5 days (caching)
- Phase 2: 5.75 days (multi-worker)
- Phase 3: 8.9 days (production hardening)
- **Total**: ~22 days (18.65 active + 3 days automated soak)

---

## 🚀 Next Steps (Today)

1. **Technical Lead** (30 min):
   - [ ] Review all 3 documents
   - [ ] Approve timeline and resources
   - [ ] Assign engineers to tasks

2. **Engineering Team** (1 hour):
   - [ ] Read IMPLEMENTATION-PLAN.md fully
   - [ ] Set up development environment
   - [ ] Prepare for Phase 0 kickoff

3. **Project Setup** (1 hour):
   - [ ] Create GitHub project or Jira board
   - [ ] Create Slack channel: `#mlx-serving-optimization`
   - [ ] Schedule daily standup (15min)

4. **Tomorrow Morning** (Day 0):
   - [ ] Kickoff meeting (30min)
   - [ ] Start Phase 0, Task 0.1 (configuration infrastructure)

---

## 📞 Support & Communication

### Project Channels
- **Slack**: `#mlx-serving-optimization` (daily updates)
- **GitHub**: Tag issues with `performance-optimization`
- **Meetings**: Daily standup (15min) + weekly review (30min)

### Documentation
- **This Directory**: `automatosx/PRD/`
- **ADRs**: `docs/architecture/adr/ADR-*.md` (created in Phase 0)
- **Runbooks**: `docs/operations/phase{1,2,3}-rollout.md` (created per phase)

---

## 🔗 Related Documents

### Background Analysis
- `automatosx/PRD/kr-serve-mlx-cpp-hybrid-analysis.md` - C++ acceleration analysis (conclusion: not needed for Phase 1-3)

### Benchmark Results (Current Baseline)
- `benchmarks/results/qwen3-30b-20q-parallel.json` - Qwen3-30B parallel (96% parity, TIE)
- `benchmarks/results/gemma-27b-bf16-benchmark.json` - Gemma 2 27B (94% parity)

---

## TL;DR - 30-Second Summary

**What**: Optimize mlx-serving to be 120-150% faster than mlx-engine

**How**:
- Phase 1 (3 days): Add caching → +10-30% for duplicates
- Phase 2 (7 days): Multi-worker + adaptive batching → +5-15% overall
- Phase 3 (14 days): Connection pooling + streaming → +10-20% at high concurrency

**Start**: Read `IMPLEMENTATION-PLAN.md` → Begin Phase 0

**Timeline**: 22 days total

**Risk**: Low (feature flags + rollback ready)

---

**Last Updated**: 2025-11-07
**Version**: 1.0
**Status**: Ready for kickoff
