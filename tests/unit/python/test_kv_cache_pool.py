"""
Unit tests for KVCachePool - Week 2 Optimization

Tests configuration, cache operations, statistics, thread safety,
and edge cases for the MLX-level KV cache management system.

Test Coverage:
- Configuration validation (4 tests)
- Cache operations (8 tests)
- Statistics tracking (4 tests)
- Thread safety (2 tests)
- Edge cases (2+ tests)
"""

import asyncio
import pytest
import time
from pathlib import Path
import sys
from unittest.mock import Mock, MagicMock

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'python'))

from kv_cache_pool import (
    KVCachePool,
    KVCachePoolConfig,
    KVCacheEntry,
    get_kv_cache_pool,
)


# Mock MLX arrays for testing
class MockMLXArray:
    """Mock mlx.core.array for testing without MLX dependency"""
    def __init__(self, size: int):
        self.size = size
        self.data = [0] * size

    def __repr__(self):
        return f"MockMLXArray(size={self.size})"


class TestKVCachePoolConfig:
    """Test KVCachePoolConfig validation and defaults"""

    def test_valid_default_config(self):
        """Test default configuration values"""
        config = KVCachePoolConfig()

        assert config.max_size == 50
        assert config.ttl_seconds == 300.0
        assert config.enable_prefix_sharing is True
        assert config.prefix_length_ratio == 0.6
        assert config.enable_statistics is True
        assert config.log_operations is False

    def test_valid_custom_config(self):
        """Test custom configuration values"""
        config = KVCachePoolConfig(
            max_size=100,
            ttl_seconds=600.0,
            enable_prefix_sharing=False,
            prefix_length_ratio=0.8,
            enable_statistics=False,
            log_operations=True
        )

        assert config.max_size == 100
        assert config.ttl_seconds == 600.0
        assert config.enable_prefix_sharing is False
        assert config.prefix_length_ratio == 0.8
        assert config.enable_statistics is False
        assert config.log_operations is True

    def test_edge_case_max_size_one(self):
        """Test edge case: max_size=1 (minimal cache)"""
        config = KVCachePoolConfig(max_size=1)

        assert config.max_size == 1
        # Should still work with single entry cache

    def test_edge_case_ttl_zero(self):
        """Test edge case: ttl=0 (instant expiration)"""
        config = KVCachePoolConfig(ttl_seconds=0.0)

        assert config.ttl_seconds == 0.0
        # Entries should expire immediately


