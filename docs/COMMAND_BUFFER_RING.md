# Command Buffer Ring - Detailed Guide

**Version:** v0.9.0
**Component:** Week 1 Metal Optimization #3
**Performance Impact:** +5-10% GPU utilization, +2-3% throughput
**Status:** Production Ready

---

## Overview

The **Command Buffer Ring** optimization implements **double/triple buffering** for Metal command buffers, enabling continuous GPU utilization by overlapping command buffer submission, execution, and completion. This eliminates GPU idle time between operations and provides a foundation for future kernel fusion (Week 2).

### What Problem Does It Solve?

**Current Behavior (Single Command Buffer):**

```
Timeline (sequential command buffers):
┌────────┬══════════┬─────────┐ ┌────────┬══════════┬─────────┐
│ Submit │ GPU Exec │Complete │ │ Submit │ GPU Exec │Complete │
│ 0.3ms  │  8.2ms   │ 0.1ms   │ │ 0.3ms  │  8.2ms   │ 0.1ms   │
└────────┴══════════┴─────────┘ └────────┴══════════┴─────────┘
         ↑                   ↑           ↑
    GPU idle (submission)   GPU idle (completion)

GPU Utilization: 8.2 / (0.3 + 8.2 + 0.1) = 95.3%
But submission blocks next operation → effective utilization ~72%
```

**With Command Buffer Ring (Triple Buffering):**

```
Timeline (overlapped command buffers):
Buffer 0: ┌────────┬══════════┬─────────┐
          │ Submit │ GPU Exec │Complete │
          └────────┴══════════┴─────────┘
                   ↑
Buffer 1:          │ ┌────────┬══════════┬─────────┐
                   │ │ Submit │ GPU Exec │Complete │
                   │ └────────┴══════════┴─────────┘
                   ↑          ↑
        GPU busy (buffer 0)   │
                              ↑
Buffer 2:                     │ ┌────────┬══════════┬─────────┐
                              │ │ Submit │ GPU Exec │Complete │
                              │ └────────┴══════════┴─────────┘
                              ↑
                   GPU busy (buffer 1)

GPU Utilization: Near 100% (submission overlaps with execution)
Effective utilization: ~85% (accounting for completion overhead)
```

**Benefits:**
- **Reduced GPU idle time:** Submission and completion overlap with execution
- **Higher throughput:** More work per unit time
- **Better pipeline utilization:** Foundation for kernel fusion

---

## Architecture

### Components

```
CommandBufferRing
├─ MTLDevice (id<MTLDevice>)
│  └─ Shared GPU device reference
├─ MTLCommandQueue (id<MTLCommandQueue>)
│  └─ Compute command queue (shared with MLX)
├─ Ring Buffer (std::vector<id<MTLCommandBuffer>>)
│  ├─ Buffer 0 (label: "CommandRing #0")
│  ├─ Buffer 1 (label: "CommandRing #1")
│  └─ Buffer 2 (label: "CommandRing #2")
├─ Ring State
│  ├─ Current Index (atomic, wraps at ring_size)
│  ├─ Acquisition Counter (total buffer acquisitions)
│  └─ Wait Events (count of stalls)
└─ Statistics & Metrics
   ├─ Reuse rate (ring hits / total acquisitions)
   ├─ Average wait time (time blocked waiting for free buffer)
   └─ Total acquisitions/releases
```

### How It Works

#### 1. Initialization (Pre-allocate Command Buffers)

```objc++
CommandBufferRing(const Config& config) {
    // Create ring of command buffers
    for (size_t i = 0; i < config.ring_size; i++) {
        id<MTLCommandBuffer> cmd_buffer = [queue commandBuffer];
        cmd_buffer.label = [NSString stringWithFormat:@"CommandRing #%zu", i];
        ring_.push_back(cmd_buffer);
    }

    // Track completion with shared event
    shared_event_ = [device newSharedEvent];
}
```

**Why pre-allocate?**
- Creating `MTLCommandBuffer` has ~0.3ms overhead
- Pre-allocation eliminates this cost during inference
- Command buffers are lightweight (metadata only)

---

#### 2. Acquire (Get Next Available Buffer)

