"""
Adaptive Batch Controller for mlx-serving Phase 2.

This module implements adaptive batch sizing with EMA-based feedback for mlx-serving.
It monitors batch latency and dynamically adjusts batch size to maintain target latency
while maximizing throughput.

Algorithm:
- Use Exponential Moving Average (EMA) to smooth latency measurements
- Adjust batch size based on deviation from target latency
- Rate-limit adjustments to prevent oscillation
- Handle edge cases gracefully (cold start, extreme latency)

Part of mlx-serving Phase 2: Multi-Worker Scaling and Adaptive Batching
"""

import time
from typing import Dict, Any, Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


@dataclass
class AdaptiveBatchConfig:
    """Configuration for adaptive batch sizing."""

    enabled: bool = True
    min_batch_size: int = 2
    max_batch_size: int = 16
    target_latency_ms: float = 10.0
    ema_alpha: float = 0.3  # Smoothing factor (0-1, higher = more reactive)
    adjustment_interval_ms: float = 1000.0  # Min time between adjustments (milliseconds)


class AdaptiveBatchController:
    """
    Adaptive batch sizing controller using EMA-based feedback.

    Monitors batch processing latency and dynamically adjusts batch size
    to maintain target latency while maximizing throughput.

    Strategy:
    - If EMA latency < target * 0.9: Increase batch size (more throughput)
    - If EMA latency > target * 1.1: Decrease batch size (reduce latency)
    - Otherwise: Keep current size (within acceptable range)
    - Use EMA smoothing to avoid oscillations
    - Rate-limit adjustments to prevent thrashing

    Thread-safety: Designed for single-threaded async Python runtime.
    All methods should be called from the same event loop.
    """

    def __init__(self, config: AdaptiveBatchConfig):
        """
        Initialize the adaptive batch controller.

        Args:
            config: Controller configuration
        """
        self.config = config
        self.current_size = config.min_batch_size
        self.ema_latency = 0.0
        self.last_adjustment_time = 0.0
        self.total_batches = 0
        self.total_adjustments = 0
        self.size_increase_count = 0
        self.size_decrease_count = 0

        logger.info(
            f"AdaptiveBatchController initialized: enabled={config.enabled}, "
            f"size={self.current_size}, min={config.min_batch_size}, "
            f"max={config.max_batch_size}, alpha={config.ema_alpha}, "
            f"target={config.target_latency_ms}ms, interval={config.adjustment_interval_ms}ms"
        )

    def update(self, batch_latency_ms: float, batch_size: int) -> int:
        """
        Update controller with batch metrics and return recommended size.

        Args:
            batch_latency_ms: Actual latency of last batch (milliseconds)
            batch_size: Size of last batch

        Returns:
            Recommended batch size for next batch
        """
        # If disabled, always return min size
        if not self.config.enabled:
            return self.config.min_batch_size

        # Validate input
        if batch_latency_ms <= 0:
            logger.warning(
                f"Invalid batch latency: {batch_latency_ms}ms (must be > 0), "
                "skipping adjustment"
            )
            return self.current_size

        # Handle extremely high latency (>10x target) - emergency reduction
        if batch_latency_ms > self.config.target_latency_ms * 10:
            logger.warning(
                f"Extreme latency detected: {batch_latency_ms:.2f}ms "
                f"(>{self.config.target_latency_ms * 10:.2f}ms), "
                "reducing to minimum batch size"
            )
            self._apply_adjustment(self.config.min_batch_size, "extreme_latency")
            return self.current_size

        # Update EMA latency
        if self.ema_latency == 0.0:
            # Cold start: Initialize EMA with first measurement
            self.ema_latency = batch_latency_ms
            logger.info(f"EMA initialized: {self.ema_latency:.2f}ms (first batch)")
        else:
            # Standard EMA update: ema = alpha * current + (1 - alpha) * ema
            self.ema_latency = (
                self.config.ema_alpha * batch_latency_ms
                + (1 - self.config.ema_alpha) * self.ema_latency
            )

        self.total_batches += 1

        # Check if enough time has passed since last adjustment
        current_time_ms = time.time() * 1000  # Convert to milliseconds
        time_since_last_adjustment = current_time_ms - self.last_adjustment_time

        if time_since_last_adjustment < self.config.adjustment_interval_ms:
            # Too soon to adjust, return current size
            return self.current_size

        # Calculate adjustment based on EMA latency
        new_size = self._calculate_adjustment()

        # Apply adjustment if size changed
        if new_size != self.current_size:
            self._apply_adjustment(new_size, "periodic_adjustment")

        return self.current_size

    def _calculate_adjustment(self) -> int:
        """
        Calculate new batch size based on EMA latency.

        Returns:
            New batch size (may be same as current)
        """
        target = self.config.target_latency_ms
        lower_bound = target * 0.9  # 10% below target
        upper_bound = target * 1.1  # 10% above target

        current_size = self.current_size

        # Decision logic based on ±10% target latency band
        if self.ema_latency < lower_bound:
            # Latency is good, increase batch size for more throughput
            new_size = min(self.config.max_batch_size, current_size + 1)
            if new_size != current_size:
                logger.debug(
                    f"EMA latency {self.ema_latency:.2f}ms < {lower_bound:.2f}ms, "
                    f"increasing batch size: {current_size} -> {new_size}"
                )
        elif self.ema_latency > upper_bound:
            # Latency is high, decrease batch size to reduce latency
            new_size = max(self.config.min_batch_size, current_size - 1)
            if new_size != current_size:
                logger.debug(
                    f"EMA latency {self.ema_latency:.2f}ms > {upper_bound:.2f}ms, "
                    f"decreasing batch size: {current_size} -> {new_size}"
                )
        else:
            # Latency is acceptable, keep current size
            new_size = current_size
            logger.debug(
                f"EMA latency {self.ema_latency:.2f}ms within acceptable range "
                f"[{lower_bound:.2f}ms, {upper_bound:.2f}ms], "
                f"keeping batch size: {current_size}"
            )

        return new_size

    def _apply_adjustment(self, new_size: int, reason: str):
        """
        Apply batch size adjustment and update statistics.

        Args:
            new_size: New batch size to apply
            reason: Reason for adjustment (for logging)
        """
        old_size = self.current_size
        self.current_size = new_size
        self.last_adjustment_time = time.time() * 1000  # milliseconds

        # Update adjustment counters
        if new_size > old_size:
            self.size_increase_count += 1
        elif new_size < old_size:
            self.size_decrease_count += 1

        if new_size != old_size:
            self.total_adjustments += 1
            logger.info(
                f"Batch size adjusted: {old_size} -> {new_size} "
                f"(reason: {reason}, EMA: {self.ema_latency:.2f}ms, "
                f"adjustments: {self.total_adjustments})"
            )

    def get_recommended_size(self) -> int:
        """Get current recommended batch size."""
        return self.current_size

    def get_stats(self) -> Dict[str, Any]:
        """
        Get controller statistics.

        Returns:
            Dictionary with current state and statistics
        """
        return {
            'current_size': self.current_size,
            'ema_latency_ms': self.ema_latency,
            'total_batches': self.total_batches,
            'total_adjustments': self.total_adjustments,
            'size_increase_count': self.size_increase_count,
            'size_decrease_count': self.size_decrease_count,
            'target_latency_ms': self.config.target_latency_ms,
        }

    def reset(self):
        """Reset controller state."""
        self.current_size = self.config.min_batch_size
        self.ema_latency = 0.0
        self.last_adjustment_time = 0.0
        self.total_batches = 0
        self.total_adjustments = 0
        self.size_increase_count = 0
        self.size_decrease_count = 0

        logger.info("AdaptiveBatchController reset")


