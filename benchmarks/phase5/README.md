# Phase 5 Performance Benchmarks

This directory contains Phase 5 performance validation benchmarks for mlx-serving.

## Week 2 Day 1-2: TTFT Benchmark

**Objective:** Validate TTFT (Time To First Token) improvements from Phase 5 optimizations.

**Target:** TTFT P95 ≤ 550ms (stretch goal: ≤400ms)

### Quick Validation Test

Run a quick 20-sample test to validate the benchmark works:

```bash
npx tsx benchmarks/phase5/ttft-benchmark-quick.ts
```

**Expected duration:** ~5-10 minutes
**Samples:** 20 (10 warmup + 20 baseline + 20 Phase 5)
**Model:** gemma-2-2b-it-4bit (smaller for speed)

### Full Benchmark (1000+ samples)

Run the comprehensive benchmark with statistical significance:

```bash
npx tsx benchmarks/phase5/ttft-benchmark.ts
```

**Expected duration:** ~2-4 hours
**Samples:** 1000 (100 warmup + 1000 baseline + 1000 Phase 5)
**Model:** gemma-2-27b-it-4bit (production model)

### What Gets Measured

The benchmark compares two configurations:

1. **Baseline:** Phase 5 features DISABLED
   - Standard TTFT without optimizations
   - Feature flags: `phase5_enabled=false`

2. **Phase 5:** TTFT Pipeline ENABLED
   - Warmup queue for tokenizer preloading
   - Speculative execution for next-request prediction
   - KV cache prefetch
   - Feature flags: `phase5_enabled=true, ttft_pipeline=true`

### Metrics Collected

- **Mean TTFT:** Average time to first token
- **P50 (Median):** 50th percentile TTFT
- **P95:** 95th percentile TTFT (PRIMARY TARGET)
- **P99:** 99th percentile TTFT
- **Min/Max:** Best and worst case TTFT
- **StdDev:** Standard deviation
- **Error rate:** Failed requests
- **95% Confidence Intervals:** Statistical significance

### Output

The benchmark generates:

1. **Console output:** Real-time progress and summary
2. **JSON results:** `benchmarks/results/phase5-ttft-{timestamp}.json`
3. **Markdown report:** `automatosx/tmp/PHASE5-WEEK2-DAY1-2-TTFT-BENCHMARK-REPORT.md`

### Configuration

Edit the benchmark configuration in `ttft-benchmark.ts`:

```typescript
const config = {
  modelId: 'gemma-2-27b-it-4bit',
  modelPath: 'mlx-community/gemma-2-27b-it-4bit',
  samples: 1000,        // Number of samples per phase
  warmupRuns: 10,       // Warmup runs per phase
  maxTokens: 50,        // Tokens to generate
  temperature: 0.7,     // Sampling temperature
  prompts: [...],       // Test prompts (varied length)
};
```

### Feature Flag Control

The benchmark automatically controls feature flags via:

1. **Environment variables:**
   ```bash
   export PHASE5_TTFT_ENABLED=true
   npx tsx benchmarks/phase5/ttft-benchmark.ts
   ```

2. **Config file:** `config/feature-flags.yaml`
   ```yaml
   ttft_pipeline:
     enabled: true
     rollout_percentage: 100
   ```

### Interpreting Results

**✅ Success Criteria:**

- Phase 5 P95 ≤ 550ms (target)
- Phase 5 P95 ≤ 400ms (stretch goal)
- Improvement ≥ 10% over baseline
- Error rate < 1%
- Confidence intervals non-overlapping (statistically significant)

**Example output:**

```
=== Benchmark Results ===

Phase           Mean      Median    P95       P99       Min       Max       StdDev    Errors
----------------------------------------------------------------------------------------------------
Baseline        523.45    498.32    687.21    801.45    421.12    912.34    89.23     0
Phase 5         401.23    385.67    521.34    598.12    325.45    645.23    67.89     0

=== Improvement Summary ===

Mean TTFT:   122.22 ms reduction (23.4% improvement)
P50 TTFT:    112.65 ms reduction
P95 TTFT:    165.87 ms reduction ✅
P99 TTFT:    203.33 ms reduction

=== Target Validation ===

P95 Target (≤ 550ms):        ✅ PASSED (521.34 ms)
P95 Stretch Goal (≤ 400ms):  ❌ FAILED (521.34 ms)
```

### Troubleshooting

**Model not found:**
```bash
# Download model first
python -c "from mlx_lm import load; load('mlx-community/gemma-2-27b-it-4bit')"
```

**Feature flags not working:**
```bash
# Verify feature flags loaded
cat config/feature-flags.yaml

# Reset feature flag cache
rm -rf .automatosx/cache/feature-flags.json
```

**Out of memory:**
```bash
# Use smaller model
# Edit config.modelPath to 'mlx-community/gemma-2-2b-it-4bit'
```