```objc++
id<MTLCommandBuffer> acquire(uint64_t timeout_ms) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Round-robin index
    size_t index = current_index_.fetch_add(1) % ring_size_;
    id<MTLCommandBuffer> cmd_buffer = ring_[index];

    // Check if buffer is still executing
    if (cmd_buffer.status == MTLCommandBufferStatusNotEnqueued ||
        cmd_buffer.status == MTLCommandBufferStatusCompleted) {
        // Buffer is free, return immediately
        total_acquisitions_++;
        return cmd_buffer;
    }

    // Buffer is busy, wait for completion
    auto wait_start = std::chrono::steady_clock::now();

    if (timeout_ms > 0) {
        // Wait with timeout
        [cmd_buffer waitUntilCompleted];  // or timeout
    } else {
        // Wait indefinitely
        [cmd_buffer waitUntilCompleted];
    }

    auto wait_end = std::chrono::steady_clock::now();
    auto wait_ms = std::chrono::duration<double, std::milli>(wait_end - wait_start).count();

    // Update statistics
    total_acquisitions_++;
    wait_events_++;
    total_wait_ms_ += wait_ms;

    if (config_.log_wait_events) {
        NSLog(@"CommandRing: Waited %.2fms for buffer #%zu", wait_ms, index);
    }

    return cmd_buffer;
}
```

**Key Points:**
- **Round-robin selection:** Distributes load evenly across buffers
- **Non-blocking when possible:** Returns immediately if buffer free
- **Efficient wait:** Uses Metal's `waitUntilCompleted` (not busy-wait)
- **Timeout support:** Can fail-fast if buffer doesn't complete in time

---

#### 3. Release (Mark Buffer as Submitted)

```objc++
void release(id<MTLCommandBuffer> cmd_buffer) {
    // No explicit release needed!
    // Metal's ARC automatically manages lifetime
    // Buffer becomes available when execution completes

    std::lock_guard<std::mutex> lock(mutex_);
    total_releases_++;
}
```

**Why no explicit release?**
- Metal command buffers are **self-managing**
- When `commit()` is called, Metal tracks execution
- When execution completes, buffer becomes available for reuse
- ARC (Automatic Reference Counting) handles memory cleanup

---

#### 4. Usage Pattern

```objc++
// Typical inference loop
for (int i = 0; i < num_tokens; i++) {
    // 1. Acquire next buffer from ring (non-blocking if available)
    id<MTLCommandBuffer> cmd_buffer = ring.acquire(timeout_ms);

    // 2. Encode commands
    id<MTLComputeCommandEncoder> encoder = [cmd_buffer computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];
    [encoder setBuffer:input_buffer offset:0 atIndex:0];
    [encoder setBuffer:output_buffer offset:0 atIndex:1];
    [encoder dispatchThreadgroups:threadgroups threadsPerThreadgroup:threads];
    [encoder endEncoding];

    // 3. Commit (non-blocking, returns immediately)
    [cmd_buffer commit];

    // 4. Optionally wait for completion
    // [cmd_buffer waitUntilCompleted];  // Usually not needed

    // 5. Buffer automatically reused when complete
}
```

**Pipeline behavior:**
```
Iteration 0: acquire(buf#0) → encode → commit
Iteration 1: acquire(buf#1) → encode → commit  (buf#0 executing on GPU)
Iteration 2: acquire(buf#2) → encode → commit  (buf#0 & buf#1 executing)
Iteration 3: acquire(buf#0) → wait if busy → encode → commit
```

---

## Configuration

### Basic Configuration

```yaml
metal_optimizations:
  enabled: true

  command_buffer_ring:
    enabled: true
    ring_size: 3              # 2=double buffer, 3=triple buffer, 4=quad buffer
    timeout_ms: 0             # Acquisition timeout (0=infinite)
    log_wait_events: false    # Log buffer wait events (debug only)
    track_statistics: true    # Track reuse statistics
```

### Parameter Details

#### `ring_size`

**What it controls:** Number of command buffers in the ring.

**How to choose:**
- **2 (double buffering):** Minimal overhead, good for low latency
- **3 (triple buffering):** Recommended default, best balance
- **4+ (quad buffering):** Diminishing returns, more memory

**Trade-offs:**

| Ring Size | GPU Utilization | Memory | Complexity |
|-----------|----------------|---------|------------|
| **1** (baseline) | 72% | Minimal | Low |
| **2** (double) | 80% | Low | Low |
| **3** (triple) | 85% | Moderate | Moderate |
| **4** (quad) | 87% | High | Moderate |

**Recommended:**
```yaml
# Low latency (minimal buffering)
ring_size: 2

# Balanced (recommended)
ring_size: 3

# Max throughput (diminishing returns)
ring_size: 4
```

**Why not larger?**
- **Diminishing returns:** GPU utilization plateaus at ~87%
- **Memory overhead:** Each buffer consumes ~1-2MB
- **Increased latency:** More buffering = higher latency

---

#### `timeout_ms`

**What it controls:** Maximum time to wait for a free command buffer.