# Unit test helper functions
def create_test_controller(
    min_size: int = 2,
    max_size: int = 16,
    target_ms: float = 10.0,
    alpha: float = 0.3,
) -> AdaptiveBatchController:
    """
    Create a test controller with specified parameters.

    Args:
        min_size: Minimum batch size
        max_size: Maximum batch size
        target_ms: Target latency in milliseconds
        alpha: EMA smoothing factor

    Returns:
        Configured AdaptiveBatchController instance
    """
    config = AdaptiveBatchConfig(
        enabled=True,
        min_batch_size=min_size,
        max_batch_size=max_size,
        target_latency_ms=target_ms,
        ema_alpha=alpha,
        adjustment_interval_ms=0,  # No rate limiting for tests
    )
    return AdaptiveBatchController(config)


def simulate_batch_sequence(
    controller: AdaptiveBatchController,
    latencies_ms: list[float],
    batch_sizes: Optional[list[int]] = None,
) -> list[int]:
    """
    Simulate a sequence of batches and return recommended sizes.

    Args:
        controller: Controller instance
        latencies_ms: List of batch latencies (milliseconds)
        batch_sizes: Optional list of batch sizes (defaults to recommended sizes)

    Returns:
        List of recommended batch sizes after each update
    """
    recommended_sizes = []

    if batch_sizes is None:
        batch_sizes = [controller.current_size] * len(latencies_ms)

    for latency, size in zip(latencies_ms, batch_sizes):
        recommended = controller.update(latency, size)
        recommended_sizes.append(recommended)

    return recommended_sizes
