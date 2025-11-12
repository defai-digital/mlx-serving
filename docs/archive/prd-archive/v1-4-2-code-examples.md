# kr-serve-mlx v1.4.2 - Code Implementation Examples

**Supplement to**: v1-4-2-performance-optimizations.md
**Status**: Implementation Reference
**Created**: 2025-11-05

---

## Overview

This document provides complete, production-ready code examples for the three core optimizations in v1.4.2:

1. **Reduced Default Batching Window**
2. **Adaptive Window Sizing**
3. **Fast-Path Optimization**

All code is ready for direct implementation with minimal modifications.

---

## 1. Reduced Default Batching Window

### 1.1 GPU Scheduler Configuration Update

**File**: `python/gpu_scheduler.py`

```python
# Update docstring (lines 28-32)
"""
Environment Variables:
    MLX_GPU_SCHEDULER=on|off (default: off for safety)
    MLX_GPU_SCHEDULER_BATCH_SIZE=2-16 (default: 4)
    MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 1.0)  # ← CHANGED from 2.0
    MLX_GPU_SCHEDULER_P99_THRESHOLD_MS=50-500 (default: 100.0)

    # v1.4.1 Auto-tuning
    MLX_AUTO_TUNE=on|off (default: off)
    MLX_AUTO_TUNE_MIN_BATCH=1-8 (default: 2)
    MLX_AUTO_TUNE_MAX_BATCH=4-16 (default: 8)
    MLX_AUTO_TUNE_EMA_ALPHA=0.1-0.9 (default: 0.3)
    MLX_AUTO_TUNE_INTERVAL=5-20 (default: 10)

    # v1.4.1 Metrics export
    MLX_METRICS_EXPORT=on|off (default: off)
    MLX_METRICS_PORT=1024-65535 (default: 9090)

    # v1.4.2 Performance Optimizations (NEW)
    MLX_ADAPTIVE_WINDOW=on|off (default: on)
    MLX_FAST_PATH=on|off (default: on)
"""

# Update GPUScheduler.__init__() default parameter (line 149)
def __init__(
    self,
    batch_window_ms: float = 1.0,  # ← CHANGED from 2.0
    max_batch_size: int = 4,
    p99_threshold_ms: float = 100.0,
    enabled: bool = True,
):
    """
    Initialize GPU scheduler

    Args:
        batch_window_ms: Time window to collect jobs for batching (default: 1.0ms, v1.4.2)
        max_batch_size: Maximum jobs per batch (default: 4)
        p99_threshold_ms: P99 latency threshold for auto-degradation (default: 100ms)
        enabled: Enable scheduler (False = direct passthrough mode)
    """
    # ... rest of init unchanged ...

# Update get_scheduler() default (line 569)
def get_scheduler() -> GPUScheduler:
    """
    Get or create global GPU scheduler instance

    Configuration from environment variables:
        MLX_GPU_SCHEDULER=on|off (default: off)
        MLX_GPU_SCHEDULER_BATCH_SIZE=2-16 (default: 4)
        MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 1.0)  # ← CHANGED from 2.0
        MLX_GPU_SCHEDULER_P99_THRESHOLD_MS=50-500 (default: 100.0)

    Returns:
        Shared GPUScheduler instance
    """
    global _scheduler

    if _scheduler is None:
        with _scheduler_lock:
            if _scheduler is None:
                # Read configuration from environment
                enabled = os.getenv("MLX_GPU_SCHEDULER", "off").lower() == "on"
                batch_size = int(os.getenv("MLX_GPU_SCHEDULER_BATCH_SIZE", "4"))
                window_ms = float(os.getenv("MLX_GPU_SCHEDULER_WINDOW_MS", "1.0"))  # ← CHANGED
                p99_threshold = float(os.getenv("MLX_GPU_SCHEDULER_P99_THRESHOLD_MS", "100.0"))

                # Validate configuration
                batch_size = max(1, min(16, batch_size))
                window_ms = max(0.75, min(5.0, window_ms))
                p99_threshold = max(50.0, min(500.0, p99_threshold))

                _scheduler = GPUScheduler(
                    batch_window_ms=window_ms,
                    max_batch_size=batch_size,
                    p99_threshold_ms=p99_threshold,
                    enabled=enabled,
                )

    return _scheduler
```

