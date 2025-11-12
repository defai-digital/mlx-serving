# PRD: Metal-Layer Performance Optimizations (Phase 6)

**Version**: v0.9.0
**Status**: Ready for Implementation
**Priority**: P1 (High Impact, Low Risk)
**Target Timeline**: Week 1 (7 days)
**Owner**: Core Infrastructure Team
**Last Updated**: 2025-11-09

---

## Executive Summary

This PRD defines **Week 1** of Metal-layer performance optimizations for mlx-serving, focused on **production stability** with **measurable performance gains**. All optimizations are **low-risk, user-configurable, and feature-flagged** to ensure zero production impact if disabled.

### Goals
- **+40-60% throughput improvement** over current baseline (84.96 tok/s → 120-135 tok/s)
- **-15-20% TTFT reduction** through I/O overlap
- **-20-30% allocation overhead** through memory pooling
- **100% backward compatibility** (all features can be disabled)
- **Zero stability regression** (comprehensive testing, graceful fallbacks)

### Principles
1. **Stability First**: All optimizations must degrade gracefully
2. **User Control**: Every feature has a config flag (default: disabled for safety)
3. **Low-Medium Risk Only**: No experimental features in Week 1
4. **Measurable Impact**: Clear benchmarks before/after each optimization
5. **Production Ready**: Comprehensive testing, monitoring, rollback procedures

---

## Background & Problem Statement

### Current State (v0.8.0)

**Achievements**:
- ✅ 19.5% performance improvement via application-layer optimizations
- ✅ 100% stability (512/512 tests passing)
- ✅ 4-layer concurrency fix prevents Metal GPU crashes
- ✅ Request deduplication, prompt caching, request coalescing

**Performance Baseline**:
- Throughput: **84.96 tok/s** (Qwen3-30B-4bit)
- TTFT: Not currently measured
- P99 latency: Not currently measured

### Problem

Current optimizations are **application-layer only** (TypeScript/Python). The next frontier is **Metal-layer optimizations**, which can provide:

1. **Memory allocation overhead**: Dynamic MTLBuffer allocation causes jitter
2. **I/O blocking**: Data upload/download blocks GPU compute pipeline
3. **Command buffer serialization**: Single buffer limits instruction interleaving

### Technical Analysis (from Apple Silicon M3/M4 Discussion)

**Key Insight**: On Apple Silicon, you **cannot** achieve true GPU-level parallelism for multiple MLX tasks due to Metal's single-context architecture. However, you **can** optimize:

- ✅ Memory management (MTLHeap pooling)
- ✅ I/O overlap (blit command queue)
- ✅ Instruction interleaving (command buffer ring)

**Source**: Technical discussion with Apple Silicon Metal expert (2025-11-09)

---

## Goals & Success Metrics

### Primary Goals (Week 1)

1. **Implement Metal Memory Pool**
   - Success: +10-15% throughput improvement
   - Metric: Allocation overhead reduction (measured via profiling)
   - Risk: Low (isolated, well-understood pattern)

2. **Implement I/O Overlap with Blit Queue**
   - Success: +15-20% TTFT reduction
   - Metric: Time to first token (measured per-request)
   - Risk: Low-Medium (standard Metal pattern)

3. **Implement Command Buffer Ring**
   - Success: +5-10% GPU utilization improvement
   - Metric: GPU idle time reduction (Metal Performance HUD)
   - Risk: Low (proven technique)

### Secondary Goals

4. **Feature Flag System**
   - All optimizations configurable via `config/runtime.yaml`
   - Default: **disabled** (opt-in for production safety)
   - Graceful fallback if optimization fails

5. **Comprehensive Testing**
   - Unit tests for each optimization
   - Integration tests with real MLX workloads
   - Performance benchmarks (before/after comparison)
   - Stability tests (24-hour soak test)

6. **Production Monitoring**
   - Expose metrics via Prometheus
   - Track optimization effectiveness
   - Alert on degradation or errors

### Non-Goals (Out of Scope for Week 1)

- ❌ Kernel fusion (high risk, requires extensive testing)
- ❌ Core ML/ANE integration (major architecture change)
- ❌ Custom Metal kernels (medium-high risk)
- ❌ Multi-process scaling (different optimization path)

### Success Criteria

**Must Have** (Week 1 Completion):
- ✅ All 3 optimizations implemented and tested
- ✅ Feature flags in `config/runtime.yaml`
- ✅ Performance benchmarks show +40-60% improvement
- ✅ All tests passing (512/512 → 520+/520+)
- ✅ Zero stability regression (24-hour soak test)

**Nice to Have**:
- ✅ Prometheus metrics for each optimization
- ✅ Documentation for operators
- ✅ Performance tuning guide

**Failure Criteria** (Triggers Rollback):
- ❌ Any test regression
- ❌ Performance degradation vs baseline
- ❌ Crashes or stability issues
- ❌ Cannot disable optimizations via config

