"""MLX model management modules."""

# Make vision loader optional to prevent import failures
# This ensures scheduled_generator can be imported even if numpy is missing
try:
    from .vision_loader import VisionModelLoader, VisionModelHandle, ImageEmbedding
    VISION_AVAILABLE = True
except ImportError as exc:
    VISION_AVAILABLE = False
    VisionModelLoader = None  # type: ignore
    VisionModelHandle = None  # type: ignore
    ImageEmbedding = None  # type: ignore
    # Log warning but don't fail
    import sys
    print(f"Warning: Vision loader unavailable: {exc}", file=sys.stderr, flush=True)

__all__ = [
    "VisionModelLoader",
    "VisionModelHandle",
    "ImageEmbedding",
    "VISION_AVAILABLE",
]
