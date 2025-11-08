# Phase 5: Integration, Validation & Rollout - Action Plan

**Detailed Implementation Roadmap**

**Version:** 1.0
**Date:** 2025-01-08
**Timeline:** 3 weeks
**Team Size:** 2-3 engineers

---

## Table of Contents

1. [Overview](#overview)
2. [Week 1: Integration Testing](#week-1-integration-testing)
3. [Week 2: Performance Validation](#week-2-performance-validation)
4. [Week 3: Documentation & Rollout](#week-3-documentation--rollout)
5. [Testing Strategy](#testing-strategy)
6. [Monitoring & Observability](#monitoring--observability)
7. [Rollback Procedures](#rollback-procedures)
8. [Appendix](#appendix)

---

## Overview

### Goals
- Integrate Phase 4 components with live streaming operations
- Validate performance against targets (TTFT ≤ 550ms, +30% throughput)
- Create comprehensive documentation
- Execute gradual rollout with monitoring

### Prerequisites
- ✅ Phase 4 implementation complete (~4,830 lines)
- ✅ TypeScript compilation passing
- ✅ Git commits for all components
- ⏳ Load testing environment setup
- ⏳ Monitoring dashboards configured

---

## Week 1: Integration Testing

### Day 1-2: StreamRegistry Integration

**Goal:** Wire QosIntegration to live StreamRegistry

**Tasks:**

#### Task 1.1: Create Integration Entry Point
**File:** `src/server/qos-integration-factory.ts` (NEW)
```typescript
/**
 * Factory for creating QosIntegration instance
 * Connects StreamRegistry to QosMonitor
 */
import { QosIntegration } from '../streaming/integration/QosIntegration.js';
import type { StreamRegistry } from '../bridge/stream-registry.js';
import { getConfig } from '../config/loader.js';

export function createQosIntegration(
  streamRegistry: StreamRegistry,
  logger?: Logger
): QosIntegration | null {
  const config = getConfig();

  if (!config.qos_monitor?.enabled) {
    logger?.info('QoS integration disabled via config');
    return null;
  }

  return new QosIntegration(
    streamRegistry,
    {
      enabled: true,
      qosMonitor: config.qos_monitor,
      sampleRate: config.qos_monitor.sample_rate ?? 1,
    },
    logger
  );
}
```

**Acceptance:** ✅ Factory function compiles and returns QosIntegration when enabled

---

#### Task 1.2: Wire Integration in Server Bootstrap
**File:** `src/server/server.ts` (MODIFY)
```typescript
// Add after StreamRegistry initialization
import { createQosIntegration } from './qos-integration-factory.js';

// In server startup
const streamRegistry = new StreamRegistry({ logger });
const qosIntegration = createQosIntegration(streamRegistry, logger);

// Store reference for shutdown
server.locals.qosIntegration = qosIntegration;

// Cleanup on shutdown
process.on('SIGTERM', () => {
  qosIntegration?.stop();
});
```

**Acceptance:** ✅ QosIntegration initialized when server starts

---

#### Task 1.3: Add Configuration
**File:** `config/runtime.yaml` (MODIFY)
```yaml
qos_monitor:
  enabled: false  # Start disabled
  sample_rate: 1  # 100% sampling

  evaluator:
    enabled: false
    evaluation_interval_ms: 5000
    window_ms: 60000
    tdigest_compression: 100

  executor:
    enabled: false
    cooldown_ms: 60000
    max_executions_per_window: 5
    execution_window_ms: 300000
    loop_detection_window: 6

  policy_store:
    policies:
      - id: default_ttft_policy
        name: Default TTFT SLO
        enabled: true
        priority: 100
        slos:
          - name: ttft_p95
            metric: ttft
            threshold: 550
            window_ms: 60000
            severity: critical
        remediations:
          - type: alert
            target: stream_registry
            params:
              message: "TTFT SLO violated"
            reason: "TTFT exceeded 550ms"
```

**Acceptance:** ✅ Config loads without errors

---

#### Task 1.4: Create Integration Test
**File:** `tests/integration/qos-integration.test.ts` (NEW)
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StreamRegistry } from '../../src/bridge/stream-registry.js';
import { QosIntegration } from '../../src/streaming/integration/QosIntegration.js';

describe('QosIntegration', () => {
  let streamRegistry: StreamRegistry;
  let qosIntegration: QosIntegration;

  beforeAll(() => {
    streamRegistry = new StreamRegistry();
    qosIntegration = new QosIntegration(
      streamRegistry,
      {
        enabled: true,
        qosMonitor: { /* config */ },
      }
    );
  });

  afterAll(() => {
    qosIntegration.stop();
  });

  it('should record TTFT metrics on stream completion', async () => {
    // Register stream
    const promise = streamRegistry.register('test-stream-1');

    // Simulate completion
    streamRegistry.handleStats({
      stream_id: 'test-stream-1',
      tokens_generated: 100,
      tokens_per_second: 50,
      time_to_first_token: 400,
      total_time: 2.0,
    });

    streamRegistry.handleEvent({
      stream_id: 'test-stream-1',
      event: 'completed',
      finish_reason: 'stop',
      is_final: true,
    });

    await promise;

    // Check metrics were recorded
    const telemetry = qosIntegration.getTelemetry();
    expect(telemetry).toBeDefined();
  });

  it('should record error rate on stream failures', async () => {
    const promise = streamRegistry.register('test-stream-2');

    streamRegistry.handleEvent({
      stream_id: 'test-stream-2',
      event: 'error',
      error: 'Test error',
      is_final: true,
    });

    await expect(promise).rejects.toThrow();

    const stats = qosIntegration.getStats();
    expect(stats.errorCount).toBeGreaterThan(0);
  });
});
```

**Acceptance:** ✅ Integration tests passing

---

**Day 1-2 Deliverable:**
- ✅ QosIntegration wired to StreamRegistry
- ✅ Configuration added to runtime.yaml
- ✅ Integration tests passing
- ✅ Feature disabled by default

---

### Day 3-4: QoS Policy Engine Testing

**Goal:** Test SLO evaluation and remediation execution

#### Task 1.5: Create SLO Violation Test
**File:** `tests/integration/qos-violation.test.ts` (NEW)
```typescript
import { describe, it, expect, vi } from 'vitest';
import { QosMonitor } from '../../src/streaming/qos/QosMonitor.js';

describe('QoS SLO Violations', () => {
  it('should detect TTFT violations', () => {
    const monitor = new QosMonitor({
      enabled: true,
      evaluator: {
        enabled: true,
        evaluation_interval_ms: 1000,
        window_ms: 10000,
        tdigest_compression: 100,
      },
      executor: {
        enabled: false,
        cooldown_ms: 60000,
        max_executions_per_window: 5,
        execution_window_ms: 300000,
        loop_detection_window: 6,
      },
      policyStore: {
        policies: [
          {
            id: 'test-policy',
            name: 'Test TTFT Policy',
            enabled: true,
            priority: 100,
            slos: [
              {
                name: 'ttft_p95',
                metric: 'ttft',
                threshold: 550,
                windowMs: 10000,
                severity: 'critical',
              },
            ],
            remediations: [],
          },
        ],
      },
    });

    monitor.start();

    // Emit violation listener
    const violationHandler = vi.fn();
    monitor.on('violation', violationHandler);

    // Record TTFT samples that violate threshold
    for (let i = 0; i < 100; i++) {
      monitor.recordMetric({
        metric: 'ttft',
        value: 700, // Above 550ms threshold
        timestamp: Date.now(),
        streamId: `stream-${i}`,
      });
    }

    // Wait for evaluation
    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(violationHandler).toHaveBeenCalled();
    monitor.stop();
  });
});
```

**Acceptance:** ✅ SLO violation detection working

---

#### Task 1.6: Test Remediation Execution
**File:** `tests/integration/qos-remediation.test.ts` (NEW)
```typescript
describe('Remediation Execution', () => {
  it('should execute remediation on violation', async () => {
    const executedActions: RemediationAction[] = [];

    const monitor = new QosMonitor({
      enabled: true,
      evaluator: { enabled: true, /* ... */ },
      executor: { enabled: true, /* ... */ },
      policyStore: {
        policies: [
          {
            id: 'remediation-policy',
            name: 'Test Remediation',
            enabled: true,
            priority: 100,
            slos: [
              {
                name: 'ttft_p95',
                metric: 'ttft',
                threshold: 550,
                windowMs: 10000,
                severity: 'critical',
              },
            ],
            remediations: [
              {
                type: 'alert',
                target: 'stream_registry',
                params: { message: 'TTFT violated' },
                reason: 'Test remediation',
              },
            ],
          },
        ],
      },
    });

    monitor.on('executed', (result) => {
      executedActions.push(result.action);
    });

    monitor.start();

    // Trigger violation
    for (let i = 0; i < 100; i++) {
      monitor.recordMetric({
        metric: 'ttft',
        value: 700,
        timestamp: Date.now(),
      });
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(executedActions.length).toBeGreaterThan(0);
    expect(executedActions[0].type).toBe('alert');

    monitor.stop();
  });

  it('should prevent remediation loops', async () => {
    // Test loop detection logic
    // Alternate between scale_up and scale_down
    // Verify circuit breaker opens
  });
});
```

**Acceptance:** ✅ Remediation execution working
**Acceptance:** ✅ Loop detection preventing oscillation

---

**Day 3-4 Deliverable:**
- ✅ SLO violation detection validated
- ✅ Remediation execution tested
- ✅ Loop detection verified
- ✅ Circuit breaker functional

---

### Day 5: TTFT Pipeline Integration

**Goal:** Connect TTFT Pipeline to generate() flow

#### Task 1.7: Create TTFT Integration Hook
**File:** `src/core/ttft-integration.ts` (NEW)
```typescript
import { TtftPipeline } from '../streaming/pipeline/ttft/TtftPipeline.js';
import { createTtftHint } from '../streaming/pipeline/ttft/HintHasher.js';
import type { PromptPayload } from '../streaming/pipeline/ttft/types.js';

export class TtftIntegration {
  private pipeline?: TtftPipeline;

  constructor(enabled: boolean) {
    if (enabled) {
      this.pipeline = new TtftPipeline({
        warmQueue: {
          enabled: true,
          maxQueueSize: 1000,
          ttlMs: 800,
          processingIntervalMs: 50,
        },
        speculation: {
          enabled: true,
          minConfidence: 0.85,
          maxCandidates: 3,
          allowlistOnly: true,
        },
        kvPrep: {
          enabled: false, // Python integration pending
        },
      });
    }
  }

  async optimizeTTFT(
    modelId: string,
    prompt: string,
    params: Record<string, unknown>
  ): Promise<string[] | null> {
    if (!this.pipeline) {
      return null;
    }

    const hint = createTtftHint(modelId, prompt, params);
    const payload: PromptPayload = {
      model: modelId,
      prompt,
      params,
      timestamp: Date.now(),
    };

    const result = await this.pipeline.processTtftHint(hint, payload);
    return result.candidateTokens;
  }

  recordFirstToken(
    streamId: string,
    promptHash: string,
    actualToken: string,
    candidateTokens: string[] | null
  ): void {
    if (this.pipeline && candidateTokens) {
      this.pipeline.recordFirstToken(
        streamId,
        promptHash,
        actualToken,
        candidateTokens
      );
    }
  }
}
```

**Acceptance:** ✅ TTFT integration compiles

---

#### Task 1.8: Wire TTFT into Generate Flow
**File:** `src/core/generate-batcher.ts` (MODIFY)
```typescript
import { TtftIntegration } from './ttft-integration.js';

class GenerateBatcher {
  private ttftIntegration?: TtftIntegration;

  constructor() {
    const config = getConfig();
    this.ttftIntegration = new TtftIntegration(
      config.ttft_pipeline?.enabled ?? false
    );
  }

  async generate(params: GenerateParams): Promise<StreamResponse> {
    // Before starting stream, optimize TTFT
    const candidateTokens = await this.ttftIntegration?.optimizeTTFT(
      params.model,
      params.prompt,
      params
    );

    // Start streaming
    const streamId = uuid();
    const stream = this.startStream(streamId, params, candidateTokens);

    return stream;
  }

  private async handleFirstToken(
    streamId: string,
    promptHash: string,
    token: string,
    candidateTokens: string[] | null
  ): Promise<void> {
    // Record outcome for speculation confidence adjustment
    this.ttftIntegration?.recordFirstToken(
      streamId,
      promptHash,
      token,
      candidateTokens
    );
  }
}
```

**Acceptance:** ✅ TTFT pipeline integrated into generate flow

---

#### Task 1.9: Test TTFT Optimization
**File:** `tests/integration/ttft-optimization.test.ts` (NEW)
```typescript
describe('TTFT Optimization', () => {
  it('should reduce TTFT with warm queue', async () => {
    const baseline = await measureTTFT({ ttft_enabled: false });
    const optimized = await measureTTFT({ ttft_enabled: true });

    expect(optimized.p95).toBeLessThan(baseline.p95);
  });

  it('should improve with speculation', async () => {
    // Test speculative token generation
    // Verify first token matches speculation
  });
});
```

**Acceptance:** ✅ TTFT improvements measurable

---

**Day 5 Deliverable:**
- ✅ TTFT pipeline integrated
- ✅ Speculative tokens working
- ✅ Warm queue functional
- ✅ Measurable TTFT improvements

---

**Week 1 Summary:**
- ✅ All Phase 4 components integrated
- ✅ QoS monitoring operational
- ✅ TTFT pipeline active
- ✅ Integration tests passing

---

## Week 2: Performance Validation

### Day 1-2: TTFT Benchmarking

**Goal:** Validate TTFT ≤ 550ms at P95

#### Task 2.1: Create TTFT Benchmark Suite
**File:** `benchmarks/ttft-benchmark.ts` (NEW)
```typescript
import { generate } from '../src/index.js';
import { TDigest } from '../src/streaming/qos/TDigest.js';

interface BenchmarkConfig {
  model: string;
  prompts: string[];
  iterations: number;
  ttft_enabled: boolean;
}

async function runTTFTBenchmark(config: BenchmarkConfig) {
  const digest = new TDigest(100);
  const ttfts: number[] = [];

  for (const prompt of config.prompts) {
    for (let i = 0; i < config.iterations; i++) {
      const startTime = Date.now();
      let firstTokenTime: number | null = null;

      const stream = await generate({
        model: config.model,
        prompt,
        stream: true,
      });

      for await (const chunk of stream) {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now() - startTime;
          digest.add(firstTokenTime);
          ttfts.push(firstTokenTime);
        }
      }
    }
  }

  return {
    count: ttfts.length,
    min: Math.min(...ttfts),
    max: Math.max(...ttfts),
    mean: ttfts.reduce((a, b) => a + b) / ttfts.length,
    p50: digest.percentile(0.5),
    p95: digest.percentile(0.95),
    p99: digest.percentile(0.99),
  };
}

// Run benchmark
const prompts = [
  "Explain quantum computing in simple terms.",
  "Write a Python function to sort a list.",
  "What is the capital of France?",
  // ... 97 more prompts of varying length
];

const baseline = await runTTFTBenchmark({
  model: 'gemma-2-27b-it-4bit',
  prompts,
  iterations: 1,
  ttft_enabled: false,
});

const optimized = await runTTFTBenchmark({
  model: 'gemma-2-27b-it-4bit',
  prompts,
  iterations: 1,
  ttft_enabled: true,
});

console.log('Baseline TTFT P95:', baseline.p95, 'ms');
console.log('Optimized TTFT P95:', optimized.p95, 'ms');
console.log('Improvement:', ((baseline.p95 - optimized.p95) / baseline.p95 * 100).toFixed(1), '%');
```

**Acceptance:** ✅ TTFT P95 ≤ 550ms with optimizations enabled

---

#### Task 2.2: Create Benchmark Report
**File:** `benchmarks/results/ttft-report.md` (NEW - AUTO-GENERATED)
```markdown
# TTFT Benchmark Report

**Date:** 2025-01-XX
**Model:** gemma-2-27b-it-4bit
**Prompts:** 100
**Iterations:** 1

## Results

| Configuration | P50 (ms) | P95 (ms) | P99 (ms) | Improvement |
|---------------|----------|----------|----------|-------------|
| Baseline      | 600      | 800      | 950      | -           |
| Optimized     | 350      | 520      | 650      | 35%         |

## Target Achievement

- ✅ P95 TTFT ≤ 550ms: **PASS** (520ms)
- ✅ Improvement ≥ 30%: **PASS** (35%)

## Distribution

[Chart: TTFT distribution histogram]

## Recommendations

1. Enable TTFT pipeline in production
2. Monitor speculation hit rate
3. Tune warm queue TTL based on load patterns
```

**Acceptance:** ✅ Report generated with clear metrics

---

**Day 1-2 Deliverable:**
- ✅ TTFT benchmark suite created
- ✅ Target validated (P95 ≤ 550ms)
- ✅ Improvement documented (35%+)
- ✅ Report generated

---

### Day 3-4: Throughput and Load Testing

**Goal:** Validate +30% throughput improvement

#### Task 2.3: Create Throughput Benchmark
**File:** `benchmarks/throughput-benchmark.ts` (NEW)
```typescript
interface ThroughputConfig {
  concurrency: number;
  duration: number; // seconds
  model: string;
}

async function runThroughputBenchmark(config: ThroughputConfig) {
  const startTime = Date.now();
  const endTime = startTime + config.duration * 1000;

  let completed = 0;
  let totalTokens = 0;
  const workers: Promise<void>[] = [];

  // Spawn concurrent workers
  for (let i = 0; i < config.concurrency; i++) {
    workers.push((async () => {
      while (Date.now() < endTime) {
        const stream = await generate({
          model: config.model,
          prompt: "Generate 100 tokens",
          max_tokens: 100,
        });

        let tokens = 0;
        for await (const chunk of stream) {
          tokens++;
        }

        completed++;
        totalTokens += tokens;
      }
    })());
  }

  await Promise.all(workers);

  const duration = (Date.now() - startTime) / 1000;

  return {
    duration,
    completed,
    totalTokens,
    requestsPerSecond: completed / duration,
    tokensPerSecond: totalTokens / duration,
  };
}

// Benchmark at different concurrency levels
for (const concurrency of [10, 25, 50, 75]) {
  const baseline = await runThroughputBenchmark({
    concurrency,
    duration: 60,
    model: 'gemma-2-27b-it-4bit',
  });

  console.log(`Concurrency: ${concurrency}`);
  console.log(`Requests/sec: ${baseline.requestsPerSecond.toFixed(2)}`);
  console.log(`Tokens/sec: ${baseline.tokensPerSecond.toFixed(2)}`);
}
```

**Acceptance:** ✅ Throughput +30% at 50 concurrency

---

#### Task 2.4: Stress Test - Find Breaking Point
**File:** `benchmarks/stress-test.ts` (NEW)
```typescript
async function findBreakingPoint() {
  let concurrency = 10;
  let lastSuccessful = 0;

  while (concurrency <= 200) {
    try {
      const result = await runThroughputBenchmark({
        concurrency,
        duration: 30,
        model: 'gemma-2-27b-it-4bit',
      });

      const errorRate = calculateErrorRate(result);

      if (errorRate < 0.01) {
        lastSuccessful = concurrency;
        console.log(`✅ Concurrency ${concurrency}: SUCCESS`);
      } else {
        console.log(`❌ Concurrency ${concurrency}: FAILED (${errorRate}% errors)`);
        break;
      }

      concurrency += 10;
    } catch (error) {
      console.log(`❌ Concurrency ${concurrency}: CRASHED`);
      break;
    }
  }

  console.log(`Breaking point: ${concurrency}`);
  console.log(`Safe capacity: ${lastSuccessful} concurrent streams`);
}
```

**Acceptance:** ✅ Safe capacity ≥ 75 concurrent streams

---

**Day 3-4 Deliverable:**
- ✅ Throughput benchmark suite created
- ✅ +30% improvement validated
- ✅ Safe capacity determined (75+ streams)
- ✅ Stress test results documented

---

### Day 5: Regression Testing

**Goal:** Ensure no degradation in existing features

#### Task 2.5: Run Existing Test Suite
```bash
npm run test              # Unit tests
npm run test:integration  # Integration tests
npm run test:e2e          # End-to-end tests
```

**Acceptance:** ✅ 100% pass rate on all tests

---

#### Task 2.6: Baseline Comparison
**File:** `benchmarks/regression-check.ts` (NEW)
```typescript
// Compare baseline performance (Phase 3) vs Phase 4
const metrics = {
  phase3: await measurePerformance({ phase4_enabled: false }),
  phase4: await measurePerformance({ phase4_enabled: true }),
};

console.log('Latency P95:', metrics.phase3.latency_p95, '→', metrics.phase4.latency_p95);
console.log('Memory usage:', metrics.phase3.memory, '→', metrics.phase4.memory);
console.log('CPU usage:', metrics.phase3.cpu, '→', metrics.phase4.cpu);

// Ensure no regression
expect(metrics.phase4.latency_p95).toBeLessThanOrEqual(metrics.phase3.latency_p95 * 1.05);
expect(metrics.phase4.memory).toBeLessThanOrEqual(metrics.phase3.memory * 1.10);
```

**Acceptance:** ✅ No regression in latency, memory, CPU

---

**Day 5 Deliverable:**
- ✅ All tests passing
- ✅ No regressions detected
- ✅ Performance comparison documented

---

**Week 2 Summary:**
- ✅ TTFT P95 ≤ 550ms validated
- ✅ Throughput +30% confirmed
- ✅ Safe capacity 75+ streams
- ✅ No regressions

---

## Week 3: Documentation & Rollout

### Day 1-2: Documentation

**Goal:** Complete API docs and integration guides

#### Task 3.1: API Documentation
**Files:**
```
docs/api/
  ├── qos-monitor.md
  ├── ttft-pipeline.md
  ├── adaptive-governor.md
  └── http2-transport.md
```

**Template:**
```markdown
# QosMonitor API

## Overview
Brief description of the component.

## Installation
```typescript
import { QosMonitor } from '@defai.digital/mlx-serving';
```

## Configuration
```yaml
qos_monitor:
  enabled: true
  # ...
```

## API Reference

### Constructor
```typescript
constructor(config: QosMonitorConfig, logger?: Logger)
```

### Methods

#### `start()`
Start QoS monitoring.

**Returns:** `void`

#### `recordMetric(sample: MetricSample)`
Record a metric sample.

**Parameters:**
- `sample`: Metric sample object

**Returns:** `void`

## Examples

### Basic Usage
```typescript
const monitor = new QosMonitor(config, logger);
monitor.start();

monitor.recordMetric({
  metric: 'ttft',
  value: 450,
  timestamp: Date.now(),
});
```

### With SLO Policies
```typescript
// Example with custom policies
```

## Events

- `violation` - Emitted when SLO is violated
- `recovery` - Emitted when SLO recovers
- `evaluation` - Emitted on each evaluation cycle

## Troubleshooting

Common issues and solutions.
```

**Acceptance:** ✅ API docs complete for all components

---

#### Task 3.2: Integration Guides
**Files:**
```
docs/integration/
  ├── quickstart.md
  ├── qos-setup.md
  ├── ttft-optimization.md
  └── monitoring.md
```

**Example: `quickstart.md`**
```markdown
# Quick Start Guide - Phase 4 Features

## Prerequisites
- mlx-serving v0.1.0+
- Node.js 18+
- TypeScript 5+

## Step 1: Enable QoS Monitoring

Edit `config/runtime.yaml`:
```yaml
qos_monitor:
  enabled: true
  sample_rate: 1
```

## Step 2: Start Server
```bash
npm start
```

## Step 3: Monitor Metrics
```bash
curl http://localhost:3000/metrics
```

## Step 4: Enable TTFT Pipeline
```yaml
ttft_pipeline:
  enabled: true
```

## Step 5: Validate Performance
```bash
npm run benchmark:ttft
```

## Next Steps
- [Configure SLO policies](./qos-setup.md)
- [Tune TTFT optimization](./ttft-optimization.md)
- [Setup monitoring dashboards](./monitoring.md)
```

**Acceptance:** ✅ Guides tested by new team member

---

**Day 1-2 Deliverable:**
- ✅ API docs complete
- ✅ Integration guides written
- ✅ Configuration reference created
- ✅ Runbooks validated

---

### Day 3: Canary Rollout (1%)

**Goal:** Enable Phase 4 for 1% of traffic

#### Task 3.3: Implement Feature Flags
**File:** `src/config/feature-flags.ts` (NEW)
```typescript
export interface FeatureFlags {
  phase4_rollout_percentage: number;
  adaptive_governor_enabled: boolean;
  ttft_pipeline_enabled: boolean;
  qos_monitoring_enabled: boolean;
  http2_transport_enabled: boolean;
}

export function getFeatureFlags(): FeatureFlags {
  const config = getConfig();
  return {
    phase4_rollout_percentage: config.phase4_rollout?.percentage ?? 0,
    adaptive_governor_enabled: config.streaming?.phase4?.adaptive_governor?.enabled ?? false,
    ttft_pipeline_enabled: config.ttft_pipeline?.enabled ?? false,
    qos_monitoring_enabled: config.qos_monitor?.enabled ?? false,
    http2_transport_enabled: config.http2_transport?.enabled ?? false,
  };
}

export function shouldEnablePhase4(requestId: string): boolean {
  const flags = getFeatureFlags();
  const percentage = flags.phase4_rollout_percentage;

  if (percentage === 0) return false;
  if (percentage === 100) return true;

  // Consistent hashing based on request ID
  const hash = hashString(requestId);
  return (hash % 100) < percentage;
}
```

**Acceptance:** ✅ Feature flags working

---

#### Task 3.4: Enable 1% Canary
**File:** `config/runtime.yaml` (MODIFY)
```yaml
phase4_rollout:
  percentage: 1  # 1% canary

qos_monitor:
  enabled: true
  sample_rate: 1  # 100% sampling for canary

ttft_pipeline:
  enabled: true
```

**Acceptance:** ✅ 1% of requests using Phase 4

---

#### Task 3.5: Monitor Canary
```bash
# Watch metrics
watch -n 5 'curl -s http://localhost:3000/metrics | grep phase4'

# Check error rate
watch -n 5 'curl -s http://localhost:3000/health | jq .error_rate'

# Monitor TTFT
watch -n 5 'curl -s http://localhost:3000/metrics | grep ttft_p95'
```

**Criteria:**
- ✅ Error rate = 0%
- ✅ TTFT P95 ≤ 550ms
- ✅ No resource spikes
- ✅ No crashes for 24 hours

**Acceptance:** ✅ Canary successful for 24 hours

---

**Day 3 Deliverable:**
- ✅ Feature flags implemented
- ✅ 1% canary deployed
- ✅ Monitoring dashboard operational
- ✅ No incidents for 24 hours

---

### Day 4: Expand Rollout (10% → 50%)

**Goal:** Increase rollout percentage based on canary success

#### Task 3.6: 10% Rollout
**File:** `config/runtime.yaml` (MODIFY)
```yaml
phase4_rollout:
  percentage: 10  # Increase to 10%
```

**Monitor for 48 hours:**
- Error rate
- TTFT metrics
- Throughput
- Resource usage

**Acceptance:** ✅ 10% stable for 48 hours

---

#### Task 3.7: 50% Rollout
**File:** `config/runtime.yaml` (MODIFY)
```yaml
phase4_rollout:
  percentage: 50  # Increase to 50%
```

**Monitor for 72 hours:**
- All metrics stable
- QoS violations minimal
- Remediation actions appropriate

**Acceptance:** ✅ 50% stable for 72 hours

---

**Day 4 Deliverable:**
- ✅ 10% rollout completed
- ✅ 50% rollout completed
- ✅ All metrics stable
- ✅ No incidents

---

### Day 5: Full Rollout (100%)

**Goal:** Complete rollout to 100%

#### Task 3.8: 100% Rollout
**File:** `config/runtime.yaml` (MODIFY)
```yaml
phase4_rollout:
  percentage: 100  # Full rollout

qos_monitor:
  enabled: true
  sample_rate: 0.1  # 10% sampling at full scale

adaptive_governor:
  enabled: true

ttft_pipeline:
  enabled: true

http2_transport:
  enabled: true
```

**Monitor for 1 week:**
- Sustained performance
- No degradation over time
- QoS policies effective

**Acceptance:** ✅ 100% stable for 1 week

---

**Day 5 Deliverable:**
- ✅ Full rollout completed
- ✅ All Phase 4 features enabled
- ✅ Performance targets maintained
- ✅ Production stable

---

**Week 3 Summary:**
- ✅ Documentation complete
- ✅ Gradual rollout successful
- ✅ 100% deployment achieved
- ✅ Phase 5 COMPLETE

---

## Testing Strategy

### Unit Tests
**Target:** 90%+ coverage

```bash
npm run test:unit
npm run test:coverage
```

**Files to test:**
- `src/streaming/qos/*.ts`
- `src/streaming/governor/*.ts`
- `src/streaming/pipeline/ttft/*.ts`
- `src/streaming/integration/*.ts`

---

### Integration Tests
**Scenarios:**
1. StreamRegistry → QosIntegration → QosMonitor
2. TTFT Pipeline → Generate flow
3. SLO violation → Remediation execution
4. HTTP/2 multiplexing

```bash
npm run test:integration
```

---

### Load Tests
**Tools:** Artillery, k6

**Config:** `load-tests/phase4.yml`
```yaml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 300
      arrivalRate: 50
      name: "Sustained load"
    - duration: 60
      arrivalRate: 100
      name: "Spike"

scenarios:
  - name: "Generate text"
    flow:
      - post:
          url: "/v1/generate"
          json:
            model: "gemma-2-27b-it-4bit"
            prompt: "Explain AI"
            max_tokens: 100
```

```bash
npm run test:load
```

---

### Regression Tests
**Baseline Capture:**
```bash
# Before Phase 4
npm run benchmark:baseline > baseline-phase3.json

# After Phase 4
npm run benchmark:baseline > baseline-phase4.json

# Compare
npm run benchmark:compare baseline-phase3.json baseline-phase4.json
```

**Acceptance:**
- ✅ Latency ≤ Phase 3 + 5%
- ✅ Memory ≤ Phase 3 + 10%
- ✅ Throughput ≥ Phase 3 + 30%

---

## Monitoring & Observability

### Metrics to Track

**TTFT Metrics:**
- `ttft_p50_ms` - Median TTFT
- `ttft_p95_ms` - 95th percentile TTFT
- `ttft_p99_ms` - 99th percentile TTFT

**Throughput Metrics:**
- `requests_per_second` - Request rate
- `tokens_per_second` - Token generation rate
- `concurrent_streams` - Active stream count

**QoS Metrics:**
- `qos_violations_total` - SLO violations
- `qos_remediations_total` - Remediation executions
- `qos_circuit_breakers_open` - Open circuit breakers

**Resource Metrics:**
- `cpu_usage_percent` - CPU utilization
- `memory_usage_mb` - Memory consumption
- `gpu_utilization_percent` - GPU usage

---

### Dashboard Setup

**Prometheus Queries:**
```promql
# TTFT P95
histogram_quantile(0.95, rate(ttft_bucket[5m]))

# Throughput
rate(requests_total[1m])

# Error rate
rate(errors_total[1m]) / rate(requests_total[1m])
```

**Grafana Dashboard:**
```json
{
  "dashboard": {
    "title": "Phase 4 - Stream Optimization",
    "panels": [
      {
        "title": "TTFT P95",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(ttft_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Throughput",
        "targets": [
          {
            "expr": "rate(requests_total[1m])"
          }
        ]
      }
    ]
  }
}
```

---

### Alerts

**Critical Alerts:**
```yaml
groups:
  - name: phase4
    rules:
      - alert: HighErrorRate
        expr: rate(errors_total[5m]) > 0.01
        for: 5m
        annotations:
          summary: "Error rate above 1%"

      - alert: HighTTFT
        expr: histogram_quantile(0.95, rate(ttft_bucket[5m])) > 550
        for: 10m
        annotations:
          summary: "TTFT P95 above target"

      - alert: QoSViolations
        expr: increase(qos_violations_total[5m]) > 10
        for: 5m
        annotations:
          summary: "Excessive QoS violations"
```

---

## Rollback Procedures

### Emergency Rollback

**Trigger Conditions:**
- Error rate > 1%
- TTFT P95 > 800ms (worse than baseline)
- Memory usage > 150% of baseline
- Multiple crashes

**Rollback Steps:**

1. **Disable Phase 4 Features**
```bash
# Edit config/runtime.yaml
vim config/runtime.yaml

# Set:
phase4_rollout:
  percentage: 0

qos_monitor:
  enabled: false

ttft_pipeline:
  enabled: false
```

2. **Restart Server**
```bash
npm run restart
```

3. **Verify Rollback**
```bash
curl http://localhost:3000/health
# Check phase4_enabled: false
```

**Time to Rollback:** < 5 minutes

---

### Partial Rollback

**Scenario:** Only one feature causing issues

**Steps:**
```yaml
# Disable only problematic feature
qos_monitor:
  enabled: false  # Disable QoS only

ttft_pipeline:
  enabled: true   # Keep TTFT

adaptive_governor:
  enabled: true   # Keep Governor
```

---

### Automated Rollback

**File:** `scripts/auto-rollback.sh` (NEW)
```bash
#!/bin/bash

ERROR_RATE=$(curl -s http://localhost:3000/metrics | grep error_rate | awk '{print $2}')

if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
  echo "ERROR RATE TOO HIGH: $ERROR_RATE"
  echo "Initiating automatic rollback..."

  # Disable Phase 4
  sed -i 's/percentage: [0-9]*/percentage: 0/' config/runtime.yaml

  # Restart
  npm run restart

  # Alert
  curl -X POST https://alerts.example.com/webhook \
    -d "{\"text\": \"Phase 4 auto-rollback triggered due to high error rate\"}"
fi
```

**Cron Job:**
```bash
*/5 * * * * /path/to/auto-rollback.sh
```

---

## Appendix

### A. File Checklist

**New Files Created:**
```
src/
  ├── server/qos-integration-factory.ts
  ├── core/ttft-integration.ts
  └── config/feature-flags.ts

tests/
  ├── integration/qos-integration.test.ts
  ├── integration/qos-violation.test.ts
  ├── integration/qos-remediation.test.ts
  └── integration/ttft-optimization.test.ts

benchmarks/
  ├── ttft-benchmark.ts
  ├── throughput-benchmark.ts
  ├── stress-test.ts
  └── regression-check.ts

docs/
  ├── api/
  │   ├── qos-monitor.md
  │   ├── ttft-pipeline.md
  │   └── adaptive-governor.md
  └── integration/
      ├── quickstart.md
      ├── qos-setup.md
      └── monitoring.md

scripts/
  └── auto-rollback.sh
```

---

### B. Configuration Examples

**Development:**
```yaml
phase4_rollout:
  percentage: 0  # Disabled

qos_monitor:
  enabled: true
  sample_rate: 1  # Full sampling for testing
```

**Staging:**
```yaml
phase4_rollout:
  percentage: 100  # Fully enabled

qos_monitor:
  enabled: true
  sample_rate: 1
```

**Production:**
```yaml
phase4_rollout:
  percentage: 100

qos_monitor:
  enabled: true
  sample_rate: 0.1  # 10% sampling
```

---

### C. Performance Targets Summary

| Metric | Baseline | Target | Status |
|--------|----------|--------|--------|
| TTFT P95 | 800ms | ≤550ms | ⏳ TBD |
| Throughput | 100 req/s | 130 req/s | ⏳ TBD |
| Concurrency | 50 streams | 75 streams | ⏳ TBD |
| Error Rate | 0% | 0% | ⏳ TBD |

---

### D. Timeline Summary

| Week | Focus | Deliverables |
|------|-------|--------------|
| 1 | Integration Testing | All components integrated, tests passing |
| 2 | Performance Validation | Benchmarks complete, targets validated |
| 3 | Documentation & Rollout | Docs complete, 100% deployed |

**Total Duration:** 3 weeks
**Team Size:** 2-3 engineers
**Risk Level:** Medium

---

**Document Status:** READY FOR IMPLEMENTATION
**Next Steps:** Begin Week 1 tasks
**Contact:** Engineering team
