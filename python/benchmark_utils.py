"""
Benchmark utilities - Lightweight logging and optimizations for benchmark mode

Benchmark mode (MLX_BENCHMARK_MODE=1) disables non-critical operations to minimize overhead:
- Verbose logging (saves ~2-3ms per request)
- Performance metrics collection
- Debug output

This allows fair performance comparisons by reducing non-inference overhead.
"""

import os
import sys
from typing import Any, Optional


# Global benchmark mode flag (cached on import)
_BENCHMARK_MODE = os.getenv("MLX_BENCHMARK_MODE", "").strip() == "1"


def is_benchmark_mode() -> bool:
    """
    Check if running in benchmark mode

    Returns:
        True if MLX_BENCHMARK_MODE=1 is set
    """
    return _BENCHMARK_MODE


class BenchmarkAwareLogger:
    """
    Logger that respects benchmark mode

    In benchmark mode (MLX_BENCHMARK_MODE=1):
    - info/debug calls are no-ops (saves ~0.1-0.3ms per call)
    - warning/error calls still work (critical for debugging)

    Usage:
        logger = BenchmarkAwareLogger("module_name")
        logger.info("This won't print in benchmark mode")
        logger.error("This always prints")
    """

    def __init__(self, name: str):
        """
        Initialize logger

        Args:
            name: Logger name (typically module name)
        """
        self.name = name
        self.benchmark_mode = _BENCHMARK_MODE

    def _format_message(self, level: str, msg: str, **kwargs: Any) -> str:
        """Format log message with context"""
        if kwargs:
            ctx = " ".join(f"{k}={v}" for k, v in kwargs.items())
            return f"[{self.name}] {level}: {msg} ({ctx})"
        return f"[{self.name}] {level}: {msg}"

    def debug(self, msg: str, **kwargs: Any) -> None:
        """
        Log debug message (disabled in benchmark mode)

        Args:
            msg: Message to log
            **kwargs: Optional context key-value pairs
        """
        if not self.benchmark_mode:
            print(self._format_message("DEBUG", msg, **kwargs), file=sys.stderr, flush=True)

    def info(self, msg: str, **kwargs: Any) -> None:
        """
        Log info message (disabled in benchmark mode)

        Args:
            msg: Message to log
            **kwargs: Optional context key-value pairs
        """
        if not self.benchmark_mode:
            print(self._format_message("INFO", msg, **kwargs), file=sys.stderr, flush=True)

    def warning(self, msg: str, **kwargs: Any) -> None:
        """
        Log warning message (always enabled)

        Args:
            msg: Message to log
            **kwargs: Optional context key-value pairs
        """
        print(self._format_message("WARNING", msg, **kwargs), file=sys.stderr, flush=True)

    def error(self, msg: str, **kwargs: Any) -> None:
        """
        Log error message (always enabled)

        Args:
            msg: Message to log
            **kwargs: Optional context key-value pairs
        """
        print(self._format_message("ERROR", msg, **kwargs), file=sys.stderr, flush=True)


# Convenience function for quick checks
def should_skip_verbose_logging() -> bool:
    """
    Check if verbose logging should be skipped

    Returns:
        True if in benchmark mode (skip verbose logging)
    """
    return _BENCHMARK_MODE
