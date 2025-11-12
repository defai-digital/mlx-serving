# PRD: Week 2 - CPU Parallelization + Production Hardening

**Version**: v0.10.0
**Status**: Ready for Implementation
**Priority**: P1 (High Impact, Low Risk)
**Target Timeline**: Week 2 (7 days)
**Prerequisites**: Week 1 Complete (Metal optimizations)
**Owner**: Core Infrastructure Team
**Last Updated**: 2025-11-09

---

## Executive Summary

Week 2 builds on Week 1's Metal optimizations (+40-60% throughput) by adding **CPU-level parallelization** and **production-grade deployment infrastructure**. This week focuses on:

1. **Offloading non-GPU work to CPU** (tokenizer, preprocessing)
2. **Enhanced KV cache management** (MLX-level pooling)
3. **Production deployment infrastructure** (canary, A/B testing, auto-rollback)

### Goals

**Performance**:
- **+10-15% additional throughput** (offload CPU work from GPU path)
- **-10-15% end-to-end latency** (parallel tokenization)
- **+20-30% multi-turn latency reduction** (KV cache sharing)

**Production Readiness**:
- **Canary deployment system** (gradual rollout with auto-rollback)
- **A/B testing framework** (validate performance gains)
- **Automated regression detection** (alert on degradation)
- **Zero-downtime deployment** (rolling restart)

**Combined Target** (Week 1 + Week 2):
- **Week 1**: +40-60% (119-136 tok/s)
- **Week 2**: +10-15% additional
- **Total**: +54-84% (131-157 tok/s from 84.96 baseline)

### Principles

1. **Build on Week 1**: Leverage Metal optimizations
2. **Stability First**: All features feature-flagged, graceful fallback
3. **Production Safe**: Canary deployment, automated rollback
4. **Low-Medium Risk**: CPU parallelization is isolated from GPU
5. **User Control**: All features configurable and monitorable

---

## Background & Prerequisites

### Week 1 Deliverables (Prerequisites)

**Required from Week 1**:
- ✅ Metal Memory Pool (+10-15% throughput)
- ✅ Blit Queue I/O Overlap (-15-20% TTFT)
- ✅ Command Buffer Ring (+5-10% GPU util)
- ✅ Feature flag system
- ✅ Prometheus metrics
- ✅ 24-hour soak test passed

**Week 1 Performance Baseline**:
- Throughput: **119-136 tok/s** (assuming +40-60% from Week 1)
- TTFT: **10.2ms** (assuming -15% from Week 1)
- GPU Utilization: **77-80%** (assuming +5-10% from Week 1)

### Current Bottlenecks (After Week 1)

With Metal optimizations in place, new bottlenecks emerge:

```
Total Inference Time per Token: 9.17ms (after Week 1)
├─ Compute (GPU):           8.25ms (90%)  ← Fully utilized
├─ Tokenization (CPU):      0.65ms (7%)   ← NEW BOTTLENECK
├─ Memory/I/O (optimized):  0.15ms (2%)   ← Already optimized
└─ Other:                   0.12ms (1%)
```

**Key Insight**: GPU is now highly utilized. Further gains require **CPU parallelization** to keep GPU fed with tokens.

---

## Optimization 1: CPU-Parallelized Tokenizer

### Problem Statement

**Current Behavior**:
- Tokenizer runs in Python (single-threaded)
- Blocks GPU pipeline while tokenizing
- Sequential processing: tokenize request 1 → request 2 → request 3

**Impact**:
- Tokenization latency: ~0.65ms per request
- Under concurrent load (10 requests), tokenization becomes bottleneck
- GPU starvation during tokenization phase

### Solution: C++ Parallel Tokenizer

