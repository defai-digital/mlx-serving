"""
Batch Generator - GPU-level batching for parallel inference

Week 1 Implementation: Static batching for proof of concept
Processes fixed-size batches of requests in parallel on GPU

Architecture:
    TypeScript → JSON-RPC → batch_generate_parallel → BatchGenerator → MLX (parallel)

Performance Target:
    2-3x throughput improvement vs sequential processing
"""

import asyncio
import time
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple
from dataclasses import dataclass

# Import MLX with safety check
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from models.loader import ModelHandle, MLX_AVAILABLE
from errors import GenerationError
from config_loader import get_config

# Conditional MLX imports
mx = None
if MLX_AVAILABLE:
    try:
        import mlx.core as mx
    except ImportError:
        MLX_AVAILABLE = False


@dataclass
class BatchRequest:
    """
    Single request in a batch

    Tracks all state for one generation request during batching
    """
    request_id: str
    prompt: str
    prompt_tokens: List[int]
    max_tokens: int
    temperature: float
    top_p: float
    stream_id: str

    # Generated tokens
    generated_tokens: List[int]
    generated_text: str

    # State tracking
    is_finished: bool
    finish_reason: Optional[str]

    # Timing
    started_at: float
    first_token_at: Optional[float]

    # Week 3: Request timeout (optional)
    timeout_ms: Optional[float] = None  # Timeout in milliseconds