### 1.2 Runtime Configuration Update

**File**: `config/runtime.yaml`

Add new section after line 316:

```yaml
# GPU Scheduler Configuration (v1.4.2)
# Provides stability by serializing GPU command buffer submissions
gpu_scheduler:
  # Enable GPU scheduler for stability (prevents Metal GPU crashes)
  # Controlled via MLX_GPU_SCHEDULER environment variable
  enabled: false  # Default: off (opt-in for stability)

  # Batching window in milliseconds
  # v1.4.2: Reduced from 2.0ms → 1.0ms for better latency
  # Trade-off: Lower = better latency, Higher = better throughput
  batch_window_ms: 1.0

  # Maximum batch size (number of jobs per batch)
  # Higher batch size improves throughput but increases latency
  max_batch_size: 4

  # P99 latency threshold for auto-degradation (milliseconds)
  # If P99 latency exceeds this, batch size is reduced automatically
  p99_threshold_ms: 100.0

  # Workload-specific presets
  # Use these for quick configuration based on workload type
  presets:
    # Preset 1: Ultra-low latency (2-3% overhead)
    # Best for: Real-time inference, interactive applications
    latency_sensitive:
      batch_window_ms: 0.75
      max_batch_size: 2
      adaptive_window: false
      fast_path: true

    # Preset 2: Balanced (4-5% overhead) - DEFAULT
    # Best for: Production workloads, mixed traffic patterns
    balanced:
      batch_window_ms: 1.0
      max_batch_size: 4
      adaptive_window: true
      fast_path: true

    # Preset 3: High throughput (8-11% overhead)
    # Best for: Batch processing, high-concurrency workloads
    throughput_optimized:
      batch_window_ms: 2.0
      max_batch_size: 8
      adaptive_window: true
      fast_path: true

  # v1.4.2: Adaptive window sizing (NEW)
  # Dynamically adjusts batching window based on queue depth
  adaptive_window:
    enabled: true  # Set via MLX_ADAPTIVE_WINDOW env var

    # Queue depth thresholds
    low_load_threshold: 1      # Queue depth ≤ 1 = low load
    medium_load_threshold: 5   # Queue depth 2-5 = medium load
    high_load_threshold: 6     # Queue depth ≥ 6 = high load

    # Window sizes for each load level
    low_load_window_ms: 0.75    # Prioritize latency
    medium_load_window_ms: 1.0  # Balanced
    high_load_window_ms: 2.0    # Maximize batching

    # Hysteresis to prevent oscillation
    # Require N consecutive samples before transitioning
    hysteresis_count: 3

    # EMA smoothing for queue depth measurement
    # Higher alpha = more responsive, Lower = more stable
    ema_alpha: 0.5

  # v1.4.2: Fast-path optimization (NEW)
  # Bypass batching window when queue is empty (single job execution)
  fast_path:
    enabled: true  # Set via MLX_FAST_PATH env var
```

---

## 2. Adaptive Window Sizing

### 2.1 Adaptive Window Controller Module

**File**: `python/models/adaptive_window.py` (NEW)

