# Flexible Benchmark Tool

A powerful CLI tool for benchmarking **any MLX model** with **any number of questions** against both `mlx-serving` and `mlx-engine`.

## Features

✅ **Flexible Model Selection** - Test any HuggingFace MLX model
✅ **Customizable Question Count** - From 1 to 10,000+ questions
✅ **Multiple Comparison Modes** - Test mlx-serving only, mlx-engine only, or both
✅ **Diverse Question Generation** - Automatic generation of varied prompts across 90+ topics
✅ **Comprehensive Metrics** - TTFT, latency, throughput, P50/P95/P99 percentiles
✅ **JSON Output** - Export results for further analysis
✅ **Progress Tracking** - Real-time progress bars and status updates
✅ **Statistical Analysis** - Mean, median, stddev, percentiles

---

## Quick Start

### Basic Usage

```bash
# Quick test with 10 questions (mlx-serving only)
npm run bench:flexible -- -q 10

# Or using tsx directly
tsx benchmarks/flexible-benchmark.ts -q 10
```

### Compare Both Engines

```bash
# Benchmark gemma-2-27b-it-4bit with 200 questions
tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --compare both

# Short form
tsx benchmarks/flexible-benchmark.ts -m gemma-2-27b-it-4bit -q 200 -c both
```

---

## Command-Line Options

### Required Options

None! All options have sensible defaults.

### Optional Arguments

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--model` | `-m` | HuggingFace model ID | `mlx-community/Llama-3.2-3B-Instruct-4bit` |
| `--questions` | `-q` | Number of questions to test | `100` |
| `--max-tokens` | | Maximum tokens per generation | `100` |
| `--temperature` | `-t` | Temperature for generation (0.0-2.0) | `0.7` |
| `--top-p` | | Top-p sampling parameter | (none) |
| `--compare` | `-c` | Mode: `mlx-serving`, `mlx-engine`, or `both` | `mlx-serving` |
| `--output` | `-o` | Output JSON file path | `results/benchmark-<timestamp>.json` |
| `--verbose` | `-v` | Enable verbose output | `false` |
| `--sequential` | | Sequential execution (vs concurrent) | `true` |
| `--help` | `-h` | Show help message | |

---

## Examples

### 1. Quick Test (10 Questions)

```bash
tsx benchmarks/flexible-benchmark.ts -q 10
```

**Output:**
```
✓ Generated 10 questions
🚀 Benchmarking mlx-serving
✓ Model loaded in 1.2s
[██████████████████████████████████████████] 100% (10/10)
✓ Completed 10/10 requests

═══════════════════════════════════════════
            BENCHMARK RESULTS
═══════════════════════════════════════════

mlx-serving Results:
  Total Time:             12.5s
  Total Tokens:           987
  Overall Throughput:     78.96 tokens/sec
  Mean Latency:           1,245.6ms
  Mean TTFT:              234.5ms
  ...
```

### 2. Gemma 2 27B Benchmark (200 Questions)

```bash
tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --compare both \
  --output results/gemma-27b-200q.json
```

**Use Case:** Compare mlx-serving vs mlx-engine performance on a large model.

### 3. High-Temperature Creative Test

```bash
tsx benchmarks/flexible-benchmark.ts \
  -q 50 \
  --max-tokens 200 \
  --temperature 0.9 \
  --top-p 0.95 \
  --verbose
```

**Use Case:** Test creative generation with higher temperature and longer outputs.

### 4. Quick Comparison (Both Engines, 50 Questions)

```bash
tsx benchmarks/flexible-benchmark.ts -q 50 -c both
```

**Use Case:** Fast comparison between engines without long wait times.

### 5. Stress Test (1000 Questions)

```bash
tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen-2.5-7B-Instruct-4bit" \
  --questions 1000 \
  --compare mlx-serving \
  --output results/qwen-stress-test.json
