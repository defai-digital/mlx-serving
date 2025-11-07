# C++ Metal Kernel Optimization Analysis
**Deep Dive: Should kr-serve-mlx Add C++ Components?**

**Date**: November 4, 2025
**Status**: Strategic Analysis
**Decision**: 🔴 **NOT RECOMMENDED** (see conclusions)

---

## Executive Summary

After comprehensive analysis, **we do NOT recommend adding C++ Metal kernels to kr-serve-mlx** at this time. The performance gains don't justify the development cost, and better alternatives exist.

**Key Findings:**
1. **Diminishing Returns**: kr-serve-mlx is already 1.021× faster than mlx-engine
2. **kr-infer Not Production Ready**: Custom Metal optimizations are theoretical (Phase 0)
3. **Better ROI**: Phase 1 optimizations can deliver 20-30% gains in 1-2 weeks
4. **Upstream Path**: Contributing to mlx-lm benefits entire ecosystem
5. **Architectural Complexity**: C++ breaks TypeScript-first philosophy

---

## Performance Analysis

### Current Performance Baseline

**kr-serve-mlx v1.0.0 vs mlx-engine:**

| Metric | kr-serve-mlx | mlx-engine | Speedup | Status |
|--------|--------------|------------|---------|--------|
| Token Throughput | 140.67 tok/s | 137.82 tok/s | **1.021×** | ✅ Faster |
| TTFT | 52.77ms | 53.31ms | **1.010×** | ✅ Faster |
| Pure Generation Speed | 148.51 tok/s | 144.61 tok/s | **1.027×** | ✅ Faster |
| 50-Question Avg | 96.5-97.5% | 100% baseline | 0.965-0.975× | Good |

**Analysis**: kr-serve-mlx is already competitive to faster, despite being a higher-level abstraction (TypeScript + Python vs Python-only).

### Theoretical Performance Ceiling

**MLX Framework Performance (from kr-infer benchmarks):**

| Configuration | Throughput | Latency | Memory |
|---------------|------------|---------|--------|
| seq512_b1 | 849,615 tok/s | 0.60ms | 11 MB |
| seq2048_b1 | 768,582 tok/s | 2.66ms | 140 MB |
| seq4096_b1 | 415,109 tok/s | 9.87ms | 536 MB |

**Key Insight**: These are **MLX baseline** numbers (what mlx-lm already provides). Custom Metal kernels could potentially improve on these.

### kr-infer Target Performance (Phase 2, 2026 Q1)

| Optimization | Target Speedup | Implementation Status |
|--------------|----------------|----------------------|
| Flash Attention | 1.8-2.2× | 🔴 Stub only (not implemented) |
| KV Quantization | 1.05× (memory) | 🔴 Stub only |
| Paged KV Cache | 1.03× | 🔴 Stub only |
| AMX Pipeline | 1.2-1.4× | 🔴 Stub only |
| **Overall Target** | **≥1.6×** | Phase 2 (2026 Q1) |

**Key Insight**: kr-infer's optimizations are **not yet implemented**. They're planned for 2026 Q1.

### Realistic Performance Gains from C++ Metal

**Scenario 1: Implement Flash Attention Only**
- Expected gain: 1.5-2.0× on attention operations
- Attention is ~30-40% of inference time
- **Net speedup: 1.15-1.25× overall** (15-25% improvement)
- Development time: 4-6 weeks

**Scenario 2: Full kr-infer Implementation**
- Expected gain: 1.5-2.0× overall (kr-infer target)
- Development time: 6-12 months (based on kr-infer Phase 0→2 timeline)
- **Net speedup: 1.5-2.0×** (50-100% improvement)
- Risk: High (unproven technology)

**Scenario 3: Phase 1 TypeScript/Python Optimizations**
- Expected gain: 1.2-1.3× overall (20-30% improvement)
- Development time: 1-2 weeks
- **Net speedup: 1.2-1.3×** (20-30% improvement)
- Risk: Low (proven patterns)

---

## Architecture Analysis

### Option A: Pure TypeScript/Python (Current)

```
┌─────────────────────────────────────┐
│  TypeScript API (kr-serve-mlx)      │
├─────────────────────────────────────┤
│  Python Runtime (mlx-lm/mlx-vlm)    │
├─────────────────────────────────────┤
│  MLX Framework (C++/Metal)           │
└─────────────────────────────────────┘
```