```python
"""
Adaptive Window Controller for Dynamic Batching Window Sizing.

Adjusts batching window based on queue depth to optimize latency vs throughput.
Part of kr-serve-mlx v1.4.2 performance optimizations.

Architecture:
    Queue Depth → EMA Smoothing → Window Selection → Hysteresis → Window Update

Features:
    - Dynamic window sizing (0.75ms - 2.0ms)
    - EMA smoothing to prevent oscillation
    - Hysteresis mechanism for stability
    - Integration with GPU Scheduler
    - Prometheus metrics export

Environment Variables:
    MLX_ADAPTIVE_WINDOW=on|off (default: on)
    MLX_ADAPTIVE_WINDOW_LOW_MS=0.5-2.0 (default: 0.75)
    MLX_ADAPTIVE_WINDOW_MEDIUM_MS=0.75-3.0 (default: 1.0)
    MLX_ADAPTIVE_WINDOW_HIGH_MS=1.0-5.0 (default: 2.0)
    MLX_ADAPTIVE_WINDOW_HYSTERESIS=1-10 (default: 3)
    MLX_ADAPTIVE_WINDOW_EMA_ALPHA=0.1-0.9 (default: 0.5)
"""

import os
import time
import logging
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field

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

    @classmethod
    def from_env(cls) -> 'WindowConfig':
        """Load configuration from environment variables."""
        return cls(
            low_load_threshold=int(os.getenv('MLX_ADAPTIVE_WINDOW_LOW_THRESHOLD', '1')),
            medium_load_threshold=int(os.getenv('MLX_ADAPTIVE_WINDOW_MEDIUM_THRESHOLD', '5')),
            high_load_threshold=int(os.getenv('MLX_ADAPTIVE_WINDOW_HIGH_THRESHOLD', '6')),
            low_load_window_ms=float(os.getenv('MLX_ADAPTIVE_WINDOW_LOW_MS', '0.75')),
            medium_load_window_ms=float(os.getenv('MLX_ADAPTIVE_WINDOW_MEDIUM_MS', '1.0')),
            high_load_window_ms=float(os.getenv('MLX_ADAPTIVE_WINDOW_HIGH_MS', '2.0')),
            hysteresis_count=int(os.getenv('MLX_ADAPTIVE_WINDOW_HYSTERESIS', '3')),
            ema_alpha=float(os.getenv('MLX_ADAPTIVE_WINDOW_EMA_ALPHA', '0.5')),
        )


@dataclass
class WindowMetrics:
    """Metrics tracked by the adaptive window controller."""

    current_window_ms: float
    ema_queue_depth: float
    total_updates: int
    window_transitions: int
    transition_rate: float
    last_transition_time: float
    transition_history: List[Tuple[float, float, str]] = field(default_factory=list)  # (timestamp, window_ms, reason)


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
    - Configurable via environment variables
    - Integration with MetricsCollector for observability

    Example:
        controller = AdaptiveWindowController()

        # Update with current queue depth
        window_ms, transition = controller.update(queue_depth=3)

        # Get current window
        current = controller.get_current_window_ms()

        # Get metrics
        metrics = controller.get_metrics()
    """

    def __init__(self, config: Optional[WindowConfig] = None):
        """
        Initialize adaptive window controller.

        Args:
            config: Window configuration. If None, loads from environment.
        """
        self.config = config or WindowConfig.from_env()
        self.enabled = os.getenv('MLX_ADAPTIVE_WINDOW', 'on').lower() == 'on'

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
        self.last_transition_time = time.time()
        self.transition_history: List[Tuple[float, float, str]] = []

        logger.info(
            f"AdaptiveWindowController initialized: enabled={self.enabled}, "
            f"low={self.config.low_load_window_ms}ms, "
            f"medium={self.config.medium_load_window_ms}ms, "
            f"high={self.config.high_load_window_ms}ms, "
            f"hysteresis={self.config.hysteresis_count}, "
            f"ema_alpha={self.config.ema_alpha}"
        )

    def update(self, queue_depth: int) -> Tuple[float, bool]:
        """
        Update window size based on current queue depth.

        Args:
            queue_depth: Current number of jobs in queue

        Returns:
            Tuple of (window_ms, transition_occurred)
        """
        if not self.enabled:
            return self.current_window_ms, False

        self.total_updates += 1
        self.last_update_time = time.time()

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
                    self.last_transition_time = time.time()

                    # Record transition
                    reason = self._get_transition_reason(queue_depth, self.ema_queue_depth)
                    self.transition_history.append((
                        time.time(),
                        target_window_ms,
                        reason
                    ))

                    # Keep history bounded
                    if len(self.transition_history) > 100:
                        self.transition_history = self.transition_history[-100:]

                    logger.info(
                        f"Window transition: {old_window}ms → {target_window_ms}ms "
                        f"(queue_depth={queue_depth}, ema={self.ema_queue_depth:.2f}, "
                        f"reason={reason})"
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
        """
        Calculate target window based on EMA queue depth.

        Args:
            ema_queue_depth: Exponential moving average of queue depth

        Returns:
            Target window size in milliseconds
        """
        if ema_queue_depth <= self.config.low_load_threshold:
            return self.config.low_load_window_ms
        elif ema_queue_depth <= self.config.medium_load_threshold:
            return self.config.medium_load_window_ms
        else:
            return self.config.high_load_window_ms

    def _get_transition_reason(self, queue_depth: int, ema_queue_depth: float) -> str:
        """Generate human-readable transition reason."""
        target = self._calculate_target_window(ema_queue_depth)

        if target == self.config.low_load_window_ms:
            return f"low_load (depth={queue_depth}, ema={ema_queue_depth:.2f})"
        elif target == self.config.medium_load_window_ms:
            return f"medium_load (depth={queue_depth}, ema={ema_queue_depth:.2f})"
        else:
            return f"high_load (depth={queue_depth}, ema={ema_queue_depth:.2f})"

    def get_current_window_ms(self) -> float:
        """Get current batching window in milliseconds."""
        return self.current_window_ms

    def get_metrics(self) -> WindowMetrics:
        """Get controller metrics."""
        return WindowMetrics(
            current_window_ms=self.current_window_ms,
            ema_queue_depth=self.ema_queue_depth,
            total_updates=self.total_updates,
            window_transitions=self.window_transitions,
            transition_rate=(
                self.window_transitions / max(1, self.total_updates)
            ),
            last_transition_time=self.last_transition_time,
            transition_history=self.transition_history[-10:]  # Last 10 transitions
        )

    def get_stats_dict(self) -> Dict:
        """Get metrics as JSON-serializable dictionary."""
        metrics = self.get_metrics()
        return {
            'enabled': self.enabled,
            'current_window_ms': metrics.current_window_ms,
            'ema_queue_depth': metrics.ema_queue_depth,
            'total_updates': metrics.total_updates,
            'window_transitions': metrics.window_transitions,
            'transition_rate': metrics.transition_rate,
            'last_transition_time': metrics.last_transition_time,
            'recent_transitions': [
                {
                    'timestamp': ts,
                    'window_ms': window,
                    'reason': reason
                }
                for ts, window, reason in metrics.transition_history
            ]
        }

    def reset(self):
        """Reset controller state (keeps configuration)."""
        self.current_window_ms = self.config.medium_load_window_ms
        self.ema_queue_depth = 0.0
        self.transition_counter = 0
        self.pending_window_ms = self.current_window_ms
        self.total_updates = 0
        self.window_transitions = 0
        self.last_transition_time = time.time()
        self.transition_history.clear()

        logger.info("AdaptiveWindowController reset")
```

