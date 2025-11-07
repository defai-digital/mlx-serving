# kr-infer Analysis & kr-serve-mlx Enhancement Plan

**Date**: November 4, 2025
**Purpose**: Analyze kr-infer performance optimizations and develop enhancement plan for kr-serve-mlx
**Status**: Analysis Complete, Enhancement Plan In Progress

---

## Executive Summary

**kr-infer** is a C++-based LLM inference engine with custom Metal kernels targeting 1.5-2× speedup over baseline MLX. **kr-serve-mlx** is a TypeScript API layer with Python bridge achieving production-ready performance (<1ms IPC overhead).

**Key Finding**: While kr-infer targets lower-level performance gains, kr-serve-mlx can adopt several architectural patterns and optimization techniques to achieve significant performance improvements without abandoning the TypeScript+Python architecture.

**Recommended Approach**: Hybrid strategy leveraging TypeScript API layer strengths while adopting kr-infer's optimization patterns at the Python runtime level.

---

## Architecture Comparison

### kr-infer Architecture

```
┌─────────────────────────────────────┐
│  User Application (Python/Node.js)  │
├─────────────────────────────────────┤
│  Python/Node.js Bindings (pybind11/N-API)
├─────────────────────────────────────┤
│  KR-Core (C++ Runtime, C ABI)       │
│  - Arena Allocator                   │
│  - Tensor Operations                 │
│  - Telemetry                         │
├─────────────────────────────────────┤
│  KR-MLX (Custom Metal Kernels)      │
│  - Flash Attention                   │
│  - Optimized RoPE                    │
│  - KV Cache Paging + Quantization    │
│  - AMX Coprocessor Pipeline          │
└─────────────────────────────────────┘
```

**Key Characteristics:**
- **Language**: C++ core with Python/Node.js bindings
- **Performance**: Target 1.5-2× speedup over MLX baseline
- **Status**: Phase 0 (Alpha) - Most optimizations not yet implemented
- **Deployment**: SDK (embedded) or Server (Docker with HTTP/MCP)
- **Hardware**: M3/M4 specific (AMX coprocessor, enhanced Metal)

### kr-serve-mlx Architecture

```
┌─────────────────────────────────────┐
│  Public API (TypeScript)             │
│  - Dual API (camelCase/snake_case)  │
├─────────────────────────────────────┤
│  Core Services (TypeScript)          │
│  - Model Manager                     │
│  - Generator Factory                 │
│  - Batch Queue                       │
├─────────────────────────────────────┤
│  JSON-RPC Bridge (<1ms overhead)     │
│  - Python Runner                     │
│  - Stream Registry                   │
├─────────────────────────────────────┤
│  Python Runtime                      │
│  - mlx-lm (v0.28.0)                  │
│  - mlx-vlm (v0.3.5)                  │
│  - Outlines (v0.1.25)                │
└─────────────────────────────────────┘
```

**Key Characteristics:**
- **Language**: TypeScript API + Python runtime
- **Performance**: <1ms IPC overhead, 96.5-97.5% of mlx-engine performance, 1.021× faster in token throughput
- **Status**: v1.0.0 Production Ready (15 bugs fixed, 99.5% test pass rate)
- **Deployment**: NPM package for Node.js integration
- **Hardware**: M3+ (macOS 26.0+ required)

---

## Performance Comparison

### kr-infer Performance Targets (Phase 2, 2026 Q1)

| Optimization | Target Speedup | Status |
|--------------|----------------|--------|
| Flash Attention | 1.8-2.2× | Planned (stub) |
| KV Quantization (INT8) | 20-30% memory reduction | Planned (stub) |
| Paged KV Cache | O(N) vs O(N²) reallocation | Planned (stub) |
| AMX Coprocessor | 1.2-1.4× matmul acceleration | Planned (stub) |
| **Overall Target** | **≥1.6× speedup** | Phase 2 |