**Pros:**
- ✅ Simple architecture, easy to maintain
- ✅ TypeScript ecosystem benefits (npm, TypeScript types)
- ✅ Leverages upstream mlx-lm improvements automatically
- ✅ Low maintenance burden
- ✅ Fast development cycle

**Cons:**
- ❌ Limited control over low-level optimization
- ❌ Dependent on upstream MLX performance
- ❌ Python GIL limitations (though mitigated by async)

### Option B: Hybrid TypeScript/Python + C++ Metal

```
┌─────────────────────────────────────┐
│  TypeScript API (kr-serve-mlx)      │
├─────────────────────────────────────┤
│  Python Runtime (mlx-lm/mlx-vlm)    │
├─────────────────────────────────────┤
│  Custom C++ Layer (NEW)              │
│  - Flash Attention Kernels           │
│  - Optimized RoPE                    │
│  - KV Cache Management               │
├─────────────────────────────────────┤
│  MLX Framework (C++/Metal)           │
└─────────────────────────────────────┘
```

**Pros:**
- ✅ Potential 15-25% performance gain (Flash Attention)
- ✅ Fine-grained control over Metal kernels
- ✅ Can optimize for M3/M4 specific features

**Cons:**
- ❌ Significant development complexity (C++/Metal/pybind11)
- ❌ High maintenance burden (keep up with MLX changes)
- ❌ Risk of divergence from upstream MLX
- ❌ Longer development cycle (4-6 weeks minimum)
- ❌ Team expertise required (C++, Metal, GPU programming)
- ❌ Build complexity (CMake, cross-compilation)

### Option C: Upstream Contribution to MLX

```
┌─────────────────────────────────────┐
│  TypeScript API (kr-serve-mlx)      │
├─────────────────────────────────────┤
│  Python Runtime (mlx-lm/mlx-vlm)    │
├─────────────────────────────────────┤
│  MLX Framework (C++/Metal)           │
│  + Contributed Optimizations         │
│    - Flash Attention (PR)            │
│    - Optimized Ops (PR)              │
└─────────────────────────────────────┘
```

**Pros:**
- ✅ Benefits entire MLX ecosystem
- ✅ Community review and validation
- ✅ Maintained by Apple/community
- ✅ No local maintenance burden
- ✅ Automatic propagation to kr-serve-mlx

**Cons:**
- ❌ Slower PR review process
- ❌ Less control over timeline
- ❌ May not align with Apple's priorities

---

## Development Cost Analysis

### Option A: Phase 1 TypeScript/Python Optimizations

**Timeline**: 1-2 weeks

| Task | Effort | Risk |
|------|--------|------|
| Request Batching | 3 days | Low |
| Model Cache Optimization | 4 days | Low |
| Enhanced Telemetry | 3 days | Low |
| **Total** | **10 days** | **Low** |

**Expected Performance Gain**: 20-30% (1.2-1.3×)
**ROI**: **High** (quick wins, low risk)

### Option B: C++ Flash Attention Implementation

**Timeline**: 4-6 weeks

| Task | Effort | Risk |
|------|--------|------|
| C++ Project Setup (CMake, pybind11) | 3 days | Medium |
| Metal Kernel Development | 10-14 days | High |
| Flash Attention Algorithm | 5-7 days | High |
| Integration with mlx-lm | 3-5 days | Medium |
| Testing & Validation | 5-7 days | Medium |
| Documentation | 2-3 days | Low |
| **Total** | **28-42 days** | **High** |

**Expected Performance Gain**: 15-25% (1.15-1.25×)
**ROI**: **Low** (high effort, moderate gain)

### Option C: Full kr-infer Style Implementation

**Timeline**: 6-12 months

| Task | Effort | Risk |
|------|--------|------|
| C++ Core Runtime | 4-6 weeks | Medium |
| Custom Metal Kernels | 8-12 weeks | High |
| Flash Attention | 4-6 weeks | High |
| KV Quantization | 3-4 weeks | Medium |
| Paged KV Cache | 3-4 weeks | Medium |
| AMX Pipeline | 4-6 weeks | High |
| Integration & Testing | 6-8 weeks | High |
| Production Hardening | 4-6 weeks | Medium |
| **Total** | **36-52 weeks** | **Very High** |