### 2.2 Integration with GPU Scheduler

**File**: `python/gpu_scheduler.py`

```python
# Add import at top (line 60)
from models.adaptive_controller import AdaptiveController, ControllerConfig
from models.adaptive_window import AdaptiveWindowController, WindowConfig  # NEW
from models.metrics_collector import MetricsCollector
from monitoring.prometheus_exporter import PrometheusExporter

# Update GPUScheduler.__init__() (line 179)
def __init__(
    self,
    batch_window_ms: float = 1.0,
    max_batch_size: int = 4,
    p99_threshold_ms: float = 100.0,
    enabled: bool = True,
):
    # ... existing init code ...

    # v1.4.1: Adaptive controller for auto-tuning
    self.adaptive_controller: Optional[AdaptiveController] = None
    auto_tune_enabled = os.getenv('MLX_AUTO_TUNE', 'off').lower() == 'on'
    if auto_tune_enabled:
        self.adaptive_controller = AdaptiveController()
        logger.info(
            f"AdaptiveController enabled: min_batch={self.adaptive_controller.config.min_batch_size}, "
            f"max_batch={self.adaptive_controller.config.max_batch_size}"
        )

    # v1.4.2: Adaptive window sizing (NEW)
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
        # Fallback to fixed window
        window_ms = self.current_window_ms

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

# Update get_stats() to include adaptive window metrics (line 491)
def get_stats(self) -> Dict[str, Any]:
    """
    Get scheduler statistics

    v1.4.1: Returns comprehensive metrics including auto-tuning state
    v1.4.2: Adds adaptive window controller metrics
    """
    # ... existing stats code ...

    # v1.4.2: Add AdaptiveWindowController state (NEW)
    if self.adaptive_window_controller is not None and self.adaptive_window_controller.enabled:
        window_metrics = self.adaptive_window_controller.get_stats_dict()
        base_stats["adaptive_window"] = window_metrics
    else:
        base_stats["adaptive_window"] = {"enabled": False}

    return base_stats
```

