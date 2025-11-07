#!/usr/bin/env python3
"""
Example: Original mlx-engine code (Python)

This shows how users would write code using the original mlx-engine library.
This file is for reference only and cannot be run in kr-mlx-lm.
"""

from mlx_engine import Engine

# Create engine
engine = Engine()

# Load model with snake_case parameters
model = engine.load_model(
    model='llama-3.1-8b-instruct',
    max_tokens=512,
    temperature=0.7,
    top_p=0.9,
    repetition_penalty=1.1
)

# Generate text with snake_case parameters
print("Generating text...")
for chunk in engine.create_generator(
    model='llama-3.1-8b-instruct',
    prompt='Hello, how are you?',
    max_tokens=100,
    temperature=0.7,
    stream=True
):
    if 'token' in chunk:
        print(chunk['token'], end='', flush=True)

print("\n\nTokenization example:")
result = engine.tokenize(
    model='llama-3.1-8b-instruct',
    text='Hello, world!',
    add_bos=True
)
print(f"Tokens: {result['tokens']}")
print(f"Token count: {len(result['tokens'])}")

# Cleanup
engine.shutdown()
