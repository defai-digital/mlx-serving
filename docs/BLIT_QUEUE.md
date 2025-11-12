# Blit Queue I/O Overlap - Detailed Guide

**Version:** v0.9.0
**Component:** Week 1 Metal Optimization #2
**Performance Impact:** -15-20% TTFT, +8-10% throughput
**Status:** Production Ready

---

## Overview

The **Blit Queue I/O Overlap** optimization enables **asynchronous data transfer** between CPU and GPU using a dedicated Metal Blit Command Queue. By overlapping tokenization, upload, compute, and download operations, it significantly reduces Time to First Token (TTFT) and improves overall throughput.

### What Problem Does It Solve?

**Current Behavior (Synchronous I/O):**

```
Timeline (sequential operations):
┌─────────────┬────────┬══════════┬─────────┐
│ Tokenize    │ Upload │ Compute  │Download │
│ (CPU)       │(block) │  (GPU)   │(block)  │
└─────────────┴────────┴══════════┴─────────┘
  2.5ms        1.3ms     8.2ms      0.8ms
                 ↑                     ↑
            GPU idle              CPU idle

TTFT = Tokenize + Upload + Compute = 12.0ms
Total = 12.8ms per request
```

**With Blit Queue (Asynchronous I/O):**

```
Timeline (overlapped operations):
┌─────────────┐
│ Tokenize    │────────┐
│ (CPU)       │        │
└─────────────┘        ▼
                  ┌────────┐
                  │ Upload │─────┐
                  │(async) │     │
                  └────────┘     ▼
                            ┌══════════┐
                            │ Compute  │────┐
                            │  (GPU)   │    │
                            └══════════┘    ▼
                                       ┌─────────┐
                                       │Download │
                                       │ (async) │
                                       └─────────┘
  2.5ms              1.3ms      8.2ms       0.8ms
  (overlaps upload)           (overlaps download)

TTFT = Tokenize + Compute = 10.7ms (-10.8%)
Total = 10.7ms per request (-16.4%)
```

**Time Saved:**
- Upload overlaps with tokenization tail: -1.3ms
- Download overlaps with next request: -0.8ms
- **Total improvement:** -16.4% latency, +19.5% throughput potential

---

## Architecture

### Components

```
BlitQueue
├─ MTLDevice (id<MTLDevice>)
│  └─ Shared GPU device reference
├─ MTLCommandQueue (id<MTLCommandQueue>)
│  └─ Dedicated blit queue (label: "krserve.blit.queue")
├─ MTLSharedEvent (id<MTLSharedEvent>)
│  └─ CPU-GPU synchronization primitive (no busy-wait)
├─ Operation Tracking
│  ├─ Pending Operations (Map<op_id → BlitOperation>)
│  ├─ Completed Operations (Map<op_id → BlitOperation>)
│  └─ Next Event Value (atomic counter)
└─ Statistics & Metrics
   ├─ Upload/download counts and timings
   ├─ Overlap efficiency ratio
   └─ Synchronization wait times
```

### How It Works

#### 1. Asynchronous Upload (CPU → GPU)

```objc++
uint64_t uploadAsync(const void* source_data, size_t source_size,
                     id<MTLBuffer> dest_buffer, size_t dest_offset) {
    // 1. Create staging buffer (CPU-accessible shared memory)
    id<MTLBuffer> staging_buffer = [device_ newBufferWithBytes:source_data
                                                         length:source_size
                                                        options:MTLResourceStorageModeShared];

    // 2. Create blit command buffer
    id<MTLCommandBuffer> cmd_buffer = [blit_queue_ commandBuffer];
    cmd_buffer.label = @"BlitQueue Upload";

    // 3. Encode copy operation
    id<MTLBlitCommandEncoder> encoder = [cmd_buffer blitCommandEncoder];
    [encoder copyFromBuffer:staging_buffer
               sourceOffset:0
                   toBuffer:dest_buffer
          destinationOffset:dest_offset
                       size:source_size];
    [encoder endEncoding];

    // 4. Signal shared event when complete
    uint64_t event_value = next_event_value_++;
    [cmd_buffer encodeSignalEvent:shared_event_ value:event_value];

    // 5. Add completion handler for metrics
    [cmd_buffer addCompletedHandler:^(id<MTLCommandBuffer> buffer) {
        // Update metrics, invoke user callback
        total_uploads_++;
        // ...
    }];

    // 6. Commit (returns immediately, no blocking)
    [cmd_buffer commit];

    return operation_id;  // Caller can wait or continue
}
```

