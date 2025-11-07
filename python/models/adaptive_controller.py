"""
Adaptive Controller for GPU Scheduler Auto-Tuning.

This module implements load-aware batch size adjustment using EMA smoothing
and P99 latency feedback to optimize GPU scheduler performance.

Part of kr-serve-mlx v1.4.1 upgrade.
"""

import os
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)


@dataclass
class ControllerConfig:
    """Configuration for AdaptiveController."""

    min_batch_size: int = 2
    max_batch_size: int = 8
    ema_alpha: float = 0.3  # Exponential moving average smoothing factor
    adjustment_interval: int = 10  # Adjust every N batches
    p99_target_ms: float = 100.0  # Target P99 latency in milliseconds
    p99_tolerance_ms: float = 20.0  # Tolerance before adjustment
    degradation_threshold: float = 2.0  # Multiplier for degradation detection
    max_adjustment_step: int = 1  # Maximum batch size change per adjustment

    @classmethod
    def from_env(cls) -> 'ControllerConfig':
        """Load configuration from environment variables."""
        return cls(
            min_batch_size=int(os.getenv('MLX_AUTO_TUNE_MIN_BATCH', '2')),
            max_batch_size=int(os.getenv('MLX_AUTO_TUNE_MAX_BATCH', '8')),
            ema_alpha=float(os.getenv('MLX_AUTO_TUNE_EMA_ALPHA', '0.3')),
            adjustment_interval=int(os.getenv('MLX_AUTO_TUNE_INTERVAL', '10')),
            p99_target_ms=float(os.getenv('MLX_GPU_SCHEDULER_P99_THRESHOLD_MS', '100.0')),
        )


@dataclass
class ControllerMetrics:
    """Metrics tracked by the controller."""

    current_batch_size: int
    p99_latency_ms: float
    ema_p99_ms: float
    batch_count: int
    adjustment_count: int
    degradation_events: int
    last_adjustment_time: float
    adjustment_history: List[Tuple[float, int, str]] = field(default_factory=list)  # (timestamp, batch_size, reason)