## Week 2 Day 3-4: Throughput Benchmark

**Objective:** Validate sustained throughput and concurrency under realistic production load.

**Targets:**
- Sustained throughput ≥ 130 req/s
- Peak concurrency ≥ 75 concurrent streams
- CPU utilization < 80%
- Error rate < 1%

### Quick Validation Test

Run a quick 1-minute test to validate the benchmark works:

```bash
npx tsx benchmarks/phase5/throughput-benchmark-quick.ts
```

**Expected duration:** ~1-2 minutes (including model load)
**Configuration:** 1-minute duration, 50 req/s target, gemma-2-2b-it-4bit

### Full Benchmark (10-minute sustained load)

Run the comprehensive 10-minute sustained load test:

```bash
npx tsx benchmarks/phase5/throughput-benchmark.ts
```

**Expected duration:** ~11 minutes per phase (10 min test + 30s warmup + model load)
**Configuration:** 10-minute duration, 130 req/s target, gemma-2-27b-it-4bit
**Total runtime:** ~22 minutes (baseline + Phase 5)

### What Gets Measured

The benchmark compares two configurations:

1. **Baseline:** Phase 5 features DISABLED
   - Standard throughput without optimizations

2. **Phase 5:** Throughput optimizations ENABLED
   - TTFT Pipeline for reduced latency
   - QoS Policy Engine for load management
   - Adaptive batching and concurrency

### Metrics Collected

**Real-time metrics (updated every 5 seconds):**
- **Requests/sec:** Actual vs target throughput
- **Token throughput:** Tokens per second
- **Concurrency:** Current, peak, and average concurrent streams
- **Latency:** P50, P95, P99 percentiles
- **Error rate:** Failed requests percentage
- **Resources:** CPU %, memory usage (MB)

**Summary statistics:**
- Mean, median, P95, P99 for all metrics
- Comparison: Baseline vs Phase 5
- Improvement percentages
- Target validation results

### Output

The benchmark generates:

1. **Console output:** Real-time progress with live stats
2. **JSON results:** `benchmarks/results/phase5-throughput-{timestamp}.json`

**Example console output:**

```
=== Throughput Benchmark (Phase 5 ENABLED) ===

[████████████████░░░░░░░░░░░░] 60% (6:00 / 10:00)

Requests/sec:   128.3 / 130.0 (target)   ✓
Concurrent:     73 (peak: 78, avg: 71)   ✓
Token/sec:      2,456.7
Latency P95:    523.4 ms
Errors:         0.3% (2/657)
CPU:            67.2%
Memory:         3,456 MB
```

### Configuration

Edit the benchmark configuration in `throughput-benchmark.ts`:

```typescript
const config = {
  modelId: 'gemma-2-27b-it-4bit',
  modelPath: 'mlx-community/gemma-2-27b-it-4bit',
  durationMs: 600000,           // 10 minutes
  targetRequestsPerSecond: 130, // Target throughput
  maxConcurrent: 100,           // Concurrency limit
  warmupDurationMs: 30000,      // 30 seconds
  maxTokens: 50,                // Tokens per request
  temperature: 0.7,
  prompts: [...],               // Test prompts
};
```

### Interpreting Results

**✅ Success Criteria:**

- Sustained throughput ≥ 130 req/s
- Peak concurrency ≥ 75 concurrent streams
- CPU utilization < 80%
- Memory stable (no continuous growth)
- Error rate < 1%
- Phase 5 improvement ≥ 5% over baseline

**Example comparison:**

```
=== Comparison Summary ===

Metric               Baseline    Phase 5     Improvement
-----------------------------------------------------------
Avg Req/s           118.3       128.3       +8.5%       ✓
Peak Concurrent     68          78          +14.7%      ✓
Avg Latency (ms)    687         523         -23.9%      ✓
P95 Latency (ms)    892         634         -28.9%      ✓
Error Rate          1.2%        0.3%        -75.0%      ✓
Avg CPU %           72.3%       68.1%       -5.8%       ✓
```

### Troubleshooting

**Model not found:**
```bash
# Download model first
python -c "from mlx_lm import load; load('mlx-community/gemma-2-27b-it-4bit')"
```

**Throughput below target:**
- Check if Phase 5 features are enabled
- Verify feature flags in config/feature-flags.yaml
- Lower target rate for smaller models
- Increase maxConcurrent limit

**High error rate:**
- Reduce targetRequestsPerSecond
- Increase maxConcurrent limit
- Check memory usage (might be OOM)

**Out of memory:**
```bash
# Use smaller model
# Edit config.modelPath to 'mlx-community/gemma-2-2b-it-4bit'
```

## Week 2 Day 5: Stress Test & Regression Check