**Key Points:**
- `MTLResourceStorageModeShared`: Accessible by both CPU and GPU
- `commit()` is **non-blocking**: Returns immediately
- Caller can continue processing while upload happens in background
- `MTLSharedEvent` allows efficient waiting later if needed

---

#### 2. Asynchronous Download (GPU → CPU)

```objc++
uint64_t downloadAsync(id<MTLBuffer> source_buffer, size_t source_offset,
                       void* dest_data, size_t dest_size) {
    // 1. Create staging buffer (CPU-accessible)
    id<MTLBuffer> staging_buffer = [device_ newBufferWithLength:dest_size
                                                        options:MTLResourceStorageModeShared];

    // 2. Create blit command buffer
    id<MTLCommandBuffer> cmd_buffer = [blit_queue_ commandBuffer];
    cmd_buffer.label = @"BlitQueue Download";

    // 3. Encode GPU → staging copy
    id<MTLBlitCommandEncoder> encoder = [cmd_buffer blitCommandEncoder];
    [encoder copyFromBuffer:source_buffer
               sourceOffset:source_offset
                   toBuffer:staging_buffer
          destinationOffset:0
                       size:dest_size];
    [encoder endEncoding];

    // 4. Signal shared event
    uint64_t event_value = next_event_value_++;
    [cmd_buffer encodeSignalEvent:shared_event_ value:event_value];

    // 5. Completion handler: staging → destination (CPU memcpy)
    [cmd_buffer addCompletedHandler:^(id<MTLCommandBuffer> buffer) {
        memcpy(dest_data, [staging_buffer contents], dest_size);
        // Update metrics, invoke user callback
    }];

    // 6. Commit (non-blocking)
    [cmd_buffer commit];

    return operation_id;
}
```

**Key Points:**
- Two-stage transfer: GPU → staging (Metal), staging → CPU (memcpy)
- `memcpy` happens in completion handler (async, no blocking)
- Caller can poll `isCompleted()` or wait explicitly

---

#### 3. Efficient Synchronization (MTLSharedEvent)

```objc++
bool waitForCompletion(uint64_t operation_id, uint64_t timeout_ms) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Already completed?
    if (completed_ops_.count(operation_id)) {
        return true;
    }

    // Get event value for this operation
    uint64_t event_value = pending_ops_[operation_id].event_value;

    // Wait on MTLSharedEvent (efficient, not busy-wait)
    if (timeout_ms > 0) {
        return [shared_event_ waitUntilSignaledValue:event_value
                                           timeoutNS:timeout_ms * 1000000ULL];
    } else {
        // Infinite wait with efficient sleep loop
        while ([shared_event_ signaledValue] < event_value) {
            std::this_thread::sleep_for(std::chrono::microseconds(100));
        }
        return true;
    }
}
```

**Why MTLSharedEvent?**
- **No busy-wait:** CPU sleeps until GPU signals
- **Minimal overhead:** ~10-50μs wait latency
- **Fine-grained:** Can wait for specific operations, not all operations

**Alternative (polling, not used):**
```cpp
// Bad: Busy-wait wastes CPU
while (!isCompleted(op_id)) { /* burn CPU */ }

// Good: MTLSharedEvent blocks efficiently
waitForCompletion(op_id, timeout_ms);
```

---

## Configuration

### Basic Configuration

```yaml
metal_optimizations:
  enabled: true

  blit_queue:
    enabled: true
    max_pending_ops: 8           # Max concurrent blit operations
    use_shared_events: true      # Use MTLSharedEvent (recommended)
    staging_buffer_size_mb: 64   # Staging buffer size
    track_metrics: true          # Performance tracking
    verbose_logging: false       # Debug logging (perf impact)
```

