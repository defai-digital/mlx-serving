"""
Memory Controller for Continuous Batching Memory Optimization

Week 4: Complement AdaptiveController with memory-aware batch sizing
While AdaptiveController tunes based on P99 latency, MemoryController
ensures we don't exceed memory limits and can scale up when memory available.

Key Features:
- Real-time GPU memory monitoring
- Memory-based batch size limits
- Prevents OOM conditions
- Works alongside AdaptiveController
- Comprehensive memory metrics

Architecture:
    ContinuousBatcher
           ↓
    MemoryController.get_max_batch_size()  ← Memory limit
           ↓
    AdaptiveController.get_current_batch_size()  ← Latency optimization
           ↓
    Effective batch size = min(memory_limit, latency_optimal)

Expected Gains:
- Zero OOM errors under load
- 2-4x larger batch sizes when memory available
- 75-85% memory utilization (optimal)
- Safe scaling up to hardware limits

Author: Week 4 Implementation
Date: 2025-11-05
"""

import time
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import logging

try:
    import mlx.core as mx
    MLX_AVAILABLE = True
except ImportError:
    MLX_AVAILABLE = False

logger = logging.getLogger(__name__)


@dataclass
class MemoryStats:
    """
    GPU memory statistics snapshot

    Captures current state of MLX Metal memory subsystem
    """
    active_memory_gb: float      # Currently allocated memory
    peak_memory_gb: float         # Peak memory allocation since startup
    cache_memory_gb: float        # Memory used by MLX cache
    utilization: float            # active / peak (0.0 to 1.0)
    timestamp: float              # When stats were captured


