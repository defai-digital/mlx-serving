"""
Unit tests for AsyncPriorityQueue

Tests priority ordering, FIFO within priority, async operations,
and metrics tracking.
"""

import asyncio
import pytest
import time
from pathlib import Path
import sys

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'python'))

from models.priority_queue import (
    AsyncPriorityQueue,
    Priority,
    PrioritizedRequest,
    create_priority_request
)


class TestAsyncPriorityQueue:
    """Test AsyncPriorityQueue functionality"""

    @pytest.mark.asyncio
    async def test_basic_enqueue_dequeue(self):
        """Test basic put/get operations"""
        queue = AsyncPriorityQueue()

        # Add item
        await queue.put(PrioritizedRequest(
            priority=Priority.NORMAL,
            timestamp=time.time(),
            request="test1"
        ))

        assert queue.qsize() == 1
        assert not queue.empty()

        # Get item
        item = await queue.get()
        assert item == "test1"
        assert queue.qsize() == 0
        assert queue.empty()

    @pytest.mark.asyncio
    async def test_priority_ordering(self):
        """Test that higher priority items are dequeued first"""
        queue = AsyncPriorityQueue()

        # Add items in random order
        await queue.put(PrioritizedRequest(
            priority=Priority.LOW,
            timestamp=time.time(),
            request="low"
        ))
        await queue.put(PrioritizedRequest(
            priority=Priority.HIGH,
            timestamp=time.time(),
            request="high"
        ))
        await queue.put(PrioritizedRequest(
            priority=Priority.NORMAL,
            timestamp=time.time(),
            request="normal"
        ))
        await queue.put(PrioritizedRequest(
            priority=Priority.CRITICAL,
            timestamp=time.time(),
            request="critical"
        ))

        # Should dequeue in priority order
        assert await queue.get() == "critical"
        assert await queue.get() == "high"
        assert await queue.get() == "normal"
        assert await queue.get() == "low"

    @pytest.mark.asyncio
    async def test_fifo_within_same_priority(self):
        """Test FIFO ordering within same priority level"""
        queue = AsyncPriorityQueue()

        # Add multiple items with same priority but different timestamps
        for i in range(5):
            await queue.put(PrioritizedRequest(
                priority=Priority.NORMAL,
                timestamp=time.time() + i * 0.001,  # Slightly different timestamps
                request=f"item{i}"
            ))
            await asyncio.sleep(0.002)  # Ensure timestamp ordering

        # Should dequeue in FIFO order (oldest first)
        for i in range(5):
            item = await queue.get()
            assert item == f"item{i}"

    @pytest.mark.asyncio
    async def test_get_nowait_empty(self):
        """Test get_nowait raises exception when empty"""
        queue = AsyncPriorityQueue()

        with pytest.raises(asyncio.QueueEmpty):
            queue.get_nowait()

    @pytest.mark.asyncio
    async def test_get_nowait_success(self):
        """Test get_nowait returns item immediately if available"""
        queue = AsyncPriorityQueue()

        await queue.put(PrioritizedRequest(
            priority=Priority.NORMAL,
            timestamp=time.time(),
            request="test"
        ))

        item = queue.get_nowait()
        assert item == "test"
        assert queue.empty()

    @pytest.mark.asyncio
    async def test_maxsize_blocking(self):
        """Test that queue blocks when full"""
        queue = AsyncPriorityQueue(maxsize=2)

        # Fill queue
        await queue.put(create_priority_request("item1"))
        await queue.put(create_priority_request("item2"))

        assert queue.full()
        assert queue.qsize() == 2

        # Try to add third item (should block)
        # Use timeout to prevent hanging
        put_task = asyncio.create_task(
            queue.put(create_priority_request("item3"))
        )

        # Wait briefly - should still be blocked
        await asyncio.sleep(0.1)
        assert not put_task.done()

        # Dequeue one item - should unblock put
        await queue.get()
        await asyncio.sleep(0.1)
        assert put_task.done()

        # Should now have 2 items
        assert queue.qsize() == 2

    @pytest.mark.asyncio
    async def test_get_blocks_when_empty(self):
        """Test that get() blocks when queue is empty"""
        queue = AsyncPriorityQueue()

        # Try to get from empty queue (should block)
        get_task = asyncio.create_task(queue.get())

        # Wait briefly - should still be blocked
        await asyncio.sleep(0.1)
        assert not get_task.done()

        # Add item - should unblock get
        await queue.put(create_priority_request("test"))
        await asyncio.sleep(0.1)
        assert get_task.done()

        result = await get_task
        assert result == "test"

    @pytest.mark.asyncio
    async def test_metrics_tracking(self):
        """Test that metrics are tracked correctly"""
        queue = AsyncPriorityQueue()

        # Add items with different priorities
        await queue.put(create_priority_request("item1", Priority.HIGH))
        await queue.put(create_priority_request("item2", Priority.NORMAL))
        await queue.put(create_priority_request("item3", Priority.HIGH))

        # Get metrics
        metrics = queue.get_metrics()

        assert metrics['current_size'] == 3
        assert metrics['total_enqueued'] == 3
        assert metrics['total_dequeued'] == 0
        assert not metrics['is_empty']

        # Dequeue one item
        await queue.get()

        metrics = queue.get_metrics()
        assert metrics['current_size'] == 2
        assert metrics['total_enqueued'] == 3
        assert metrics['total_dequeued'] == 1

        # Check priority distribution
        distribution = metrics['priority_distribution']
        assert 'HIGH' in distribution
        assert 'NORMAL' in distribution
        assert distribution['HIGH']['count'] == 2
        assert distribution['NORMAL']['count'] == 1

    @pytest.mark.asyncio
    async def test_peek_priority(self):
        """Test peeking at next priority without dequeuing"""
        queue = AsyncPriorityQueue()

        # Empty queue
        assert queue.peek_priority() is None

        # Add items
        await queue.put(create_priority_request("low", Priority.LOW))
        await queue.put(create_priority_request("high", Priority.HIGH))

        # Peek should show highest priority
        assert queue.peek_priority() == Priority.HIGH
        assert queue.qsize() == 2  # Should not dequeue

        # Dequeue high priority
        await queue.get()

        # Peek should now show next priority
        assert queue.peek_priority() == Priority.LOW

    @pytest.mark.asyncio
    async def test_clear(self):
        """Test clearing the queue"""
        queue = AsyncPriorityQueue()

        # Add items
        for i in range(5):
            await queue.put(create_priority_request(f"item{i}"))

        assert queue.qsize() == 5

        # Clear
        queue.clear()

        assert queue.qsize() == 0
        assert queue.empty()
        assert queue.peek_priority() is None

    @pytest.mark.asyncio
    async def test_concurrent_operations(self):
        """Test concurrent put/get operations"""
        queue = AsyncPriorityQueue()

        async def producer(n):
            """Add n items to queue"""
            for i in range(n):
                await queue.put(create_priority_request(f"item{i}"))
                await asyncio.sleep(0.01)

        async def consumer(n):
            """Get n items from queue"""
            items = []
            for _ in range(n):
                item = await queue.get()
                items.append(item)
                await asyncio.sleep(0.01)
            return items

        # Run producer and consumer concurrently
        producer_task = asyncio.create_task(producer(10))
        consumer_task = asyncio.create_task(consumer(10))

        await asyncio.gather(producer_task, consumer_task)

        # All items should be consumed
        assert queue.empty()

        # Check metrics
        metrics = queue.get_metrics()
        assert metrics['total_enqueued'] == 10
        assert metrics['total_dequeued'] == 10

    @pytest.mark.asyncio
    async def test_create_priority_request_helper(self):
        """Test the helper function for creating priority requests"""
        # Default priority (NORMAL)
        req1 = create_priority_request("test1")
        assert req1.priority == Priority.NORMAL
        assert req1.request == "test1"
        assert req1.timestamp <= time.time()

        # Explicit priority
        req2 = create_priority_request("test2", Priority.HIGH)
        assert req2.priority == Priority.HIGH
        assert req2.request == "test2"

    @pytest.mark.asyncio
    async def test_mixed_priority_workload(self):
        """Test realistic mixed priority workload"""
        queue = AsyncPriorityQueue()

        # Simulate mixed workload
        await queue.put(create_priority_request("background1", Priority.BACKGROUND))
        await queue.put(create_priority_request("normal1", Priority.NORMAL))
        await queue.put(create_priority_request("critical1", Priority.CRITICAL))
        await queue.put(create_priority_request("normal2", Priority.NORMAL))
        await queue.put(create_priority_request("high1", Priority.HIGH))
        await queue.put(create_priority_request("low1", Priority.LOW))
        await queue.put(create_priority_request("critical2", Priority.CRITICAL))

        # Dequeue and verify order
        expected_order = [
            "critical1",  # CRITICAL (first)
            "critical2",  # CRITICAL (second)
            "high1",      # HIGH
            "normal1",    # NORMAL (first)
            "normal2",    # NORMAL (second)
            "low1",       # LOW
            "background1" # BACKGROUND
        ]

        for expected in expected_order:
            actual = await queue.get()
            assert actual == expected, f"Expected {expected}, got {actual}"

        assert queue.empty()


class TestPriorityEnum:
    """Test Priority enum"""

    def test_priority_values(self):
        """Test priority values are ordered correctly"""
        assert Priority.CRITICAL < Priority.HIGH
        assert Priority.HIGH < Priority.NORMAL
        assert Priority.NORMAL < Priority.LOW
        assert Priority.LOW < Priority.BACKGROUND

    def test_priority_names(self):
        """Test priority names"""
        assert Priority.CRITICAL.name == "CRITICAL"
        assert Priority.HIGH.name == "HIGH"
        assert Priority.NORMAL.name == "NORMAL"
        assert Priority.LOW.name == "LOW"
        assert Priority.BACKGROUND.name == "BACKGROUND"


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