```

**Use Case:** Stress test mlx-serving with high load.

### 6. Multiple Models Comparison

```bash
# Run benchmarks for different models
for model in \
  "mlx-community/Llama-3.2-3B-Instruct-4bit" \
  "mlx-community/gemma-2-9b-it-4bit" \
  "mlx-community/Qwen-2.5-7B-Instruct-4bit"; do

  echo "Benchmarking $model..."
  tsx benchmarks/flexible-benchmark.ts \
    -m "$model" \
    -q 100 \
    -c both \
    -o "results/$(basename $model)-100q.json"
done
```

**Use Case:** Compare performance across different model architectures.

---

## Question Generation

The tool automatically generates diverse questions across **90+ topics** in 5 categories:

### Question Templates (25 types)

**Factual Questions:**
- "What is {}?"
- "Explain {} in simple terms."
- "Describe the key features of {}."
- "What are the benefits of using {}?"
- "How does {} work?"

**Creative Prompts:**
- "Write a short poem about {}."
- "Create a story involving {}."
- "Describe {} from the perspective of a child."
- "Explain {} using an analogy."

**Technical Questions:**
- "What are the technical challenges of {}?"
- "How is {} implemented?"
- "What algorithms are used in {}?"

**Practical Questions:**
- "How do I get started with {}?"
- "What tools are needed for {}?"
- "What are best practices for {}?"

### Topics (90+ subjects)

**Technology (20):** quantum computing, AI, machine learning, blockchain, cloud computing, etc.
**Science (18):** quantum mechanics, genetics, CRISPR, nanotechnology, particle physics, etc.
**Energy & Environment (16):** renewable energy, solar power, climate change, carbon capture, etc.
**Data & Analytics (11):** data science, big data, predictive modeling, time series analysis, etc.
**Security & Privacy (10):** cybersecurity, encryption, zero-knowledge proofs, threat modeling, etc.
**Emerging Tech (15):** AR/VR, metaverse, brain-computer interfaces, autonomous vehicles, etc.

### Example Generated Questions

```
1. "What is quantum computing?"
2. "Explain artificial intelligence in simple terms."
3. "Write a short poem about machine learning."
4. "What are the benefits of using deep learning?"
5. "How does neural networks work?"
6. "Compare natural language processing with traditional approaches."
...
```

---

## Output Format

### Console Output

```
═══════════════════════════════════════════════════════════════
                    BENCHMARK RESULTS
═══════════════════════════════════════════════════════════════

Configuration:
  Model:          mlx-community/gemma-2-27b-it-4bit
  Questions:      200
  Max Tokens:     100
  Temperature:    0.7
  Compare Mode:   both
  Timestamp:      2025-01-07T16:30:00.000Z

System Info:
  Platform:       darwin arm64
  Node.js:        v22.0.0
  CPUs:           10
  Memory:         65536 MB

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
mlx-serving Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Model Load Time:        1.23s
  Total Time:             125.6s
  Total Tokens:           19,847
  Completed:              200/200
  Success Rate:           100.0%
  Overall Throughput:     158.03 tokens/sec

  Latency Statistics (ms):
    Mean:                 628.0
    Median (P50):         615.3
    P95:                  892.5
    P99:                  1,045.2
    Min/Max:              412.1 / 1,234.5

  TTFT Statistics (ms):
    Mean:                 145.6
    Median (P50):         142.3
    P95:                  198.7

  Throughput Statistics (tokens/sec):
    Mean:                 159.42
    Median (P50):         162.78
    P95:                  243.12

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
mlx-engine Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Model Load Time:        1.45s
  Total Time:             138.9s
  Total Tokens:           19,756
  Completed:              200/200
  Success Rate:           100.0%
  Overall Throughput:     142.19 tokens/sec
  ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Comparison:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Throughput Speedup:     1.12x
  TTFT Speedup:           1.03x
  Latency Speedup:        1.09x
  Winner:                 MLX-SERVING 🏆

