"""
TTFT Accelerator - KV Cache Prefetch Coordinator

Coordinates KV cache prefetching based on warmup signals from TypeScript.
Enables faster TTFT by pre-loading cache for known prompts.

Phase 4.3 Implementation
"""

from dataclasses import dataclass
from typing import Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


@dataclass
class WarmupSignal:
    """Warmup signal from TypeScript"""
    stream_id: str
    model_id: str
    prompt_hash: str
    estimated_tokens: int
    speculation_allowed: bool
    speculated_tokens: Optional[List[str]] = None


@dataclass
class KvPrepStatus:
    """KV prep status to return to TypeScript"""
    stream_id: str
    status: str  # 'pending' | 'ready' | 'failed'
    cached_tokens: Optional[int] = None
    error_message: Optional[str] = None


class KvPrepCoordinator:
    """
    KV Cache Prefetch Coordinator

    Manages KV cache prefetching and first-token speculation
    for TTFT optimization.
    """

    def __init__(self):
        """Initialize the coordinator"""
        self.speculation_cache: Dict[str, List[int]] = {}
        self.warmup_queue: List[WarmupSignal] = []
        self.enabled = False

    def handle_signal(self, signal: WarmupSignal) -> KvPrepStatus:
        """
        Handle warmup signal from TypeScript

        Args:
            signal: Warmup signal with prompt metadata

        Returns:
            Status of KV preparation
        """
        if not self.enabled:
            return KvPrepStatus(
                stream_id=signal.stream_id,
                status='pending'
            )

        try:
            # Check if we have cached speculation for this prompt
            if signal.speculation_allowed and signal.prompt_hash in self.speculation_cache:
                cached_tokens = len(self.speculation_cache[signal.prompt_hash])
                logger.debug(
                    f"Found cached speculation for {signal.prompt_hash}: "
                    f"{cached_tokens} tokens"
                )

                return KvPrepStatus(
                    stream_id=signal.stream_id,
                    status='ready',
                    cached_tokens=cached_tokens
                )

            # No cached speculation, but prefetch can still help
            # In a full implementation, this would trigger KV cache prefetch
            logger.debug(f"No cached speculation for {signal.prompt_hash}")

            return KvPrepStatus(
                stream_id=signal.stream_id,
                status='pending'
            )

        except Exception as e:
            logger.error(f"Error handling warmup signal: {e}")
            return KvPrepStatus(
                stream_id=signal.stream_id,
                status='failed',
                error_message=str(e)
            )

    def update_speculation(self, prompt_hash: str, tokens: List[int]):
        """
        Update speculation cache with observed first tokens

        Args:
            prompt_hash: Hash of the prompt
            tokens: Actual first tokens observed
        """
        self.speculation_cache[prompt_hash] = tokens
        logger.debug(f"Updated speculation cache for {prompt_hash}: {len(tokens)} tokens")

    def enable(self):
        """Enable KV prefetch coordination"""
        self.enabled = True
        logger.info("KV prefetch coordinator enabled")

    def disable(self):
        """Disable KV prefetch coordination"""
        self.enabled = False
        logger.info("KV prefetch coordinator disabled")

    def get_stats(self) -> Dict:
        """Get coordinator statistics"""
        return {
            'enabled': self.enabled,
            'cached_prompts': len(self.speculation_cache),
            'queue_size': len(self.warmup_queue)
        }


# Global coordinator instance
_coordinator: Optional[KvPrepCoordinator] = None


def get_coordinator() -> KvPrepCoordinator:
    """Get or create the global coordinator instance"""
    global _coordinator
    if _coordinator is None:
        _coordinator = KvPrepCoordinator()
    return _coordinator