---

## 3. Fast-Path Optimization

### 3.1 Fast-Path Implementation

**File**: `python/gpu_scheduler.py`

```python
# Update GPUScheduler.__init__() to track fast-path metrics (line 179)
def __init__(
    self,
    batch_window_ms: float = 1.0,
    max_batch_size: int = 4,
    p99_threshold_ms: float = 100.0,
    enabled: bool = True,
):
    # ... existing init code ...

    # v1.4.2: Fast-path metrics (NEW)
    self.fast_path_executions = 0
    self.normal_path_executions = 0

    logger.info(
        f"GPUScheduler initialized: enabled={enabled}, window={batch_window_ms}ms, "
        f"batch_size={max_batch_size}, p99_threshold={p99_threshold_ms}ms, "
        f"auto_tune={auto_tune_enabled}, metrics_export={self.prometheus_exporter.enabled}, "
        f"adaptive_window={adaptive_window_enabled}, "
        f"fast_path={os.getenv('MLX_FAST_PATH', 'on').lower() == 'on'}"
    )

# Update _collect_batch() with fast-path logic (line 345)
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
                self.fast_path_executions += 1

                if self.fast_path_executions % 100 == 0:
                    logger.debug(
                        f"Fast-path execution #{self.fast_path_executions}: "
                        f"single job, queue empty"
                    )

                return batch

            # Jobs arrived during check - continue to normal batching
            # (fall through to deadline-based collection)
            self.normal_path_executions += 1

        except asyncio.TimeoutError:
            # No jobs available yet - return empty batch
            return batch

    else:
        # Normal path (queue not empty or fast-path disabled)
        self.normal_path_executions += 1

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

# Update get_stats() to include fast-path metrics (line 491)
def get_stats(self) -> Dict[str, Any]:
    """
    Get scheduler statistics

    v1.4.1: Returns comprehensive metrics including auto-tuning state
    v1.4.2: Adds adaptive window and fast-path metrics
    """
    # ... existing stats code ...

    # v1.4.2: Add fast-path metrics (NEW)
    fast_path_enabled = os.getenv('MLX_FAST_PATH', 'on').lower() == 'on'
    total_executions = self.fast_path_executions + self.normal_path_executions
    fast_path_rate = (
        self.fast_path_executions / max(1, total_executions)
    )

    base_stats["fast_path"] = {
        "enabled": fast_path_enabled,
        "executions": self.fast_path_executions,
        "normal_executions": self.normal_path_executions,
        "total_executions": total_executions,
        "fast_path_rate": fast_path_rate,
    }

    return base_stats
```

---

## 4. Combined Example: All Optimizations Together

### 4.1 Complete _collect_batch() Method

**File**: `python/gpu_scheduler.py` (Complete implementation with all v1.4.2 optimizations)