**Current Status**: Phase 0 (v0.9.0-alpha) - Baseline benchmarks only, no optimizations implemented

### kr-serve-mlx Current Performance (v1.0.0)

| Metric | Value | Comparison |
|--------|-------|------------|
| **IPC Overhead** | <1ms (p95) | Target achieved ✅ |
| **Token Throughput** | 140.67 tok/s | 1.021× faster than mlx-engine ✅ |
| **TTFT** | 52.77ms | 1.010× faster than mlx-engine ✅ |
| **Pure Generation Speed** | 148.51 tok/s | 1.027× faster than mlx-engine ✅ |
| **50-Question Benchmark** | 96.5-97.5% | 100% success rate ✅ |

**Current Status**: Production-ready with excellent baseline performance

---

## Key Optimization Techniques from kr-infer

### 1. Arena Allocator (Zero-Syscall Memory)

**kr-infer Implementation:**
```cpp
// Arena allocator for zero-syscall cached allocations
kr_status_t kr_arena_create(size_t initial_size, kr_arena_t* arena);
kr_status_t kr_arena_alloc(kr_arena_t arena, size_t size, void** ptr);
kr_status_t kr_arena_reset(kr_arena_t arena); // Fast bulk deallocation
```

**Benefits:**
- Eliminates malloc/free syscall overhead
- Bulk deallocation in O(1)
- Cache-friendly memory layout

**kr-serve-mlx Application:**
- **High Impact**: Implement arena-style memory pooling in Python runtime for tensor allocations
- **Implementation**: Use `mlx.core.array` buffer pool for repeated generation calls
- **Expected Gain**: 5-10% reduction in allocation overhead

### 2. Performance Telemetry

**kr-infer Implementation:**
```cpp
// Built-in telemetry with <3% overhead
kr_telemetry_t telemetry;
kr_telemetry_record(telemetry, "generate", duration_ms);
```

**Benefits:**
- Real-time performance monitoring
- Identifies bottlenecks
- Minimal overhead (<3%)

**kr-serve-mlx Application:**
- **High Impact**: Add comprehensive telemetry to Python runtime and TypeScript layer
- **Implementation**: Extend existing `PerformanceStats` with Python-side metrics
- **Expected Gain**: Better observability, enables targeted optimization

### 3. Rigorous Benchmarking Infrastructure

**kr-infer Implementation:**
- 11 benchmark configurations (seq_len, batch_size, num_heads, head_dim)
- 100 runs per configuration
- p50/p95/p99 latency tracking
- Throughput and memory measurement

**Benefits:**
- Reproducible performance measurement
- Statistical rigor (≤5% variance)
- Performance regression detection

**kr-serve-mlx Application:**
- **Medium Impact**: Already have apple-to-apple and 50-question benchmarks
- **Enhancement**: Add more comprehensive micro-benchmarks for operations
- **Expected Gain**: Better performance tracking and optimization targeting

### 4. Custom Metal Kernels (Future)

**kr-infer Plan** (Phase 2):
- Flash Attention (Philip Turner kernels)
- Fused RoPE operations
- Optimized matmul with AMX coprocessor

**kr-serve-mlx Consideration:**
- **Low Immediate Impact**: Requires C++ development, breaks TypeScript-first philosophy
- **Alternative**: Contribute optimizations upstream to mlx-lm/mlx-vlm
- **Long-term**: Consider hybrid approach with optional C++ acceleration module

---

## Enhancement Opportunities for kr-serve-mlx

### High Priority (Immediate Implementation)

#### 1. Request Batching (Estimated 50-80% IPC Reduction)

**Current State**: Single request per IPC call
**Target**: Batch multiple requests to reduce round-trips

**Implementation:**
```typescript
// src/core/batch-queue.ts (already exists, needs enabling)
export class BatchQueue {
  async tokenize(params: TokenizeParams[]): Promise<TokenizeResponse[]> {
    // Batch multiple tokenize requests
    return this.transport.request('batch_tokenize', { requests: params });
  }
}
```