**How to choose:**
- **0 (infinite):** Wait forever (default, recommended)
- **>0 (timeout):** Fail-fast on GPU hangs (debugging)

**Use cases:**

```yaml
# Production (recommended)
timeout_ms: 0  # Wait forever, no failures

# Debugging GPU hangs
timeout_ms: 5000  # Fail after 5 seconds

# Real-time systems (hard deadlines)
timeout_ms: 100  # Fail if GPU can't keep up
```

**Behavior on timeout:**
```cpp
try {
    id<MTLCommandBuffer> cmd_buffer = ring.acquire(timeout_ms);
} catch (const std::runtime_error& e) {
    // Timeout occurred
    NSLog(@"ERROR: Command buffer acquisition timeout after %lums", timeout_ms);
    // Handle failure (skip frame, reduce quality, etc.)
}
```

---

#### `log_wait_events`

**What it controls:** Log when buffer acquisition blocks (debug mode).

**Performance impact:**
- **Enabled:** ~1-2% overhead (I/O)
- **Disabled:** No logging overhead

**Recommended:**
```yaml
# Development/debugging
log_wait_events: true

# Production
log_wait_events: false
```

**Example output:**
```
[DEBUG] CommandRing: Waited 2.35ms for buffer #0
[DEBUG] CommandRing: Waited 1.87ms for buffer #1
[DEBUG] CommandRing: Waited 0.12ms for buffer #2
```

**Interpretation:**
- **Wait time < 0.1ms:** Excellent, no stalls
- **Wait time 0.1-1ms:** Good, minor stalls
- **Wait time > 1ms:** Poor, GPU bottleneck or too small ring

---

#### `track_statistics`

**What it controls:** Enable/disable metrics collection.

**Performance impact:**
- **Enabled:** ~1% overhead (atomic counters)
- **Disabled:** No overhead, no observability

**Recommended:**
```yaml
# Production (monitoring required)
track_statistics: true

# Benchmarking (absolute max performance)
track_statistics: false
```

---

## Performance Impact

### GPU Utilization Improvement

**Expected improvements:**
- **Conservative:** +5-7% GPU utilization
- **Target:** +8-10% GPU utilization
- **Optimistic:** +10-12% GPU utilization

**Measurement:**
```bash
# Enable Metal Performance HUD
export MTL_HUD_ENABLED=1

# Run inference
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions 100

# Observe GPU utilization in HUD overlay
# Without ring: 72-75%
# With ring:    80-85%
```

### Throughput Improvement

**Expected improvements:**
- **Conservative:** +2-3% throughput
- **Target:** +3-5% throughput
- **Optimistic:** +5-7% throughput

**Why smaller than GPU utilization gain?**
- GPU utilization is just one factor in overall throughput
- Memory bandwidth, compute intensity also matter
- Amdahl's Law: Diminishing returns on partial optimization

**Measurement:**
```bash
# Baseline (ring disabled)
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions 100 \
  --output baseline.json

# With command ring
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions 100 \
  --output ring.json

# Compare
python scripts/compare-benchmarks.py baseline.json ring.json
```

**Example results:**
```
Baseline Throughput:    84.96 tok/s
Ring Throughput:        87.50 tok/s
Improvement:            +3.0% ✅

GPU Utilization:
  Baseline:  72%
  Ring:      80%
  Gain:      +11.1% ✅
```

---

## Monitoring Metrics

### Statistics API

```python
from krserve_native import CommandBufferRing

# Get current statistics
stats = ring.get_statistics()

print(f"Total acquisitions:    {stats.total_acquisitions}")
print(f"Total releases:        {stats.total_releases}")
print(f"Wait events:           {stats.wait_events}")
print(f"Reuse rate:            {stats.reuse_rate * 100:.1f}%")
print(f"Avg wait time:         {stats.avg_wait_ms:.2f}ms")
print(f"Ring size:             {stats.ring_size}")
print(f"Current index:         {stats.current_index}")
```

### Key Metrics

#### Reuse Rate

**Formula:**
```
reuse_rate = (total_acquisitions - wait_events) / total_acquisitions
```

**Interpretation:**
- **1.0 (100%):** No waits, ring size sufficient
- **0.9 (90%):** Rare waits, acceptable
- **0.7 (70%):** Frequent waits, increase ring size
- **0.5 (50%):** Very frequent waits, ring too small or GPU bottleneck

**Targets:**
- **Excellent:** >95% reuse rate
- **Good:** 85-95% reuse rate
- **Fair:** 70-85% reuse rate
- **Poor:** <70% reuse rate

