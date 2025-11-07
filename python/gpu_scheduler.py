"""
GPU Scheduler Layer for MLX Operations

This module provides a low-risk stabilization layer that serializes GPU command buffer
submissions to prevent SIGSEGV crashes from concurrent Metal GPU access.

Architecture:
    Multiple CPU threads → JobQueue → Single CommitWorker → MLX → Metal GPU

Key Features:
    - Single serialization point for GPU submissions
    - Lightweight request batching to reduce command buffer count
    - P50/P99 latency monitoring with auto-degradation
    - Zero-risk fallback to direct MLX mode
    - No modifications to MLX core library

v1.4.1 Enhancements:
    - Adaptive batch size controller with EMA smoothing
    - Comprehensive metrics collection (P50/P95/P99, throughput, batch distributions)
    - Prometheus metrics export (/metrics, /health, /ready, /stats)
    - Auto-tuning based on P99 latency feedback

v1.4.2 Optimizations:
    - Phase 1: Reduced default batching window (2.0ms → 1.0ms) for lower latency
    - Phase 2: Fast-path bypass (skip window when queue empty) for sequential workloads
    - Phase 3: Adaptive window sizing (dynamic window based on queue depth)
    - Phase 4: Low-contention metrics (fine-grained locks reduce thread synchronization)
    - Phase 5: Lazy metrics aggregation (cache computed metrics, dirty-flag invalidation)
    - Phase 6: Cached configuration lookups (avoid repeated os.getenv() calls)

Performance Targets:
    - Throughput: ≥ +15% vs Pure MLX
    - P99 Latency: ≤ -30% vs Pure MLX
    - Stability: 72-hour stress test with 0 errors

Environment Variables:
    MLX_GPU_SCHEDULER=on|off (default: off for safety)
    MLX_GPU_SCHEDULER_BATCH_SIZE=2-16 (default: 4)
    MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 1.0)
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

    # v1.4.2 Fast-path optimization
    MLX_FAST_PATH=on|off (default: on)

    # v1.4.2 Adaptive window sizing (opt-in for high-concurrency workloads)
    MLX_ADAPTIVE_WINDOW=on|off (default: off, enable for variable-load scenarios)
    MLX_ADAPTIVE_WINDOW_LOW_MS=0.5-1.5 (default: 0.75, for 0-1 jobs)
    MLX_ADAPTIVE_WINDOW_MEDIUM_MS=0.75-2.0 (default: 1.0, for 2-5 jobs)
    MLX_ADAPTIVE_WINDOW_HIGH_MS=1.5-5.0 (default: 2.0, for 6+ jobs)
"""

import asyncio
import os
import time
import threading
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, List, Optional, TypeVar
import sys
import logging

# v1.4.1: Import new components
from models.adaptive_controller import AdaptiveController, ControllerConfig
from models.metrics_collector import MetricsCollector
from monitoring.prometheus_exporter import PrometheusExporter

logger = logging.getLogger(__name__)
T = TypeVar('T')


class JobPriority(Enum):
    """Priority levels for GPU job scheduling"""
    URGENT = 0      # < 1ms latency target (real-time inference)
    DEFAULT = 1     # Normal priority
    BACKGROUND = 2  # Can wait (preloading, warmup)


@dataclass
class GPUJob:
    """Represents a single GPU operation to be scheduled"""
    job_id: str
    priority: JobPriority
    operation: Callable[[], Coroutine[Any, Any, T]]
    future: asyncio.Future
    enqueue_time: float = field(default_factory=time.perf_counter)

    def __lt__(self, other: 'GPUJob') -> bool:
        """Priority queue ordering: lower priority value = higher priority"""
        if self.priority.value != other.priority.value:
            return self.priority.value < other.priority.value
        return self.enqueue_time < other.enqueue_time


class LatencyMetrics:
    """Tracks latency percentiles with sliding window"""

    def __init__(self, window_size: int = 1000):
        self.window_size = window_size
        self.latencies: deque = deque(maxlen=window_size)
        self.lock = threading.Lock()

    def record(self, latency_ms: float) -> None:
        """Record a latency measurement"""
        with self.lock:
            self.latencies.append(latency_ms)

    def get_percentiles(self) -> Dict[str, float]:
        """Calculate P50, P95, P99 latencies"""
        with self.lock:
            if not self.latencies:
                return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "count": 0}

            sorted_latencies = sorted(self.latencies)
            count = len(sorted_latencies)

            return {
                "p50": sorted_latencies[int(count * 0.50)] if count > 0 else 0.0,
                "p95": sorted_latencies[int(count * 0.95)] if count > 1 else 0.0,
                "p99": sorted_latencies[int(count * 0.99)] if count > 2 else 0.0,
                "count": count,
            }

    def reset(self) -> None:
        """Clear metrics (for testing or reset)"""
        with self.lock:
            self.latencies.clear()