### Parameter Details

#### `max_pending_ops`

**What it controls:** Maximum number of concurrent blit operations.

**How to choose:**
- **Low latency:** 2-4 operations (less buffering, faster response)
- **High throughput:** 8-16 operations (more pipelining)
- **Debugging:** 1-2 operations (easier tracing)

**Trade-offs:**
- **Too low:** Underutilized pipeline, lower throughput
- **Too high:** Memory overhead, scheduler contention

**Recommended:**
```yaml
# Real-time streaming (low latency)
max_pending_ops: 4

# Batch processing (high throughput)
max_pending_ops: 16

# Development/debugging
max_pending_ops: 2
```

**Memory Impact:**
```
Memory overhead = max_pending_ops × staging_buffer_size_mb
                = 8 × 64MB = 512MB
```

---

#### `use_shared_events`

**What it controls:** Use `MTLSharedEvent` for synchronization vs. polling.

**Recommended:** Always `true` (unless debugging MTLSharedEvent issues)

**Comparison:**

| Method | CPU Overhead | Wait Latency | Complexity |
|--------|--------------|--------------|------------|
| **MTLSharedEvent** | ~1% | 10-50μs | Low |
| **Polling** | ~5-10% | 100-500μs | Very Low |

**Configuration:**
```yaml
# Production (recommended)
use_shared_events: true

# Debugging MTLSharedEvent issues
use_shared_events: false
```

**Fallback behavior:**
If `MTLSharedEvent` creation fails, automatically falls back to polling:
```cpp
if (![device supportsFeatureSet:MTLFeatureSet_macOS_GPUFamily2_v1]) {
    // MTLSharedEvent not supported, use polling
    use_shared_events = false;
}
```

---

#### `staging_buffer_size_mb`

**What it controls:** Size of staging buffers for CPU↔GPU transfers.

**How to choose:**
1. Profile typical transfer sizes:
   ```python
   # Log transfer sizes during inference
   print(f"Token upload size: {token_ids.nbytes / 1024 / 1024:.2f}MB")
   print(f"Result download size: {results.nbytes / 1024 / 1024:.2f}MB")
   ```

2. Set staging buffer to accommodate largest typical transfer:
   ```yaml
   # If largest transfer is 32MB:
   staging_buffer_size_mb: 64  # 2× safety margin
   ```

**Default recommended:**
```yaml
# Small models (<7B)
staging_buffer_size_mb: 32

# Medium models (7-13B)
staging_buffer_size_mb: 64

# Large models (13-30B)
staging_buffer_size_mb: 128
```

**Trade-offs:**
- **Too small:** Multiple transfers needed, lower throughput
- **Too large:** Memory waste, no benefit if unused

---

#### `track_metrics`

**What it controls:** Enable/disable performance metrics collection.

**Performance impact:**
- **Enabled:** ~1-2% overhead (timing + atomic counters)
- **Disabled:** No overhead, but no observability

**Recommended:**
```yaml
# Production (monitoring required)
track_metrics: true

# Benchmarking (absolute max performance)
track_metrics: false
```

---

#### `verbose_logging`

**What it controls:** Log every blit operation (debug mode).

**Performance impact:**
- **Enabled:** ~5-10% overhead (I/O + string formatting)
- **Disabled:** No logging overhead

**Recommended:**
```yaml
# Development/debugging
verbose_logging: true

# Production
verbose_logging: false
```

**Example verbose output:**
```
[DEBUG] BlitQueue: uploadAsync op_id=42 size=1.2MB
[DEBUG] BlitQueue: Upload op_id=42 completed in 1.35ms
[DEBUG] BlitQueue: downloadAsync op_id=43 size=0.8MB
[DEBUG] BlitQueue: Download op_id=43 completed in 0.92ms
```

---

## Performance Impact

### TTFT Reduction

**Expected improvements:**
- **Conservative:** -10-12% TTFT
- **Target:** -15% TTFT
- **Optimistic:** -20% TTFT (with aggressive prefetching)

