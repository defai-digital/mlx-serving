# Phase 5 Performance Optimization Guide

**Version:** 0.1.0-alpha.1
**Last Updated:** 2025-01-08
**Status:** Week 2 Complete (Benchmarking), Week 3-4 In Progress

---

## Table of Contents

- [Overview](#overview)
- [Current Status](#current-status)
- [Performance Benchmarking](#performance-benchmarking)
- [Feature Flags](#feature-flags)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## Overview

Phase 5 focuses on performance validation, optimization, and production rollout of mlx-serving. This guide covers the benchmarking tools, performance analysis, and gradual rollout strategies.

### What Phase 5 Provides

**Week 1 (Completed):**
- Feature flag infrastructure for gradual rollout
- TTFT (Time To First Token) Pipeline foundations
- QoS (Quality of Service) Policy Engine foundations
- Integration test framework

**Week 2 (Completed):**
- **TTFT Benchmark:** 1000+ sample statistical analysis
- **Throughput Benchmark:** 10-minute sustained load testing
- **Stress Test:** Breaking point identification
- **Regression Check:** Automated validation against baseline

**Week 3 (In Progress):**
- Documentation
- 1% Canary rollout infrastructure

**Week 4 (Planned):**
- Gradual rollout: 10% → 50% → 100%

### Performance Targets

| Metric | Target | Stretch Goal |
|--------|--------|--------------|
| TTFT P95 | ≤ 550ms | ≤ 400ms |
| Throughput | ≥ 130 req/s | ≥ 150 req/s |
| Concurrency | ≥ 75 concurrent | ≥ 100 concurrent |
| Error Rate | < 1% | < 0.5% |
| CPU Utilization | < 80% | < 70% |

---

## Current Status

### Implemented Components

✅ **Feature Flags System** (`src/config/feature-flag-loader.ts`)
- Hash-based percentage rollout
- Environment variable override
- Configuration file support

✅ **Performance Benchmarks** (`benchmarks/phase5/`)
- TTFT Benchmark (full + quick)
- Throughput Benchmark (full + quick)
- Stress Test
- Regression Check

✅ **Benchmark Utilities** (`benchmarks/utils.ts`, `benchmarks/types.ts`)
- Statistical analysis (P50/P95/P99, confidence intervals)
- Result formatting and export
- Progress tracking

### In Progress

⏳ **TTFT Pipeline** (Week 3)
- Warmup queue for tokenizer preloading
- Speculative execution
- KV cache prefetch

⏳ **QoS Policy Engine** (Week 3)
- Policy evaluation
- Remediation actions
- Circuit breakers

⏳ **Canary Rollout** (Week 3-4)
- 1% canary deployment
- Monitoring dashboard
- Automated rollback

---

## Performance Benchmarking

### Quick Start

Run all quick benchmarks (~15 minutes total):

```bash
# TTFT quick test (5-10 min)
npx tsx benchmarks/phase5/ttft-benchmark-quick.ts

# Throughput quick test (1-2 min)
npx tsx benchmarks/phase5/throughput-benchmark-quick.ts

# Regression check (3-5 min)
npx tsx benchmarks/phase5/regression-check.ts
```

### Full Benchmark Suite

Run comprehensive benchmarks (~4 hours total):

```bash
# TTFT full benchmark (2-4 hours)
npx tsx benchmarks/phase5/ttft-benchmark.ts

# Throughput full benchmark (22 minutes)
npx tsx benchmarks/phase5/throughput-benchmark.ts

# Stress test (10-30 minutes)
npx tsx benchmarks/phase5/stress-test.ts

# Regression check (5 minutes)
npx tsx benchmarks/phase5/regression-check.ts
```

### Understanding Benchmark Results

#### TTFT Benchmark

Measures Time To First Token across 1000+ samples:

```
=== TTFT Benchmark Results ===

Phase           Mean      Median    P95       P99       Min       Max       StdDev
------------------------------------------------------------------------------------------------
Baseline        523ms     498ms     687ms     801ms     421ms     912ms     89ms
Phase 5         401ms     386ms     521ms     598ms     325ms     645ms     68ms

=== Improvement ===
P95 TTFT: -166ms (-24.2%) ✅ PASSED (target: ≤550ms)
```

**Key Metrics:**
- **P95 TTFT:** 95% of requests complete first token in this time
- **Mean:** Average time across all samples
- **StdDev:** Consistency of performance (lower is better)

**Success Criteria:**
- P95 ≤ 550ms (target)
- P95 ≤ 400ms (stretch goal)
- Improvement ≥ 10% over baseline

#### Throughput Benchmark

Measures sustained throughput over 10 minutes:

```
=== Throughput Benchmark Results ===

Metric               Baseline    Phase 5     Improvement
-----------------------------------------------------------
Avg Req/s           118.3       128.3       +8.5%       ✓
Peak Concurrent     68          78          +14.7%      ✓
Avg Latency (ms)    687         523         -23.9%      ✓
P95 Latency (ms)    892         634         -28.9%      ✓
Error Rate          1.2%        0.3%        -75.0%      ✓
Avg CPU %           72.3%       68.1%       -5.8%       ✓
```

**Key Metrics:**
- **Req/s:** Actual throughput achieved
- **Concurrent:** Number of simultaneous streams handled
- **Latency:** Time from request to completion
- **Error Rate:** Percentage of failed requests

**Success Criteria:**
- Sustained throughput ≥ 130 req/s
- Peak concurrency ≥ 75
- CPU < 80%
- Error rate < 1%

#### Stress Test

Gradually increases load to find breaking point:

```
=== Stress Test Results ===

Level  Req/s   Requests  Errors   P95 Lat   Peak Conc   CPU     Memory    Status
------------------------------------------------------------------------------------
  0       50       1500     0.0%     421ms          48    62.3%    2,456MB  ✓ OK
  1       70       2100     0.1%     487ms          67    68.7%    2,678MB  ✓ OK
  2       90       2700     0.3%     523ms          86    73.2%    2,891MB  ✓ OK
  3      110       3300     0.8%     598ms         105    78.9%    3,123MB  ⚠ ERR
  4      130       3900     2.1%     734ms         124    84.5%    3,456MB  ⚠ ERR
  5      150       4500     5.7%     912ms         143    89.2%    3,789MB  ⚠ DEGR
  6      170       5100    12.3%    1,234ms        161    94.1%    4,123MB  ⚠ DEGR

=== Breaking Point ===
Maximum sustainable throughput: 150 req/s
Breaking point: 170 req/s
Failure mode: resource_exhaustion
```

**Failure Modes:**
- `out_of_memory`: Memory usage > 90%
- `timeout`: Timeout errors > 5%
- `high_error_rate`: Error rate > 10%
- `resource_exhaustion`: CPU > 95%
- `crash`: System crashes

**What to Do:**
- **OOM:** Reduce model size or batch size
- **Timeout:** Optimize inference latency
- **High Error Rate:** Check request validation
- **Resource Exhaustion:** Reduce concurrency or scale horizontally
- **Crash:** Check logs for segfaults or exceptions

#### Regression Check

Validates no performance degradation:

```
=== Regression Check Results ===

Metric          Baseline    Current     Delta      % Change   Status
------------------------------------------------------------------------------
TTFT P50        450ms       438ms       -12ms      -2.7%      ✓ PASS
TTFT P95        650ms       623ms       -27ms      -4.2%      ✓ PASS
TTFT P99        800ms       791ms        -9ms      -1.1%      ✓ PASS
TTFT Mean       480ms       467ms       -13ms      -2.7%      ✓ PASS

=== Overall Result ===
Status: ✓ PASSED - No regressions detected
```

**Tolerance:** ±10% threshold for all metrics

**Exit Codes:**
- `0`: All checks passed
- `1`: Regressions detected (fails CI/CD)

**CI/CD Integration:**
```bash
npx tsx benchmarks/phase5/regression-check.ts
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ Regression detected! Blocking deployment."
  exit 1
fi
```

---

## Feature Flags

### Overview

Feature flags enable gradual rollout and A/B testing of Phase 5 optimizations.

### Configuration

**Environment Variables:**
```bash
# Enable Phase 5 features
export PHASE5_ENABLED=true

# Enable specific features
export PHASE5_TTFT_ENABLED=true
export PHASE5_QOS_ENABLED=true

# Rollout percentage (0-100)
export PHASE5_ROLLOUT_PERCENT=10
```

**Configuration File:** `config/feature-flags.yaml`
```yaml
phase5:
  enabled: true
  rollout_percentage: 10

ttft_pipeline:
  enabled: true
  rollout_percentage: 100

qos_policy:
  enabled: true
  dry_run: true  # Log actions without executing
```

### Hash-Based Rollout

Feature flags use MD5 hash of request ID for deterministic rollout:

```typescript
import { isFeatureEnabled } from './src/config/feature-flag-loader.js';

// Check if feature is enabled for this request
if (isFeatureEnabled('phase5', requestId)) {
  // Use Phase 5 optimizations
} else {
  // Use baseline behavior
}
```

**Properties:**
- Deterministic: Same request ID always gets same result
- Sticky: Users don't flip between versions
- Gradual: Increase percentage over time

### Canary Deployment Strategy

**Week 3:**
1. Deploy with 1% rollout
2. Monitor metrics for 24 hours
3. Compare canary vs baseline
4. Rollback if regressions detected

**Week 4:**
1. Increase to 10% (Day 1-2)
2. Increase to 50% (Day 3-4)
3. Increase to 100% (Day 5)

**Automated Rollback Triggers:**
- Error rate > 2x baseline
- P95 latency > 1.5x baseline
- Memory growth > 20%/hour
- Crash rate > 0.1%

---

## Performance Tuning

### Model Selection

Choose model size based on throughput requirements:

| Model | Size | TTFT P95 | Throughput | Best For |
|-------|------|----------|------------|----------|
| gemma-2-2b-it-4bit | 2B | ~350ms | 200+ req/s | High throughput |
| gemma-2-9b-it-4bit | 9B | ~450ms | 150 req/s | Balanced |
| gemma-2-27b-it-4bit | 27B | ~650ms | 80 req/s | Quality |
| qwen3-30b-4bit | 30B | ~750ms | 60 req/s | Maximum quality |

### Concurrency Tuning

Adjust based on available resources:

```typescript
// config/runtime.yaml
streaming:
  maxConcurrentStreams: 100  # Adjust based on CPU cores
  batchSize: 4               # Adjust based on memory
```

**Guidelines:**
- **CPU-bound:** Reduce `maxConcurrentStreams`
- **Memory-bound:** Reduce `batchSize`
- **GPU-bound:** Reduce both or use smaller model

### Memory Management

**Prevent OOM:**
```yaml
model_cache:
  maxModels: 3           # Limit cached models
  evictionPolicy: LRU    # Evict least recently used

streaming:
  requestTimeout: 30000  # Kill slow requests (ms)
  maxTokens: 2048        # Limit response length
```

**Monitor Memory:**
```bash
# Watch memory usage
watch -n 1 'ps aux | grep mlx-serving'

# Check for leaks
node --expose-gc --max-old-space-size=4096 dist/index.js
```

---

## Troubleshooting

### Common Issues

#### High Latency

**Symptoms:** P95 > 1000ms

**Causes:**
- Model too large for hardware
- Too many concurrent requests
- Disk I/O bottleneck (model loading)

**Solutions:**
```bash
# Use smaller model
export MODEL_PATH="mlx-community/gemma-2-2b-it-4bit"

# Reduce concurrency
export MAX_CONCURRENT=50

# Preload model at startup
export PRELOAD_MODEL=true
```

#### Low Throughput

**Symptoms:** < 100 req/s

**Causes:**
- Insufficient concurrency
- Slow tokenization
- Network bottleneck

**Solutions:**
```yaml
# Increase concurrency
streaming:
  maxConcurrentStreams: 150

# Enable batching
batching:
  enabled: true
  maxBatchSize: 8
```

#### Memory Leaks

**Symptoms:** Memory grows continuously

**Causes:**
- Unclosed streams
- Cached responses not evicted
- EventEmitter listeners not removed

**Solutions:**
```bash
# Enable GC logging
node --trace-gc dist/index.js

# Force GC periodically
node --expose-gc dist/index.js

# Monitor with heapdump
npm install heapdump
node --require heapdump dist/index.js
```

#### Benchmark Failures

**TTFT Benchmark:**
```bash
# Model not found
python -c "from mlx_lm import load; load('mlx-community/gemma-2-27b-it-4bit')"

# Reduce samples for quick test
# Edit ttft-benchmark.ts: samples: 100 (instead of 1000)
```

**Throughput Benchmark:**
```bash
# Throughput below target
# Lower target rate
# Edit throughput-benchmark.ts: targetRequestsPerSecond: 100
```

**Stress Test:**
```bash
# Breaks immediately
# Lower starting rate
# Edit stress-test.ts: startingRequestsPerSecond: 30
```

---

## Roadmap

### Week 3 (Current)

**Day 1-2: Documentation**
- ✅ Performance Guide
- ⏳ API Reference
- ⏳ Migration Guide
- ⏳ Troubleshooting Guide

**Day 3-4: Canary Infrastructure**
- Implement 1% rollout mechanism
- Create monitoring dashboard
- Define rollback triggers
- Set up alerts

**Day 5: Canary Validation**
- Deploy 1% canary
- Monitor for 24 hours
- Validate metrics
- Document findings

### Week 4 (Planned)

**Day 1-2: 10% Rollout**
- Increase rollout to 10%
- Monitor error rates
- Validate performance
- Adjust if needed

**Day 3-4: 50% Rollout**
- Increase rollout to 50%
- Full performance validation
- User feedback collection
- Final tuning

**Day 5: 100% Rollout**
- Increase rollout to 100%
- Remove feature flags
- Update documentation
- Celebrate! 🎉

### Post-Launch

**Continuous Monitoring:**
- Daily performance reports
- Weekly trend analysis
- Monthly capacity planning
- Quarterly optimization reviews

**Future Optimizations:**
- Multi-GPU support
- Request coalescing
- Speculative decoding
- KV cache sharing

---

## Additional Resources

### Documentation

- [Phase 5 Benchmark README](../benchmarks/phase5/README.md) - Detailed benchmark guide
- [Architecture Documentation](./ARCHITECTURE.md) - System architecture
- [Testing Guide](./TESTING.md) - Testing strategies
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment

### Planning Documents

- [Phase 5 Master Plan](../automatosx/tmp/PHASE5-MASTER-IMPLEMENTATION-PLAN.md)
- [Week 1 Status](../automatosx/tmp/PHASE5-WEEK1-DAY1-2-STATUS.md)
- [Week 2 Final Status](../automatosx/tmp/PHASE5-WEEK2-FINAL-STATUS.md)

### Benchmark Results

- `benchmarks/results/` - JSON results from all benchmarks
- `automatosx/tmp/` - Status reports and analysis

---

## Support

### Getting Help

**Issues:** https://github.com/your-org/mlx-serving/issues
**Discussions:** https://github.com/your-org/mlx-serving/discussions
**Email:** support@your-org.com

### Contributing

We welcome contributions to Phase 5! See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

**Priority Areas:**
- Additional benchmark scenarios
- Performance optimizations
- Documentation improvements
- Bug fixes

---

**Document Status:** DRAFT
**Next Review:** End of Week 3
**Maintained By:** Phase 5 Team