**Python Runtime:**
```python
async def batch_tokenize(self, params: dict) -> dict:
    requests = params['requests']
    results = await asyncio.gather(*[
        self.tokenize(req) for req in requests
    ])
    return {'results': results}
```

**Expected Impact:**
- 50-80% reduction in IPC overhead for tokenization
- Improved throughput for multi-request scenarios
- Better CPU utilization

#### 2. Model Artifact Caching (Estimated 90%+ Time Savings)

**Current State**: Basic caching implemented, needs optimization
**Target**: Zero-copy model reuse, persistent cache

**Enhancement:**
```typescript
// src/core/model-artifact-cache.ts (already exists)
export class ModelArtifactCache {
  // Add memory-mapped file support for large models
  async lookupMmap(descriptor: ModelDescriptor): Promise<MmapHandle> {
    // Memory-map cached model files
  }
}
```

**Expected Impact:**
- 90%+ reduction in model load time for cached models
- Lower memory footprint with mmap
- Faster startup times

#### 3. Python Runtime Memory Pool

**Current State**: Standard Python memory allocation
**Target**: Pre-allocated tensor buffers for generation

**Implementation:**
```python
# python/models/memory_pool.py (new)
class TensorPool:
    def __init__(self, max_seq_len: int, dtype: mx.Dtype):
        self.buffers = [
            mx.zeros((1, max_seq_len), dtype=dtype)
            for _ in range(10)  # Pool of 10 buffers
        ]
        self.available = list(range(10))

    def acquire(self) -> mx.array:
        idx = self.available.pop()
        return self.buffers[idx]

    def release(self, buffer: mx.array):
        # Return to pool instead of dealloc
        pass
```

**Expected Impact:**
- 5-10% reduction in allocation overhead
- Smoother memory usage patterns
- Reduced GC pressure

#### 4. Enhanced Telemetry

**Current State**: Basic stats tracking
**Target**: Comprehensive Python + TypeScript metrics

**Implementation:**
```python
# python/telemetry.py (new)
class RuntimeTelemetry:
    def record_generate(self, duration_ms: float, tokens: int):
        self.stats['generate_calls'] += 1
        self.stats['total_tokens'] += tokens
        self.stats['latencies'].append(duration_ms)

    def get_report(self) -> dict:
        return {
            'p50': np.percentile(self.stats['latencies'], 50),
            'p95': np.percentile(self.stats['latencies'], 95),
            'p99': np.percentile(self.stats['latencies'], 99),
            'throughput': self.stats['total_tokens'] / self.stats['total_time'],
        }
```

**Expected Impact:**
- Better observability
- Performance regression detection
- Targeted optimization opportunities

### Medium Priority (Future Consideration)

#### 5. Shared Memory IPC (For Large Tensors)

**Current State**: JSON-RPC over stdio
**Target**: Shared memory for tensors >1MB

**Consideration:**
- Adds complexity
- Benefits primarily for very large context windows (>32K tokens)
- Consider if we see performance issues with long contexts

#### 6. Custom MLX Operations (Upstream Contribution)

**Current State**: Using standard mlx-lm operations
**Target**: Contribute optimized operations upstream

**Approach:**
- Identify bottlenecks in mlx-lm
- Implement optimizations (Flash Attention, etc.)
- Submit PRs to ml-explore/mlx
- Benefits entire MLX ecosystem

### Low Priority (Not Recommended)

#### 7. Rewrite in C++

**Analysis:**
- Abandons TypeScript ecosystem advantages
- High development cost
- kr-infer is still Phase 0 (not production-ready)
- kr-serve-mlx already achieving competitive performance (1.021× faster than mlx-engine)

**Recommendation**: **Do not pursue**. Focus on optimizing current architecture.

---

## Recommended Implementation Roadmap

