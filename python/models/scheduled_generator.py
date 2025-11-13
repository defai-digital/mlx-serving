"""
Scheduled Generator - GPU Scheduler integration for MLX generation

This module provides a wrapper around the standard generator that routes
MLX operations through the GPU scheduler for stability.

Key Features:
    - Transparent drop-in replacement for generate_stream()
    - Serializes GPU command buffer submissions
    - Maintains all existing features (streaming, cancellation, metrics)
    - Zero-overhead when scheduler is disabled
"""

import asyncio
from typing import Any, Callable, Dict, Optional
import sys

# Import GPU scheduler
try:
    from gpu_scheduler import get_scheduler, JobPriority, GPUScheduler
    GPU_SCHEDULER_AVAILABLE = True
except ImportError:
    GPU_SCHEDULER_AVAILABLE = False
    print("[ScheduledGenerator] GPU scheduler not available - using direct mode",
          file=sys.stderr, flush=True)

# Import standard generator
from models.generator import stream_generate as _standard_stream_generate
from models.loader import ModelHandle


async def stream_generate(
    handle: ModelHandle,
    params: Dict[str, Any],
    emit_chunk: Callable,
    emit_stats: Callable,
    emit_event: Callable,
    chunk_pool=None,
    stats_pool=None,
    event_pool=None,
    priority: str = "default",
) -> None:
    """
    Generate tokens with GPU scheduler integration

    This is a drop-in replacement for models.generator.stream_generate() that
    routes the operation through the GPU scheduler when enabled.

    Args:
        handle: ModelHandle for the loaded model
        params: Generation parameters (including prompt, stream_id, etc.)
        emit_chunk: Callback for emitting token chunks
        emit_stats: Callback for emitting stats
        emit_event: Callback for emitting events
        priority: Job priority ("urgent", "default", "background")

    Environment:
        MLX_GPU_SCHEDULER=on|off - Enable/disable scheduler (default: off)

    When scheduler is disabled (default):
        - Falls through to standard stream_generate() immediately
        - Zero overhead, identical behavior

    When scheduler is enabled:
        - Routes through GPU scheduler for serialized GPU access
        - Prevents concurrent Metal command buffer submissions
        - Adds P99 monitoring and auto-degradation
    """
    # Check if scheduler is enabled
    if not GPU_SCHEDULER_AVAILABLE:
        # Scheduler not available - use standard path
        return await _standard_stream_generate(
            handle, params, emit_chunk, emit_stats, emit_event,
            chunk_pool, stats_pool, event_pool
        )

    scheduler = get_scheduler()

    if not scheduler.enabled:
        # Scheduler disabled - use standard path (zero overhead)
        return await _standard_stream_generate(
            handle, params, emit_chunk, emit_stats, emit_event,
            chunk_pool, stats_pool, event_pool
        )

    # Scheduler enabled - route through it
    priority_enum = _parse_priority(priority)
    stream_id = params.get("stream_id", "unknown")

    # Wrap generation in scheduler
    async def gpu_operation():
        """GPU operation to be scheduled"""
        return await _standard_stream_generate(
            handle, params, emit_chunk, emit_stats, emit_event,
            chunk_pool, stats_pool, event_pool
        )

    # Schedule the operation
    try:
        await scheduler.schedule(
            operation=gpu_operation,
            priority=priority_enum,
            job_id=f"generate_{stream_id}",
        )
    except Exception as exc:
        # Log scheduler error and fall back to direct execution
        print(f"[ScheduledGenerator] Scheduler error for stream {stream_id}: {exc}, "
              f"falling back to direct execution",
              file=sys.stderr, flush=True)
        return await _standard_stream_generate(
            handle, params, emit_chunk, emit_stats, emit_event,
            chunk_pool, stats_pool, event_pool
        )


def _parse_priority(priority: str) -> 'JobPriority':
    """Parse priority string to JobPriority enum"""
    if not GPU_SCHEDULER_AVAILABLE:
        return None  # type: ignore

    priority_lower = priority.lower()
    if priority_lower == "urgent":
        return JobPriority.URGENT
    elif priority_lower == "background":
        return JobPriority.BACKGROUND
    else:
        return JobPriority.DEFAULT


# Export scheduler control functions
async def initialize_gpu_scheduler() -> None:
    """Initialize the GPU scheduler (call from runtime startup)"""
    if not GPU_SCHEDULER_AVAILABLE:
        return

    from gpu_scheduler import initialize_scheduler
    await initialize_scheduler()

    scheduler = get_scheduler()
    if scheduler.enabled:
        print(f"[ScheduledGenerator] GPU scheduler initialized: "
              f"batch_size={scheduler.max_batch_size}, "
              f"window={scheduler.batch_window_ms}ms, "
              f"p99_threshold={scheduler.p99_threshold_ms}ms",
              file=sys.stderr, flush=True)
    else:
        print("[ScheduledGenerator] GPU scheduler disabled (using direct mode)",
              file=sys.stderr, flush=True)


async def shutdown_gpu_scheduler() -> None:
    """Shutdown the GPU scheduler (call from runtime shutdown)"""
    if not GPU_SCHEDULER_AVAILABLE:
        return

    from gpu_scheduler import shutdown_scheduler
    await shutdown_scheduler()


def get_gpu_scheduler_stats() -> Optional[Dict[str, Any]]:
    """Get GPU scheduler statistics (for telemetry)"""
    if not GPU_SCHEDULER_AVAILABLE:
        return None

    scheduler = get_scheduler()
    return scheduler.get_stats()