**Architecture**:
```cpp
// native/include/kr_parallel_tokenizer.h
class ParallelTokenizer {
public:
    // Multi-threaded encoding
    std::vector<int32_t> encode(const std::string& text, int num_threads = 4);

    // Batch encoding (process multiple requests concurrently)
    std::vector<std::vector<int32_t>> encodeBatch(
        const std::vector<std::string>& texts,
        int num_threads = 8
    );

    // Async encoding (non-blocking)
    std::future<std::vector<int32_t>> encodeAsync(const std::string& text);

private:
    // Use Apple Accelerate framework for vectorized operations
    void accelerateTokenize(const std::string& text);

    // Thread pool for parallel processing
    std::shared_ptr<ThreadPool> thread_pool_;
};
```

**Key Technologies**:
- **OpenMP**: Multi-threaded string processing
- **TBB (Threading Building Blocks)**: Task-based parallelism
- **Apple Accelerate**: Vectorized string operations (SIMD)
- **Thread Pool**: Reuse threads to avoid creation overhead

### Implementation Strategy

**Phase 1: C++ Tokenizer Core** (Day 1-2)
```cpp
// native/src/parallel_tokenizer.cpp
#include <omp.h>
#include <Accelerate/Accelerate.h>

std::vector<int32_t> ParallelTokenizer::encode(
    const std::string& text,
    int num_threads
) {
    // Split text into chunks
    auto chunks = splitTextChunks(text, num_threads);
    std::vector<std::vector<int32_t>> results(num_threads);

    #pragma omp parallel for num_threads(num_threads)
    for (int i = 0; i < chunks.size(); ++i) {
        results[i] = tokenizeChunk(chunks[i]);
    }

    // Merge results
    return mergeTokens(results);
}

std::vector<std::vector<int32_t>> ParallelTokenizer::encodeBatch(
    const std::vector<std::string>& texts,
    int num_threads
) {
    std::vector<std::vector<int32_t>> results(texts.size());

    #pragma omp parallel for num_threads(num_threads)
    for (int i = 0; i < texts.size(); ++i) {
        results[i] = encode(texts[i], 1);  // Single-threaded per text
    }

    return results;
}
```

**Phase 2: Python Bindings** (Day 2)
```cpp
// native/bindings/tokenizer_bindings.cpp
py::class_<ParallelTokenizer>(m, "ParallelTokenizer")
    .def(py::init<const std::string&>(),
         py::arg("tokenizer_path"),
         "Load tokenizer from file")

    .def("encode", &ParallelTokenizer::encode,
         py::arg("text"), py::arg("num_threads") = 4,
         "Encode text to token IDs")

    .def("encode_batch", &ParallelTokenizer::encodeBatch,
         py::arg("texts"), py::arg("num_threads") = 8,
         "Encode multiple texts in parallel");
```

**Phase 3: Integration** (Day 3)
```python
# python/models/tokenizer.py
from krserve_native import ParallelTokenizer

class MLXTokenizer:
    def __init__(self, tokenizer_path, use_cpp=True):
        if use_cpp:
            # Use C++ parallel tokenizer
            self.tokenizer = ParallelTokenizer(tokenizer_path)
        else:
            # Fallback to Python tokenizer
            self.tokenizer = load_python_tokenizer(tokenizer_path)

    def encode(self, text):
        config = get_config()
        if config.cpu_optimizations.parallel_tokenizer.enabled:
            return self.tokenizer.encode(
                text,
                num_threads=config.cpu_optimizations.parallel_tokenizer.num_threads
            )
        else:
            return self.tokenizer.encode(text)  # Fallback
```

### Expected Performance Gains

**Single Request**:
```
Current tokenization time: 0.65ms
With 4-thread parallelization: 0.25ms (60% reduction)

End-to-end latency reduction:
  = 0.65ms - 0.25ms = 0.40ms
  = 0.40ms / 9.17ms × 100% = 4.4%
```

**Batch Requests** (10 concurrent):
```
Current (sequential): 10 × 0.65ms = 6.5ms
With parallel batch: 1.2ms (92% reduction)

Throughput improvement under load:
  = (6.5ms - 1.2ms) / 9.17ms × 100% = 57.8% (during tokenization phase)
```

**Target**: **+10-12% end-to-end latency reduction**, **+15-20% throughput under concurrent load**

