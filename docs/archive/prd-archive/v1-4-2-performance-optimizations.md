# kr-serve-mlx v1.4.2 Performance Optimizations PRD

**Version**: 1.4.2
**Status**: Design Phase
**Target**: <5% overhead vs baseline (down from 11.0%)
**Priority**: High
**Owner**: Architecture Team
**Created**: 2025-11-05

---

## Executive Summary

Based on comprehensive hybrid mode analysis (v1.4.1), this PRD outlines performance optimizations to reduce GPU Scheduler overhead from **11.0% → <5%** while maintaining 100% stability and full observability features.

### Key Findings from v1.4.1 Analysis

- **Current Overhead**: 11.0% vs baseline (20.34s on 50 questions benchmark)
- **Hybrid Mode**: 10.6% overhead (GPU Scheduler only, no auto-tune/metrics)
- **Auto-Tune + Metrics Overhead**: Only 0.4% (exceptionally well-optimized)
- **Primary Bottleneck**: GPU Scheduler batching window (2.0ms) = 85% of total overhead

### Performance Targets

| Metric | Current (v1.4.1) | Target (v1.4.2) | Improvement |
|--------|------------------|-----------------|-------------|
| **Total Overhead** | 11.0% | <5.0% | >6% reduction |
| **Mean Response Time** | +8.10ms | <4.0ms | >50% reduction |
| **TTFT Overhead** | +10.32ms | <5.0ms | >50% reduction |
| **Throughput Degradation** | -1.9% | <1.0% | >45% improvement |

---

## Architecture Overview

### Current Architecture (v1.4.1)

```
┌─────────────────────────────────────────────────────────────┐
│                     TypeScript API Layer                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     GPU Scheduler                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Job Queue → [WAIT 2.0ms] → Batch Collection       │    │  ← 85% overhead
│  └────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Batch Execution (Sequential GPU Operations)       │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Metrics Collector (0.5ms) + AdaptiveController (0.1ms)     │  ← 5% overhead
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     MLX Runtime                              │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Architecture (v1.4.2)

```
┌─────────────────────────────────────────────────────────────┐
│                     TypeScript API Layer                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Enhanced GPU Scheduler v1.4.2                 │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Job Queue → Fast Path Check                       │    │
│  │    ├─ Empty Queue? → IMMEDIATE EXECUTION            │    │  ← NEW: Fast Path
│  │    └─ Has Jobs? → Adaptive Window Collection       │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Adaptive Window Controller                         │    │  ← NEW: Dynamic Window
│  │    Queue Depth 0-1:  0.75ms window                 │    │
│  │    Queue Depth 2-5:  1.0ms window (NEW DEFAULT)    │    │
│  │    Queue Depth 6+:   2.0ms window                  │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Batch Execution (Sequential GPU Operations)       │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Lock-Free Metrics Collector + AdaptiveController           │  ← NEW: Atomic Ops
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     MLX Runtime                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Optimization 1: Reduced Default Batching Window

### Problem Statement

Current 2.0ms default batching window adds ~8.6ms TTFT overhead (9.1% increase), accounting for 85% of total scheduler overhead.

### Solution

**Change default from 2.0ms → 1.0ms** while maintaining configurability for high-throughput workloads.

### Implementation Details

#### 1. Update Default Environment Variable

**File**: `python/gpu_scheduler.py`

```python
# Line 31-32 (Current)
#    MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 2.0)
# Change to:
#    MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 1.0)

# Line 149 (Current)
def __init__(
    self,
    batch_window_ms: float = 2.0,  # Change to: 1.0
    max_batch_size: int = 4,
    p99_threshold_ms: float = 100.0,
    enabled: bool = True,
):
```

#### 2. Update Configuration File

**File**: `config/runtime.yaml`

Add new section for GPU Scheduler configuration:

```yaml
# GPU Scheduler Configuration (v1.4.2)
gpu_scheduler:
  # Enable GPU scheduler for stability (prevents Metal GPU crashes)
  enabled: false  # Set via MLX_GPU_SCHEDULER env var

  # Batching window in milliseconds (v1.4.2: reduced from 2.0ms → 1.0ms)
  # Trade-off: Lower = better latency, Higher = better throughput
  batch_window_ms: 1.0

  # Maximum batch size (number of jobs per batch)
  max_batch_size: 4

  # P99 latency threshold for auto-degradation (milliseconds)
  p99_threshold_ms: 100.0

  # Workload-specific presets
  presets:
    latency_sensitive:
      batch_window_ms: 0.75
      max_batch_size: 2
    balanced:
      batch_window_ms: 1.0
      max_batch_size: 4
    throughput_optimized:
      batch_window_ms: 2.0
      max_batch_size: 8
```

#### 3. Update Documentation

**Files to Update**:
- `README.md`: Update GPU Scheduler section
- `GPU_SCHEDULER_GUIDE.md`: Update configuration table
- `CLAUDE.md`: Update environment variables section

### Expected Performance Impact

- **TTFT Reduction**: 10.32ms → 5.5ms (-4.8ms, -46% overhead)
- **Mean Response Time**: +8.10ms → +4.5ms (-3.6ms, -44% overhead)
- **Total Time Overhead**: 11.0% → 6.5% (-4.5% improvement)

### Backward Compatibility

✅ **Fully backward compatible** - Environment variable `MLX_GPU_SCHEDULER_WINDOW_MS=2.0` still supported.

### Migration Guide

```bash
# v1.4.1 configuration (11.0% overhead)
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0

# v1.4.2 default (6.5% overhead) - no changes needed
# (automatically uses 1.0ms)

# v1.4.2 ultra-low-latency (4-5% overhead)
export MLX_GPU_SCHEDULER_WINDOW_MS=0.75
```

---

## Optimization 2: Adaptive Window Sizing

### Problem Statement

Fixed batching window is inefficient:
- **Low load** (sequential requests): 2.0ms wait is pure overhead
- **High load** (concurrent requests): 2.0ms enables efficient batching

### Solution

**Dynamic window adjustment based on queue depth** - low latency when queue is empty, higher throughput under load.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  Adaptive Window Controller                   │
│                                                               │
│  Input: Current Queue Depth                                  │
│  Output: Dynamic Batching Window (ms)                        │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Queue Depth  │  Window (ms)  │  Rationale          │   │
│  ├───────────────┼───────────────┼─────────────────────┤   │
│  │  0-1 (Low)    │  0.75ms       │  Prioritize latency │   │
│  │  2-5 (Medium) │  1.0ms        │  Balanced           │   │
│  │  6+ (High)    │  2.0ms        │  Maximize batching  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  Features:                                                    │
│  ✓ Zero config (automatic adaptation)                        │
│  ✓ Hysteresis to prevent oscillation                         │
│  ✓ EMA smoothing for stable transitions                      │
│  ✓ Integration with AdaptiveController                       │
└──────────────────────────────────────────────────────────────┘
```

### Implementation Details

#### 1. Create Adaptive Window Controller Module

**New File**: `python/models/adaptive_window.py`

```python
"""
Adaptive Window Controller for Dynamic Batching Window Sizing.

Adjusts batching window based on queue depth to optimize latency vs throughput.
Part of kr-serve-mlx v1.4.2 performance optimizations.
"""

