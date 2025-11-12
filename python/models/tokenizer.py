"""
Tokenizer wrappers - Simple encoding/decoding operations

Responsibilities:
- Tokenize text to token IDs
- Detokenize token IDs to text
- Count tokens for diagnostics
"""

from typing import List, Dict, Any
from dataclasses import dataclass
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from models.loader import ModelHandle
from errors import TokenizerError


@dataclass
class TokenizeResult:
    """Result of tokenization operation"""

    tokens: List[int]
    token_strings: List[str]


def _get_tokenizer(handle: ModelHandle):
    """
    Get tokenizer from ModelHandle with validation

    Args:
        handle: ModelHandle to extract tokenizer from

    Returns:
        Tokenizer instance

    Raises:
        TokenizerError: If tokenizer is unavailable
    """
    tokenizer = handle.tokenizer
    if tokenizer is None:
        raise TokenizerError(handle.model_id, "Tokenizer unavailable")
    return tokenizer


def tokenize(handle: ModelHandle, text: str, add_special_tokens: bool = True) -> TokenizeResult:
    """
    Tokenize text using model's tokenizer

    Args:
        handle: Loaded ModelHandle
        text: Input text to tokenize
        add_special_tokens: Whether to add BOS/EOS tokens

    Returns:
        TokenizeResult with token IDs and string representations

    Raises:
        TokenizerError: If tokenization fails
    """
    tokenizer = _get_tokenizer(handle)

    try:
        # Encode text to token IDs
        token_ids = tokenizer.encode(text, add_special_tokens=add_special_tokens)

        # Convert IDs to string representations for debugging
        try:
            token_strings = tokenizer.convert_ids_to_tokens(token_ids)
        except AttributeError:
            # Fallback if tokenizer doesn't have convert_ids_to_tokens
            token_strings = [f"<token_{tid}>" for tid in token_ids]

        return TokenizeResult(tokens=token_ids, token_strings=token_strings)

    except TokenizerError:
        # Re-raise our own errors
        raise
    except Exception as exc:
        raise TokenizerError(handle.model_id, f"encode failed: {exc}") from exc


def detokenize(handle: ModelHandle, token_ids: List[int]) -> str:
    """
    Detokenize token IDs to text

    Args:
        handle: Loaded ModelHandle
        token_ids: List of token IDs

    Returns:
        Decoded text string

    Raises:
        TokenizerError: If detokenization fails
    """
    tokenizer = _get_tokenizer(handle)

    try:
        # Decode token IDs to text
        # skip_special_tokens=False to preserve all tokens
        # clean_up_tokenization_spaces=False to preserve exact formatting
        text = tokenizer.decode(token_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False)

        # Note: HuggingFace tokenizers (used by MLX) return valid Unicode strings in Python 3.
        # UnicodeDecodeError is extremely rare in this context and typically indicates
        # a deeper issue with the tokenizer or model configuration.
        return text

    except TokenizerError:
        # Re-raise our own errors
        raise
    except Exception as exc:
        raise TokenizerError(handle.model_id, f"decode failed: {exc}") from exc


def count_tokens(handle: ModelHandle, text: str) -> int:
    """
    Count tokens in text (for diagnostics)

    Args:
        handle: Loaded ModelHandle
        text: Input text

    Returns:
        Number of tokens

    Raises:
        TokenizerError: If token counting fails
    """
    tokenizer = _get_tokenizer(handle)

    try:
        # Encode without special tokens to get raw count
        token_ids = tokenizer.encode(text, add_special_tokens=False)
        return len(token_ids)

    except TokenizerError:
        # Re-raise our own errors
        raise
    except Exception as exc:
        raise TokenizerError(handle.model_id, f"count failed: {exc}") from exc


def get_special_tokens(handle: ModelHandle) -> Dict[str, Any]:
    """
    Get special tokens from tokenizer

    Args:
        handle: Loaded ModelHandle

    Returns:
        Dictionary of special tokens (bos, eos, pad, unk, etc.)
    """
    tokenizer = _get_tokenizer(handle)

    special_tokens = {}

    # Common special token attributes
    for attr in ("bos_token", "eos_token", "pad_token", "unk_token", "sep_token", "cls_token"):
        value = getattr(tokenizer, attr, None)
        if value is not None:
            special_tokens[attr] = value

    # Token IDs
    for attr in ("bos_token_id", "eos_token_id", "pad_token_id", "unk_token_id"):
        value = getattr(tokenizer, attr, None)
        if value is not None:
            special_tokens[attr] = value

    return special_tokens