---

## Technical Design

### Optimization 1: Metal Memory Pool (MTLHeap)

#### Problem
Dynamic MTLBuffer allocation causes:
- Memory allocation overhead (malloc/free latency)
- Memory fragmentation
- GPU memory pressure
- Unpredictable latency spikes (P99 variance)

#### Solution
Pre-allocate MTLHeap buffers and pool them for reuse:

```objc++
// native/src/metal_memory_pool.mm
@interface KRMetalMemoryPool : NSObject

@property (nonatomic, strong) id<MTLDevice> device;
@property (nonatomic, strong) NSMutableArray<id<MTLHeap>>* heapPool;
@property (nonatomic, strong) NSMutableArray<id<MTLHeap>>* availableHeaps;
@property (nonatomic, assign) size_t heapSize;
@property (nonatomic, assign) NSUInteger poolCount;

// Thread-safe heap management
@property (nonatomic, strong) NSLock* poolLock;

- (instancetype)initWithDevice:(id<MTLDevice>)device
                      heapSize:(size_t)heapSize
                     poolCount:(NSUInteger)poolCount;

- (nullable id<MTLHeap>)acquireHeap;
- (void)releaseHeap:(id<MTLHeap>)heap;
- (void)warmupWithBufferSizes:(NSArray<NSNumber*>*)sizes;
- (NSDictionary*)getStatistics;

@end
```

#### Integration Points

**Python Bindings** (`native/bindings/memory_pool_bindings.cpp`):
```cpp
py::class_<MetalMemoryPool>(m, "MetalMemoryPool")
    .def(py::init<size_t, size_t>(),
         py::arg("heap_size_mb") = 256,
         py::arg("pool_count") = 4)
    .def("acquire_heap", &MetalMemoryPool::acquireHeap)
    .def("release_heap", &MetalMemoryPool::releaseHeap)
    .def("warmup", &MetalMemoryPool::warmup)
    .def("get_statistics", &MetalMemoryPool::getStatistics);
```

**Python Runtime** (`python/runtime.py`):
```python
from krserve_native import MetalMemoryPool

class RuntimeServer:
    def __init__(self):
        # Initialize Metal memory pool (if enabled)
        config = get_config()
        if config.metal_optimizations.memory_pool.enabled:
            self.metal_pool = MetalMemoryPool(
                heap_size_mb=config.metal_optimizations.memory_pool.heap_size_mb,
                pool_count=config.metal_optimizations.memory_pool.num_heaps
            )
            # Pre-warm with common buffer sizes
            self.metal_pool.warmup(
                config.metal_optimizations.memory_pool.warmup_buffer_sizes_mb
            )
        else:
            self.metal_pool = None
```

#### Feature Flag Configuration

```yaml
# config/runtime.yaml
metal_optimizations:
  memory_pool:
    enabled: false                 # DEFAULT: disabled for safety
    heap_size_mb: 256              # Size per heap (256MB default)
    num_heaps: 4                   # Number of pre-allocated heaps
    warmup_buffer_sizes_mb: [32, 128, 512]  # Common buffer sizes to pre-allocate

    # Monitoring
    track_statistics: true
    log_pool_exhaustion: true

    # Safety limits
    max_heap_size_mb: 2048         # Maximum heap size (2GB safety limit)
    min_heaps: 2                   # Minimum heaps (safety minimum)
```

#### Graceful Fallback

```python
# python/models/generator.py
def allocate_buffer(self, size):
    if self.metal_pool and self.metal_pool.enabled:
        try:
            heap = self.metal_pool.acquire_heap()
            buffer = heap.newBufferWithLength(size)
            return buffer
        except Exception as e:
            logger.warning(f"Metal pool allocation failed, falling back to direct allocation: {e}")
            # Fallback to direct allocation
            return mlx.core.metal.buffer(size)
    else:
        # Direct allocation (original behavior)
        return mlx.core.metal.buffer(size)
```

#### Testing Strategy

**Unit Tests** (`tests/unit/native/metal_memory_pool.test.ts`):
- Pool initialization and warmup
- Acquire/release cycle
- Pool exhaustion handling
- Thread safety (concurrent acquire/release)
- Statistics tracking

**Integration Tests** (`tests/integration/metal_memory_pool.test.ts`):
- Real MLX workload with pooling enabled
- Performance comparison (pooled vs direct allocation)
- Stability test (1000+ allocations)

**Performance Benchmark**:
```bash
# Baseline (disabled)
npx tsx benchmarks/flexible-benchmark.ts -q 100 --metal-pool=off

# With memory pool
npx tsx benchmarks/flexible-benchmark.ts -q 100 --metal-pool=on

# Expected: +10-15% throughput, -20-30% allocation overhead
```