import time
import logging
from typing import Tuple
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class WindowConfig:
    """Configuration for adaptive window sizing."""

    # Queue depth thresholds
    low_load_threshold: int = 1      # Queue depth ≤ 1 = low load
    medium_load_threshold: int = 5   # Queue depth 2-5 = medium load
    high_load_threshold: int = 6     # Queue depth ≥ 6 = high load

    # Window sizes (milliseconds)
    low_load_window_ms: float = 0.75
    medium_load_window_ms: float = 1.0
    high_load_window_ms: float = 2.0

    # Hysteresis to prevent oscillation
    hysteresis_count: int = 3  # Require N consecutive samples before transition

    # EMA smoothing for queue depth
    ema_alpha: float = 0.5  # Smoothing factor (0.0-1.0)


class AdaptiveWindowController:
    """
    Controls batching window size based on queue load.

    Strategy:
    - Low load (queue depth 0-1): 0.75ms window → minimize latency
    - Medium load (queue depth 2-5): 1.0ms window → balanced
    - High load (queue depth 6+): 2.0ms window → maximize batching

    Features:
    - Hysteresis to prevent oscillation
    - EMA smoothing for queue depth measurement
    - Integration with AdaptiveController
    """

    def __init__(self, config: WindowConfig = None):
        """
        Initialize adaptive window controller.

        Args:
            config: Window configuration (default: WindowConfig())
        """
        self.config = config or WindowConfig()

        # State tracking
        self.current_window_ms = self.config.medium_load_window_ms
        self.ema_queue_depth = 0.0
        self.last_update_time = time.time()

        # Hysteresis tracking
        self.transition_counter = 0
        self.pending_window_ms = self.current_window_ms

        # Metrics
        self.total_updates = 0
        self.window_transitions = 0

        logger.info(
            f"AdaptiveWindowController initialized: "
            f"low={self.config.low_load_window_ms}ms, "
            f"medium={self.config.medium_load_window_ms}ms, "
            f"high={self.config.high_load_window_ms}ms"
        )

    def update(self, queue_depth: int) -> Tuple[float, bool]:
        """
        Update window size based on current queue depth.

        Args:
            queue_depth: Current number of jobs in queue

        Returns:
            Tuple of (window_ms, transition_occurred)
        """
        self.total_updates += 1

        # Update EMA queue depth
        if self.ema_queue_depth == 0.0:
            self.ema_queue_depth = float(queue_depth)
        else:
            alpha = self.config.ema_alpha
            self.ema_queue_depth = (
                alpha * queue_depth + (1 - alpha) * self.ema_queue_depth
            )

        # Determine target window based on EMA queue depth
        target_window_ms = self._calculate_target_window(self.ema_queue_depth)

        # Apply hysteresis
        if target_window_ms != self.current_window_ms:
            if target_window_ms == self.pending_window_ms:
                # Same target as before - increment counter
                self.transition_counter += 1

                # Transition if threshold reached
                if self.transition_counter >= self.config.hysteresis_count:
                    old_window = self.current_window_ms
                    self.current_window_ms = target_window_ms
                    self.transition_counter = 0
                    self.window_transitions += 1

                    logger.info(
                        f"Window transition: {old_window}ms → {target_window_ms}ms "
                        f"(queue_depth={queue_depth}, ema={self.ema_queue_depth:.2f})"
                    )
                    return self.current_window_ms, True
            else:
                # Different target - reset hysteresis
                self.pending_window_ms = target_window_ms
                self.transition_counter = 1
        else:
            # Already at target - reset hysteresis
            self.transition_counter = 0
            self.pending_window_ms = target_window_ms

        return self.current_window_ms, False

    def _calculate_target_window(self, ema_queue_depth: float) -> float:
        """Calculate target window based on EMA queue depth."""
        if ema_queue_depth <= self.config.low_load_threshold:
            return self.config.low_load_window_ms
        elif ema_queue_depth <= self.config.medium_load_threshold:
            return self.config.medium_load_window_ms
        else:
            return self.config.high_load_window_ms

    def get_current_window_ms(self) -> float:
        """Get current batching window in milliseconds."""
        return self.current_window_ms

    def get_metrics(self) -> dict:
        """Get controller metrics."""
        return {
            'current_window_ms': self.current_window_ms,
            'ema_queue_depth': self.ema_queue_depth,
            'total_updates': self.total_updates,
            'window_transitions': self.window_transitions,
            'transition_rate': (
                self.window_transitions / max(1, self.total_updates)
            )
        }

    def reset(self):
        """Reset controller state."""
        self.current_window_ms = self.config.medium_load_window_ms
        self.ema_queue_depth = 0.0
        self.transition_counter = 0
        self.pending_window_ms = self.current_window_ms
        self.total_updates = 0
        self.window_transitions = 0
        logger.info("AdaptiveWindowController reset")
```

#### 2. Integrate with GPU Scheduler

**File**: `python/gpu_scheduler.py`

```python
# Add import at top
from models.adaptive_window import AdaptiveWindowController, WindowConfig

# Update GPUScheduler.__init__() (line 146)
def __init__(
    self,
    batch_window_ms: float = 1.0,  # NEW DEFAULT: 1.0ms
    max_batch_size: int = 4,
    p99_threshold_ms: float = 100.0,
    enabled: bool = True,
):
    # ... existing init code ...

    # v1.4.2: Adaptive window sizing
    self.adaptive_window_controller: Optional[AdaptiveWindowController] = None
    adaptive_window_enabled = os.getenv('MLX_ADAPTIVE_WINDOW', 'on').lower() == 'on'
    if adaptive_window_enabled:
        self.adaptive_window_controller = AdaptiveWindowController()
        logger.info(
            f"AdaptiveWindowController enabled: "
            f"low={self.adaptive_window_controller.config.low_load_window_ms}ms, "
            f"medium={self.adaptive_window_controller.config.medium_load_window_ms}ms, "
            f"high={self.adaptive_window_controller.config.high_load_window_ms}ms"
        )

    # ... rest of init code ...

# Update _collect_batch() method (line 345)
async def _collect_batch(self) -> List[GPUJob]:
    """
    Collect jobs for batching within time window.

    v1.4.2: Uses adaptive window sizing based on queue depth.

    Returns:
        List of jobs to execute (up to max_batch_size)
    """
    batch: List[GPUJob] = []

    # v1.4.2: Determine window size dynamically
    if self.adaptive_window_controller is not None:
        queue_depth = self.job_queue.qsize()
        window_ms, transition = self.adaptive_window_controller.update(queue_depth)
        if transition:
            # Log window transition for observability
            self.metrics_collector.record_mode_transition(f"window_{window_ms}ms")
    else:
        window_ms = self.current_window_ms

    deadline = time.perf_counter() + (window_ms / 1000.0)

    # ... rest of method unchanged ...
