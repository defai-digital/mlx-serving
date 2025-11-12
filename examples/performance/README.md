# Performance Examples

**Week 7 optimization examples for mlx-serving**

---

## Overview

This directory contains working examples demonstrating Week 7 performance optimizations:

1. **[Model Preloading](./01-model-preloading.ts)** - Zero first-request latency
2. **[Object Pooling](./02-object-pooling.ts)** - 20% GC reduction
3. **[Adaptive Batching](./03-adaptive-batching.ts)** - Dynamic throughput optimization

**Expected Performance Gains**:
- **TTFT**: 12.5% faster
- **Throughput**: 20% improvement
- **First Request**: 104x faster (5,200ms → 50ms with preloading)

---

## Prerequisites

```bash
# Install package
npm install @defai.digital/mlx-serving

# Setup Python environment
npm run setup
```

**Requirements**:
- macOS 26.0+ (Darwin 25.0.0+)
- Apple Silicon M3 or newer
- Node.js 22.0.0+
- Python 3.11-3.12

---

## Running Examples

```bash
# Model preloading example
npx tsx examples/performance/01-model-preloading.ts

# Object pooling example
npx tsx examples/performance/02-object-pooling.ts

# Adaptive batching example
npx tsx examples/performance/03-adaptive-batching.ts
```

---

## Example 1: Model Preloading

**File**: [01-model-preloading.ts](./01-model-preloading.ts)

**What it demonstrates**:
- Configuring model preloading via runtime.yaml
- Zero first-request latency
- Warmup request configuration

**Performance gain**: 104x faster first request (5,200ms → 50ms)

**Key configuration**:
```yaml
# config/runtime.yaml
model_preload:
  enabled: true
  models:
    - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"
      warmup_requests: 3
      max_tokens: 10
```

---

## Example 2: Object Pooling

**File**: [02-object-pooling.ts](./02-object-pooling.ts)

**What it demonstrates**:
- Using ObjectPool for efficient object reuse
- Reducing garbage collection pressure
- Pool statistics and monitoring

**Performance gain**: 20% GC reduction

**Key API**:
```typescript
import { ObjectPool } from '@defai.digital/mlx-serving';

const pool = new ObjectPool<MyObject>(
  () => createObject(),      // Factory function
  (obj) => resetObject(obj), // Reset function
  { maxSize: 100 }
);

const obj = pool.acquire();
// ... use object ...
pool.release(obj);
```

---

## Example 3: Adaptive Batching

**File**: [03-adaptive-batching.ts](./03-adaptive-batching.ts)

**What it demonstrates**:
- Configuring adaptive batching
- Dynamic batch sizing based on latency/throughput
- Monitoring batch queue statistics

**Performance gain**: 10-15% throughput improvement

**Key configuration**:
```yaml
# config/runtime.yaml
batch_queue:
  enabled: true
  adaptive_sizing: true
  target_latency_ms: 100
  min_batch_size: 1
  max_batch_size: 8
```

---

## Configuration Reference

All examples use configuration from `config/runtime.yaml`. Edit this file to customize behavior:

```yaml
# Week 7 Performance Optimizations
model_preload:
  enabled: true
  models:
    - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"
      warmup_requests: 3
      max_tokens: 10
  parallel: true
  max_parallel: 2
  fail_fast: false

batch_queue:
  enabled: true
  adaptive_sizing: true
  target_latency_ms: 100
  min_batch_size: 1
  max_batch_size: 8
  window_size: 100
```

---

## Performance Monitoring

### Benchmarking

```bash
# Quick benchmark (10 questions)
npm run bench:quick

# Full benchmark (100 questions)
npm run bench:compare

# Custom benchmark
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Llama-3.2-3B-Instruct-4bit" \
  --questions 50 \
  --max-tokens 100
```

### Metrics Collection

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

// Get preload statistics
const preloadStats = engine.getPreloadStats();
console.log('Preloaded models:', preloadStats.preloadedModels);

// Get batch queue statistics
const batchStats = engine.getBatchQueueStats();
console.log('Avg batch size:', batchStats.avgBatchSize);
console.log('Throughput:', batchStats.throughput);
```

---

## Troubleshooting

### Model not preloading

**Issue**: First request still has 5+ second latency

**Solution**:
1. Check `config/runtime.yaml` has `model_preload.enabled: true`
2. Verify model_id matches exactly
3. Check logs for preload errors:
   ```typescript
   const engine = await createEngine({ verbose: true });
   ```

### Object pool not reducing GC

**Issue**: Still seeing high GC pressure

**Solution**:
1. Increase pool size: `maxSize: 200`
2. Enable preallocation: `preallocate: 50`
3. Monitor with: `pool.getStats()`

### Adaptive batching not improving throughput

**Issue**: No throughput gain with batching enabled

**Solution**:
1. Increase concurrent requests (batching needs load)
2. Adjust `target_latency_ms` (try 150-200ms)
3. Check batch size: `engine.getBatchQueueStats().avgBatchSize`

---

## Additional Resources

- **[Performance Guide](../../docs/PERFORMANCE.md)** - Complete Week 7 optimization guide
- **[Production Features](../../docs/PRODUCTION_FEATURES.md)** - Enterprise features (TTFT, QoS)
- **[Quick Start](../../docs/QUICK_START.md)** - 5-minute getting started guide
- **[Documentation Index](../../docs/INDEX.md)** - Full documentation hub

---

**Last Updated**: 2025-11-10
**Version**: 0.8.0
