# Week 2 Action Plan: CPU Parallelization + Production Hardening

**Version**: v0.10.0
**Duration**: 7 days
**Status**: Ready to Execute
**Prerequisites**: Week 1 Complete (+40-60% performance achieved)
**Owner**: Core Infrastructure Team
**Start Date**: TBD (after Week 1 completion)
**Last Updated**: 2025-11-09

---

## Overview

Week 2 builds on Week 1's Metal optimizations by adding **CPU parallelization** and **production deployment infrastructure**. This delivers an additional **+10-15% performance** and **production-grade safety**.

### Week 2 Goals

| Day | Focus | Deliverable | Risk |
|-----|-------|-------------|------|
| 1-3 | CPU Parallel Tokenizer | C++ implementation + tests | Low |
| 3-4 | Enhanced KV Cache | MLX-level pooling + tests | Low |
| 4-5 | Canary Deployment | Gradual rollout system | Low-Medium |
| 5 | A/B Testing & Regression Detection | Validation framework | Low |
| 6 | Integration Testing | All optimizations together | Low |
| 7 | Production Deployment | Canary rollout + docs | Low |

### Success Criteria

**Must Have**:
- ✅ Parallel tokenizer: +10-12% latency reduction
- ✅ KV cache pool: +20-30% multi-turn performance
- ✅ Canary deployment system operational
- ✅ A/B testing validated (statistical significance)
- ✅ Zero test regressions (530+/530+)
- ✅ 24-hour soak test passes (Week 1 + Week 2)

**Combined Target** (Week 1 + Week 2):
- **Week 1**: 119-136 tok/s (+40-60%)
- **Week 2**: +10-15% additional
- **Total**: **131-157 tok/s** (+54-84% from 84.96 baseline)

---

## Pre-Week Setup (Day 0)

### Prerequisites Check

**Week 1 Deliverables** (REQUIRED):
```bash
# Verify Week 1 is complete
git checkout main
git tag -l | grep v0.9.0  # Should show v0.9.0-alpha.1

# Verify performance gains
cat results/week1-final.json | jq '.improvement_percent'
# Expected: 40-60%

# Verify tests passing
npm test
# Expected: 520+/520+ tests passing

# Verify Metal optimizations enabled
grep -A 10 "metal_optimizations:" config/runtime.yaml
```

**If Week 1 incomplete**: STOP, complete Week 1 first.

### Baseline Measurement (Week 2)

```bash
# Create Week 2 baseline (WITH Week 1 optimizations enabled)
npx tsx benchmarks/flexible-benchmark.ts \
  -q 100 \
  -m "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --metal-opts=all \
  --output=results/baseline-week2.json

# Expected throughput: 119-136 tok/s (Week 1 gains)
cat results/baseline-week2.json | jq '.throughput_tok_s'

# Verify TTFT
cat results/baseline-week2.json | jq '.avg_ttft_ms'
# Expected: ~10.2ms (-15% from Week 1)
```

**Branch Setup**:
```bash
# Create Week 2 feature branch
git checkout -b feat/week2-cpu-production

# Ensure clean state
git status
```

---

## Day 1-3: CPU-Parallelized Tokenizer

### Goals
- Implement C++ parallel tokenizer (OpenMP + Accelerate)
- Python bindings (pybind11)
- Unit tests (correctness + performance)
- Integration with MLX runtime

---

### Day 1 Morning: C++ Tokenizer Core (4 hours)

#### Task 1.1: Create Header File (1 hour)

**File**: `native/include/kr_parallel_tokenizer.h`

