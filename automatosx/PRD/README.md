# mlx-serving Planning Documents

**Current Status**: v0.12.0-alpha.3 Production Ready
**Last Updated**: 2025-11-09

---

## Active Documents

### 🚀 NEW: Distributed Inference System (Mac-Only)

**Status**: Planning Phase - Ready for Implementation
**Target**: Q1 2026 (GA Release)

#### [DISTRIBUTED-INFERENCE-PRD.md](./DISTRIBUTED-INFERENCE-PRD.md) (9,900+ lines)
Complete Product Requirements Document for distributed Mac cluster:
- **Architecture**: Controller/Worker (centralized, not P2P like exo-explore)
- **Messaging**: NATS for inter-node communication
- **Load Balancing**: Hardware-aware (M1-M5 optimization)
- **Dashboard**: Web-based cluster visualization
- **Features**: Auto-discovery, task distribution, sticky sessions
- **Timeline**: 12-13 weeks (5 phases)

**Key Differentiators from exo-explore**:
- Task distribution (not layer splitting)
- Centralized control (not P2P)
- Mac-only optimization with MLX/Metal
- Full-featured web dashboard
- Production-grade observability

#### [DISTRIBUTED-INFERENCE-ACTION-PLAN.md](./DISTRIBUTED-INFERENCE-ACTION-PLAN.md) (600+ lines)
Detailed implementation guide with:
- Task breakdown for all 5 phases
- Code examples for key components
- Time estimates and validation criteria
- Technology stack: NATS, React, Express, Prometheus

---

### PUBLISHING-CHECKLIST.md
Guide for publishing releases to npm. Use this checklist for all releases.

### FUTURE_PLANS.md ⭐
**Metal GPU optimizations deferred to 2026+**
- Phase 1 complete (34,749 lines of infrastructure code)
- Phase 2 blocked (requires MLX fork or upstream contribution)
- Decision: Focus on current working optimizations for 2025
- See document for two paths forward (Fork vs Upstream Contribution)

---

## Current Production Features (v0.11.0)

### Working Optimizations
- ✅ **Weight Manager Warmup**: 512MB pre-allocation (5-10% TTFT improvement)
- ✅ **Request Deduplication**: Collapse duplicate concurrent requests
- ✅ **Prompt Cache**: LRU cache with 5-minute TTL
- ✅ **Request Coalescing**: Multiplex streaming responses
- ✅ **Model Concurrency Limiter**: Prevents GPU crashes on 30B+ models

### Performance Results
```
Llama 3.1 70B: 8.93 tok/s (mlx-serving) vs 8.92 tok/s (mlx-engine) → Tie
Qwen 3 30B: 82.39 tok/s (mlx-serving) vs 85.86 tok/s (mlx-engine) → -4.04%
Success Rate: 100% on both models
```

### Code Quality
- **Lines of Code**: 34,749 (C++/Python/TypeScript)
- **Test Coverage**: 98.1% (922/942 tests passing)
- **Lint Status**: 0 errors, 0 warnings

---

## Archive

### ARCHIVE/WEEK1-3-METAL-PLANS/
All Week 1-3 metal optimization planning documents (deferred to 2026+)

### ARCHIVE/ (Other historical documents)
- Architecture designs
- Feature specifications
- Phase 0-5 planning documents

---

## Related Documentation

- **Implementation Reports**: `automatosx/tmp/`
- **Technical Docs**: `docs/`
- **Native Code**: `native/` (487KB compiled C++ module)

---

**2025 Focus**: Stability, reliability, production features
**Deferred to 2026+**: Metal GPU optimizations (see FUTURE_PLANS.md)
