#!/usr/bin/env python3
"""
Persistent mlx-engine server for fair vision model benchmarking.
Uses lmstudio-ai/mlx-engine API with vision support.
Loads model once, then processes multiple image+text prompts.
"""
import sys
import json
import os
import base64
from pathlib import Path

# Import HuggingFace download function BEFORE mlx_engine
from huggingface_hub import snapshot_download as hf_snapshot_download

# Add mlx-engine to path
sys.path.insert(0, '/tmp/mlx-engine')

from mlx_engine.generate import load_model, create_generator, tokenize

def resolve_model_path(model_arg):
    """Resolve model path - handles both HF repo names and local paths."""
    if os.path.exists(model_arg):
        return model_arg

    # Try HuggingFace snapshot download
    try:
        sys.stderr.write(f"Downloading model from HuggingFace: {model_arg}\n")
        sys.stderr.flush()
        path = hf_snapshot_download(repo_id=model_arg)
        return path
    except Exception as e:
        raise ValueError(f"Could not find or download model '{model_arg}': {e}")

def load_image_as_base64(image_path):
    """Load image file and convert to base64 string."""
    with open(image_path, 'rb') as f:
        image_data = f.read()
    return base64.b64encode(image_data).decode('utf-8')

def main():
    # Read model name from first line
    model_name = sys.stdin.readline().strip()
    model_path = resolve_model_path(model_name)

    # Load model once using mlx-engine API
    sys.stderr.write(f"Loading vision model with mlx-engine: {model_path}\n")
    sys.stderr.flush()

    try:
        model_kit = load_model(model_path, trust_remote_code=False)
    except Exception as e:
        sys.stderr.write(f"Error loading model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write("mlx-engine vision model loaded, ready for prompts\n")
    sys.stderr.flush()

    # Process prompts from stdin
    while True:
        line = sys.stdin.readline()
        if not line:
            break

        try:
            request = json.loads(line.strip())
            prompt = request['prompt']
            image_path = request['image_path']
            max_tokens = request.get('max_tokens', 100)
            temp = request.get('temp', 0.7)

            # Load image as base64
            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Image not found: {image_path}")

            image_b64 = load_image_as_base64(image_path)

            # Tokenize prompt using mlx-engine
            prompt_tokens = tokenize(model_kit, prompt)

            # Generate response using mlx-engine with images
            generator = create_generator(
                model_kit,
                prompt_tokens,
                images_b64=[image_b64],
                max_tokens=max_tokens,
                temp=temp,
            )

            # Collect tokens
            full_text = ""
            token_count = 0

            for generation_result in generator:
                full_text += generation_result.text
                token_count += len(generation_result.tokens)

            # Send response
            result = {
                'response': full_text,
                'tokens': token_count
            }
            print(json.dumps(result), flush=True)

        except Exception as e:
            import traceback
            sys.stderr.write(f"Error: {e}\n{traceback.format_exc()}\n")
            sys.stderr.flush()
            error = {
                'error': str(e),
                'tokens': 0
            }
            print(json.dumps(error), flush=True)

if __name__ == '__main__':
    main()
