#!/usr/bin/env python3
"""
KnowRAG Studio Engine - Python Runtime
Provides MLX inference capabilities via JSON-RPC over stdio

This runtime is a thin wrapper around MLX libraries:
- Delegates model loading to models/loader.py
- Delegates generation to models/generator.py
- Delegates tokenization to models/tokenizer.py
- All business logic resides in TypeScript
"""

import sys
import json
import asyncio
import time
import uuid
import logging
import struct
from typing import Dict, Any, Optional, List, Tuple
import orjson
import msgpack

# Import configuration loader
from config_loader import get_config

# Phase 2: Object pooling for performance
from object_pool import ObjectPool

# Import our modular MLX wrappers
from models import loader, tokenizer
from models.vision_loader import VisionModelLoader, VisionModelHandle
from adapters import outlines_adapter

# Import GPU-scheduled generator (with fallback to standard generator)
try:
    from models import scheduled_generator as generator
    GPU_SCHEDULER_INTEGRATED = True
except ImportError:
    from models import generator
    GPU_SCHEDULER_INTEGRATED = False
from errors import (
    MLXRuntimeError,
    ModelLoadError,
    GenerationError,
    TokenizerError,
    GuidanceError,
    ModelNotLoaded,
    ERROR_CODE_MAP,
)
import validators

# Phase 1.3: Enhanced Telemetry
from telemetry import RuntimeTelemetry

# Metal Optimizations (Week 1: Native C++/Metal GPU optimizations)
# Import native module if available
try:
    from krserve_native import MetalMemoryPool, BlitQueue, CommandBufferRing
    from krserve_native import MetalMemoryPoolConfig, BlitQueueConfig, CommandBufferRingConfig
    METAL_OPTIMIZATIONS_AVAILABLE = True
    logging.info("✅ Metal optimization modules loaded (MetalMemoryPool, BlitQueue, CommandBufferRing)")
except ImportError:
    METAL_OPTIMIZATIONS_AVAILABLE = False
    logging.info("ℹ️ Metal optimizations not available (native module not built)")

# Week 2: CPU Optimizations (Parallel Tokenizer)
try:
    from krserve_native import ParallelTokenizer, ParallelTokenizerConfig
    CPU_TOKENIZER_AVAILABLE = True
    logging.info("✅ CPU optimization modules loaded (ParallelTokenizer)")
except ImportError:
    CPU_TOKENIZER_AVAILABLE = False
    logging.info("ℹ️ CPU tokenizer not available (native module not built)")

# Week 2: KV Cache Pool
try:
    from kv_cache_pool import KVCachePool, KVCachePoolConfig
    KV_CACHE_AVAILABLE = True
except ImportError:
    KV_CACHE_AVAILABLE = False
    logging.warning("KV cache pool not available")

# Week 3: Weight Management
try:
    from krserve_native import WeightManager, WeightManagerConfig
    WEIGHT_MANAGER_AVAILABLE = True
    logging.info("✅ Weight management modules loaded (WeightManager)")
except ImportError:
    WEIGHT_MANAGER_AVAILABLE = False
    logging.info("ℹ️ Weight management not available (native module not built)")

# Week 3: Model Registry (multi-model serving)
try:
    from model_registry import ModelRegistry, ModelRegistryConfig
    MODEL_REGISTRY_AVAILABLE = True
except ImportError:
    MODEL_REGISTRY_AVAILABLE = False
    logging.warning("Week 3 ModelRegistry not available")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# Phase 1: Binary Streaming - Message Type Constants
MSG_TYPE_TOKEN = 1  # Token chunk (stream.chunk)
MSG_TYPE_STATS = 2  # Statistics (stream.stats)
MSG_TYPE_EVENT = 3  # Events (stream.event)
MSG_TYPE_DONE = 4   # Stream completion (stream.done)


