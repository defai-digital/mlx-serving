#!/usr/bin/env python3
"""
Persistent mlx-vlm server for fair vision model benchmarking.
Loads model once, then processes multiple image+text prompts.
"""
import sys
import json
import os
from pathlib import Path
from PIL import Image

# Import HuggingFace download function
from huggingface_hub import snapshot_download as hf_snapshot_download

# Import mlx-vlm
try:
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config
except ImportError:
    print("Error: mlx-vlm not installed. Install with: pip install mlx-vlm", file=sys.stderr)
    sys.exit(1)

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

def main():
    # Read model name from first line
    model_name = sys.stdin.readline().strip()
    model_path = resolve_model_path(model_name)

    # Load model once using mlx-vlm API
    sys.stderr.write(f"Loading vision model with mlx-vlm: {model_path}\n")
    sys.stderr.flush()

    try:
        model, processor = load(model_path)
        config = load_config(model_path)
    except Exception as e:
        sys.stderr.write(f"Error loading model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write("mlx-vlm model loaded, ready for prompts\n")
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

            # Load image
            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Image not found: {image_path}")

            image = Image.open(image_path)

            # Format prompt with chat template
            formatted_prompt = apply_chat_template(
                processor, config, prompt, num_images=1
            )

            # Generate response using mlx-vlm
            output = generate(
                model,
                processor,
                image,
                formatted_prompt,
                max_tokens=max_tokens,
                temp=temp,
                verbose=False
            )

            # Count tokens (approximate)
            token_count = len(output.split())

            # Send response
            result = {
                'response': output,
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
