# kr-serve-mlx v1.4.2 Phase 1 - Performance Report

**Date**: 2025-11-05
**Optimization**: Reduced default batching window (2.0ms → 1.0ms)
**Test**: 50 Questions Comparison Benchmark
**Model**: llama-3.2-3b-instruct

---

## Executive Summary

Phase 1 implementation (reduced batching window from 2.0ms to 1.0ms) shows **marginal performance improvement** in per-request metrics but **similar total execution time** due to test variance.

### Key Findings

✅ **Per-Request Improvements**:
- Mean response time: **-1.51ms** (-0.36%)
- TTFT: **-0.77ms** (-0.73%)
- Throughput: **+0.45 tok/s** (+0.37%)

⚠️ **Total Time**: Essentially unchanged (204.91s vs 204.74s, +0.17s)

📊 **Verdict**: Phase 1 shows modest improvements, but test variance masks the expected 4-5% gain

---

## Detailed Performance Comparison

### Response Time Metrics

| Configuration | Mean | Median | P95 | P99 | Std Dev |
|--------------|------|--------|-----|-----|---------|
| **v1.4.1 (2.0ms window)** | 415.85ms | 414.90ms | 428.10ms | 431.03ms | 6.49ms |
| **Phase 1 (1.0ms window)** | 414.34ms | 413.77ms | 424.50ms | 435.32ms | 6.45ms |
| **Change** | **-1.51ms** | **-1.13ms** | **-3.60ms** | **+4.29ms** | **-0.04ms** |
| **% Change** | **-0.36%** | **-0.27%** | **-0.84%** | **+1.00%** | **-0.62%** |

**Analysis**:
- Mean and median show slight improvement
- P95 improved by 3.60ms (good!)
- P99 regressed by 4.29ms (unexpected, likely variance)
- Standard deviation essentially unchanged

### Time To First Token (TTFT)

| Configuration | Mean TTFT | Median TTFT | P95 TTFT | P99 TTFT |
|--------------|-----------|-------------|----------|----------|
| **v1.4.1 (2.0ms)** | 104.99ms | 104.33ms | 115.58ms | 119.35ms |
| **Phase 1 (1.0ms)** | 104.22ms | 103.19ms | 113.40ms | 125.05ms |
| **Change** | **-0.77ms** | **-1.14ms** | **-2.18ms** | **+5.70ms** |
| **% Change** | **-0.73%** | **-1.09%** | **-1.89%** | **+4.78%** |

**Analysis**:
- Mean and median TTFT improved slightly
- P95 improved by 2.18ms
- P99 regressed (variance)
- Expected improvement: ~1ms (from 1.0ms window reduction)

### Throughput

| Configuration | Mean Throughput | Median Throughput | P95 Throughput |
|--------------|----------------|-------------------|----------------|
| **v1.4.1 (2.0ms)** | 120.27 tok/s | 120.51 tok/s | 123.12 tok/s |
| **Phase 1 (1.0ms)** | 120.72 tok/s | 120.84 tok/s | 124.03 tok/s |
| **Change** | **+0.45 tok/s** | **+0.33 tok/s** | **+0.91 tok/s** |
| **% Change** | **+0.37%** | **+0.27%** | **+0.74%** |

**Analysis**: Slight throughput improvement across all percentiles

### Total Execution Time

| Configuration | Total Time | Overhead vs Baseline | Success Rate |
|--------------|------------|---------------------|--------------|
| **Baseline (mlx-engine)** | 183.32s | 0% | 100% |
| **v1.4.1 (2.0ms window)** | 204.74s | +11.7% | 100% |
| **Phase 1 (1.0ms window)** | 204.91s | +11.8% | 100% |
| **Change** | **+0.17s** | **+0.1%** | **0%** |

**Analysis**: Total time essentially unchanged, likely due to:
1. Baseline variance: 183.32s vs 184.40s (previous) = -1.08s variance
2. Per-request improvements masked by test variance
3. Small sample size (50 questions)

---

## Variance Analysis

### Baseline Variance Across Runs

| Run | Baseline Time | Variance |
|-----|--------------|----------|
| **v1.4.1 initial** | 181.82s | -1.50s |
| **v1.4.1 full** | 184.40s | Baseline |
| **Hybrid mode** | 184.40s | 0s |
| **Phase 1** | 183.32s | -1.08s |

**Observation**: Baseline varies by ±1.5s (±0.8%), which is significant compared to expected Phase 1 improvement.

### Statistical Significance

With current variance (~1.5s total time, ~0.8% overhead):
- **Expected Phase 1 improvement**: 4-5% (8-10s)
- **Observed improvement**: 0.36% per-request, 0% total
- **Conclusion**: Either:
  1. Test variance is masking real improvements
  2. 1.0ms window doesn't provide expected gain
  3. Need more samples (100+ questions) for statistical significance

---

## Why Phase 1 Didn't Show Expected Improvement?

### Hypothesis 1: Test Variance

**Evidence**:
- Baseline varied by ±1.5s across runs
- Per-request metrics show improvement
- Small sample size (50 questions)

**Conclusion**: Likely the primary factor

### Hypothesis 2: Batching Window Impact Overestimated

**Original Analysis**:
- Assumed 2ms window accounts for ~8.6ms overhead per request
- Reducing to 1.0ms should save ~4.3ms per request
- Expected total savings: ~4.3ms × 50 = 215ms (~4.5%)

**Actual**:
- Mean response time improved by only 1.51ms
- Suggests window impact is ~1.5ms, not 4.3ms

