# mlx-serving Benchmarking Guide

This directory contains tools and scripts for fair benchmarking of mlx-serving against mlx-engine.

---

## Quick Start

### 1. One-Time Setup (Install mlx-engine)

```bash
bash scripts/setup-mlx-engine-benchmark.sh
```

This script will:
- ✅ Check for Python 3.11
- ✅ Create a Python venv at `.mlx-engine-venv/`
- ✅ Clone mlx-engine to `/tmp/mlx-engine`
- ✅ Install all dependencies (mlx, mlx-lm, mlx-vlm, transformers, etc.)
- ✅ Verify the installation

**Time**: ~5-10 minutes (depending on your internet speed)

### 2. Run Benchmarks

```bash
# Small models first (recommended for quick results)
pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1-small-first.yaml

# All models (comprehensive, takes hours)
pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1.yaml

# Large models only
pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1-large-only.yaml
```

---

## Benchmark Configurations

### Available Configurations

| Config File | Models | Time | Use Case |
|------------|--------|------|----------|
| `comprehensive-benchmark-v1.1.1-small-first.yaml` | 13 models (0.5B→72B) | ~2-4 hours | Recommended for fresh benchmarks |
| `comprehensive-benchmark-v1.1.1.yaml` | All models | ~4-6 hours | Complete analysis |
| `comprehensive-benchmark-v1.1.1-large-only.yaml` | Large models only (70B+) | ~1-2 hours | Focus on large models |

### Model Sizes Covered

- **Very Small**: 0.5B - 1.5B (Qwen2.5, Llama-3.2)
- **Small**: 3B - 4B (Llama-3.2-3B, Phi-3-mini)
- **Medium**: 7B - 8B (Qwen2.5-7B, Llama-3.1-8B)
- **Large**: 14B - 47B (Qwen2.5-14B/32B, Mixtral-8x7B)
- **Very Large**: 70B - 72B (Llama-3.1-70B, Qwen2.5-72B)

---

## How It Works

### Fair Comparison Methodology

Both engines use identical methodology:

```
1. Load model ONCE (warm start)
2. Run N questions through the loaded model
3. Measure: throughput, latency, success rate
4. Unload model
5. Repeat for next model
```

This ensures:
- ✅ No cold-start penalties
- ✅ Real-world persistent server performance
- ✅ Fair comparison (both engines optimized)

### Metrics Collected

For each model, we measure:

| Metric | Description |
|--------|-------------|
| **Throughput** | Tokens per second (tok/s) |
| **Latency** | Average time per request (ms) |
| **Success Rate** | Percentage of successful completions |
| **Total Time** | Wall-clock time for all questions |

---

## Understanding Results

### Output Format

Benchmark results are displayed in markdown tables:

```markdown
| Model | Size | mlx-engine | mlx-serving | Difference | Winner |
|-------|------|------------|-------------|------------|--------|
| Qwen2.5-7B | 7B | 45.2 tok/s | 47.1 tok/s | +4.2% ✅ | mlx-serving |
```

### Result Files

Results are saved to:
```
benchmarks/results/
├── benchmark-2025-11-15-12-30-45.json   # Raw data
└── benchmark-2025-11-15-12-30-45.md     # Markdown report
```

### Interpreting Results

**Performance Patterns by Model Size:**

- **0.5B - 14B**: mlx-serving typically shows advantages
  - Better IPC batching
  - Persistent Python process (no startup overhead)
  - Optimized token buffering

- **30B - 47B**: Competitive, usually within ±3%
  - Both engines well-optimized
  - Performance depends on specific model architecture

- **70B+**: mlx-engine may have slight edge
  - Lower overhead for very large models
  - Direct mlx-lm usage

**Success Rate:**
- Both engines should achieve >98% success rate
- Lower rates indicate timeout or memory issues

---

## Troubleshooting

### Setup Issues

**Problem**: `Python 3.11 not found`
```bash
# Install Python 3.11
brew install python@3.11
```

**Problem**: `mlx-engine repository not found`
```bash
# Manually clone
git clone https://github.com/lmstudio-ai/mlx-engine.git /tmp/mlx-engine
```

**Problem**: `Import Error: mlx_engine.generate`
```bash
# Reinstall dependencies
.mlx-engine-venv/bin/pip install -r /tmp/mlx-engine/requirements.txt
```

### Benchmark Issues

**Problem**: Model loading timeout (very large models)

The benchmark has a 10-minute timeout for model loading. For 70B+ models:
- ✅ Normal: 2-5 minutes to load
- ⚠️ Warning: 5-8 minutes (memory pressure)
- ❌ Timeout: >10 minutes (insufficient RAM)

**Recommendation**: Close other applications when benchmarking 70B+ models.

**Problem**: Out of Memory

If you see `MemoryError` or system freezes:
1. Skip very large models (70B+)
2. Use `comprehensive-benchmark-v1.1.1-small-first.yaml`
3. Benchmark one size category at a time

**Problem**: Inconsistent Results

For consistent benchmarks:
- ✅ Close other apps (especially browsers)
- ✅ Disable background sync (Time Machine, iCloud)
- ✅ Run when machine is cool (not thermally throttled)
- ✅ Plug in (not on battery power)

---

## Customizing Benchmarks