#### Risks & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Pool exhaustion under high concurrency | Medium | Fallback to direct allocation, log warning |
| Memory leak if heaps not released | Medium | RAII pattern in C++, Python context manager |
| Thread safety issues | Low | NSLock for all pool operations |
| Incompatibility with MLX updates | Low | Isolated from MLX internals, uses public Metal API |

---

### Optimization 2: I/O Overlap with Blit Queue

#### Problem
Data upload/download blocks GPU compute pipeline:
- Tokenization results must be uploaded before inference
- Generated tokens must be downloaded after inference
- Both operations block GPU compute queue

**Current**: Serialize: tokenize → upload → compute → download → decode
**Goal**: Overlap: (tokenize + upload) || compute || (download + decode)

#### Solution
Use Metal's **blit command queue** to transfer data in parallel with compute:

```objc++
// native/src/blit_coordinator.mm
@interface KRBlitCoordinator : NSObject

@property (nonatomic, strong) id<MTLDevice> device;
@property (nonatomic, strong) id<MTLCommandQueue> computeQueue;
@property (nonatomic, strong) id<MTLCommandQueue> blitQueue;
@property (nonatomic, strong) id<MTLSharedEvent> syncEvent;

// Synchronization
@property (nonatomic, assign) uint64_t currentEventValue;
@property (nonatomic, strong) NSLock* eventLock;

- (instancetype)initWithDevice:(id<MTLDevice>)device
                  computeQueue:(id<MTLCommandQueue>)computeQueue;

// Async operations
- (void)asyncUploadData:(NSData*)data
               toBuffer:(id<MTLBuffer>)buffer
             completion:(void(^)(void))completion;

- (void)asyncDownloadBuffer:(id<MTLBuffer>)buffer
                 completion:(void(^)(NSData*))completion;

// Prefetching
- (void)prefetchNextBatch:(NSData*)batchData;

// Synchronization
- (void)waitForCompletion;
- (void)signalComputeQueue:(uint64_t)value;
- (void)waitOnComputeQueue:(uint64_t)value;

@end
```

#### Integration Points

**Python Bindings** (`native/bindings/blit_coordinator_bindings.cpp`):
```cpp
py::class_<BlitCoordinator>(m, "BlitCoordinator")
    .def(py::init<>())
    .def("async_upload", &BlitCoordinator::asyncUpload,
         py::arg("data"), py::arg("buffer"), py::arg("completion"))
    .def("async_download", &BlitCoordinator::asyncDownload,
         py::arg("buffer"), py::arg("completion"))
    .def("prefetch_next_batch", &BlitCoordinator::prefetchNextBatch)
    .def("wait_for_completion", &BlitCoordinator::waitForCompletion);
```

**Python Runtime** (`python/models/generator.py`):
```python
from krserve_native import BlitCoordinator

class MLXGenerator:
    def __init__(self, model):
        self.model = model

        # Initialize blit coordinator (if enabled)
        config = get_config()
        if config.metal_optimizations.blit_queue.enabled:
            self.blit = BlitCoordinator()
        else:
            self.blit = None

    async def generate_streaming(self, prompt):
        # Tokenize
        tokens = self.tokenizer.encode(prompt)

        # Upload tokens (async if blit enabled)
        if self.blit:
            # Start background upload
            upload_complete = asyncio.Event()
            self.blit.async_upload(
                tokens.tobytes(),
                self.input_buffer,
                lambda: upload_complete.set()
            )

            # Optionally prefetch next batch while waiting
            if self.prefetch_enabled:
                next_batch = self.get_next_batch()
                self.blit.prefetch_next_batch(next_batch)

            await upload_complete.wait()
        else:
            # Direct upload (original behavior)
            self.input_buffer.write(tokens)

        # Inference
        async for token in self.model.generate(self.input_buffer):
            # Download token (async if blit enabled)
            if self.blit:
                download_complete = asyncio.Event()
                result_data = None

                def on_download(data):
                    nonlocal result_data
                    result_data = data
                    download_complete.set()

                self.blit.async_download(self.output_buffer, on_download)
                await download_complete.wait()
                yield self.tokenizer.decode(result_data)
            else:
                # Direct download (original behavior)
                yield token
```

#### Feature Flag Configuration

```yaml
# config/runtime.yaml
metal_optimizations:
  blit_queue:
    enabled: false                 # DEFAULT: disabled for safety
    prefetch_enabled: true         # Prefetch next batch during compute
    async_upload: true             # Async token upload
    async_download: true           # Async output download

    # Synchronization
    timeout_ms: 5000               # Timeout for blit operations
    max_pending_ops: 10            # Max concurrent blit operations

    # Monitoring
    track_timing: true             # Track upload/download timing
    log_slow_operations: true      # Log operations > 10ms
```

#### Graceful Fallback

```python
# Automatic fallback on blit failure
try:
    if self.blit:
        self.blit.async_upload(data, buffer, completion)
except Exception as e:
    logger.warning(f"Blit upload failed, falling back to direct upload: {e}")
    buffer.write(data)  # Direct upload
```

