# Performance Benchmarks

Comprehensive performance benchmark framework for kr-mlx-lm.

## Quick Start

```bash
# Run all benchmarks with default settings
pnpm bench

# Run specific benchmark
pnpm bench:ipc          # IPC overhead (JSON vs MessagePack)
pnpm bench:ttft         # Time To First Token
pnpm bench:throughput   # Token generation throughput

# Generate full report
pnpm bench:report       # Creates Markdown report in benchmarks/results/
```

## Benchmark Types

### 1. IPC Overhead (`ipc-overhead.ts`)

Measures serialization/deserialization performance comparing JSON and MessagePack protocols.

**Metrics:**
- Encode time (ms)
- Decode time (ms)
- Payload size (bytes)
- Compression ratio

**Tests:**
- Small payloads (stream.chunk messages)
- Medium payloads (tokenize requests)
- Large payloads (load_model responses)

**Target:** < 1ms p95 overhead for MessagePack

```bash
pnpm bench:ipc
```

### 2. TTFT - Time To First Token (`ttft.ts`)

Measures latency from request to first token generation.

**Metrics:**
- Cold start TTFT (model loading + first generation)
- Warm start TTFT (model already loaded)
- Statistical distribution (mean, median, p95, p99)

**Tests:**
- Different model sizes
- Various prompt lengths
- Cold vs warm start comparison

**Target:** < 200ms p95 for warm start

```bash
pnpm bench:ttft
```

### 3. Throughput (`throughput.ts`)

Measures token generation throughput across different scenarios.

**Metrics:**
- Tokens per second
- Average latency
- Streaming vs non-streaming comparison

**Tests:**
- Short, medium, and long prompts
- Streaming mode enabled/disabled
- Different generation lengths

**Target:** >= 20 tokens/sec minimum

```bash
pnpm bench:throughput
```

### 4. Comparison Benchmark (`comparison.ts`)

Compares kr-mlx-lm performance against the reference mlx-engine implementation.

**Metrics:**
- TTFT comparison
- Throughput comparison
- Total latency comparison
- Success rate

**Tests:**
- Side-by-side performance testing
- Same models and prompts
- Statistical analysis

**Prerequisites:**
1. Install Python 3.11: `brew install python@3.11`
2. Clone mlx-engine: `git clone https://github.com/lmstudio-ai/mlx-engine.git /tmp/mlx-engine`
3. Setup Python environment (see below)

```bash
pnpm bench:comparison
```

### 5. Apple-to-Apple Comparison (`apple-to-apple-comparison.ts`) ⭐ **RECOMMENDED**

**Strict fair comparison** ensuring identical test conditions between engines.

**Fair Testing Features:**
- ✅ **Warmup Phase** - Eliminates cold start bias
- ✅ **Randomized Test Order** - Eliminates sequence bias
- ✅ **Identical Conditions** - Same model, prompts, parameters
- ✅ **Precise Timing** - Separate model load, TTFT, generation metrics
- ✅ **Statistical Rigor** - Multiple runs with p95/p99 analysis
- ✅ **PRD Compliance Check** - Automatic target verification

**Metrics:**
- Model load time
- TTFT (Time To First Token)
- Pure generation speed (excluding TTFT)
- Overall throughput
- Output consistency

**Why This Test Matters:**

This test ensures **true apple-to-apple comparison** by:
1. **Warmup runs** - Both engines get 2 warmup runs to eliminate JIT/caching effects
2. **Randomized order** - Tests run in random order to eliminate sequence bias
3. **Identical parameters** - Same model path, prompts, temperature, topP, maxTokens
4. **Separate timing** - Model load separated from generation timing
5. **Multiple runs** - 10 runs per engine for statistical significance

```bash
pnpm bench:apple-to-apple
```

**Example Output:**
```
═══ Time To First Token (TTFT) ═══
  Engine          Mean         Median       P95          P99
  ──────────────────────────────────────────────────────────
  kr-mlx-lm       124.5ms      120.3ms      145.2ms      148.9ms
  mlx-engine      118.2ms      115.6ms      138.4ms      142.1ms
  Speedup: 0.948x (mlx faster)

═══ PRD Performance Targets ═══
  TTFT Target (≤ 1.2x mlx-engine):         ✓ PASS (0.948x)
  Throughput Target (≥ 90% mlx-engine):   ✓ PASS (94.2%)
```

**Setup mlx-engine:**