**Expected Performance Gain**: 50-100% (1.5-2.0×)
**ROI**: **Very Low** (massive effort, uncertain gain)

---

## Technical Feasibility Analysis

### Flash Attention Implementation Complexity

**Algorithm Overview:**
```
Traditional Attention: O(N²) memory, compute-bound
Flash Attention: O(N) memory, I/O-optimized

Key Techniques:
1. Tiling (block-wise computation)
2. Recomputation (avoid storing intermediate)
3. Softmax fusion (reduce memory bandwidth)
```

**Metal Implementation Challenges:**

1. **Kernel Complexity**
   - Flash Attention requires sophisticated tiling strategies
   - Metal shader language has limitations vs CUDA
   - Debugging Metal kernels is harder than Python

2. **Integration with MLX**
   - Must maintain compatibility with MLX tensor format
   - Need to handle MLX lazy evaluation
   - Risk of breaking MLX's unified memory model

3. **Testing & Validation**
   - Numerical accuracy critical (bit-level consistency)
   - Performance validation across model sizes
   - Regression testing for every MLX update

4. **M3/M4 Optimization**
   - AMX coprocessor requires specific API usage
   - Enhanced Metal 3.3 features need careful tuning
   - Different behavior on M3 Pro/Max/Ultra

**Realistic Assessment**:
- **Minimum viable implementation**: 4 weeks (experienced Metal developer)
- **Production-ready implementation**: 6-8 weeks
- **Ongoing maintenance**: 20% of original development time per year

### MLX Framework Limitations

**Current MLX Performance (from kr-infer benchmarks):**
- Already well-optimized for M-series chips
- Uses Metal Performance Shaders (MPS) where appropriate
- Implements efficient memory management

**Room for Improvement:**
- Flash Attention not yet in MLX (as of Oct 2025)
- KV cache could be more efficient
- Speculative decoding could be faster

**BUT**: Apple is actively developing MLX
- Regular updates and performance improvements
- Community contributions welcome
- Future updates may include Flash Attention

---

## Strategic Considerations

### 1. Team Expertise & Resources

**Required Skills for C++/Metal Development:**
- ✅ C++17 (CMake, modern C++)
- ✅ Metal Shading Language
- ✅ GPU programming concepts (tiling, memory coalescing)
- ✅ pybind11 (Python/C++ binding)
- ✅ Numerical optimization (floating-point accuracy)
- ✅ Apple Silicon architecture (M3/M4 specifics, AMX)

**Current kr-serve-mlx Team:**
- ✅ Strong TypeScript/Node.js expertise
- ✅ Python development
- ❓ C++/Metal expertise (unknown)

**Assessment**: If team doesn't have Metal expertise, hire cost is significant.

### 2. Maintenance Burden

**Ongoing Maintenance Tasks:**
- Keep up with MLX API changes (every release)
- Update Metal kernels for new hardware (M5, M6...)
- Debug platform-specific issues
- Maintain build system (CMake, cross-compilation)
- Update documentation

**Estimated Maintenance**: 1-2 days per month minimum

### 3. Time-to-Market

**Scenario 1: TypeScript/Python Optimizations**
- Implementation: 1-2 weeks
- Testing: 3-5 days
- Release v1.1.0: **~3 weeks total**
- **Market impact**: Quick performance improvements, low risk

**Scenario 2: C++ Flash Attention**
- Implementation: 4-6 weeks
- Testing: 2-3 weeks
- Release v1.1.0: **~8-10 weeks total**
- **Market impact**: Moderate performance improvements, higher risk

**Scenario 3: Full C++ Rewrite**
- Implementation: 6-12 months
- Testing: 2-3 months
- Release v2.0.0: **~12-18 months total**
- **Market impact**: Uncertain (kr-infer not yet proven)

### 4. Competitive Positioning

**Current Market:**
- mlx-engine: Baseline Python implementation
- kr-serve-mlx: TypeScript API, 1.021× faster than mlx-engine ✅
- llama.cpp: C++, but not MLX-optimized
- vLLM: High-performance, but CUDA-only

**kr-serve-mlx Unique Value:**
- ✅ TypeScript-first (Node.js ecosystem)
- ✅ Type-safe API
- ✅ Already faster than mlx-engine
- ✅ Production-ready (v1.0.0)

**Adding C++/Metal:**
- Would differentiate from mlx-engine (more)
- But loses TypeScript-first simplicity
- Competes on different axis than intended