#### Testing Strategy

**Unit Tests**:
- Blit queue initialization
- Async upload/download correctness
- Synchronization (MTLSharedEvent)
- Timeout handling

**Integration Tests**:
- Real inference with blit queue enabled
- Correctness validation (output matches direct path)
- Performance comparison (TTFT reduction)

**Performance Benchmark**:
```bash
# Measure TTFT with/without blit queue
npx tsx benchmarks/ttft-benchmark.ts --blit-queue=off
npx tsx benchmarks/ttft-benchmark.ts --blit-queue=on

# Expected: -15-20% TTFT reduction
```

#### Risks & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Synchronization bugs (data race) | High | MTLSharedEvent for explicit sync, extensive testing |
| Increased complexity | Medium | Graceful fallback, comprehensive logging |
| Blit queue starvation | Low | Limit max pending ops, timeout enforcement |
| Compatibility with MLX | Low | Uses public Metal API only |

---

### Optimization 3: Command Buffer Ring

#### Problem
Single command buffer limits instruction interleaving:
- Small operations must wait for large operations
- GPU idle time between submissions
- Serialization overhead

#### Solution
Rotate 2-3 command buffers for better GPU utilization:

```cpp
// native/include/kr_command_buffer_ring.h
class CommandBufferRing {
public:
    CommandBufferRing(MTLCommandQueue* queue, size_t ring_size = 3);
    ~CommandBufferRing();

    // Acquire next available buffer
    MTLCommandBuffer* acquireNext();

    // Submit buffer for execution
    void submit(MTLCommandBuffer* buffer, bool wait = false);

    // Wait for all buffers to complete
    void waitForAll();

    // Statistics
    struct Stats {
        size_t total_acquired;
        size_t total_submitted;
        size_t total_completed;
        size_t ring_size;
        size_t available_count;
    };
    Stats getStats() const;

private:
    MTLCommandQueue* queue_;
    std::vector<MTLCommandBuffer*> ring_;
    std::atomic<size_t> current_index_{0};
    std::mutex mutex_;
    std::condition_variable cv_;
};
```

#### Integration Points

**Python Bindings**:
```cpp
py::class_<CommandBufferRing>(m, "CommandBufferRing")
    .def(py::init<size_t>(), py::arg("ring_size") = 3)
    .def("acquire_next", &CommandBufferRing::acquireNext)
    .def("submit", &CommandBufferRing::submit,
         py::arg("buffer"), py::arg("wait") = false)
    .def("wait_for_all", &CommandBufferRing::waitForAll)
    .def("get_stats", &CommandBufferRing::getStats);
```

**Python Runtime**:
```python
from krserve_native import CommandBufferRing

class RuntimeServer:
    def __init__(self):
        config = get_config()
        if config.metal_optimizations.command_buffer_ring.enabled:
            self.cmd_ring = CommandBufferRing(
                ring_size=config.metal_optimizations.command_buffer_ring.ring_size
            )
        else:
            self.cmd_ring = None
```

#### Feature Flag Configuration

```yaml
# config/runtime.yaml
metal_optimizations:
  command_buffer_ring:
    enabled: false                 # DEFAULT: disabled for safety
    ring_size: 3                   # 2-3 buffers recommended (Apple best practice)

    # Behavior
    wait_on_full_ring: true        # Wait if all buffers in use
    max_wait_ms: 1000              # Max wait time for available buffer

    # Monitoring
    track_statistics: true
    log_ring_exhaustion: true
```

#### Graceful Fallback

```python
def get_command_buffer(self):
    if self.cmd_ring:
        try:
            return self.cmd_ring.acquire_next()
        except Exception as e:
            logger.warning(f"Command ring acquisition failed, falling back: {e}")
            return self.queue.commandBuffer()  # Direct allocation
    else:
        return self.queue.commandBuffer()
```

#### Testing Strategy

**Unit Tests**:
- Ring initialization
- Acquire/submit cycle
- Ring exhaustion handling
- Thread safety

**Integration Tests**:
- Real MLX workload with ring enabled
- Interleaving small/large operations
- GPU utilization measurement

**Performance Benchmark**:
```bash
# Measure GPU idle time
instruments -t "Metal System Trace" -D trace.trace \
  npx tsx benchmarks/flexible-benchmark.ts --cmd-ring=on

# Expected: +5-10% GPU utilization
```

#### Risks & Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Ring exhaustion under load | Low | Wait with timeout, fallback to direct allocation |
| Thread safety issues | Low | Mutex + condition variable |
| Increased memory usage | Very Low | Only 2-3 buffers (minimal overhead) |

---

## Feature Flag Strategy

### Configuration Schema

All optimizations controlled via `config/runtime.yaml`:

```yaml
# Phase 6: Metal-Layer Optimizations (v0.9.0)
metal_optimizations:
  # Global enable/disable
  enabled: false                   # MASTER SWITCH: disables all optimizations

  # Individual optimizations
  memory_pool:
    enabled: false                 # DEFAULT: disabled
    heap_size_mb: 256
    num_heaps: 4
    warmup_buffer_sizes_mb: [32, 128, 512]
    track_statistics: true

  blit_queue:
    enabled: false                 # DEFAULT: disabled
    prefetch_enabled: true
    async_upload: true
    async_download: true
    timeout_ms: 5000
    track_timing: true

  command_buffer_ring:
    enabled: false                 # DEFAULT: disabled
    ring_size: 3
    wait_on_full_ring: true
    max_wait_ms: 1000
    track_statistics: true

  # Global settings
  graceful_fallback: true          # Fallback to safe mode on errors
  log_fallbacks: true              # Log when fallback occurs
  expose_metrics: true             # Expose Prometheus metrics
```

### Runtime Control

Optimizations can be toggled at runtime (without restart):

```typescript
// src/api/engine.ts
class Engine {
  async updateMetalOptimizations(config: MetalOptimizationsConfig) {
    // Validate config
    const validated = MetalOptimizationsSchema.safeParse(config);
    if (!validated.success) {
      throw new Error('Invalid metal optimizations config');
    }

    // Send to Python runtime
    await this.jsonRpc.call('runtime.update_metal_config', {
      config: validated.data
    });

    // Update local config
    this.config.metal_optimizations = validated.data;
  }

  async getMetalOptimizationsStats() {
    return await this.jsonRpc.call('runtime.get_metal_stats', {});
  }
}
```

### Default Behavior

**Production Safe**:
- All optimizations **disabled by default**
- Requires explicit opt-in via config
- Graceful fallback on any errors
- Comprehensive logging

**Development/Testing**:
- Can enable via environment variables
- Automatic benchmarking on startup
- Detailed metrics exposed

---

## Risk Assessment & Mitigation

### Risk Matrix

| Risk | Probability | Impact | Severity | Mitigation |
|------|-------------|--------|----------|------------|
| Memory pool leak | Low | High | Medium | RAII pattern, Python context manager, leak detection |
| Blit queue data corruption | Low | Critical | Medium | MTLSharedEvent sync, correctness tests, checksum validation |
| Command ring deadlock | Very Low | High | Low | Timeout enforcement, deadlock detection |
| Performance regression | Low | Medium | Low | Comprehensive benchmarks, A/B testing |
| MLX compatibility break | Very Low | High | Low | Uses public Metal API only, integration tests |
| Production stability | Very Low | Critical | Low | Feature flags, graceful fallback, 24h soak test |

### Mitigation Strategies

#### 1. Memory Pool Safety

**Leak Detection**:
```python
# python/runtime.py
class RuntimeServer:
    def __enter__(self):
        if self.metal_pool:
            self.metal_pool.reset_statistics()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.metal_pool:
            stats = self.metal_pool.get_statistics()
            if stats['acquired'] != stats['released']:
                logger.error(f"Memory pool leak detected: {stats}")
                # Alert monitoring system
```

**RAII Pattern** (C++):
```cpp
class HeapGuard {
public:
    HeapGuard(MetalMemoryPool* pool) : pool_(pool) {
        heap_ = pool_->acquireHeap();
    }
    ~HeapGuard() {
        if (heap_) pool_->releaseHeap(heap_);
    }
private:
    MetalMemoryPool* pool_;
    MTLHeap* heap_;
};
```

#### 2. Blit Queue Correctness

**Checksum Validation**:
```python
import hashlib

def upload_with_validation(data, buffer):
    checksum = hashlib.sha256(data).digest()

    if self.blit:
        self.blit.async_upload(data, buffer, completion)
        # Verify after upload
        downloaded = buffer.read()
        assert hashlib.sha256(downloaded).digest() == checksum
    else:
        buffer.write(data)
```

**Synchronization Testing**:
```cpp
// Test MTLSharedEvent correctness
void testBlitSync() {
    BlitCoordinator blit;

    // Upload data
    std::vector<uint8_t> data(1024, 0x42);
    blit.asyncUpload(data);

    // Ensure compute waits for blit
    blit.waitForCompletion();

    // Verify data integrity
    auto downloaded = buffer.read();
    ASSERT_EQ(data, downloaded);
}
```

#### 3. Command Ring Deadlock Prevention

**Timeout Enforcement**:
```cpp
MTLCommandBuffer* CommandBufferRing::acquireNext() {
    std::unique_lock<std::mutex> lock(mutex_);

    // Wait with timeout
    if (!cv_.wait_for(lock, std::chrono::milliseconds(1000),
                      [this]() { return hasAvailableBuffer(); })) {
        logger.warning("Command ring timeout, falling back");
        return queue_->commandBuffer();  // Fallback
    }

    return ring_[current_index_++ % ring_size_];
}
```