### Feature Configuration

```yaml
# config/runtime.yaml
cpu_optimizations:
  parallel_tokenizer:
    enabled: false               # DEFAULT: disabled for safety
    num_threads: 4               # Number of threads (default: 4)
    use_accelerate: true         # Use Apple Accelerate framework
    batch_mode: true             # Enable batch processing
    thread_pool_size: 8          # Thread pool size
    fallback_on_error: true      # Fallback to Python on error
```

---

## Optimization 2: Enhanced KV Cache Management

### Problem Statement

**Current Behavior**:
- KV cache managed at application level (TypeScript prompt cache)
- No sharing between similar prompts
- Each conversation creates new KV cache (even with identical prefix)
- Memory waste for multi-turn conversations

**Example** (chatbot scenario):
```
Turn 1: "You are a helpful assistant. User: Hello"
Turn 2: "You are a helpful assistant. User: Hello\nAssistant: Hi!\nUser: What's the weather?"
                                      ↑──────────────────────────↑
                                      Same prefix, KV cache could be shared
```

### Solution: MLX-Level KV Cache Pool

**Architecture**:
```python
# python/models/kv_cache_pool.py
class KVCachePool:
    def __init__(self, max_sequences=100, max_tokens_per_seq=8192):
        self.pool = {}  # fingerprint -> KVCache
        self.lru = []   # LRU tracking
        self.max_sequences = max_sequences
        self.max_tokens_per_seq = max_tokens_per_seq

    def get_or_create(self, prompt_fingerprint, model_id):
        """Get cached KV or create new"""
        if prompt_fingerprint in self.pool:
            # Hit: Reuse cached KV
            self.lru.remove(prompt_fingerprint)
            self.lru.append(prompt_fingerprint)
            return self.pool[prompt_fingerprint]
        else:
            # Miss: Create new KV cache
            if len(self.pool) >= self.max_sequences:
                self.evict_lru()

            kv_cache = self.create_kv_cache(model_id)
            self.pool[prompt_fingerprint] = kv_cache
            self.lru.append(prompt_fingerprint)
            return kv_cache

    def share_prefix(self, prompt1_fingerprint, prompt2_fingerprint):
        """Share KV cache for common prefix"""
        kv1 = self.pool.get(prompt1_fingerprint)
        kv2 = self.pool.get(prompt2_fingerprint)

        if kv1 and kv2:
            # Find common prefix length
            common_length = self.find_common_prefix_length(kv1, kv2)

            # Share KV cache up to common prefix
            if common_length > 0:
                return kv1[:common_length]  # Reuse prefix

        return None

    def evict_lru(self):
        """Evict least recently used KV cache"""
        if self.lru:
            evicted = self.lru.pop(0)
            del self.pool[evicted]
```

### Integration with MLX

```python
# python/models/generator.py
class MLXGenerator:
    def __init__(self, model):
        self.model = model
        self.kv_cache_pool = KVCachePool()

    def generate(self, prompt, conversation_id=None):
        # Generate fingerprint (conversation prefix)
        if conversation_id:
            fingerprint = hash(conversation_id + prompt[:200])  # Prefix fingerprint
        else:
            fingerprint = hash(prompt)

        # Get or create KV cache
        kv_cache = self.kv_cache_pool.get_or_create(fingerprint, self.model.id)

        # Generate with cached KV
        for token in self.model.generate(prompt, kv_cache=kv_cache):
            yield token
```

### Expected Performance Gains

**Multi-Turn Conversations**:
```
Turn 1: Full inference (no cached KV)
  Time: 9.17ms per token

Turn 2: Reuse KV cache for prefix (e.g., system prompt + first turn)
  Prefix length: 100 tokens
  Time saved: 100 tokens × 9.17ms = 917ms
  New time: 917ms saved + (new tokens × 9.17ms)

  For 100-token prefix:
    Latency reduction: ~900ms
    Percentage: ~30-40% for multi-turn

Turn 3+: Cumulative savings increase
```