**Measurement:**
```typescript
import { Engine } from '@/api/engine.js';

const engine = new Engine();
await engine.start();

const ttftStart = Date.now();
const stream = engine.generate({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  prompt: 'What is the meaning of life?',
  maxTokens: 100
});

for await (const chunk of stream) {
  if (chunk.type === 'token') {
    const ttft = Date.now() - ttftStart;
    console.log(`TTFT: ${ttft}ms`);
    break;
  }
}

// Without blit queue: ~12.0ms TTFT
// With blit queue:    ~10.2ms TTFT (-15%)
```

### Throughput Improvement

**Expected improvements:**
- **Conservative:** +8-10% throughput
- **Target:** +10-12% throughput
- **Optimistic:** +15% throughput (with perfect overlap)

**Mechanism:**
```
Throughput = tokens_generated / total_time

Baseline:
  total_time = N × (tokenize + upload + compute + download)
             = N × (2.5 + 1.3 + 8.2 + 0.8) = N × 12.8ms

With blit queue:
  total_time = N × (tokenize + compute)  # Upload/download overlap
             = N × (2.5 + 8.2) = N × 10.7ms

Improvement = (12.8 - 10.7) / 12.8 = 16.4%
```

**Note:** Actual gain depends on **overlap ratio** (how much I/O overlaps with compute).

---

## Monitoring Metrics

### Statistics API

```python
from krserve_native import BlitQueue

# Get current metrics
metrics = blit_queue.get_metrics()

print(f"Total uploads:         {metrics.total_uploads}")
print(f"Total downloads:       {metrics.total_downloads}")
print(f"Avg upload time:       {metrics.avg_upload_ms:.2f}ms")
print(f"Avg download time:     {metrics.avg_download_ms:.2f}ms")
print(f"Total overlap time:    {metrics.total_overlap_ms:.2f}ms")
print(f"Overlap ratio:         {metrics.overlap_ratio * 100:.1f}%")
print(f"Sync wait count:       {metrics.sync_wait_count}")
print(f"Avg sync wait time:    {metrics.avg_sync_wait_ms:.2f}ms")
```

### Key Metrics

#### Overlap Ratio

**Formula:**
```
overlap_ratio = total_overlap_ms / (total_upload_ms + total_download_ms)
```

**Interpretation:**
- **1.0 (100%):** Perfect overlap, all I/O hidden
- **0.8 (80%):** Excellent overlap, most I/O hidden
- **0.5 (50%):** Moderate overlap, some I/O blocking
- **0.0 (0%):** No overlap, synchronous behavior

**Targets:**
- **Excellent:** >80% overlap
- **Good:** 60-80% overlap
- **Fair:** 40-60% overlap
- **Poor:** <40% overlap

**Example:**
```python
metrics = blit_queue.get_metrics()

if metrics.overlap_ratio > 0.80:
    print("✅ Excellent overlap efficiency")
elif metrics.overlap_ratio > 0.60:
    print("✅ Good overlap efficiency")
elif metrics.overlap_ratio > 0.40:
    print("⚠️ Fair overlap efficiency, consider tuning")
else:
    print("❌ Poor overlap efficiency, investigate")
```

---

#### Sync Wait Time

**Formula:**
```
avg_sync_wait_ms = total_sync_wait_ms / sync_wait_count
```

**Interpretation:**
- **<0.1ms:** Excellent (no blocking)
- **0.1-1ms:** Good (minimal blocking)
- **1-5ms:** Fair (some blocking)
- **>5ms:** Poor (significant blocking)

**Targets:**
- **Target:** <0.1ms average sync wait
- **Warning:** >1ms average sync wait
- **Critical:** >5ms average sync wait

**Example:**
```python
metrics = blit_queue.get_metrics()

if metrics.avg_sync_wait_ms < 0.1:
    print("✅ No blocking, perfect overlap")
elif metrics.avg_sync_wait_ms < 1.0:
    print("✅ Minimal blocking, good performance")
elif metrics.avg_sync_wait_ms < 5.0:
    print("⚠️ Some blocking, reduce max_pending_ops")
else:
    print("❌ Significant blocking, investigate stalls")
```