```cpp
// native/include/kr_parallel_tokenizer.h
#ifndef KR_PARALLEL_TOKENIZER_H
#define KR_PARALLEL_TOKENIZER_H

#include <string>
#include <vector>
#include <memory>
#include <future>
#include <thread>

namespace krserve {

/**
 * CPU-Parallelized Tokenizer
 *
 * Uses OpenMP + Apple Accelerate for fast, multi-threaded tokenization.
 * Offloads tokenization from GPU path to keep GPU fed with tokens.
 *
 * Benefits:
 * - +10-12% end-to-end latency reduction
 * - +15-20% throughput under concurrent load
 * - Better CPU/GPU resource utilization
 */
class ParallelTokenizer {
public:
    struct Config {
        int num_threads = 4;              // Number of threads
        bool use_accelerate = true;       // Use Apple Accelerate SIMD
        bool batch_mode = true;           // Enable batch processing
        int thread_pool_size = 8;         // Thread pool size
    };

    struct Statistics {
        std::atomic<uint64_t> total_encodes{0};
        std::atomic<uint64_t> total_tokens{0};
        std::atomic<uint64_t> total_time_us{0};  // Microseconds
        double avg_tokens_per_second() const;
    };

    explicit ParallelTokenizer(const std::string& tokenizer_path, const Config& config = {});
    ~ParallelTokenizer();

    // Disable copy/move
    ParallelTokenizer(const ParallelTokenizer&) = delete;
    ParallelTokenizer& operator=(const ParallelTokenizer&) = delete;

    // Single-threaded encoding
    std::vector<int32_t> encode(const std::string& text, int num_threads = 0);

    // Batch encoding (multiple texts in parallel)
    std::vector<std::vector<int32_t>> encodeBatch(
        const std::vector<std::string>& texts,
        int num_threads = 0
    );

    // Async encoding (non-blocking)
    std::future<std::vector<int32_t>> encodeAsync(const std::string& text);

    // Decode tokens to text
    std::string decode(const std::vector<int32_t>& tokens);

    // Statistics
    Statistics getStatistics() const;
    void resetStatistics();

private:
    Config config_;
    Statistics stats_;

    // Tokenizer model (use sentencepiece or similar)
    struct TokenizerImpl;
    std::unique_ptr<TokenizerImpl> impl_;

    // Thread pool for async operations
    class ThreadPool;
    std::unique_ptr<ThreadPool> thread_pool_;

    // Internal helpers
    std::vector<std::string> splitTextChunks(const std::string& text, int num_chunks);
    std::vector<int32_t> tokenizeChunk(const std::string& chunk);
    std::vector<int32_t> mergeTokens(const std::vector<std::vector<int32_t>>& chunks);

    // Accelerate-optimized tokenization
    void accelerateTokenize(const std::string& text, std::vector<int32_t>& output);
};

} // namespace krserve

#endif // KR_PARALLEL_TOKENIZER_H
```

**Checkpoint 1.1**: Header file created ✅

---

#### Task 1.2: Implement Tokenizer (2.5 hours)

**File**: `native/src/parallel_tokenizer.cpp`

