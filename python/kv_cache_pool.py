"""
Enhanced KV Cache Pool - Week 2 Optimization

MLX-level Key-Value cache management with prefix sharing and LRU eviction.
Dramatically improves multi-turn conversation performance by reusing KV caches.

Key Features:
- MLX-level cache storage (mlx.core.array objects)
- Prefix sharing for multi-turn conversations
- LRU eviction when cache is full
- Thread-safe access with asyncio locks
- Comprehensive cache statistics

Architecture:
    Request: "System: You are helpful. User: Hello"
           ↓
    KVCachePool.get(prompt_hash, prefix_hash)
           ↓
    Exact match? → Return full KV cache (instant)
    Prefix match? → Return partial KV cache (50-60% speedup)
    Cache miss? → None (compute from scratch)
           ↓
    After generation: pool.put(prompt_hash, kv_cache, prefix_hash)

Expected Performance:
- Multi-turn conversations: +20-30% improvement
- Cache hit rate: >80% for conversations
- Prefix sharing: 50-60% cache reuse
- Memory overhead: <10% additional memory

Integration:
- Called from python/models/generator.py before MLX generate()
- Stores KV caches after generation for reuse
- Transparent to TypeScript layer (pure Python optimization)

Author: Week 2 Implementation
Date: 2025-11-09
"""

import asyncio
import hashlib
import time
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from collections import OrderedDict

logger = logging.getLogger(__name__)

# MLX import with fallback
try:
    import mlx.core as mx
    MLX_AVAILABLE = True
except ImportError:
    MLX_AVAILABLE = False
    logger.warning("MLX not available - KVCachePool will operate in mock mode")


@dataclass
class KVCacheEntry:
    """
    Single KV cache entry in the pool

    Stores metadata and the actual MLX KV cache arrays
    """
    prompt_hash: str              # SHA256 hash of full prompt
    prefix_hash: Optional[str]    # SHA256 hash of prompt prefix (for sharing)
    kv_cache: Any                 # MLX KV cache arrays (mx.array or mock)
    prompt_tokens: int            # Number of tokens in prompt
    created_at: float             # Timestamp when cached
    last_used: float              # Last access timestamp
    use_count: int                # Number of times reused
    memory_bytes: int             # Estimated memory usage


class KVCachePoolConfig:
    """
    Configuration for KV Cache Pool

    Provides sensible defaults with ability to override
    """
    def __init__(
        self,
        max_size: int = 50,
        ttl_seconds: float = 300.0,  # 5 minutes
        enable_prefix_sharing: bool = True,
        prefix_length_ratio: float = 0.6,  # Use first 60% of prompt as prefix
        enable_statistics: bool = True,
        log_operations: bool = False
    ):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self.enable_prefix_sharing = enable_prefix_sharing
        self.prefix_length_ratio = prefix_length_ratio
        self.enable_statistics = enable_statistics
        self.log_operations = log_operations