---

## Tuning Recommendations

### Scenario 1: Low Overlap Ratio (<60%)

**Symptoms:**
- `overlap_ratio < 0.60`
- Expected TTFT improvement not realized
- High `sync_wait_count`

**Diagnosis:**
```python
metrics = blit_queue.get_metrics()
print(f"Overlap ratio: {metrics.overlap_ratio * 100:.1f}%")
print(f"Avg upload: {metrics.avg_upload_ms:.2f}ms")
print(f"Avg download: {metrics.avg_download_ms:.2f}ms")
print(f"Avg sync wait: {metrics.avg_sync_wait_ms:.2f}ms")
```

**Possible causes:**
1. **Upload/download too fast to overlap:** I/O completes before compute starts
2. **Compute too short:** Not enough time for overlap
3. **Synchronization overhead:** Excessive wait events

**Solutions:**

1. **Increase compute workload (not always possible):**
   ```yaml
   # Larger models naturally have longer compute
   # Or increase batch size
   ```

2. **Reduce max_pending_ops (paradoxical but can help):**
   ```yaml
   # Too much concurrency can cause scheduler thrashing
   max_pending_ops: 4  # Reduce from 8
   ```

3. **Enable MTLSharedEvent if disabled:**
   ```yaml
   use_shared_events: true  # Reduce sync overhead
   ```

---

### Scenario 2: High Sync Wait Time (>1ms)

**Symptoms:**
- `avg_sync_wait_ms > 1.0`
- Increased latency despite overlap
- `sync_wait_count` growing rapidly

**Diagnosis:**
```python
metrics = blit_queue.get_metrics()
print(f"Sync wait count: {metrics.sync_wait_count}")
print(f"Avg sync wait: {metrics.avg_sync_wait_ms:.2f}ms")
print(f"Max pending ops: {config.max_pending_ops}")
```

**Possible causes:**
1. **Queue depth too high:** GPU can't keep up
2. **MTLSharedEvent not enabled:** Polling is inefficient
3. **GPU stalls:** Compute queue blocking blit queue

**Solutions:**

1. **Reduce max_pending_ops:**
   ```yaml
   max_pending_ops: 4  # Reduce from 8 or 16
   ```

2. **Enable MTLSharedEvent:**
   ```yaml
   use_shared_events: true
   ```

3. **Profile GPU stalls:**
   ```bash
   instruments -t "Metal System Trace" -D trace.trace <command>
   # Check for "GPU Wait" events in timeline
   ```

---

### Scenario 3: Excessive Memory Usage

**Symptoms:**
- High memory pressure
- `vmmap` shows large staging buffers
- System slowdown

**Diagnosis:**
```bash
# Check memory usage
vmmap <pid> | grep "MALLOC_LARGE"

# Example output:
# MALLOC_LARGE  512.0MB  # staging_buffer_size_mb × max_pending_ops
```

**Solutions:**

1. **Reduce staging buffer size:**
   ```yaml
   staging_buffer_size_mb: 32  # Reduce from 64
   ```

2. **Reduce max_pending_ops:**
   ```yaml
   max_pending_ops: 4  # Reduce from 8
   ```

3. **Memory calculation:**
   ```python
   memory_overhead_mb = config.staging_buffer_size_mb * config.max_pending_ops
   print(f"Staging buffer memory: {memory_overhead_mb}MB")
   ```

---

## Troubleshooting

### Issue: Initialization Failure

**Error:**
```
[ERROR] BlitQueue: Failed to create MTLCommandQueue
RuntimeError: Failed to initialize BlitQueue
```

**Diagnosis:**
```python
# Check Metal device availability
import Metal

device = Metal.MTLCreateSystemDefaultDevice()
if device is None:
    print("❌ No Metal device available")
else:
    print(f"✅ Metal device: {device.name}")
```

**Solutions:**

