"""
Generator module - Streaming token generation with MLX

Responsibilities:
- Bridge blocking MLX generation into asyncio
- Emit streaming notifications (chunk, stats, event)
- Measure TTFT and throughput
- Handle stop sequences and generation parameters
"""

import asyncio
import math
import time
import threading
import os
from time import perf_counter
from typing import Any, Callable, Dict, Optional

# Import configuration loader
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from config_loader import get_config

# Reuse loader's platform probe to avoid SIGABRT on unsupported hosts (Bug #1 P0)
from models.loader import ModelHandle, MLX_AVAILABLE, MLX_IMPORT_ERROR

mlx_generate = None  # type: ignore[assignment]
MLX_GENERATE_AVAILABLE = False
MLX_GENERATE_ERROR: Optional[str] = None

if MLX_AVAILABLE:
    try:
        from mlx_lm import stream_generate as mlx_generate  # type: ignore[assignment]

        MLX_GENERATE_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001
        MLX_GENERATE_AVAILABLE = False
        MLX_GENERATE_ERROR = f"mlx-lm stream_generate import failed: {exc}"
else:
    MLX_GENERATE_ERROR = MLX_IMPORT_ERROR or "mlx-lm not available"

from adapters import outlines_adapter
from errors import GenerationError, GuidanceError
from validators import validate_generation_params

# Note: SUPPORTED_DTYPES is now loaded from config dynamically
# See ensure_model_dtype() for usage

# PERFORMANCE OPT: Conditional Metal sync counter
# Sync every N requests instead of every request to reduce overhead
_metal_sync_counter = 0
_metal_sync_interval = int(os.getenv('MLX_METAL_SYNC_INTERVAL', '3'))  # Sync every 3 requests by default


def ensure_model_dtype(handle: ModelHandle, params: Dict[str, Any]) -> None:
    """
    Validate model dtype compatibility

    Args:
        handle: ModelHandle to check
        params: Generation parameters (may contain required_dtype)

    Raises:
        GenerationError: If dtype mismatch or unsupported
    """
    config = get_config()
    requested = params.get("required_dtype")
    model_dtype = handle.metadata.get("dtype", "unknown").lower()

    if requested and requested.lower() != model_dtype:
        raise GenerationError(
            handle.model_id, f"dtype mismatch: model {model_dtype}, requested {requested}"
        )

    if model_dtype not in config.supported_dtypes and model_dtype != "unknown":
        raise GenerationError(handle.model_id, f"Unsupported dtype {model_dtype}")