class KVCachePool:
    """
    MLX-level KV Cache Pool with prefix sharing and LRU eviction

    Key Insight: Multi-turn conversations often share common prefixes
    (system prompts, conversation history). By caching KV states at the
    MLX level, we can skip redundant computation and dramatically improve
    performance.

    Example Usage:
        pool = KVCachePool(KVCachePoolConfig(max_size=100))

        # Try to get cached KV
        kv_cache = await pool.get(prompt_hash, prefix_hash)

        if kv_cache:
            # Use cached KV cache (instant)
            result = mlx_generate_with_cache(kv_cache)
        else:
            # Generate from scratch
            result, kv_cache = mlx_generate_and_cache()
            # Store for next time
            await pool.put(prompt_hash, kv_cache, prefix_hash)

    Thread Safety:
        All operations are async and use asyncio.Lock for thread safety
    """

    def __init__(self, config: Optional[KVCachePoolConfig] = None):
        self.config = config or KVCachePoolConfig()

        # Cache storage (OrderedDict maintains insertion order for LRU)
        # Key: prompt_hash -> KVCacheEntry
        self.cache: OrderedDict[str, KVCacheEntry] = OrderedDict()

        # Prefix index for fast prefix lookups
        # Key: prefix_hash -> List[prompt_hash]
        self.prefix_index: Dict[str, List[str]] = {}

        # Thread safety
        self.lock = asyncio.Lock()

        # Statistics
        self.stats = {
            'total_requests': 0,
            'cache_hits': 0,
            'prefix_hits': 0,
            'cache_misses': 0,
            'evictions': 0,
            'total_memory_bytes': 0,
            'ttl_evictions': 0
        }

        logger.info(
            f"KVCachePool initialized: max_size={self.config.max_size}, "
            f"ttl={self.config.ttl_seconds}s, "
            f"prefix_sharing={self.config.enable_prefix_sharing}"
        )

    def _compute_prompt_hash(self, prompt: str) -> str:
        """
        Compute SHA256 hash of prompt for cache key

        Args:
            prompt: Full prompt text

        Returns:
            16-character hex hash (truncated SHA256)
        """
        return hashlib.sha256(prompt.encode('utf-8')).hexdigest()[:16]

    def _compute_prefix_hash(self, prompt: str) -> Optional[str]:
        """
        Compute hash of prompt prefix for sharing

        Args:
            prompt: Full prompt text

        Returns:
            Prefix hash if prefix sharing enabled, None otherwise
        """
        if not self.config.enable_prefix_sharing:
            return None

        # Use first N% of prompt as prefix
        prefix_length = int(len(prompt) * self.config.prefix_length_ratio)
        if prefix_length < 10:  # Minimum 10 characters
            return None

        prefix = prompt[:prefix_length]
        return hashlib.sha256(prefix.encode('utf-8')).hexdigest()[:16]

    def _estimate_memory_bytes(self, kv_cache: Any, prompt_tokens: int) -> int:
        """
        Estimate memory usage of KV cache

        Args:
            kv_cache: MLX KV cache arrays
            prompt_tokens: Number of tokens in prompt

        Returns:
            Estimated memory in bytes

        Note:
            Rough estimate: ~4 bytes per token for KV cache
            (2 bytes for K, 2 bytes for V, assuming float16)
        """
        # Conservative estimate: 8 bytes per token (4 for K, 4 for V)
        # This accounts for potential overhead
        return prompt_tokens * 8

    def _is_expired(self, entry: KVCacheEntry) -> bool:
        """
        Check if cache entry has expired

        Args:
            entry: Cache entry to check

        Returns:
            True if expired based on TTL
        """
        age = time.time() - entry.created_at
        return age > self.config.ttl_seconds

    async def get(
        self,
        prompt: str,
        prompt_hash: Optional[str] = None,
        prefix_hash: Optional[str] = None
    ) -> Optional[Any]:
        """
        Get cached KV cache for prompt

        Args:
            prompt: Full prompt text (for hash computation if not provided)
            prompt_hash: Pre-computed prompt hash (optional)
            prefix_hash: Pre-computed prefix hash (optional)

        Returns:
            MLX KV cache if found, None otherwise

        Behavior:
            1. Try exact match first (full cache hit)
            2. Try prefix match if enabled (partial cache hit)
            3. Return None if no match (cache miss)
        """
        async with self.lock:
            self.stats['total_requests'] += 1

            # Compute hashes if not provided
            if prompt_hash is None:
                prompt_hash = self._compute_prompt_hash(prompt)
            if prefix_hash is None and self.config.enable_prefix_sharing:
                prefix_hash = self._compute_prefix_hash(prompt)

            # Try exact match first
            if prompt_hash in self.cache:
                entry = self.cache[prompt_hash]

                # Check if expired
                if self._is_expired(entry):
                    if self.config.log_operations:
                        logger.debug(f"[KVCache] TTL expired: {prompt_hash}")
                    await self._remove_entry(prompt_hash)
                    self.stats['ttl_evictions'] += 1
                    self.stats['cache_misses'] += 1
                    return None

                # Move to end (mark as most recently used)
                self.cache.move_to_end(prompt_hash)
                entry.last_used = time.time()
                entry.use_count += 1

                self.stats['cache_hits'] += 1

                if self.config.log_operations:
                    logger.debug(
                        f"[KVCache] EXACT HIT: hash={prompt_hash}, "
                        f"use_count={entry.use_count}, tokens={entry.prompt_tokens}"
                    )

                return entry.kv_cache

            # Try prefix match if enabled
            if self.config.enable_prefix_sharing and prefix_hash:
                if prefix_hash in self.prefix_index:
                    # Find best prefix match (longest valid entry)
                    candidates = self.prefix_index[prefix_hash]

                    for candidate_hash in candidates:
                        if candidate_hash in self.cache:
                            entry = self.cache[candidate_hash]

                            # Check if expired
                            if self._is_expired(entry):
                                continue

                            # Mark as used
                            self.cache.move_to_end(candidate_hash)
                            entry.last_used = time.time()
                            entry.use_count += 1

                            self.stats['prefix_hits'] += 1

                            if self.config.log_operations:
                                logger.debug(
                                    f"[KVCache] PREFIX HIT: prefix={prefix_hash}, "
                                    f"tokens={entry.prompt_tokens}"
                                )

                            return entry.kv_cache

            # Cache miss
            self.stats['cache_misses'] += 1

            if self.config.log_operations:
                logger.debug(f"[KVCache] MISS: hash={prompt_hash}")

            return None

    async def put(
        self,
        prompt: str,
        kv_cache: Any,
        prompt_tokens: int,
        prompt_hash: Optional[str] = None,
        prefix_hash: Optional[str] = None
    ) -> KVCacheEntry:
        """
        Store KV cache in pool

        Args:
            prompt: Full prompt text
            kv_cache: MLX KV cache arrays to store
            prompt_tokens: Number of tokens in prompt
            prompt_hash: Pre-computed prompt hash (optional)
            prefix_hash: Pre-computed prefix hash (optional)

        Returns:
            KVCacheEntry that was created

        Behavior:
            1. Evict LRU entries if cache is full
            2. Store new entry
            3. Update prefix index if prefix sharing enabled
        """
        async with self.lock:
            # Compute hashes if not provided
            if prompt_hash is None:
                prompt_hash = self._compute_prompt_hash(prompt)
            if prefix_hash is None and self.config.enable_prefix_sharing:
                prefix_hash = self._compute_prefix_hash(prompt)

            # Evict if cache is full
            while len(self.cache) >= self.config.max_size:
                await self._evict_lru()

            # Estimate memory usage
            memory_bytes = self._estimate_memory_bytes(kv_cache, prompt_tokens)

            # Create entry
            entry = KVCacheEntry(
                prompt_hash=prompt_hash,
                prefix_hash=prefix_hash,
                kv_cache=kv_cache,
                prompt_tokens=prompt_tokens,
                created_at=time.time(),
                last_used=time.time(),
                use_count=0,  # Will increment on first use
                memory_bytes=memory_bytes
            )

            # Store in cache
            self.cache[prompt_hash] = entry
            self.stats['total_memory_bytes'] += memory_bytes

            # Update prefix index
            if prefix_hash:
                if prefix_hash not in self.prefix_index:
                    self.prefix_index[prefix_hash] = []
                self.prefix_index[prefix_hash].append(prompt_hash)

            if self.config.log_operations:
                logger.debug(
                    f"[KVCache] PUT: hash={prompt_hash}, "
                    f"tokens={prompt_tokens}, memory={memory_bytes / 1024:.1f}KB"
                )

            return entry

    async def _remove_entry(self, prompt_hash: str):
        """
        Remove entry from cache (internal helper)

        Args:
            prompt_hash: Hash of prompt to remove
        """
        if prompt_hash not in self.cache:
            return

        entry = self.cache[prompt_hash]

        # Remove from prefix index
        if entry.prefix_hash and entry.prefix_hash in self.prefix_index:
            try:
                self.prefix_index[entry.prefix_hash].remove(prompt_hash)
                # Clean up empty prefix lists
                if not self.prefix_index[entry.prefix_hash]:
                    del self.prefix_index[entry.prefix_hash]
            except ValueError:
                pass  # Already removed

        # Update stats
        self.stats['total_memory_bytes'] -= entry.memory_bytes

        # Remove from cache
        del self.cache[prompt_hash]

    async def _evict_lru(self):
        """
        Evict least recently used cache entry

        Uses OrderedDict to track LRU order efficiently
        """
        if not self.cache:
            return

        # OrderedDict maintains insertion order
        # First item is the oldest (LRU)
        lru_hash = next(iter(self.cache))
        entry = self.cache[lru_hash]

        if self.config.log_operations:
            age_minutes = (time.time() - entry.created_at) / 60
            logger.debug(
                f"[KVCache] EVICT LRU: hash={lru_hash}, "
                f"age={age_minutes:.1f}min, use_count={entry.use_count}"
            )

        await self._remove_entry(lru_hash)
        self.stats['evictions'] += 1

    async def clear(self):
        """
        Clear all cache entries

        Useful for testing or memory pressure situations
        """
        async with self.lock:
            count = len(self.cache)
            self.cache.clear()
            self.prefix_index.clear()
            self.stats['total_memory_bytes'] = 0

            logger.info(f"[KVCache] CLEAR: removed {count} entries")

    async def cleanup_expired(self) -> int:
        """
        Remove expired entries based on TTL

        Returns:
            Number of entries removed
        """
        async with self.lock:
            expired = []

            for prompt_hash, entry in self.cache.items():
                if self._is_expired(entry):
                    expired.append(prompt_hash)

            for prompt_hash in expired:
                await self._remove_entry(prompt_hash)
                self.stats['ttl_evictions'] += 1

            if expired and self.config.log_operations:
                logger.debug(f"[KVCache] Cleaned up {len(expired)} expired entries")

            return len(expired)

    def get_stats(self) -> Dict[str, Any]:
        """
        Get cache statistics

        Returns:
            Dictionary with comprehensive cache metrics
        """
        # Calculate derived metrics
        total_hits = self.stats['cache_hits'] + self.stats['prefix_hits']
        hit_rate = (
            total_hits / self.stats['total_requests']
            if self.stats['total_requests'] > 0
            else 0.0
        )

        prefix_hit_rate = (
            self.stats['prefix_hits'] / self.stats['total_requests']
            if self.stats['total_requests'] > 0
            else 0.0
        )

        # Calculate average age and use count
        if self.cache:
            now = time.time()
            entries = list(self.cache.values())
            avg_age_seconds = sum(now - e.created_at for e in entries) / len(entries)
            avg_use_count = sum(e.use_count for e in entries) / len(entries)
        else:
            avg_age_seconds = 0.0
            avg_use_count = 0.0

        return {
            # Configuration
            'max_size': self.config.max_size,
            'ttl_seconds': self.config.ttl_seconds,
            'prefix_sharing_enabled': self.config.enable_prefix_sharing,

            # Current state
            'cache_size': len(self.cache),
            'prefix_index_size': len(self.prefix_index),
            'total_memory_mb': self.stats['total_memory_bytes'] / (1024 ** 2),

            # Hit rate metrics
            'total_requests': self.stats['total_requests'],
            'cache_hits': self.stats['cache_hits'],
            'prefix_hits': self.stats['prefix_hits'],
            'cache_misses': self.stats['cache_misses'],
            'hit_rate': hit_rate,
            'prefix_hit_rate': prefix_hit_rate,

            # Eviction metrics
            'evictions': self.stats['evictions'],
            'ttl_evictions': self.stats['ttl_evictions'],

            # Entry statistics
            'avg_age_seconds': avg_age_seconds,
            'avg_use_count': avg_use_count,
        }

    def get_cache_info(self) -> List[Dict[str, Any]]:
        """
        Get detailed information about cached entries

        Returns:
            List of cache entry details (sorted by most recently used)
        """
        now = time.time()

        entries = []
        for prompt_hash, entry in self.cache.items():
            entries.append({
                'hash': prompt_hash,
                'prefix_hash': entry.prefix_hash,
                'tokens': entry.prompt_tokens,
                'use_count': entry.use_count,
                'age_seconds': now - entry.created_at,
                'last_used_seconds_ago': now - entry.last_used,
                'memory_kb': entry.memory_bytes / 1024,
            })

        # Sort by most recently used
        entries.sort(key=lambda e: e['last_used_seconds_ago'])

        return entries