class RuntimeServer:
    """Lightweight Python runtime exposing MLX bindings via JSON-RPC"""

    def __init__(self):
        # Model handle storage (TypeScript decides when to load/unload)
        self.models: Dict[str, loader.ModelHandle] = {}
        self.vision_models: Dict[str, VisionModelHandle] = {}
        self.vision_loader = VisionModelLoader()
        self.shutdown_requested: bool = False
        # Stream task tracking
        self.stream_tasks: Dict[str, asyncio.Task] = {}
        # Bug Fix #55 Phase 1: Track runtime restart count for state reconciliation
        # This helps TypeScript detect when Python process has restarted
        self.restart_count: int = 0

        # Week 2: Continuous batching - per-model batcher instances
        self.continuous_batchers: Dict[str, Any] = {}  # model_id -> ContinuousBatcher

        # Phase 1.3: Initialize telemetry with config
        config = get_config()
        self.telemetry = RuntimeTelemetry(
            enabled=config.telemetry_enabled,
            sampling_rate=config.telemetry_sampling_rate
        )

        # Metal Optimizations (Week 1: Native C++/Metal GPU optimizations)
        self.metal_pool: Optional[MetalMemoryPool] = None
        self.blit_queue: Optional[BlitQueue] = None
        self.command_ring: Optional[CommandBufferRing] = None

        # Week 2: CPU Optimizations
        self.cpu_tokenizer: Optional[Any] = None  # ParallelTokenizer if available

        # Week 2: KV Cache Pool
        self.kv_cache_pool: Optional[KVCachePool] = None

        # Week 3: Weight Management
        self.weight_manager: Optional[Any] = None  # WeightManager if available

        # Week 3: Model Registry (multi-model serving)
        self.model_registry: Optional[ModelRegistry] = None

        # Phase 1: Binary Streaming (Performance Optimization)
        # Enable binary mode for MessagePack token streaming (3-5% performance gain)
        self.binary_mode: bool = config.use_messagepack if hasattr(config, 'use_messagepack') else False

        # Phase 2: Object Pooling (Performance Optimization)
        # Reuse dictionaries to reduce GC pressure (2-3% performance gain)
        pooling_enabled = config.object_pooling_enabled if hasattr(config, 'object_pooling_enabled') else True
        chunk_pool_size = config.chunk_pool_size if hasattr(config, 'chunk_pool_size') else 100
        stats_pool_size = config.stats_pool_size if hasattr(config, 'stats_pool_size') else 20
        event_pool_size = config.event_pool_size if hasattr(config, 'event_pool_size') else 20

        self.chunk_pool = ObjectPool(
            factory=lambda: {},
            reset=lambda d: d.clear(),
            max_size=chunk_pool_size,
            enabled=pooling_enabled
        )

        self.stats_pool = ObjectPool(
            factory=lambda: {},
            reset=lambda d: d.clear(),
            max_size=stats_pool_size,
            enabled=pooling_enabled
        )

        self.event_pool = ObjectPool(
            factory=lambda: {},
            reset=lambda d: d.clear(),
            max_size=event_pool_size,
            enabled=pooling_enabled
        )

        # Initialize native optimizations based on config
        self._initialize_native_optimizations()

    def _initialize_native_optimizations(self) -> None:
        """Initialize native C++ optimization modules if available and enabled"""
        config = get_config()

        # Week 1: Metal Optimizations
        if METAL_OPTIMIZATIONS_AVAILABLE and config.metal_optimizations_enabled:
            try:
                # Metal Memory Pool
                pool_config = MetalMemoryPoolConfig()
                pool_config.heap_size_mb = config.metal_optimizations.get('memory_pool', {}).get('heap_size_mb', 512)
                pool_config.track_statistics = config.metal_optimizations.get('memory_pool', {}).get('track_statistics', True)
                self.metal_pool = MetalMemoryPool(pool_config)
                logging.info(f"✅ Metal Memory Pool initialized: heap_size={pool_config.heap_size_mb}MB")

                # Blit Queue
                blit_config = BlitQueueConfig()
                blit_config.max_pending_ops = config.metal_optimizations.get('blit_queue', {}).get('max_pending_ops', 16)
                blit_config.track_metrics = config.metal_optimizations.get('blit_queue', {}).get('track_metrics', True)
                self.blit_queue = BlitQueue(blit_config)
                logging.info(f"✅ Blit Queue initialized: max_pending_ops={blit_config.max_pending_ops}")

                # Command Buffer Ring
                ring_config = CommandBufferRingConfig()
                ring_config.ring_size = config.metal_optimizations.get('command_ring', {}).get('ring_size', 3)
                ring_config.track_statistics = config.metal_optimizations.get('command_ring', {}).get('track_statistics', True)
                self.command_ring = CommandBufferRing(ring_config)
                logging.info(f"✅ Command Buffer Ring initialized: ring_size={ring_config.ring_size}")

            except Exception as e:
                logging.warning(f"⚠️ Failed to initialize Metal optimizations: {e}")
                self.metal_pool = None
                self.blit_queue = None
                self.command_ring = None
        else:
            if METAL_OPTIMIZATIONS_AVAILABLE:
                logging.info("ℹ️ Metal optimizations available but disabled in config")
            else:
                logging.info("ℹ️ Metal optimizations not available (native module not built)")

        # Week 2: CPU Optimizations
        if CPU_TOKENIZER_AVAILABLE and config.cpu_optimizations_enabled:
            try:
                tok_config = ParallelTokenizerConfig()
                tok_config.num_threads = config.cpu_optimizations.get('parallel_tokenizer', {}).get('num_threads', 8)
                tok_config.use_accelerate = config.cpu_optimizations.get('parallel_tokenizer', {}).get('use_accelerate', True)
                tok_config.enable_stats = config.cpu_optimizations.get('parallel_tokenizer', {}).get('enable_stats', True)

                self.cpu_tokenizer = ParallelTokenizer(tok_config)
                logging.info(f"✅ Parallel Tokenizer initialized: threads={tok_config.num_threads}, accelerate={tok_config.use_accelerate}")

            except Exception as e:
                logging.warning(f"⚠️ Failed to initialize CPU optimizations: {e}")
                self.cpu_tokenizer = None
        else:
            if CPU_TOKENIZER_AVAILABLE:
                logging.info("ℹ️ CPU optimizations available but disabled in config")
            else:
                logging.info("ℹ️ CPU optimizations not available (native module not built)")

        # Week 3: Weight Management
        if WEIGHT_MANAGER_AVAILABLE and config.weight_management_enabled:
            try:
                wm_config = WeightManagerConfig()
                wm_config.pin_critical_weights = config.weight_management.get('pin_critical_weights', True)
                wm_config.prefetch_enabled = config.weight_management.get('prefetch_enabled', True)
                wm_config.prefetch_threads = config.weight_management.get('prefetch_threads', 2)
                wm_config.warmup_on_load = config.weight_management.get('warmup_on_load', True)
                wm_config.warmup_buffer_mb = config.weight_management.get('warmup_buffer_mb', 512)

                self.weight_manager = WeightManager(wm_config)
                logging.info(f"✅ Weight Manager initialized: pin={wm_config.pin_critical_weights}, prefetch={wm_config.prefetch_enabled}")

            except Exception as e:
                logging.warning(f"⚠️ Failed to initialize Weight Manager: {e}")
                self.weight_manager = None
        else:
            if WEIGHT_MANAGER_AVAILABLE:
                logging.info("ℹ️ Weight management available but disabled in config")
            else:
                logging.info("ℹ️ Weight management not available (native module not built)")

    def _notify(self, method: str, params: Dict[str, Any]) -> None:
        """Emit JSON-RPC notification to stdout"""
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        print(orjson.dumps(payload).decode("utf-8"), flush=True)

    def _notify_binary(self, msg_type: int, params: Dict[str, Any]) -> None:
        """
        Emit binary notification using MessagePack (Phase 1: Performance Optimization)

        Message Format:
            [4 bytes: length (big-endian)] + [N bytes: msgpack data]

        Message Types:
            1 = Token (stream.chunk)
            2 = Stats (stream.stats)
            3 = Event (stream.event)
            4 = Done (stream.done)

        Performance:
            - JSON: ~150 bytes per token
            - MessagePack: ~20 bytes per token
            - Bandwidth savings: ~85%
            - Throughput improvement: 3-5% on 14B+ models
        """
        try:
            # Pack message with MessagePack (compact binary format)
            packed = msgpack.packb({
                't': msg_type,  # Message type (1-4)
                'p': params     # Payload parameters
            }, use_bin_type=True)

            # Write length prefix (4 bytes, big-endian) + packed data
            length = len(packed)
            sys.stdout.buffer.write(struct.pack('>I', length))
            sys.stdout.buffer.write(packed)
            sys.stdout.buffer.flush()
        except Exception as e:
            # Fallback to JSON if binary serialization fails
            logging.warning(f"Binary notification failed, falling back to JSON: {e}")
            method_map = {
                MSG_TYPE_TOKEN: "stream.chunk",
                MSG_TYPE_STATS: "stream.stats",
                MSG_TYPE_EVENT: "stream.event",
                MSG_TYPE_DONE: "stream.done"
            }
            self._notify(method_map.get(msg_type, "stream.event"), params)

    def _serialize_error(self, exc: Exception) -> Dict[str, Any]:
        """Translate Python exceptions to JSON-RPC error objects"""
        if isinstance(exc, MLXRuntimeError):
            code = ERROR_CODE_MAP.get(type(exc), -32099)
            data = {"model_id": exc.model_id} if hasattr(exc, "model_id") else {}
            return {"code": code, "message": exc.message, "data": data}
        elif isinstance(exc, ValueError):
            # Bug #19 Fix: Handle validation errors from validators.py
            # ValueError from validators should be exposed (they are safe validation messages)
            error_log_message = f"Validation error: {exc}"
            print(error_log_message, file=sys.stderr, flush=True)
            return {
                "code": -32602,  # Invalid params (JSON-RPC standard)
                "message": str(exc),
                "data": {"type": "ValidationError"},
            }
        else:
            # Generic error to prevent leaking sensitive information
            # Log the full error for debugging
            error_log_message = f"Unexpected error in runtime: {type(exc).__name__}: {exc}"
            print(error_log_message, file=sys.stderr, flush=True)
            return {
                "code": -32099,
                "message": "An unexpected internal error occurred",
                "data": {"type": "InternalError"},
            }

    async def handle_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Handle incoming JSON-RPC request or notification

        Returns:
            Response dict for requests (with id), None for notifications (without id)
        """
        method = request.get("method")
        params = request.get("params", {})
        req_id = request.get("id")

        # Check if this is a notification (no 'id' field)
        is_notification = 'id' not in request

        try:
            if method == "runtime/info":
                result = await self.get_runtime_info()
            elif method == "runtime/state":
                # Bug Fix #55 Phase 1: Add runtime/state method for state reconciliation
                result = await self.get_runtime_state()
            elif method == "runtime/telemetry":
                # Phase 1.3: Enhanced Telemetry
                result = await self.get_telemetry_report()
            elif method == "shutdown":
                result = await self.shutdown()
            elif method == "load_model":
                result = await self.load_model(params)
            elif method == "unload_model":
                result = await self.unload_model(params)
            elif method == "generate":
                result = await self.generate(params)
            elif method == "batch_generate":
                result = await self.batch_generate(params)
            elif method == "batch_generate_parallel":
                # Week 1: Static GPU Batching
                result = await self.batch_generate_parallel(params)
            elif method == "continuous_generate":
                # Week 2: Continuous Batching
                result = await self.continuous_generate(params)
            elif method == "get_batcher_metrics":
                # Week 3: Metrics endpoint
                result = await self.get_batcher_metrics(params)
            elif method == "get_batcher_health":
                # Week 3 Day 3: Health check endpoint
                result = await self.get_batcher_health(params)
            elif method == "get_week4_metrics":
                # Week 4: Memory optimization metrics
                result = await self.get_week4_metrics(params)
            elif method == "tokenize":
                result = await self.tokenize_request(params)
            elif method == "check_draft":
                result = await self.check_draft(params)
            elif method == "batch_tokenize":
                # Week 1: Request Batching
                result = await self.batch_tokenize(params)
            elif method == "batch_check_draft":
                # Week 1: Request Batching
                result = await self.batch_check_draft(params)
            elif method == "load_vision_model":
                result = await self.load_vision_model(params)
            elif method == "generate_with_image":
                result = await self.generate_with_image(params)
            else:
                raise ValueError(f"Unknown method: {method}")

            # Don't send response for notifications (JSON-RPC 2.0 spec)
            if is_notification:
                return None

            return {"jsonrpc": "2.0", "id": req_id, "result": result}

        except Exception as exc:
            error_obj = self._serialize_error(exc)

            # Don't send error response for notifications
            if is_notification:
                # Log error for debugging but don't respond
                print(f"Error in notification: {exc}", file=sys.stderr, flush=True)
                return None

            return {"jsonrpc": "2.0", "id": req_id, "error": error_obj}

    async def get_runtime_info(self) -> Dict[str, Any]:
        """Return runtime version and capabilities"""
        mlx_supported = loader.MLX_AVAILABLE

        if mlx_supported:
            try:
                import mlx.core as mx

                # Bug #20 Fix: mlx.__version__ doesn't exist, use mlx.core.__version__
                mlx_version = mx.__version__ if hasattr(mx, "__version__") else "unknown"
            except ImportError:
                mlx_version = "not installed"

            try:
                import mlx_lm

                mlx_lm_version = mlx_lm.__version__ if hasattr(mlx_lm, "__version__") else "unknown"
            except ImportError:
                mlx_lm_version = "not installed"
        else:
            # Bug #1 P0: Avoid importing MLX on unsupported hosts to prevent SIGABRT.
            mlx_version = loader.MLX_IMPORT_ERROR or "unsupported"
            mlx_lm_version = loader.MLX_IMPORT_ERROR or "unsupported"

        # Get memory info for RuntimeInfoResponse
        # Bug #27 Fix: Match TypeScript RuntimeInfo schema (rss/vms instead of used/available/total)
        try:
            import psutil
            process = psutil.Process()
            mem_info = process.memory_info()
            memory = {
                "rss": mem_info.rss,        # Resident Set Size
                "vms": mem_info.vms         # Virtual Memory Size
            }
        except ImportError:
            # Fallback if psutil not available
            memory = {
                "rss": 0,
                "vms": 0
            }

        capabilities = []
        if mlx_supported:
            capabilities = [
                "load_model",
                "generate",
                "batch_generate",      # v1.3: Generate batching (IPC-level)
                "batch_generate_parallel",  # Week 1: GPU-level batching
                "continuous_generate",      # Week 2: Continuous batching
                "get_batcher_metrics",      # Week 3 Day 2: Metrics endpoint
                "get_batcher_health",       # Week 3 Day 3: Health check endpoint
                "get_week4_metrics",        # Week 4: Memory optimization metrics
                "tokenize",
                "check_draft",
                "guidance",
                "batch_tokenize",       # Week 1: Request Batching
                "batch_check_draft",    # Week 1: Request Batching
                "runtime/telemetry",    # Phase 1.3: Enhanced Telemetry
            ]
            if getattr(loader, "MLX_VLM_AVAILABLE", False):
                capabilities.extend([
                    "load_vision_model",
                    "generate_with_image",
                ])

        return {
            "version": "0.1.0",
            "mlx_version": mlx_version,
            "mlx_lm_version": mlx_lm_version,
            "protocol": "json-rpc-2.0",
            "capabilities": capabilities,
            "mlx_supported": mlx_supported,
            "memory": memory,  # Add memory field for RuntimeInfoResponse
        }

    async def get_runtime_state(self) -> Dict[str, Any]:
        """
        Return current runtime state for reconciliation
        Bug Fix #55 Phase 1: State Synchronization Protocol

        This method exposes Python's internal state (loaded models, active streams)
        to TypeScript for state reconciliation after Python restart.

        Returns:
            loaded_models: List of currently loaded models with their state
            active_streams: Number of active generation streams
            restart_count: Runtime restart counter (incremented on each state request)
        """
        # BUG-013 FIX: Increment restart counter on each state reconciliation
        # This allows TypeScript to detect Python process restarts
        self.restart_count += 1

        loaded_models = []

        # Collect text models
        for model_id, handle in self.models.items():
            loaded_models.append({
                "model_id": model_id,
                "state": "ready",  # All models in self.models are ready
                "type": "text",
            })

        # Collect vision models
        for model_id, handle in self.vision_models.items():
            loaded_models.append({
                "model_id": model_id,
                "state": "ready",
                "type": "vision",
            })

        return {
            "loaded_models": loaded_models,
            "active_streams": len(self.stream_tasks),
            "restart_count": self.restart_count,
        }

    async def get_telemetry_report(self) -> Dict[str, Any]:
        """
        Get telemetry performance report (Phase 1.3)

        Returns comprehensive performance metrics including:
        - Generation stats (calls, tokens, latency percentiles)
        - Tokenization stats (calls, latency percentiles)
        - Error rates and timeouts
        """
        report = self.telemetry.get_report()

        # Add native optimization statistics (Week 1-3)
        report['native_optimizations'] = self._get_optimization_stats()

        return report

    def _get_optimization_stats(self) -> Dict[str, Any]:
        """Get statistics from native optimization modules"""
        stats = {
            'enabled': {
                'metal_pool': self.metal_pool is not None,
                'blit_queue': self.blit_queue is not None,
                'command_ring': self.command_ring is not None,
                'cpu_tokenizer': self.cpu_tokenizer is not None,
                'weight_manager': self.weight_manager is not None,
            },
            'statistics': {}
        }

        # Week 1: Metal optimizations
        if self.metal_pool:
            try:
                stats['statistics']['metal_pool'] = self.metal_pool.get_statistics()
            except Exception as e:
                stats['statistics']['metal_pool'] = {'error': str(e)}

        if self.blit_queue:
            try:
                stats['statistics']['blit_queue'] = self.blit_queue.get_statistics()
            except Exception as e:
                stats['statistics']['blit_queue'] = {'error': str(e)}

        if self.command_ring:
            try:
                stats['statistics']['command_ring'] = self.command_ring.get_statistics()
            except Exception as e:
                stats['statistics']['command_ring'] = {'error': str(e)}

        # Week 2: CPU optimizations
        if self.cpu_tokenizer:
            try:
                stats['statistics']['cpu_tokenizer'] = self.cpu_tokenizer.get_statistics()
            except Exception as e:
                stats['statistics']['cpu_tokenizer'] = {'error': str(e)}

        # Week 3: Weight management
        if self.weight_manager:
            try:
                stats['statistics']['weight_manager'] = self.weight_manager.get_statistics()
            except Exception as e:
                stats['statistics']['weight_manager'] = {'error': str(e)}

        return stats

    async def load_model(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Load a model into memory"""
        model_id = params.get("model_id")
        model_id = validators.validate_model_id(model_id)

        # Validate load options
        validators.validate_load_model_params(params)

        try:
            # Week 3: Pre-warm memory before model loading (if Weight Manager enabled)
            if self.weight_manager:
                warmup_mb = params.get('warmup_buffer_mb', 512)
                try:
                    self.weight_manager.warmup_model(warmup_mb)
                    logging.info(f"[WeightManager] Pre-warmed {warmup_mb}MB memory before loading {model_id}")
                except Exception as e:
                    logging.warning(f"[WeightManager] Warmup failed: {e}")

            # Delegate to loader module
            handle = loader.load_model(model_id, params)
            self.models[model_id] = handle

            # Return metadata
            return {
                "model_id": model_id,
                "state": "ready",
                "context_length": handle.metadata.get("context_length", 8192),
                "parameter_count": handle.metadata.get("parameter_count", 0),
                "dtype": handle.metadata.get("dtype", "unknown"),
                "is_vision_model": handle.metadata.get("is_vision_model", False),
                "cached_path": handle.metadata.get("cached_path"),  # Phase 2: Return path for artifact cache
            }

        except ModelLoadError:
            raise
        except Exception as exc:
            raise ModelLoadError(model_id, f"Unexpected error: {exc}") from exc

    async def load_vision_model(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Load a vision-language model via mlx-vlm"""
        model_id = validators.validate_model_id(params.get("model_id"))
        validators.validate_vision_load_params(params)

        try:
            handle = await self.vision_loader.load_vision_model(
                model_id=model_id,
                revision=params.get("revision", "main"),
                quantization=params.get("quantization"),
                local_path=params.get("local_path"),
            )
            self.vision_models[model_id] = handle

            metadata = handle.metadata
            return {
                "model_id": model_id,
                "state": "ready",
                "context_length": metadata.get("context_length"),
                "processor_type": metadata.get("processor_type"),
                "image_size": metadata.get("image_size"),
                "revision": metadata.get("revision"),
                "quantization": metadata.get("quantization"),
                "dtype": metadata.get("dtype", "unknown"),
                "is_vision_model": True,
            }

        except ModelLoadError:
            raise
        except Exception as exc:
            raise ModelLoadError(model_id, f"Unexpected error: {exc}") from exc

    async def unload_model(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Unload a model from memory"""
        model_id = params.get("model_id")
        model_id = validators.validate_model_id(model_id)

        if model_id in self.models:
            handle = self.models[model_id]
            # Delegate to loader module for cleanup
            loader.unload_model(handle)
            del self.models[model_id]
        elif model_id in self.vision_models:
            handle = self.vision_models[model_id]
            self.vision_loader.unload_model(handle)
            del self.vision_models[model_id]

        return {"success": True}

    async def generate(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Generate tokens from a prompt (streaming)"""
        model_id = params.get("model_id")
        model_id = validators.validate_model_id(model_id)

        # Validate generation parameters
        validators.validate_generation_params(params)

        if model_id not in self.models:
            raise ModelNotLoaded(model_id)

        handle = self.models[model_id]

        # Generate unique stream ID
        stream_id = params.get("stream_id") or str(uuid.uuid4())

        # Validate stream_id doesn't already exist (prevents collision)
        if stream_id in self.stream_tasks:
            raise ValueError(f"Stream ID '{stream_id}' is already in use")

        params["stream_id"] = stream_id
        started_at = time.time()

        # Create notification emitters (Phase 1: Binary streaming support)
        async def emit_chunk(chunk_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_TOKEN, chunk_params)
            else:
                self._notify("stream.chunk", chunk_params)

        async def emit_stats(stats_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_STATS, stats_params)
            else:
                self._notify("stream.stats", stats_params)

        async def emit_event(event_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_EVENT, event_params)
            else:
                self._notify("stream.event", event_params)

        # Wrapper to handle task lifecycle
        async def run_generation() -> None:
            try:
                # Phase 2: Pass object pools to generator
                await generator.stream_generate(
                    handle, params, emit_chunk, emit_stats, emit_event,
                    chunk_pool=self.chunk_pool,
                    stats_pool=self.stats_pool,
                    event_pool=self.event_pool
                )
            except Exception as exc:
                # Log error and emit error event (Phase 2: Use pool)
                if self.event_pool and self.event_pool.enabled:
                    event_data = self.event_pool.acquire()
                    event_data["stream_id"] = stream_id
                    event_data["event"] = "error"
                    event_data["error"] = str(exc)
                    event_data["is_final"] = True
                    await emit_event(event_data)
                    self.event_pool.release(event_data)
                else:
                    await emit_event({
                        "stream_id": stream_id,
                        "event": "error",
                        "error": str(exc),
                        "is_final": True,
                    })
            finally:
                # Always cleanup
                self.stream_tasks.pop(stream_id, None)

        # Start async task to stream tokens
        task = asyncio.create_task(run_generation())
        self.stream_tasks[stream_id] = task

        # Return stream handshake immediately
        return {
            "stream_id": stream_id,
            "started_at": started_at,
        }

    async def generate_with_image(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Generate tokens with a vision-language model"""
        model_id = validators.validate_model_id(params.get("model_id"))
        validators.validate_generation_params(params)

        if model_id not in self.vision_models:
            raise ModelNotLoaded(model_id)

        image_param = params.get("image")
        if image_param is None:
            raise ValueError("image parameter is required for vision generation")

        image_bytes = validators.validate_base64_image(image_param)
        handle = self.vision_models[model_id]

        try:
            image_embedding = self.vision_loader.encode_image(handle, image_bytes)
        except GenerationError:
            raise
        except Exception as exc:
            raise GenerationError(model_id, f"Image encoding failed: {exc}") from exc

        stream_id = params.get("stream_id") or str(uuid.uuid4())

        # Validate stream_id doesn't already exist (prevents collision)
        if stream_id in self.stream_tasks:
            raise ValueError(f"Stream ID '{stream_id}' is already in use")

        params["stream_id"] = stream_id
        started_at = time.time()

        # Create notification emitters (Phase 1: Binary streaming support)
        async def emit_chunk(chunk_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_TOKEN, chunk_params)
            else:
                self._notify("stream.chunk", chunk_params)

        async def emit_stats(stats_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_STATS, stats_params)
            else:
                self._notify("stream.stats", stats_params)

        async def emit_event(event_params: Dict[str, Any]) -> None:
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_EVENT, event_params)
            else:
                self._notify("stream.event", event_params)

        async def run_generation() -> None:
            try:
                # Phase 2: Pass object pools to vision generator
                await self.vision_loader.stream_generate(
                    handle,
                    params,
                    image_embedding,
                    emit_chunk,
                    emit_stats,
                    emit_event,
                    stream_id=stream_id,
                    chunk_pool=self.chunk_pool,
                    stats_pool=self.stats_pool,
                    event_pool=self.event_pool,
                )
            except Exception as exc:
                # Log error and emit error event (Phase 2: Use pool)
                if self.event_pool and self.event_pool.enabled:
                    event_data = self.event_pool.acquire()
                    event_data["stream_id"] = stream_id
                    event_data["event"] = "error"
                    event_data["error"] = str(exc)
                    event_data["is_final"] = True
                    await emit_event(event_data)
                    self.event_pool.release(event_data)
                else:
                    await emit_event(
                        {
                            "stream_id": stream_id,
                            "event": "error",
                            "error": str(exc),
                            "is_final": True,
                        }
                    )
            finally:
                self.stream_tasks.pop(stream_id, None)

        task = asyncio.create_task(run_generation())
        self.stream_tasks[stream_id] = task

        return {"stream_id": stream_id, "started_at": started_at}

    async def tokenize_request(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Tokenize text"""
        model_id = params.get("model_id")
        model_id = validators.validate_model_id(model_id)

        # Validate tokenize parameters
        validators.validate_tokenize_params(params)

        text = params.get("text", "")
        add_special_tokens = params.get("add_special_tokens", True)

        if model_id not in self.models:
            raise ModelNotLoaded(model_id)

        handle = self.models[model_id]

        # Phase 1.3: Record telemetry
        start_time = time.time()
        result = None

        try:
            # Delegate to tokenizer module using thread offload to enable concurrency
            result = await asyncio.to_thread(
                tokenizer.tokenize,
                handle,
                text,
                add_special_tokens=add_special_tokens,
            )

            # Record telemetry (very low overhead)
            duration_ms = (time.time() - start_time) * 1000
            self.telemetry.record_tokenize(duration_ms, len(result.tokens))

            return {
                "tokens": result.tokens,
                "token_strings": result.token_strings,
            }

        except TokenizerError:
            raise
        except Exception as exc:
            raise TokenizerError(model_id, f"Tokenization failed: {exc}") from exc

    async def check_draft(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check if draft model is compatible with primary."""
        return await asyncio.to_thread(self._check_draft_sync, params)

    def _check_draft_sync(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Synchronous helper for draft compatibility checks."""
        # Backend Bug #29 Fix: Match TypeScript serializer param names (primary_id, draft_id)
        primary_id = params.get("primary_id")
        draft_id = params.get("draft_id")

        # Validate both model IDs
        primary_id = validators.validate_model_id(primary_id)
        draft_id = validators.validate_model_id(draft_id)

        if primary_id not in self.models:
            raise ModelNotLoaded(primary_id)
        if draft_id not in self.models:
            raise ModelNotLoaded(draft_id)

        primary = self.models[primary_id]
        draft = self.models[draft_id]

        warnings: List[str] = []
        errors: List[str] = []

        # Week 2 Day 1: Enhanced Compatibility Checks

        # 1. Vocabulary compatibility (CRITICAL)
        if hasattr(primary.tokenizer, "vocab_size") and hasattr(draft.tokenizer, "vocab_size"):
            primary_vocab = primary.tokenizer.vocab_size
            draft_vocab = draft.tokenizer.vocab_size

            if primary_vocab != draft_vocab:
                errors.append(
                    f"Vocabulary size mismatch: primary={primary_vocab}, draft={draft_vocab}. "
                    f"Speculative decoding requires identical vocabulary."
                )

        # 2. Architecture family check
        primary_arch = primary.metadata.get("architecture", "unknown")
        draft_arch = draft.metadata.get("architecture", "unknown")

        if primary_arch != "unknown" and draft_arch != "unknown":
            if primary_arch != draft_arch:
                warnings.append(
                    f"Architecture mismatch: primary={primary_arch}, draft={draft_arch}. "
                    f"Different architectures may have compatibility issues."
                )

        # 3. Model size check (draft should be smaller for performance gain)
        primary_params = primary.metadata.get("parameter_count", 0)
        draft_params = draft.metadata.get("parameter_count", 0)

        if draft_params >= primary_params:
            warnings.append(
                f"Draft model is not smaller than primary: "
                f"draft={draft_params:,}, primary={primary_params:,}. "
                f"Expected performance gain may not materialize."
            )

        # 4. Calculate speedup ratio (rough estimate)
        speedup_ratio = 1.0
        if draft_params > 0 and primary_params > 0:
            size_ratio = draft_params / primary_params
            speedup_ratio = 1.0 + (1.0 - size_ratio) * 0.3  # Conservative estimate

        # 5. Tokenizer special tokens check
        if hasattr(primary.tokenizer, "bos_token_id") and hasattr(draft.tokenizer, "bos_token_id"):
            if primary.tokenizer.bos_token_id != draft.tokenizer.bos_token_id:
                warnings.append(
                    f"BOS token mismatch: primary={primary.tokenizer.bos_token_id}, "
                    f"draft={draft.tokenizer.bos_token_id}"
                )

        if hasattr(primary.tokenizer, "eos_token_id") and hasattr(draft.tokenizer, "eos_token_id"):
            if primary.tokenizer.eos_token_id != draft.tokenizer.eos_token_id:
                warnings.append(
                    f"EOS token mismatch: primary={primary.tokenizer.eos_token_id}, "
                    f"draft={draft.tokenizer.eos_token_id}"
                )

        # Compatible if no ERRORS (warnings are acceptable)
        compatible = len(errors) == 0

        # Week 2 Day 1: Enhanced compatibility report
        return {
            "compatible": compatible,
            "errors": errors,
            "warnings": warnings,
            "details": {
                "primary_model": {
                    "id": primary_id,
                    "vocab_size": getattr(primary.tokenizer, "vocab_size", None),
                    "parameter_count": primary_params,
                    "architecture": primary_arch,
                },
                "draft_model": {
                    "id": draft_id,
                    "vocab_size": getattr(draft.tokenizer, "vocab_size", None),
                    "parameter_count": draft_params,
                    "architecture": draft_arch,
                },
                "performance_estimate": {
                    "expected_speedup": f"{speedup_ratio:.2f}x",
                    "size_ratio": f"{(draft_params / primary_params * 100):.1f}%" if primary_params > 0 else "N/A",
                    "recommendation": "Good pairing" if compatible and draft_params < primary_params * 0.5 else "May not provide significant speedup",
                },
            },
        }

    async def batch_generate(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Batch dispatch streaming generation handshakes (v1.3.0 feature).

        This handler collapses multiple `generate` RPCs into a single call while
        preserving per-request semantics: every entry must include a unique
        `stream_id`, validation and telemetry reuse the existing `generate`
        implementation, and stream notifications fan out normally via the
        underlying event emitters.

        Args:
            params: {"requests": [GenerateParams & {"stream_id": str}]}

        Returns:
            {"results": [{"success": bool, "result": {...} | None, "error": str | None}]}

        Raises:
            ValueError: when `requests` is not a list, a request omits `stream_id`,
                or duplicate stream identifiers are detected in the batch.
        """
        requests = params.get("requests", [])

        if not isinstance(requests, list):
            raise ValueError("batch_generate expects 'requests' to be a list")

        if not requests:
            return {"results": []}

        # Ensure each request declares a distinct stream identifier to avoid
        # clobbering entries in self.stream_tasks during the per-request generate().
        seen_stream_ids = set()
        for idx, req in enumerate(requests):
            stream_id = req.get("stream_id")
            if stream_id is None:
                raise ValueError(f"batch_generate request at index {idx} is missing 'stream_id'")
            if stream_id in seen_stream_ids:
                raise ValueError(f"Duplicate stream_id '{stream_id}' detected in batch_generate payload")
            seen_stream_ids.add(stream_id)

        # LAYER 3 FIX: Run sequentially instead of asyncio.gather()
        # Concurrent execution causes SIGTRAP (concurrent Metal GPU access)
        # Sequential execution is protected by MLX semaphore in generator.py
        results: List[Dict[str, Any]] = []
        for req in requests:
            try:
                response = await self.generate(dict(req))
                results.append({
                    "success": True,
                    "result": response,
                    "error": None,
                })
            except Exception as exc:
                error_obj = self._serialize_error(exc)
                results.append({
                    "success": False,
                    "result": None,
                    "error": error_obj.get("message", str(exc)),
                })

        return {"results": results}

    async def batch_generate_parallel(self, params: Dict[str, Any]) -> None:
        """
        GPU-level batch generation (Week 1: Static Batching)

        Processes multiple requests in parallel on GPU, vs sequential batch_generate.
        All requests MUST use the same model.

        Key differences from batch_generate:
        - batch_generate: IPC batching (still sequential GPU generation)
        - batch_generate_parallel: True GPU batching (parallel generation)

        Args:
            params: {
                "requests": [GenerateParams & {"stream_id": str}],
                "batch_size": int (optional, default: 4)
            }

        Raises:
            ValueError: If requests use different models or invalid params
            GenerationError: If batch generation fails
        """
        from models.batch_generator import BatchGenerator, create_batch_request

        requests = params.get("requests", [])

        if not isinstance(requests, list):
            raise ValueError("batch_generate_parallel expects 'requests' to be a list")

        if not requests:
            return  # Nothing to do

        # Validate all requests use same model
        model_ids = set(req.get("model_id") for req in requests)
        if len(model_ids) > 1:
            raise ValueError(
                f"batch_generate_parallel requires all requests to use same model, "
                f"got: {model_ids}"
            )

        model_id = requests[0].get("model_id")
        if not model_id:
            raise ValueError("model_id required in requests")

        # Validate model_id
        model_id = validators.validate_model_id(model_id)

        if model_id not in self.models:
            raise ModelNotLoaded(model_id)

        handle = self.models[model_id]

        # Get batch size
        batch_size = params.get("batch_size", 4)

        # Create BatchGenerator
        batch_gen = BatchGenerator(
            handle=handle,
            batch_size=batch_size
        )

        # Create batch requests
        batch_requests = []
        for req in requests:
            # Generate unique request ID if not provided
            request_id = req.get("request_id", str(uuid.uuid4()))

            # Create batch request
            batch_req = create_batch_request(
                request_id=request_id,
                params=req,
                tokenizer=handle.tokenizer
            )

            batch_requests.append(batch_req)

        # Define callbacks for token emission (Phase 1: Binary streaming support)
        def emit_token(stream_id: str, token: int, text: str):
            """Emit token chunk notification"""
            chunk_params = {
                "stream_id": stream_id,
                "token": text,  # Token text
                "token_id": token,  # Token ID
                "is_final": False
            }
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_TOKEN, chunk_params)
            else:
                self._notify("stream.chunk", chunk_params)

        def emit_complete(stream_id: str, stats: Dict[str, Any]):
            """Emit completion notification"""
            event_params = {
                "stream_id": stream_id,
                "event": "completed",
                "stats": stats,
                "is_final": True
            }
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_EVENT, event_params)
            else:
                self._notify("stream.event", event_params)

        # Run batch generation
        await batch_gen.generate_batch(
            batch_requests,
            emit_token=emit_token,
            emit_complete=emit_complete
        )

        # Note: This is a notification-based method (no return value)
        # TypeScript receives tokens via stream.chunk notifications

    async def continuous_generate(self, params: Dict[str, Any]) -> None:
        """
        Add request to continuous batcher (Week 2: Continuous Batching)

        Unlike batch_generate_parallel (Week 1), this doesn't wait for a full batch.
        Requests are processed continuously in the background by a per-model batcher.

        Key Differences:
        - batch_generate_parallel: Fixed batch size, all requests start/finish together
        - continuous_generate: Dynamic batch, requests join/leave independently

        Args:
            params: {
                "model_id": str,
                "prompt": str,
                "max_tokens": int,
                "temperature": float,
                "top_p": float,
                "stream_id": str,
                "request_id": str  # Optional
            }

        Returns:
            None (tokens emitted via notifications, this is non-blocking)

        Performance:
            - Static batching: 2-3x throughput
            - Continuous batching: 3-5x throughput (target)

        Example:
            # Request 1 at T=0
            await continuous_generate({"prompt": "Q1", ...})

            # Request 2 at T=100ms (joins ongoing batch)
            await continuous_generate({"prompt": "Q2", ...})

            # Request 1 finishes at T=500ms (removed from batch)
            # Request 2 continues generating
        """
        model_id = params.get("model_id")
        handle = self.models.get(model_id)

        if not handle:
            raise ModelNotLoaded(f"Model not loaded: {model_id}")

        # Get or create continuous batcher for this model
        if model_id not in self.continuous_batchers:
            # Lazy import to avoid loading if not used
            from models.continuous_batcher import ContinuousBatcher

            # Get config - for now use defaults until Config class is updated
            # TODO: Add continuous_batching section to Config class
            max_batch_size = 8
            batch_window_ms = 10.0
            adaptive_sizing = True

            # Create new batcher
            batcher = ContinuousBatcher(
                handle=handle,
                max_batch_size=max_batch_size,
                batch_window_ms=batch_window_ms,
                adaptive_sizing=adaptive_sizing
            )

            # Start background loop
            await batcher.start()

            self.continuous_batchers[model_id] = batcher

        batcher = self.continuous_batchers[model_id]

        # Create batch request
        from models.batch_generator import create_batch_request

        request_id = params.get("request_id", str(uuid.uuid4()))
        batch_req = create_batch_request(
            request_id=request_id,
            params=params,
            tokenizer=handle.tokenizer
        )

        # Define callbacks (synchronous versions for continuous batching)
        # Phase 1: Binary streaming support
        def emit_token(stream_id: str, token: int, text: str):
            """Emit token chunk notification"""
            chunk_params = {
                "stream_id": stream_id,
                "token": text,
                "token_id": token,
                "is_final": False
            }
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_TOKEN, chunk_params)
            else:
                self._notify("stream.chunk", chunk_params)

        def emit_complete(stream_id: str, stats: Dict[str, Any]):
            """Emit completion notification"""
            event_params = {
                "stream_id": stream_id,
                "event": "completed",
                "stats": stats,
                "is_final": True
            }
            if self.binary_mode:
                self._notify_binary(MSG_TYPE_EVENT, event_params)
            else:
                self._notify("stream.event", event_params)

        # Add to batcher (non-blocking - returns immediately)
        await batcher.add_request(batch_req, emit_token, emit_complete)

        # No return value - this is a notification-based method
        # TypeScript receives tokens via stream.chunk notifications

    async def get_batcher_metrics(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get comprehensive metrics from continuous batcher (Week 3: Metrics)

        Returns latency, throughput, and batch size metrics for a specific model's
        continuous batcher.

        Args:
            params: {
                "model_id": str  # Model ID to get metrics for
            }

        Returns:
            {
                "latency": {
                    "p50_ms": float,
                    "p95_ms": float,
                    "p99_ms": float,
                    "avg_ms": float,
                    "min_ms": float,
                    "max_ms": float
                },
                "throughput": {
                    "tokens_per_sec_5s": float,
                    "tokens_per_sec_30s": float,
                    "tokens_per_sec_60s": float,
                    "requests_per_sec_5s": float,
                    "requests_per_sec_30s": float,
                    "requests_per_sec_60s": float
                },
                "batch_size": {
                    "avg": float,
                    "min": int,
                    "max": int,
                    "distribution": {"1": int, "2": int, ...}  # Count per size
                }
            }

        Raises:
            ModelNotLoaded: If model is not loaded
            ValueError: If no continuous batcher exists for the model
        """
        model_id = params.get("model_id")

        if not model_id:
            raise ValueError("model_id is required")

        # Check if model is loaded
        if model_id not in self.models:
            raise ModelNotLoaded(f"Model not loaded: {model_id}")

        # Check if continuous batcher exists for this model
        if model_id not in self.continuous_batchers:
            raise ValueError(
                f"No continuous batcher exists for model: {model_id}. "
                f"You must call continuous_generate at least once to create a batcher."
            )

        batcher = self.continuous_batchers[model_id]

        # Get metrics from batcher
        metrics = batcher.get_metrics()

        return metrics

    async def get_batcher_health(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get health status from continuous batcher (Week 3 Day 3: Health checks)

        Returns health status indicating if the batcher is operating normally.

        Args:
            params: {
                "model_id": str  # Model ID to check health for
            }

        Returns:
            {
                "healthy": bool,               # Overall health status
                "running": bool,               # Background loop running
                "active_batch_size": int,      # Current batch size
                "pending_queue_size": int,     # Requests waiting
                "total_requests": int,         # Lifetime total
                "completed_requests": int,     # Successfully completed
                "max_batch_size": int,         # Maximum batch capacity
                "error_indicators": List[str]  # Problems if unhealthy
            }

        Raises:
            ModelNotLoaded: If model is not loaded
            ValueError: If no continuous batcher exists for the model
        """
        model_id = params.get("model_id")

        if not model_id:
            raise ValueError("model_id is required")

        # Check if model is loaded
        if model_id not in self.models:
            raise ModelNotLoaded(f"Model not loaded: {model_id}")

        # Check if continuous batcher exists for this model
        if model_id not in self.continuous_batchers:
            raise ValueError(
                f"No continuous batcher exists for model: {model_id}. "
                f"You must call continuous_generate at least once to create a batcher."
            )

        batcher = self.continuous_batchers[model_id]

        # Get health status from batcher
        health = batcher.health_check()

        return health

    async def get_week4_metrics(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get Week 4 optimization metrics from continuous batcher (Week 4: Memory Optimization)

        Returns comprehensive metrics for memory-aware optimizations including:
        - MemoryController metrics (GPU memory usage, batch size limits)
        - PromptCacheManager metrics (cache hits, memory usage)
        - Combined Week 4 summary

        Args:
            params: {
                "model_id": str  # Model ID to get metrics for
            }

        Returns:
            {
                "memory_controller": {
                    "enabled": bool,
                    "current_limit": int,
                    "utilization": float,
                    "active_memory_gb": float,
                    "oom_prevented": int
                },
                "prompt_cache": {
                    "enabled": bool,
                    "cache_size": int,
                    "hit_rate": float,
                    "total_requests": int,
                    "cache_hits": int,
                    "memory_mb": float
                },
                "week4_summary": {
                    "features_enabled": int,
                    "memory_utilization": float,
                    "cache_effectiveness": float
                }
            }

        Raises:
            ModelNotLoaded: If model is not loaded
            ValueError: If no continuous batcher exists for the model
        """
        model_id = params.get("model_id")

        if not model_id:
            raise ValueError("model_id is required")

        # Check if model is loaded
        if model_id not in self.models:
            raise ModelNotLoaded(f"Model not loaded: {model_id}")

        # Check if continuous batcher exists for this model
        if model_id not in self.continuous_batchers:
            raise ValueError(
                f"No continuous batcher exists for model: {model_id}. "
                f"You must call continuous_generate at least once to create a batcher."
            )

        batcher = self.continuous_batchers[model_id]

        # Get Week 4 metrics summary from batcher
        metrics = batcher.get_week4_summary()

        return metrics

    async def batch_tokenize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Batch tokenize multiple text inputs (Week 1: Request Batching)

        Processes multiple tokenize requests in a single IPC call to reduce overhead.
        Error isolation: Individual request failures don't affect others.

        Args:
            params: {"requests": [{"model_id": str, "text": str, "add_special_tokens": bool}]}

        Returns:
            {"results": [{"success": bool, "result": {...} | null, "error": str | null}]}
        """
        requests = params.get("requests", [])

        if not isinstance(requests, list):
            raise ValueError("batch_tokenize expects 'requests' to be a list")

        if not requests:
            return {"results": []}

        grouped: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {}
        for idx, req in enumerate(requests):
            model_key = req.get("model_id") or "__unknown__"
            grouped.setdefault(model_key, []).append((idx, req))

        results: List[Optional[Dict[str, Any]]] = [None] * len(requests)

        async def handle_group(items: List[Tuple[int, Dict[str, Any]]]) -> None:
            tasks = [self.tokenize_request(req) for _, req in items]
            responses = await asyncio.gather(*tasks, return_exceptions=True)

            for (index, _), response in zip(items, responses):
                if isinstance(response, Exception):
                    error_obj = self._serialize_error(response)
                    results[index] = {
                        "success": False,
                        "result": None,
                        "error": error_obj.get("message", str(response)),
                    }
                else:
                    results[index] = {
                        "success": True,
                        "result": response,
                        "error": None,
                    }

        # BUG-FIX: Add return_exceptions=True to prevent group handler failures from crashing entire batch
        # If handle_group() itself raises (e.g., iteration error, zip error), it won't crash all groups
        group_results = await asyncio.gather(
            *(handle_group(group) for group in grouped.values()),
            return_exceptions=True
        )

        # Handle any group-level failures by filling in error results
        for group_idx, group_result in enumerate(group_results):
            if isinstance(group_result, Exception):
                # Group handler failed - mark all items in this group as failed
                group_items = list(grouped.values())[group_idx]
                error_obj = self._serialize_error(group_result)
                for index, _ in group_items:
                    if results[index] is None:  # Only fill if not already set
                        results[index] = {
                            "success": False,
                            "result": None,
                            "error": error_obj.get("message", str(group_result)),
                        }

        # Fill any missing entries with a generic error (should not happen)
        normalized = [
            entry
            if entry is not None
            else {
                "success": False,
                "result": None,
                "error": "Unknown batch tokenization error",
            }
            for entry in results
        ]

        return {"results": normalized}

    async def batch_check_draft(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Batch check draft model compatibility (Week 1: Request Batching)

        Checks multiple draft-primary pairs in a single IPC call.
        Error isolation: Individual check failures don't affect others.

        Args:
            params: {"requests": [{"primary_id": str, "draft_id": str}]}

        Returns:
            {"results": [{"success": bool, "result": {...} | null, "error": str | null}]}
        """
        requests = params.get("requests", [])

        if not isinstance(requests, list):
            raise ValueError("batch_check_draft expects 'requests' to be a list")

        if not requests:
            return {"results": []}

        grouped: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {}
        for idx, req in enumerate(requests):
            primary_key = req.get("primary_id") or "__unknown__"
            grouped.setdefault(primary_key, []).append((idx, req))

        results: List[Optional[Dict[str, Any]]] = [None] * len(requests)

        async def handle_group(items: List[Tuple[int, Dict[str, Any]]]) -> None:
            tasks = [self.check_draft(req) for _, req in items]
            responses = await asyncio.gather(*tasks, return_exceptions=True)

            for (index, _), response in zip(items, responses):
                if isinstance(response, Exception):
                    error_obj = self._serialize_error(response)
                    results[index] = {
                        "success": False,
                        "result": None,
                        "error": error_obj.get("message", str(response)),
                    }
                else:
                    results[index] = {
                        "success": True,
                        "result": response,
                        "error": None,
                    }

        await asyncio.gather(*(handle_group(group) for group in grouped.values()))

        normalized = [
            entry
            if entry is not None
            else {
                "success": False,
                "result": None,
                "error": "Unknown batch draft compatibility error",
            }
            for entry in results
        ]

        return {"results": normalized}

    async def shutdown(self) -> Dict[str, Any]:
        """Gracefully shutdown the runtime"""
        # Set shutdown flag FIRST to prevent race conditions
        self.shutdown_requested = True

        # Week 2: Stop all continuous batchers (gracefully complete active requests)
        for model_id, batcher in list(self.continuous_batchers.items()):
            try:
                await batcher.stop()
            except Exception as exc:
                print(f"Error stopping batcher for {model_id}: {exc}", file=sys.stderr, flush=True)
        self.continuous_batchers.clear()

        # Clean up loaded models
        for model_id in list(self.models.keys()):
            handle = self.models[model_id]
            loader.unload_model(handle)
            del self.models[model_id]

        for model_id in list(self.vision_models.keys()):
            handle = self.vision_models[model_id]
            self.vision_loader.unload_model(handle)
            del self.vision_models[model_id]

        # Cancel active stream tasks and wait for them
        # Store tasks to wait for before clearing the dict
        tasks_to_cancel = list(self.stream_tasks.values())

        for task in tasks_to_cancel:
            if not task.done():
                task.cancel()

        # Wait for all cancelled tasks to finish
        if tasks_to_cancel:
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)

        # Now safe to clear
        self.stream_tasks.clear()

        # Cleanup Metal Optimizations (Week 1: Log statistics before shutdown)
        if self.metal_pool:
            try:
                stats = self.metal_pool.get_statistics()
                stats_dict = stats.to_dict()
                logging.info(f"Metal Memory Pool final stats: {stats_dict}")
            except Exception as exc:
                logging.warning(f"Error getting Metal pool stats: {exc}")

        if self.blit_queue:
            try:
                self.blit_queue.wait_for_all()  # Wait for pending operations
                metrics = self.blit_queue.get_metrics()
                metrics_dict = metrics.to_dict()
                logging.info(f"Blit Queue final metrics: {metrics_dict}")
            except Exception as exc:
                logging.warning(f"Error getting Blit queue metrics: {exc}")

        if self.command_ring:
            try:
                self.command_ring.wait_all()  # Wait for in-flight buffers
                stats = self.command_ring.get_statistics()
                stats_dict = stats.to_dict()
                logging.info(f"Command Buffer Ring final stats: {stats_dict}")
            except Exception as exc:
                logging.warning(f"Error getting Command ring stats: {exc}")

        # Cleanup Week 2 Optimizations
        # Log CPU tokenizer statistics
        if self.cpu_tokenizer:
            try:
                stats = self.cpu_tokenizer.get_statistics()
                stats_dict = stats.to_dict()
                logging.info(f"CPU tokenizer final stats: {stats_dict}")
            except Exception as exc:
                logging.warning(f"Error getting CPU tokenizer stats: {exc}")

        # Log KV cache pool statistics
        if self.kv_cache_pool:
            try:
                stats = self.kv_cache_pool.get_stats()
                logging.info(f"KV cache pool final stats: {stats}")
            except Exception as exc:
                logging.warning(f"Error getting KV cache pool stats: {exc}")

        # Week 3: Cleanup Weight Manager
        if self.weight_manager:
            try:
                stats = self.weight_manager.get_statistics()
                stats_dict = stats.to_dict()
                logging.info(f"WeightManager final stats: {stats_dict}")
            except Exception as exc:
                logging.warning(f"Error getting WeightManager stats: {exc}")

        # Week 3: Log Model Registry statistics
        if self.model_registry:
            try:
                stats = self.model_registry.get_stats()
                logging.info(f"ModelRegistry final stats: {stats}")
            except Exception as exc:
                logging.warning(f"Error getting ModelRegistry stats: {exc}")

        return {"success": True}

    async def run(self) -> None:
        """Main event loop reading from stdin"""
        # Load configuration
        config = get_config()

        # Initialize GPU scheduler (if available and enabled)
        if GPU_SCHEDULER_INTEGRATED:
            try:
                await generator.initialize_gpu_scheduler()
            except Exception as exc:
                print(f"[Runtime] GPU scheduler initialization failed: {exc}",
                      file=sys.stderr, flush=True)

        # Initialize Metal Optimizations (Week 1: Native C++/Metal GPU optimizations)
        if METAL_OPTIMIZATIONS_AVAILABLE and config.metal_optimizations_enabled:
            try:
                metal_config = config.metal_optimizations

                # Initialize Metal Memory Pool
                if metal_config.get('memory_pool', {}).get('enabled', False):
                    pool_config = MetalMemoryPoolConfig()
                    pool_cfg = metal_config['memory_pool']
                    pool_config.heap_size_mb = pool_cfg.get('heap_size_mb', 256)
                    pool_config.num_heaps = pool_cfg.get('num_heaps', 4)
                    pool_config.warmup_sizes = pool_cfg.get('warmup_sizes', [])
                    pool_config.track_statistics = pool_cfg.get('track_statistics', True)
                    pool_config.log_exhaustion = pool_cfg.get('log_exhaustion', True)

                    self.metal_pool = MetalMemoryPool(pool_config)
                    self.metal_pool.warmup()
                    logging.info(f"Metal Memory Pool initialized: {pool_config.num_heaps} heaps x {pool_config.heap_size_mb}MB")

                # Initialize Blit Queue
                if metal_config.get('blit_queue', {}).get('enabled', False):
                    blit_config = BlitQueueConfig()
                    blit_cfg = metal_config['blit_queue']
                    blit_config.enabled = True
                    blit_config.max_pending_ops = blit_cfg.get('max_pending_ops', 8)
                    blit_config.use_shared_events = blit_cfg.get('use_shared_events', True)
                    blit_config.track_metrics = blit_cfg.get('track_metrics', True)

                    self.blit_queue = BlitQueue(blit_config)
                    logging.info(f"Blit Queue initialized: max_pending={blit_config.max_pending_ops}")

                # Initialize Command Buffer Ring
                if metal_config.get('command_buffer_ring', {}).get('enabled', False):
                    ring_config = CommandBufferRingConfig()
                    ring_cfg = metal_config['command_buffer_ring']
                    ring_config.ring_size = ring_cfg.get('ring_size', 2)
                    ring_config.timeout_ms = ring_cfg.get('timeout_ms', 0)
                    ring_config.track_statistics = ring_cfg.get('track_statistics', True)
                    ring_config.log_wait_events = ring_cfg.get('log_wait_events', False)

                    self.command_ring = CommandBufferRing(ring_config)
                    logging.info(f"Command Buffer Ring initialized: ring_size={ring_config.ring_size}")

                if self.metal_pool or self.blit_queue or self.command_ring:
                    logging.info("Metal optimizations initialized successfully")

            except Exception as exc:
                logging.error(f"Failed to initialize Metal optimizations: {exc}")
                if not metal_config.get('graceful_fallback', True):
                    raise
                logging.warning("Continuing without Metal optimizations (graceful fallback)")

        # Initialize Week 2 Optimizations
        # CPU Tokenizer (Parallel Tokenization)
        if CPU_TOKENIZER_AVAILABLE and config.cpu_optimizations_enabled:
            try:
                cpu_config = config.cpu_optimizations
                tokenizer_cfg = cpu_config.get('parallel_tokenizer', {})

                if tokenizer_cfg.get('enabled', False):
                    tokenizer_config = ParallelTokenizerConfig()
                    tokenizer_config.num_threads = tokenizer_cfg.get('num_threads', 4)
                    tokenizer_config.use_accelerate = tokenizer_cfg.get('use_accelerate', True)
                    tokenizer_config.batch_size = tokenizer_cfg.get('batch_size', 16)
                    tokenizer_config.prefetch_enabled = tokenizer_cfg.get('prefetch_enabled', True)
                    tokenizer_config.cache_vocab = tokenizer_cfg.get('cache_vocab', True)
                    tokenizer_config.track_statistics = tokenizer_cfg.get('track_statistics', True)

                    self.cpu_tokenizer = ParallelTokenizer(tokenizer_config)
                    logging.info(
                        f"CPU tokenizer initialized: {tokenizer_config.num_threads} threads, "
                        f"batch_size={tokenizer_config.batch_size}, "
                        f"accelerate={tokenizer_config.use_accelerate}"
                    )

            except Exception as exc:
                logging.error(f"Failed to initialize CPU tokenizer: {exc}")
                if not cpu_config.get('graceful_fallback', True):
                    raise
                logging.warning("Continuing without CPU tokenizer (graceful fallback)")

        # KV Cache Pool
        if KV_CACHE_AVAILABLE and config.kv_cache_pool_enabled:
            try:
                kv_config = config.kv_cache_pool
                cache_config = KVCachePoolConfig(
                    max_size=kv_config.get('max_size', 50),
                    ttl_seconds=kv_config.get('ttl_seconds', 300.0),
                    enable_prefix_sharing=kv_config.get('enable_prefix_sharing', True),
                    prefix_length_ratio=kv_config.get('prefix_length_ratio', 0.6),
                    enable_statistics=kv_config.get('enable_statistics', True),
                    log_operations=kv_config.get('log_operations', False)
                )

                self.kv_cache_pool = KVCachePool(cache_config)
                logging.info(
                    f"KV cache pool initialized: max_size={cache_config.max_size}, "
                    f"ttl={cache_config.ttl_seconds}s, "
                    f"prefix_sharing={cache_config.enable_prefix_sharing}"
                )

            except Exception as exc:
                logging.error(f"Failed to initialize KV cache pool: {exc}")
                # KV cache is optional, so always gracefully fallback
                logging.warning("Continuing without KV cache pool (graceful fallback)")

        # Week 3: Weight Management
        if config.advanced_optimizations_enabled and config.weight_management_enabled:
            if WEIGHT_MANAGER_AVAILABLE:
                try:
                    wm_config = config.weight_management
                    logging.info("Initializing Week 3 WeightManager...")
                    # WeightManager initialization will happen per-model on load
                    # Store config for later use
                    logging.info(
                        f"WeightManager config loaded: "
                        f"pin_critical={wm_config.get('pin_critical_weights', True)}, "
                        f"prefetch={wm_config.get('prefetch_enabled', True)}, "
                        f"critical_layers={wm_config.get('critical_layers', 3)}"
                    )
                except Exception as exc:
                    logging.error(f"Failed to load WeightManager config: {exc}")
                    logging.warning("Continuing without WeightManager (graceful fallback)")
            else:
                logging.warning("WeightManager requested but native module unavailable")

        # Week 3: Model Registry (multi-model serving)
        if config.advanced_optimizations_enabled and config.multi_model_enabled:
            if MODEL_REGISTRY_AVAILABLE:
                try:
                    mm_config = config.multi_model
                    registry_config = ModelRegistryConfig(
                        max_cached_models=mm_config.get('max_cached_models', 3),
                        eviction_strategy=mm_config.get('eviction_strategy', 'lru'),
                        memory_aware_eviction=True,
                        gpu_memory_threshold=0.9,
                        track_access_patterns=True
                    )
                    self.model_registry = ModelRegistry(registry_config)
                    logging.info(
                        f"Week 3 ModelRegistry initialized: "
                        f"max_models={registry_config.max_cached_models}, "
                        f"strategy={registry_config.eviction_strategy}"
                    )
                except Exception as exc:
                    logging.error(f"Failed to initialize ModelRegistry: {exc}")
                    logging.warning("Continuing without ModelRegistry (graceful fallback)")
            else:
                logging.warning("ModelRegistry requested but not available")

        buffer = ""
        # Bug Fix #66: Enforce max buffer size to prevent memory exhaustion attack
        # Default: 1MB (configurable via config/runtime.yaml python_bridge.max_buffer_size)
        # This prevents attackers from sending arbitrarily large JSON payloads
        max_buffer_size = config.max_buffer_size

        while True:
            try:
                # Read line from stdin
                line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)

                if not line:
                    break

                # Bug Fix #66 & BUG-018: Check buffer size BEFORE appending (TOCTOU fix)
                # Check line size BEFORE concatenation to prevent temporary overflow
                line_bytes = len(line.encode('utf-8'))
                current_buffer_bytes = len(buffer.encode('utf-8'))

                # Would concatenation exceed limit?
                if current_buffer_bytes + line_bytes > max_buffer_size:
                    # Try to extract id from current buffer (not from line!)
                    msg_id = None
                    try:
                        partial = orjson.loads(buffer)
                        msg_id = partial.get('id')
                    except (orjson.JSONDecodeError, ValueError, KeyError, TypeError):
                        # BUG-007 FIX: Use specific exceptions instead of bare except
                        # Avoids catching SystemExit, KeyboardInterrupt, GeneratorExit
                        pass  # id remains None

                    error_response = {
                        "jsonrpc": "2.0",
                        "id": msg_id,  # Include id (can be null for unknown)
                        "error": {
                            "code": -32600,  # Invalid Request
                            "message": f"Buffer overflow: would exceed {max_buffer_size} bytes",
                        },
                    }
                    print(orjson.dumps(error_response).decode("utf-8"), flush=True)
                    buffer = ""  # Reset buffer
                    continue  # Skip appending this line

                buffer += line  # SAFE: Already checked size

                # Try to parse complete JSON-RPC message
                try:
                    request = orjson.loads(buffer)
                    buffer = ""  # Clear buffer on successful parse

                    # Handle request (may return None for notifications)
                    response = await self.handle_request(request)

                    # Only write response if not None (notifications don't get responses)
                    if response is not None:
                        response_json = orjson.dumps(response).decode("utf-8")
                        print(response_json, flush=True)

                    # Check if shutdown was requested
                    if self.shutdown_requested:
                        break

                except orjson.JSONDecodeError:
                    # Incomplete message, continue reading
                    continue

            except Exception as e:
                # Bug Fix: Log errors to stderr for debugging, not just to stdout
                print(f"Parse error in runtime loop: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                error_response = {
                    "jsonrpc": "2.0",
                    "error": {"code": -32700, "message": f"Parse error: {str(e)}"},
                }
                print(orjson.dumps(error_response).decode("utf-8"), flush=True)
                buffer = ""


def main():
    """Entry point"""
    # Emit ready notification to stderr for TypeScript detection
    print("MLX Runtime ready", file=sys.stderr, flush=True)

    server = RuntimeServer()
    asyncio.run(server.run())


if __name__ == "__main__":
    main()