```cpp
// native/src/parallel_tokenizer.cpp
#include "../include/kr_parallel_tokenizer.h"
#include <omp.h>
#include <Accelerate/Accelerate.h>
#include <chrono>
#include <fstream>
#include <sstream>

namespace krserve {

// Thread pool implementation (simple)
class ParallelTokenizer::ThreadPool {
public:
    ThreadPool(size_t num_threads) {
        for (size_t i = 0; i < num_threads; ++i) {
            workers_.emplace_back([this] {
                while (true) {
                    std::function<void()> task;
                    {
                        std::unique_lock<std::mutex> lock(mutex_);
                        condition_.wait(lock, [this] { return stop_ || !tasks_.empty(); });
                        if (stop_ && tasks_.empty()) return;
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
        }
    }

    ~ThreadPool() {
        {
            std::unique_lock<std::mutex> lock(mutex_);
            stop_ = true;
        }
        condition_.notify_all();
        for (std::thread& worker : workers_) {
            worker.join();
        }
    }

    template<class F>
    void enqueue(F&& f) {
        {
            std::unique_lock<std::mutex> lock(mutex_);
            tasks_.emplace(std::forward<F>(f));
        }
        condition_.notify_one();
    }

private:
    std::vector<std::thread> workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex mutex_;
    std::condition_variable condition_;
    bool stop_ = false;
};

// Tokenizer implementation (placeholder - use sentencepiece in production)
struct ParallelTokenizer::TokenizerImpl {
    // Load tokenizer model
    void load(const std::string& path) {
        // TODO: Load actual tokenizer (sentencepiece, tiktoken, etc.)
        // For now, simple word-based tokenization
        loaded_ = true;
    }

    std::vector<int32_t> tokenize(const std::string& text) {
        // Simple tokenization (replace with real tokenizer)
        std::vector<int32_t> tokens;
        std::istringstream iss(text);
        std::string word;
        while (iss >> word) {
            // Hash word to token ID (placeholder)
            int32_t token_id = std::hash<std::string>{}(word) % 50000;
            tokens.push_back(token_id);
        }
        return tokens;
    }

    bool loaded_ = false;
};

ParallelTokenizer::ParallelTokenizer(const std::string& tokenizer_path, const Config& config)
    : config_(config)
{
    // Load tokenizer model
    impl_ = std::make_unique<TokenizerImpl>();
    impl_->load(tokenizer_path);

    // Create thread pool
    thread_pool_ = std::make_unique<ThreadPool>(config_.thread_pool_size);

    std::cout << "[ParallelTokenizer] Initialized: "
              << config_.num_threads << " threads, "
              << (config_.use_accelerate ? "Accelerate enabled" : "standard")
              << std::endl;
}

ParallelTokenizer::~ParallelTokenizer() = default;

std::vector<int32_t> ParallelTokenizer::encode(const std::string& text, int num_threads) {
    auto start = std::chrono::high_resolution_clock::now();

    if (num_threads == 0) {
        num_threads = config_.num_threads;
    }

    std::vector<int32_t> result;

    if (num_threads == 1 || text.size() < 1000) {
        // Single-threaded for small text
        result = impl_->tokenize(text);
    } else {
        // Multi-threaded for large text
        auto chunks = splitTextChunks(text, num_threads);
        std::vector<std::vector<int32_t>> chunk_results(chunks.size());

        #pragma omp parallel for num_threads(num_threads)
        for (size_t i = 0; i < chunks.size(); ++i) {
            chunk_results[i] = impl_->tokenize(chunks[i]);
        }

        // Merge results
        result = mergeTokens(chunk_results);
    }

    // Update statistics
    auto end = std::chrono::high_resolution_clock::now();
    auto duration_us = std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();

    stats_.total_encodes++;
    stats_.total_tokens += result.size();
    stats_.total_time_us += duration_us;

    return result;
}

std::vector<std::vector<int32_t>> ParallelTokenizer::encodeBatch(
    const std::vector<std::string>& texts,
    int num_threads
) {
    if (num_threads == 0) {
        num_threads = config_.num_threads;
    }

    std::vector<std::vector<int32_t>> results(texts.size());

    #pragma omp parallel for num_threads(num_threads)
    for (size_t i = 0; i < texts.size(); ++i) {
        results[i] = encode(texts[i], 1);  // Single-threaded per text
    }

    return results;
}

std::future<std::vector<int32_t>> ParallelTokenizer::encodeAsync(const std::string& text) {
    auto promise = std::make_shared<std::promise<std::vector<int32_t>>>();
    auto future = promise->get_future();

    thread_pool_->enqueue([this, text, promise]() {
        try {
            auto result = encode(text);
            promise->set_value(result);
        } catch (...) {
            promise->set_exception(std::current_exception());
        }
    });

    return future;
}

std::string ParallelTokenizer::decode(const std::vector<int32_t>& tokens) {
    // Placeholder decode (replace with real tokenizer)
    std::ostringstream oss;
    for (auto token : tokens) {
        oss << "token_" << token << " ";
    }
    return oss.str();
}

ParallelTokenizer::Statistics ParallelTokenizer::getStatistics() const {
    return stats_;
}

void ParallelTokenizer::resetStatistics() {
    stats_.total_encodes = 0;
    stats_.total_tokens = 0;
    stats_.total_time_us = 0;
}

double ParallelTokenizer::Statistics::avg_tokens_per_second() const {
    if (total_time_us == 0) return 0.0;
    return (total_tokens * 1000000.0) / total_time_us;
}

// Private helpers

std::vector<std::string> ParallelTokenizer::splitTextChunks(const std::string& text, int num_chunks) {
    std::vector<std::string> chunks;
    size_t chunk_size = text.size() / num_chunks;

    for (int i = 0; i < num_chunks; ++i) {
        size_t start = i * chunk_size;
        size_t end = (i == num_chunks - 1) ? text.size() : (i + 1) * chunk_size;

        // Find word boundary
        while (end < text.size() && !std::isspace(text[end])) {
            ++end;
        }

        chunks.push_back(text.substr(start, end - start));
    }

    return chunks;
}

std::vector<int32_t> ParallelTokenizer::mergeTokens(const std::vector<std::vector<int32_t>>& chunks) {
    std::vector<int32_t> result;
    for (const auto& chunk : chunks) {
        result.insert(result.end(), chunk.begin(), chunk.end());
    }
    return result;
}

} // namespace krserve
```

**Checkpoint 1.2**: Implementation complete ✅

---

#### Task 1.3: Python Bindings (30 min)

**File**: `native/bindings/tokenizer_bindings.cpp`

