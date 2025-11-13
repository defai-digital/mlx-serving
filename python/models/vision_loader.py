from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import gc
import inspect
import os
import tempfile
import time
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any, Awaitable, Callable, Dict, List, Optional

import importlib

import numpy as np
from PIL import Image

import sys
from pathlib import Path
import importlib.util

# Fix: Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from config_loader import get_config
from errors import GenerationError, ModelLoadError
from models.generator import build_generation_kwargs

mx = None
_HAVE_MLX = False
_MLX_IMPORT_ERROR: Optional[str] = None


def _ensure_mlx_available() -> bool:
    """
    Perform a lazy capability probe for MLX support.

    Uses importlib.util.find_spec to avoid importing on unsupported hosts.
    Catches BaseException to guard against platform-specific import crashes.
    """
    global mx, _HAVE_MLX, _MLX_IMPORT_ERROR

    if _HAVE_MLX and mx is not None:
        return True

    spec = importlib.util.find_spec("mlx.core")
    if spec is None:
        _MLX_IMPORT_ERROR = "MLX runtime is not available on this host (module mlx.core not found)"
        mx = None
        _HAVE_MLX = False
        return False

    try:
        mx_module = importlib.import_module("mlx.core")
    except BaseException as exc:  # pragma: no cover
        _MLX_IMPORT_ERROR = f"MLX runtime failed to initialize: {exc}"
        mx = None
        _HAVE_MLX = False
        return False

    mx = mx_module
    _HAVE_MLX = True
    _MLX_IMPORT_ERROR = None
    return True

try:
    from mlx_vlm import load as load_vlm_model
    from mlx_vlm import stream_generate as vlm_generate  # Use stream_generate for streaming
    from mlx_vlm.utils import load_image as vlm_load_image

    _HAVE_VLM = True
except ImportError:  # pragma: no cover
    load_vlm_model = None  # type: ignore
    vlm_generate = None  # type: ignore
    vlm_load_image = None  # type: ignore
    _HAVE_VLM = False

@dataclass
class ImageEmbedding:
    image: Image.Image
    embeddings: list[list[float]]
    original_size: tuple[int, int]
    processed_size: tuple[int, int]
    num_tokens: int
    processor_inputs: Dict[str, Any] = field(default_factory=dict)
    temp_path: Optional[str] = None  # For mlx-vlm file path requirement

@dataclass
class VisionModelHandle:
    model_id: str
    model: Any
    tokenizer: Any
    processor: Any
    config: Any
    metadata: Dict[str, Any]