### Phase 1: Quick Wins (1-2 weeks)

**Target**: 20-30% performance improvement with minimal code changes

1. **Enable Request Batching** (2-3 days)
   - Implement `batch_tokenize` in Python runtime
   - Enable batching in TypeScript BatchQueue
   - Add configuration for batch size tuning

2. **Optimize Model Artifact Cache** (2-3 days)
   - Add memory-mapped file support
   - Implement LRU eviction policy
   - Add cache warming on startup

3. **Add Enhanced Telemetry** (2-3 days)
   - Python runtime metrics collection
   - Percentile tracking (p50/p95/p99)
   - Export telemetry via JSON-RPC

**Expected Outcome:**
- 20-30% improvement in multi-request scenarios
- Better observability
- Faster model loading

### Phase 2: Advanced Optimizations (2-4 weeks)

**Target**: 40-60% performance improvement in specific scenarios

1. **Python Runtime Memory Pool** (1 week)
   - Implement tensor buffer pool
   - Add to generator pipeline
   - Benchmark memory usage reduction

2. **Shared Memory IPC** (1-2 weeks)
   - Implement for tensors >1MB
   - Fallback to JSON-RPC for small messages
   - Add comprehensive tests

3. **Upstream MLX Contributions** (2-4 weeks)
   - Profile mlx-lm bottlenecks
   - Implement Flash Attention (if not already available)
   - Submit PRs to ml-explore/mlx

**Expected Outcome:**
- 40-60% improvement in high-throughput scenarios
- Better memory efficiency
- Contribution to MLX ecosystem

### Phase 3: Production Hardening (2-3 weeks)

**Target**: Production-grade monitoring and reliability

1. **Comprehensive Benchmarking**
   - Expand benchmark suite (micro-benchmarks)
   - Add regression detection
   - CI/CD integration

2. **Production Telemetry**
   - OpenTelemetry integration
   - Prometheus metrics export
   - Grafana dashboards

3. **Performance Documentation**
   - Tuning guide
   - Benchmarking methodology
   - Best practices

**Expected Outcome:**
- Production-ready performance monitoring
- Clear optimization guidelines
- Better developer experience

---

## Risk Assessment

### High Risk

**Rewriting in C++**
- **Risk**: Abandons TypeScript ecosystem, high development cost
- **Mitigation**: Do not pursue

### Medium Risk

**Shared Memory IPC**
- **Risk**: Increased complexity, potential compatibility issues
- **Mitigation**: Implement as optional feature with JSON-RPC fallback

**Upstream MLX Contributions**
- **Risk**: Slow review process, API changes
- **Mitigation**: Maintain compatibility layer, contribute incrementally

### Low Risk

**Request Batching**
- **Risk**: Minimal (already partially implemented)
- **Mitigation**: Comprehensive testing

**Enhanced Telemetry**
- **Risk**: Minimal (<3% overhead)
- **Mitigation**: Make telemetry optional via configuration

---

## Conclusion

kr-serve-mlx is already production-ready with excellent performance (1.021× faster than mlx-engine). Rather than pursuing a costly rewrite, we should focus on **incremental optimizations** inspired by kr-infer's architecture:

1. **Request Batching**: High-impact, low-risk improvement
2. **Model Artifact Caching**: Significant startup time reduction
3. **Python Memory Pool**: Reduced allocation overhead
4. **Enhanced Telemetry**: Better observability

This approach maintains kr-serve-mlx's TypeScript-first philosophy while achieving significant performance gains.

**Next Steps:**
1. Implement Phase 1 quick wins (request batching, cache optimization, telemetry)
2. Measure performance improvements
3. Evaluate Phase 2 advanced optimizations based on Phase 1 results
4. Consider upstream MLX contributions for ecosystem benefit

---

**Document Status**: Analysis Complete
**Next Action**: Work with AutomatosX agent to prioritize and implement Phase 1 enhancements
