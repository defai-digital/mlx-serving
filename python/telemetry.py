"""
Enhanced Telemetry for MLX Runtime (Phase 1.3)

Lightweight performance monitoring with <3% overhead.
Tracks generation, tokenization, and runtime metrics.
"""

import time
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
import random


@dataclass
class TelemetryStats:
    """Statistics for telemetry tracking"""
    generate_calls: int = 0
    tokenize_calls: int = 0
    total_tokens: int = 0
    total_generate_time_ms: float = 0.0
    total_tokenize_time_ms: float = 0.0
    generate_latencies_ms: List[float] = field(default_factory=list)
    tokenize_latencies_ms: List[float] = field(default_factory=list)
    errors: int = 0
    timeouts: int = 0


class RuntimeTelemetry:
    """
    Lightweight telemetry system for MLX runtime

    Features:
    - Percentile latency tracking (p50, p95, p99)
    - Rolling window (1000 samples max)
    - Configurable sampling rate
    - <3% overhead (when sampling_rate=1.0)

    Performance:
    - record_generate(): ~0.1ms overhead
    - get_report(): ~1ms for 1000 samples
    """

    def __init__(self, enabled: bool = True, sampling_rate: float = 1.0):
        """
        Initialize telemetry system

        Args:
            enabled: Enable/disable telemetry
            sampling_rate: Probability of recording an event (0.01-1.0)
                          1.0 = 100%, 0.01 = 1% sampling
        """
        self.enabled = enabled
        self.sampling_rate = max(0.01, min(1.0, sampling_rate))
        self.stats = TelemetryStats()
        self._max_samples = 1000  # Rolling window size

    def record_generate(
        self,
        duration_ms: float,
        tokens: int,
        success: bool = True
    ) -> None:
        """
        Record a text generation event

        Args:
            duration_ms: Generation time in milliseconds
            tokens: Number of tokens generated
            success: Whether generation succeeded
        """
        if not self.enabled:
            return

        # Sampling: skip with probability (1 - sampling_rate)
        if self.sampling_rate < 1.0 and random.random() > self.sampling_rate:
            return

        self.stats.generate_calls += 1
        self.stats.total_tokens += tokens
        self.stats.total_generate_time_ms += duration_ms
        self.stats.generate_latencies_ms.append(duration_ms)

        if not success:
            self.stats.errors += 1

        # Maintain rolling window
        if len(self.stats.generate_latencies_ms) > self._max_samples:
            self.stats.generate_latencies_ms = self.stats.generate_latencies_ms[-self._max_samples:]

    def record_tokenize(
        self,
        duration_ms: float,
        tokens: int
    ) -> None:
        """
        Record a tokenization event

        Args:
            duration_ms: Tokenization time in milliseconds
            tokens: Number of tokens processed
        """
        if not self.enabled:
            return

        # Sampling
        if self.sampling_rate < 1.0 and random.random() > self.sampling_rate:
            return

        self.stats.tokenize_calls += 1
        self.stats.total_tokenize_time_ms += duration_ms
        self.stats.tokenize_latencies_ms.append(duration_ms)

        # Maintain rolling window
        if len(self.stats.tokenize_latencies_ms) > self._max_samples:
            self.stats.tokenize_latencies_ms = self.stats.tokenize_latencies_ms[-self._max_samples:]

    def record_error(self, is_timeout: bool = False) -> None:
        """Record an error event"""
        if not self.enabled:
            return

        self.stats.errors += 1
        if is_timeout:
            self.stats.timeouts += 1

    def get_report(self) -> Dict[str, Any]:
        """
        Get comprehensive telemetry report

        Returns:
            Dictionary with performance metrics including percentiles
        """
        if not self.enabled:
            return {"enabled": False}

        report: Dict[str, Any] = {
            "enabled": True,
            "sampling_rate": self.sampling_rate,
            "generation": self._get_generation_metrics(),
            "tokenization": self._get_tokenization_metrics(),
            "errors": {
                "total": self.stats.errors,
                "timeouts": self.stats.timeouts,
                "error_rate": (
                    self.stats.errors / max(1, self.stats.generate_calls + self.stats.tokenize_calls)
                )
            }
        }

        return report

    def _get_generation_metrics(self) -> Dict[str, Any]:
        """Calculate generation performance metrics"""
        if self.stats.generate_calls == 0:
            return {
                "calls": 0,
                "total_tokens": 0
            }

        latencies = sorted(self.stats.generate_latencies_ms)

        metrics = {
            "calls": self.stats.generate_calls,
            "total_tokens": self.stats.total_tokens,
            "avg_tokens_per_call": self.stats.total_tokens / self.stats.generate_calls,
            "latency_ms": {
                "mean": self.stats.total_generate_time_ms / self.stats.generate_calls,
                "min": min(latencies) if latencies else 0,
                "max": max(latencies) if latencies else 0,
            },
            "throughput": {
                "tokens_per_second": (
                    (self.stats.total_tokens / (self.stats.total_generate_time_ms / 1000.0))
                    if self.stats.total_generate_time_ms > 0 else 0
                )
            }
        }

        # Calculate percentiles if we have samples
        if len(latencies) >= 10:
            metrics["latency_ms"]["p50"] = self._percentile(latencies, 0.50)
            metrics["latency_ms"]["p95"] = self._percentile(latencies, 0.95)
            metrics["latency_ms"]["p99"] = self._percentile(latencies, 0.99)

        return metrics

    def _get_tokenization_metrics(self) -> Dict[str, Any]:
        """Calculate tokenization performance metrics"""
        if self.stats.tokenize_calls == 0:
            return {
                "calls": 0
            }

        latencies = sorted(self.stats.tokenize_latencies_ms)

        metrics = {
            "calls": self.stats.tokenize_calls,
            "latency_ms": {
                "mean": self.stats.total_tokenize_time_ms / self.stats.tokenize_calls,
                "min": min(latencies) if latencies else 0,
                "max": max(latencies) if latencies else 0,
            }
        }

        # Calculate percentiles if we have samples
        if len(latencies) >= 10:
            metrics["latency_ms"]["p50"] = self._percentile(latencies, 0.50)
            metrics["latency_ms"]["p95"] = self._percentile(latencies, 0.95)
            metrics["latency_ms"]["p99"] = self._percentile(latencies, 0.99)

        return metrics

    @staticmethod
    def _percentile(sorted_values: List[float], percentile: float) -> float:
        """
        Calculate percentile from sorted values

        Args:
            sorted_values: Sorted list of values
            percentile: Percentile to calculate (0.0-1.0)

        Returns:
            Percentile value
        """
        if not sorted_values:
            return 0.0

        n = len(sorted_values)
        index = int(percentile * n)

        # Ensure index is within bounds
        index = min(index, n - 1)

        return sorted_values[index]

    def reset(self) -> None:
        """Reset all statistics"""
        self.stats = TelemetryStats()

    def get_stats_summary(self) -> str:
        """Get a human-readable summary of statistics"""
        report = self.get_report()

        if not report.get("enabled"):
            return "Telemetry disabled"

        lines = ["=== Telemetry Report ==="]

        # Generation stats
        gen = report.get("generation", {})
        if gen.get("calls", 0) > 0:
            lines.append(f"\nGeneration:")
            lines.append(f"  Calls: {gen['calls']}")
            lines.append(f"  Total tokens: {gen['total_tokens']}")
            lines.append(f"  Avg tokens/call: {gen['avg_tokens_per_call']:.1f}")
            lines.append(f"  Throughput: {gen['throughput']['tokens_per_second']:.1f} tokens/s")

            lat = gen['latency_ms']
            lines.append(f"  Latency: mean={lat['mean']:.2f}ms, min={lat['min']:.2f}ms, max={lat['max']:.2f}ms")
            if 'p95' in lat:
                lines.append(f"  Percentiles: p50={lat['p50']:.2f}ms, p95={lat['p95']:.2f}ms, p99={lat['p99']:.2f}ms")

        # Tokenization stats
        tok = report.get("tokenization", {})
        if tok.get("calls", 0) > 0:
            lines.append(f"\nTokenization:")
            lines.append(f"  Calls: {tok['calls']}")

            lat = tok['latency_ms']
            lines.append(f"  Latency: mean={lat['mean']:.2f}ms, min={lat['min']:.2f}ms, max={lat['max']:.2f}ms")
            if 'p95' in lat:
                lines.append(f"  Percentiles: p50={lat['p50']:.2f}ms, p95={lat['p95']:.2f}ms, p99={lat['p99']:.2f}ms")

        # Error stats
        errors = report.get("errors", {})
        if errors.get("total", 0) > 0:
            lines.append(f"\nErrors:")
            lines.append(f"  Total: {errors['total']}")
            lines.append(f"  Timeouts: {errors['timeouts']}")
            lines.append(f"  Error rate: {errors['error_rate']*100:.2f}%")

        return "\n".join(lines)
