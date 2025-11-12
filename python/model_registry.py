#!/usr/bin/env python3
"""
Model Registry - Python Side

LRU-based model cache for multi-model serving with GPU memory management.
Provides fast model switching and memory tracking.

Week 3: Advanced Scaling - Multi-Model Serving
"""

import time
import logging
from typing import Dict, Optional, List, Tuple, Any
from dataclasses import dataclass
from collections import OrderedDict

try:
    import mlx.core as mx
    MLX_AVAILABLE = True
except ImportError:
    MLX_AVAILABLE = False
    logging.warning("MLX not available - model registry will not function")


@dataclass
class ModelMemoryInfo:
    """Memory usage information for a model"""
    gpu_memory_bytes: int
    cpu_memory_bytes: int
    parameter_count: int
    quantization: Optional[str] = None
    dtype: Optional[str] = None


@dataclass
class ModelCacheEntry:
    """Cache entry for a loaded model"""
    model_id: str
    model: Any  # MLX model object
    tokenizer: Any  # Tokenizer object
    memory_info: ModelMemoryInfo
    load_time: float
    last_access_time: float
    access_count: int
    pinned: bool = False


class ModelRegistryConfig:
    """Configuration for model registry"""

    def __init__(
        self,
        max_cached_models: int = 3,
        eviction_strategy: str = 'lru',
        memory_aware_eviction: bool = True,
        gpu_memory_threshold: float = 0.9,
        track_access_patterns: bool = True,
    ):
        self.max_cached_models = max_cached_models
        self.eviction_strategy = eviction_strategy
        self.memory_aware_eviction = memory_aware_eviction
        self.gpu_memory_threshold = gpu_memory_threshold
        self.track_access_patterns = track_access_patterns