```python
async def _collect_batch(self) -> List[GPUJob]:
    """
    Collect jobs for batching within time window.

    v1.4.2 Optimizations (ALL COMBINED):
    1. Fast path: Skip window if queue empty (execute immediately)
    2. Adaptive window sizing based on queue depth
    3. Reduced default window (1.0ms instead of 2.0ms)

    Returns:
        List of jobs to execute (up to max_batch_size)
    """
    batch: List[GPUJob] = []

    # =========================================================================
    # OPTIMIZATION 1: Fast-Path Check
    # =========================================================================
    # If queue is empty when first job arrives, execute immediately
    # Expected benefit: ~5-7% overhead reduction for sequential requests
    fast_path_enabled = os.getenv('MLX_FAST_PATH', 'on').lower() == 'on'
    initial_queue_depth = self.job_queue.qsize()

    # =========================================================================
    # OPTIMIZATION 2: Adaptive Window Sizing
    # =========================================================================
    # Dynamically adjust window based on queue depth
    # Low load (depth 0-1): 0.75ms window
    # Medium load (depth 2-5): 1.0ms window (default)
    # High load (depth 6+): 2.0ms window
    if self.adaptive_window_controller is not None:
        window_ms, transition = self.adaptive_window_controller.update(initial_queue_depth)
        if transition:
            # Record window transition for observability
            self.metrics_collector.record_mode_transition(f"window_{window_ms}ms")
            logger.debug(
                f"Window transition: new_window={window_ms}ms, "
                f"queue_depth={initial_queue_depth}, "
                f"ema={self.adaptive_window_controller.ema_queue_depth:.2f}"
            )
    else:
        # OPTIMIZATION 3: Reduced default window (1.0ms instead of 2.0ms)
        window_ms = self.current_window_ms

    # =========================================================================
    # FAST PATH EXECUTION
    # =========================================================================
    if fast_path_enabled and initial_queue_depth == 0:
        try:
            # Wait for first job with minimal timeout (0.1ms)
            # This is much faster than waiting for the full batching window
            _, _, job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=0.0001  # 0.1ms
            )
            batch.append(job)

            # Check if more jobs arrived while we were waiting
            current_queue_depth = self.job_queue.qsize()

            if current_queue_depth == 0:
                # Still empty - FAST PATH EXECUTION
                # Execute immediately without waiting for batching window
                self.fast_path_executions += 1

                # Log fast-path execution periodically
                if self.fast_path_executions % 100 == 0:
                    total_executions = self.fast_path_executions + self.normal_path_executions
                    fast_path_rate = self.fast_path_executions / max(1, total_executions)
                    logger.debug(
                        f"Fast-path stats: executions={self.fast_path_executions}, "
                        f"total={total_executions}, rate={fast_path_rate:.1%}"
                    )

                return batch

            # Jobs arrived - fall through to normal batching
            logger.debug(
                f"Fast-path fallback: jobs arrived during check "
                f"(queue_depth={current_queue_depth})"
            )
            self.normal_path_executions += 1

        except asyncio.TimeoutError:
            # No jobs available yet
            return []

    else:
        # Normal path (queue not empty or fast-path disabled)
        self.normal_path_executions += 1

    # =========================================================================
    # NORMAL BATCHING PATH
    # =========================================================================
    # Collect jobs until window expires or batch is full
    deadline = time.perf_counter() + (window_ms / 1000.0)

    while len(batch) < self.current_batch_size:
        # Calculate remaining time in window
        timeout = max(0.0, deadline - time.perf_counter())

        if timeout <= 0 and batch:
            # Window expired and we have jobs - execute batch
            break

        try:
            # Wait for next job with timeout
            _, _, job = await asyncio.wait_for(
                self.job_queue.get(),
                timeout=timeout if timeout > 0 else 0.001
            )
            batch.append(job)

            # URGENT jobs: execute immediately (no batching)
            if job.priority == JobPriority.URGENT:
                logger.debug(f"URGENT job detected - breaking batching window")
                break

        except asyncio.TimeoutError:
            # Window expired
            break

    # Log batch collection statistics periodically
    if self.total_batches % 1000 == 0 and batch:
        avg_batch_size = sum(
            self.metrics_collector._batch_sizes
        ) / max(1, len(self.metrics_collector._batch_sizes))

        logger.debug(
            f"Batch collection: size={len(batch)}, "
            f"window={window_ms}ms, "
            f"queue_depth={self.job_queue.qsize()}, "
            f"avg_batch_size={avg_batch_size:.2f}"
        )

    return batch
```

---

## 5. Testing Examples

### 5.1 Fast-Path Unit Test

