"""
mlx-engine Benchmark Script

Measures performance metrics for LM Studio's mlx-engine
"""

import time
import json
import sys
from pathlib import Path
from typing import Dict, List, Any
import psutil

try:
    from mlx_engine import MLXEngine
except ImportError:
    print("ERROR: mlx-engine not installed")
    print("Install with: pip install mlx-engine")
    sys.exit(1)


def measure_memory() -> float:
    """Get current memory usage in MB"""
    process = psutil.Process()
    return process.memory_info().rss / 1024 / 1024  # MB


def run_benchmark(
    model_path: str,
    prompt: str,
    max_tokens: int
) -> Dict[str, Any]:
    """Run a single benchmark test"""

    mem_start = measure_memory()
    mem_peak = mem_start
    first_token_time = 0
    token_count = 0
    error = None
    success = False

    start_time = time.time()

    try:
        # Initialize engine
        print(f"[mlx-engine] Loading model: {model_path}")
        engine = MLXEngine(model_path)
        print(f"[mlx-engine] Model loaded")

        # Generate tokens
        gen_start_time = time.time()
        first_token = True

        for token in engine.generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=0.0,  # Deterministic
        ):
            if first_token:
                first_token_time = (time.time() - gen_start_time) * 1000  # ms
                first_token = False

            token_count += 1

            # Update peak memory
            current_mem = measure_memory()
            if current_mem > mem_peak:
                mem_peak = current_mem

        success = True

    except Exception as e:
        error = str(e)
        print(f"[mlx-engine] Error: {error}")

    total_time = (time.time() - start_time) * 1000  # ms
    mem_end = measure_memory()

    return {
        "framework": "mlx-engine",
        "model": model_path,
        "prompt": prompt,
        "maxTokens": max_tokens,
        "timeToFirstToken": first_token_time,
        "tokensPerSecond": token_count / (total_time / 1000) if token_count > 0 else 0,
        "totalTime": total_time,
        "totalTokens": token_count,
        "memoryUsage": {
            "start": mem_start,
            "peak": mem_peak,
            "end": mem_end
        },
        "success": success,
        "error": error
    }


def main():
    print("=== mlx-engine Benchmark ===\n")

    test_cases = [
        {
            "model": "./models/llama-3.2-3b-instruct",
            "prompt": "Write a short story about a robot learning to code.",
            "maxTokens": 100
        },
        {
            "model": "./models/llama-3.2-3b-instruct",
            "prompt": "Explain quantum computing in simple terms.",
            "maxTokens": 200
        },
        {
            "model": "./models/llama-3.2-3b-instruct",
            "prompt": "What is the meaning of life?",
            "maxTokens": 50
        }
    ]

    results = []

    for test_case in test_cases:
        print(f"\nTest: {test_case['prompt'][:50]}...")
        print(f"Model: {test_case['model']}")
        print(f"Max Tokens: {test_case['maxTokens']}\n")

        result = run_benchmark(
            test_case["model"],
            test_case["prompt"],
            test_case["maxTokens"]
        )

        results.append(result)

        print("Results:")
        print(f"  - Time to First Token: {result['timeToFirstToken']:.2f}ms")
        print(f"  - Tokens/Second: {result['tokensPerSecond']:.2f}")
        print(f"  - Total Time: {result['totalTime']:.2f}ms")
        print(f"  - Total Tokens: {result['totalTokens']}")
        print(f"  - Memory (Start/Peak/End): {result['memoryUsage']['start']:.1f}MB / {result['memoryUsage']['peak']:.1f}MB / {result['memoryUsage']['end']:.1f}MB")
        print(f"  - Success: {result['success']}")

    # Save results
    Path("./benchmarks/results").mkdir(parents=True, exist_ok=True)
    with open("./benchmarks/results/mlx-engine-results.json", "w") as f:
        json.dump(results, f, indent=2)

    print("\n=== Benchmark Complete ===")
    print("Results saved to: ./benchmarks/results/mlx-engine-results.json")

    # Summary
    avg_ttft = sum(r["timeToFirstToken"] for r in results) / len(results)
    avg_tps = sum(r["tokensPerSecond"] for r in results) / len(results)
    success_rate = (sum(1 for r in results if r["success"]) / len(results)) * 100

    print("\nSummary:")
    print(f"  - Average TTFT: {avg_ttft:.2f}ms")
    print(f"  - Average Tokens/Second: {avg_tps:.2f}")
    print(f"  - Success Rate: {success_rate:.1f}%")


if __name__ == "__main__":
    main()