class ModelRegistry:
    """
    LRU-based model cache for multi-model serving.

    Manages model loading, caching, and eviction with GPU memory awareness.
    Provides fast model switching by keeping frequently used models in memory.

    Features:
    - LRU/LFU eviction strategies
    - GPU memory tracking
    - Access pattern tracking
    - Model pinning
    - Fast model switching (<100ms for cached models)

    Example:
        ```python
        registry = ModelRegistry(config)

        # Get or load model
        model, tokenizer = registry.get_or_load('model-id', loader_fn)

        # Stats
        stats = registry.get_stats()
        print(f"Cache hit rate: {stats['cache_hit_rate'] * 100}%")
        ```
    """

    def __init__(self, config: Optional[ModelRegistryConfig] = None):
        self.config = config or ModelRegistryConfig()
        self.logger = logging.getLogger(__name__)

        # OrderedDict for LRU ordering
        self.cache: OrderedDict[str, ModelCacheEntry] = OrderedDict()

        # Statistics
        self.cache_hits = 0
        self.cache_misses = 0
        self.eviction_count = 0
        self.total_load_time = 0.0
        self.load_count = 0

        # Eviction history
        self.eviction_history: List[Dict[str, Any]] = []

        self.logger.info(
            f"ModelRegistry initialized (max_models={self.config.max_cached_models}, "
            f"strategy={self.config.eviction_strategy})"
        )

    def get_or_load(
        self,
        model_id: str,
        loader_fn: Any,
        loader_args: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Any, Any]:
        """
        Get a model from cache or load it.

        Args:
            model_id: Model identifier
            loader_fn: Function to load model if not cached
            loader_args: Arguments to pass to loader_fn

        Returns:
            Tuple of (model, tokenizer)
        """
        # Check cache first
        if model_id in self.cache:
            # Cache hit
            self.cache_hits += 1
            entry = self.cache[model_id]

            # Update access pattern
            entry.last_access_time = time.time()
            entry.access_count += 1

            # Move to end (most recently used)
            self.cache.move_to_end(model_id)

            self.logger.debug(f"Cache hit: {model_id}")

            return entry.model, entry.tokenizer

        # Cache miss - need to load
        self.cache_misses += 1
        self.logger.debug(f"Cache miss: {model_id} - loading")

        # Check if we need to evict before loading
        if len(self.cache) >= self.config.max_cached_models:
            self._evict()

        # Load the model
        start_time = time.time()

        loader_args = loader_args or {}
        model, tokenizer = loader_fn(**loader_args)

        load_time = time.time() - start_time
        self.total_load_time += load_time
        self.load_count += 1

        # Get memory info
        memory_info = self._get_model_memory(model, loader_args)

        # Create cache entry
        entry = ModelCacheEntry(
            model_id=model_id,
            model=model,
            tokenizer=tokenizer,
            memory_info=memory_info,
            load_time=start_time,
            last_access_time=time.time(),
            access_count=1,
            pinned=False,
        )

        # Add to cache
        self.cache[model_id] = entry

        self.logger.info(
            f"Model loaded: {model_id} "
            f"(load_time={load_time:.2f}s, "
            f"gpu_mem={memory_info.gpu_memory_bytes / (1024**3):.2f}GB, "
            f"cached_models={len(self.cache)})"
        )

        return model, tokenizer

    def is_cached(self, model_id: str) -> bool:
        """Check if a model is currently cached."""
        return model_id in self.cache

    def get_model_info(self, model_id: str) -> Optional[Dict[str, Any]]:
        """Get information about a cached model."""
        entry = self.cache.get(model_id)
        if not entry:
            return None

        return {
            'model_id': entry.model_id,
            'memory_info': {
                'gpu_memory_bytes': entry.memory_info.gpu_memory_bytes,
                'cpu_memory_bytes': entry.memory_info.cpu_memory_bytes,
                'parameter_count': entry.memory_info.parameter_count,
                'quantization': entry.memory_info.quantization,
                'dtype': entry.memory_info.dtype,
            },
            'load_time': entry.load_time,
            'last_access_time': entry.last_access_time,
            'access_count': entry.access_count,
            'pinned': entry.pinned,
        }

    def list_cached_models(self) -> List[Dict[str, Any]]:
        """List all cached models with their info."""
        return [self.get_model_info(model_id) for model_id in self.cache.keys()]

    def pin_model(self, model_id: str) -> None:
        """Pin a model to prevent eviction."""
        entry = self.cache.get(model_id)
        if entry:
            entry.pinned = True
            self.logger.info(f"Model pinned: {model_id}")

    def unpin_model(self, model_id: str) -> None:
        """Unpin a model to allow eviction."""
        entry = self.cache.get(model_id)
        if entry:
            entry.pinned = False
            self.logger.info(f"Model unpinned: {model_id}")

    def evict_model(self, model_id: str) -> None:
        """Manually evict a specific model."""
        entry = self.cache.get(model_id)
        if not entry:
            return

        if entry.pinned:
            raise RuntimeError(f"Cannot evict pinned model: {model_id}")

        self._perform_eviction(model_id, reason='manual')

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total_gpu_memory = sum(
            e.memory_info.gpu_memory_bytes for e in self.cache.values()
        )
        total_cpu_memory = sum(
            e.memory_info.cpu_memory_bytes for e in self.cache.values()
        )

        total_requests = self.cache_hits + self.cache_misses
        cache_hit_rate = self.cache_hits / total_requests if total_requests > 0 else 0
        cache_miss_rate = self.cache_misses / total_requests if total_requests > 0 else 0

        avg_load_time = self.total_load_time / self.load_count if self.load_count > 0 else 0

        # Top models by access count
        top_models = sorted(
            [
                {'model_id': e.model_id, 'access_count': e.access_count}
                for e in self.cache.values()
            ],
            key=lambda x: x['access_count'],
            reverse=True,
        )[:5]

        return {
            'cached_models': len(self.cache),
            'max_cached_models': self.config.max_cached_models,
            'total_gpu_memory': total_gpu_memory,
            'total_cpu_memory': total_cpu_memory,
            'cache_hit_rate': cache_hit_rate,
            'cache_miss_rate': cache_miss_rate,
            'cache_hits': self.cache_hits,
            'cache_misses': self.cache_misses,
            'evictions': self.eviction_count,
            'avg_load_time': avg_load_time,
            'top_models': top_models,
        }

    def get_gpu_memory_stats(self) -> Dict[str, Any]:
        """Get GPU memory statistics."""
        if not MLX_AVAILABLE:
            return {
                'total_memory': 0,
                'used_memory': 0,
                'free_memory': 0,
                'utilization': 0.0,
                'under_pressure': False,
            }

        # Get actual GPU memory from MLX
        # Note: MLX doesn't expose total GPU memory, so we estimate
        stats = self.get_stats()
        used_memory = stats['total_gpu_memory']

        # Estimate total memory (M3 Max = 16GB typical)
        # TODO: Get actual GPU memory from system
        total_memory = 16 * 1024 * 1024 * 1024  # 16GB
        free_memory = total_memory - used_memory
        utilization = used_memory / total_memory if total_memory > 0 else 0
        under_pressure = utilization > self.config.gpu_memory_threshold

        return {
            'total_memory': total_memory,
            'used_memory': used_memory,
            'free_memory': free_memory,
            'utilization': utilization,
            'under_pressure': under_pressure,
        }

    def reset_stats(self) -> None:
        """Reset cache statistics."""
        self.cache_hits = 0
        self.cache_misses = 0
        self.eviction_count = 0
        self.total_load_time = 0.0
        self.load_count = 0
        self.eviction_history.clear()

        self.logger.info("Cache statistics reset")

    # ==================== Private Methods ====================

    def _evict(self) -> None:
        """Evict a model from cache using configured strategy."""
        candidate = self._select_eviction_candidate()
        if not candidate:
            self.logger.warning("No eviction candidate found - cache full with pinned models")
            raise RuntimeError("Cannot evict: all models are pinned")

        self._perform_eviction(candidate, reason=self.config.eviction_strategy)

    def _select_eviction_candidate(self) -> Optional[str]:
        """Select a model for eviction based on strategy."""
        # Filter out pinned models
        candidates = [(k, v) for k, v in self.cache.items() if not v.pinned]

        if not candidates:
            return None

        strategy = self.config.eviction_strategy

        if strategy == 'lru':
            # Evict least-recently-used (first in OrderedDict)
            return candidates[0][0]

        elif strategy == 'lfu':
            # Evict least-frequently-used
            min_access = min(e.access_count for _, e in candidates)
            for model_id, entry in candidates:
                if entry.access_count == min_access:
                    return model_id

        elif strategy == 'access-time':
            # Evict model with longest idle time
            now = time.time()
            max_idle = 0
            max_idle_id = None

            for model_id, entry in candidates:
                idle_time = now - entry.last_access_time
                if idle_time > max_idle:
                    max_idle = idle_time
                    max_idle_id = model_id

            return max_idle_id

        # Fallback to LRU
        return candidates[0][0]

    def _perform_eviction(self, model_id: str, reason: str) -> None:
        """Perform actual eviction of a model."""
        entry = self.cache.get(model_id)
        if not entry:
            return

        self.logger.info(f"Evicting model: {model_id} (reason={reason})")

        # Record eviction event
        event = {
            'model_id': model_id,
            'reason': reason,
            'timestamp': time.time(),
            'memory_freed': entry.memory_info.gpu_memory_bytes + entry.memory_info.cpu_memory_bytes,
            'access_count': entry.access_count,
        }

        self.eviction_history.append(event)
        self.eviction_count += 1

        # Keep history bounded
        if len(self.eviction_history) > 100:
            self.eviction_history.pop(0)

        # Remove from cache
        del self.cache[model_id]

        # Cleanup model (trigger garbage collection)
        del entry.model
        del entry.tokenizer

        # Force MLX memory cleanup if available
        if MLX_AVAILABLE:
            mx.metal.clear_cache()

        self.logger.info(
            f"Model evicted: {model_id} "
            f"(freed={event['memory_freed'] / (1024**3):.2f}GB, "
            f"cached_models={len(self.cache)})"
        )

    def _get_model_memory(
        self,
        model: Any,
        loader_args: Dict[str, Any]
    ) -> ModelMemoryInfo:
        """Get memory usage information for a model."""
        # Try to estimate model memory
        gpu_memory = 0
        cpu_memory = 0
        parameter_count = 0
        quantization = loader_args.get('quantization')
        dtype = None

        # If model has parameters, count them
        if hasattr(model, 'parameters'):
            try:
                params = model.parameters()
                if hasattr(params, '__len__'):
                    parameter_count = len(params)

                # Try to get actual memory usage
                if MLX_AVAILABLE:
                    # Estimate GPU memory based on parameters
                    # TODO: Get actual memory from MLX
                    # For now, rough estimate based on param count and dtype
                    bytes_per_param = 2  # float16 default
                    if quantization == '4bit':
                        bytes_per_param = 0.5
                    elif quantization == '8bit':
                        bytes_per_param = 1

                    gpu_memory = int(parameter_count * bytes_per_param)
                    dtype = 'float16'  # Default assumption
            except Exception as e:
                self.logger.warning(f"Failed to get model memory info: {e}")

        return ModelMemoryInfo(
            gpu_memory_bytes=gpu_memory,
            cpu_memory_bytes=cpu_memory,
            parameter_count=parameter_count,
            quantization=quantization,
            dtype=dtype,
        )
