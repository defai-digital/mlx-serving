"""
Input validation for JSON-RPC methods

Centralized validation logic to prevent invalid parameters and DoS attacks
"""

from __future__ import annotations

import base64
import binascii
from typing import Any, Dict
import sys
from pathlib import Path

# Fix: Add parent directory to path for imports when run as main module
if __name__ != '__main__':
    sys.path.insert(0, str(Path(__file__).parent))

from config_loader import get_config


def validate_model_id(model_id: Any) -> str:
    """
    Validate model_id parameter

    Args:
        model_id: Model ID to validate

    Returns:
        Validated model_id string

    Raises:
        ValueError: If model_id is invalid
    """
    if not model_id:
        raise ValueError("model_id is required")

    if not isinstance(model_id, str):
        raise ValueError(f"model_id must be a string, got {type(model_id).__name__}")

    if len(model_id) > 512:
        raise ValueError(f"model_id too long ({len(model_id)} chars, max 512)")

    # BUG-010 FIX: Allow URI schemes (hf://, file://) and revision syntax (@)
    # Allow alphanumeric, hyphens, underscores, dots, slashes, colons, and @ symbols
    # Disallow '..' to prevent path traversal
    import re
    if '..' in model_id or not re.match(r'^[a-zA-Z0-9_\-./@:]+$', model_id):
        raise ValueError("model_id contains invalid characters or path traversal attempts")

    return model_id


def validate_text_input(text: Any, param_name: str = "text", max_length: int = 1_048_576) -> str:
    """
    Validate text input parameters

    Args:
        text: Text to validate
        param_name: Parameter name for error messages
        max_length: Maximum allowed length (default 1MB)

    Returns:
        Validated text string

    Raises:
        ValueError: If text is invalid
    """
    if not isinstance(text, str):
        raise ValueError(f"{param_name} must be a string, got {type(text).__name__}")

    if len(text) > max_length:
        raise ValueError(f"{param_name} too long ({len(text)} chars, max {max_length})")

    return text


def validate_generation_params(params: Dict[str, Any]) -> None:
    """
    Validate generation parameters

    Args:
        params: Generation parameters to validate

    Raises:
        ValueError: If parameters are invalid
    """
    config = get_config()

    # Required fields are checked by caller (model_id, prompt)

    # Validate max_tokens (Security: prevent DoS attacks)
    if "max_tokens" in params:
        max_tokens = params["max_tokens"]
        if not isinstance(max_tokens, int):
            raise ValueError(f"max_tokens must be an integer, got {type(max_tokens).__name__}")
        if max_tokens < 1:
            raise ValueError(f"max_tokens must be positive, got {max_tokens}")

        # Use configured limit from config (default 4096)
        max_allowed = config.max_generation_tokens
        if max_tokens > max_allowed:
            raise ValueError(f"max_tokens too large ({max_tokens}, max {max_allowed})")

    # Validate temperature (Security: prevent unreasonable values)
    if "temperature" in params:
        temp = params["temperature"]
        if not isinstance(temp, (int, float)):
            raise ValueError(f"temperature must be numeric, got {type(temp).__name__}")
        if temp < 0:
            raise ValueError(f"temperature must be non-negative, got {temp}")

        # Use configured limit from config (default 2.0)
        max_temp = config.max_temperature
        if temp > max_temp:
            raise ValueError(f"temperature too large ({temp}, max {max_temp})")

    # Validate top_p
    if "top_p" in params:
        top_p = params["top_p"]
        if not isinstance(top_p, (int, float)):
            raise ValueError(f"top_p must be numeric, got {type(top_p).__name__}")
        if not (0 < top_p <= 1):
            raise ValueError(f"top_p must be in (0, 1], got {top_p}")

    # Validate penalties
    for penalty_name in ["presence_penalty", "frequency_penalty"]:
        if penalty_name in params:
            penalty = params[penalty_name]
            if not isinstance(penalty, (int, float)):
                raise ValueError(f"{penalty_name} must be numeric, got {type(penalty).__name__}")
            if penalty < -2.0 or penalty > 2.0:
                raise ValueError(f"{penalty_name} must be in [-2.0, 2.0], got {penalty}")

    # Validate stop sequences
    if "stop_sequences" in params:
        stop = params["stop_sequences"]
        if stop is not None:
            if not isinstance(stop, list):
                raise ValueError(f"stop_sequences must be a list, got {type(stop).__name__}")
            if len(stop) > 10:  # Reasonable limit
                raise ValueError(f"too many stop_sequences ({len(stop)}, max 10)")
            for idx, seq in enumerate(stop):
                if not isinstance(seq, str):
                    raise ValueError(f"stop_sequences[{idx}] must be a string")
                if len(seq) > 100:
                    raise ValueError(f"stop_sequences[{idx}] too long ({len(seq)} chars, max 100)")

    # Validate stop_token_ids
    if "stop_token_ids" in params:
        stop_ids = params["stop_token_ids"]
        if stop_ids is not None:
            if not isinstance(stop_ids, list):
                raise ValueError(f"stop_token_ids must be a list, got {type(stop_ids).__name__}")
            if len(stop_ids) > 100:
                raise ValueError(f"too many stop_token_ids ({len(stop_ids)}, max 100)")
            for idx, token_id in enumerate(stop_ids):
                if not isinstance(token_id, int):
                    raise ValueError(f"stop_token_ids[{idx}] must be an integer")
                if token_id < 0 or token_id > 1_000_000:
                    raise ValueError(f"stop_token_ids[{idx}] out of range")

    # Validate seed
    if "seed" in params:
        seed = params["seed"]
        if seed is not None:
            if not isinstance(seed, int):
                raise ValueError(f"seed must be an integer, got {type(seed).__name__}")
            if seed < 0 or seed > 2**32 - 1:
                raise ValueError(f"seed out of range (0 to {2**32 - 1})")

    # Validate prompt
    if "prompt" in params:
        validate_text_input(params["prompt"], "prompt", max_length=1_048_576)