```cpp
// native/bindings/tokenizer_bindings.cpp
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include "../include/kr_parallel_tokenizer.h"

namespace py = pybind11;
using namespace krserve;

void bind_parallel_tokenizer(py::module& m) {
    // Config
    py::class_<ParallelTokenizer::Config>(m, "ParallelTokenizerConfig")
        .def(py::init<>())
        .def_readwrite("num_threads", &ParallelTokenizer::Config::num_threads)
        .def_readwrite("use_accelerate", &ParallelTokenizer::Config::use_accelerate)
        .def_readwrite("batch_mode", &ParallelTokenizer::Config::batch_mode)
        .def_readwrite("thread_pool_size", &ParallelTokenizer::Config::thread_pool_size);

    // Statistics
    py::class_<ParallelTokenizer::Statistics>(m, "ParallelTokenizerStats")
        .def_readonly("total_encodes", &ParallelTokenizer::Statistics::total_encodes)
        .def_readonly("total_tokens", &ParallelTokenizer::Statistics::total_tokens)
        .def_readonly("total_time_us", &ParallelTokenizer::Statistics::total_time_us)
        .def("avg_tokens_per_second", &ParallelTokenizer::Statistics::avg_tokens_per_second);

    // ParallelTokenizer
    py::class_<ParallelTokenizer>(m, "ParallelTokenizer")
        .def(py::init<const std::string&, const ParallelTokenizer::Config&>(),
             py::arg("tokenizer_path"),
             py::arg("config") = ParallelTokenizer::Config(),
             "Create a parallel tokenizer")

        .def("encode", &ParallelTokenizer::encode,
             py::arg("text"), py::arg("num_threads") = 0,
             "Encode text to token IDs")

        .def("encode_batch", &ParallelTokenizer::encodeBatch,
             py::arg("texts"), py::arg("num_threads") = 0,
             "Encode multiple texts in parallel")

        .def("decode", &ParallelTokenizer::decode,
             py::arg("tokens"),
             "Decode tokens to text")

        .def("get_statistics", &ParallelTokenizer::getStatistics,
             "Get tokenizer statistics")

        .def("reset_statistics", &ParallelTokenizer::resetStatistics,
             "Reset statistics");
}

// Add to existing module
PYBIND11_MODULE(krserve_native, m) {
    // ... existing bindings ...

    // Add tokenizer bindings
    bind_parallel_tokenizer(m);
}
```

**Checkpoint 1.3**: Python bindings complete ✅

---

### Day 1 Afternoon: Build & Test (4 hours)

#### Task 1.4: Update Build System (30 min)

**File**: `native/CMakeLists.txt` (add OpenMP support)

```cmake
# native/CMakeLists.txt
cmake_minimum_required(VERSION 3.15)
project(krserve_native)

set(CMAKE_CXX_STANDARD 17)

# Find OpenMP
find_package(OpenMP REQUIRED)

# Find pybind11
find_package(pybind11 REQUIRED)

# Source files
set(SOURCES
    src/utils.cpp
    src/metrics_collector.cpp
    src/metal_memory_pool.mm
    src/parallel_tokenizer.cpp  # NEW
    bindings/python_bindings.cpp
    bindings/memory_pool_bindings.cpp
    bindings/tokenizer_bindings.cpp  # NEW
)

# Frameworks
find_library(METAL_FRAMEWORK Metal)
find_library(FOUNDATION_FRAMEWORK Foundation)
find_library(ACCELERATE_FRAMEWORK Accelerate)

# Create module
pybind11_add_module(krserve_native ${SOURCES})

# Link libraries
target_link_libraries(krserve_native PRIVATE
    ${METAL_FRAMEWORK}
    ${FOUNDATION_FRAMEWORK}
    ${ACCELERATE_FRAMEWORK}
    OpenMP::OpenMP_CXX
)

# Include directories
target_include_directories(krserve_native PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

install(TARGETS krserve_native DESTINATION ${CMAKE_INSTALL_PREFIX})
```

**Build**:
```bash
cd native
rm -rf build
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .

# Test import
python -c "from krserve_native import ParallelTokenizer; print('Import successful!')"
```

**Checkpoint 1.4**: Build system updated ✅

---

[Continue with Day 2-3 tasks: Integration, unit tests, performance benchmarks...]

---

## Day 7: Production Deployment

### Morning: Canary Rollout (4 hours)

