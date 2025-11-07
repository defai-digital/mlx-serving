"""
Python Configuration Loader

Loads configuration from YAML files to eliminate hardcoded values
"""

import os
import threading
import yaml
from pathlib import Path
from typing import Any, Dict, Optional


class Config:
    """Runtime configuration loaded from YAML"""

    def __init__(self, config_dict: Dict[str, Any]):
        # Python Runtime
        py_runtime = config_dict.get("python_runtime", {})
        self.max_restarts = py_runtime.get("max_restarts", 3)
        self.startup_timeout_ms = py_runtime.get("startup_timeout_ms", 30000)
        self.shutdown_timeout_ms = py_runtime.get("shutdown_timeout_ms", 5000)

        # Python Bridge
        py_bridge = config_dict.get("python_bridge", {})
        self.max_buffer_size = py_bridge.get("max_buffer_size", 1_048_576)
        self.stream_queue_size = py_bridge.get("stream_queue_size", 100)
        self.queue_put_max_retries = py_bridge.get("queue_put_max_retries", 100)
        self.queue_put_backoff_ms = py_bridge.get("queue_put_backoff_ms", 10)

        # JSON-RPC Configuration (Backend Bug #24: Python was ignoring this section)
        json_rpc = config_dict.get("json_rpc", {})
        self.default_timeout_ms = json_rpc.get("default_timeout_ms", 30000)
        self.max_line_buffer_size = json_rpc.get("max_line_buffer_size", 65536)
        self.max_pending_requests = json_rpc.get("max_pending_requests", 100)

        # Model
        model = config_dict.get("model", {})
        self.default_context_length = model.get("default_context_length", 8192)
        self.default_max_tokens = model.get("default_max_tokens", 512)
        self.supported_dtypes = set(model.get("supported_dtypes", ["float16", "bfloat16", "float32"]))
        self.default_dtype = model.get("default_dtype", "unknown")

        # Security settings
        self.trusted_model_directories = model.get("trusted_model_directories")
        self.max_generation_tokens = model.get("max_generation_tokens", 4096)
        self.max_temperature = model.get("max_temperature", 2.0)

        # Model Cache (Phase 2: v0.2.0)
        memory_cache = model.get("memory_cache", {})
        self.cache_enabled = memory_cache.get("enabled", True)
        self.max_cached_models = memory_cache.get("max_cached_models", 5)
        self.eviction_strategy = memory_cache.get("eviction_strategy", "lru")
        self.warmup_on_start = memory_cache.get("warmup_on_start", [])
        self.track_cache_stats = memory_cache.get("track_stats", True)

        # Outlines
        outlines = config_dict.get("outlines", {})
        self.max_schema_size_bytes = outlines.get("max_schema_size_bytes", 32768)

        # Performance
        perf = config_dict.get("performance", {})
        self.enable_aggressive_gc = perf.get("aggressive_gc", False)

        # Development
        dev = config_dict.get("development", {})
        self.verbose = dev.get("verbose", False)
        self.debug = dev.get("debug", False)

        # Telemetry (Phase 1.3)
        telemetry = config_dict.get("telemetry", {})
        self.telemetry_enabled = telemetry.get("enabled", True)
        self.telemetry_sampling_rate = telemetry.get("sampling_rate", 1.0)

    def validate(self) -> None:
        """
        Validate configuration values

        BUG-015 FIX: Add validation to catch invalid config values at startup
        instead of runtime failures

        Raises:
            ValueError: If any configuration value is invalid
        """
        if self.max_restarts < 0:
            raise ValueError(f"max_restarts must be >= 0, got {self.max_restarts}")

        if self.max_buffer_size < 1024:
            raise ValueError(f"max_buffer_size must be >= 1024 bytes, got {self.max_buffer_size}")

        if self.startup_timeout_ms < 1000:
            raise ValueError(f"startup_timeout_ms must be >= 1000ms, got {self.startup_timeout_ms}")

        if self.max_temperature < 0 or self.max_temperature > 10.0:
            raise ValueError(f"max_temperature must be in range [0, 10], got {self.max_temperature}")

        if self.telemetry_sampling_rate < 0 or self.telemetry_sampling_rate > 1.0:
            raise ValueError(f"telemetry_sampling_rate must be in range [0, 1], got {self.telemetry_sampling_rate}")

        if self.max_cached_models < 1:
            raise ValueError(f"max_cached_models must be >= 1, got {self.max_cached_models}")

        if self.eviction_strategy not in ["lru"]:
            raise ValueError(f"eviction_strategy must be 'lru', got {self.eviction_strategy}")

    def get_queue_put_backoff_seconds(self) -> float:
        """Convert backoff MS to seconds for time.sleep()"""
        return self.queue_put_backoff_ms / 1000


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Deep merge two dictionaries"""
    result = base.copy()

    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value

    return result


def load_config(
    config_path: Optional[str] = None, environment: Optional[str] = None
) -> Config:
    """
    Load configuration from YAML file

    Args:
        config_path: Path to config file (defaults to project_root/config/runtime.yaml)
        environment: Environment name (production/development/test)

    Returns:
        Config instance

    Raises:
        FileNotFoundError: If config file not found
        yaml.YAMLError: If config file is invalid
    """
    # Find project root (look for config/ directory)
    if config_path is None:
        current = Path(__file__).parent
        for _ in range(5):  # Search up to 5 levels
            config_dir = current / "config"
            if config_dir.exists():
                config_path = str(config_dir / "runtime.yaml")
                break
            parent = current.parent
            if parent == current:
                break
            current = parent

        if config_path is None:
            # Fallback to relative path
            config_path = str(Path(__file__).parent.parent / "config" / "runtime.yaml")

    # Load base configuration
    try:
        with open(config_path, "r") as f:
            base_config = yaml.safe_load(f)
    except FileNotFoundError:
        raise FileNotFoundError(f"Configuration file not found: {config_path}")
    except yaml.YAMLError as exc:
        raise ValueError(f"Failed to parse YAML config file '{config_path}': {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to load config file '{config_path}': {exc}") from exc

    # Determine environment
    env = environment or os.getenv("PYTHON_ENV") or os.getenv("NODE_ENV") or "development"

    # Apply environment-specific overrides
    final_config = base_config
    if "environments" in base_config and env in base_config["environments"]:
        env_overrides = base_config["environments"][env]
        final_config = deep_merge(base_config, env_overrides)

    # Remove environments section
    if "environments" in final_config:
        del final_config["environments"]

    # BUG-015 FIX: Validate configuration on load
    config = Config(final_config)
    config.validate()
    return config


# Global config instance
_global_config: Optional[Config] = None
_config_lock = threading.Lock()


def initialize_config(
    config_path: Optional[str] = None, environment: Optional[str] = None
) -> Config:
    """Initialize global configuration (thread-safe)"""
    global _global_config
    with _config_lock:
        _global_config = load_config(config_path, environment)
        return _global_config


def get_config() -> Config:
    """
    Get global configuration (lazy initialization)

    Thread-safe implementation using double-checked locking pattern.
    Prevents race conditions when multiple threads/asyncio tasks
    call this function concurrently during cold start.

    Bug Fix #54: Added threading lock to prevent config being loaded twice
    when multiple modules call get_config() simultaneously on first import.
    """
    global _global_config

    # First check (no lock) - fast path for already-initialized case
    if _global_config is not None:
        return _global_config

    # Slow path - acquire lock and double-check
    with _config_lock:
        # Double-check after acquiring lock (another thread may have initialized)
        if _global_config is None:
            _global_config = load_config()
        return _global_config


# For backward compatibility, expose as module-level constants
def _init_module_constants():
    """Initialize module-level constants from config"""
    try:
        cfg = get_config()
        return {
            "MAX_BUFFER_SIZE": cfg.max_buffer_size,
            "STREAM_QUEUE_SIZE": cfg.stream_queue_size,
            "QUEUE_PUT_MAX_RETRIES": cfg.queue_put_max_retries,
            "QUEUE_PUT_BACKOFF_MS": cfg.queue_put_backoff_ms,
            "DEFAULT_CONTEXT_LENGTH": cfg.default_context_length,
            "MAX_SCHEMA_SIZE_BYTES": cfg.max_schema_size_bytes,
            "ENABLE_AGGRESSIVE_GC": cfg.enable_aggressive_gc,
        }
    except Exception:
        # Fallback to hardcoded values if config loading fails
        return {
            "MAX_BUFFER_SIZE": 1_048_576,
            "STREAM_QUEUE_SIZE": 100,
            "QUEUE_PUT_MAX_RETRIES": 100,
            "QUEUE_PUT_BACKOFF_MS": 10,
            "DEFAULT_CONTEXT_LENGTH": 8192,
            "MAX_SCHEMA_SIZE_BYTES": 32768,
            "ENABLE_AGGRESSIVE_GC": False,
        }


# Export constants
_constants = _init_module_constants()
MAX_BUFFER_SIZE = _constants["MAX_BUFFER_SIZE"]
STREAM_QUEUE_SIZE = _constants["STREAM_QUEUE_SIZE"]
QUEUE_PUT_MAX_RETRIES = _constants["QUEUE_PUT_MAX_RETRIES"]
QUEUE_PUT_BACKOFF_MS = _constants["QUEUE_PUT_BACKOFF_MS"]
DEFAULT_CONTEXT_LENGTH = _constants["DEFAULT_CONTEXT_LENGTH"]
MAX_SCHEMA_SIZE_BYTES = _constants["MAX_SCHEMA_SIZE_BYTES"]
ENABLE_AGGRESSIVE_GC = _constants["ENABLE_AGGRESSIVE_GC"]
