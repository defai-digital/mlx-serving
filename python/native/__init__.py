"""
Native acceleration module for mlx-serving

Provides optional C++/ObjC++ acceleration with automatic fallback to pure Python.
"""

import os
import sys
import logging
from typing import Optional
from pathlib import Path

logger = logging.getLogger(__name__)

# Try to import native module
_native_available = False
_native_module = None

def _find_native_module():
    """Find and load native module from build directory"""
    # Try relative to python directory
    python_dir = Path(__file__).parent.parent
    project_root = python_dir.parent
    build_dir = project_root / "native" / "build"

    if build_dir.exists():
        # Add build dir to path
        sys.path.insert(0, str(build_dir))

    try:
        import krserve_native
        return krserve_native
    except ImportError:
        return None

try:
    _native_module = _find_native_module()
    if _native_module:
        _native_available = True
        logger.info(f"✅ Native acceleration loaded (version {_native_module.get_version()})")
    else:
        logger.warning("⚠️  Native acceleration not available - using Python fallback")
except Exception as e:
    logger.error(f"❌ Failed to load native module: {e}")
    logger.info("Falling back to pure Python implementation")

def is_native_available() -> bool:
    """Check if native acceleration is available"""
    return _native_available

def use_native() -> bool:
    """Check if native acceleration should be used"""
    if not _native_available:
        return False

    # Check environment variable
    use_native_env = os.getenv('USE_NATIVE', 'false').lower()
    return use_native_env in ('true', '1', 'yes', 'on')

def get_native_module():
    """Get native module if available"""
    if not _native_available:
        raise RuntimeError("Native module not available")
    return _native_module

def get_status() -> dict:
    """Get native acceleration status"""
    return {
        'available': _native_available,
        'enabled': use_native(),
        'version': _native_module.get_version() if _native_module else None,
        'module_path': getattr(_native_module, '__file__', None) if _native_module else None
    }

__all__ = [
    'is_native_available',
    'use_native',
    'get_native_module',
    'get_status',
]