**Revised Understanding**:
- The 2ms batching window may not add 2ms to every request
- First request in batch waits, subsequent requests don't
- Effective window overhead might be lower than theoretical maximum

### Hypothesis 3: Auto-Tune/Metrics Overhead is Variable

**Evidence**:
- v1.4.1 full (2.0ms): 204.74s
- Hybrid mode (2.0ms): 203.93s (0.81s faster)
- Phase 1 (1.0ms): 204.91s (same as v1.4.1)

**Conclusion**: Metrics overhead varies slightly between runs

---

## Recommendations

### 1. Run Extended Benchmark (100+ Questions)

To establish statistical significance, we need more samples:

```bash
# Proposed: 100-question benchmark
npm run bench:100-questions
```

**Expected Result**: Variance will average out, real improvements visible

### 2. Measure Actual Batching Window Impact

Instrument the GPU scheduler to measure:
- Actual wait time in batching window per request
- Percentage of requests that wait full window vs partial

### 3. Consider More Aggressive Window Reduction

If 1.0ms → 0.75ms shows similar behavior:
- Try 0.75ms or even 0.5ms
- Measure impact on crash rate (should remain 0%)

### 4. Implement Phase 2 (Fast-Path) for Clear Win

Fast-path optimization (skip window when queue empty) will show clearer improvement:
- Expected gain: 5-7% for sequential workloads
- Less sensitive to variance
- Easier to validate

---

## Baseline Comparison Matrix

| Metric | Baseline | v1.4.1 (2.0ms) | Phase 1 (1.0ms) | Hybrid (2.0ms) |
|--------|----------|----------------|-----------------|----------------|
| **Total Time** | 183.32s | 204.74s | 204.91s | 203.93s |
| **Overhead** | 0% | +11.7% | +11.8% | +11.3% |
| **Mean Response** | 406.20ms | 415.85ms | 414.34ms | 413.60ms |
| **TTFT** | 93.46ms | 104.99ms | 104.22ms | 103.28ms |
| **Throughput** | 123.18 tok/s | 120.27 tok/s | 120.72 tok/s | 120.92 tok/s |

**Best Configuration**: Hybrid mode (GPU Scheduler only, 2.0ms) at 203.93s

---

## Conclusions

### Phase 1 Status: ⚠️ **Marginal Improvement**

1. **Per-Request Metrics Improved**: Mean response time -1.51ms (-0.36%)
2. **Total Time Unchanged**: 204.91s vs 204.74s (+0.17s, within variance)
3. **Stability Maintained**: 100% success rate, zero crashes

### Root Cause Analysis

The expected 4-5% improvement didn't materialize because:
1. **Test variance** (±1.5s baseline) masks small improvements
2. **Batching window overhead was overestimated** (actual ~1.5ms, not 4.3ms)
3. **Sequential workload** doesn't fully utilize batching improvements

### Next Steps

1. ✅ **Keep Phase 1 changes** (1.0ms default is still better)
2. 🔄 **Run 100-question benchmark** to establish statistical significance
3. ⏭️ **Proceed to Phase 2 (Fast-Path)** for clearer performance win
4. 📊 **Instrument batching window** to measure actual overhead

### Expected v1.4.2 Performance (All Phases)

| Optimization | Expected Gain | Confidence |
|--------------|--------------|------------|
| **Phase 1 (1.0ms window)** | 0.4% | Medium (observed) |
| **Phase 2 (Fast-path)** | 3-5% | High |
| **Phase 3 (Adaptive window)** | 2-3% | Medium |
| **Total** | **5-8%** | Medium |

**Revised Target**: 5-8% overhead (vs 11% current), not 2.2% originally projected

---

## Benchmark Data

### Phase 1 (1.0ms window) - Full v1.4.1 Features

```
Configuration: MLX_GPU_SCHEDULER=on, MLX_AUTO_TUNE=on, MLX_METRICS_EXPORT=on
Default Window: 1.0ms

Mean Response Time:    414.34 ms
Median Response Time:  413.77 ms
P95 Latency:          424.50 ms
P99 Latency:          435.32 ms
Min:                  398.99 ms
Max:                  442.10 ms
Std Dev:               6.45 ms

Mean TTFT:            104.22 ms
Median TTFT:          103.19 ms
P95 TTFT:             113.40 ms
P99 TTFT:             125.05 ms

Mean Throughput:      120.72 tok/s
Median Throughput:    120.84 tok/s
P95 Throughput:       124.03 tok/s
P99 Throughput:       124.85 tok/s

Total Time:           204.91 s
Success Rate:         100% (50/50)
Total Tokens:         2,500
```

### Baseline (mlx-engine) - Current Run

```
Mean Response Time:    406.20 ms
Median Response Time:  404.56 ms
P95 Latency:          417.23 ms
P99 Latency:          452.25 ms
Min:                  390.96 ms
Max:                  457.56 ms
Std Dev:               14.68 ms

Mean TTFT:             93.46 ms
Median TTFT:           92.27 ms
P95 TTFT:             105.25 ms
P99 TTFT:             110.84 ms

Mean Throughput:      123.18 tok/s
Median Throughput:    123.59 tok/s
P95 Throughput:       126.60 tok/s
P99 Throughput:       127.46 tok/s

Total Time:           183.32 s
Success Rate:         100% (50/50)
Total Tokens:         2,500
```

---

**Generated by**: kr-serve-mlx v1.4.2 Phase 1 Analysis
**Timestamp**: 2025-11-05
**Test Data**: benchmarks/results/50-questions-comparison.json
