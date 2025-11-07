"""
Async Priority Queue for Request Scheduling

Week 4: Intelligent request prioritization for better SLA management
Enables high-priority requests to be processed before lower-priority ones
while maintaining FIFO ordering within the same priority level.

Key Features:
- Priority levels: CRITICAL, HIGH, NORMAL, LOW, BACKGROUND
- FIFO ordering within same priority
- Async/await compatible
- Efficient heap-based implementation (O(log n))
- Graceful degradation (works as normal queue if priorities not used)

Architecture:
    Request arrives with priority → Add to heap queue
                                          ↓
                            Sort by: (priority, timestamp)
                                          ↓
                            High-priority requests pulled first
                                          ↓
                            Within same priority: FIFO order

Expected Benefits:
- Better SLA for important requests
- P95 latency reduced by 50% for high-priority
- Background jobs don't block critical work
- Fair scheduling within priority levels

Author: Week 4 Implementation
Date: 2025-11-05
"""

import asyncio
import heapq
import time
from enum import IntEnum
from dataclasses import dataclass, field
from typing import Any, List, Optional
import logging

logger = logging.getLogger(__name__)


class Priority(IntEnum):
    """
    Request priority levels

    Lower numeric value = higher priority (processed first)
    """
    CRITICAL = 0    # Immediate processing (e.g., health checks, admin)
    HIGH = 1        # User-facing requests (e.g., interactive queries)
    NORMAL = 2      # Standard requests (default)
    LOW = 3         # Batch processing, analytics
    BACKGROUND = 4  # Background jobs, precomputation


@dataclass(order=True)
class PrioritizedRequest:
    """
    Request with priority for heap queue

    Ordering: First by priority (lower = higher), then by timestamp (FIFO)
    """
    priority: int                    # Priority level (0 = highest)
    timestamp: float                 # Arrival timestamp (for FIFO within priority)
    request: Any = field(compare=False)  # Actual request (not compared)


