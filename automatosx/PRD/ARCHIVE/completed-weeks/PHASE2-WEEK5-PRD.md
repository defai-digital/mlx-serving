# Phase 2 Week 5: Performance Benchmarks & End-to-End Testing - PRD

**Project**: mlx-serving Distributed Inference
**Phase**: Phase 2 - Enhancement & Optimization
**Week**: Week 5 of 13 (Week 8 overall)
**Status**: Ready for Implementation
**Version**: 1.0.0
**Date**: 2025-11-10

---

## Executive Summary

**Goal**: Comprehensive performance benchmarking and end-to-end testing to validate Phase 2 Week 1-4 improvements, identify bottlenecks, and optimize the distributed inference system for production deployment.

**Impact**:
- Validate 40-60% latency improvement from sticky sessions
- Validate 90% cold-start reduction from pre-warming
- Validate 2-3x throughput improvement from batching
- Identify and fix performance bottlenecks
- Establish performance baselines for monitoring
- Validate system reliability under load

**Scope**:
- Sticky session latency benchmarks
- Pre-warming cold-start benchmarks
- Continuous batching throughput benchmarks
- End-to-end cluster tests (100+ concurrent requests)
- Load testing and stress testing
- Performance optimization based on results
- Comprehensive performance report

---

## Table of Contents