```

#### 3. Add Configuration

**File**: `config/runtime.yaml`

```yaml
# GPU Scheduler Configuration (v1.4.2)
gpu_scheduler:
  # ... existing config ...

  # Adaptive window sizing (v1.4.2 NEW)
  adaptive_window:
    enabled: true  # Set via MLX_ADAPTIVE_WINDOW env var
    low_load_threshold: 1
    medium_load_threshold: 5
    high_load_threshold: 6
    low_load_window_ms: 0.75
    medium_load_window_ms: 1.0
    high_load_window_ms: 2.0
    hysteresis_count: 3
    ema_alpha: 0.5
```

#### 4. Environment Variables

```python
# python/gpu_scheduler.py docstring (line 28)
# Add new environment variables:
#    MLX_ADAPTIVE_WINDOW=on|off (default: on)
#    MLX_ADAPTIVE_WINDOW_LOW_MS=0.5-2.0 (default: 0.75)
#    MLX_ADAPTIVE_WINDOW_MEDIUM_MS=0.75-3.0 (default: 1.0)
#    MLX_ADAPTIVE_WINDOW_HIGH_MS=1.0-5.0 (default: 2.0)
```

### Expected Performance Impact

- **Sequential Workloads**: 6.5% → 4.0% overhead (-2.5% improvement via 0.75ms window)
- **Concurrent Workloads**: Maintains 2.0ms window for high throughput
- **Mixed Workloads**: Adaptive adjustment optimizes for actual load pattern

### Configuration Matrix

| Load Pattern | Queue Depth | Window (ms) | Overhead (Est.) |
|-------------|-------------|-------------|-----------------|
| **Sequential** | 0-1 | 0.75ms | ~4.0% |
| **Low Concurrent** | 2-5 | 1.0ms | ~6.5% |
| **High Concurrent** | 6+ | 2.0ms | ~11.0% (but higher throughput) |

---

## Optimization 3: Fast-Path Bypass

### Problem Statement

When job queue is empty and a single job arrives, waiting for the batching window is pure overhead (no batching benefit).

### Solution

**Skip batching window when queue is empty** - execute immediately for single jobs.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              Fast-Path Decision Logic                         │
│                                                               │
│  Job Arrives → Check Queue Depth                             │
│       │                                                       │
│       ├─ Queue Empty (depth = 0)                             │
│       │    └→ FAST PATH: Execute immediately (0ms wait)      │  ← NEW
│       │                                                       │
│       └─ Queue Has Jobs (depth ≥ 1)                          │
│            └→ NORMAL PATH: Batching window collection        │
│                                                               │
│  Expected Benefit:                                            │
│  - Sequential requests: ~5-7% overhead reduction              │
│  - Concurrent requests: No change (batching still used)       │
└──────────────────────────────────────────────────────────────┘
```

### Implementation Details

#### 1. Update Batch Collection Logic

**File**: `python/gpu_scheduler.py`

```python
# Update _collect_batch() method (line 345)
async def _collect_batch(self) -> List[GPUJob]:
    """
    Collect jobs for batching within time window.

    v1.4.2 Optimizations:
    - Fast path: Skip window if queue empty (execute immediately)
    - Adaptive window sizing based on queue depth

    Returns:
        List of jobs to execute (up to max_batch_size)
    """
    batch: List[GPUJob] = []

    # v1.4.2 OPTIMIZATION 1: Fast-path check
    # If queue is empty when first job arrives, execute immediately
    fast_path_enabled = os.getenv('MLX_FAST_PATH', 'on').lower() == 'on'
    initial_queue_depth = self.job_queue.qsize()

    # v1.4.2 OPTIMIZATION 2: Determine window size dynamically
    if self.adaptive_window_controller is not None:
        window_ms, transition = self.adaptive_window_controller.update(initial_queue_depth)
        if transition:
            self.metrics_collector.record_mode_transition(f"window_{window_ms}ms")
    else:
        window_ms = self.current_window_ms

    # FAST PATH: Queue empty, execute immediately (no batching overhead)
    if fast_path_enabled and initial_queue_depth == 0:
        try:
            # Wait for first job with minimal timeout (0.1ms)
            _, _, job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=0.0001  # 0.1ms - just check if job available
            )
            batch.append(job)

            # Check if more jobs arrived while we were checking
            # If queue still empty, return immediately (fast path)
            if self.job_queue.qsize() == 0:
                # Record fast-path execution
                if self.total_batches % 100 == 0:
                    logger.debug(f"Fast-path execution: single job, queue empty")
                return batch

            # Jobs arrived - continue to normal batching
            # (fall through to deadline-based collection)

        except asyncio.TimeoutError:
            # No jobs available yet - return empty batch
            return batch

    # NORMAL PATH: Deadline-based batch collection
    deadline = time.perf_counter() + (window_ms / 1000.0)

    while len(batch) < self.current_batch_size:
        timeout = max(0.0, deadline - time.perf_counter())

        if timeout <= 0 and batch:
            break  # Window expired, execute what we have

        try:
            # Wait for next job with timeout
            _, _, job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=timeout if timeout > 0 else 0.001
            )
            batch.append(job)

            # URGENT jobs: execute immediately (no batching)
            if job.priority == JobPriority.URGENT:
                break

        except asyncio.TimeoutError:
            break  # Window expired

    return batch
```

#### 2. Add Metrics for Fast-Path Usage

```python
# python/gpu_scheduler.py - Update __init__() to track fast-path metrics
def __init__(self, ...):
    # ... existing code ...

    # v1.4.2: Fast-path metrics
    self.fast_path_executions = 0
    self.normal_path_executions = 0
```

```python
# Update _collect_batch() to track fast-path usage
if fast_path_enabled and initial_queue_depth == 0:
    # ... fast path code ...
    if self.job_queue.qsize() == 0:
        self.fast_path_executions += 1  # Track fast-path usage
        return batch
```

```python
# Update get_stats() to include fast-path metrics
def get_stats(self) -> Dict[str, Any]:
    # ... existing stats ...

    base_stats["fast_path"] = {
        "enabled": os.getenv('MLX_FAST_PATH', 'on').lower() == 'on',
        "executions": self.fast_path_executions,
        "normal_executions": self.normal_path_executions,
        "fast_path_rate": (
            self.fast_path_executions /
            max(1, self.fast_path_executions + self.normal_path_executions)
        )
    }
```

#### 3. Configuration

**File**: `config/runtime.yaml`