#### 4. Rollback Procedures

**Automatic Rollback** (if performance regresses):
```python
# python/runtime.py
class RuntimeServer:
    async def benchmark_and_rollback(self):
        # Measure baseline
        baseline = await self.run_benchmark()

        # Enable optimizations
        self.enable_metal_optimizations()

        # Measure with optimizations
        optimized = await self.run_benchmark()

        # Rollback if regression
        if optimized['throughput'] < baseline['throughput'] * 0.95:
            logger.error(f"Performance regression detected, rolling back")
            self.disable_metal_optimizations()
            return False

        return True
```

**Manual Rollback** (operator-triggered):
```bash
# Disable all Metal optimizations
curl -X POST http://localhost:9464/api/v1/config \
  -d '{"metal_optimizations": {"enabled": false}}'

# Or via config file
echo "metal_optimizations:\n  enabled: false" > config/runtime.yaml
pkill -HUP mlx-serving  # Reload config
```

---

## Testing Strategy

### Unit Tests (50+ tests)

**Memory Pool** (`tests/unit/native/metal_memory_pool.test.ts`):
- ✅ Pool initialization and warmup
- ✅ Acquire/release cycle
- ✅ Pool exhaustion handling
- ✅ Thread safety (concurrent acquire/release)
- ✅ Statistics tracking
- ✅ Leak detection

**Blit Coordinator** (`tests/unit/native/blit_coordinator.test.ts`):
- ✅ Async upload/download correctness
- ✅ Synchronization (MTLSharedEvent)
- ✅ Timeout handling
- ✅ Prefetch functionality
- ✅ Data integrity (checksum validation)

**Command Ring** (`tests/unit/native/command_buffer_ring.test.ts`):
- ✅ Ring initialization
- ✅ Acquire/submit cycle
- ✅ Ring exhaustion handling
- ✅ Thread safety
- ✅ Statistics tracking

### Integration Tests (20+ tests)

**End-to-End with Real MLX** (`tests/integration/metal_optimizations.test.ts`):
- ✅ Memory pool with real inference workload
- ✅ Blit queue with streaming generation
- ✅ Command ring with concurrent requests
- ✅ All optimizations enabled together
- ✅ Graceful fallback on errors
- ✅ Configuration toggling

**Performance Tests** (`tests/integration/metal_performance.test.ts`):
- ✅ Throughput comparison (optimized vs baseline)
- ✅ TTFT reduction measurement
- ✅ Allocation overhead reduction
- ✅ GPU utilization improvement
- ✅ P99 latency variance

### Stability Tests

**24-Hour Soak Test**:
```bash
#!/bin/bash
# scripts/soak-test-metal.sh

# Enable all Metal optimizations
export METAL_OPTIMIZATIONS_ENABLED=true

# Run continuous load for 24 hours
npx tsx tests/stability/soak-test.ts \
  --duration=24h \
  --concurrency=10 \
  --model="mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions=10000

# Expected:
# - 0 crashes
# - 0 memory leaks
# - Performance stable within ±5%
# - All tests passing
```

**Memory Leak Detection**:
```bash
# Run with memory profiling
instruments -t "Leaks" -D leaks.trace \
  npx tsx benchmarks/flexible-benchmark.ts --metal-opts=on

# Analyze results
leaks --trace=leaks.trace --list
```

### Performance Benchmarking

**Baseline Measurement** (Day 1):
```bash
# Measure current performance (optimizations disabled)
npx tsx benchmarks/flexible-benchmark.ts \
  -q 100 \
  -m "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --output=results/baseline.json

# Record:
# - Throughput (tok/s)
# - TTFT (ms)
# - P50/P95/P99 latency
# - GPU utilization
# - Memory usage
```

**Optimization Comparison** (Day 7):
```bash
# Test each optimization individually
npx tsx benchmarks/metal-optimization-comparison.ts \
  --baseline=results/baseline.json \
  --optimizations=memory_pool,blit_queue,command_ring \
  --output=results/week1-comparison.json

# Expected results:
# memory_pool:      +10-15% throughput
# blit_queue:       -15-20% TTFT
# command_ring:     +5-10% GPU util
# all_combined:     +40-60% throughput
```

---

## Monitoring & Observability

### Prometheus Metrics

**Memory Pool Metrics**:
```python
# python/telemetry.py
from prometheus_client import Counter, Gauge, Histogram

# Pool statistics
metal_pool_acquired = Counter('metal_pool_acquired_total', 'Total heaps acquired')
metal_pool_released = Counter('metal_pool_released_total', 'Total heaps released')
metal_pool_available = Gauge('metal_pool_available', 'Available heaps in pool')
metal_pool_exhaustion = Counter('metal_pool_exhaustion_total', 'Pool exhaustion events')

# Allocation timing
metal_pool_acquire_duration = Histogram(
    'metal_pool_acquire_duration_seconds',
    'Time to acquire heap',
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1]
)
```