class AsyncPriorityQueue:
    """
    Async priority queue with FIFO ordering within same priority

    Implementation uses Python's heapq for O(log n) operations.
    Thread-safe for async operations via asyncio.Lock.

    Example:
        queue = AsyncPriorityQueue()

        # Add high-priority request
        await queue.put(PrioritizedRequest(
            priority=Priority.HIGH,
            timestamp=time.time(),
            request=my_request
        ))

        # Get highest priority request (blocks if empty)
        request = await queue.get()  # Returns high-priority first

    Args:
        maxsize: Maximum queue size (0 = unlimited)
    """

    def __init__(self, maxsize: int = 0):
        """
        Initialize priority queue

        Args:
            maxsize: Maximum queue size (0 = unlimited, default)
        """
        self.maxsize = maxsize
        self._heap: List[PrioritizedRequest] = []
        self._lock = asyncio.Lock()
        self._not_empty = asyncio.Event()
        self._not_full = asyncio.Event()

        # Set initial state
        self._not_full.set()  # Queue starts empty, so not full

        # Metrics
        self.total_enqueued = 0
        self.total_dequeued = 0
        self.priority_counts = {p: 0 for p in Priority}

        logger.debug(f"AsyncPriorityQueue initialized (maxsize={maxsize})")

    async def put(self, item: PrioritizedRequest) -> None:
        """
        Add item to priority queue

        Blocks if queue is full (when maxsize > 0).
        Items are automatically sorted by priority, then timestamp.

        Args:
            item: PrioritizedRequest to enqueue
        """
        # Wait if queue is full
        if self.maxsize > 0:
            while len(self._heap) >= self.maxsize:
                self._not_full.clear()
                await self._not_full.wait()

        async with self._lock:
            heapq.heappush(self._heap, item)
            self.total_enqueued += 1

            # Track priority distribution
            try:
                priority_enum = Priority(item.priority)
                self.priority_counts[priority_enum] += 1
            except ValueError:
                pass  # Unknown priority, skip tracking

            self._not_empty.set()

            logger.debug(
                f"Enqueued request (priority={item.priority}, "
                f"queue_size={len(self._heap)})"
            )

    async def get(self) -> Any:
        """
        Get highest priority item from queue

        Blocks if queue is empty.
        Returns the request with lowest priority value (highest priority).
        Within same priority, returns oldest (FIFO).

        Returns:
            The actual request object (not PrioritizedRequest wrapper)
        """
        # Wait if queue is empty
        while not self._heap:
            self._not_empty.clear()
            await self._not_empty.wait()

        async with self._lock:
            item = heapq.heappop(self._heap)
            self.total_dequeued += 1

            # Signal not full
            if self.maxsize > 0:
                self._not_full.set()

            logger.debug(
                f"Dequeued request (priority={item.priority}, "
                f"queue_size={len(self._heap)}, "
                f"waited={(time.time() - item.timestamp) * 1000:.1f}ms)"
            )

            return item.request

    def get_nowait(self) -> Any:
        """
        Get highest priority item without waiting

        WARNING: This method is not fully thread-safe and should only be used
        when no other coroutines are accessing the queue concurrently.
        Prefer using async get() for proper synchronization.

        Raises:
            asyncio.QueueEmpty: If queue is empty

        Returns:
            The actual request object
        """
        # BUG FIX: Protect against heap becoming empty between check and pop
        try:
            item = heapq.heappop(self._heap)
        except IndexError:
            raise asyncio.QueueEmpty("Priority queue is empty")

        self.total_dequeued += 1

        if self.maxsize > 0:
            self._not_full.set()

        logger.debug(
            f"Dequeued request (nowait, priority={item.priority}, "
            f"queue_size={len(self._heap)})"
        )

        return item.request

    def qsize(self) -> int:
        """
        Get current queue size

        Returns:
            Number of items in queue
        """
        return len(self._heap)

    def empty(self) -> bool:
        """
        Check if queue is empty

        Returns:
            True if queue is empty
        """
        return len(self._heap) == 0

    def full(self) -> bool:
        """
        Check if queue is full

        Returns:
            True if queue is full (only relevant if maxsize > 0)
        """
        if self.maxsize <= 0:
            return False
        return len(self._heap) >= self.maxsize

    def get_metrics(self) -> dict:
        """
        Get queue metrics for monitoring

        Returns:
            Dictionary with queue statistics
        """
        # Calculate priority distribution percentages
        priority_distribution = {}
        if self.total_enqueued > 0:
            for priority, count in self.priority_counts.items():
                percentage = (count / self.total_enqueued) * 100
                priority_distribution[priority.name] = {
                    'count': count,
                    'percentage': percentage
                }

        return {
            'current_size': len(self._heap),
            'max_size': self.maxsize if self.maxsize > 0 else 'unlimited',
            'total_enqueued': self.total_enqueued,
            'total_dequeued': self.total_dequeued,
            'priority_distribution': priority_distribution,
            'is_empty': self.empty(),
            'is_full': self.full(),
        }

    def peek_priority(self) -> Optional[int]:
        """
        Peek at highest priority without removing

        Returns:
            Priority of next item, or None if empty
        """
        if not self._heap:
            return None
        return self._heap[0].priority

    def clear(self):
        """Clear all items from queue"""
        self._heap.clear()
        self._not_empty.clear()
        self._not_full.set()
        logger.info(f"Priority queue cleared (total_enqueued={self.total_enqueued})")


# Helper function for backward compatibility
def create_priority_request(
    request: Any,
    priority: Priority = Priority.NORMAL
) -> PrioritizedRequest:
    """
    Create a PrioritizedRequest with current timestamp

    Helper function for easy priority request creation.

    Args:
        request: The actual request object
        priority: Priority level (default: NORMAL)

    Returns:
        PrioritizedRequest ready for queue
    """
    return PrioritizedRequest(
        priority=priority.value,
        timestamp=time.time(),
        request=request
    )


# Export for use in runtime
__all__ = [
    'Priority',
    'PrioritizedRequest',
    'AsyncPriorityQueue',
    'create_priority_request',
]