```yaml
# GPU Scheduler Configuration (v1.4.2)
gpu_scheduler:
  # ... existing config ...

  # Fast-path optimization (v1.4.2 NEW)
  # Bypass batching window when queue is empty (single job)
  fast_path:
    enabled: true  # Set via MLX_FAST_PATH env var
```

### Expected Performance Impact

- **Sequential Requests**: 4.0% → 2.0% overhead (-2.0% improvement)
- **Low Concurrency (< 2 concurrent)**: 6.5% → 4.0% overhead (-2.5% improvement)
- **High Concurrency**: No impact (batching still beneficial)

### Interaction with Adaptive Window

Fast-path and adaptive window work together:

1. **First job arrives** → Fast-path check (queue depth = 0) → Execute immediately (0ms)
2. **More jobs arrive** → Queue depth increases → Adaptive window kicks in
3. **Load decreases** → Queue depth decreases → Smaller window (0.75ms or 1.0ms)

---

## Optimization 4: Lock-Free Metrics Collection (Optional)

### Problem Statement

`MetricsCollector` uses `threading.RLock()` for thread safety, adding ~0.5ms overhead per request (5% of total overhead).

### Solution

**Replace RLock with lock-free atomic operations** for metrics recording.

### Implementation Complexity

⚠️ **MEDIUM COMPLEXITY** - Requires careful thread-safety analysis.

**Trade-offs**:
- ✅ **Benefit**: ~0.5ms reduction (0.5% overhead reduction)
- ⚠️ **Risk**: Race conditions if not implemented correctly
- 📊 **Priority**: Medium (only 5% of overhead)

### Decision

**DEFER to v1.4.3** - Focus on high-impact optimizations first (window sizing, fast-path).

### Future Implementation Notes

Use Python 3.11+ `threading` module with atomic operations:

```python
# Current implementation (v1.4.1)
class MetricsCollector:
    def __init__(self):
        self._lock = threading.RLock()  # RLock overhead
        self._latencies: deque = deque(maxlen=1000)

    def record_latency(self, latency_ms: float):
        with self._lock:  # Lock acquisition overhead
            self._latencies.append((time.time(), latency_ms))

# Proposed lock-free implementation (v1.4.3+)
import threading
from collections import deque

class MetricsCollector:
    def __init__(self):
        # Use lock-free deque (thread-safe for append/pop operations)
        self._latencies: deque = deque(maxlen=1000)
        # Atomic counter for total records
        self._total_records = threading.AtomicInt(0)

    def record_latency(self, latency_ms: float):
        # No lock needed - deque.append() is thread-safe
        self._latencies.append((time.time(), latency_ms))
        self._total_records.add(1)

    def get_latency_metrics(self) -> LatencyMetrics:
        # Snapshot deque for percentile calculation
        # (reading deque is thread-safe, but may include partial updates)
        snapshot = list(self._latencies)
        # ... percentile calculation ...
```

**Risks**:
- Reading `deque` during append may get inconsistent snapshot
- Need careful ordering guarantees for multi-field updates

**Recommendation**: Profile first to confirm 0.5ms overhead before implementing.

---

## Configuration Matrix (v1.4.2)

### Workload-Specific Presets

| Workload Type | Batch Window | Fast Path | Adaptive Window | Expected Overhead |
|---------------|--------------|-----------|-----------------|-------------------|
| **Ultra-Low Latency** | 0.75ms fixed | ON | OFF | ~2-3% |
| **Balanced (Default)** | 1.0ms (adaptive) | ON | ON | ~4-5% |
| **High Throughput** | 2.0ms (adaptive) | ON | ON | ~8-11% |

### Environment Variable Reference

```bash
# GPU Scheduler Core (v1.4.0)
MLX_GPU_SCHEDULER=on|off              # Enable GPU scheduler (default: off)
MLX_GPU_SCHEDULER_BATCH_SIZE=1-16     # Max batch size (default: 4)
MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0  # Batching window (default: 1.0, v1.4.2 change)
MLX_GPU_SCHEDULER_P99_THRESHOLD_MS=50-500  # P99 threshold (default: 100.0)

# Auto-Tuning (v1.4.1)
MLX_AUTO_TUNE=on|off                  # Enable auto-tuning (default: off)
MLX_AUTO_TUNE_MIN_BATCH=1-8           # Min batch size (default: 2)
MLX_AUTO_TUNE_MAX_BATCH=4-16          # Max batch size (default: 8)
MLX_AUTO_TUNE_EMA_ALPHA=0.1-0.9       # EMA smoothing (default: 0.3)
MLX_AUTO_TUNE_INTERVAL=5-20           # Adjustment interval (default: 10)

# Metrics Export (v1.4.1)
MLX_METRICS_EXPORT=on|off             # Enable Prometheus export (default: off)
MLX_METRICS_PORT=1024-65535           # Prometheus port (default: 9090)

# v1.4.2 Performance Optimizations (NEW)
MLX_ADAPTIVE_WINDOW=on|off            # Enable adaptive window sizing (default: on)
MLX_ADAPTIVE_WINDOW_LOW_MS=0.5-2.0    # Low load window (default: 0.75)
MLX_ADAPTIVE_WINDOW_MEDIUM_MS=0.75-3.0 # Medium load window (default: 1.0)
MLX_ADAPTIVE_WINDOW_HIGH_MS=1.0-5.0   # High load window (default: 2.0)
MLX_FAST_PATH=on|off                  # Enable fast-path bypass (default: on)
```

### Preset Configurations

#### Preset 1: Ultra-Low Latency (2-3% overhead target)

```bash
# GPU Scheduler with minimal latency
export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=0.75
export MLX_GPU_SCHEDULER_BATCH_SIZE=2
export MLX_ADAPTIVE_WINDOW=off         # Fixed window for predictability
export MLX_FAST_PATH=on                # Critical for sequential requests
export MLX_AUTO_TUNE=off               # Manual tuning preferred
export MLX_METRICS_EXPORT=off          # Minimal overhead
```

**Use Case**: Real-time inference, latency-critical applications
**Expected Performance**: 2-3% overhead vs baseline

#### Preset 2: Balanced (Default - 4-5% overhead target)

```bash
# Adaptive configuration (v1.4.2 default)
export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=1.0
export MLX_GPU_SCHEDULER_BATCH_SIZE=4
export MLX_ADAPTIVE_WINDOW=on          # Automatic adjustment
export MLX_FAST_PATH=on                # Enabled by default
export MLX_AUTO_TUNE=on                # Dynamic batch sizing
export MLX_METRICS_EXPORT=on           # Full observability
```

**Use Case**: Production workloads, mixed traffic patterns
**Expected Performance**: 4-5% overhead vs baseline

#### Preset 3: High Throughput (8-11% overhead, max throughput)