**File**: `tests/unit/gpu_scheduler_fast_path.spec.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine } from '@/api/engine.js';
import type { Engine } from '@/types/engine.js';

describe('GPU Scheduler Fast Path (v1.4.2)', () => {
  let engine: Engine;

  beforeEach(async () => {
    // Enable fast-path optimization
    process.env.MLX_GPU_SCHEDULER = 'on';
    process.env.MLX_FAST_PATH = 'on';
    process.env.MLX_GPU_SCHEDULER_WINDOW_MS = '1.0';
    process.env.MLX_ADAPTIVE_WINDOW = 'off'; // Disable for controlled test

    engine = await createEngine();
  });

  afterEach(async () => {
    if (engine) {
      await engine.dispose();
    }
    delete process.env.MLX_GPU_SCHEDULER;
    delete process.env.MLX_FAST_PATH;
    delete process.env.MLX_GPU_SCHEDULER_WINDOW_MS;
    delete process.env.MLX_ADAPTIVE_WINDOW;
  });

  it('should use fast-path for sequential requests (queue empty)', async () => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Execute 10 sequential requests (queue always empty)
    for (let i = 0; i < 10; i++) {
      for await (const chunk of engine.createGenerator({
        prompt: 'Hello',
        max_tokens: 10
      })) {
        // Consume chunks
      }

      // Wait to ensure queue stays empty between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Verify fast-path was used
    const stats = await engine.getSchedulerStats();

    expect(stats.fast_path.enabled).toBe(true);
    expect(stats.fast_path.executions).toBeGreaterThan(8); // Most requests should use fast-path
    expect(stats.fast_path.fast_path_rate).toBeGreaterThan(0.8); // >80% fast-path usage
  });

  it('should fall back to normal batching when queue has jobs', async () => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Execute 5 concurrent requests (queue will have jobs)
    const promises = Array.from({ length: 5 }, () =>
      (async () => {
        for await (const chunk of engine.createGenerator({
          prompt: 'Test',
          max_tokens: 10
        })) {
          // Consume chunks
        }
      })()
    );

    await Promise.all(promises);

    // Verify normal batching was used
    const stats = await engine.getSchedulerStats();

    expect(stats.fast_path.enabled).toBe(true);
    expect(stats.fast_path.normal_executions).toBeGreaterThan(0); // Should use normal batching
    expect(stats.fast_path.fast_path_rate).toBeLessThan(0.5); // <50% fast-path for concurrent
  });

  it('should measure TTFT improvement with fast-path', async () => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    const ttfts: number[] = [];

    for (let i = 0; i < 5; i++) {
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

    // Baseline TTFT: ~94ms
    // v1.4.1 TTFT: ~105ms (+11ms overhead)
    // v1.4.2 fast-path target: <100ms (<6ms overhead)
    expect(meanTTFT).toBeLessThan(100);
    console.log(`Fast-path TTFT: ${meanTTFT.toFixed(2)}ms (baseline: ~94ms)`);
  });
});
```

### 5.2 Adaptive Window Integration Test

**File**: `tests/integration/gpu_scheduler_adaptive_window.spec.ts` (NEW)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine } from '@/api/engine.js';
import type { Engine } from '@/types/engine.js';