- [Background](#background)
- [Goals & Non-Goals](#goals--non-goals)
- [Technical Design](#technical-design)
- [Benchmark Specifications](#benchmark-specifications)
- [Testing Strategy](#testing-strategy)
- [Success Criteria](#success-criteria)
- [Performance Optimization](#performance-optimization)

---

## Background

### Context

Phase 2 Weeks 1-4 delivered:
- **Week 1**: SessionRegistry, RetryHandler, CircuitBreaker, TimeoutHandler
- **Week 2**: ModelPreWarmer, ContinuousBatcher, RequestQueue, ResourceManager
- **Week 3**: Controller integration (retry, circuit breaker, timeout)
- **Week 4**: Worker integration (batching, queueing, resource limits)

All components are **now integrated** but **performance gains not validated**. Week 5 focuses on comprehensive benchmarking and optimization.

### Expected Performance Improvements

Based on PRDs:
1. **Sticky Sessions**: 40-60% latency reduction (KV cache reuse)
2. **Pre-warming**: 90% cold-start reduction (2000ms → 200ms)
3. **Continuous Batching**: 2-3x throughput improvement
4. **Retry Logic**: 95% → 99%+ success rate
5. **Circuit Breaker**: Eliminate wasted requests on unhealthy workers

### Week 5 Objectives

1. **Measure** actual performance gains
2. **Validate** expected improvements are achieved
3. **Identify** bottlenecks and optimization opportunities
4. **Optimize** based on benchmark results
5. **Document** performance baselines for production monitoring

---

## Goals & Non-Goals

### Goals

**Primary Goals**:
1. ✅ Sticky session latency benchmarks (measure 40-60% improvement)
2. ✅ Pre-warming cold-start benchmarks (measure 90% reduction)
3. ✅ Continuous batching throughput benchmarks (measure 2-3x improvement)
4. ✅ End-to-end cluster tests (100+ concurrent requests)
5. ✅ Load testing (sustained high load)
6. ✅ Stress testing (failure scenarios)
7. ✅ Performance optimization based on results
8. ✅ Comprehensive performance report

**Secondary Goals**:
1. ✅ Retry handler success rate validation (>99%)
2. ✅ Circuit breaker effectiveness validation
3. ✅ Resource manager OOM prevention validation
4. ✅ Request queue backpressure validation
5. ✅ Performance regression testing framework

**Stretch Goals**:
1. ✅ Automated performance monitoring dashboards
2. ✅ Performance comparison with baseline MLX engine
3. ✅ Scalability testing (2-10 workers)

### Non-Goals

1. ❌ New feature development (focus on testing existing features)
2. ❌ Multi-GPU support (Phase 4)
3. ❌ Distributed batching (Phase 4)
4. ❌ Production deployment (Phase 5+)
5. ❌ Web dashboard (Phase 3)

---

## Technical Design

### Benchmark Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Benchmark Test Suite                        │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Latency     │  │  Throughput  │  │  Load/Stress │      │
│  │  Benchmarks  │  │  Benchmarks  │  │  Testing     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                 │                  │               │
│         └─────────────────┴──────────────────┘               │
│                           │                                   │
└───────────────────────────┼───────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Test Cluster                            │
│                                                               │
│  ┌──────────────────┐         ┌─────────────────────────┐  │
│  │  ControllerNode  │◄────────┤  WorkerNode x N         │  │
│  │  (with all Week  │  NATS   │  (with batching, queue, │  │
│  │   3 features)    │         │   resource mgmt)        │  │
│  └──────────────────┘         └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  Metrics Collection                          │
│                                                               │
│  • Request latency (p50, p95, p99)                          │
│  • Throughput (requests/sec, tokens/sec)                    │
│  • Success rate (%)                                          │
│  • Resource usage (memory, CPU, GPU)                        │
│  • Batch statistics (size, latency)                         │
│  • Queue statistics (depth, wait time)                      │
│  • Circuit breaker statistics (trips, recoveries)           │
└─────────────────────────────────────────────────────────────┘
```

---

## Benchmark Specifications

### 1. Sticky Session Latency Benchmark

**Goal**: Validate 40-60% latency reduction from KV cache reuse

**Test Scenario**:
```typescript
// Baseline: No sticky sessions
for (let i = 0; i < 100; i++) {
  const response = await client.chatCompletion({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    messages: [{ role: 'user', content: `Question ${i}` }],
    max_tokens: 50,
    // No session_id
  });
  recordLatency(response.latency);
}

// Optimized: With sticky sessions
const sessionId = 'benchmark-session';
for (let i = 0; i < 100; i++) {
  const response = await client.chatCompletion({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    messages: [{ role: 'user', content: `Question ${i}` }],
    max_tokens: 50,
    session_id: sessionId, // Reuse same session
  });
  recordLatency(response.latency);
}

// Compare: optimized vs baseline
const improvement = (baseline - optimized) / baseline * 100;
// Expected: 40-60% improvement
```

**Metrics**:
- Baseline latency (p50, p95, p99)
- Optimized latency (p50, p95, p99)
- Improvement percentage
- Session hit rate

**Success Criteria**: 40-60% latency reduction

---

### 2. Pre-warming Cold-Start Benchmark

**Goal**: Validate 90% cold-start reduction from model pre-warming

**Test Scenario**:
```typescript
// Baseline: No pre-warming (cold start)
await worker.stop();
await worker.start({ preWarmingEnabled: false });

const coldStartTime = Date.now();
const response1 = await client.chatCompletion({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 1,
});
const coldStartLatency = Date.now() - coldStartTime;

// Optimized: With pre-warming
await worker.stop();
await worker.start({ preWarmingEnabled: true });

// Wait for pre-warming to complete
await waitForPreWarming(worker);

const warmStartTime = Date.now();
const response2 = await client.chatCompletion({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 1,
});
const warmStartLatency = Date.now() - warmStartTime;

// Compare
const improvement = (coldStartLatency - warmStartLatency) / coldStartLatency * 100;
// Expected: 90% improvement
```

**Metrics**:
- Cold start TTFT (time to first token)
- Warm start TTFT
- Improvement percentage
- Pre-warming duration
- Pre-warming success rate

**Success Criteria**: 90%+ cold-start reduction

---

### 3. Continuous Batching Throughput Benchmark

**Goal**: Validate 2-3x throughput improvement from batching

**Test Scenario**:
```typescript
// Baseline: No batching (sequential processing)
await worker.start({ batchingEnabled: false });

const startTime = Date.now();
const requests = [];
for (let i = 0; i < 100; i++) {
  requests.push(
    client.chatCompletion({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      messages: [{ role: 'user', content: `Question ${i}` }],
      max_tokens: 50,
    })
  );
}
await Promise.all(requests);
const baselineDuration = Date.now() - startTime;
const baselineThroughput = 100 / (baselineDuration / 1000);

// Optimized: With batching
await worker.stop();
await worker.start({ batchingEnabled: true, maxBatchSize: 8 });

const startTime2 = Date.now();
const requests2 = [];
for (let i = 0; i < 100; i++) {
  requests2.push(
    client.chatCompletion({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      messages: [{ role: 'user', content: `Question ${i}` }],
      max_tokens: 50,
    })
  );
}
await Promise.all(requests2);
const optimizedDuration = Date.now() - startTime2;
const optimizedThroughput = 100 / (optimizedDuration / 1000);

// Compare
const improvement = optimizedThroughput / baselineThroughput;
// Expected: 2-3x improvement
```

**Metrics**:
- Baseline throughput (requests/sec, tokens/sec)
- Optimized throughput (requests/sec, tokens/sec)
- Improvement factor
- Average batch size
- Batch latency overhead

**Success Criteria**: 2-3x throughput improvement

---

### 4. End-to-End Cluster Tests

**Goal**: Validate system reliability with 100+ concurrent requests

**Test Scenarios**:

**Scenario 1: High Concurrency**
```typescript
// 100 concurrent requests
const requests = Array.from({ length: 100 }, (_, i) =>
  client.chatCompletion({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    messages: [{ role: 'user', content: `Request ${i}` }],
    max_tokens: 50,
  })
);

const results = await Promise.allSettled(requests);
const successRate = results.filter(r => r.status === 'fulfilled').length / 100;
// Expected: >99% success rate
```

**Scenario 2: Worker Failure & Recovery**
```typescript
// Start with 3 workers
await cluster.start({ workerCount: 3 });

// Send 50 requests
const requests1 = sendRequests(50);

// Simulate worker failure mid-test
await cluster.getWorker(0).simulateFailure();

// Continue sending requests
const requests2 = sendRequests(50);

// Validate:
// - Retry handler retries on different workers
// - Circuit breaker opens for failed worker
// - All requests eventually succeed
```

**Scenario 3: Load Spike**
```typescript
// Low load (10 req/sec) for 30s
await sendSustainedLoad(10, 30000);

// Spike to 100 req/sec for 10s
await sendSustainedLoad(100, 10000);

// Return to low load
await sendSustainedLoad(10, 30000);

// Validate:
// - Request queue handles spike
// - Batch size adapts
// - No OOM crashes
// - Graceful degradation
```

**Metrics**:
- Success rate (%)
- Latency percentiles (p50, p95, p99)
- Throughput (requests/sec)
- Circuit breaker trips
- Retry count
- Resource usage (memory, CPU, GPU)

**Success Criteria**:
- >99% success rate
- <2% latency degradation
- No OOM crashes
- Graceful degradation under load

---

### 5. Load Testing

**Goal**: Validate sustained high load performance

**Test Parameters**:
- Duration: 10 minutes
- Load: 50 requests/sec
- Workers: 3
- Model: Llama-3.2-3B-Instruct-4bit
- Max tokens: 100

**Metrics to Track**:
- Latency over time (detect degradation)
- Throughput over time (detect slowdown)
- Success rate over time (detect failures)
- Memory usage over time (detect leaks)
- Queue depth over time (detect buildup)
- Batch size over time (detect batching effectiveness)

**Success Criteria**:
- Stable latency (no degradation >10%)
- Stable throughput (no slowdown >10%)
- >99% success rate
- No memory leaks (memory stable)
- Queue depth stays <50

---

### 6. Stress Testing

**Goal**: Validate failure handling and graceful degradation

**Test Scenarios**:

**Scenario 1: All Workers Offline**
```typescript
// Stop all workers
await cluster.stopAllWorkers();

// Send requests
const result = await client.chatCompletion({...});

// Expected: Proper error (NO_WORKERS_AVAILABLE)
```

**Scenario 2: Memory Pressure**
```typescript
// Configure low memory limits
await worker.start({ maxMemoryMB: 1024 });

// Send large batch of requests
const requests = sendRequests(100);

// Expected:
// - Some requests rejected (RESOURCE_LIMIT_EXCEEDED)
// - No OOM crashes
// - System recovers after load decreases
```

**Scenario 3: Network Partition**
```typescript
// Simulate NATS connection failure
await cluster.simulateNetworkPartition();

// Expected:
// - Controller detects worker offline
// - Requests retry on other workers
// - System recovers when network restored
```

**Success Criteria**:
- Proper error handling (correct error codes)
- No crashes or hangs
- System recovers after stress removed
- Graceful degradation

---

## Testing Strategy

### Test Suite Structure

```
tests/
├── integration/
│   └── distributed/
│       └── performance/
│           ├── latency-benchmarks.test.ts        (Sticky sessions)
│           ├── cold-start-benchmarks.test.ts     (Pre-warming)
│           ├── throughput-benchmarks.test.ts     (Batching)
│           ├── cluster-e2e.test.ts               (E2E tests)
│           ├── load-testing.test.ts              (Load tests)
│           ├── stress-testing.test.ts            (Stress tests)
│           └── helpers/
│               ├── benchmark-runner.ts           (Test runner utilities)
│               ├── metrics-collector.ts          (Metrics collection)
│               └── performance-reporter.ts       (Markdown reports)
```

### Benchmark Test Template

```typescript
import { BenchmarkRunner } from './helpers/benchmark-runner.js';
import { PerformanceReporter } from './helpers/performance-reporter.js';

describe('Performance Benchmark: Sticky Sessions', () => {
  let runner: BenchmarkRunner;
  let reporter: PerformanceReporter;

  beforeAll(async () => {
    runner = new BenchmarkRunner({
      workerCount: 3,
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    });

    await runner.start();
    reporter = new PerformanceReporter('sticky-sessions');
  });

  afterAll(async () => {
    await runner.stop();
    await reporter.save('automatosx/tmp/performance-reports/');
  });

  it('should show 40-60% latency improvement with sticky sessions', async () => {
    // Baseline
    const baselineMetrics = await runner.runBaseline({
      requestCount: 100,
      maxTokens: 50,
    });

    // Optimized
    const optimizedMetrics = await runner.runOptimized({
      requestCount: 100,
      maxTokens: 50,
      sessionId: 'benchmark-session',
    });

    // Report
    reporter.addBenchmark('sticky-sessions', {
      baseline: baselineMetrics,
      optimized: optimizedMetrics,
      expectedImprovement: '40-60%',
    });

    // Validate
    const improvement = calculateImprovement(baselineMetrics, optimizedMetrics);
    expect(improvement).toBeGreaterThanOrEqual(40);
    expect(improvement).toBeLessThanOrEqual(60);
  });
});
```

---

## Success Criteria

### Functional Requirements

- ✅ Sticky session benchmark shows 40-60% latency improvement
- ✅ Pre-warming benchmark shows 90%+ cold-start reduction
- ✅ Batching benchmark shows 2-3x throughput improvement
- ✅ End-to-end tests pass with >99% success rate
- ✅ Load tests show stable performance under sustained load
- ✅ Stress tests show graceful degradation under failure
- ✅ Comprehensive performance report generated

### Performance Requirements

**Sticky Sessions**:
- ✅ 40-60% latency improvement (p50)
- ✅ Session hit rate >90%

**Pre-warming**:
- ✅ 90%+ cold-start reduction
- ✅ Pre-warming success rate >95%

**Continuous Batching**:
- ✅ 2-3x throughput improvement
- ✅ Average batch size 3-6

**End-to-End**:
- ✅ >99% success rate (100+ concurrent requests)
- ✅ p99 latency <5s

**Load Testing**:
- ✅ Stable performance (10 minutes)
- ✅ No memory leaks

**Stress Testing**:
- ✅ No crashes
- ✅ Proper error handling

### Quality Requirements

- ✅ All benchmarks passing (>95% within expected range)
- ✅ All E2E tests passing (>99% success rate)
- ✅ Performance report complete with metrics
- ✅ TypeScript: 0 errors
- ✅ ESLint: 0 errors/warnings
- ✅ Documentation: Performance baselines documented

---

## Performance Optimization

### Optimization Process

1. **Run Benchmarks**: Execute all benchmark tests
2. **Analyze Results**: Identify bottlenecks and underperformance
3. **Optimize**: Make targeted improvements
4. **Re-benchmark**: Validate improvements
5. **Document**: Record optimizations and new baselines

### Common Bottlenecks & Solutions

**Bottleneck 1: High Request Latency**
- **Symptom**: p95 latency >3s
- **Solutions**:
  - Increase batch timeout to reduce wait time
  - Optimize queue depth
  - Add more workers

**Bottleneck 2: Low Throughput**
- **Symptom**: <20 requests/sec with batching
- **Solutions**:
  - Increase max batch size
  - Reduce batch timeout
  - Optimize batcher loop

**Bottleneck 3: Memory Leaks**
- **Symptom**: Memory usage grows over time
- **Solutions**:
  - Fix pending requests cleanup
  - Add request timeout
  - Implement metrics cleanup

**Bottleneck 4: Circuit Breaker Flapping**
- **Symptom**: Circuit opens/closes frequently
- **Solutions**:
  - Tune failure threshold
  - Increase timeout
  - Improve health checks

---

## Deliverables

### Code (600+ lines)
- Latency benchmarks (~100 lines)
- Cold-start benchmarks (~100 lines)
- Throughput benchmarks (~100 lines)
- E2E cluster tests (~150 lines)
- Load testing (~75 lines)
- Stress testing (~75 lines)

### Test Utilities (400+ lines)
- BenchmarkRunner (~150 lines)
- MetricsCollector (~100 lines)
- PerformanceReporter (~150 lines)

### Documentation
- Performance report (comprehensive metrics)
- Benchmark guide
- Optimization recommendations
- Performance baselines
- Week 5 summary

---

## Timeline

**Total Duration**: 5 days (1 week)

- **Day 1**: Sticky session & retry benchmarks
- **Day 2**: Pre-warming & batching benchmarks
- **Day 3**: End-to-end cluster tests
- **Day 4**: Load testing & stress testing
- **Day 5**: Performance optimization & final report

---

## Dependencies

**Phase 2 Weeks 1-4** (Complete):
- ✅ Week 1: SessionRegistry, RetryHandler, CircuitBreaker, TimeoutHandler
- ✅ Week 2: ModelPreWarmer, ContinuousBatcher, RequestQueue, ResourceManager
- ✅ Week 3: Controller integration
- ✅ Week 4: Worker integration

---

**Document Version**: 1.0.0
**Last Updated**: 2025-11-10
**Author**: Claude Code
**Status**: Ready for Implementation