**Objectives:**
- Identify maximum sustainable throughput before system breaks
- Classify failure modes (OOM, timeout, high error rate, etc.)
- Verify no performance regressions vs baseline
- Validate graceful degradation under extreme load

### Stress Test

**Purpose:** Gradually increase load until the system breaks to identify limits and failure modes.

**Strategy:** Start at 50 req/s, increment by 20 req/s every 30 seconds until failure detected.

#### Running the Stress Test

```bash
npx tsx benchmarks/phase5/stress-test.ts
```

**Expected duration:** 10-30 minutes (depends on breaking point)
**Configuration:** 50→300 req/s, +20 req/s every 30s, gemma-2-27b-it-4bit

#### What Gets Measured

For each stress level:
- **Request rate:** Actual throughput achieved
- **Total requests:** Requests attempted at this level
- **Success/failure counts:** Successful vs failed requests
- **Error rate:** Percentage of failed requests
- **Latency:** P95, P99 latencies
- **Concurrency:** Peak concurrent streams
- **Resources:** CPU %, memory usage
- **Error types:** Categorized errors (timeout, OOM, etc.)
- **Degradation detection:** Automatic detection of performance degradation

#### Failure Mode Classification

The stress test automatically classifies failures into:

1. **OOM (Out of Memory):** Memory usage > 90% of total
2. **Timeout:** Timeout errors > 5% of total requests
3. **High Error Rate:** Error rate > 10%
4. **Resource Exhaustion:** CPU > 95%
5. **Crash:** System crashes or unhandled exceptions
6. **None:** No failure detected (reached max req/s without breaking)

#### Output Format

**Console output:**
```
=== Stress Test Results ===

Phase: Phase 5 ENABLED
Duration: 15.3 minutes
Levels tested: 8

Level  Req/s   Requests  Errors   P95 Lat   Peak Conc   CPU     Memory    Status
------------------------------------------------------------------------------------
  0       50       1500     0.0%     421ms          48    62.3%    2,456MB  ✓ OK
  1       70       2100     0.1%     487ms          67    68.7%    2,678MB  ✓ OK
  2       90       2700     0.3%     523ms          86    73.2%    2,891MB  ✓ OK
  3      110       3300     0.8%     598ms         105    78.9%    3,123MB  ⚠ ERR
  4      130       3900     2.1%     734ms         124    84.5%    3,456MB  ⚠ ERR
  5      150       4500     5.7%     912ms         143    89.2%    3,789MB  ⚠ DEGR
  6      170       5100    12.3%    1,234ms        161    94.1%    4,123MB  ⚠ DEGR
  7      190       5700    23.4%    2,456ms        178    98.7%    4,567MB  ⚠ DEGR

=== Breaking Point ===

Maximum sustainable throughput: 150 req/s
Breaking point: 190 req/s (level 7)
Failure mode: resource_exhaustion
Error rate at break: 23.4%
```

**JSON export:** `benchmarks/results/phase5-stress-test-{timestamp}.json`

#### Configuration

Edit `stress-test.ts` to customize:

```typescript
const config = {
  modelId: 'gemma-2-27b-it-4bit',
  modelPath: 'mlx-community/gemma-2-27b-it-4bit',
  startingRequestsPerSecond: 50,
  incrementRequestsPerSecond: 20,
  incrementIntervalMs: 30000,    // 30 seconds per level
  maxRequestsPerSecond: 300,
  maxConcurrent: 150,
  maxDurationMs: 600000,         // 10 minutes max
  failureThreshold: 0.1,         // 10% error rate
  maxTokens: 50,
  temperature: 0.7,
  prompts: DEFAULT_PROMPTS,
};
```

#### Interpreting Results

**Success Indicators:**
- System handles gradual load increase gracefully
- Breaking point identified clearly
- Failure mode classified correctly
- Last successful level has < 10% error rate

**What to Look For:**
- **Maximum sustainable throughput:** Last level with < 10% error rate
- **Failure mode:** Helps identify optimization targets (OOM → optimize memory, Timeout → optimize latency)
- **Degradation pattern:** Gradual vs sudden failure
- **Resource bottleneck:** CPU vs memory vs concurrent streams

**Example Analysis:**
```
Breaking point: 190 req/s with resource_exhaustion
→ System is CPU-bound, not memory-bound
→ Optimize: Reduce per-request CPU usage or scale horizontally

Maximum sustainable: 150 req/s
→ Safe production target: ~120 req/s (80% of max)
```

### Regression Check

**Purpose:** Validate that Phase 5 hasn't introduced performance regressions compared to historical baseline.

**Strategy:** Compare current metrics against baseline with ±10% tolerance threshold.

#### Running the Regression Check

```bash
npx tsx benchmarks/phase5/regression-check.ts
```

**Expected duration:** 3-5 minutes
**Samples:** 50 (quick validation)
**Model:** gemma-2-2b-it-4bit (smaller for speed)