```bash
cd /tmp/mlx-engine
python3.11 -m venv .venv
source .venv/bin/activate
pip install -U -r requirements.txt
```

**Download test model:**

```bash
# Using LM Studio CLI
lms get mlx-community/Meta-Llama-3.2-3B-Instruct-4bit

# Or ensure model exists at: models/llama-3.2-3b-instruct
```

## Advanced Usage

### Custom Configuration

```bash
# Run with custom sample count
pnpm bench -- --benchmark ipc --samples 200

# Enable verbose output
pnpm bench -- --benchmark ttft --verbose

# Custom warmup runs
pnpm bench -- --benchmark throughput --warmup 5
```

### Export Formats

```bash
# JSON format
pnpm bench -- --benchmark all --format json --output results.json

# CSV format
pnpm bench -- --benchmark ipc --format csv --output ipc-results.csv

# Markdown report
pnpm bench -- --benchmark all --format markdown --output report.md
```

### CLI Options

```
-b, --benchmark <type>    Benchmark to run: ipc, ttft, throughput, all (default: all)
-s, --samples <number>    Number of samples per test (default: varies by benchmark)
-w, --warmup <number>     Number of warmup runs (default: 3)
-v, --verbose             Enable verbose output
-f, --format <format>     Report format: console, json, csv, markdown (default: console)
-o, --output <path>       Output file path (required for json/csv/markdown formats)
-h, --help                Show help message
```

## Architecture

```
benchmarks/
├── index.ts           # Main benchmark runner
├── types.ts           # Type definitions
├── utils.ts           # Statistical utilities
├── ipc-overhead.ts    # IPC benchmark
├── ttft.ts            # TTFT benchmark
├── throughput.ts      # Throughput benchmark
├── report.ts          # Report generator
└── results/           # Generated reports (gitignored)
```

## Performance Targets

As defined in the PRD (`automatosx/PRD/kr-mlx-lm-master-prd.md`):

| Metric | Target | Notes |
|--------|--------|-------|
| IPC Overhead | < 1ms (p95) | MessagePack serialization |
| TTFT (warm) | < 200ms (p95) | 128-token prompts |
| Throughput | >= 20 tokens/sec | Minimum acceptable |
| TTFT vs Python | <= 1.2x | Parity with mlx-engine |
| Throughput vs Python | >= 90% | Parity with mlx-engine |

## Statistics

All benchmarks use robust statistical analysis:

- **Mean:** Average value
- **Median:** 50th percentile
- **P95:** 95th percentile (performance target)
- **P99:** 99th percentile (tail latency)
- **Min/Max:** Range bounds
- **StdDev:** Standard deviation (variance indicator)

## CI Integration

Benchmarks can be integrated into CI for regression detection:

```yaml
# .github/workflows/benchmark.yml
- name: Run benchmarks
  run: pnpm bench:all --format json --output benchmark-results.json

- name: Check performance targets
  run: node scripts/check-benchmark-targets.js benchmark-results.json
```

## Troubleshooting

### "Model not found"

Ensure test models are available:
```bash
ls models/llama-3.2-3b-instruct/
```

### High variance in results

- Increase sample count: `--samples 100`
- Close background applications
- Run on dedicated hardware
- Check system load: `top` or Activity Monitor

### Python runtime errors

Verify Python environment:
```bash
.kr-mlx-venv/bin/python --version
.kr-mlx-venv/bin/pip list | grep mlx
```

## Development

### Adding New Benchmarks

1. Create new file: `benchmarks/my-benchmark.ts`
2. Implement benchmark function
3. Add to `benchmarks/index.ts`
4. Update this README
5. Add npm script to package.json

### Benchmark Template

```typescript
import type { BenchmarkResult, BenchmarkConfig } from './types.js';
import { calculateStatistics, getSystemInfo } from './utils.js';

export async function runMyBenchmark(config: BenchmarkConfig = {}): Promise<BenchmarkResult[]> {
  const { samples = 100, verbose = false } = config;

  // Implement benchmark logic
  const results: BenchmarkResult[] = [];

  return results;
}

export function formatMyResults(results: BenchmarkResult[]): void {
  // Format and display results
}
```

## References

- [PRD: Performance Metrics](../automatosx/PRD/kr-mlx-lm-master-prd.md#2-desired-outcomes--success-metrics)
- [IPC Strategy](../automatosx/PRD/kr-mlx-lm-master-prd.md#7-ipc--runtime-strategy)
- [mlx-engine Comparison](https://github.com/lmstudio-ai/mlx-engine)