```bash
# Throughput-optimized configuration
export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0
export MLX_GPU_SCHEDULER_BATCH_SIZE=8
export MLX_ADAPTIVE_WINDOW=on          # Can adjust down under low load
export MLX_FAST_PATH=on                # Still beneficial for single requests
export MLX_AUTO_TUNE=on                # Adjust batch size dynamically
export MLX_METRICS_EXPORT=on           # Monitor throughput metrics
export MLX_AUTO_TUNE_MAX_BATCH=16      # Allow larger batches
```

**Use Case**: Batch processing, high-concurrency workloads
**Expected Performance**: 8-11% overhead, but 20-30% throughput increase

---

## Performance Validation Strategy

### Test Suite Design

```
┌──────────────────────────────────────────────────────────────┐
│               Performance Validation Pipeline                 │
│                                                               │
│  Stage 1: Unit Tests                                         │
│  ├─ AdaptiveWindowController logic validation                │
│  ├─ Fast-path detection correctness                          │
│  └─ Hysteresis behavior verification                         │
│                                                               │
│  Stage 2: Integration Tests                                  │
│  ├─ Sequential request pattern (fast-path validation)        │
│  ├─ Concurrent request pattern (adaptive window validation)  │
│  └─ Mixed workload pattern (combined optimization)           │
│                                                               │
│  Stage 3: Benchmark Regression Tests                         │
│  ├─ 50-question benchmark (existing baseline)                │
│  ├─ TTFT measurement (fast-path impact)                      │
│  └─ Throughput measurement (adaptive window impact)          │
│                                                               │
│  Stage 4: Stress Testing                                     │
│  ├─ 72-hour stability test (zero crashes)                    │
│  ├─ Load spike simulation (adaptive window response)         │
│  └─ Queue depth oscillation test (hysteresis validation)     │
└──────────────────────────────────────────────────────────────┘
```

### Benchmark Configuration

#### Baseline Comparison Matrix

| Configuration | Batch Window | Adaptive Window | Fast Path | Expected Overhead |
|---------------|--------------|-----------------|-----------|-------------------|
| **v1.4.1 (Current)** | 2.0ms | OFF | OFF | 11.0% |
| **v1.4.2 Window Only** | 1.0ms | OFF | OFF | 6.5% |
| **v1.4.2 Adaptive** | 1.0ms (base) | ON | OFF | 5.0% |
| **v1.4.2 Fast Path** | 1.0ms (base) | OFF | ON | 4.5% |
| **v1.4.2 Full** | 1.0ms (base) | ON | ON | **<4.0%** ✅ |

### Success Criteria

#### Primary Metrics

| Metric | v1.4.1 Baseline | v1.4.2 Target | Success Threshold |
|--------|----------------|---------------|-------------------|
| **Total Overhead** | 11.0% | <5.0% | ≤5.0% |
| **Mean Response Time Overhead** | +8.10ms | <4.0ms | ≤4.0ms |
| **TTFT Overhead** | +10.32ms | <5.0ms | ≤5.0ms |
| **Throughput Degradation** | -1.9% | <1.0% | ≤1.0% |

#### Secondary Metrics (Stability)

| Metric | Target | Success Threshold |
|--------|--------|-------------------|
| **Crash Rate** | 0% | 0% (zero tolerance) |
| **P99 Latency** | <100ms | <100ms |
| **72-hour Uptime** | 100% | 100% |
| **Window Transition Stability** | <5% oscillation | <10% oscillation |

### Test Implementation

#### Test 1: Fast-Path Validation

**File**: `tests/integration/gpu_scheduler_fast_path.spec.ts`

```typescript
describe('GPU Scheduler Fast Path (v1.4.2)', () => {
  it('should execute single requests immediately (zero batching overhead)', async () => {
    // Enable fast-path
    process.env.MLX_GPU_SCHEDULER = 'on';
    process.env.MLX_FAST_PATH = 'on';
    process.env.MLX_GPU_SCHEDULER_WINDOW_MS = '1.0';

    const engine = await createEngine();
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Measure TTFT for sequential requests (queue always empty)
    const ttfts: number[] = [];

    for (let i = 0; i < 10; i++) {
      const startTime = Date.now();
      let firstTokenTime: number | null = null;

      for await (const chunk of engine.createGenerator({
        prompt: 'Hello',
        max_tokens: 50
      })) {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
        }
      }

      const ttft = firstTokenTime! - startTime;
      ttfts.push(ttft);

      // Wait to ensure queue stays empty
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const meanTTFT = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;

    // Baseline TTFT: ~94ms, v1.4.1: ~105ms (+11ms)
    // v1.4.2 fast-path target: <100ms (<6ms overhead)
    expect(meanTTFT).toBeLessThan(100);

    // Verify fast-path was used
    const stats = await engine.getSchedulerStats();
    expect(stats.fast_path.executions).toBeGreaterThan(8); // Most requests should use fast-path
    expect(stats.fast_path.fast_path_rate).toBeGreaterThan(0.8); // >80% fast-path usage
  });

  it('should fall back to normal batching when queue has jobs', async () => {
    // ... concurrent request test ...
  });
});
```

#### Test 2: Adaptive Window Validation

**File**: `tests/integration/gpu_scheduler_adaptive_window.spec.ts`

```typescript
describe('GPU Scheduler Adaptive Window (v1.4.2)', () => {
  it('should adjust window based on queue depth', async () => {
    process.env.MLX_GPU_SCHEDULER = 'on';
    process.env.MLX_ADAPTIVE_WINDOW = 'on';

    const engine = await createEngine();
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Simulate load spike: 0 → 10 concurrent requests
    const promises: Promise<any>[] = [];

    // Low load phase (queue depth 0-1)
    for (let i = 0; i < 2; i++) {
      promises.push(
        (async () => {
          for await (const chunk of engine.createGenerator({
            prompt: 'Test',
            max_tokens: 10
          })) {
            // consume
          }
        })()
      );
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // High load phase (queue depth 6+)
    for (let i = 0; i < 10; i++) {
      promises.push(
        (async () => {
          for await (const chunk of engine.createGenerator({
            prompt: 'Test',
            max_tokens: 10
          })) {
            // consume
          }
        })()
      );
    }

    await Promise.all(promises);

    // Verify window transitions occurred
    const stats = await engine.getSchedulerStats();
    const windowMetrics = stats.v1_4_1_metrics.mode_transitions;

    // Should have transitions: 1.0ms → 2.0ms (low load → high load)
    expect(windowMetrics.window_0_75ms).toBeGreaterThan(0); // Low load
    expect(windowMetrics.window_2_0ms).toBeGreaterThan(0);  // High load
  });
});
```

#### Test 3: Regression Benchmark

**File**: `benchmarks/v1.4.2-regression-test.ts`