**Target**: **+20-30% multi-turn latency reduction**, **+15-20% memory efficiency**

### Feature Configuration

```yaml
# config/runtime.yaml
cpu_optimizations:
  kv_cache_pool:
    enabled: false               # DEFAULT: disabled for safety
    max_sequences: 100           # Maximum cached sequences
    max_tokens_per_sequence: 8192 # Max tokens per KV cache
    prefix_matching: true        # Enable prefix sharing
    lru_eviction: true           # LRU eviction policy
    memory_limit_mb: 2048        # Memory limit for KV cache pool (2GB)
```

---

## Production Infrastructure

### Component 1: Canary Deployment System

**Purpose**: Gradually roll out optimizations with automated rollback on performance degradation.

**Architecture**:
```typescript
// src/canary/canary-router.ts
class CanaryRouter {
  private baselineEngine: Engine;
  private canaryEngine: Engine;
  private trafficSplit: number = 0.10;  // 10% canary traffic

  async route(request: GenerateRequest): Promise<AsyncIterator> {
    // Deterministic routing based on request hash
    const hash = this.hashRequest(request);
    const useCanary = (hash % 100) < (this.trafficSplit * 100);

    if (useCanary) {
      return this.canaryEngine.generate(request);
    } else {
      return this.baselineEngine.generate(request);
    }
  }

  async comparePerformance(): Promise<ComparisonReport> {
    const baselineMetrics = await this.baselineEngine.getMetrics();
    const canaryMetrics = await this.canaryEngine.getMetrics();

    return {
      baseline: baselineMetrics,
      canary: canaryMetrics,
      regression: this.detectRegression(baselineMetrics, canaryMetrics),
      recommendation: this.shouldRollback(baselineMetrics, canaryMetrics)
        ? 'ROLLBACK'
        : 'CONTINUE',
    };
  }
}
```

**Rollback Criteria**:
```typescript
function shouldRollback(baseline: Metrics, canary: Metrics): boolean {
  // Rollback if canary is >5% worse than baseline
  const throughputRegression = (
    (baseline.throughput - canary.throughput) / baseline.throughput
  );

  const ttftRegression = (
    (canary.ttft - baseline.ttft) / baseline.ttft
  );

  return (
    throughputRegression > 0.05 ||  // >5% throughput drop
    ttftRegression > 0.10 ||        // >10% TTFT increase
    canary.errorRate > 0.01         // >1% error rate
  );
}
```

**Gradual Rollout Schedule**:
```
Stage 1: 10% traffic → Monitor 24h → Validate
Stage 2: 25% traffic → Monitor 24h → Validate
Stage 3: 50% traffic → Monitor 24h → Validate
Stage 4: 100% traffic → Monitor 48h → Complete
```

### Component 2: A/B Testing Framework

**Purpose**: Validate performance improvements with statistical significance.

```typescript
// src/testing/ab-test-framework.ts
class ABTestFramework {
  async runABTest(
    configA: EngineConfig,  // Baseline
    configB: EngineConfig,  // Optimized
    sampleSize: number = 1000
  ): Promise<ABTestResult> {
    const resultsA = await this.runBenchmark(configA, sampleSize);
    const resultsB = await this.runBenchmark(configB, sampleSize);

    // Statistical significance test (t-test)
    const tTest = this.tTest(resultsA.throughput, resultsB.throughput);

    return {
      configA: resultsA,
      configB: resultsB,
      improvement: (resultsB.throughput - resultsA.throughput) / resultsA.throughput,
      pValue: tTest.pValue,
      significant: tTest.pValue < 0.05,  // 95% confidence
      recommendation: this.generateRecommendation(resultsA, resultsB, tTest),
    };
  }

  private tTest(samplesA: number[], samplesB: number[]): TTestResult {
    // Welch's t-test for unequal variances
    const meanA = this.mean(samplesA);
    const meanB = this.mean(samplesB);
    const varA = this.variance(samplesA);
    const varB = this.variance(samplesB);

    const tStatistic = (meanB - meanA) / Math.sqrt(varA / samplesA.length + varB / samplesB.length);
    const pValue = this.tDistribution(tStatistic, samplesA.length + samplesB.length - 2);

    return { tStatistic, pValue, significant: pValue < 0.05 };
  }
}
```