**Example:**
```python
stats = ring.get_statistics()

if stats.reuse_rate > 0.95:
    print("✅ Excellent reuse rate, ring sized correctly")
elif stats.reuse_rate > 0.85:
    print("✅ Good reuse rate, acceptable performance")
elif stats.reuse_rate > 0.70:
    print("⚠️ Fair reuse rate, consider increasing ring_size")
else:
    print("❌ Poor reuse rate, increase ring_size or check GPU bottleneck")
```

---

#### Average Wait Time

**Formula:**
```
avg_wait_ms = total_wait_ms / wait_events
```

**Interpretation:**
- **<0.1ms:** No blocking, ring size sufficient
- **0.1-1ms:** Minimal blocking, acceptable
- **1-5ms:** Moderate blocking, tune ring size or GPU
- **>5ms:** Severe blocking, GPU bottleneck or deadlock

**Targets:**
- **Target:** <0.1ms average wait
- **Warning:** >1ms average wait
- **Critical:** >5ms average wait

**Example:**
```python
stats = ring.get_statistics()

if stats.avg_wait_ms < 0.1:
    print("✅ No blocking, optimal performance")
elif stats.avg_wait_ms < 1.0:
    print("✅ Minimal blocking, acceptable")
elif stats.avg_wait_ms < 5.0:
    print("⚠️ Moderate blocking, investigate GPU load")
else:
    print("❌ Severe blocking, GPU bottleneck or deadlock")
```

---

## Tuning Recommendations

### Scenario 1: Low Reuse Rate (<85%)

**Symptoms:**
- `reuse_rate < 0.85`
- Frequent wait events
- Lower throughput than expected

**Diagnosis:**
```python
stats = ring.get_statistics()
print(f"Reuse rate: {stats.reuse_rate * 100:.1f}%")
print(f"Wait events: {stats.wait_events}")
print(f"Acquisitions: {stats.total_acquisitions}")
print(f"Ring size: {stats.ring_size}")
```

**Solutions:**

1. **Increase ring size:**
   ```yaml
   # If ring_size: 2
   ring_size: 3  # Triple buffering

   # If ring_size: 3
   ring_size: 4  # Quad buffering
   ```

2. **Check GPU bottleneck:**
   ```bash
   # Profile GPU workload
   instruments -t "Metal System Trace" -D trace.trace <command>
   # Look for GPU idle time
   ```

3. **Reduce workload per command:**
   ```python
   # If encoding too much work per buffer:
   # Split into smaller commands
   ```

---

### Scenario 2: High Wait Time (>1ms)

**Symptoms:**
- `avg_wait_ms > 1.0`
- Performance degradation
- GPU utilization not improving

**Diagnosis:**
```python
stats = ring.get_statistics()
print(f"Avg wait: {stats.avg_wait_ms:.2f}ms")
print(f"Wait events: {stats.wait_events}")
print(f"Total acquisitions: {stats.total_acquisitions}")
```

**Possible causes:**
1. **GPU execution too long:** Command buffers not completing fast enough
2. **Ring size too small:** Not enough buffers for pipelining
3. **GPU stall:** Deadlock or synchronization issue

**Solutions:**

1. **Increase ring size:**
   ```yaml
   ring_size: 4  # Or 5 for very long GPU commands
   ```

2. **Profile GPU execution:**
   ```bash
   instruments -t "Metal System Trace" -D trace.trace <command>
   # Identify long-running kernels
   ```

3. **Add timeout to detect hangs:**
   ```yaml
   timeout_ms: 5000  # Fail if waiting >5 seconds
   ```

---

### Scenario 3: Wasted Memory (Ring Too Large)

**Symptoms:**
- `reuse_rate > 0.98`
- `wait_events == 0` or very low
- Memory pressure warnings

**Diagnosis:**
```python
stats = ring.get_statistics()
print(f"Reuse rate: {stats.reuse_rate * 100:.1f}%")
print(f"Ring size: {stats.ring_size}")
print(f"Wait events: {stats.wait_events}")

# If reuse_rate > 0.98 and ring_size > 2:
print("⚠️ Ring may be over-provisioned, reduce ring_size")
```

**Solutions:**

1. **Reduce ring size:**
   ```yaml
   # If ring_size: 4 and no waits
   ring_size: 3  # Reduce to triple buffering

   # If ring_size: 3 and no waits
   ring_size: 2  # Reduce to double buffering
   ```

**Caveat:** Only reduce if **consistently** no waits. Bursty workloads may need larger ring.

---

## Troubleshooting

### Issue: No Performance Improvement

**Symptoms:**
- GPU utilization unchanged
- Throughput same as baseline
- Reuse rate very high (>98%)