### Create Custom Configuration

```yaml
# my-benchmark.yaml
benchmark:
  max_tokens: 100          # Tokens per completion
  temperature: 0.7         # Randomness (0-1)
  timeout_ms: 300000       # 5 minutes per request

models:
  - name: mlx-community/Qwen2.5-7B-Instruct-4bit
    size: 7B
    questions: 10          # Number of test questions
    cycles: 1              # Repetitions
    enabled: true

questions:
  - "What is machine learning?"
  - "Explain quantum computing."
  - "Write a Python function to sort a list."
```

Run your custom benchmark:
```bash
pnpm run bench:llm my-benchmark.yaml
```

### Benchmark Parameters

| Parameter | Description | Default | Recommended Range |
|-----------|-------------|---------|-------------------|
| `max_tokens` | Output length | 100 | 50-200 for speed, 500+ for quality |
| `temperature` | Randomness | 0.7 | 0.0 for deterministic, 1.0 for creative |
| `timeout_ms` | Request timeout | 300000 (5min) | 60000-600000 |
| `questions` | Test questions | 5 | 3-10 per model |
| `cycles` | Repetitions | 1 | 1-3 for averaging |

---

## Best Practices

### Running Production Benchmarks

1. **Warm up the system** (run one small model first)
2. **Start with small models** (use `-small-first` config)
3. **Monitor resources** (Activity Monitor for memory/CPU)
4. **Save results** (copy JSON files for comparison)
5. **Document conditions** (note system state, temperature)

### Comparing Versions

To compare mlx-serving versions:

```bash
# Benchmark current version
pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1-small-first.yaml
cp benchmarks/results/latest.json benchmarks/results/v1.2.0-baseline.json

# Switch to new version, then benchmark again
pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1-small-first.yaml

# Compare
diff benchmarks/results/v1.2.0-baseline.json benchmarks/results/latest.json
```

---

## Architecture

### Benchmark Components

```
benchmarks/
├── compare-engines-fair.ts         # Main benchmark orchestrator
├── mlx-engine-server.py            # mlx-engine wrapper
├── comprehensive-benchmark-*.yaml  # Configurations
└── results/                        # Output directory
```

### How the Benchmark Works

```typescript
// Simplified flow
for each model in config:
  // mlx-engine test
  start mlx-engine server
  load model
  for each question:
    send request
    measure performance
  stop server

  // mlx-serving test
  start mlx-serving
  load model
  for each question:
    send request
    measure performance
  stop server

  compare results
```

---

## Performance Expectations

### Typical Results (M3 Max, 128GB RAM)

| Model Size | mlx-engine | mlx-serving | Difference |
|------------|------------|-------------|------------|
| 0.5B - 1.5B | ~200 tok/s | ~210 tok/s | +5% |
| 3B - 4B | ~150 tok/s | ~155 tok/s | +3% |
| 7B - 8B | ~90 tok/s | ~92 tok/s | +2% |
| 14B | ~50 tok/s | ~51 tok/s | +2% |
| 30B - 32B | ~20 tok/s | ~20 tok/s | parity |
| 47B | ~13 tok/s | ~13 tok/s | parity |
| 70B - 72B | ~8 tok/s | ~8 tok/s | parity |

*Note: Actual results vary by specific model and hardware*

---

## Vision Model Benchmarks

For vision-language models, use:

```bash
pnpm run bench:vision
```

See `compare-vision-fair.ts` for vision-specific benchmarking.

---

## Contributing

### Adding New Models

1. Edit the YAML configuration
2. Add model to the `models` array
3. Ensure model is available on HuggingFace
4. Test with a small number of questions first

### Reporting Issues

If you encounter benchmark failures:

1. Check logs in `benchmarks/results/`
2. Verify mlx-engine setup: `bash scripts/setup-mlx-engine-benchmark.sh`
3. Report with:
   - Model name and size
   - Error message
   - System specs (RAM, macOS version)
   - Benchmark config used

---

## FAQ

**Q: How long does a full benchmark take?**
A: 2-6 hours depending on configuration and model availability (cached vs downloaded).

**Q: Do I need to download models first?**
A: No, both engines will auto-download from HuggingFace if needed.

**Q: Can I benchmark on battery?**
A: Not recommended - performance will be throttled. Use AC power.

**Q: Why does mlx-engine sometimes show better numbers?**
A: For very large models (70B+), mlx-engine's lower overhead can provide slight advantages. mlx-serving optimizes for small-to-medium models and persistent workloads.

**Q: Are the benchmarks fair?**
A: Yes. Both engines:
- Load model once (no cold starts)
- Use same test questions
- Run with same parameters
- Measure same metrics

**Q: Can I compare against raw mlx-lm?**
A: mlx-engine IS mlx-lm (it's a wrapper). Comparing against mlx-engine is comparing against mlx-lm.

---

## Version History

- **v1.2.0**: Current benchmarks (Concurrency Revamp)
- **v1.1.1**: Added comprehensive model coverage (0.5B-72B)
- **v1.1.0**: Initial fair benchmark implementation
- **v1.0.9**: Phase 2 optimizations baseline

---

**Last Updated**: 2025-11-15
**Benchmark Version**: 1.2.0
**Compatible with**: mlx-serving v1.2.0+