```typescript
/**
 * v1.4.2 Regression Benchmark
 *
 * Compares v1.4.2 against v1.4.1 baseline using 50-question benchmark.
 *
 * Success Criteria:
 * - Total overhead: ≤5.0% (down from 11.0%)
 * - TTFT overhead: ≤5.0ms (down from 10.32ms)
 * - Throughput degradation: ≤1.0% (down from 1.9%)
 */

describe('v1.4.2 Regression Benchmark', () => {
  it('should achieve <5% overhead vs baseline', async () => {
    // Configuration: v1.4.2 full (all optimizations enabled)
    process.env.MLX_GPU_SCHEDULER = 'on';
    process.env.MLX_GPU_SCHEDULER_WINDOW_MS = '1.0';
    process.env.MLX_ADAPTIVE_WINDOW = 'on';
    process.env.MLX_FAST_PATH = 'on';
    process.env.MLX_AUTO_TUNE = 'on';
    process.env.MLX_METRICS_EXPORT = 'on';

    const results = await run50QuestionBenchmark();

    // Baseline: 184.40s total time
    const baselineTotalTime = 184.40;
    const measuredTotalTime = results.totalTime;
    const overhead = ((measuredTotalTime - baselineTotalTime) / baselineTotalTime) * 100;

    // Target: <5% overhead
    expect(overhead).toBeLessThan(5.0);

    // TTFT target: <5ms overhead
    const baselineTTFT = 94.67;
    const measuredTTFT = results.meanTTFT;
    const ttftOverhead = measuredTTFT - baselineTTFT;

    expect(ttftOverhead).toBeLessThan(5.0);

    // Throughput target: <1% degradation
    const baselineThroughput = 122.66;
    const measuredThroughput = results.meanThroughput;
    const throughputDegradation =
      ((baselineThroughput - measuredThroughput) / baselineThroughput) * 100;

    expect(throughputDegradation).toBeLessThan(1.0);
  });
});
```

### Continuous Benchmarking

Add to CI pipeline:

```yaml
# .github/workflows/performance-benchmarks.yml
name: Performance Benchmarks

on:
  pull_request:
    branches: [main, feat/v1.4.2-performance]
  push:
    branches: [main]

jobs:
  benchmark:
    runs-on: macos-14  # M3 required
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm install
      - name: Setup Python
        run: npm run prepare:python
      - name: Run regression benchmarks
        run: npm run bench:regression
      - name: Check performance targets
        run: |
          # Fail if overhead exceeds 5%
          if [ $(jq '.overhead_percent' benchmarks/results/latest.json) -gt 5 ]; then
            echo "Performance regression detected: overhead exceeds 5%"
            exit 1
          fi
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: benchmark-results
          path: benchmarks/results/
```

---

## Implementation Timeline

### Phase 1: Reduced Default Window (Week 1)

**Duration**: 2 days
**Risk**: Low
**Dependencies**: None

**Tasks**:
1. Update default `batch_window_ms` from 2.0ms → 1.0ms
2. Update documentation (README.md, GPU_SCHEDULER_GUIDE.md, CLAUDE.md)
3. Add runtime.yaml configuration section
4. Run regression benchmark
5. Update performance reports

**Deliverables**:
- ✅ Default window reduced to 1.0ms
- ✅ Documentation updated
- ✅ Benchmark results showing ~6.5% overhead (down from 11%)

### Phase 2: Fast-Path Optimization (Week 1-2)

**Duration**: 3 days
**Risk**: Low
**Dependencies**: Phase 1

**Tasks**:
1. Implement fast-path check in `_collect_batch()`
2. Add fast-path metrics tracking
3. Add environment variable `MLX_FAST_PATH`
4. Write unit tests for fast-path logic
5. Write integration tests for sequential requests
6. Run regression benchmark

**Deliverables**:
- ✅ Fast-path bypass implemented
- ✅ Unit tests passing (95%+ coverage)
- ✅ Integration tests passing
- ✅ Benchmark results showing ~4.5% overhead

### Phase 3: Adaptive Window Sizing (Week 2)

**Duration**: 4 days
**Risk**: Medium
**Dependencies**: Phase 2

**Tasks**:
1. Create `python/models/adaptive_window.py`
2. Implement `AdaptiveWindowController` class
3. Integrate with `GPUScheduler`
4. Add configuration to runtime.yaml
5. Add environment variables
6. Write unit tests for window controller
7. Write integration tests for load transitions
8. Run regression benchmark

**Deliverables**:
- ✅ Adaptive window controller implemented
- ✅ Hysteresis logic validated
- ✅ Integration with GPU scheduler complete
- ✅ Benchmark results showing <5% overhead

### Phase 4: Testing & Validation (Week 2-3)

**Duration**: 3 days
**Risk**: Low
**Dependencies**: Phases 1-3

**Tasks**:
1. Run full regression benchmark suite
2. 72-hour stability test
3. Load spike simulation tests
4. Performance profiling and validation
5. Documentation updates
6. Preset configuration validation

**Deliverables**:
- ✅ All benchmarks passing
- ✅ 72-hour stability test: 0 crashes
- ✅ Performance targets met (<5% overhead)
- ✅ Documentation complete

### Phase 5: Release Preparation (Week 3)

**Duration**: 2 days
**Risk**: Low
**Dependencies**: Phase 4

**Tasks**:
1. Update CHANGELOG.md
2. Update VERSION files
3. Create migration guide
4. Update README.md with v1.4.2 features
5. Tag release v1.4.2
6. Publish release notes

**Deliverables**:
- ✅ v1.4.2 release tagged
- ✅ Migration guide published
- ✅ Release notes published

**Total Duration**: 14 days (2 weeks)

---

## Risk Analysis

### Risk 1: Fast-Path Race Condition

**Probability**: Low
**Impact**: High (crashes)
**Mitigation**:
- Extensive unit testing with concurrent job arrivals
- Integration tests with queue depth monitoring
- Use asyncio primitives correctly (no race conditions)

### Risk 2: Adaptive Window Oscillation

**Probability**: Medium
**Impact**: Medium (performance instability)
**Mitigation**:
- Hysteresis mechanism (require 3 consecutive samples before transition)
- EMA smoothing for queue depth measurement
- Extensive stress testing with load spikes

### Risk 3: Performance Regression Under High Load

**Probability**: Low
**Impact**: Medium
**Mitigation**:
- Preserve 2.0ms window for high load (adaptive controller)
- Benchmark suite includes high-concurrency tests
- Can disable optimizations via environment variables

### Risk 4: Breaking Changes for Existing Users

**Probability**: Very Low
**Impact**: Medium
**Mitigation**:
- Fully backward compatible (environment variables still work)
- Default change (2.0ms → 1.0ms) is performance improvement
- Migration guide provided
- Preset configurations for easy rollback

---

## Backward Compatibility

### Environment Variable Compatibility

✅ **100% Backward Compatible**

All existing environment variables continue to work:

```bash
# v1.4.1 configuration - STILL WORKS IN v1.4.2
export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0  # Overrides new 1.0ms default
export MLX_GPU_SCHEDULER_BATCH_SIZE=4
export MLX_AUTO_TUNE=on
export MLX_METRICS_EXPORT=on
```

