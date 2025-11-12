"""
Command Buffer Pool with native acceleration and Python fallback
"""

from typing import Optional, Any
import logging
from . import is_native_available, use_native, get_native_module

logger = logging.getLogger(__name__)

class CommandBufferPool:
    """
    Command buffer pool with optional native acceleration

    When USE_NATIVE=true, uses C++/ObjC++ implementation for ~10x faster
    buffer acquisition. Falls back to Python implementation automatically.
    """

    def __init__(self, pool_size: int = 16):
        self.pool_size = pool_size
        self._native_pool: Optional[Any] = None
        self._python_pool: list = []
        self._native_failed = False

        if use_native():
            try:
                native_module = get_native_module()
                self._native_pool = native_module.CommandBufferPool(pool_size)
                logger.info(f"✅ Using native CommandBufferPool (size={pool_size})")
            except Exception as e:
                logger.error(f"❌ Failed to initialize native pool: {e}")
                logger.info("⚠️  Falling back to Python pool")
                self._native_failed = True

    def acquire(self):
        """Acquire a command buffer from pool"""
        if self._native_pool is not None and not self._native_failed:
            try:
                return self._native_pool.acquire()
            except Exception as e:
                logger.error(f"❌ Native pool acquire failed: {e}")
                self._native_failed = True
                self._native_pool = None

        # Python fallback
        if self._python_pool:
            return self._python_pool.pop()
        return None  # Caller must create new buffer

    def release(self, buffer):
        """Release command buffer back to pool"""
        if self._native_pool is not None and not self._native_failed:
            try:
                self._native_pool.release(buffer)
                return
            except Exception as e:
                logger.error(f"❌ Native pool release failed: {e}")
                self._native_failed = True
                self._native_pool = None

        # Python fallback
        if len(self._python_pool) < self.pool_size:
            self._python_pool.append(buffer)

    def reset(self):
        """Reset pool"""
        if self._native_pool is not None and not self._native_failed:
            try:
                self._native_pool.reset()
            except Exception as e:
                logger.error(f"❌ Native pool reset failed: {e}")

        self._python_pool.clear()

    def get_stats(self) -> dict:
        """Get pool statistics"""
        if self._native_pool is not None and not self._native_failed:
            try:
                stats = self._native_pool.get_stats()
                return {
                    'pool_size': stats.pool_size,
                    'available_buffers': stats.available_buffers,
                    'total_acquired': stats.total_acquired,
                    'total_released': stats.total_released,
                    'cache_hits': stats.cache_hits,
                    'cache_misses': stats.cache_misses,
                    'backend': 'native'
                }
            except Exception as e:
                logger.error(f"❌ Failed to get native stats: {e}")

        # Python fallback stats
        return {
            'pool_size': self.pool_size,
            'available_buffers': len(self._python_pool),
            'total_acquired': 0,
            'total_released': 0,
            'cache_hits': 0,
            'cache_misses': 0,
            'backend': 'python'
        }