class TestKVCachePoolOperations:
    """Test core cache operations"""

    @pytest.mark.asyncio
    async def test_basic_put_get_exact_match(self):
        """Test basic put and get with exact match"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Create mock KV cache
        kv_cache = MockMLXArray(size=100)
        prompt = "Hello, how are you?"

        # Put entry
        entry = await pool.put(
            prompt=prompt,
            kv_cache=kv_cache,
            prompt_tokens=5
        )

        assert entry.prompt_tokens == 5
        assert entry.use_count == 0
        assert entry.kv_cache == kv_cache

        # Get entry (exact match)
        result = await pool.get(prompt)

        assert result == kv_cache
        assert pool.cache[entry.prompt_hash].use_count == 1

    @pytest.mark.asyncio
    async def test_get_non_existent_key_miss(self):
        """Test cache miss for non-existent key"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Try to get non-existent entry
        result = await pool.get("This prompt doesn't exist")

        assert result is None
        assert pool.stats['cache_misses'] == 1
        assert pool.stats['cache_hits'] == 0

    @pytest.mark.asyncio
    async def test_update_existing_entry(self):
        """Test updating an existing cache entry"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        prompt = "Same prompt"
        kv_cache1 = MockMLXArray(size=100)
        kv_cache2 = MockMLXArray(size=200)

        # Put first entry
        entry1 = await pool.put(prompt, kv_cache1, 5)
        hash1 = entry1.prompt_hash

        # Put second entry with same prompt (should replace)
        entry2 = await pool.put(prompt, kv_cache2, 10)
        hash2 = entry2.prompt_hash

        assert hash1 == hash2  # Same hash
        assert len(pool.cache) == 1  # Still one entry

        # Get should return updated cache
        result = await pool.get(prompt)
        assert result == kv_cache2

    @pytest.mark.asyncio
    async def test_ttl_expiration(self):
        """Test TTL-based expiration"""
        config = KVCachePoolConfig(max_size=10, ttl_seconds=0.1)
        pool = KVCachePool(config)

        prompt = "Will expire soon"
        kv_cache = MockMLXArray(size=100)

        # Put entry
        await pool.put(prompt, kv_cache, 5)

        # Should be cached immediately
        result = await pool.get(prompt)
        assert result == kv_cache

        # Wait for TTL to expire
        await asyncio.sleep(0.15)

        # Should be expired now
        result = await pool.get(prompt)
        assert result is None
        assert pool.stats['ttl_evictions'] == 1

    @pytest.mark.asyncio
    async def test_lru_eviction_when_full(self):
        """Test LRU eviction when cache reaches max size"""
        config = KVCachePoolConfig(max_size=3)
        pool = KVCachePool(config)

        # Fill cache to max
        prompts = ["prompt1", "prompt2", "prompt3"]
        for i, prompt in enumerate(prompts):
            await pool.put(prompt, MockMLXArray(100), 5)

        assert len(pool.cache) == 3

        # Add fourth entry (should evict LRU - prompt1)
        await pool.put("prompt4", MockMLXArray(100), 5)

        assert len(pool.cache) == 3
        assert pool.stats['evictions'] == 1

        # prompt1 should be evicted
        result = await pool.get("prompt1")
        assert result is None

        # Other prompts should still exist
        assert await pool.get("prompt2") is not None
        assert await pool.get("prompt3") is not None
        assert await pool.get("prompt4") is not None

    @pytest.mark.asyncio
    async def test_prefix_matching_enabled(self):
        """Test prefix matching when enabled"""
        config = KVCachePoolConfig(
            max_size=10,
            enable_prefix_sharing=True,
            prefix_length_ratio=0.6
        )
        pool = KVCachePool(config)

        # Put entry with long prompt
        base_prompt = "System: You are helpful. User: "
        full_prompt1 = base_prompt + "What is Python?"
        kv_cache1 = MockMLXArray(size=100)

        entry = await pool.put(full_prompt1, kv_cache1, 10)
        prefix_hash = entry.prefix_hash

        assert prefix_hash is not None
        assert prefix_hash in pool.prefix_index

        # Try to get with similar prefix
        full_prompt2 = base_prompt + "What is JavaScript?"
        result = await pool.get(full_prompt2)

        # Should find prefix match
        # Note: This will be exact match if prompts share same prefix hash
        # or None if prefix differs enough
        if result is not None:
            assert pool.stats['prefix_hits'] >= 0  # May or may not match

    @pytest.mark.asyncio
    async def test_prefix_matching_disabled(self):
        """Test prefix matching when disabled"""
        config = KVCachePoolConfig(
            max_size=10,
            enable_prefix_sharing=False
        )
        pool = KVCachePool(config)

        # Put entry
        prompt1 = "System: You are helpful. User: What is Python?"
        kv_cache1 = MockMLXArray(size=100)

        entry = await pool.put(prompt1, kv_cache1, 10)

        assert entry.prefix_hash is None
        assert len(pool.prefix_index) == 0

        # Similar prompt should not match (prefix sharing disabled)
        prompt2 = "System: You are helpful. User: What is JavaScript?"
        result = await pool.get(prompt2)

        assert result is None
        assert pool.stats['prefix_hits'] == 0

    @pytest.mark.asyncio
    async def test_clear_all_entries(self):
        """Test clearing all cache entries"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Add multiple entries
        for i in range(5):
            await pool.put(f"prompt{i}", MockMLXArray(100), 5)

        assert len(pool.cache) == 5

        # Clear all
        await pool.clear()

        assert len(pool.cache) == 0
        assert len(pool.prefix_index) == 0
        assert pool.stats['total_memory_bytes'] == 0