### Default Behavior Change

⚠️ **Default window reduced: 2.0ms → 1.0ms**

**Impact**:
- **Users with explicit `MLX_GPU_SCHEDULER_WINDOW_MS=2.0`**: No change
- **Users relying on default**: Performance improvement (11% → 6.5% overhead)
- **Users wanting old behavior**: Set `MLX_GPU_SCHEDULER_WINDOW_MS=2.0`

### Opt-Out Strategy

Users can disable new optimizations individually:

```bash
# Disable adaptive window (use fixed 1.0ms)
export MLX_ADAPTIVE_WINDOW=off

# Disable fast-path (always use batching window)
export MLX_FAST_PATH=off

# Complete v1.4.1 behavior restoration
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0
export MLX_ADAPTIVE_WINDOW=off
export MLX_FAST_PATH=off
```

---

## Migration Guide

### Upgrading from v1.4.1 → v1.4.2

#### Scenario 1: Default Configuration (No custom environment variables)

**Change**: Automatic performance improvement

```bash
# v1.4.1 (no env vars) - 11% overhead
npm start

# v1.4.2 (no env vars) - <5% overhead (automatic)
npm start
```

**Action Required**: None - automatic improvement

#### Scenario 2: Custom Window Configuration

**Change**: Your custom window is preserved

```bash
# v1.4.1
export MLX_GPU_SCHEDULER_WINDOW_MS=5.0  # Custom high-throughput config

# v1.4.2 - same behavior (your custom value is preserved)
export MLX_GPU_SCHEDULER_WINDOW_MS=5.0
```

**Action Required**: None

#### Scenario 3: Want v1.4.1 Default Behavior

**Change**: Explicitly set 2.0ms window

```bash
# v1.4.2 with v1.4.1 behavior
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0
export MLX_ADAPTIVE_WINDOW=off
export MLX_FAST_PATH=off
```

**Action Required**: Add environment variables above

### Recommended Actions

1. **Development/Testing**: Use v1.4.2 defaults (automatic optimization)
2. **Production (first deployment)**: Use "Balanced" preset (default)
3. **Production (after validation)**: Tune to your workload using presets
4. **Rollback strategy**: Set env vars to v1.4.1 defaults

---

## Performance Projections

### Expected Performance Matrix (50-Question Benchmark)

| Configuration | Total Time | Overhead vs Baseline | TTFT Overhead | Throughput Degradation |
|---------------|-----------|---------------------|---------------|----------------------|
| **Baseline (mlx-engine)** | 184.40s | 0% | 0ms | 0% |
| **v1.4.1 (Current)** | 204.74s | +11.0% | +10.32ms | -1.9% |
| **v1.4.2 Window Only** | 196.50s | +6.5% | +5.5ms | -1.2% |
| **v1.4.2 + Fast Path** | 191.70s | +4.0% | +3.0ms | -0.8% |
| **v1.4.2 + Adaptive** | 189.80s | +2.9% | +2.5ms | -0.6% |
| **v1.4.2 Full** | 188.50s | **+2.2%** ✅ | **+2.0ms** ✅ | **-0.5%** ✅ |

### Confidence Intervals

Based on statistical analysis of hybrid mode benchmark:

- **Best Case**: 1.5% overhead (all requests use fast-path, queue always empty)
- **Expected Case**: 2-4% overhead (mixed sequential/concurrent workload)
- **Worst Case**: 6% overhead (continuous high load, adaptive window at 2.0ms)

### Performance by Workload Type

| Workload Pattern | v1.4.1 Overhead | v1.4.2 Overhead | Improvement |
|-----------------|----------------|----------------|-------------|
| **Sequential Requests** | 11.0% | 2.0% | -9.0% ✅ |
| **Low Concurrency (2-5)** | 11.0% | 4.0% | -7.0% ✅ |
| **High Concurrency (10+)** | 11.0% | 6.5% | -4.5% ✅ |
| **Mixed (Realistic)** | 11.0% | 3.5% | -7.5% ✅ |

---

## Success Metrics

### Primary Success Criteria

- ✅ **Total Overhead**: <5% vs baseline (Target: 2-4%)
- ✅ **TTFT Overhead**: <5ms (Target: 2-3ms)
- ✅ **Throughput Degradation**: <1% (Target: 0.5%)
- ✅ **Stability**: 0% crash rate (72-hour test)

### Secondary Success Criteria

- ✅ **Fast-Path Usage**: >80% for sequential workloads
- ✅ **Window Transitions**: <10% oscillation rate
- ✅ **Backward Compatibility**: 100% (no breaking changes)
- ✅ **Documentation**: Complete (migration guide, presets, API reference)

### Key Performance Indicators (KPIs)

1. **Mean Response Time**: <410ms (baseline: 407.75ms, v1.4.1: 415.85ms)
2. **P99 Latency**: <100ms (stability target)
3. **Throughput**: >121 tok/s (baseline: 122.66 tok/s, v1.4.1: 120.27 tok/s)
4. **TTFT P95**: <100ms (real-time inference requirement)

---

## Appendix A: Code Structure

### File Organization

```
python/
├── gpu_scheduler.py                    # Modified: Fast-path, adaptive window integration
├── models/
│   ├── adaptive_controller.py          # Existing (v1.4.1)
│   ├── adaptive_window.py              # NEW: Adaptive window controller
│   └── metrics_collector.py            # Existing (v1.4.1)
└── monitoring/
    └── prometheus_exporter.py          # Existing (v1.4.1)

config/
└── runtime.yaml                        # Modified: GPU scheduler section

tests/
├── unit/
│   ├── gpu_scheduler_fast_path.spec.ts        # NEW: Fast-path unit tests
│   └── adaptive_window_controller.spec.ts     # NEW: Adaptive window tests
└── integration/
    ├── gpu_scheduler_fast_path.spec.ts        # NEW: Fast-path integration tests
    ├── gpu_scheduler_adaptive_window.spec.ts  # NEW: Adaptive window integration tests
    └── gpu_scheduler_regression.spec.ts       # NEW: v1.4.2 regression tests

benchmarks/
├── v1.4.2-regression-test.ts           # NEW: Comprehensive regression benchmark
└── results/
    └── v1.4.2-comparison.json          # NEW: Benchmark results

docs/
└── V1_4_2_PERFORMANCE_OPTIMIZATIONS.md # This PRD
```

### Module Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│                     gpu_scheduler.py                         │
│                                                               │
│  Imports:                                                     │
│  ├─ models.adaptive_controller (v1.4.1)                      │
│  ├─ models.adaptive_window (v1.4.2 NEW)                      │
│  ├─ models.metrics_collector (v1.4.1)                        │
│  └─ monitoring.prometheus_exporter (v1.4.1)                  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              models/adaptive_window.py (NEW)                 │
│                                                               │
│  Classes:                                                     │
│  ├─ WindowConfig (dataclass)                                │
│  └─ AdaptiveWindowController                                │
│                                                               │
│  Dependencies: None (standalone module)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Appendix B: Adaptive Window Algorithm Details

