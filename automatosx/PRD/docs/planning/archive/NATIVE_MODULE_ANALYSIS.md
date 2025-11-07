# C++ Native Module Analysis for mlx-serving

**Date:** 2025-11-07
**Source:** `/Users/akiralam/code/kr-serve-mlx/native/`
**Status:** Production-grade C++ module with pybind11 Python bindings

---

## Overview

kr-serve-mlx includes a **native C++ acceleration module** (`krserve_native`) that provides direct Metal API access for performance optimization. This module is **optional but provides 5-60% performance gains** according to the native acceleration plan.

---

## Native Module Architecture

### Technology Stack
- **Language:** C++17 + Objective-C++ (.mm files)
- **Build System:** CMake 3.15+
- **Python Bindings:** pybind11
- **Frameworks:**
  - Metal (direct GPU access)
  - Foundation (macOS primitives)
  - CoreGraphics

### Components

#### 1. Command Buffer Pool (`command_buffer_pool.mm`)
**Purpose:** Reuses Metal command buffers to reduce allocation overhead

**Performance Impact:**
- Reduces command buffer allocation from ~0.5ms to ~0.05ms
- Expected improvement: 5-10% on small batches

**API:**
```cpp
class CommandBufferPool {
    explicit CommandBufferPool(size_t pool_size = 16);
    void* acquire();                    // Get buffer from pool
    void release(void* buffer);         // Return buffer to pool
    void reset();                       // Clear pool
    Stats getStats() const;             // Get metrics
};
```

**Stats Tracked:**
- Pool size and available buffers
- Total acquired/released
- Cache hits/misses

#### 2. Metrics Collector (`metrics_collector.cpp`)
**Purpose:** High-performance lock-free metrics collection

**Features:**
- Thread-safe atomic counters
- Latency percentiles (P50, P95, P99)
- Throughput calculation (requests per second)
- Statistical aggregation

**API:**
```cpp
class MetricsCollector {
    void recordRequest();
    void recordCompletion(double latency_ms);
    void recordFailure();
    Metrics getMetrics() const;
    void reset();
};
```

**Metrics Provided:**
- Total/completed/failed requests
- Average latency
- P50/P95/P99 latencies
- Throughput (RPS)

#### 3. Python Bindings (`python_bindings.cpp`)
**Purpose:** Expose C++ classes to Python via pybind11

**Module:** `krserve_native`
**Version:** 1.0.0

**Exposed Classes:**
- `CommandBufferPool`
- `CommandBufferPoolStats`
- `MetricsCollector`
- `Metrics`

---

## Integration with Python Runtime

### Python Wrapper Location
`/Users/akiralam/code/kr-serve-mlx/python/native/__init__.py`

**Usage Pattern:**
```python
try:
    import krserve_native
    # Use native acceleration
    pool = krserve_native.CommandBufferPool(pool_size=16)
    metrics = krserve_native.MetricsCollector()
except ImportError:
    # Fall back to pure Python
    pass
```

**Integration Status:**
- ✅ Native module is **optional** (graceful fallback)
- ✅ Python runtime checks for availability
- ✅ No hard dependency on C++ module

---

## Build System

### CMake Configuration
**File:** `native/CMakeLists.txt`

**Build Options:**
- `BUILD_TESTS` - Build test suite (default: ON)
- `BUILD_BENCHMARKS` - Build benchmarks (default: ON)
- `ENABLE_ASAN` - AddressSanitizer for debugging (default: OFF)

**Build Types:**
- **Debug:** `-g -O0` with full warnings
- **Release:** `-O3 -DNDEBUG -flto` (link-time optimization)

**Key Features:**
- Automatic pybind11 detection
- Metal framework linking
- Objective-C++ ARC (Automatic Reference Counting)
- Source maps for debugging

### Build Commands
```bash
cd native/
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
cmake --install .  # Installs to Python site-packages
```

---

## Performance Characteristics

### From NATIVE_ACCELERATION_PLAN.md

**Current v1.4.2 Baseline:**
- 1.081x faster than mlx-engine
- 100% success rate
- 5.4x lower variance

**Expected Gains with Native Module:**
- Command buffer pooling: 5-10% improvement
- Metal optimization: 10-20% additional
- Combined potential: 25-60% total gain

**Decision Gates (from plan):**
- < 5% gain → Not worth complexity
- 5-10% gain → Reconsider alternatives
- 10-20% gain → Proceed with hybrid approach
- > 20% gain → Full native rewrite

---

## Directory Structure

```
native/
├── CMakeLists.txt                    # Build configuration
├── include/
│   ├── kr_command_buffer_pool.h      # Command buffer pool header
│   └── kr_metrics_collector.h        # Metrics collector header
├── src/
│   ├── command_buffer_pool.mm        # Objective-C++ implementation
│   ├── metrics_collector.cpp         # C++ implementation
│   └── utils.cpp                     # Utility functions
├── bindings/
│   └── python_bindings.cpp           # pybind11 Python bindings
├── build/                            # CMake build artifacts (generated)
├── benchmarks/                       # Performance benchmarks
└── tests/                            # Native module tests
```