**Strategic Question**: Is kr-serve-mlx's value proposition "fastest MLX inference" or "best TypeScript MLX integration"?

**Answer**: TypeScript integration is the core value prop. Performance is important, but not at the cost of complexity.

---

## Risk Assessment

### Technical Risks (C++ Implementation)

| Risk | Probability | Impact | Severity |
|------|-------------|--------|----------|
| Metal kernel bugs | High | High | 🔴 Critical |
| Numerical inconsistency | Medium | High | 🔴 Critical |
| Platform compatibility | Medium | Medium | 🟡 Moderate |
| Build system complexity | High | Medium | 🟡 Moderate |
| Maintenance burden | High | High | 🔴 Critical |
| Team expertise gap | Unknown | High | 🔴 Critical |

### Business Risks

| Risk | Probability | Impact | Severity |
|------|-------------|--------|----------|
| Delayed time-to-market | High | High | 🔴 Critical |
| Resource diversion | High | Medium | 🟡 Moderate |
| Technical debt | High | High | 🔴 Critical |
| Competitive disadvantage | Low | Low | 🟢 Low |
| User confusion | Medium | Medium | 🟡 Moderate |

### Mitigation Strategies

**If proceeding with C++ (not recommended):**

1. **Start Small**
   - Implement only Flash Attention
   - Make it optional (fallback to MLX)
   - Measure before/after rigorously

2. **Upstream First**
   - Contribute Flash Attention to MLX
   - Only implement locally if rejected
   - This de-risks maintenance

3. **Expertise Investment**
   - Hire Metal expert (contractor or full-time)
   - Budget 20% time for ongoing maintenance
   - Document everything

4. **Incremental Rollout**
   - Alpha release (opt-in, experimental)
   - Beta release (default, with escape hatch)
   - GA release (after 3+ months stable)

---

## Alternative Approaches

### Alternative 1: Python-Level Optimizations (Recommended)

**Approach**: Optimize Python runtime without C++

1. **Request Batching** (Phase 1)
   - Already designed, 1-2 weeks implementation
   - 50-80% IPC reduction
   - Zero C++ complexity

2. **Model Caching with Mmap** (Phase 1)
   - Memory-mapped files (Python `mmap` module)
   - 90%+ load time reduction
   - No C++ needed

3. **Python Profiling & Optimization**
   - Use `cProfile` to find bottlenecks
   - Optimize hot paths
   - Maybe Cython for critical sections (easier than C++)

**Expected Gain**: 20-30% (Phase 1), 40-60% (Phase 2)
**Effort**: 2-6 weeks
**Risk**: Low

### Alternative 2: Upstream MLX Contributions (Recommended)

**Approach**: Contribute optimizations to ml-explore/mlx

1. **Identify MLX Bottlenecks**
   - Profile mlx-lm with kr-serve-mlx workloads
   - Find operations that could be faster

2. **Implement Optimizations**
   - Flash Attention (if not already planned)
   - Optimized RoPE
   - Better KV cache

3. **Submit PRs to MLX**
   - Work with Apple/community
   - Get optimizations into mainline
   - Benefits entire ecosystem