class AdaptiveController:
    """
    Adaptive batch size controller using EMA and P99 latency feedback.

    The controller monitors P99 latency and adjusts batch size to maintain
    optimal throughput while staying within latency targets.

    Strategy:
    - If P99 latency is below target: Increase batch size (more throughput)
    - If P99 latency is above target: Decrease batch size (reduce latency)
    - Use EMA smoothing to avoid oscillations
    - Detect degradation events for automatic fallback
    """

    def __init__(self, config: Optional[ControllerConfig] = None):
        """
        Initialize the adaptive controller.

        Args:
            config: Controller configuration. If None, loads from environment.
        """
        self.config = config or ControllerConfig.from_env()
        self.enabled = os.getenv('MLX_AUTO_TUNE', 'off').lower() == 'on'

        # State
        self.current_batch_size = self.config.min_batch_size
        self.batch_count = 0
        self.adjustment_count = 0
        self.degradation_events = 0

        # EMA state
        self.ema_p99_ms: Optional[float] = None
        self.p99_history: List[float] = []

        # Timing
        self.last_adjustment_time = time.time()
        self.adjustment_history: List[Tuple[float, int, str]] = []

        logger.info(
            f"AdaptiveController initialized: enabled={self.enabled}, "
            f"batch_size={self.current_batch_size}, "
            f"min={self.config.min_batch_size}, max={self.config.max_batch_size}, "
            f"alpha={self.config.ema_alpha}, target_p99={self.config.p99_target_ms}ms"
        )

    def update(self, p99_latency_ms: float) -> Tuple[int, bool]:
        """
        Update controller with new P99 latency measurement.

        Args:
            p99_latency_ms: Current P99 latency in milliseconds

        Returns:
            Tuple of (new_batch_size, adjustment_made)
        """
        if not self.enabled:
            return self.current_batch_size, False

        # Update EMA
        if self.ema_p99_ms is None:
            self.ema_p99_ms = p99_latency_ms
        else:
            self.ema_p99_ms = (
                self.config.ema_alpha * p99_latency_ms +
                (1 - self.config.ema_alpha) * self.ema_p99_ms
            )

        self.p99_history.append(p99_latency_ms)
        self.batch_count += 1

        # Check for degradation (sudden spike)
        if self._detect_degradation(p99_latency_ms):
            self.degradation_events += 1
            logger.warning(
                f"Degradation detected: P99={p99_latency_ms:.2f}ms, "
                f"EMA={self.ema_p99_ms:.2f}ms, threshold={self.config.p99_target_ms * self.config.degradation_threshold:.2f}ms"
            )
            # Emergency batch size reduction
            new_size = max(self.config.min_batch_size, self.current_batch_size - 2)
            if new_size != self.current_batch_size:
                self._apply_adjustment(new_size, "degradation_emergency")
                return new_size, True

        # Check if adjustment interval reached
        if self.batch_count % self.config.adjustment_interval == 0:
            new_size = self._calculate_adjustment()
            if new_size != self.current_batch_size:
                self._apply_adjustment(new_size, "periodic_adjustment")
                return new_size, True

        return self.current_batch_size, False

    def _detect_degradation(self, p99_latency_ms: float) -> bool:
        """Detect if current latency indicates degradation."""
        if self.ema_p99_ms is None:
            return False

        # Degradation if latency exceeds threshold by multiplier
        threshold = self.config.p99_target_ms * self.config.degradation_threshold
        return p99_latency_ms > threshold and p99_latency_ms > self.ema_p99_ms * 1.5

    def _calculate_adjustment(self) -> int:
        """
        Calculate new batch size based on EMA P99 latency.

        Returns:
            New batch size (may be same as current)
        """
        if self.ema_p99_ms is None:
            return self.current_batch_size

        current_size = self.current_batch_size
        target = self.config.p99_target_ms
        tolerance = self.config.p99_tolerance_ms

        # Calculate latency deviation
        deviation = self.ema_p99_ms - target

        # Decision logic
        if deviation < -tolerance:
            # P99 well below target -> increase batch size for more throughput
            new_size = min(
                self.config.max_batch_size,
                current_size + self.config.max_adjustment_step
            )
            reason = f"p99_below_target (EMA={self.ema_p99_ms:.2f}ms < target={target:.2f}ms)"
        elif deviation > tolerance:
            # P99 above target -> decrease batch size to reduce latency
            new_size = max(
                self.config.min_batch_size,
                current_size - self.config.max_adjustment_step
            )
            reason = f"p99_above_target (EMA={self.ema_p99_ms:.2f}ms > target={target:.2f}ms)"
        else:
            # Within tolerance -> no change
            new_size = current_size
            reason = f"within_tolerance (EMA={self.ema_p99_ms:.2f}ms)"

        if new_size != current_size:
            logger.info(
                f"Auto-tuning decision: {current_size} -> {new_size} ({reason})"
            )

        return new_size

    def _apply_adjustment(self, new_size: int, reason: str):
        """Apply batch size adjustment and record history."""
        old_size = self.current_batch_size
        self.current_batch_size = new_size
        self.adjustment_count += 1
        self.last_adjustment_time = time.time()

        self.adjustment_history.append((
            time.time(),
            new_size,
            reason
        ))

        # Keep history bounded
        if len(self.adjustment_history) > 100:
            self.adjustment_history = self.adjustment_history[-100:]

        logger.info(
            f"Batch size adjusted: {old_size} -> {new_size} (reason: {reason}, "
            f"adjustments: {self.adjustment_count}, batches: {self.batch_count})"
        )

    def get_metrics(self) -> ControllerMetrics:
        """Get current controller metrics."""
        return ControllerMetrics(
            current_batch_size=self.current_batch_size,
            p99_latency_ms=self.p99_history[-1] if self.p99_history else 0.0,
            ema_p99_ms=self.ema_p99_ms or 0.0,
            batch_count=self.batch_count,
            adjustment_count=self.adjustment_count,
            degradation_events=self.degradation_events,
            last_adjustment_time=self.last_adjustment_time,
            adjustment_history=self.adjustment_history[-10:]  # Last 10 adjustments
        )

    def reset(self):
        """Reset controller state (keeps configuration)."""
        self.current_batch_size = self.config.min_batch_size
        self.batch_count = 0
        self.adjustment_count = 0
        self.degradation_events = 0
        self.ema_p99_ms = None
        self.p99_history.clear()
        self.adjustment_history.clear()
        self.last_adjustment_time = time.time()

        logger.info("AdaptiveController reset")

    def get_current_batch_size(self) -> int:
        """Get current recommended batch size."""
        return self.current_batch_size

    def get_stability_score(self) -> float:
        """
        Calculate stability score (0.0 to 1.0).

        Returns:
            1.0 = very stable (few adjustments)
            0.0 = very unstable (many adjustments)
        """
        if self.batch_count == 0:
            return 1.0

        # Score based on adjustment frequency
        adjustment_rate = self.adjustment_count / max(1, self.batch_count)
        stability = max(0.0, 1.0 - (adjustment_rate * 10))  # 10% adjustment = 0 score

        return stability
