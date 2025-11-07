#!/usr/bin/env python3
"""
JSON Schema Example - Basic structured output generation

This example demonstrates how to use JSON schema to generate
structured user profiles with guaranteed format compliance.

Requirements:
- kr-mlx-lm Python environment
- outlines >= 0.0.40
- A loaded text model (non-vision)

Usage:
    .kr-mlx-venv/bin/python examples/structured/json_schema_example.py
"""

import asyncio
import json
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../python'))

from runtime import Runtime


# Define JSON schema for user profile
USER_PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {
            "type": "string",
            "description": "Full name of the user"
        },
        "age": {
            "type": "integer",
            "minimum": 0,
            "maximum": 150,
            "description": "Age in years"
        },
        "email": {
            "type": "string",
            "format": "email",
            "description": "Email address"
        },
        "role": {
            "type": "string",
            "enum": ["admin", "user", "guest"],
            "description": "User role"
        },
        "active": {
            "type": "boolean",
            "description": "Whether user account is active"
        }
    },
    "required": ["name", "age", "email"]
}


async def generate_user_profile(runtime: Runtime, prompt: str):
    """
    Generate a user profile matching the schema.

    Args:
        runtime: Runtime instance with loaded model
        prompt: Description of the user to generate

    Returns:
        dict: Generated user profile
    """
    print(f"\n{'='*60}")
    print(f"Prompt: {prompt}")
    print(f"{'='*60}\n")

    # Prepare generation parameters
    params = {
        "prompt": prompt,
        "stream_id": "user_profile_stream",
        "max_tokens": 200,
        "temperature": 0.3,  # Lower temperature for more consistent output
        "guidance": {
            "mode": "json_schema",
            "schema": USER_PROFILE_SCHEMA
        }
    }

    # Generate with schema
    output = ""
    async for chunk in runtime._generate_stream(params):
        if chunk.get("type") == "chunk":
            token = chunk.get("token", "")
            output += token
            print(token, end="", flush=True)

    print("\n")

    # Parse and validate output
    try:
        user_data = json.loads(output)
        print(f"{'='*60}")
        print("Generated User Profile:")
        print(f"{'='*60}")
        print(json.dumps(user_data, indent=2))
        return user_data
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON output: {e}")
        print(f"Raw output: {output}")
        return None


async def main():
    """Main example function"""
    print("JSON Schema Example - User Profile Generation")
    print("=" * 60)

    # Initialize runtime
    runtime = Runtime()

    # Model configuration - use a local or HuggingFace model
    # Adjust path based on your setup
    model_path = "./models/llama-3.2-3b-instruct"  # Local model
    # Or use HuggingFace model:
    # model_path = "meta-llama/Llama-3.2-3B-Instruct"

    print(f"\nLoading model: {model_path}")

    try:
        # Load model
        load_result = await runtime.load_model({
            "model": model_path,
            "revision": "main"
        })
        print(f"Model loaded: {load_result['model_id']}")

        # Example 1: Generate admin user
        print("\n" + "=" * 60)
        print("Example 1: Generate Admin User")
        print("=" * 60)

        await generate_user_profile(
            runtime,
            "Generate a user profile for Alice Smith, a 28-year-old admin. Email: alice@example.com"
        )

        # Example 2: Generate regular user
        print("\n" + "=" * 60)
        print("Example 2: Generate Regular User")
        print("=" * 60)

        await generate_user_profile(
            runtime,
            "Create a user profile for Bob Johnson, age 35, regular user role, email bob.j@company.org"
        )

        # Example 3: Generate guest user
        print("\n" + "=" * 60)
        print("Example 3: Generate Guest User")
        print("=" * 60)

        await generate_user_profile(
            runtime,
            "Make a guest user profile: Charlie Brown, 42 years old, charlie.brown@mail.com"
        )

        print("\n" + "=" * 60)
        print("Example completed successfully!")
        print("=" * 60)

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

    finally:
        # Cleanup
        print("\nCleaning up...")
        await runtime.shutdown()


if __name__ == "__main__":
    # Run the example
    asyncio.run(main())