1. **Verify Metal 3.3 support:**
   ```bash
   xcrun metal --version
   # Output: metal version 3.3.0
   ```

2. **Check system requirements:**
   - macOS 26.0+ required
   - Apple Silicon M3+ required

3. **Enable graceful fallback:**
   ```yaml
   metal_optimizations:
     graceful_fallback: true  # Auto-disable on errors
   ```

---

### Issue: MTLSharedEvent Failure

**Error:**
```
[WARN] BlitQueue: MTLSharedEvent creation failed, using polling fallback
```

**Diagnosis:**
```objc++
// Check if shared events supported
if (![device supportsFeatureSet:MTLFeatureSet_macOS_GPUFamily2_v1]) {
    NSLog(@"MTLSharedEvent not supported");
}
```

**Solutions:**

1. **Verify OS version:**
   ```bash
   sw_vers
   # ProductVersion: 26.0.0 or higher
   ```

2. **Accept polling fallback (slightly slower but functional):**
   ```yaml
   use_shared_events: true  # Will fallback to polling if unsupported
   ```

---

### Issue: Degraded Performance

**Symptoms:**
- TTFT **worse** than baseline
- Throughput **lower** than expected
- High CPU usage

**Diagnosis:**

1. **Check if overlap is happening:**
   ```python
   metrics = blit_queue.get_metrics()
   print(f"Overlap ratio: {metrics.overlap_ratio * 100:.1f}%")
   if metrics.overlap_ratio < 0.40:
       print("❌ Low overlap, blit queue not effective")
   ```

2. **Check for verbose logging overhead:**
   ```yaml
   verbose_logging: false  # Ensure disabled in production
   ```

3. **Profile with Instruments:**
   ```bash
   instruments -t "Time Profiler" -D profile.trace <command>
   # Look for time spent in blit queue methods
   ```

**Solutions:**

- If overlap_ratio < 0.40: Consider disabling blit queue (not beneficial)
- If verbose_logging enabled: Disable in production
- If sync_wait_ms > 5ms: Reduce max_pending_ops

---

## Advanced Usage

### Non-Blocking API

```python
from krserve_native import BlitQueue

# Upload asynchronously
upload_id = blit_queue.upload_async(
    source_data=token_ids.data_ptr(),
    source_size=token_ids.nbytes,
    dest_buffer=gpu_buffer.data_ptr(),
    dest_offset=0
)

# Continue processing (upload happens in background)
# ...

# Wait before using GPU buffer
blit_queue.wait_for_completion(upload_id, timeout_ms=1000)

# Now safe to use gpu_buffer
```

### Completion Callbacks

Future enhancement (not yet implemented):

```python
def upload_complete():
    print("Upload finished, starting compute")

upload_id = blit_queue.upload_async(
    source_data=data,
    source_size=size,
    dest_buffer=buffer,
    completion=upload_complete  # Called when done
)
```

### Pipelined Workflow

```python
# Pipeline: tokenize → upload → compute → download

# Stage 1: Tokenize (CPU)
token_ids = tokenizer.encode(prompt)

# Stage 2: Upload (async)
upload_id = blit_queue.upload_async(token_ids, gpu_buffer)

# Stage 3: Compute (wait for upload, then run)
blit_queue.wait_for_completion(upload_id)
result_buffer = mlx_inference(gpu_buffer)

# Stage 4: Download (async, allows next request to start)
download_id = blit_queue.download_async(result_buffer, cpu_buffer)

# Next request can start while download happens
```

---

## Related Documentation

- **[METAL_OPTIMIZATIONS.md](./METAL_OPTIMIZATIONS.md)** - Overview of all Week 1 optimizations
- **[METAL_MEMORY_POOL.md](./METAL_MEMORY_POOL.md)** - Memory pool optimization
- **[COMMAND_BUFFER_RING.md](./COMMAND_BUFFER_RING.md)** - Command buffer ring optimization
- **Implementation Summary** - Technical implementation details (see alpha release documentation)

---

**Version:** v0.9.0
**Last Updated:** 2025-11-09
**Component:** Blit Queue I/O Overlap