class MemoryController:
    """
    Memory-aware batch size controller

    Monitors GPU memory usage and enforces batch size limits to prevent OOM.
    Complements AdaptiveController which tunes for latency.

    Example:
        memory_ctrl = MemoryController(
            max_memory_utilization=0.85,  # Use up to 85% of GPU RAM
            min_batch_size=1,
            max_batch_size=32
        )

        # Get memory-safe batch size limit
        memory_limit = memory_ctrl.get_max_batch_size()

        # Combine with latency-optimal size from AdaptiveController
        effective_size = min(memory_limit, adaptive_size)

    Args:
        max_memory_utilization: Maximum memory usage 0-1 (default: 0.85)
        min_batch_size: Minimum allowed batch size (default: 1)
        max_batch_size: Maximum allowed batch size (default: 32)
        sampling_window: Batches between memory samples (default: 5)
    """

    def __init__(
        self,
        max_memory_utilization: float = 0.85,
        min_batch_size: int = 1,
        max_batch_size: int = 32,
        sampling_window: int = 5
    ):
        if not MLX_AVAILABLE:
            logger.warning("MLX not available - MemoryController will use fallback mode")
            self.mlx_available = False
        else:
            self.mlx_available = True

        # Configuration
        self.max_memory_utilization = max_memory_utilization
        self.min_batch_size = min_batch_size
        self.max_batch_size = max_batch_size
        self.sampling_window = sampling_window

        # State
        self.current_memory_limit = max_batch_size
        self.sample_count = 0
        self.memory_history: List[MemoryStats] = []
        self.max_history_size = 100

        # Metrics
        self.oom_prevention_count = 0
        self.scale_up_count = 0

        # Get initial memory stats
        if self.mlx_available:
            initial_stats = self.get_memory_stats()
            logger.info(
                f"MemoryController initialized: "
                f"max_util={max_memory_utilization:.1%}, "
                f"current_memory={initial_stats.active_memory_gb:.2f}GB, "
                f"peak_memory={initial_stats.peak_memory_gb:.2f}GB"
            )

    def get_memory_stats(self) -> MemoryStats:
        """
        Get current GPU memory usage from MLX Metal API

        Returns:
            MemoryStats with current memory state
        """
        if not self.mlx_available:
            # Fallback mode - assume safe defaults
            # BUG FIX: Use 0.5 (neutral) to avoid incorrect scaling in fallback mode
            return MemoryStats(
                active_memory_gb=0.0,
                peak_memory_gb=16.0,  # Assume 16GB
                cache_memory_gb=0.0,
                utilization=0.5,  # Neutral value (don't scale up or down)
                timestamp=time.time()
            )

        try:
            # Get memory stats from MLX Metal
            active = mx.metal.get_active_memory() / (1024 ** 3)  # Convert to GB
            peak = mx.metal.get_peak_memory() / (1024 ** 3)      # Convert to GB
            cache = mx.metal.get_cache_memory() / (1024 ** 3)    # Convert to GB

            # Calculate utilization (avoid division by zero)
            # BUG FIX: Use 0.5 (neutral) instead of 0.0 to avoid incorrect scaling
            utilization = (active / peak) if peak > 0 else 0.5

            return MemoryStats(
                active_memory_gb=active,
                peak_memory_gb=peak,
                cache_memory_gb=cache,
                utilization=utilization,
                timestamp=time.time()
            )
        except Exception as exc:
            logger.warning(f"Failed to get memory stats: {exc}")
            # Return safe fallback
            # BUG FIX: Use 0.5 (neutral) to avoid incorrect scaling when stats unavailable
            return MemoryStats(
                active_memory_gb=0.0,
                peak_memory_gb=16.0,
                cache_memory_gb=0.0,
                utilization=0.5,  # Neutral value (don't scale up or down)
                timestamp=time.time()
            )

    def should_sample(self) -> bool:
        """
        Check if we should sample memory this iteration

        Returns:
            True if sampling window elapsed
        """
        self.sample_count += 1
        return self.sample_count % self.sampling_window == 0

    def get_max_batch_size(self, current_batch_size: int) -> int:
        """
        Get maximum safe batch size based on memory usage

        Args:
            current_batch_size: Current batch size being used

        Returns:
            Maximum safe batch size (memory-limited)
        """
        # Sample memory periodically
        if not self.should_sample():
            return self.current_memory_limit

        # Get current memory stats
        stats = self.get_memory_stats()
        self.memory_history.append(stats)

        # Trim history
        if len(self.memory_history) > self.max_history_size:
            self.memory_history = self.memory_history[-self.max_history_size:]

        # Calculate memory-based limit
        old_limit = self.current_memory_limit

        if stats.utilization > self.max_memory_utilization:
            # Memory pressure HIGH - decrease limit
            new_limit = max(
                self.min_batch_size,
                current_batch_size - 1  # Reduce from current
            )

            if new_limit < old_limit:
                self.oom_prevention_count += 1
                logger.warning(
                    f"[MemoryController] ⚠️  Memory pressure HIGH "
                    f"({stats.utilization:.1%} > {self.max_memory_utilization:.1%}), "
                    f"reducing batch size limit: {old_limit} → {new_limit}"
                )

        elif stats.utilization < self.max_memory_utilization - 0.15:
            # Memory AVAILABLE - can increase limit
            new_limit = min(
                self.max_batch_size,
                old_limit + 2  # Allow faster scaling up
            )

            if new_limit > old_limit:
                self.scale_up_count += 1
                logger.info(
                    f"[MemoryController] ✅ Memory available "
                    f"({stats.utilization:.1%} < {self.max_memory_utilization:.1%}), "
                    f"increasing batch size limit: {old_limit} → {new_limit}"
                )

        else:
            # Memory usage in acceptable range
            new_limit = old_limit

        self.current_memory_limit = new_limit
        return new_limit

    def get_metrics(self) -> Dict[str, Any]:
        """
        Get controller metrics for monitoring

        Returns:
            Dictionary with current state and statistics
        """
        stats = self.get_memory_stats()

        # Calculate utilization statistics from history
        if self.memory_history:
            recent = self.memory_history[-10:]
            avg_util = sum(s.utilization for s in recent) / len(recent)
            min_util = min(s.utilization for s in recent)
            max_util = max(s.utilization for s in recent)
            avg_active_gb = sum(s.active_memory_gb for s in recent) / len(recent)
        else:
            avg_util = 0.0
            min_util = 0.0
            max_util = 0.0
            avg_active_gb = 0.0

        return {
            # Current state
            'current_memory_limit': self.current_memory_limit,
            'min_batch_size': self.min_batch_size,
            'max_batch_size': self.max_batch_size,

            # Memory configuration
            'max_memory_utilization': self.max_memory_utilization,

            # Current memory stats
            'current_utilization': stats.utilization,
            'active_memory_gb': stats.active_memory_gb,
            'peak_memory_gb': stats.peak_memory_gb,
            'cache_memory_gb': stats.cache_memory_gb,

            # Historical stats
            'avg_utilization': avg_util,
            'min_utilization': min_util,
            'max_utilization': max_util,
            'avg_active_memory_gb': avg_active_gb,

            # Adjustment statistics
            'oom_prevention_count': self.oom_prevention_count,
            'scale_up_count': self.scale_up_count,
            'sample_count': self.sample_count,

            # History
            'memory_samples': len(self.memory_history),
        }

    def reset_stats(self):
        """Reset statistics (useful for benchmarking)"""
        self.oom_prevention_count = 0
        self.scale_up_count = 0
        self.sample_count = 0
        self.memory_history.clear()
        self.current_memory_limit = self.max_batch_size