**Expected Gain**: Varies (depends on what's merged)
**Effort**: 4-12 weeks (includes PR review time)
**Risk**: Medium (depends on Apple's priorities)

**Benefits:**
- ✅ No local maintenance burden
- ✅ Community validation
- ✅ Automatic propagation to kr-serve-mlx
- ✅ Ecosystem contribution

### Alternative 3: Hybrid Approach with Feature Flags

**Approach**: Implement C++ optimizations as optional features

1. **Core remains TypeScript/Python**
   - Default behavior: No C++ dependency
   - Works on all platforms

2. **Optional C++ Acceleration**
   - Install via `npm install @kr-serve-mlx/metal-acceleration`
   - Enable via config flag
   - Falls back gracefully if unavailable

3. **Progressive Enhancement**
   - Users can opt-in for performance
   - Doesn't complicate default experience
   - Easier to deprecate if needed

**Benefits:**
- ✅ Best of both worlds
- ✅ Low-risk for users
- ✅ Can experiment with C++

**Drawbacks:**
- ❌ More complex to maintain (two code paths)
- ❌ Testing burden (with/without C++)
- ❌ User confusion (which version to use?)

---

## Benchmark: Real-World Impact Analysis

### Use Case 1: Single-User Development

**Scenario**: Developer running kr-serve-mlx locally for testing

**Current Performance:**
- Load model: ~5s (first time), ~500ms (cached)
- Generate 100 tokens: ~800ms
- TTFT: ~50ms

**With Phase 1 Optimizations:**
- Load model: ~5s (first time), ~50ms (mmap cached) ✅ **10× faster**
- Generate 100 tokens: ~800ms (same, single request)
- TTFT: ~50ms (same)

**With C++ Flash Attention:**
- Load model: ~5s (same)
- Generate 100 tokens: ~640ms ✅ **20% faster**
- TTFT: ~40ms ✅ **20% faster**

**Winner**: Phase 1 for development use case (faster iteration)

### Use Case 2: Multi-User Production Server

**Scenario**: Server handling 100 requests/minute

**Current Performance:**
- Throughput: 140 tok/s per request
- Latency: ~50ms p95
- IPC overhead: ~100ms total (100 requests × 1ms)

**With Phase 1 Optimizations:**
- Throughput: 140 tok/s (same)
- Latency: ~50ms p95 (same)
- IPC overhead: ~10ms total (10 batches × 1ms) ✅ **90% reduction**
- **Effective throughput**: **1.9× higher** (due to reduced overhead)

**With C++ Flash Attention:**
- Throughput: 168 tok/s per request ✅ **20% faster**
- Latency: ~40ms p95 ✅ **20% faster**
- IPC overhead: ~100ms total (same)
- **Effective throughput**: **1.2× higher**

**Winner**: Phase 1 for production use case (batching > raw speed)

### Use Case 3: Long Context Generation

**Scenario**: Generate with 32K context length

**Current Performance:**
- Prefill (32K tokens): ~2-3 seconds
- Decode (1 token): ~15ms
- Memory usage: ~8GB

**With Phase 1 Optimizations:**
- Prefill: ~2-3 seconds (same)
- Decode: ~15ms (same)
- Memory usage: ~8GB (same)

**With C++ Flash Attention:**
- Prefill: ~1.2-1.5 seconds ✅ **40-50% faster**
- Decode: ~15ms (same, KV cache dominates)
- Memory usage: ~6GB ✅ **25% reduction**

**Winner**: C++ Flash Attention (significant improvement for long contexts)

---

## Decision Matrix

### Quantitative Comparison

| Criterion | Weight | Phase 1 (TS/Py) | C++ Flash Attn | Full C++ Rewrite |
|-----------|--------|------------------|----------------|------------------|
| **Performance Gain** | 30% | 🟡 20-30% (3) | 🟡 15-25% (2.5) | 🟢 50-100% (5) |
| **Development Time** | 25% | 🟢 1-2 weeks (5) | 🟡 4-6 weeks (3) | 🔴 6-12 months (1) |
| **Maintenance Burden** | 20% | 🟢 Low (5) | 🔴 High (2) | 🔴 Very High (1) |
| **Risk Level** | 15% | 🟢 Low (5) | 🟡 Medium (3) | 🔴 High (1) |
| **Team Alignment** | 10% | 🟢 High (5) | 🟡 Medium (3) | 🔴 Low (1) |
| **Total Score** | 100% | **4.25** ⭐⭐⭐⭐ | **2.68** ⭐⭐ | **1.90** ⭐ |

### Qualitative Assessment

**Phase 1 TypeScript/Python Optimizations:**
- ✅ Quick wins, low risk
- ✅ Maintains project philosophy
- ✅ High ROI
- ✅ Easy to implement and maintain
- 🟢 **STRONGLY RECOMMENDED**

**C++ Flash Attention (Standalone):**
- 🟡 Moderate performance gains
- ❌ High development cost
- ❌ Ongoing maintenance burden
- 🟡 Use case dependent (benefits long contexts)
- 🟡 **CONSIDER ONLY IF**: Long context is core use case

**Full C++ Rewrite (kr-infer style):**
- 🟢 Best raw performance (theoretical)
- ❌ Massive development cost
- ❌ Abandons TypeScript-first philosophy
- ❌ kr-infer not yet proven
- 🔴 **NOT RECOMMENDED**

---

## Conclusions & Recommendations

### Primary Recommendation: Phase 1 TypeScript/Python Optimizations

**Implement Phase 1 optimizations WITHOUT adding C++:**

1. **Request Batching** (50-80% IPC reduction)
2. **Model Artifact Cache with Mmap** (90%+ load time reduction)
3. **Enhanced Telemetry** (<3% overhead)

**Timeline**: 1-2 weeks
**Expected Gain**: 20-30% overall performance improvement
**Risk**: Low
**ROI**: ⭐⭐⭐⭐⭐ Excellent

### Secondary Recommendation: Upstream MLX Contributions

**After Phase 1, contribute optimizations to MLX:**

1. Profile mlx-lm with kr-serve-mlx workloads
2. Identify bottlenecks (Flash Attention, KV cache, etc.)
3. Submit PRs to ml-explore/mlx
4. Benefits entire ecosystem

**Timeline**: 4-12 weeks (ongoing)
**Expected Gain**: Varies (automatic propagation to kr-serve-mlx)
**Risk**: Medium
**ROI**: ⭐⭐⭐⭐ Good (ecosystem benefit)

### Conditional Recommendation: C++ Flash Attention

**ONLY if ALL conditions are met:**

1. ✅ Phase 1 optimizations completed
2. ✅ Long context (>16K) is core use case
3. ✅ Team has C++/Metal expertise (or budget to hire)
4. ✅ Willing to invest 4-6 weeks + ongoing maintenance
5. ✅ Upstream MLX doesn't implement Flash Attention first

**IF conditions met:**
- Implement as optional feature (feature flag)
- Start with standalone PR to MLX (upstream first)
- Only implement locally if upstream rejected

**ROI**: ⭐⭐ Fair (only for specific use cases)

### NOT Recommended: Full C++ Rewrite

**Do NOT pursue full kr-infer style C++ rewrite:**

1. ❌ kr-infer is Phase 0 (not production-ready)
2. ❌ Abandons TypeScript-first philosophy
3. ❌ Massive development cost (6-12 months)
4. ❌ High risk, uncertain payoff
5. ❌ Better alternatives exist

**ROI**: ⭐ Poor

---

## Action Plan

### Immediate Actions (This Week)

1. ✅ **Approve Phase 1 implementation plan**
2. 🔄 **Start Phase 1: Request Batching** (3 days)
3. 🔄 **Profile mlx-lm** to identify bottlenecks

### Short-Term (Next 2-4 Weeks)

1. Complete Phase 1 optimizations
2. Measure performance improvements
3. Benchmark long context scenarios
4. Evaluate need for C++ (if long context is critical)

### Medium-Term (Next 2-3 Months)

1. Contribute optimizations to MLX (upstream)
2. Monitor MLX development (Flash Attention, etc.)
3. Re-evaluate C++ decision based on:
   - Phase 1 results
   - MLX upstream progress
   - User feedback on long context needs

### Decision Gates

**Gate 1 (After Phase 1 - 2 weeks):**
- If Phase 1 delivers 20-30% improvement ✅
  → Proceed with Phase 2 (Python optimizations)
- If Phase 1 delivers <15% improvement ❌
  → Consider C++ Flash Attention

**Gate 2 (After Phase 2 - 6 weeks):**
- If MLX adds Flash Attention upstream ✅
  → Automatic benefit, no C++ needed
- If long context use cases dominate ✅
  → Consider C++ Flash Attention
- Otherwise ❌
  → Continue with Python/TS optimizations

---

## Final Verdict

🔴 **DO NOT ADD C++ METAL COMPONENTS AT THIS TIME**

**Rationale:**
1. kr-serve-mlx is already faster than mlx-engine
2. Phase 1 optimizations offer better ROI (20-30% gain in 1-2 weeks)
3. C++ adds complexity without proportional benefit
4. Upstream MLX contributions are better long-term strategy
5. TypeScript-first philosophy is core value proposition

**Next Steps:**
1. ✅ Implement Phase 1 optimizations (approved plan)
2. ✅ Measure and validate improvements
3. ✅ Profile and contribute to upstream MLX
4. 🔄 Re-evaluate C++ decision in 3 months based on:
   - Phase 1/2 results
   - MLX upstream progress
   - User feedback

---

**Document Status**: Analysis Complete
**Decision**: Phase 1 TypeScript/Python optimizations only
**Rationale**: Better ROI, lower risk, maintains project philosophy