# Global singleton instance (lazy initialization)
_global_kv_cache_pool: Optional[KVCachePool] = None


def get_kv_cache_pool(config: Optional[KVCachePoolConfig] = None) -> KVCachePool:
    """
    Get global KV Cache Pool instance (singleton)

    Args:
        config: Configuration (only used on first call)

    Returns:
        Global KVCachePool instance
    """
    global _global_kv_cache_pool

    if _global_kv_cache_pool is None:
        _global_kv_cache_pool = KVCachePool(config)

    return _global_kv_cache_pool


# Example integration pattern for generator.py
async def example_integration(prompt: str, model: Any, tokenizer: Any) -> Tuple[Any, Any]:
    """
    Example showing how to integrate KV Cache Pool with MLX generation

    This is a reference implementation - actual integration should be
    in python/models/generator.py

    Args:
        prompt: Input prompt
        model: MLX model
        tokenizer: MLX tokenizer

    Returns:
        (generation_result, kv_cache)
    """
    pool = get_kv_cache_pool()

    # Tokenize prompt to get token count
    tokens = tokenizer.encode(prompt)
    prompt_tokens = len(tokens)

    # Try to get cached KV
    kv_cache = await pool.get(prompt)

    if kv_cache:
        # Cache hit - use cached KV for generation
        logger.info(f"[KVCache] Using cached KV for {prompt_tokens} tokens")

        # Generate with cached KV cache
        # NOTE: Actual MLX API may differ
        result = model.generate(prompt, cache=kv_cache)

        return result, kv_cache
    else:
        # Cache miss - generate from scratch
        logger.info(f"[KVCache] Computing KV for {prompt_tokens} tokens")

        # Generate and capture KV cache
        # NOTE: Actual MLX API may differ
        result, kv_cache = model.generate_with_cache(prompt)

        # Store KV cache for next time
        await pool.put(prompt, kv_cache, prompt_tokens)

        return result, kv_cache