**Usage**:
```bash
# Run A/B test
npx tsx src/testing/ab-test.ts \
  --baseline=config/baseline.yaml \
  --optimized=config/week2-optimized.yaml \
  --samples=1000

# Output:
# A/B Test Results:
# Baseline:   119.5 tok/s (±2.3)
# Optimized:  138.7 tok/s (±2.8)
# Improvement: +16.1% (p < 0.001) ✅ SIGNIFICANT
# Recommendation: DEPLOY
```

### Component 3: Automated Regression Detection

**Purpose**: Continuously monitor for performance degradation.

```typescript
// src/monitoring/regression-detector.ts
class RegressionDetector {
  private baselineMetrics: PerformanceMetrics;
  private alertThresholds = {
    throughputDrop: 0.05,    // >5% throughput drop
    ttftIncrease: 0.10,      // >10% TTFT increase
    p99Increase: 0.15,       // >15% P99 latency increase
    errorRateIncrease: 0.01, // >1% error rate
  };

  async detect(): Promise<RegressionAlert[]> {
    const currentMetrics = await this.collectCurrentMetrics();
    const alerts: RegressionAlert[] = [];

    // Throughput check
    const throughputDrop = (
      (this.baselineMetrics.throughput - currentMetrics.throughput) /
      this.baselineMetrics.throughput
    );

    if (throughputDrop > this.alertThresholds.throughputDrop) {
      alerts.push({
        severity: 'CRITICAL',
        metric: 'throughput',
        baseline: this.baselineMetrics.throughput,
        current: currentMetrics.throughput,
        degradation: throughputDrop,
        recommendation: 'IMMEDIATE_ROLLBACK',
      });
    }

    // TTFT check
    const ttftIncrease = (
      (currentMetrics.ttft - this.baselineMetrics.ttft) /
      this.baselineMetrics.ttft
    );

    if (ttftIncrease > this.alertThresholds.ttftIncrease) {
      alerts.push({
        severity: 'WARNING',
        metric: 'ttft',
        baseline: this.baselineMetrics.ttft,
        current: currentMetrics.ttft,
        degradation: ttftIncrease,
        recommendation: 'INVESTIGATE',
      });
    }

    return alerts;
  }

  async autoRollback(alert: RegressionAlert): Promise<void> {
    if (alert.recommendation === 'IMMEDIATE_ROLLBACK') {
      // Disable problematic optimizations
      await this.disableOptimizations(alert.metric);

      // Notify team
      await this.sendAlert(alert);

      // Log rollback
      logger.critical(`Auto-rollback triggered: ${alert.metric} degraded by ${alert.degradation * 100}%`);
    }
  }
}
```

**Prometheus Alerting Rules**:
```yaml
# prometheus/alerts/regression-detection.yml
groups:
  - name: performance_regression
    rules:
      # Throughput regression
      - alert: ThroughputRegression
        expr: |
          (
            (rate(tokens_generated[5m]) / rate(requests_total[5m]))
            -
            (rate(tokens_generated[1h] offset 1h) / rate(requests_total[1h] offset 1h))
          ) / (rate(tokens_generated[1h] offset 1h) / rate(requests_total[1h] offset 1h))
          < -0.05
        for: 5m
        annotations:
          summary: "Throughput dropped >5% from baseline"
          action: "Auto-rollback triggered"

      # TTFT regression
      - alert: TTFTRegression
        expr: |
          (
            histogram_quantile(0.50, ttft_ms[5m])
            -
            histogram_quantile(0.50, ttft_ms[1h] offset 1h)
          ) / histogram_quantile(0.50, ttft_ms[1h] offset 1h)
          > 0.10
        for: 5m
        annotations:
          summary: "TTFT increased >10% from baseline"
          action: "Investigation required"
```