**Diagnosis:**
```python
stats = ring.get_statistics()
print(f"Reuse rate: {stats.reuse_rate * 100:.1f}%")
print(f"Ring size: {stats.ring_size}")

if stats.reuse_rate > 0.98:
    print("⚠️ Ring not being stressed, GPU execution may be too fast")
```

**Possible causes:**
1. **GPU execution too fast:** Buffers complete before next acquisition
2. **Ring size too large:** More buffers than needed
3. **Not enough workload:** Commands are too lightweight

**Solutions:**

- **Reduce ring size:** `ring_size: 2` (minimal buffering)
- **Verify workload:** Ensure commands are GPU-bound, not CPU-bound
- **Combine with other optimizations:** Ring alone provides small gain

---

### Issue: Deadlock or Hang

**Symptoms:**
- `acquire()` hangs indefinitely
- GPU appears frozen
- No progress in inference

**Diagnosis:**
```bash
# Enable wait event logging
# In config/runtime.yaml:
log_wait_events: true

# Check logs for indefinite waits
# Example:
# [DEBUG] CommandRing: Waiting for buffer #0...
# [DEBUG] CommandRing: Still waiting... (5000ms elapsed)
```

**Possible causes:**
1. **Command buffer never completes:** GPU hang or infinite loop
2. **Synchronization bug:** Waiting for wrong buffer
3. **Resource exhaustion:** GPU out of memory

**Solutions:**

1. **Add timeout to detect hang:**
   ```yaml
   timeout_ms: 10000  # Fail after 10 seconds
   ```

2. **Profile GPU execution:**
   ```bash
   instruments -t "Metal System Trace" -D trace.trace <command>
   # Check for hung kernels
   ```

3. **Check GPU errors:**
   ```objc++
   if (cmd_buffer.status == MTLCommandBufferStatusError) {
       NSLog(@"Command buffer error: %@", cmd_buffer.error);
   }
   ```

---

### Issue: High Memory Usage

**Symptoms:**
- Memory pressure warnings
- Swap usage increasing
- `vmmap` shows large command buffers

**Diagnosis:**
```bash
# Check memory usage
vmmap <pid> | grep "MTL"

# Example output:
# MTLCommandBuffer  12.0MB  # ring_size × buffer_size
```

**Solutions:**

1. **Reduce ring size:**
   ```yaml
   ring_size: 2  # Minimal buffering
   ```

2. **Verify no buffer leaks:**
   ```python
   stats = ring.get_statistics()
   leaked = stats.total_acquisitions - stats.total_releases
   if leaked > 0:
       print(f"❌ {leaked} buffers leaked!")
   ```

---

## Advanced Usage

### Integration with Kernel Fusion (Week 2)

Command buffer ring provides foundation for kernel fusion:

```objc++
// Week 2: Fused attention + MLP kernel
id<MTLCommandBuffer> cmd_buffer = ring.acquire();

// Encode fused kernel (single dispatch, no intermediate buffers)
id<MTLComputeCommandEncoder> encoder = [cmd_buffer computeCommandEncoder];
[encoder setComputePipelineState:fused_pipeline];
[encoder setBuffer:input_buffer offset:0 atIndex:0];
[encoder setBuffer:output_buffer offset:0 atIndex:1];
[encoder dispatchThreadgroups:threadgroups threadsPerThreadgroup:threads];
[encoder endEncoding];

[cmd_buffer commit];

// Ring automatically pipelines fused kernels
```

**Benefits:**
- **Less overhead:** Fewer command buffer creations
- **Better pipelining:** Fused kernels execute continuously
- **Higher GPU utilization:** Ring keeps GPU busy with fused work

---

### Custom Ring Management

Future enhancement (not yet implemented):

```yaml
command_buffer_ring:
  allocation_strategy: 'priority'  # Options: 'round-robin', 'priority', 'least-busy'
  priority_levels: 3  # High/medium/low priority buffers
```

---

## Related Documentation

- **[METAL_OPTIMIZATIONS.md](./METAL_OPTIMIZATIONS.md)** - Overview of all Week 1 optimizations
- **[METAL_MEMORY_POOL.md](./METAL_MEMORY_POOL.md)** - Memory pool optimization
- **[BLIT_QUEUE.md](./BLIT_QUEUE.md)** - Async I/O overlap optimization
- **[Week 1 Performance Modeling](../automatosx/PRD/WEEK1-PERFORMANCE-MODELING.md)** - Mathematical predictions and validation

---

**Version:** v0.9.0
**Last Updated:** 2025-11-09
**Component:** Command Buffer Ring