class BatchGenerator:
    """
    Static batch generator for MLX models

    Processes fixed-size batches of requests in parallel on GPU.
    All requests in batch must use the same model.

    Week 1 Implementation:
    - Fixed batch sizes (2, 4, 8)
    - Synchronous batch processing
    - Padding for variable-length sequences
    - Per-request sampling parameters

    Future Enhancements (Week 2):
    - Dynamic batch composition
    - Continuous batching loop
    - Adaptive batch sizing
    """

    def __init__(
        self,
        handle: ModelHandle,
        batch_size: int = 4,
        pad_token_id: Optional[int] = None
    ):
        """
        Initialize batch generator

        Args:
            handle: Loaded model handle
            batch_size: Maximum batch size
            pad_token_id: Token ID for padding (default: 0)
        """
        if not MLX_AVAILABLE or mx is None:
            raise RuntimeError("MLX not available - cannot use batch generation")

        self.handle = handle
        self.batch_size = batch_size

        # Get pad token ID from tokenizer or use default
        self.pad_token_id = pad_token_id
        if self.pad_token_id is None:
            self.pad_token_id = getattr(
                handle.tokenizer,
                'pad_token_id',
                0  # Default to 0 if no pad token
            )

        # Get EOS token ID
        self.eos_token_id = getattr(handle.tokenizer, 'eos_token_id', 2)

        # Config
        self.config = get_config()

    async def generate_batch(
        self,
        requests: List[BatchRequest],
        emit_token: Callable[[str, int, str], None],
        emit_complete: Callable[[str, Dict[str, Any]], None]
    ) -> None:
        """
        Generate tokens for batch of requests in parallel

        This is the main entry point for batch generation. It tokenizes prompts,
        pads to same length, and generates tokens step-by-step for entire batch.

        Args:
            requests: List of batch requests (max batch_size)
            emit_token: Callback for each generated token (stream_id, token, text)
            emit_complete: Callback when request completes (stream_id, stats)

        Raises:
            GenerationError: If batch generation fails
        """
        if not requests:
            return

        if len(requests) > self.batch_size:
            raise GenerationError(
                self.handle.model_id,
                f"Batch size {len(requests)} exceeds maximum {self.batch_size}"
            )

        try:
            # Run in thread pool to avoid blocking asyncio loop
            await asyncio.to_thread(
                self._generate_batch_sync,
                requests,
                emit_token,
                emit_complete
            )

        except Exception as exc:
            raise GenerationError(
                self.handle.model_id,
                f"Batch generation failed: {exc}"
            ) from exc

    def _generate_batch_sync(
        self,
        requests: List[BatchRequest],
        emit_token: Callable,
        emit_complete: Callable
    ) -> None:
        """
        Synchronous batch generation (runs in thread pool)

        This is where the actual GPU batching happens. We:
        1. Pad all prompts to same length
        2. Create batch tensors
        3. Generate tokens step-by-step for entire batch
        4. Sample per-request with different temperatures
        5. Emit tokens as they're generated
        6. Remove finished requests

        Args:
            requests: Batch requests
            emit_token: Token callback
            emit_complete: Complete callback
        """
        # 1. Tokenize and pad prompts
        batch_input, attention_mask = self._prepare_batch_input(requests)

        # Track active requests
        active_requests = list(requests)

        # 2. Generate tokens step-by-step
        max_tokens = max(req.max_tokens for req in requests)

        for step in range(max_tokens):
            if not active_requests:
                break  # All requests finished

            # 3. Forward pass for entire batch (PARALLEL on GPU)
            try:
                logits = self._forward_batch(batch_input, attention_mask)

            except Exception as exc:
                # Handle generation errors
                for req in active_requests:
                    req.is_finished = True
                    req.finish_reason = 'error'
                    emit_complete(req.stream_id, {
                        'error': str(exc),
                        'tokens_generated': len(req.generated_tokens)
                    })
                raise

            # 4. Sample next token for each request in batch
            next_tokens = self._sample_batch(logits, active_requests)

            # 5. Process tokens for each request
            finished_indices = []
            for i, (req, token_id) in enumerate(zip(active_requests, next_tokens)):
                # Record first token timing
                if req.first_token_at is None:
                    req.first_token_at = time.time()

                # Add to generated tokens
                req.generated_tokens.append(token_id)

                # Decode token to text
                try:
                    token_text = self.handle.tokenizer.decode([token_id])
                    req.generated_text += token_text

                    # Emit token
                    emit_token(req.stream_id, token_id, token_text)

                except Exception as exc:
                    # Decoding error - finish request
                    req.is_finished = True
                    req.finish_reason = 'error'
                    finished_indices.append(i)
                    continue

                # Check if finished
                if token_id == self.eos_token_id:
                    req.is_finished = True
                    req.finish_reason = 'eos'
                    finished_indices.append(i)

                elif len(req.generated_tokens) >= req.max_tokens:
                    req.is_finished = True
                    req.finish_reason = 'length'
                    finished_indices.append(i)

            # 6. Emit completion for finished requests
            for i in finished_indices:
                req = active_requests[i]
                duration = time.time() - req.started_at
                ttft = (req.first_token_at - req.started_at) if req.first_token_at else 0

                emit_complete(req.stream_id, {
                    'finish_reason': req.finish_reason,
                    'tokens_generated': len(req.generated_tokens),
                    'duration_ms': duration * 1000,
                    'ttft_ms': ttft * 1000,
                    'tokens_per_sec': len(req.generated_tokens) / duration if duration > 0 else 0
                })

            # 7. Remove finished requests from batch
            active_requests = [
                req for i, req in enumerate(active_requests)
                if i not in finished_indices
            ]

            # If requests finished, we need to rebuild batch
            if finished_indices and active_requests:
                # Rebuild batch with remaining requests
                batch_input, attention_mask = self._prepare_batch_input(
                    active_requests,
                    include_generated=True  # Include generated tokens
                )

            elif active_requests:
                # Append new tokens to batch input
                next_tokens_tensor = mx.array([[t] for t in next_tokens])
                batch_input = mx.concatenate([batch_input, next_tokens_tensor], axis=1)

                # Update attention mask
                attention_mask = mx.concatenate([
                    attention_mask,
                    mx.ones((len(active_requests), 1))
                ], axis=1)

    def _prepare_batch_input(
        self,
        requests: List[BatchRequest],
        include_generated: bool = False
    ) -> Tuple[mx.array, mx.array]:
        """
        Prepare batch input tensors with padding

        Pads all sequences to same length for batching. Creates attention
        mask to ignore padding tokens.

        Args:
            requests: Batch requests
            include_generated: Include already-generated tokens

        Returns:
            (batch_input, attention_mask)
                batch_input: [batch_size, max_seq_len]
                attention_mask: [batch_size, max_seq_len]
        """
        # Build sequences
        sequences = []
        for req in requests:
            seq = req.prompt_tokens.copy()
            if include_generated:
                seq.extend(req.generated_tokens)
            sequences.append(seq)

        # Find max length
        lengths = [len(seq) for seq in sequences]
        max_length = max(lengths)

        # Pad sequences
        padded_sequences = []
        attention_masks = []

        for seq, length in zip(sequences, lengths):
            pad_length = max_length - length

            # Pad sequence
            padded_seq = seq + [self.pad_token_id] * pad_length
            padded_sequences.append(padded_seq)

            # Create attention mask (1 for real tokens, 0 for padding)
            mask = [1] * length + [0] * pad_length
            attention_masks.append(mask)

        # Convert to MLX arrays
        batch_input = mx.array(padded_sequences, dtype=mx.int32)
        attention_mask = mx.array(attention_masks, dtype=mx.int32)

        return batch_input, attention_mask

    def _forward_batch(
        self,
        batch_input: mx.array,
        attention_mask: mx.array
    ) -> mx.array:
        """
        Run forward pass on batch

        Args:
            batch_input: [batch_size, seq_len]
            attention_mask: [batch_size, seq_len]

        Returns:
            logits: [batch_size, seq_len, vocab_size]
        """
        # Run model forward pass
        # Note: MLX models may not support attention_mask parameter
        # In that case, we rely on padding token embeddings being zero
        try:
            # Try with attention_mask first
            output = self.handle.model(
                batch_input,
                attention_mask=attention_mask
            )
        except TypeError:
            # Model doesn't support attention_mask, use input only
            output = self.handle.model(batch_input)

        return output

    def _sample_batch(
        self,
        logits: mx.array,
        requests: List[BatchRequest]
    ) -> List[int]:
        """
        Sample next token for each request in batch

        Uses per-request temperature and top_p for sampling.

        Args:
            logits: [batch_size, seq_len, vocab_size]
            requests: List of requests (for sampling params)

        Returns:
            next_tokens: List of token IDs (one per request)
        """
        # Get logits for last position
        last_logits = logits[:, -1, :]  # [batch_size, vocab_size]

        next_tokens = []
        for i, req in enumerate(requests):
            # Get logits for this request
            request_logits = last_logits[i]  # [vocab_size]

            # Apply temperature
            if req.temperature > 0:
                request_logits = request_logits / req.temperature

            # Apply top_p sampling
            if req.top_p < 1.0:
                token_id = self._sample_top_p(request_logits, req.top_p)
            else:
                # Standard categorical sampling
                probs = mx.softmax(request_logits, axis=-1)
                token_id = mx.random.categorical(probs, num_samples=1)[0]

            next_tokens.append(int(token_id))

        return next_tokens

    def _sample_top_p(
        self,
        logits: mx.array,
        top_p: float
    ) -> int:
        """
        Sample with nucleus (top-p) sampling

        Args:
            logits: [vocab_size]
            top_p: Cumulative probability threshold

        Returns:
            token_id: Sampled token ID
        """
        # Convert to probabilities
        probs = mx.softmax(logits, axis=-1)

        # Sort probabilities in descending order
        sorted_indices = mx.argsort(probs, axis=-1)[::-1]
        sorted_probs = probs[sorted_indices]

        # Compute cumulative probabilities
        cumsum_probs = mx.cumsum(sorted_probs, axis=-1)

        # Find cutoff index where cumsum exceeds top_p
        # Keep all tokens until we exceed top_p
        mask = cumsum_probs <= top_p

        # Ensure at least one token is kept
        if not mx.any(mask):
            # If nothing passes threshold, keep top token
            mask = mx.zeros_like(mask)
            mask[0] = True

        # Zero out probabilities below threshold
        filtered_probs = mx.where(mask, sorted_probs, 0.0)

        # Renormalize
        filtered_probs = filtered_probs / mx.sum(filtered_probs)

        # Sample from filtered distribution
        token_idx = mx.random.categorical(filtered_probs, num_samples=1)[0]

        # Map back to original token ID
        token_id = sorted_indices[int(token_idx)]

        return int(token_id)


# Helper function to create batch requests from params
def create_batch_request(
    request_id: str,
    params: Dict[str, Any],
    tokenizer: Any
) -> BatchRequest:
    """
    Create BatchRequest from generation parameters

    Args:
        request_id: Unique request ID
        params: Generation parameters (prompt, max_tokens, etc.)
        tokenizer: Tokenizer for encoding prompt

    Returns:
        BatchRequest instance
    """
    config = get_config()

    prompt = params.get('prompt', '')
    prompt_tokens = tokenizer.encode(prompt)

    return BatchRequest(
        request_id=request_id,
        prompt=prompt,
        prompt_tokens=prompt_tokens,
        max_tokens=params.get('max_tokens', config.default_max_tokens),
        temperature=params.get('temperature', 1.0),
        top_p=params.get('top_p', 1.0),
        stream_id=params.get('stream_id', request_id),
        generated_tokens=[],
        generated_text='',
        is_finished=False,
        finish_reason=None,
        started_at=time.time(),
        first_token_at=None,
        timeout_ms=params.get('timeout_ms')  # Week 3: Optional timeout
    )
