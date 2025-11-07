"""
Custom exception types for MLX runtime

Provides typed exceptions for consistent JSON-RPC error mapping.
All domain-specific errors should inherit from these base types.
"""

from typing import Optional


class MLXRuntimeError(Exception):
    """Base exception for all MLX runtime errors"""

    def __init__(self, message: str, model_id: Optional[str] = None):
        self.message = message
        self.model_id = model_id
        super().__init__(message)


class ModelNotLoaded(MLXRuntimeError):
    """Raised when attempting to use a model that hasn't been loaded"""

    def __init__(self, model_id: str):
        super().__init__(f"Model not loaded: {model_id}", model_id)


class ModelLoadError(MLXRuntimeError):
    """Raised when model loading fails"""

    def __init__(self, model_id: str, reason: str):
        super().__init__(f"Failed to load model {model_id}: {reason}", model_id)
        self.reason = reason


class GenerationError(MLXRuntimeError):
    """Raised when token generation fails"""

    def __init__(self, model_id: str, reason: str):
        super().__init__(f"Generation failed for {model_id}: {reason}", model_id)
        self.reason = reason


class TokenizerError(MLXRuntimeError):
    """Raised when tokenization/detokenization fails"""

    def __init__(self, model_id: str, reason: str):
        super().__init__(f"Tokenizer error for {model_id}: {reason}", model_id)
        self.reason = reason


class GuidanceError(MLXRuntimeError):
    """Raised when structured output guidance fails"""

    def __init__(self, model_id: str, reason: str):
        super().__init__(f"Guidance error for {model_id}: {reason}", model_id)
        self.reason = reason


# JSON-RPC error code mapping
# MUST match TypeScript JsonRpcErrorCode enum (src/bridge/serializers.ts)
# See automatosx/tmp/ERROR_CODES.md for complete documentation
ERROR_CODE_MAP = {
    ModelLoadError: -32001,
    GenerationError: -32002,
    TokenizerError: -32003,
    GuidanceError: -32004,
    ModelNotLoaded: -32005,
    MLXRuntimeError: -32099,  # Generic runtime error
}