═══════════════════════════════════════════════════════════════

✓ Results saved to: results/benchmark-1736267400000.json
```

### JSON Output

Results are automatically saved to JSON for further analysis:

```json
{
  "config": {
    "model": "mlx-community/gemma-2-27b-it-4bit",
    "questionCount": 200,
    "maxTokens": 100,
    "temperature": 0.7,
    "compareMode": "both"
  },
  "timestamp": "2025-01-07T16:30:00.000Z",
  "systemInfo": {
    "nodeVersion": "v22.0.0",
    "platform": "darwin",
    "arch": "arm64",
    "cpus": 10,
    "totalMemoryMB": 65536
  },
  "mlxServing": {
    "engineName": "mlx-serving",
    "modelId": "mlx-community/gemma-2-27b-it-4bit",
    "modelLoadTimeMs": 1234.56,
    "totalTimeMs": 125600,
    "totalTokens": 19847,
    "completed": 200,
    "failed": 0,
    "questions": [
      {
        "questionIndex": 0,
        "question": "What is quantum computing?",
        "ttftMs": 145.2,
        "latencyMs": 628.5,
        "tokens": 98,
        "tokensPerSec": 155.89,
        "output": "Quantum computing is...",
        "success": true
      }
      // ... more results
    ],
    "statistics": {
      "latency": {
        "mean": 628.0,
        "median": 615.3,
        "p95": 892.5,
        "p99": 1045.2,
        "min": 412.1,
        "max": 1234.5,
        "stdDev": 145.2
      },
      "ttft": { /* ... */ },
      "tokensPerSec": { /* ... */ },
      "tokensPerRequest": { /* ... */ }
    }
  },
  "mlxEngine": { /* ... similar structure ... */ },
  "comparison": {
    "speedup": 1.12,
    "ttftSpeedup": 1.03,
    "latencySpeedup": 1.09,
    "winner": "mlx-serving"
  }
}
```

---

## NPM Scripts

Add these to `package.json` for convenience:

```json
{
  "scripts": {
    "bench:flexible": "tsx benchmarks/flexible-benchmark.ts",
    "bench:quick": "tsx benchmarks/flexible-benchmark.ts -q 10",
    "bench:gemma-27b-200q": "tsx benchmarks/flexible-benchmark.ts -m mlx-community/gemma-2-27b-it-4bit -q 200 -c both",
    "bench:compare": "tsx benchmarks/flexible-benchmark.ts -q 100 -c both"
  }
}
```

**Usage:**
```bash
npm run bench:flexible -- -m gemma-2-27b-it-4bit -q 200
npm run bench:quick
npm run bench:gemma-27b-200q
```

---

## Interpreting Results

### Throughput Speedup

- **> 1.05x**: mlx-serving is faster
- **0.95x - 1.05x**: Similar performance (tie)
- **< 0.95x**: mlx-engine is faster

### Key Metrics

- **Model Load Time**: Time to load model into memory
- **TTFT (Time To First Token)**: Latency before first token appears
- **Latency**: Total time per request (including TTFT)
- **Throughput**: Tokens generated per second
- **P95/P99**: 95th/99th percentile latencies (tail latency)

### Success Rate

- **100%**: All requests succeeded
- **< 100%**: Some requests failed (check verbose logs)

---

## Troubleshooting

### Model Not Found

```bash
Error: Model not found: mlx-community/gemma-2-27b-it-4bit
```

**Solution:** Check model ID on HuggingFace. Ensure it's an MLX-compatible model.

### Python Script Failed

```bash
ERROR: Python script exited with code 1
```

**Solution:**
1. Ensure `mlx-lm` is installed: `pip install mlx-lm`
2. Check Python version: `python3 --version` (requires 3.11+)
3. Verify model is downloadable: `mlx-lm --model <model-id>`

### Out of Memory

```bash
Error: Metal out of memory
```

**Solution:**
- Use smaller model (e.g., 3B instead of 27B)
- Reduce `--max-tokens`
- Close other applications
- Use 4-bit quantized models

### Slow Performance

**Tips:**
- Use 4-bit quantized models (faster)
- Reduce `--questions` for quick tests
- Set `--max-tokens 50` for faster generation
- Use smaller models for testing

---

## Performance Tips

### For Fastest Benchmarks

```bash
# Small model, few questions, low max-tokens
tsx benchmarks/flexible-benchmark.ts \
  -m mlx-community/Llama-3.2-1B-Instruct-4bit \
  -q 20 \
  --max-tokens 50