class VisionModelLoader:

    def __init__(self) -> None:
        pass

    @staticmethod
    @contextlib.contextmanager
    def _temp_image_file():
        """
        Context manager for creating and cleaning up temporary image files.
        Ensures file is always deleted, even on exceptions.
        """
        temp_fd, temp_path = tempfile.mkstemp(suffix=".jpg", prefix="mlx_vlm_")
        try:
            os.close(temp_fd)  # Close file descriptor immediately
            yield temp_path
        finally:
            # Always cleanup, even on exception
            try:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
            except OSError:
                pass  # Best effort cleanup

    async def load_vision_model(
        self,
        model_id: str,
        *,
        revision: Optional[str] = "main",
        quantization: Optional[str] = None,
        local_path: Optional[str] = None,
    ) -> VisionModelHandle:
        if not _ensure_mlx_available():
            reason = _MLX_IMPORT_ERROR or "MLX runtime is not available on this host"
            raise ModelLoadError(model_id, reason)

        if not _HAVE_VLM or load_vlm_model is None:
            raise ModelLoadError(model_id, "mlx-vlm library is not available")

        # mlx-vlm >= 0.3.0 supports revision and other parameters via kwargs
        kwargs: Dict[str, Any] = {}
        if revision:
            kwargs["revision"] = revision
        # Note: quantization is typically handled during model conversion, not at load time
        # if quantization:
        #     kwargs["quantization"] = quantization

        path = local_path or model_id
        loop = asyncio.get_running_loop()
        try:
            # mlx-vlm load() returns (model, processor) not (model, tokenizer, processor, config)
            model, processor = await loop.run_in_executor(
                None, lambda: load_vlm_model(path, **kwargs)
            )
            # Extract tokenizer and config from processor
            tokenizer = getattr(processor, 'tokenizer', processor)
            config = getattr(model, 'config', None) or getattr(processor, 'config', None)
        except Exception as exc:  # pragma: no cover
            raise ModelLoadError(model_id, str(exc)) from exc

        context_length = next(
            (int(getattr(config, attr)) for attr in ("max_position_embeddings", "n_ctx", "max_sequence_length", "context_length", "model_max_length") if getattr(config, attr, None)),
            get_config().default_context_length,
        )

        metadata = {
            "model_id": model_id,
            "context_length": context_length,
            "revision": revision,
            "quantization": quantization,
            "processor_type": processor.__class__.__name__,
        }
        image_size = getattr(getattr(config, "vision_config", config), "image_size", None)
        if image_size is not None: metadata["image_size"] = image_size

        return VisionModelHandle(model_id, model, tokenizer, processor, config, metadata)

    def unload_model(self, handle: VisionModelHandle) -> None:
        for attr in ("model", "tokenizer", "processor", "config"):
            if hasattr(handle, attr):
                delattr(handle, attr)
        gc.collect()
        if _ensure_mlx_available() and mx is not None:  # pragma: no branch
            try:  # pragma: no cover
                mx.metal.sync()
            except AttributeError:
                pass

    def encode_image(self, handle: VisionModelHandle, image_data: str | bytes) -> ImageEmbedding:
        if isinstance(image_data, bytes):
            raw = image_data
        else:
            payload = image_data.split(",", 1)[1] if image_data.startswith("data:") else image_data
            try:
                raw = base64.b64decode(payload, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("image payload is not valid base64 data") from exc

        buffer = BytesIO(raw); image = None
        if vlm_load_image is not None:
            try:
                image = vlm_load_image(buffer)
            except Exception:
                image = None
        if image is None:
            buffer.seek(0)
            image = Image.open(buffer)
        if image.mode != "RGB":
            image = image.convert("RGB")

        # For mlx-vlm: Skip preprocessing, mlx-vlm handles it internally
        # Just provide dummy data for ImageEmbedding structure
        dummy_array = np.zeros((1, 3, 336, 336), dtype=np.float32)
        inputs = {"pixel_values": dummy_array}
        embeddings = dummy_array.reshape(dummy_array.shape[0], -1).tolist()

        # Use standard LLaVA dimensions
        height, width = 336, 336

        # mlx-vlm expects image file path, so save to temp file
        # Note: We create the temp file here but DON'T use context manager yet
        # because the file needs to persist through stream_generate()
        # The cleanup happens in stream_generate's finally block
        temp_fd, temp_path = tempfile.mkstemp(suffix=".jpg", prefix="mlx_vlm_")
        try:
            os.close(temp_fd)  # Close the file descriptor
            image.save(temp_path, format="JPEG")
        except Exception as exc:
            # If save fails, clean up immediately and raise
            try:
                os.unlink(temp_path)
            except OSError:
                pass  # File might not exist
            raise ValueError(f"Failed to save image to temp file: {exc}") from exc

        return ImageEmbedding(image, embeddings, (image.width, image.height), (int(width), int(height)), int(height * width), inputs, temp_path)

    async def stream_generate(
        self,
        handle: VisionModelHandle,
        params: Dict[str, Any],
        image_embedding: ImageEmbedding,
        emit_chunk: Callable[[Dict[str, Any]], Awaitable[None]],
        emit_stats: Callable[[Dict[str, Any]], Awaitable[None]],
        emit_event: Callable[[Dict[str, Any]], Awaitable[None]],
        *,
        stream_id: str,
        chunk_pool=None,
        stats_pool=None,
        event_pool=None,
    ) -> None:
        if vlm_generate is None:
            raise GenerationError(handle.model_id, "mlx-vlm generate() unavailable")

        gen_param_names = set(inspect.signature(vlm_generate).parameters)

        config = get_config()
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=config.stream_queue_size)
        loop = asyncio.get_running_loop()
        started = time.perf_counter()
        first_token_at: Optional[float] = None
        token_count = 0
        last_chunk: Any = None
        error_holder: Dict[str, Optional[Exception]] = {"exc": None}

        kwargs = build_generation_kwargs(params)

        batching_enabled = bool(getattr(config, "ipc_batching_enabled", True))
        max_batch_tokens = max(1, int(getattr(config, "ipc_batch_max_tokens", 1)))
        flush_interval_sec = max(
            0.001,
            float(getattr(config, "ipc_batch_flush_ms", 6)) / 1000.0,
        )
        pending_chunks: List[Dict[str, Any]] = []

        async def flush_pending_chunks() -> None:
            nonlocal pending_chunks

            if not pending_chunks:
                return

            if len(pending_chunks) == 1:
                chunk_payload = pending_chunks[0]
                pending_chunks = []
                await emit_chunk(chunk_payload)
                if chunk_pool:
                    chunk_pool.release(chunk_payload)
                return

            batch = pending_chunks
            pending_chunks = []
            batch_payload = {
                "stream_id": stream_id,
                "tokens": batch,
                "batch_size": len(batch),
                "is_batch": True,
            }
            await emit_chunk(batch_payload)
            if chunk_pool:
                for chunk_payload in batch:
                    chunk_pool.release(chunk_payload)

        async def emit_token_chunk(chunk_payload: Dict[str, Any]) -> None:
            if not batching_enabled:
                await emit_chunk(chunk_payload)
                if chunk_pool:
                    chunk_pool.release(chunk_payload)
                return

            pending_chunks.append(chunk_payload)
            if len(pending_chunks) >= max_batch_tokens:
                await flush_pending_chunks()

        def make_kwargs() -> Dict[str, Any]:
            prompt = params.get("prompt", "")

            # mlx-vlm 0.3.0 requires <image> token in prompt
            if "<image>" not in prompt:
                prompt = f"<image>\n{prompt}"

            # Validate temp_path exists (BUG-008 fix)
            if not image_embedding.temp_path:
                raise GenerationError(
                    handle.model_id,
                    "Image temp file was not created - encode_image() may have failed"
                )

            if not os.path.exists(image_embedding.temp_path):
                raise GenerationError(
                    handle.model_id,
                    f"Image temp file does not exist: {image_embedding.temp_path}"
                )

            # Validate temp file is readable (prevents access errors)
            if not os.access(image_embedding.temp_path, os.R_OK):
                raise GenerationError(
                    handle.model_id,
                    f"Image temp file is not readable: {image_embedding.temp_path}"
                )

            # mlx-vlm expects image file path (str), not PIL Image
            pairs = [
                ("model", handle.model),
                ("processor", handle.processor),
                ("prompt", prompt),
                ("image", image_embedding.temp_path),  # Pass temp file path
            ]
            selected = {k: v for k, v in pairs if k in gen_param_names and v is not None}
            selected.update({k: v for k, v in kwargs.items() if k in gen_param_names})
            if "stream" in gen_param_names:
                selected.setdefault("stream", True)
            return selected

        def producer() -> None:
            nonlocal last_chunk
            try:
                iterator = vlm_generate(**make_kwargs())
                if isinstance(iterator, str):
                    asyncio.run_coroutine_threadsafe(queue.put({"text": iterator}), loop).result()
                    return
                for chunk in iterator:
                    last_chunk = chunk
                    asyncio.run_coroutine_threadsafe(queue.put(chunk), loop).result()
                asyncio.run_coroutine_threadsafe(queue.put(StopAsyncIteration), loop).result()
            except Exception as exc:  # pragma: no cover
                error_holder["exc"] = exc
                asyncio.run_coroutine_threadsafe(queue.put(StopAsyncIteration), loop).result()

        producer_task = asyncio.create_task(asyncio.to_thread(producer))

        try:
            while True:
                try:
                    if batching_enabled and pending_chunks:
                        item = await asyncio.wait_for(queue.get(), timeout=flush_interval_sec)
                    else:
                        item = await queue.get()
                except asyncio.TimeoutError:
                    await flush_pending_chunks()
                    continue
                if item is StopAsyncIteration:
                    await flush_pending_chunks()
                    if error_holder["exc"] is not None:
                        raise GenerationError(handle.model_id, str(error_holder["exc"]))
                    break

                if isinstance(item, dict):
                    chunk = item
                elif isinstance(item, str):
                    chunk = {"text": item}
                elif hasattr(item, "text"):
                    chunk = {"text": getattr(item, "text")}
                else:
                    raise GenerationError(handle.model_id, f"Unsupported chunk type: {type(item).__name__}")
                token_count += 1
                if first_token_at is None:
                    first_token_at = time.perf_counter()

                # mlx-vlm doesn't provide token_id, use 0 as placeholder for schema compliance
                # Phase 2: Use object pool if available
                if chunk_pool:
                    payload = chunk_pool.acquire()
                    payload["stream_id"] = stream_id
                    payload["token"] = chunk.get("text", "")
                    payload["token_id"] = chunk.get("token_id", 0)  # Default to 0 for mlx-vlm compatibility
                    payload["is_final"] = False
                    # Only include logprob if available
                    if chunk.get("logprob") is not None:
                        payload["logprob"] = chunk["logprob"]
                    await emit_token_chunk(payload)
                else:
                    payload = {
                        "stream_id": stream_id,
                        "token": chunk.get("text", ""),
                        "token_id": chunk.get("token_id", 0),  # Default to 0 for mlx-vlm compatibility
                        "is_final": False
                    }
                    # Only include logprob if available
                    if chunk.get("logprob") is not None:
                        payload["logprob"] = chunk["logprob"]
                    await emit_token_chunk(payload)

            await flush_pending_chunks()

            elapsed = time.perf_counter() - started
            ttft = (first_token_at - started) if first_token_at else elapsed
            steady = max(elapsed - ttft, 1e-6)
            throughput = token_count / steady if token_count else 0.0

            # Phase 2: Use object pool if available
            if stats_pool:
                stats_data = stats_pool.acquire()
                stats_data["stream_id"] = stream_id
                stats_data["tokens_generated"] = token_count
                stats_data["tokens_per_second"] = throughput
                stats_data["time_to_first_token"] = ttft
                stats_data["total_time"] = elapsed
                await emit_stats(stats_data)
                stats_pool.release(stats_data)
            else:
                await emit_stats({"stream_id": stream_id, "tokens_generated": token_count, "tokens_per_second": throughput, "time_to_first_token": ttft, "total_time": elapsed})

            finish_reason = (
                last_chunk.get("stop_reason")
                if isinstance(last_chunk, dict) and "stop_reason" in last_chunk
                else ("no_output" if token_count == 0 else "completed")
            )
            # Phase 2: Use object pool if available
            if event_pool:
                event_data = event_pool.acquire()
                event_data["stream_id"] = stream_id
                event_data["event"] = "completed"
                event_data["is_final"] = True
                event_data["finish_reason"] = finish_reason
                await emit_event(event_data)
                event_pool.release(event_data)
            else:
                await emit_event({"stream_id": stream_id, "event": "completed", "is_final": True, "finish_reason": finish_reason})

        except GenerationError:
            raise
        except Exception as exc:  # pragma: no cover
            raise GenerationError(handle.model_id, f"Unexpected vision generation error: {exc}")
        finally:
            await producer_task
            # BUG-001 FIX: Robust cleanup of temp file - ALWAYS attempt cleanup
            # This ensures temp files are deleted even on exception/cancellation
            if image_embedding.temp_path:
                try:
                    # Use os.path.exists to avoid race conditions
                    if os.path.exists(image_embedding.temp_path):
                        os.unlink(image_embedding.temp_path)
                except OSError as cleanup_err:
                    # Log but don't raise - cleanup failure shouldn't mask original exception
                    import sys
                    print(f"Warning: Failed to cleanup temp file {image_embedding.temp_path}: {cleanup_err}", file=sys.stderr)

    def _to_numpy(self, value: Any) -> np.ndarray:
        if isinstance(value, np.ndarray):
            return value
        if _ensure_mlx_available() and mx is not None and hasattr(mx, "array") and isinstance(value, mx.array):
            return np.array(value)
        if hasattr(value, "numpy"):
            return value.numpy()
        if hasattr(value, "to_numpy"):
            return value.to_numpy()
        return np.asarray(value)