**Blit Queue Metrics**:
```python
# Upload/download timing
blit_upload_duration = Histogram(
    'blit_upload_duration_seconds',
    'Blit upload duration',
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1]
)
blit_download_duration = Histogram(
    'blit_download_duration_seconds',
    'Blit download duration',
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1]
)

# TTFT impact
ttft_with_blit = Histogram('ttft_with_blit_ms', 'TTFT with blit queue')
ttft_without_blit = Histogram('ttft_without_blit_ms', 'TTFT without blit queue')
```

**Command Ring Metrics**:
```python
# Ring utilization
command_ring_acquired = Counter('command_ring_acquired_total', 'Buffers acquired')
command_ring_submitted = Counter('command_ring_submitted_total', 'Buffers submitted')
command_ring_available = Gauge('command_ring_available', 'Available buffers')
command_ring_wait_time = Histogram('command_ring_wait_seconds', 'Wait time for buffer')
```

### Grafana Dashboards

**Metal Optimizations Dashboard**:
- Memory pool statistics (acquired/released/available)
- Blit queue timing (upload/download duration)
- Command ring utilization
- TTFT comparison (with/without optimizations)
- Throughput trends
- Error rates

### Alerting Rules

**Critical Alerts**:
```yaml
# prometheus/alerts/metal_optimizations.yml
groups:
  - name: metal_optimizations
    rules:
      # Memory pool leak detection
      - alert: MetalPoolLeak
        expr: metal_pool_acquired_total - metal_pool_released_total > 10
        for: 5m
        annotations:
          summary: "Metal memory pool leak detected"

      # Pool exhaustion
      - alert: MetalPoolExhaustion
        expr: rate(metal_pool_exhaustion_total[5m]) > 0.1
        for: 2m
        annotations:
          summary: "Metal pool exhaustion rate high"

      # Blit queue performance degradation
      - alert: BlitQueueSlow
        expr: histogram_quantile(0.99, blit_upload_duration_seconds) > 0.05
        for: 5m
        annotations:
          summary: "Blit queue P99 upload time > 50ms"
```

---

## Rollout Plan

### Phase 1: Development (Day 1-5)

**Day 1-2**: Memory Pool Implementation
- Implement `MetalMemoryPool` (Objective-C++)
- Python bindings (pybind11)
- Unit tests
- Integration tests

**Day 3-4**: Blit Queue Implementation
- Implement `BlitCoordinator`
- Python bindings
- Unit tests
- Integration tests with real inference

**Day 5**: Command Buffer Ring Implementation
- Implement `CommandBufferRing`
- Python bindings
- Unit tests
- Integration tests

### Phase 2: Testing & Validation (Day 6)

**Day 6**: Comprehensive Testing
- Run all unit tests (50+)
- Run all integration tests (20+)
- Performance benchmarking
- Memory leak detection
- Stability testing (mini soak test: 2 hours)

### Phase 3: Documentation & Deployment (Day 7)

**Day 7**: Documentation & Release
- Update `CLAUDE.md`
- Update `README.md`
- Create operator guide (`docs/METAL_OPTIMIZATIONS.md`)
- Create performance tuning guide
- Tag release: `v0.9.0-alpha.1`

### Rollout Strategy (Production)

**Stage 1: Canary (10% traffic)**
- Enable on 10% of production traffic
- Monitor for 24 hours
- Rollback if any issues

**Stage 2: Staged Rollout (50% traffic)**
- Enable on 50% of production traffic
- Monitor for 48 hours
- Validate performance gains

**Stage 3: Full Rollout (100% traffic)**
- Enable on all production traffic
- Continue monitoring for 1 week
- Document lessons learned

---

## Success Metrics (Week 1 Completion)

### Technical Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Throughput | 84.96 tok/s | 120-135 tok/s | Flexible benchmark (100q) |
| TTFT | TBD | -15-20% | Per-request measurement |
| Allocation overhead | TBD | -20-30% | Instruments profiling |
| GPU utilization | TBD | +5-10% | Metal Performance HUD |
| P99 latency | TBD | -10-15% | 24-hour soak test |
| Memory usage | TBD | <+5% | Memory profiling |

### Quality Metrics

| Metric | Target | Status |
|--------|--------|--------|
| Test coverage | >90% | TBD |
| Unit tests passing | 50+/50+ | TBD |
| Integration tests passing | 20+/20+ | TBD |
| Memory leaks | 0 | TBD |
| Crashes (24h soak) | 0 | TBD |
| Performance regression | 0 | TBD |

### Operational Metrics

| Metric | Target | Status |
|--------|--------|--------|
| Feature flag system | Implemented | TBD |
| Graceful fallback | Working | TBD |
| Prometheus metrics | Exposed | TBD |
| Documentation | Complete | TBD |
| Rollback procedure | Tested | TBD |

---

## Appendix