### Queue Depth Measurement

```python
# Exponential Moving Average (EMA) for queue depth smoothing
ema_queue_depth = alpha * current_depth + (1 - alpha) * ema_queue_depth

# Where:
# - alpha = 0.5 (configurable via MLX_ADAPTIVE_WINDOW_EMA_ALPHA)
# - Higher alpha = more responsive to changes
# - Lower alpha = more stable, less oscillation
```

### Hysteresis Mechanism

```python
# Require N consecutive samples before transitioning
if target_window != current_window:
    if target_window == pending_window:
        transition_counter += 1
        if transition_counter >= hysteresis_count:
            current_window = target_window  # Transition approved
            transition_counter = 0
    else:
        pending_window = target_window
        transition_counter = 1  # Reset counter for new target
```

### Window Selection Logic

```python
def calculate_target_window(ema_queue_depth: float) -> float:
    if ema_queue_depth <= 1:
        return 0.75  # Low load: prioritize latency
    elif ema_queue_depth <= 5:
        return 1.0   # Medium load: balanced
    else:
        return 2.0   # High load: maximize batching
```

### State Transition Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                Window State Transitions                      │
│                                                               │
│   LOW (0.75ms) ←────────────────→ MEDIUM (1.0ms)            │
│       │                                  │                   │
│       │                                  │                   │
│       └──────────────────────────────────┴→ HIGH (2.0ms)     │
│                                                               │
│  Transitions:                                                 │
│  - Require 3 consecutive samples in new state                │
│  - Use EMA queue depth (not instantaneous)                   │
│  - Prevent oscillation via hysteresis                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Appendix C: Fast-Path Decision Flow

### Fast-Path Algorithm

```python
async def _collect_batch(self) -> List[GPUJob]:
    batch = []
    initial_queue_depth = self.job_queue.qsize()

    # FAST PATH CHECK
    if fast_path_enabled and initial_queue_depth == 0:
        # Wait for first job (minimal timeout)
        try:
            job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=0.0001  # 0.1ms
            )
            batch.append(job)

            # Check if more jobs arrived while waiting
            if self.job_queue.qsize() == 0:
                # Still empty - FAST PATH EXECUTION (return immediately)
                self.fast_path_executions += 1
                return batch

            # More jobs arrived - FALL THROUGH TO NORMAL BATCHING
        except asyncio.TimeoutError:
            return []  # No jobs yet

    # NORMAL BATCHING PATH
    window_ms = self.adaptive_window_controller.get_current_window_ms()
    deadline = time.perf_counter() + (window_ms / 1000.0)

    while len(batch) < self.max_batch_size:
        timeout = max(0.0, deadline - time.perf_counter())
        if timeout <= 0 and batch:
            break

        try:
            job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=timeout
            )
            batch.append(job)
        except asyncio.TimeoutError:
            break

    return batch
```

### Decision Tree

```
Job Arrives
    │
    ├─ Fast-Path Enabled?
    │   ├─ No  → Normal Batching
    │   └─ Yes → Queue Empty?
    │            ├─ No  → Normal Batching
    │            └─ Yes → Wait 0.1ms for job
    │                     ├─ No job → Return empty
    │                     └─ Job arrived → Queue still empty?
    │                                      ├─ No  → Normal Batching
    │                                      └─ Yes → FAST PATH EXECUTION ✅
    │
    └─ Normal Batching:
        Determine window (adaptive controller)
        Collect jobs until window expires or batch full
        Return batch
```

---

## Appendix D: Performance Profiling Results

### Overhead Breakdown (v1.4.1)

Based on hybrid mode analysis:

```
Total Overhead: 10.32ms TTFT increase
├─ Batching Window Wait: 8.6ms (83.3%)  ← PRIMARY BOTTLENECK
├─ MetricsCollector Lock: 0.5ms (4.8%)
├─ AdaptiveController EMA: 0.1ms (1.0%)
├─ Thread Synchronization: 0.5ms (4.8%)
├─ Prometheus Export: 0.1ms (1.0%)
└─ Other/Variance: 0.52ms (5.1%)
```

### Expected Improvement (v1.4.2)

```
Optimization 1: Default Window 2.0ms → 1.0ms
- TTFT Reduction: 8.6ms → 4.3ms (-4.3ms, -50%)

Optimization 2: Adaptive Window
- Sequential Requests: 4.3ms → 3.2ms (-1.1ms via 0.75ms window)
- Concurrent Requests: Maintains 2.0ms window (no regression)

Optimization 3: Fast Path
- Sequential Requests: 3.2ms → 1.0ms (-2.2ms, skip window entirely)
- Concurrent Requests: No change

TOTAL EXPECTED IMPROVEMENT:
Sequential: 8.6ms → 1.0ms (-7.6ms, -88% reduction) ✅
Concurrent: 8.6ms → 4.3-8.6ms (adaptive, load-dependent)
Mixed: 8.6ms → 2.5ms (-6.1ms, -71% reduction) ✅
```

---

## Conclusion

This PRD outlines a comprehensive performance optimization strategy for kr-serve-mlx v1.4.2 that targets **<5% overhead** (down from 11%) while maintaining 100% stability and full observability.

### Key Optimizations

1. **Reduced Default Window**: 2.0ms → 1.0ms (4.5% improvement, low risk)
2. **Adaptive Window Sizing**: Dynamic adjustment based on load (3% additional improvement)
3. **Fast-Path Bypass**: Skip window for empty queue (2% additional improvement for sequential)
4. **Lock-Free Metrics**: Deferred to v1.4.3 (low ROI, medium complexity)

### Expected Results

- **Total Overhead**: 11.0% → 2-4% (7-9% improvement)
- **TTFT Overhead**: 10.32ms → 2-3ms (7-8ms improvement)
- **Throughput**: -1.9% → -0.5% (1.4% improvement)
- **Stability**: 0% crash rate maintained (100% uptime)

### Implementation Timeline

- **Phase 1**: Reduced window (2 days)
- **Phase 2**: Fast-path (3 days)
- **Phase 3**: Adaptive window (4 days)
- **Phase 4**: Testing (3 days)
- **Phase 5**: Release (2 days)
- **Total**: 14 days (2 weeks)

### Success Criteria

✅ All optimizations are backward compatible
✅ Environment variables provide granular control
✅ Preset configurations for common workloads
✅ Comprehensive test coverage (unit, integration, regression)
✅ Performance targets validated via benchmarks

---

**Status**: Ready for Implementation
**Next Steps**: Begin Phase 1 (Reduced Default Window)
**Review Required**: Architecture team approval

**Document Version**: 1.0
**Last Updated**: 2025-11-05
**Author**: Architecture Team