```

### For Accurate Comparisons

```bash
# More questions, both engines, multiple runs
for run in {1..3}; do
  tsx benchmarks/flexible-benchmark.ts \
    -m <model> \
    -q 200 \
    -c both \
    -o results/run-$run.json
done
```

### For Production Simulation

```bash
# High load, realistic parameters
tsx benchmarks/flexible-benchmark.ts \
  -q 1000 \
  --max-tokens 150 \
  -t 0.7 \
  --compare mlx-serving
```

---

## Analyzing Results

### Compare Multiple Runs

```bash
# Run benchmarks
for count in 50 100 200 500; do
  tsx benchmarks/flexible-benchmark.ts \
    -q $count \
    -c both \
    -o "results/gemma-${count}q.json"
done

# Analyze with jq
jq '.comparison.speedup' results/*.json
```

### Extract Key Metrics

```bash
# Get throughput for all runs
jq '.mlxServing.statistics.tokensPerSec.mean' results/*.json

# Get winner for each run
jq '.comparison.winner' results/*.json
```

### Plot Results (Python)

```python
import json
import matplotlib.pyplot as plt

# Load results
with open('results/benchmark-123456.json') as f:
    data = json.load(f)

# Plot latency distribution
latencies = [q['latencyMs'] for q in data['mlxServing']['questions']]
plt.hist(latencies, bins=50)
plt.xlabel('Latency (ms)')
plt.ylabel('Frequency')
plt.title('mlx-serving Latency Distribution')
plt.show()
```

---

## Advanced Usage

### Custom Question List

Modify the `generateQuestions()` function in `flexible-benchmark.ts`:

```typescript
function generateQuestions(count: number): string[] {
  // Your custom logic here
  return [
    'Custom question 1',
    'Custom question 2',
    // ...
  ];
}
```

### Custom Model Path

```bash
tsx benchmarks/flexible-benchmark.ts \
  --model "/path/to/local/model" \
  -q 100
```

### Environment Variables

```bash
# Set Python path
PYTHON_PATH=/opt/homebrew/bin/python3 tsx benchmarks/flexible-benchmark.ts

# Set MLX_LM cache
HUGGINGFACE_HUB_CACHE=/path/to/cache tsx benchmarks/flexible-benchmark.ts
```

---

## Roadmap

- [ ] Concurrent request support
- [ ] Custom question CSV import
- [ ] Real-time dashboard (web UI)
- [ ] Grafana/Prometheus integration
- [ ] Multi-GPU support
- [ ] Result comparison tool (diff multiple JSON files)
- [ ] Automatic report generation (markdown/PDF)

---

## Contributing

Found a bug or want to add a feature?

1. Open an issue on GitHub
2. Submit a pull request
3. Update this README with examples

---

## License

Elastic License 2.0 - See [LICENSE](../LICENSE)

---

## Changelog

### v1.0.0 (2025-01-07)
- ✨ Initial release
- ✅ Support for any MLX model
- ✅ Flexible question count (1-10,000+)
- ✅ mlx-serving vs mlx-engine comparison
- ✅ Comprehensive statistics (P50/P95/P99)
- ✅ JSON output format
- ✅ Progress tracking
- ✅ 90+ topic question generation

---

**Made with ❤️ by the mlx-serving team**
