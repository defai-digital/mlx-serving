# kr-serve-mlx vs kr-serve-mlx2 - Codebase Comparison

**Date:** 2025-11-07
**Critical Decision Required:** Which codebase should be the source for mlx-serving?

---

## Key Differences Discovered

### kr-serve-mlx (Latest/Active Development)

**Location:** `/Users/akiralam/code/kr-serve-mlx`

**Key Characteristics:**
- ✅ **Has C++ Native Module** (`native/` directory)
- ✅ **CMake build system** for native compilation
- ✅ **Extensive documentation** (80+ markdown files including week-by-week progress)
- ✅ **Active development** (last modified Nov 5, 2024)
- ✅ **Advanced features:**
  - Native Metal command buffer pool (`command_buffer_pool.mm`)
  - Native metrics collector (`metrics_collector.cpp`)
  - Continuous batching implementation
  - GPU optimization guide
  - PagedAttention planning
  - Week 1-4 implementation reports

**Directory Count:** 114 items (much larger)

**Native Module Components:**
```
native/
├── CMakeLists.txt           # CMake build configuration
├── include/
│   ├── kr_command_buffer_pool.h
│   └── kr_metrics_collector.h
├── src/
│   ├── command_buffer_pool.mm    # Objective-C++ Metal integration
│   ├── metrics_collector.cpp
│   └── utils.cpp
├── bindings/
│   └── python_bindings.cpp       # pybind11 Python bindings
├── build/                        # CMake build artifacts
├── benchmarks/
└── tests/
```

**Technologies:**
- C++17
- Objective-C++ (.mm files)
- pybind11 for Python bindings
- Metal framework (direct Metal API access)
- Foundation framework
- CoreGraphics framework

**Additional Features:**
- Continuous batching
- PagedAttention (planned)
- Advanced GPU optimization
- Native performance monitoring

---

### kr-serve-mlx2 (Clean/Stable Release?)

**Location:** `/Users/akiralam/code/kr-serve-mlx2`

**Key Characteristics:**
- ❌ **No C++ Native Module** (no `native/` directory)
- ✅ **Clean documentation** (fewer files, more focused)
- ✅ **Stable structure** (appears to be release version)
- ✅ **Core features only:**
  - TypeScript API layer
  - Python runtime
  - GPU scheduler
  - Standard MLX integration

**Directory Count:** 40 items (cleaner, more focused)

**Technologies:**
- TypeScript only
- Python runtime
- MLX via Python pip packages
- No direct Metal API access

---

## Package.json Comparison

### Common Elements (Both versions)
- Version: 1.4.2
- Same npm package name: `@defai.digital/kr-serve-mlx`
- Same README content (first 50 lines identical)
- Same core dependencies
- Same test framework (Vitest)

### Differences

**kr-serve-mlx (with native/):**
```json
{
  "version": "1.4.2",
  "files": ["dist", "python", "scripts", "config", "README.md", "LICENSE"],
  // No native module references in package.json yet
  // But native/ directory exists with CMake build
}
```

**kr-serve-mlx2 (clean):**
```json
{
  "version": "1.4.2",
  "files": ["dist", "python", "scripts", "config", "README.md", "LICENSE"],
  // Cleaner, production-ready version
}
```

---

## Documentation Differences

### kr-serve-mlx (80+ docs)
Includes development history and planning:
- `NATIVE_ACCELERATION_PLAN.md`
- `CONTINUOUS_BATCHING_PAGEDATTENTION_PLAN.md`
- `GPU_OPTIMIZATION_GUIDE.md`
- `WEEK1_FINAL_STATUS.md` through `WEEK4_COMPLETE.md`
- `BUGFIX_WEEK4_*.md` (multiple bug fix reports)
- `OVERALL_STATUS.md`

### kr-serve-mlx2 (Clean docs)
Essential documentation only:
- `README.md`
- `CHANGELOG.md`
- `GETTING_STARTED.md`
- `GPU_SCHEDULER_GUIDE.md`
- `REFACTORING_REPORT.md`

---

## Critical Questions

### 1. Which is the "production" version?
- **kr-serve-mlx2** appears to be cleaner, possibly the npm-published version
- **kr-serve-mlx** appears to be active development with experimental features

### 2. Is the native C++ module production-ready?
**From kr-serve-mlx/native/CMakeLists.txt:**
```cmake
project(krserve_native VERSION 1.0.0 LANGUAGES CXX OBJCXX)

# Source files
set(NATIVE_SOURCES
    src/command_buffer_pool.mm    # Metal command buffer optimization
    src/metrics_collector.cpp      # Performance metrics
    src/utils.cpp
)

# Python module
pybind11_add_module(krserve_native
    bindings/python_bindings.cpp
    ${NATIVE_SOURCES}
)
```

This is a **production-grade native extension** using:
- Direct Metal API access via Objective-C++
- pybind11 for Python integration
- CMake for cross-platform builds
- Address sanitizer support for debugging

### 3. Why two codebases?
Possible scenarios:
1. **kr-serve-mlx** = bleeding edge development
2. **kr-serve-mlx2** = stable release branch
3. **kr-serve-mlx** = future v2.0 with native acceleration
4. **kr-serve-mlx2** = current v1.4.2 npm package

---

## Implications for mlx-serving

### If we use kr-serve-mlx (with native/):

**Advantages:**
- ✅ Access to advanced features (continuous batching, native Metal optimization)
- ✅ Better performance potential (direct Metal API)
- ✅ More complete feature set
- ✅ Active development insights from week reports

**Challenges:**
- ⚠️ Need to preserve C++ build system
- ⚠️ CMake + pybind11 dependency
- ⚠️ Objective-C++ compilation required
- ⚠️ More complex Phase 0 setup
- ⚠️ Potentially unstable/experimental features

**Phase 0 Impact:**
- Must copy and preserve `native/` directory
- Must ensure CMake builds work
- Must test native module compilation
- Need to integrate C++ into ReScript plan

### If we use kr-serve-mlx2 (clean):

**Advantages:**
- ✅ Simpler architecture (TypeScript + Python only)
- ✅ Proven stable codebase
- ✅ Easier to refactor
- ✅ No C++ build complexity
- ✅ Matches original PRD assumptions

**Challenges:**
- ⚠️ Miss out on native acceleration features
- ⚠️ May need to backport features from kr-serve-mlx later
- ⚠️ Potentially outdated compared to active development

**Phase 0 Impact:**
- Straightforward copy operation
- Pure TypeScript/Python refactor
- Simpler testing and validation

---

## Recommendation Required

**Question for Tony:**

Which codebase should we use as the source for mlx-serving?

**Option A: kr-serve-mlx (with native module)**
- More features, more complexity
- Need to update PRD and implementation plan for C++ handling
- Longer Phase 0 (need to validate C++ builds)

**Option B: kr-serve-mlx2 (clean version)**
- Simpler, matches current PRD
- Faster Phase 0 execution
- May need to merge native features later

**Option C: Hybrid approach**
- Start with kr-serve-mlx2 for base
- Plan Phase 5 to integrate native acceleration from kr-serve-mlx

---

## Next Steps (Awaiting Decision)

1. **Clarify which codebase is "production"**
2. **Decide on native module strategy**
3. **Update PRD if using kr-serve-mlx**
4. **Adjust Phase 0 plan accordingly**
5. **Begin implementation**

---

**Status:** BLOCKED pending codebase selection decision
**Blocker Owner:** Tony (CTO)
**Impact:** Cannot proceed with Phase 0 until resolved