### A. Configuration Schema (Zod)

```typescript
// src/types/schemas/metal-optimizations.ts
import { z } from 'zod';

export const MetalMemoryPoolSchema = z.object({
  enabled: z.boolean().default(false),
  heap_size_mb: z.number().int().min(64).max(2048).default(256),
  num_heaps: z.number().int().min(2).max(16).default(4),
  warmup_buffer_sizes_mb: z.array(z.number().int().min(1).max(1024)).default([32, 128, 512]),
  track_statistics: z.boolean().default(true),
  log_pool_exhaustion: z.boolean().default(true),
});

export const MetalBlitQueueSchema = z.object({
  enabled: z.boolean().default(false),
  prefetch_enabled: z.boolean().default(true),
  async_upload: z.boolean().default(true),
  async_download: z.boolean().default(true),
  timeout_ms: z.number().int().min(100).max(30000).default(5000),
  max_pending_ops: z.number().int().min(1).max(100).default(10),
  track_timing: z.boolean().default(true),
  log_slow_operations: z.boolean().default(true),
});

export const MetalCommandRingSchema = z.object({
  enabled: z.boolean().default(false),
  ring_size: z.number().int().min(2).max(8).default(3),
  wait_on_full_ring: z.boolean().default(true),
  max_wait_ms: z.number().int().min(100).max(10000).default(1000),
  track_statistics: z.boolean().default(true),
  log_ring_exhaustion: z.boolean().default(true),
});

export const MetalOptimizationsSchema = z.object({
  enabled: z.boolean().default(false),
  memory_pool: MetalMemoryPoolSchema,
  blit_queue: MetalBlitQueueSchema,
  command_buffer_ring: MetalCommandRingSchema,
  graceful_fallback: z.boolean().default(true),
  log_fallbacks: z.boolean().default(true),
  expose_metrics: z.boolean().default(true),
});

export type MetalOptimizationsConfig = z.infer<typeof MetalOptimizationsSchema>;
```

### B. Performance Benchmark Script

```typescript
// benchmarks/metal-optimization-comparison.ts
import { createEngine } from '../src/index.js';
import * as fs from 'fs';

async function benchmarkMetalOptimizations() {
  const model = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const questions = 100;

  const configurations = [
    { name: 'baseline', metal: { enabled: false } },
    { name: 'memory_pool', metal: { enabled: true, memory_pool: { enabled: true } } },
    { name: 'blit_queue', metal: { enabled: true, blit_queue: { enabled: true } } },
    { name: 'command_ring', metal: { enabled: true, command_buffer_ring: { enabled: true } } },
    { name: 'all_optimizations', metal: { enabled: true, memory_pool: { enabled: true }, blit_queue: { enabled: true }, command_buffer_ring: { enabled: true } } },
  ];

  const results = [];

  for (const config of configurations) {
    console.log(`\n=== Benchmarking: ${config.name} ===`);

    const engine = await createEngine({ metal_optimizations: config.metal });
    await engine.loadModel({ model });

    const startTime = Date.now();
    let totalTokens = 0;
    let ttftSum = 0;

    for (let i = 0; i < questions; i++) {
      const prompt = `Question ${i + 1}: What is quantum computing?`;
      const requestStart = Date.now();
      let firstTokenTime = null;

      for await (const chunk of engine.createGenerator({ model, prompt, maxTokens: 100 })) {
        if (chunk.type === 'token') {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            ttftSum += (firstTokenTime - requestStart);
          }
          totalTokens++;
        }
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const throughput = totalTokens / duration;
    const avgTtft = ttftSum / questions;

    results.push({
      configuration: config.name,
      throughput_tok_s: throughput,
      avg_ttft_ms: avgTtft,
      total_tokens: totalTokens,
      duration_s: duration,
    });

    await engine.dispose();
  }

  // Save results
  fs.writeFileSync('results/metal-optimization-comparison.json', JSON.stringify(results, null, 2));

  // Print comparison
  console.log('\n=== Results ===');
  console.table(results);

  // Calculate improvements
  const baseline = results.find(r => r.configuration === 'baseline');
  for (const result of results) {
    if (result.configuration !== 'baseline') {
      const improvement = ((result.throughput_tok_s - baseline.throughput_tok_s) / baseline.throughput_tok_s * 100).toFixed(1);
      const ttftImprovement = ((baseline.avg_ttft_ms - result.avg_ttft_ms) / baseline.avg_ttft_ms * 100).toFixed(1);
      console.log(`${result.configuration}: +${improvement}% throughput, ${ttftImprovement}% TTFT reduction`);
    }
  }
}

benchmarkMetalOptimizations().catch(console.error);
```

---

## Sign-off

**Product Owner**: _______________
**Engineering Lead**: _______________
**QA Lead**: _______________
**Date**: _______________

---

**Version History**:
- v1.0 (2025-11-09): Initial PRD for Week 1 Metal optimizations
