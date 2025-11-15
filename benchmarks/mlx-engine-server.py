#!/usr/bin/env python3
"""
Persistent mlx-engine server for fair benchmarking.
Uses lmstudio-ai/mlx-engine API (not raw mlx_lm).
Loads model once, then processes multiple prompts.
"""
import sys
import json
import os
from pathlib import Path

# Import HuggingFace download function BEFORE mlx_engine (which overrides it)
from huggingface_hub import snapshot_download as hf_snapshot_download

# Add mlx-engine to path
sys.path.insert(0, '/tmp/mlx-engine')

from mlx_engine.generate import load_model, create_generator, tokenize
import mlx.core as mx

def resolve_model_path(model_arg):
    """Resolve model path - handles both HF repo names and local paths."""
    # If it's a full path or local file, return as-is
    if os.path.exists(model_arg):
        return model_arg

    # Check common local directories
    local_paths = [
        os.path.expanduser("~/.lmstudio/models"),
        os.path.expanduser("~/.cache/lm-studio/models"),
    ]

    for path in local_paths:
        full_path = os.path.join(path, model_arg)
        if os.path.exists(full_path):
            return full_path

    # Try HuggingFace snapshot download
    try:
        sys.stderr.write(f"Downloading model from HuggingFace: {model_arg}\n")
        sys.stderr.flush()
        path = hf_snapshot_download(repo_id=model_arg)
        return path
    except Exception as e:
        raise ValueError(f"Could not find or download model '{model_arg}': {e}")

def main():
    # Read model name from first line
    model_name = sys.stdin.readline().strip()

    # Resolve model path
    model_path = resolve_model_path(model_name)

    # Clear MLX cache before loading model to prevent memory accumulation
    try:
        # Try new API first (MLX 0.29+)
        if hasattr(mx, 'clear_cache'):
            mx.clear_cache()
        # Fallback to old API
        elif hasattr(mx.metal, 'clear_cache'):
            mx.metal.clear_cache()
        else:
            # Manual garbage collection as last resort
            import gc
            gc.collect()
        sys.stderr.write("MLX cache cleared before model load\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"Warning: Failed to clear MLX cache: {e}\n")
        sys.stderr.flush()

    # Load model once using mlx-engine API
    sys.stderr.write(f"Loading model with mlx-engine: {model_path}\n")
    sys.stderr.flush()

    try:
        load_kwargs = {"trust_remote_code": False}
        model_kit = load_model(model_path, **load_kwargs)
    except Exception as e:
        sys.stderr.write(f"ERROR: Failed to load model: {type(e).__name__}: {str(e)}\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write("mlx-engine model loaded, ready for prompts\n")
    sys.stderr.flush()

    # Process prompts from stdin
    while True:
        line = sys.stdin.readline()
        if not line:
            break

        try:
            request = json.loads(line.strip())
            prompt = request['prompt']
            max_tokens = request.get('max_tokens', 100)
            temp = request.get('temp', 0.7)

            # Tokenize prompt using mlx-engine
            prompt_tokens = tokenize(model_kit, prompt)

            # Generate response using mlx-engine
            generator = create_generator(
                model_kit,
                prompt_tokens,
                max_tokens=max_tokens,
                temp=temp,
            )

            # Collect tokens
            full_text = ""
            token_count = 0

            for generation_result in generator:
                full_text += generation_result.text
                # generation_result.tokens is a list of Token objects
                token_count += len(generation_result.tokens)

            # Send response
            result = {
                'response': full_text,
                'tokens': token_count
            }
            print(json.dumps(result), flush=True)

        except Exception as e:
            error = {
                'error': str(e),
                'tokens': 0
            }
            print(json.dumps(error), flush=True)

if __name__ == '__main__':
    main()