describe('GPU Scheduler Adaptive Window (v1.4.2)', () => {
  let engine: Engine;

  beforeEach(async () => {
    // Enable adaptive window optimization
    process.env.MLX_GPU_SCHEDULER = 'on';
    process.env.MLX_ADAPTIVE_WINDOW = 'on';
    process.env.MLX_FAST_PATH = 'off'; // Disable for controlled test
    process.env.MLX_GPU_SCHEDULER_WINDOW_MS = '1.0';

    engine = await createEngine();
  });

  afterEach(async () => {
    if (engine) {
      await engine.dispose();
    }
    delete process.env.MLX_GPU_SCHEDULER;
    delete process.env.MLX_ADAPTIVE_WINDOW;
    delete process.env.MLX_FAST_PATH;
    delete process.env.MLX_GPU_SCHEDULER_WINDOW_MS;
  });

  it('should adjust window based on queue depth', async () => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Phase 1: Low load (sequential requests, queue depth 0-1)
    for (let i = 0; i < 3; i++) {
      for await (const chunk of engine.createGenerator({
        prompt: 'Low load',
        max_tokens: 10
      })) {
        // Consume
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const lowLoadStats = await engine.getSchedulerStats();
    const lowLoadWindow = lowLoadStats.adaptive_window.current_window_ms;

    // Should use low load window (0.75ms)
    expect(lowLoadWindow).toBeCloseTo(0.75, 1);

    // Phase 2: High load (concurrent requests, queue depth 6+)
    const promises = Array.from({ length: 10 }, () =>
      (async () => {
        for await (const chunk of engine.createGenerator({
          prompt: 'High load',
          max_tokens: 10
        })) {
          // Consume
        }
      })()
    );

    await Promise.all(promises);

    const highLoadStats = await engine.getSchedulerStats();
    const transitions = highLoadStats.adaptive_window.window_transitions;

    // Should have transitioned to higher window
    expect(transitions).toBeGreaterThan(0);
  });

  it('should use hysteresis to prevent oscillation', async () => {
    await engine.loadModel({ model: 'llama-3.2-3b-instruct' });

    // Simulate oscillating load
    for (let cycle = 0; cycle < 3; cycle++) {
      // Low load
      for (let i = 0; i < 2; i++) {
        for await (const chunk of engine.createGenerator({
          prompt: 'Test',
          max_tokens: 5
        })) {
          // Consume
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // High load
      const promises = Array.from({ length: 5 }, () =>
        (async () => {
          for await (const chunk of engine.createGenerator({
            prompt: 'Test',
            max_tokens: 5
          })) {
            // Consume
          }
        })()
      );
      await Promise.all(promises);
    }

    const stats = await engine.getSchedulerStats();
    const transitionRate = stats.adaptive_window.transition_rate;

    // Transition rate should be low (<10%) due to hysteresis
    expect(transitionRate).toBeLessThan(0.1);
  });
});
```

---

## 6. Configuration Examples

### 6.1 Environment Variable Presets

**Ultra-Low Latency Preset**:

```bash
#!/bin/bash
# v1.4.2 Ultra-Low Latency Configuration
# Target: 2-3% overhead, minimal latency
# Use case: Real-time inference, interactive applications

export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=0.75
export MLX_GPU_SCHEDULER_BATCH_SIZE=2
export MLX_ADAPTIVE_WINDOW=off       # Fixed window for predictability
export MLX_FAST_PATH=on              # Critical for sequential requests
export MLX_AUTO_TUNE=off             # Manual tuning preferred
export MLX_METRICS_EXPORT=off        # Minimal overhead
```

**Balanced Preset (Default)**:

```bash
#!/bin/bash
# v1.4.2 Balanced Configuration (Default)
# Target: 4-5% overhead, adaptive optimization
# Use case: Production workloads, mixed traffic patterns

export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=1.0
export MLX_GPU_SCHEDULER_BATCH_SIZE=4
export MLX_ADAPTIVE_WINDOW=on        # Automatic adjustment
export MLX_FAST_PATH=on              # Enabled by default
export MLX_AUTO_TUNE=on              # Dynamic batch sizing
export MLX_METRICS_EXPORT=on         # Full observability
```

**High Throughput Preset**:

```bash
#!/bin/bash
# v1.4.2 High Throughput Configuration
# Target: 8-11% overhead, maximum throughput
# Use case: Batch processing, high-concurrency workloads

export MLX_GPU_SCHEDULER=on
export MLX_GPU_SCHEDULER_WINDOW_MS=2.0
export MLX_GPU_SCHEDULER_BATCH_SIZE=8
export MLX_ADAPTIVE_WINDOW=on        # Can adjust down under low load
export MLX_FAST_PATH=on              # Still beneficial for single requests
export MLX_AUTO_TUNE=on              # Adjust batch size dynamically
export MLX_METRICS_EXPORT=on         # Monitor throughput metrics
export MLX_AUTO_TUNE_MAX_BATCH=16    # Allow larger batches
```

---

## Summary

This document provides complete, production-ready code for all three v1.4.2 optimizations:

1. **Reduced Default Window**: Simple default change from 2.0ms → 1.0ms
2. **Adaptive Window Sizing**: Complete `AdaptiveWindowController` module with EMA smoothing and hysteresis
3. **Fast-Path Optimization**: Queue depth check for immediate execution

All code is ready for implementation and includes:
- Complete module implementations
- Integration examples
- Test cases
- Configuration presets
- Environment variable documentation

**Next Steps**: Begin implementation with Phase 1 (Reduced Default Window) as outlined in the main PRD.