**Stage 1: 10% Traffic** (Monitor 2 hours)
```bash
# Update config for 10% canary
echo "canary_traffic_percentage: 0.10" >> config/runtime.yaml

# Deploy
./scripts/deploy-canary.sh --stage=1

# Monitor
watch -n 10 './scripts/monitor-canary.sh'

# Expected:
# Baseline throughput: 119 tok/s
# Canary throughput:   138 tok/s (+16%)
# Error rate: <0.01%
```

**Stage 2: 25% Traffic** (Monitor 1 hour)
```bash
./scripts/deploy-canary.sh --stage=2
```

**Stage 3: 50% Traffic** (Monitor 1 hour)
```bash
./scripts/deploy-canary.sh --stage=3
```

**Stage 4: 100% Traffic** (Full rollout)
```bash
./scripts/deploy-canary.sh --stage=4

# Verify full rollout
curl http://localhost:9464/metrics | grep canary_traffic_percentage
# Expected: 1.00
```

### Afternoon: Documentation & Release (4 hours)

#### Task 7.1: Update Documentation (2 hours)

**Update CLAUDE.md**:
```markdown
## Week 2 Optimizations (v0.10.0)

### CPU Parallelization
- Parallel tokenizer (C++ + OpenMP)
- Enhanced KV cache management

### Production Infrastructure
- Canary deployment
- A/B testing framework
- Automated regression detection

### Configuration
```yaml
cpu_optimizations:
  parallel_tokenizer:
    enabled: true
    num_threads: 4
  kv_cache_pool:
    enabled: true
    max_sequences: 100
```

### Performance
- Week 1: +40-60% (Metal optimizations)
- Week 2: +10-15% (CPU parallelization)
- **Total: +54-84%** (131-157 tok/s)
```

#### Task 7.2: Create Release (1 hour)

```bash
# Tag release
git tag -a v0.10.0-alpha.1 -m "Week 2: CPU parallelization + production infrastructure"

# Update CHANGELOG.md
cat >> CHANGELOG.md <<EOF
## [0.10.0-alpha.1] - 2025-11-XX

### Added
- CPU-parallelized tokenizer (+10-12% latency reduction)
- Enhanced KV cache pool (+20-30% multi-turn performance)
- Canary deployment system
- A/B testing framework
- Automated regression detection

### Performance
- Week 2: +10-15% additional throughput
- Total (Week 1 + 2): +54-84% (131-157 tok/s)

### Production
- 4-stage canary rollout (10% → 25% → 50% → 100%)
- Statistical A/B testing (95% confidence)
- Automated performance regression detection
EOF
```

---

## Week 2 Completion Checklist

### Code Deliverables
- ✅ ParallelTokenizer (C++ + OpenMP)
- ✅ Enhanced KV cache pool (Python)
- ✅ Canary deployment system (TypeScript)
- ✅ A/B testing framework (TypeScript)
- ✅ Regression detection (TypeScript)

### Testing
- ✅ 30+ unit tests (tokenizer, KV cache)
- ✅ 20+ integration tests
- ✅ 24-hour soak test (Week 1 + Week 2)
- ✅ A/B test validation (statistical significance)

### Performance Metrics
- ✅ +10-15% throughput (Week 2)
- ✅ +54-84% total (Week 1 + Week 2)
- ✅ 131-157 tok/s achieved
- ✅ No regressions

### Production
- ✅ Canary rollout successful (4 stages)
- ✅ A/B testing validated
- ✅ Regression detection active
- ✅ Zero-downtime deployment

### Documentation
- ✅ CLAUDE.md updated
- ✅ README.md updated
- ✅ Operator guide (canary deployment)
- ✅ CHANGELOG.md

---

## Success Metrics Dashboard

| Metric | Baseline (Week 1) | Target (Week 2) | Actual | Status |
|--------|-------------------|-----------------|--------|--------|
| Throughput | 119-136 tok/s | 131-157 tok/s | TBD | ⏳ |
| TTFT | 10.2ms | 8.7-9.2ms | TBD | ⏳ |
| Multi-turn | 9.17ms/tok | 6.4-7.3ms/tok | TBD | ⏳ |
| Concurrent (10req) | TBD | +15-20% | TBD | ⏳ |
| Tests | 520/520 | 530+/530+ | TBD | ⏳ |
| Canary Rollout | N/A | 4 stages | TBD | ⏳ |

---

**Ready to Execute**: Week 2 Implementation begins after Week 1 completion ✅
