"""
Model loader - Thin wrapper around mlx-lm and mlx-vlm

Responsibilities:
- Load models from HuggingFace or local paths
- Return ModelHandle dataclass with model, tokenizer, and metadata
- No caching logic (TypeScript decides when to load/unload)
"""

import gc
import time
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

# HuggingFace Hub imports for getting cached model paths
try:
    from huggingface_hub import snapshot_download
    HAS_HF_HUB = True
except ImportError:
    HAS_HF_HUB = False
    snapshot_download = None

# MLX imports - guarded because Apple MLX aborts on unsupported hosts (Bug #1 P0)
def _is_supported_mlx_platform() -> bool:
    """Check whether this host can safely import MLX."""
    system = platform.system().lower()
    if system != "darwin":
        return False
    machine = platform.machine().lower()
    # MLX currently ships universal wheels; arm64 is the only native acceleration path.
    return machine in {"arm64", "x86_64"}


# BUG-009 FIX: Proper type annotation for conditional import
load_text_model: Optional[Callable[..., Any]] = None
MLX_AVAILABLE = False
MLX_IMPORT_ERROR: Optional[str] = None

if _is_supported_mlx_platform():
    try:
        from mlx_lm import load as load_text_model

        MLX_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001
        # Record reason for diagnostics while keeping runtime alive on failure.
        MLX_AVAILABLE = False
        MLX_IMPORT_ERROR = f"mlx-lm import failed: {exc}"
else:
    MLX_IMPORT_ERROR = "MLX runtime unsupported on this platform"

# Try to import count_params if available (optional utility function)
try:
    if MLX_AVAILABLE:
        from mlx.nn.utils import count_params
        HAS_COUNT_PARAMS = True
    else:
        raise ImportError
except ImportError:
    HAS_COUNT_PARAMS = False
    count_params = None

try:
    if MLX_AVAILABLE:
        from mlx_vlm import load as load_vlm_model

        MLX_VLM_AVAILABLE = True
    else:
        raise ImportError
except ImportError:
    MLX_VLM_AVAILABLE = False

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from errors import ModelLoadError
from config_loader import get_config
from model_tuning import ModelTuningManager
from benchmark_utils import BenchmarkAwareLogger

# Benchmark-aware logger
_logger = BenchmarkAwareLogger("loader")


@dataclass
class ModelHandle:
    """Container for loaded model, tokenizer, and metadata"""

    model_id: str
    model: Any  # mlx model instance
    tokenizer: Any  # tokenizer instance
    metadata: Dict[str, Any]


def _detect_vision_model(options: Dict[str, Any], config: Any) -> bool:
    """
    Detect if model is a vision-language model

    Args:
        options: Load options (may contain force_vision/force_text hints)
        config: Model config object from MLX

    Returns:
        True if vision model, False if text-only
    """
    # Explicit hints override detection
    if options.get("force_vision"):
        return True
    if options.get("force_text"):
        return False

    # Check model_type attribute
    model_type = getattr(config, "model_type", "")
    if model_type.lower() in {"llava", "fuyu", "phi3vision", "qwen2vl"}:
        return True

    # Check for vision config attributes
    return hasattr(config, "vision_config") or hasattr(config, "image_size")


def _resolve_context_length(options: Dict[str, Any], config: Any) -> int:
    """
    Resolve model's maximum context length

    Args:
        options: Load options (may contain explicit context_length)
        config: Model config object

    Returns:
        Maximum context length in tokens
    """
    # Explicit override
    if "context_length" in options:
        return int(options["context_length"])

    # Try common config attributes
    for attr in (
        "max_position_embeddings",
        "n_ctx",
        "max_sequence_length",
        "context_length",
        "model_max_length",
    ):
        value = getattr(config, attr, None)
        if value:
            return int(value)

    # Load default from config
    config = get_config()
    return config.default_context_length