class GPUScheduler:
    """
    Single-point GPU scheduler for MLX operations

    Serializes GPU command buffer submissions to prevent concurrent Metal access
    issues while maintaining CPU-level parallelism for non-GPU work.

    v1.4.1: Enhanced with adaptive auto-tuning, comprehensive metrics, and
    Prometheus export.

    Usage:
        scheduler = GPUScheduler()
        await scheduler.start()

        # Schedule GPU work
        result = await scheduler.schedule(
            operation=lambda: model.generate(...),
            priority=JobPriority.DEFAULT
        )

        await scheduler.stop()
    """

    def __init__(
        self,
        batch_window_ms: float = 1.0,
        max_batch_size: int = 4,
        p99_threshold_ms: float = 100.0,
        enabled: bool = True,
    ):
        """
        Initialize GPU scheduler

        Args:
            batch_window_ms: Time window to collect jobs for batching (default: 1.0ms)
            max_batch_size: Maximum jobs per batch (default: 4)
            p99_threshold_ms: P99 latency threshold for auto-degradation (default: 100ms)
            enabled: Enable scheduler (False = direct passthrough mode)
        """
        self.enabled = enabled
        self.batch_window_ms = batch_window_ms
        self.max_batch_size = max_batch_size
        self.p99_threshold_ms = p99_threshold_ms

        # Job queue (priority-based)
        self.job_queue: asyncio.PriorityQueue = asyncio.PriorityQueue()

        # Commit worker task
        self.commit_task: Optional[asyncio.Task] = None
        self.running = False

        # v1.4.1: Enhanced metrics collection
        self.metrics_collector = MetricsCollector(window_sizes_s=[5, 30, 60])

        # v1.4.1: Adaptive controller for auto-tuning
        self.adaptive_controller: Optional[AdaptiveController] = None
        auto_tune_enabled = os.getenv('MLX_AUTO_TUNE', 'off').lower() == 'on'
        if auto_tune_enabled:
            self.adaptive_controller = AdaptiveController()
            logger.info(
                f"AdaptiveController enabled: min_batch={self.adaptive_controller.config.min_batch_size}, "
                f"max_batch={self.adaptive_controller.config.max_batch_size}"
            )

        # v1.4.1: Prometheus exporter
        self.prometheus_exporter = PrometheusExporter(self.metrics_collector)

        # Legacy metrics for backward compatibility
        self.metrics = LatencyMetrics()
        self.total_jobs = 0
        self.total_batches = 0
        self.degradation_events = 0

        # v1.4.2 Phase 2: Fast-path usage tracking
        self.total_fast_path = 0

        # v1.4.2 Phase 6: Cache environment variables to avoid repeated lookups
        self.fast_path_enabled = os.getenv('MLX_FAST_PATH', 'on').lower() == 'on'

        # v1.4.2 Phase 3: Adaptive window sizing configuration
        # REVERTED: Keep disabled by default - adaptive window caused 90% failure rate
        self.adaptive_window_enabled = os.getenv('MLX_ADAPTIVE_WINDOW', 'off').lower() == 'on'
        self.adaptive_window_low_ms = float(os.getenv('MLX_ADAPTIVE_WINDOW_LOW_MS', '0.75'))
        self.adaptive_window_medium_ms = float(os.getenv('MLX_ADAPTIVE_WINDOW_MEDIUM_MS', '1.0'))
        self.adaptive_window_high_ms = float(os.getenv('MLX_ADAPTIVE_WINDOW_HIGH_MS', '2.0'))
        self.adaptive_window_adjustments = {
            'low': 0,     # Count of low-load adjustments (0-1 jobs)
            'medium': 0,  # Count of medium-load adjustments (2-5 jobs)
            'high': 0     # Count of high-load adjustments (6+ jobs)
        }

        # Auto-degradation state (synchronized with AdaptiveController if enabled)
        # Bug fix: Initialize to controller's batch size if auto-tune enabled
        if auto_tune_enabled and self.adaptive_controller:
            self.current_batch_size = self.adaptive_controller.current_batch_size
        else:
            self.current_batch_size = max_batch_size
        self.current_window_ms = batch_window_ms

        logger.info(
            f"GPUScheduler initialized: enabled={enabled}, window={batch_window_ms}ms, "
            f"batch_size={max_batch_size}, p99_threshold={p99_threshold_ms}ms, "
            f"auto_tune={auto_tune_enabled}, metrics_export={self.prometheus_exporter.enabled}, "
            f"adaptive_window={self.adaptive_window_enabled}"
        )
        print(f"[GPUScheduler] Initialized: enabled={enabled}, window={batch_window_ms}ms, "
              f"batch_size={max_batch_size}, p99_threshold={p99_threshold_ms}ms, "
              f"adaptive_window={self.adaptive_window_enabled}",
              file=sys.stderr, flush=True)

    async def start(self) -> None:
        """Start the commit worker and Prometheus exporter"""
        if not self.enabled:
            print("[GPUScheduler] Disabled - using direct passthrough mode",
                  file=sys.stderr, flush=True)
            return

        if self.running:
            return

        self.running = True
        self.commit_task = asyncio.create_task(self._commit_worker())

        # v1.4.1: Start Prometheus exporter
        if self.prometheus_exporter.enabled:
            self.prometheus_exporter.start()
            logger.info(
                f"PrometheusExporter started: {self.prometheus_exporter.get_endpoint_url()}"
            )

    async def stop(self) -> None:
        """Stop the commit worker and Prometheus exporter gracefully"""
        if not self.enabled or not self.running:
            return

        self.running = False

        # Wait for worker to finish
        if self.commit_task:
            try:
                await asyncio.wait_for(self.commit_task, timeout=5.0)
            except asyncio.TimeoutError:
                self.commit_task.cancel()
                try:
                    await self.commit_task
                except asyncio.CancelledError:
                    pass

        # v1.4.1: Stop Prometheus exporter
        if self.prometheus_exporter.is_running():
            self.prometheus_exporter.stop()
            logger.info("PrometheusExporter stopped")

    async def schedule(
        self,
        operation: Callable[[], Coroutine[Any, Any, T]],
        priority: JobPriority = JobPriority.DEFAULT,
        job_id: Optional[str] = None,
    ) -> T:
        """
        Schedule a GPU operation for execution

        Args:
            operation: Async callable that performs GPU work
            priority: Job priority level
            job_id: Optional job identifier

        Returns:
            Result from the operation

        Raises:
            Exception: Any exception from the operation
        """
        # Passthrough mode: execute immediately
        if not self.enabled:
            return await operation()

        # Create job
        job = GPUJob(
            job_id=job_id or f"job_{self.total_jobs}",
            priority=priority,
            operation=operation,
            future=asyncio.Future(),
        )

        self.total_jobs += 1

        # Enqueue
        await self.job_queue.put((job.priority.value, job.enqueue_time, job))

        # Wait for result
        return await job.future

    async def _commit_worker(self) -> None:
        """
        Single worker that processes GPU jobs sequentially

        This is the critical serialization point that prevents concurrent
        GPU command buffer submissions.
        """
        while self.running:
            try:
                # Collect batch
                batch = await self._collect_batch()

                if not batch:
                    await asyncio.sleep(0.001)  # 1ms idle wait
                    continue

                # Execute batch sequentially
                start_time = time.perf_counter()
                await self._execute_batch(batch)
                batch_duration_ms = (time.perf_counter() - start_time) * 1000

                # Track metrics
                self.total_batches += 1

                # Auto-degradation check
                await self._check_degradation()

            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[GPUScheduler] Commit worker error: {exc}",
                      file=sys.stderr, flush=True)

    def _adjust_window_for_load(self) -> None:
        """
        v1.4.2 Phase 3: Adjust batching window based on current queue depth

        Dynamic window sizing strategy:
        - Low load (0-1 jobs):  0.75ms window → Minimize latency
        - Medium load (2-5 jobs): 1.0ms window → Balanced
        - High load (6+ jobs): 2.0ms window → Maximize throughput

        This allows the scheduler to optimize for latency when load is low
        (sequential requests) and for throughput when load is high (concurrent requests).
        """
        if not self.adaptive_window_enabled:
            return  # Keep default window if adaptive window is disabled

        queue_depth = self.job_queue.qsize()

        if queue_depth <= 1:
            # Low load: minimize latency with short window
            self.current_window_ms = self.adaptive_window_low_ms
            self.adaptive_window_adjustments['low'] += 1
        elif queue_depth <= 5:
            # Medium load: balanced window
            self.current_window_ms = self.adaptive_window_medium_ms
            self.adaptive_window_adjustments['medium'] += 1
        else:
            # High load: maximize throughput with longer window
            self.current_window_ms = self.adaptive_window_high_ms
            self.adaptive_window_adjustments['high'] += 1

    async def _collect_batch(self) -> List[GPUJob]:
        """
        Collect jobs for batching within time window

        v1.4.2 Phase 2: Fast-path optimization - skip window when queue empty
        v1.4.2 Phase 3: Adaptive window sizing based on queue depth

        Returns:
            List of jobs to execute (up to max_batch_size)
        """
        # v1.4.2 Phase 3: Dynamically adjust window based on current load
        self._adjust_window_for_load()

        batch: List[GPUJob] = []
        deadline = time.perf_counter() + (self.current_window_ms / 1000.0)

        # v1.4.2 Phase 2+6: Use cached fast_path configuration
        # Phase 6: Moved environment lookup to __init__ to avoid repeated os.getenv() calls
        fast_path_enabled = self.fast_path_enabled

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

                # v1.4.2 Phase 2: Fast-path - execute immediately if queue empty
                # This avoids batching window wait when there are no other jobs waiting
                if fast_path_enabled and len(batch) == 1 and self.job_queue.qsize() == 0:
                    self.total_fast_path += 1  # Track fast-path usage
                    break  # Queue empty after first job, execute immediately

            except asyncio.TimeoutError:
                break  # Window expired

        return batch

    async def _execute_batch(self, batch: List[GPUJob]) -> None:
        """
        Execute a batch of jobs sequentially

        This is where GPU serialization happens - jobs execute one at a time
        to prevent concurrent Metal command buffer submissions.

        v1.4.1: Enhanced with comprehensive metrics collection.
        """
        batch_start_time = time.perf_counter()
        tokens_generated = 0

        for job in batch:
            job_start_time = time.perf_counter()

            try:
                # Execute GPU operation (serialized)
                result = await job.operation()
                job.future.set_result(result)

                # Track tokens if available (for throughput metrics)
                if hasattr(result, 'usage') and hasattr(result.usage, 'completion_tokens'):
                    tokens_generated += result.usage.completion_tokens

            except Exception as exc:
                job.future.set_exception(exc)

            finally:
                # Record per-job latency
                latency_ms = (time.perf_counter() - job.enqueue_time) * 1000
                self.metrics.record(latency_ms)

                # v1.4.1: Record comprehensive metrics
                self.metrics_collector.record_latency(latency_ms)

        # v1.4.1: Record batch-level metrics
        batch_duration_ms = (time.perf_counter() - batch_start_time) * 1000
        self.metrics_collector.record_batch_size(len(batch))
        self.metrics_collector.record_queue_depth(self.job_queue.qsize())

        if tokens_generated > 0:
            self.metrics_collector.record_throughput(tokens_generated, requests=len(batch))

    async def _check_degradation(self) -> None:
        """
        Check P99 latency and auto-degrade if needed

        v1.4.1: If AdaptiveController is enabled, use that for auto-tuning.
        Otherwise, fall back to legacy degradation logic.

        Degradation strategies (legacy):
            1. Reduce batch size (more frequent commits)
            2. Reduce batch window (less waiting)
            3. Log warning if P99 still high
        """
        # v1.4.1: Use AdaptiveController if enabled
        if self.adaptive_controller is not None and self.adaptive_controller.enabled:
            # Get current P99 from MetricsCollector
            latency_metrics = self.metrics_collector.get_latency_metrics()

            if latency_metrics.count >= 10:  # Need minimum samples
                # Update controller with P99 latency
                new_batch_size, adjustment_made = self.adaptive_controller.update(
                    latency_metrics.p99_ms
                )

                if adjustment_made:
                    # Apply controller's recommendation
                    old_size = self.current_batch_size
                    self.current_batch_size = new_batch_size
                    logger.info(
                        f"AdaptiveController adjusted batch size: {old_size} → {new_batch_size} "
                        f"(P99={latency_metrics.p99_ms:.2f}ms, "
                        f"EMA={self.adaptive_controller.ema_p99_ms:.2f}ms)"
                    )

                    # Record mode transition for metrics
                    self.metrics_collector.record_mode_transition(f"batch_size_{new_batch_size}")

            return

        # Legacy degradation logic (when AdaptiveController is disabled)
        stats = self.metrics.get_percentiles()

        if stats['count'] < 100:
            return  # Not enough data

        p99 = stats['p99']

        if p99 > self.p99_threshold_ms:
            self.degradation_events += 1

            # Strategy 1: Reduce batch size
            if self.current_batch_size > 1:
                self.current_batch_size = max(1, self.current_batch_size // 2)
                print(f"[GPUScheduler] Auto-degrade: batch_size → {self.current_batch_size} "
                      f"(P99={p99:.2f}ms > {self.p99_threshold_ms}ms)",
                      file=sys.stderr, flush=True)
                return

            # Strategy 2: Reduce window
            if self.current_window_ms > 0.5:
                self.current_window_ms = max(0.5, self.current_window_ms / 2)
                print(f"[GPUScheduler] Auto-degrade: window → {self.current_window_ms}ms "
                      f"(P99={p99:.2f}ms > {self.p99_threshold_ms}ms)",
                      file=sys.stderr, flush=True)
                return

            # Strategy 3: Log warning
            print(f"[GPUScheduler] WARNING: P99={p99:.2f}ms exceeds threshold "
                  f"{self.p99_threshold_ms}ms (degradation limit reached)",
                  file=sys.stderr, flush=True)

    def get_stats(self) -> Dict[str, Any]:
        """
        Get scheduler statistics

        v1.4.1: Returns comprehensive metrics including auto-tuning state,
        detailed latency percentiles, throughput, and batch distributions.
        """
        # Legacy metrics (backward compatible)
        stats = self.metrics.get_percentiles()

        base_stats = {
            "enabled": self.enabled,
            "total_jobs": self.total_jobs,
            "total_batches": self.total_batches,
            "degradation_events": self.degradation_events,
            "current_batch_size": self.current_batch_size,
            "current_window_ms": self.current_window_ms,
            "queue_size": self.job_queue.qsize(),
            "latency_p50_ms": stats["p50"],
            "latency_p95_ms": stats["p95"],
            "latency_p99_ms": stats["p99"],
            "sample_count": stats["count"],
        }

        # v1.4.1: Add comprehensive metrics
        comprehensive_metrics = self.metrics_collector.export_json()
        base_stats["v1_4_1_metrics"] = comprehensive_metrics

        # v1.4.1: Add AdaptiveController state
        if self.adaptive_controller is not None and self.adaptive_controller.enabled:
            controller_metrics = self.adaptive_controller.get_metrics()
            base_stats["auto_tune"] = {
                "enabled": True,
                "current_batch_size": controller_metrics.current_batch_size,
                "p99_latency_ms": controller_metrics.p99_latency_ms,
                "ema_p99_ms": controller_metrics.ema_p99_ms,
                "batch_count": controller_metrics.batch_count,
                "adjustment_count": controller_metrics.adjustment_count,
                "degradation_events": controller_metrics.degradation_events,
                "stability_score": self.adaptive_controller.get_stability_score(),
                "recent_adjustments": controller_metrics.adjustment_history,
            }
        else:
            base_stats["auto_tune"] = {"enabled": False}

        # v1.4.1: Add Prometheus export URL
        if self.prometheus_exporter.is_running():
            base_stats["prometheus_url"] = self.prometheus_exporter.get_endpoint_url()

        return base_stats


# Global scheduler instance (lazy initialization)
_scheduler: Optional[GPUScheduler] = None
_scheduler_lock = threading.Lock()


def get_scheduler() -> GPUScheduler:
    """
    Get or create global GPU scheduler instance

    Configuration from environment variables:
        MLX_GPU_SCHEDULER=on|off (default: off)
        MLX_GPU_SCHEDULER_BATCH_SIZE=2-16 (default: 4)
        MLX_GPU_SCHEDULER_WINDOW_MS=0.75-5.0 (default: 1.0)
        MLX_GPU_SCHEDULER_P99_THRESHOLD_MS=50-500 (default: 100.0)

    Returns:
        Shared GPUScheduler instance
    """
    global _scheduler

    if _scheduler is None:
        with _scheduler_lock:
            if _scheduler is None:
                # Read configuration from environment
                # BUGFIX: Changed default from 'off' to 'on' to prevent Metal command buffer crashes
                enabled = os.getenv("MLX_GPU_SCHEDULER", "on").lower() == "on"
                batch_size = int(os.getenv("MLX_GPU_SCHEDULER_BATCH_SIZE", "4"))
                window_ms = float(os.getenv("MLX_GPU_SCHEDULER_WINDOW_MS", "1.0"))
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


async def initialize_scheduler() -> None:
    """Initialize and start the global scheduler"""
    scheduler = get_scheduler()
    await scheduler.start()


async def shutdown_scheduler() -> None:
    """Stop the global scheduler"""
    scheduler = get_scheduler()
    await scheduler.stop()