def validate_load_model_params(params: Dict[str, Any]) -> None:
    """
    Validate load_model parameters

    Args:
        params: Load model parameters

    Raises:
        ValueError: If parameters are invalid
    """
    # Validate local_path if present
    if "local_path" in params:
        local_path = params["local_path"]
        # Allow None/null (will use model_id as fallback in loader)
        if local_path is not None:
            if not isinstance(local_path, str):
                raise ValueError(f"local_path must be a string, got {type(local_path).__name__}")
            if len(local_path) > 4096:
                raise ValueError(f"local_path too long ({len(local_path)} chars, max 4096)")

            # BUG-003 FIX: Security - reject dangerous path patterns
            # Don't try to resolve paths here - that's the loader's job
            # This matches the security check in loader.py (line 186)
            if ".." in local_path or "~" in local_path:
                raise ValueError(f"Path contains potentially unsafe sequences (.. or ~): {local_path}")

            # Note: Full path resolution and trusted directory validation
            # is performed by the loader (models/loader.py lines 193-235)
            # This validator only checks for obviously dangerous patterns


    # Validate context_length if present
    if "context_length" in params:
        ctx_len = params["context_length"]
        if not isinstance(ctx_len, int):
            raise ValueError(f"context_length must be an integer, got {type(ctx_len).__name__}")
        if ctx_len < 1 or ctx_len > 1_000_000:
            raise ValueError(f"context_length out of range (1 to 1000000), got {ctx_len}")

    # Validate quantization if present
    if "quantization" in params:
        quant = params["quantization"]
        if quant is not None:
            if not isinstance(quant, str):
                raise ValueError(f"quantization must be a string, got {type(quant).__name__}")
            # Add more specific validation if needed

    # Validate revision if present
    if "revision" in params:
        revision = params["revision"]
        if revision is not None:
            if not isinstance(revision, str):
                raise ValueError(f"revision must be a string, got {type(revision).__name__}")
            if len(revision) > 256:
                raise ValueError(f"revision too long ({len(revision)} chars, max 256)")


def validate_vision_load_params(params: Dict[str, Any]) -> None:
    """Validate parameters for loading vision-language models."""

    validate_load_model_params(params)

    allowed_quant_modes = {None, "int4", "int8", "fp16", "bf16"}

    if "quantization" in params:
        quant_mode = params["quantization"]
        if quant_mode is not None and not isinstance(quant_mode, str):
            raise ValueError(
                f"quantization must be a string or null, got {type(quant_mode).__name__}"
            )
        if quant_mode not in allowed_quant_modes:
            raise ValueError(
                "quantization must be one of {int4,int8,fp16,bf16} or omitted"
            )

    if "vision_config" in params and params["vision_config"] is not None:
        vision_cfg = params["vision_config"]
        if not isinstance(vision_cfg, dict):
            raise ValueError(
                f"vision_config must be a dict when provided, got {type(vision_cfg).__name__}"
            )

    if "tokenizer_config" in params and params["tokenizer_config"] is not None:
        if not isinstance(params["tokenizer_config"], dict):
            raise ValueError(
                f"tokenizer_config must be a dict when provided, got {type(params['tokenizer_config']).__name__}"
            )

    if "processor_config" in params and params["processor_config"] is not None:
        if not isinstance(params["processor_config"], dict):
            raise ValueError(
                f"processor_config must be a dict when provided, got {type(params['processor_config']).__name__}"
            )


def validate_base64_image(image_data: Any, *, max_bytes: int = 10 * 1024 * 1024) -> bytes:
    """Validate and decode a base64-encoded image payload."""

    if not isinstance(image_data, (str, bytes)):
        raise ValueError(
            f"image must be a base64 string or bytes, got {type(image_data).__name__}"
        )

    if isinstance(image_data, bytes):
        payload = image_data
    else:
        # Accept optional data URI prefix
        if image_data.startswith("data:"):
            try:
                _, _, encoded = image_data.partition(",")
                payload = encoded.encode("ascii")
            except UnicodeEncodeError as exc:
                raise ValueError("base64 image data contains non-ASCII characters") from exc
        else:
            payload = image_data.encode("ascii", errors="strict")

    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image is not valid base64-encoded data") from exc

    if len(decoded) == 0:
        raise ValueError("image payload is empty")

    if len(decoded) > max_bytes:
        raise ValueError(
            f"image payload exceeds maximum size of {max_bytes} bytes (got {len(decoded)})"
        )

    return decoded


def validate_tokenize_params(params: Dict[str, Any]) -> None:
    """
    Validate tokenize_request parameters

    Args:
        params: Tokenize parameters

    Raises:
        ValueError: If parameters are invalid
    """
    # Validate text
    if "text" in params:
        validate_text_input(params["text"], "text", max_length=1_048_576)

    # Validate add_special_tokens
    if "add_special_tokens" in params:
        ast = params["add_special_tokens"]
        if not isinstance(ast, bool):
            raise ValueError(f"add_special_tokens must be a boolean, got {type(ast).__name__}")