def build_generation_kwargs(params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Map JSON-RPC parameters to MLX generation kwargs

    Args:
        params: Generation parameters from JSON-RPC

    Returns:
        Clean kwargs dict for mlx_lm.stream_generate()

    Note:
        mlx_lm.stream_generate() accepts limited parameters:
        - max_tokens: int
        - verbose: bool
        - formatter: callable (for output formatting)

        Sampling parameters (temperature, top_p, etc.) are NOT accepted directly.
        They must be implemented via custom sampler if needed in the future.

        P1-1: draft_model parameter is accepted but not yet implemented in mlx-lm.
        This is forwarded through for API compatibility with mlx-engine.
    """
    # Load config for defaults
    config = get_config()

    # Only pass parameters that stream_generate actually accepts
    # Based on MLX 0.29.3 / mlx-lm 0.28.3, stream_generate only accepts:
    # - max_tokens (int)
    kwargs = {
        "max_tokens": params.get("max_tokens", config.default_max_tokens),
    }

    # P1-1: Extract draft_model parameter (for future implementation)
    # mlx-lm does not currently support speculative decoding in stream_generate
    # But we accept the parameter for API compatibility with mlx-engine
    draft_model = params.get("draft_model")
    if draft_model:
        # Log warning that draft models are not yet supported
        print(
            f"Warning: draft_model '{draft_model}' specified but not supported by mlx-lm stream_generate. "
            "Speculative decoding is planned for future implementation.",
            file=sys.stderr,
            flush=True
        )
        # TODO: Implement speculative decoding when mlx-lm supports it
        # This will require loading the draft model handle and passing it to generation

    # TODO: Implement proper sampler support for temperature, top_p, etc.
    # For now, we use MLX defaults which work well for most cases

    # Note: stop sequences and other advanced parameters may need special handling
    # via custom samplers or formatters in future versions

    # Remove None values; MLX expects clean kwargs
    return {k: v for k, v in kwargs.items() if v is not None}


async def stream_generate(
    handle: ModelHandle,
    params: Dict[str, Any],
    emit_chunk: Callable,
    emit_stats: Callable,
    emit_event: Callable,
) -> None:
    """
    Stream generate tokens with MLX

    Args:
        handle: Loaded ModelHandle
        params: Generation parameters
            - prompt: Input text
            - stream_id: Stream identifier
            - max_tokens, temperature, top_p, etc.
        emit_chunk: Async callback for token chunks
        emit_stats: Async callback for final statistics
        emit_event: Async callback for events (completed/error)

    Raises:
        GenerationError: If generation fails
    """
    if not MLX_GENERATE_AVAILABLE or mlx_generate is None:
        reason = MLX_GENERATE_ERROR or "mlx-lm not available - install mlx-lm"
        raise GenerationError(handle.model_id, reason)

    # Validate generation parameters first
    validate_generation_params(params)

    # Validate dtype compatibility
    ensure_model_dtype(handle, params)

    prompt = params.get("prompt", "")
    stream_id = params.get("stream_id")
    if not stream_id:
        raise GenerationError(handle.model_id, "stream_id required")

    generation_kwargs = build_generation_kwargs(params)

    # Prepare generator callable (optionally wrapped with Outlines guidance)
    def base_generator(prompt_text: str, **kwargs: Any):
        return mlx_generate(
            handle.model, handle.tokenizer, prompt_text, **kwargs
        )

    generator_callable = base_generator

    guidance_params = params.get("guidance")
    if guidance_params:
        guidance_config = dict(guidance_params)
        guidance_config.setdefault("model_id", handle.model_id)

        try:
            outlines_adapter.validate_guidance_params(handle, guidance_config)
            guidance_plan = outlines_adapter.prepare_guidance(guidance_config)
            generator_callable = outlines_adapter.apply_guidance(
                base_generator,
                guidance_plan,
                tokenizer=handle.tokenizer,
                model=handle.model,
                generation_params=params,
            )
        except GuidanceError:
            raise
        except Exception as exc:
            raise GuidanceError(handle.model_id, f"Failed to initialize guidance: {exc}") from exc

    # Load config for queue and backpressure settings
    config = get_config()

    # Async queue for thread-safe communication with backpressure
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=config.stream_queue_size)

    # Timing and metrics
    started_at = perf_counter()
    first_token_at: Optional[float] = None
    token_count = 0
    caught_error: Optional[Exception] = None
    last_item = None

    # P1-2: Track cumulative text for mlx-engine compatibility
    cumulative_text = ""

    # Cancellation event to stop producer thread gracefully
    cancel_event = threading.Event()

    def producer() -> None:
        """Worker thread that runs blocking MLX generator"""
        nonlocal caught_error, last_item
        try:
            generator = generator_callable(prompt, **generation_kwargs)

            for chunk in generator:
                # Check cancellation before processing chunk
                if cancel_event.is_set():
                    # Close generator to stop MLX immediately
                    if hasattr(generator, 'close'):
                        try:
                            generator.close()
                        except Exception:
                            pass  # Ignore errors during cleanup
                    break

                # Use run_coroutine_threadsafe to properly respect backpressure
                # This correctly waits for queue space, unlike put_nowait
                future = asyncio.run_coroutine_threadsafe(queue.put(chunk), loop)
                try:
                    # Wait with timeout to detect dead consumer or cancellation
                    future.result(timeout=config.queue_put_max_retries * config.get_queue_put_backoff_seconds())
                except TimeoutError:
                    # Consumer likely dead - abort generation
                    raise GenerationError(
                        handle.model_id,
                        f"Queue put timeout - consumer may be dead or too slow"
                    )

                # BUG-002 FIX: Always update last_item after successful queue.put()
                # Even if cancellation is detected, the chunk is ALREADY in the queue
                # and the consumer may read it. We must track it for correct finish_reason.
                # The cancellation flag is for stopping FUTURE generation, not invalidating
                # chunks that are already queued and may be consumed.
                last_item = chunk

                # Double-check cancellation after updating last_item
                # If cancelled, stop generating NEW chunks but don't invalidate the one we just queued
                if cancel_event.is_set():
                    # Close generator to stop MLX immediately
                    if hasattr(generator, 'close'):
                        try:
                            generator.close()
                        except Exception:
                            pass  # Ignore errors during cleanup
                    break
        except Exception as exc:
            caught_error = exc
            # Ensure error signal gets through (unless cancelled)
            if not cancel_event.is_set():
                future = asyncio.run_coroutine_threadsafe(queue.put(None), loop)
                try:
                    future.result(timeout=5.0)  # 5 second timeout for error signal
                except TimeoutError:
                    pass  # Best effort - consumer may be dead
        else:
            # Ensure completion signal gets through (unless cancelled)
            if not cancel_event.is_set():
                future = asyncio.run_coroutine_threadsafe(queue.put(StopAsyncIteration), loop)
                try:
                    future.result(timeout=5.0)  # 5 second timeout for completion signal
                except TimeoutError:
                    pass  # Best effort - consumer may be dead

    # Launch producer in thread
    producer_task = asyncio.create_task(asyncio.to_thread(producer))

    try:
        # Consume queue and emit notifications
        while True:
            item = await queue.get()

            # Check for completion or error
            if item is StopAsyncIteration:
                break
            if item is None:
                if isinstance(caught_error, GuidanceError):
                    raise caught_error
                raise GenerationError(handle.model_id, str(caught_error))

            # Extract token data from GenerationResponse (dataclass or dict for compatibility)
            if hasattr(item, 'text'):  # GenerationResponse object
                token_text = item.text
                token_id = item.token
                # logprobs is an MLX array, get first value if available
                logprob = float(item.logprobs[0]) if hasattr(item.logprobs, '__getitem__') and len(item.logprobs) > 0 else None
            elif isinstance(item, dict):  # Legacy dict format
                token_text = item.get("text", "")
                token_id = item.get("token_id")
                logprob = item.get("logprob")
            else:
                raise GenerationError(
                    handle.model_id,
                    f"MLX generator returned invalid chunk type: {type(item).__name__}"
                )
            token_count += 1

            # P1-2: Update cumulative text for mlx-engine compatibility
            cumulative_text += token_text

            # Measure TTFT on first token
            if first_token_at is None:
                first_token_at = perf_counter()

            # Emit chunk notification
            chunk_data = {
                "stream_id": stream_id,
                "token": token_text,
                "token_id": token_id,
                "is_final": False,
                "cumulative_text": cumulative_text,  # P1-2: Include cumulative text
            }

            # Only add logprob if not None (avoid JSON null vs TypeScript undefined)
            if logprob is not None:
                chunk_data["logprob"] = logprob

            await emit_chunk(chunk_data)

        # Calculate final metrics
        total_elapsed = perf_counter() - started_at
        ttft = (first_token_at - started_at) if first_token_at else total_elapsed

        # Throughput: tokens per second in steady state (post-TTFT)
        steady_state_time = max(total_elapsed - ttft, 1e-6)
        throughput = token_count / steady_state_time if token_count > 0 else 0.0

        # Emit statistics notification
        await emit_stats(
            {
                "stream_id": stream_id,
                "tokens_generated": token_count,
                "tokens_per_second": throughput,
                "time_to_first_token": ttft,
                "total_time": total_elapsed,
            }
        )

        # Determine finish reason
        finish_reason = "completed"
        if last_item:
            # Handle both GenerationResponse (object) and dict formats
            if hasattr(last_item, 'stop_reason'):  # GenerationResponse object
                finish_reason = last_item.stop_reason if last_item.stop_reason else "completed"
            elif isinstance(last_item, dict) and "stop_reason" in last_item:  # Legacy dict format
                finish_reason = last_item["stop_reason"]
        elif token_count == 0:
            finish_reason = "no_output"

        # Emit completion event
        await emit_event(
            {
                "stream_id": stream_id,
                "event": "completed",
                "is_final": True,
                "finish_reason": finish_reason,
            }
        )

    except GuidanceError:
        raise
    except GenerationError:
        # Re-raise generation errors
        raise
    except Exception as exc:
        # Wrap unexpected errors
        raise GenerationError(handle.model_id, f"Unexpected generation error: {exc}") from exc
    finally:
        # Signal producer thread to stop
        cancel_event.set()

        # Wait for producer thread to finish
        # This ensures the MLX thread is fully stopped before returning
        await producer_task

        # BUGFIX: Sync Metal GPU buffers to prevent command buffer assertion failures
        # WITHOUT THIS: Metal command buffers can remain uncommitted, causing
        # "_status < MTLCommandBufferStatusCommitted" assertion failures on subsequent requests
        # CRITICAL: Must sync EVERY request for stability (conditional sync caused 90% failure rate)
        try:
            import mlx.core as mx
            import gc
            # Force completion of all pending GPU operations
            mx.metal.sync()
            # Collect garbage to release Metal resources
            gc.collect()
        except Exception:
            # Best effort - don't fail if MLX/Metal not available
            pass


# Note: validate_generation_params is now imported from validators module
# The duplicate function below has been removed to eliminate code duplication