---

## Implications for mlx-serving Refactor

### Phase 0 Requirements

**Must Copy:**
- ✅ Entire `native/` directory (including build system)
- ✅ `python/native/__init__.py` (Python wrapper)
- ✅ CMake build configuration

**Must Verify:**
- ✅ CMake builds successfully on Apple Silicon
- ✅ Native module loads in Python
- ✅ Tests pass for native components
- ✅ Graceful fallback works when module absent

### Integration with TypeScript/Zod/ReScript

**Zod Implications:**
- Native module is Python-only (no direct TS access)
- TypeScript calls Python → Python may use native
- No Zod validation needed at native boundary
- Native module is implementation detail

**ReScript Implications:**
- No direct ReScript interaction with C++
- Native module is opaque to ReScript state machines
- Performance gains visible at system level only

### Build Pipeline Updates

**Required Changes:**

1. **package.json:**
```json
{
  "scripts": {
    "build": "tsup",
    "build:native": "cd native && cmake --build build",
    "postinstall": "node scripts/postinstall.cjs && npm run build:native || true"
  }
}
```

2. **CI/CD:**
- Add CMake to CI dependencies
- Add pybind11 to Python requirements
- Add Metal framework detection
- Add native module tests

3. **Documentation:**
- Native module optional dependency
- Build requirements (CMake, Apple Silicon)
- Performance comparison (with/without native)

---

## Preservation Strategy

### What MUST NOT Change

1. **Native Module Implementation**
   - C++ code is production-tested
   - Metal optimizations are fragile
   - Don't refactor C++ during TypeScript modernization

2. **Python Bindings**
   - pybind11 interface is stable
   - Python wrapper handles fallback gracefully

3. **Build System**
   - CMake configuration works
   - Keep as-is unless build fails

### What CAN Change

1. **Integration Points**
   - How TypeScript calls Python (can improve)
   - Telemetry from native module (can add Zod schemas)
   - Error handling for native failures

2. **Documentation**
   - Add native module to architecture docs
   - Update performance benchmarks
   - Clarify build requirements

---

## Testing Strategy

### Native Module Tests

**Unit Tests (C++):**
- Command buffer pool acquire/release
- Metrics collector accuracy
- Thread safety validation

**Integration Tests (Python):**
- Import success/failure handling
- Performance benchmarking vs pure Python
- Memory leak detection

**System Tests (TypeScript):**
- End-to-end with native enabled
- End-to-end with native disabled
- Performance regression tests

---

## Risk Assessment

### Low Risk ✅
- Native module is **optional** (system works without it)
- Python wrapper provides graceful fallback
- Build failures don't break TypeScript layer

### Medium Risk ⚠️
- CMake build might fail on some systems
- pybind11 version compatibility
- Metal API changes in future macOS versions

### Mitigation Strategy
1. **Optional by Default:** Don't fail install if native build fails
2. **Version Pinning:** Pin pybind11 and CMake versions
3. **Feature Flags:** Allow disabling native module via env var
4. **Documentation:** Clear build requirements and troubleshooting

---

## Recommendations for mlx-serving

### Phase 0: Baseline Copy
1. ✅ Copy entire `native/` directory unchanged
2. ✅ Copy Python wrapper
3. ✅ Add native build to postinstall (optional)
4. ✅ Document native module as optional feature

### Phase 1: Zod Integration
- ❌ No Zod schemas needed for native module (internal only)
- ✅ Add Zod for Python error responses that include native metrics

### Phase 2: ReScript Migration
- ❌ No ReScript interaction with C++ needed
- ✅ Native module remains Python-only implementation detail

### Phase 3: Integration Testing
- ✅ Add native module tests to CI
- ✅ Benchmark with/without native
- ✅ Validate fallback behavior

### Future Enhancements (Post-GA)
- Consider direct TypeScript → C++ bindings (N-API/node-addon-api)
- Explore WebAssembly for cross-platform
- Add more native optimizations based on profiling

---

## Summary

**Native Module Status:** ✅ Production-ready, optional, performance enhancer

**Impact on Refactor:** 🟢 Low impact - preserve as-is

**Build Complexity:** 🟡 Medium - requires CMake + pybind11

**Performance Value:** 🟢 High - 5-60% potential gain

**Risk Level:** 🟢 Low - optional with fallback

**Recommendation:** **PRESERVE AND MIGRATE** - Copy native module unchanged, ensure builds work, document as optional feature.

---

**Next Steps:**
1. Update Phase 0 plan to include native module
2. Test native build on target system
3. Document build requirements
4. Add to CI/CD pipeline