def load_model(model_id: str, options: Dict[str, Any]) -> ModelHandle:
    """
    Load a model from HuggingFace or local path

    Args:
        model_id: Model identifier or local path (resolved by TypeScript)
        options: Load options
            - local_path: Local directory path (overrides model_id)
            - vision_hint: Boolean hint that model is vision-capable
            - allow_vlm_fallback: Try VLM loader if text loader fails
            - force_vision: Force vision model detection
            - force_text: Force text-only model detection
            - context_length: Override detected context length
            - tokenizer_config: Additional tokenizer config
            - processor_config: Processor config (for VLM)
            - load_kwargs: Additional kwargs for MLX load()
            - quantization: Quantization mode
            - revision: Model revision/branch

    Returns:
        ModelHandle with model, tokenizer, and metadata

    Raises:
        ModelLoadError: If loading fails
    """
    if not MLX_AVAILABLE:
        # Explain why MLX is unavailable so callers can skip gracefully.
        reason = MLX_IMPORT_ERROR or "MLX not available - install mlx-lm"
        raise ModelLoadError(model_id, reason)

    load_kwargs = options.get("load_kwargs", {})

    # Filter out None values from load_kwargs to prevent TypeError in mlx_lm.load()
    # MLX functions don't accept None as **kwargs values
    load_kwargs = {k: v for k, v in load_kwargs.items() if v is not None}

    # Load config for security settings
    config = get_config()

    try:
        # Resolve model path with security validation
        if options.get("local_path"):
            # Get original path before resolution to detect traversal attempts
            original_path = options["local_path"]

            # BUG-009 FIX: Expand ~ and resolve path before validation
            # This allows legitimate paths like ~/models or /opt/models/../hf/llava
            # Security is enforced later via trusted directory check
            local_path = Path(original_path).expanduser().resolve(strict=False)

            # Security: Check for symlink attacks
            try:
                # Check if path is a symlink pointing outside trusted directories
                if local_path.is_symlink():
                    real_path = local_path.resolve(strict=True)
                    # If resolved path is different, verify it's within trusted dirs
                    if real_path != local_path and config.trusted_model_directories:
                        # Will be checked below
                        local_path = real_path
            except (OSError, RuntimeError):
                # Broken symlink or permission error
                raise ModelLoadError(model_id, f"Invalid or broken symbolic link: {local_path}")

            # Security: Validate path exists and is a directory
            if not local_path.exists():
                # Sanitize path in error to prevent information leakage (CVE-2025-0003)
                raise ModelLoadError(model_id, "Local path does not exist")
            if not local_path.is_dir():
                # Sanitize path in error to prevent information leakage (CVE-2025-0003)
                raise ModelLoadError(model_id, "Local path is not a directory")

            # Security: Ensure path is absolute (resolve() should guarantee this)
            if not local_path.is_absolute():
                raise ModelLoadError(model_id, f"Path must be absolute: {local_path}")

            # Security: Enforce trusted directory boundaries if configured
            if config.trusted_model_directories:
                is_within_trusted = False
                for trusted_dir in config.trusted_model_directories:
                    # BUG-015 FIX: Expand ~ in trusted directories before resolving
                    trusted_path = Path(trusted_dir).expanduser().resolve()
                    try:
                        # Check if local_path is relative to trusted_path
                        local_path.relative_to(trusted_path)
                        is_within_trusted = True
                        break
                    except ValueError:
                        # Not relative to this trusted directory
                        continue

                if not is_within_trusted:
                    raise ModelLoadError(
                        model_id,
                        f"Path traversal detected: {local_path} is not within trusted directories: {config.trusted_model_directories}"
                    )

            resolved_id = local_path.as_posix()
        else:
            resolved_id = model_id

        model, tokenizer, config, processor = None, None, None, None
        is_vision = False

        # Try text model loader first (unless vision hint provided)
        if not options.get("vision_hint"):
            try:
                # Prepare kwargs for text model loader
                text_load_kwargs = {**load_kwargs, "return_config": True}
                if options.get("tokenizer_config") is not None:
                    text_load_kwargs["tokenizer_config"] = options["tokenizer_config"]

                # Enable lazy loading for models that require it
                if options.get("lazy", False):
                    text_load_kwargs["lazy"] = True

                # Filter out None values again after adding tokenizer_config
                text_load_kwargs = {k: v for k, v in text_load_kwargs.items() if v is not None}

                model, tokenizer, config = load_text_model(
                    resolved_id,
                    **text_load_kwargs,
                )
                # Detect if actually a vision model
                is_vision = _detect_vision_model(options, config)

            except FileNotFoundError:
                # Model path not found - re-raise immediately
                raise
            except Exception as text_load_error:
                # Text model load failed - try VLM fallback if allowed
                if options.get("allow_vlm_fallback", True) and MLX_VLM_AVAILABLE:
                    try:
                        # Prepare kwargs for VLM loader
                        vlm_load_kwargs = {**load_kwargs}
                        if options.get("tokenizer_config") is not None:
                            vlm_load_kwargs["tokenizer_config"] = options["tokenizer_config"]
                        if options.get("processor_config") is not None:
                            vlm_load_kwargs["processor_config"] = options["processor_config"]

                        # Filter out None values
                        vlm_load_kwargs = {k: v for k, v in vlm_load_kwargs.items() if v is not None}

                        model, tokenizer, processor, config = load_vlm_model(
                            resolved_id,
                            **vlm_load_kwargs,
                        )
                        is_vision = True
                    except Exception as vlm_load_error:
                        # VLM also failed - log VLM error for debugging, then raise text error
                        _logger.warning(f"VLM fallback failed for {model_id}: {vlm_load_error}")
                        raise text_load_error from vlm_load_error
                else:
                    raise text_load_error
        else:
            # Vision hint provided - load as VLM directly
            if not MLX_VLM_AVAILABLE:
                raise ModelLoadError(model_id, "mlx-vlm not available - install mlx-vlm")

            # Prepare kwargs for VLM loader
            vlm_load_kwargs = {**load_kwargs}
            if options.get("tokenizer_config") is not None:
                vlm_load_kwargs["tokenizer_config"] = options["tokenizer_config"]
            if options.get("processor_config") is not None:
                vlm_load_kwargs["processor_config"] = options["processor_config"]

            # Filter out None values
            vlm_load_kwargs = {k: v for k, v in vlm_load_kwargs.items() if v is not None}

            model, tokenizer, processor, config = load_vlm_model(
                resolved_id,
                **vlm_load_kwargs,
            )
            is_vision = True

        # Validate loaded components
        if model is None or tokenizer is None:
            raise RuntimeError("Loader returned empty model/tokenizer")

        # Phase 2: Get the actual path where the model was loaded from
        # This is needed for the artifact cache to copy files
        cached_model_path = None
        if HAS_HF_HUB and snapshot_download is not None:
            try:
                # If we loaded from HuggingFace ID, get the cached path
                if not options.get("local_path"):
                    # Use local_files_only=True to avoid re-downloading
                    # This returns the path to the cached model directory
                    cached_model_path = snapshot_download(
                        model_id,
                        revision=options.get("revision", "main"),
                        local_files_only=True,
                        # Avoid downloading any missing files
                        allow_patterns=None,
                    )
                else:
                    # If loaded from local path, use that directly
                    cached_model_path = resolved_id
            except Exception as e:
                # If we can't get the cached path, continue without it
                # The artifact cache won't work, but model loading succeeded
                _logger.warning(f"Could not determine cached model path for {model_id}: {e}")

        # Compute metadata
        try:
            if HAS_COUNT_PARAMS and count_params is not None:
                param_count = count_params(model)
                parameters = int(param_count) if param_count is not None else 0
            else:
                parameters = 0  # count_params not available in this MLX version
        except (TypeError, ValueError, Exception):
            parameters = 0  # Fallback if count_params fails

        # Get dtype from first parameter
        try:
            first_param = next(iter(model.parameters()))
            dtype = str(first_param.dtype) if first_param is not None else "unknown"
        except (StopIteration, AttributeError):
            dtype = "unknown"

        context_length = _resolve_context_length(options, config)

        # Phase 3 + 4: Calculate model tuning (adaptive concurrency + model profiles)
        model_tuning = None
        try:
            # Estimate model size from parameters (for 4-bit models: 1 param ≈ 0.5 bytes)
            if parameters > 0:
                model_size_gb = (parameters * 0.5) / (1024 ** 3)
            else:
                # Fallback: assume average parameter size for unknown models
                model_size_gb = 2.0

            # Get runtime config and calculate tuning
            runtime_config = get_config()
            tuning_manager = ModelTuningManager(runtime_config.__dict__)
            model_tuning = tuning_manager.get_model_tuning(model_id, model_size_gb)

        except Exception as e:
            # If tuning fails, log but continue (model loading shouldn't fail)
            _logger.warning(f"Failed to calculate model tuning for {model_id}: {e}")

        # Build metadata dict
        metadata = {
            "model_id": model_id,
            "parameter_count": parameters,
            "dtype": dtype,
            "context_length": context_length,
            "is_vision_model": is_vision,
            "quantization": options.get("quantization"),
            "revision": options.get("revision"),
            "loaded_at": time.time(),
            "config_model_type": getattr(config, "model_type", "unknown"),
            "cached_path": cached_model_path,  # Phase 2: Include cached path for artifact cache
            "model_tuning": model_tuning,  # Phase 3 + 4: Tuning parameters
        }

        # Add processor info if present
        if processor is not None:
            metadata["processor_type"] = processor.__class__.__name__

        return ModelHandle(
            model_id=model_id,
            model=model,
            tokenizer=tokenizer,
            metadata=metadata,
        )

    except FileNotFoundError as exc:
        raise ModelLoadError(model_id, f"Model path not found: {exc}") from exc
    except RuntimeError as exc:
        raise ModelLoadError(model_id, f"Backend failure: {exc}") from exc
    except Exception as exc:
        raise ModelLoadError(model_id, f"Unexpected loader error: {exc}") from exc


def unload_model(handle: ModelHandle) -> None:
    """
    Unload a model and free resources

    Args:
        handle: ModelHandle to unload
    """
    try:
        # Delete references
        if hasattr(handle, "model"):
            del handle.model
        if hasattr(handle, "tokenizer"):
            del handle.tokenizer
    finally:
        # Force garbage collection
        gc.collect()

        # Sync Metal buffers to ensure GPU memory is released
        try:
            import mlx.core

            mlx.core.metal.sync()
        except (ImportError, AttributeError):
            # MLX not available or no Metal support
            pass


def get_context_length(handle: ModelHandle) -> int:
    """
    Get model's maximum context length

    Args:
        handle: ModelHandle

    Returns:
        Maximum context length in tokens
    """
    config = get_config()
    return int(handle.metadata.get("context_length", config.default_context_length))