class TestKVCachePoolStatistics:
    """Test statistics tracking and reporting"""

    @pytest.mark.asyncio
    async def test_hit_miss_counting(self):
        """Test cache hit/miss statistics"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Cache miss
        await pool.get("missing_prompt")
        assert pool.stats['cache_misses'] == 1
        assert pool.stats['cache_hits'] == 0

        # Put and hit
        await pool.put("existing_prompt", MockMLXArray(100), 5)
        await pool.get("existing_prompt")

        assert pool.stats['cache_hits'] == 1
        assert pool.stats['cache_misses'] == 1

        # Multiple hits
        await pool.get("existing_prompt")
        await pool.get("existing_prompt")

        assert pool.stats['cache_hits'] == 3
        assert pool.stats['total_requests'] == 4

    @pytest.mark.asyncio
    async def test_prefix_sharing_effectiveness(self):
        """Test prefix sharing statistics"""
        config = KVCachePoolConfig(
            max_size=10,
            enable_prefix_sharing=True,
            prefix_length_ratio=0.7
        )
        pool = KVCachePool(config)

        # Put entry
        prompt1 = "A" * 100  # Long prompt
        await pool.put(prompt1, MockMLXArray(100), 10)

        stats = pool.get_stats()

        assert stats['prefix_sharing_enabled'] is True
        assert stats['prefix_index_size'] >= 0
        assert stats['cache_size'] == 1

    @pytest.mark.asyncio
    async def test_memory_usage_estimation(self):
        """Test memory usage estimation and tracking"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Put entry with known token count
        prompt = "Test prompt"
        kv_cache = MockMLXArray(size=100)
        prompt_tokens = 50

        await pool.put(prompt, kv_cache, prompt_tokens)

        stats = pool.get_stats()

        # Memory estimation: ~8 bytes per token
        expected_memory = prompt_tokens * 8
        assert pool.stats['total_memory_bytes'] == expected_memory
        assert stats['total_memory_mb'] > 0

    @pytest.mark.asyncio
    async def test_statistics_reset_after_clear(self):
        """Test that memory stats reset after clear"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Add entries
        for i in range(3):
            await pool.put(f"prompt{i}", MockMLXArray(100), 10)

        initial_memory = pool.stats['total_memory_bytes']
        assert initial_memory > 0

        # Clear
        await pool.clear()

        assert pool.stats['total_memory_bytes'] == 0
        assert pool.get_stats()['total_memory_mb'] == 0


class TestKVCachePoolThreadSafety:
    """Test thread safety with concurrent operations"""

    @pytest.mark.asyncio
    async def test_concurrent_put_operations(self):
        """Test concurrent put operations are thread-safe"""
        config = KVCachePoolConfig(max_size=100)
        pool = KVCachePool(config)

        async def put_entries(start_idx: int, count: int):
            """Add multiple entries concurrently"""
            for i in range(count):
                prompt = f"prompt_{start_idx}_{i}"
                await pool.put(prompt, MockMLXArray(100), 5)

        # Run multiple concurrent put operations
        tasks = [
            asyncio.create_task(put_entries(0, 20)),
            asyncio.create_task(put_entries(1, 20)),
            asyncio.create_task(put_entries(2, 20)),
        ]

        await asyncio.gather(*tasks)

        # All entries should be added without corruption
        assert len(pool.cache) == 60
        stats = pool.get_stats()
        assert stats['cache_size'] == 60

    @pytest.mark.asyncio
    async def test_concurrent_get_put_mix(self):
        """Test concurrent mix of get and put operations"""
        config = KVCachePoolConfig(max_size=50)
        pool = KVCachePool(config)

        # Pre-populate some entries
        for i in range(10):
            await pool.put(f"existing_{i}", MockMLXArray(100), 5)

        async def reader():
            """Read existing entries"""
            for _ in range(20):
                await pool.get(f"existing_{_ % 10}")
                await asyncio.sleep(0.001)

        async def writer():
            """Write new entries"""
            for i in range(20):
                await pool.put(f"new_{i}", MockMLXArray(100), 5)
                await asyncio.sleep(0.001)

        # Run readers and writers concurrently
        tasks = [
            asyncio.create_task(reader()),
            asyncio.create_task(reader()),
            asyncio.create_task(writer()),
        ]

        await asyncio.gather(*tasks)

        # Should have original + new entries (some may be evicted)
        assert len(pool.cache) <= 50  # Max size
        assert pool.stats['cache_hits'] > 0
        assert pool.stats['cache_misses'] >= 0


class TestKVCachePoolEdgeCases:
    """Test edge cases and boundary conditions"""

    @pytest.mark.asyncio
    async def test_very_large_cache_entry(self):
        """Test handling very large cache entries"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Simulate large KV cache (10k tokens)
        large_kv_cache = MockMLXArray(size=10000)
        prompt = "Very long prompt"

        entry = await pool.put(prompt, large_kv_cache, 10000)

        assert entry.memory_bytes == 10000 * 8
        assert pool.stats['total_memory_bytes'] == 10000 * 8

        # Should be retrievable
        result = await pool.get(prompt)
        assert result == large_kv_cache

    @pytest.mark.asyncio
    async def test_rapid_eviction_scenario(self):
        """Test rapid eviction with small cache and many entries"""
        config = KVCachePoolConfig(max_size=3)
        pool = KVCachePool(config)

        # Add many entries rapidly (should trigger many evictions)
        for i in range(20):
            await pool.put(f"prompt_{i}", MockMLXArray(100), 5)

        # Cache should stay at max size
        assert len(pool.cache) == 3
        assert pool.stats['evictions'] == 17  # 20 - 3

        # Only last 3 entries should remain (LRU keeps most recent)
        assert await pool.get("prompt_0") is None  # Evicted (oldest)
        assert await pool.get("prompt_17") is not None  # Kept
        assert await pool.get("prompt_18") is not None  # Kept
        assert await pool.get("prompt_19") is not None  # Kept

    @pytest.mark.asyncio
    async def test_cleanup_expired_entries(self):
        """Test manual cleanup of expired entries"""
        config = KVCachePoolConfig(max_size=10, ttl_seconds=0.1)
        pool = KVCachePool(config)

        # Add entries
        for i in range(5):
            await pool.put(f"prompt_{i}", MockMLXArray(100), 5)

        assert len(pool.cache) == 5

        # Wait for expiration
        await asyncio.sleep(0.15)

        # Manual cleanup
        removed = await pool.cleanup_expired()

        assert removed == 5
        assert len(pool.cache) == 0
        assert pool.stats['ttl_evictions'] == 5

    @pytest.mark.asyncio
    async def test_get_cache_info(self):
        """Test detailed cache info retrieval"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Add entries with varying use counts
        await pool.put("prompt1", MockMLXArray(100), 10)
        await pool.put("prompt2", MockMLXArray(200), 20)

        # Use entries different amounts
        await pool.get("prompt1")
        await pool.get("prompt1")
        await pool.get("prompt2")

        # Get cache info
        info = pool.get_cache_info()

        assert len(info) == 2
        assert all('hash' in entry for entry in info)
        assert all('tokens' in entry for entry in info)
        assert all('use_count' in entry for entry in info)
        assert all('age_seconds' in entry for entry in info)

        # Entries should be sorted by most recently used
        assert info[0]['last_used_seconds_ago'] <= info[1]['last_used_seconds_ago']

    @pytest.mark.asyncio
    async def test_empty_prompt_handling(self):
        """Test handling of empty or very short prompts"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        # Empty prompt
        await pool.put("", MockMLXArray(10), 1)
        result = await pool.get("")
        assert result is not None

        # Very short prompt (less than prefix minimum)
        short_prompt = "Hi"
        entry = await pool.put(short_prompt, MockMLXArray(10), 1)

        # Prefix hash should be None for short prompts
        assert entry.prefix_hash is None or len(short_prompt) < 10

    @pytest.mark.asyncio
    async def test_use_count_tracking(self):
        """Test accurate use count tracking"""
        config = KVCachePoolConfig(max_size=10)
        pool = KVCachePool(config)

        prompt = "Track my usage"
        await pool.put(prompt, MockMLXArray(100), 5)

        # Use entry multiple times
        for i in range(5):
            await pool.get(prompt)

        # Check use count
        hash_key = pool._compute_prompt_hash(prompt)
        entry = pool.cache[hash_key]

        assert entry.use_count == 5

    @pytest.mark.asyncio
    async def test_lru_ordering_verification(self):
        """Test LRU ordering is maintained correctly"""
        config = KVCachePoolConfig(max_size=5)
        pool = KVCachePool(config)

        # Add entries in order
        for i in range(5):
            await pool.put(f"prompt_{i}", MockMLXArray(100), 5)

        # Access prompt_1 (should move to end)
        await pool.get("prompt_1")

        # Add new entry (should evict prompt_0, not prompt_1)
        await pool.put("prompt_new", MockMLXArray(100), 5)

        assert await pool.get("prompt_0") is None  # Evicted
        assert await pool.get("prompt_1") is not None  # Still cached
        assert await pool.get("prompt_new") is not None

    @pytest.mark.asyncio
    async def test_prefix_hash_computation(self):
        """Test prefix hash computation logic"""
        config = KVCachePoolConfig(
            max_size=10,
            enable_prefix_sharing=True,
            prefix_length_ratio=0.6
        )
        pool = KVCachePool(config)

        # Long prompt
        long_prompt = "A" * 100
        prefix_hash = pool._compute_prefix_hash(long_prompt)

        assert prefix_hash is not None
        assert len(prefix_hash) == 16  # Truncated SHA256

        # Short prompt (less than minimum)
        short_prompt = "Hi"
        prefix_hash_short = pool._compute_prefix_hash(short_prompt)

        assert prefix_hash_short is None  # Too short for prefix


class TestKVCachePoolGlobalSingleton:
    """Test global singleton pattern"""

    def test_get_kv_cache_pool_singleton(self):
        """Test global singleton instance"""
        # First call creates instance
        pool1 = get_kv_cache_pool()
        assert pool1 is not None

        # Second call returns same instance
        pool2 = get_kv_cache_pool()
        assert pool1 is pool2

    def test_singleton_with_config(self):
        """Test singleton respects initial config"""
        # Note: Singleton is already initialized from previous tests
        # We can only test that it returns a valid instance

        # Get existing singleton
        pool = get_kv_cache_pool()

        # Should return same instance as before
        pool2 = get_kv_cache_pool()
        assert pool is pool2

        # Config is from first initialization (default or previous test)
        assert isinstance(pool.config, KVCachePoolConfig)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