---

## Testing Strategy

### Unit Tests (30+ tests)

**CPU Parallel Tokenizer**:
- ✅ Single-threaded encoding correctness
- ✅ Multi-threaded encoding correctness
- ✅ Batch encoding correctness
- ✅ Thread safety
- ✅ Performance comparison (C++ vs Python)
- ✅ Fallback on error

**KV Cache Pool**:
- ✅ Cache creation and retrieval
- ✅ LRU eviction
- ✅ Prefix sharing correctness
- ✅ Memory limit enforcement
- ✅ Thread safety

**Canary Router**:
- ✅ Traffic splitting correctness
- ✅ Deterministic routing (same request → same engine)
- ✅ Performance comparison
- ✅ Rollback logic

### Integration Tests (20+ tests)

**End-to-End with Real Workloads**:
- ✅ Parallel tokenizer with real inference
- ✅ KV cache pool with multi-turn conversations
- ✅ Canary deployment with gradual rollout
- ✅ A/B testing framework
- ✅ Automated regression detection

### Performance Benchmarks

**Tokenizer Benchmark**:
```bash
npx tsx benchmarks/tokenizer-benchmark.ts \
  --baseline=python \
  --optimized=cpp \
  --samples=1000

# Expected:
# Python:  0.65ms avg
# C++:     0.25ms avg (-60%)
# Improvement: +4.4% end-to-end latency
```

**KV Cache Benchmark**:
```bash
npx tsx benchmarks/kv-cache-benchmark.ts \
  --multi-turn=true \
  --turns=5

# Expected:
# Without cache: 917ms per turn
# With cache:    550ms per turn (-40% for turns 2+)
```

---

## Week 2 Success Metrics

### Performance Targets

| Metric | Week 1 Baseline | Week 2 Target | Measurement |
|--------|-----------------|---------------|-------------|
| **Throughput** | 119-136 tok/s | 131-157 tok/s | +10-15% |
| **TTFT** | 10.2ms | 8.7-9.2ms | -10-15% |
| **Multi-turn Latency** | 9.17ms/tok | 6.4-7.3ms/tok | -20-30% |
| **Concurrent Throughput** | TBD | +15-20% | Under 10 concurrent |

### Quality Targets

- ✅ **0 crashes** (24-hour soak test)
- ✅ **0 regressions** (A/B test validation)
- ✅ **530+ tests passing** (520 → 530+)
- ✅ **Canary rollout successful** (4-stage deployment)

### Production Targets

- ✅ **Canary deployment system** operational
- ✅ **A/B testing framework** validated
- ✅ **Automated regression detection** active
- ✅ **Zero-downtime deployment** verified

---

## Rollout Plan

### Stage 1: Development (Day 1-5)

**Day 1-3**: CPU Parallelization
- Parallel tokenizer implementation (C++)
- Enhanced KV cache pool (Python)
- Unit tests

**Day 4-5**: Production Infrastructure
- Canary deployment system
- A/B testing framework
- Regression detection

### Stage 2: Testing (Day 6)

- Integration tests (all components)
- Performance benchmarks
- 24-hour soak test (with Week 1 + Week 2 optimizations)

### Stage 3: Deployment (Day 7)

- Canary deployment (4-stage rollout)
- A/B test validation
- Documentation

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tokenizer correctness | Low | High | Extensive unit tests, validate against Python |
| KV cache memory leak | Low | Medium | RAII pattern, memory monitoring |
| Canary routing bugs | Low | Medium | Deterministic routing, extensive testing |
| Performance regression | Low | High | A/B testing, automated rollback |

---

## Conclusion

**Week 2** delivers:
1. ✅ **+10-15% additional performance** (CPU parallelization)
2. ✅ **Production deployment infrastructure** (canary, A/B, rollback)
3. ✅ **Safety & stability** (automated regression detection)

**Combined (Week 1 + Week 2)**: **+54-84% total improvement** (131-157 tok/s)

**Ready to Execute**: Week 2 Action Plan follows.