**Exit codes:**
- `0` - All checks passed, no regressions
- `1` - Regressions detected (fails CI/CD pipeline)

#### What Gets Measured

**TTFT Metrics:**
- P50 (Median)
- P95 (95th percentile)
- P99 (99th percentile)
- Mean (Average)

**Comparison:**
- Current vs Baseline
- Delta (absolute change)
- Delta % (percentage change)
- Pass/Fail based on ±10% threshold

#### Baseline Configuration

The regression check compares against a hardcoded baseline (should be loaded from previous benchmark results in production):

```typescript
const DEFAULT_BASELINE: RegressionBaseline = {
  ttft: {
    p50: 450,   // ms
    p95: 650,   // ms
    p99: 800,   // ms
    mean: 480,  // ms
  },
  throughput: {
    requestsPerSecond: 120,
    peakConcurrent: 70,
    errorRate: 0.005,  // 0.5%
  },
  resources: {
    avgCpuPercent: 72,
    peakMemoryMB: 3500,
  },
};
```

#### Output Format

**Console output:**
```
=== Regression Check Results ===

Metric          Baseline    Current     Delta      % Change   Status
------------------------------------------------------------------------------
TTFT P50        450 ms      438 ms      -12 ms     -2.7%      ✓ PASS
TTFT P95        650 ms      623 ms      -27 ms     -4.2%      ✓ PASS
TTFT P99        800 ms      791 ms       -9 ms     -1.1%      ✓ PASS
TTFT Mean       480 ms      467 ms      -13 ms     -2.7%      ✓ PASS

=== Overall Result ===

Status: ✓ PASSED - No regressions detected
```

**If regressions detected:**
```
=== Overall Result ===

Status: ✗ FAILED - Regressions detected

Failed Metrics:
  - TTFT P95: +12.3% (threshold: 10%)
  - TTFT Mean: +11.7% (threshold: 10%)
```

**JSON export:** `benchmarks/results/phase5-regression-check-{timestamp}.json`

#### Configuration

Edit `regression-check.ts` to customize:

```typescript
const config = {
  modelId: 'gemma-2-2b-it-4bit',
  modelPath: 'mlx-community/gemma-2-2b-it-4bit',
  samples: 50,           // Number of TTFT samples
  warmupRuns: 5,         // Warmup runs
  maxTokens: 30,         // Tokens per request
  temperature: 0.7,
  prompts: DEFAULT_PROMPTS,
};
```

**Tolerance threshold:** Currently hardcoded to ±10% in `compareMetric()` function.

#### Interpreting Results

**Success Criteria:**
- All metrics within ±10% of baseline
- No statistically significant degradation
- Exit code 0 (safe for CI/CD integration)

**What to Look For:**

**Small improvements (-5% to -10%):**
- Expected for Phase 5 optimizations
- Document in release notes

**No change (±2%):**
- Normal statistical variance
- No action needed

**Small regressions (+2% to +10%):**
- Investigate if consistent across runs
- May be acceptable if other metrics improved

**Large regressions (>+10%):**
- **FAIL** - Blocks deployment
- Investigate immediately
- Check for code changes, config differences, or environmental factors

#### CI/CD Integration

Use in continuous integration:

```bash
# Run regression check in CI pipeline
npx tsx benchmarks/phase5/regression-check.ts
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ Regression detected! Blocking deployment."
  exit 1
fi

echo "✅ No regressions. Safe to deploy."
```

#### Updating Baseline

After validating new performance improvements, update the baseline:

```typescript
// Option 1: Update hardcoded baseline in regression-check.ts
const DEFAULT_BASELINE: RegressionBaseline = {
  ttft: {
    p50: 438,   // Updated from 450
    p95: 623,   // Updated from 650
    p99: 791,   // Updated from 800
    mean: 467,  // Updated from 480
  },
  // ...
};

// Option 2 (recommended): Load from previous benchmark results
const baselineJson = await readFile('benchmarks/results/phase5-ttft-baseline.json');
const baseline = JSON.parse(baselineJson);
```

### Troubleshooting Day 5 Benchmarks

**Stress test breaks immediately:**
- Lower `startingRequestsPerSecond` (try 30 req/s)
- Use smaller model (gemma-2-2b-it-4bit)
- Increase `incrementIntervalMs` (try 60 seconds)

**Regression check always fails:**
- Verify baseline is realistic (update if needed)
- Run multiple times to rule out statistical variance
- Check feature flags are correctly enabled/disabled

**Out of memory:**
```bash
# Use smaller model for both benchmarks
# Edit config.modelPath to 'mlx-community/gemma-2-2b-it-4bit'
```

**Benchmark takes too long:**
```bash
# Stress test: Reduce maxRequestsPerSecond
# Regression check: Reduce samples (try 20 instead of 50)
```
