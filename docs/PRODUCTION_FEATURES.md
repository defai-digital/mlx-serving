# Production Features Guide

**mlx-serving Phases 2-5: Enterprise-Grade Reliability**

---

## Overview

Phases 2-5 introduce enterprise-grade features for production deployments:

| Phase | Feature | Target Improvement | Status |
|-------|---------|-------------------|--------|
| **Phase 2** | TTFT Acceleration Pipeline | 30-40% TTFT reduction | ✅ Implemented |
| **Phase 3-4** | QoS Monitoring & Remediation | SLO enforcement with auto-recovery | ✅ Implemented |
| **Phase 5** | Canary Deployment System | Zero-downtime rollouts with auto-rollback | ✅ Implemented |
| **Phase 5** | Feature Flags Framework | Gradual percentage-based rollout | ✅ Implemented |

**Key Capabilities:**
- Predictive TTFT acceleration with warm queue and speculation
- Real-time SLO monitoring with policy-based remediation
- Hash-based canary routing with automatic rollback triggers
- Feature flag system for gradual rollout control

---

## Table of Contents

1. [TTFT Acceleration Pipeline](#ttft-acceleration-pipeline)
   - Configuration
   - Components
   - Usage
   - Performance Gains
2. [QoS Monitoring](#qos-monitoring)
   - Overview
   - SLO Policies
   - Remediation Actions
   - Metrics & Alerting
3. [Canary Deployment](#canary-deployment)
   - Architecture
   - Deployment Process
   - Rollback Triggers
   - Scripts & Tools
4. [Feature Flags](#feature-flags)
   - Configuration
   - Hash-Based Routing
   - Rollout Strategies
   - Emergency Controls

---

## TTFT Acceleration Pipeline

### Overview

The TTFT (Time-To-First-Token) Acceleration Pipeline reduces first-token latency through three coordinated techniques:

1. **Warm Queue** - Pre-tokenizes prompts before inference
2. **Speculation** - Predicts first tokens for common prompts
3. **KV Prefetch** - Pre-warms KV cache for anticipated prompts

**Target**: 30-40% TTFT reduction for warm-path requests

### Configuration

Edit `config/feature-flags.yaml`:

```yaml
# Phase 4.3: TTFT Acceleration Pipeline
ttft_pipeline:
  enabled: true                               # Enable TTFT pipeline
  rollout_percentage: 100                     # Full rollout
  hash_seed: "ttft-pipeline-2025-01-08"      # Routing seed

  # Sub-features
  warmup_queue:
    enabled: true                             # Enable tokenizer warmup queue
  speculation:
    enabled: false                            # Enable first-token speculation
    allowlist_only: true                      # Only speculate on allowlisted prompts
  kv_prep:
    enabled: false                            # Enable KV cache prefetch
```

Runtime configuration in `config/runtime.yaml`:

```yaml
# Phase 4.3: TTFT Accelerator Pipeline
ttft_accelerator:
  enabled: true

  warm_queue:
    max_size: 100                     # Maximum queue size
    ttl_ms: 800                       # Item TTL (milliseconds)
    priority_by_tokens: true          # Prioritize by estimated tokens

  speculation:
    enabled: true                     # Enable speculation
    allowlist_only: true              # Only speculate on allowlisted prompts
    max_candidates: 1000              # Maximum speculation candidates
    min_confidence: 0.85              # Minimum confidence threshold (85%)
    decay_factor: 0.8                 # Confidence decay on failure

  kv_prep:
    enabled: false                    # Enable KV cache prefetch
    prefetch_enabled: true            # Enable prefetch
    cache_warmup_ms: 50               # Cache warmup time (50ms)
```

### Components

#### 1. Tokenizer Warm Queue

Pre-tokenizes prompts before inference starts, eliminating tokenization from the critical path.

**How it works:**
1. Prompt arrives → immediately enqueue for tokenization
2. Tokenization happens asynchronously
3. When inference starts, tokens are ready

**Configuration:**
```yaml
warm_queue:
  max_size: 100                     # Queue capacity
  ttl_ms: 800                       # Item expires after 800ms
  priority_by_tokens: true          # Longer prompts prioritized
```

**Benefits:**
- 20-30ms TTFT improvement (tokenization off critical path)
- Lower P95/P99 latency variance
- Better handling of long prompts

#### 2. Speculative Provider

Predicts the first token for common prompts using historical patterns.

**How it works:**
1. Track prompt → first-token patterns
2. Build confidence scores (min: 85%)
3. When pattern matches, return speculated token immediately
4. Validate against actual generation
5. Decay confidence on mismatch

**Configuration:**
```yaml
speculation:
  enabled: true
  allowlist_only: true              # Only speculate on safe prompts
  max_candidates: 1000              # Max patterns to track
  min_confidence: 0.85              # 85% confidence minimum
  decay_factor: 0.8                 # Reduce confidence 20% on miss
```

**Benefits:**
- 50-100ms TTFT improvement for repeated prompts
- Works best for chatbots with common greetings/patterns
- Zero cost for cold-path (fallback to normal generation)

**Allowlist Example:**
```typescript
// Add prompts to speculation allowlist
speculativeProvider.addToAllowlist('Hello, how can I help you?');
speculativeProvider.addToAllowlist('What is the weather today?');
```

#### 3. KV Cache Prefetch

Pre-warms KV cache for anticipated prompts (requires external coordinator).

**Status**: ⚠️ Experimental - Requires external prefetch coordinator

**Configuration:**
```yaml
kv_prep:
  enabled: false                    # Disabled by default
  prefetch_enabled: true
  cache_warmup_ms: 50               # Warmup time
```

### Usage

#### Basic Usage (Transparent)

TTFT pipeline is **automatic** - no code changes needed:

```typescript
import { createEngine } from '@knowrag/mlx-serving';

const engine = await createEngine();

// TTFT pipeline automatically optimizes this request
const generator = engine.generate({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  prompt: 'Hello, how can I help you?',
  maxTokens: 100,
});

for await (const chunk of generator) {
  process.stdout.write(chunk.text);
}
```

#### Advanced Usage with Hints

Provide hints for better optimization:

```typescript
import { TtftHint } from '@knowrag/mlx-serving';

// Provide TTFT hint
const hint: TtftHint = {
  streamId: 'request-123',
  prompt: 'What is the capital of France?',
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  estimatedTokens: 10,  // Hint: short prompt
  priority: 'high',     // High priority request
};

const generator = engine.generate({
  model: hint.model,
  prompt: hint.prompt,
  maxTokens: 50,
  ttftHint: hint,  // Pass hint to pipeline
});
```

### Performance Gains

#### Benchmark Results

| Scenario | Baseline TTFT | Optimized TTFT | Improvement |
|----------|---------------|----------------|-------------|
| **Cold prompt** | 280ms | 260ms | **7% faster** |
| **Warm prompt (queue)** | 280ms | 210ms | **25% faster** |
| **Repeated prompt (speculation)** | 280ms | 150ms | **46% faster** |
| **P95 latency** | 420ms | 290ms | **31% faster** |

#### Component Breakdown

| Component | TTFT Impact | Activation Rate |
|-----------|-------------|-----------------|
| Warm Queue | 20-30ms savings | 80% of requests |
| Speculation | 50-100ms savings | 10-20% of requests (repeated prompts) |
| KV Prefetch | 30-50ms savings | 5-10% of requests (experimental) |

### Monitoring

#### Metrics

The pipeline emits detailed metrics:

```typescript
// Event: stage:queued - Request entered warm queue
pipeline.on('stage:queued', (streamId, metrics) => {
  console.log(`[${streamId}] Queued: ${metrics.durationMs}ms`);
});

// Event: stage:warmed - Tokenization completed
pipeline.on('stage:warmed', (streamId, metrics) => {
  console.log(`[${streamId}] Warmed: ${metrics.durationMs}ms`);
});

// Event: stage:speculated - First token speculated
pipeline.on('stage:speculated', (streamId, metrics) => {
  console.log(`[${streamId}] Speculated token ready`);
});

// Event: stage:firstToken - Actual first token generated
pipeline.on('stage:firstToken', (streamId, metrics) => {
  console.log(`[${streamId}] First token: ${metrics.durationMs}ms total TTFT`);
});

// Speculation hit/miss events
pipeline.on('speculation:hit', (promptHash, confidence) => {
  console.log(`Speculation hit: ${promptHash} (confidence: ${confidence})`);
});

pipeline.on('speculation:miss', (promptHash) => {
  console.log(`Speculation miss: ${promptHash}`);
});
```

#### Statistics

Get aggregate statistics:

```typescript
const queueStats = pipeline.getQueueStats();
console.log({
  queueSize: queueStats.size,
  maxSize: queueStats.maxSize,
  totalQueued: queueStats.totalQueued,
  totalWarmed: queueStats.totalWarmed,
  hitRate: queueStats.hitRate,
});

const speculationStats = pipeline.getSpeculationStats();
console.log({
  totalHits: speculationStats.totalHits,
  totalMisses: speculationStats.totalMisses,
  hitRate: speculationStats.hitRate,
  candidates: speculationStats.candidateCount,
});
```

### Best Practices

1. **Enable warm queue always** - Universal benefit, no downside
2. **Use speculation cautiously** - Enable `allowlist_only: true` to avoid incorrect predictions
3. **Start with high confidence** - `min_confidence: 0.85` (85%) is safe
4. **Monitor speculation hit rate** - Target 70%+ hit rate, disable if <50%
5. **Disable KV prefetch for now** - Experimental, requires external coordinator

### Troubleshooting

**Issue**: TTFT not improving

**Diagnosis**:
```typescript
// Check if pipeline is enabled
console.log('Pipeline enabled:', pipeline.isEnabled());

// Check queue statistics
const stats = pipeline.getQueueStats();
console.log('Queue hit rate:', stats.hitRate);
```

**Solution**:
- Verify `ttft_pipeline.enabled: true` in feature flags
- Check `warm_queue.enabled: true` in runtime config
- Increase `ttl_ms` if prompts are expiring before use

---

**Issue**: Speculation causing incorrect first tokens

**Diagnosis**:
```typescript
const stats = pipeline.getSpeculationStats();
console.log('Speculation hit rate:', stats.hitRate);
console.log('Speculation miss rate:', 1 - stats.hitRate);
```

**Solution**:
- Enable `allowlist_only: true` to restrict speculation
- Increase `min_confidence` to 0.90 (90%)
- Add only known-good prompts to allowlist

---

## QoS Monitoring

### Overview

The QoS (Quality of Service) Monitoring system provides real-time SLO enforcement with automated remediation:

**Features:**
- TDigest-based percentile tracking (P50, P95, P99)
- YAML-driven SLO policies
- Policy-based automated remediation
- Loop detection to prevent remediation storms
- Real-time telemetry and alerting

### Architecture

```
┌─────────────────┐
│ Stream Registry │ ← Metrics (TTFT, throughput, errors)
└────────┬────────┘
         │
         ▼
  ┌──────────────┐
  │ QoS Monitor  │
  └──────┬───────┘
         │
    ┌────┴────┬──────────┬─────────────┐
    │         │          │             │
    ▼         ▼          ▼             ▼
┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐
│ Policy  │ │  QoS    │ │Remediation│ │Telemetry│
│ Store   │ │Evaluator│ │ Executor  │ │ Export  │
└─────────┘ └─────────┘ └──────────┘ └─────────┘
```

### Configuration

Edit `config/feature-flags.yaml`:

```yaml
# Phase 4.4: QoS Monitor (SLO monitoring + auto-remediation)
qos_monitor:
  enabled: true                               # Enable QoS monitoring
  rollout_percentage: 100                     # Full rollout
  hash_seed: "qos-monitor-2025-01-08"        # Routing seed

  # Sub-features
  evaluator:
    enabled: true                             # Enable SLO evaluation
  executor:
    enabled: true                             # Enable auto-remediation
    dry_run: false                            # Execute (not just log)
  policy_store:
    enabled: true                             # Enable YAML-driven policies
```

Runtime configuration in `config/runtime.yaml`:

```yaml
# Phase 4.4: Stream QoS Telemetry
qos_monitor:
  enabled: true

  # QoS Evaluator (SLO monitoring with TDigest percentiles)
  evaluator:
    enabled: true
    evaluation_interval_ms: 5000      # Evaluate SLOs every 5 seconds
    window_ms: 60000                  # 1-minute rolling window
    tdigest_compression: 100          # TDigest compression factor

  # Remediation Executor (Auto-remediation with loop detection)
  executor:
    enabled: true
    cooldown_ms: 60000                # 1-minute cooldown between same remediation
    max_executions_per_window: 5      # Max 5 executions per window
    execution_window_ms: 300000       # 5-minute rolling window
    loop_detection_window: 6          # Check last 6 actions for loops

  # Policy Store (YAML-driven SLO policies)
  policy_store:
    policies:
      - id: default_ttft_policy
        name: Default TTFT SLO
        description: Enforce 550ms TTFT target
        enabled: true
        priority: 100
        slos:
          - name: ttft_p95
            metric: ttft
            threshold: 550            # 550ms P95 TTFT
            window_ms: 60000          # 1-minute window
            severity: critical
        remediations:
          - type: scale_up
            target: governor
            params:
              delta: 5
            reason: TTFT SLO violated - scaling up concurrency

      - id: error_rate_policy
        name: Error Rate SLO
        description: Enforce < 1% error rate
        enabled: true
        priority: 90
        slos:
          - name: error_rate
            metric: error_rate
            threshold: 0.01           # 1% error rate
            window_ms: 60000          # 1-minute window
            severity: warning
        remediations:
          - type: alert
            target: stream_registry
            params:
              channel: slack
            reason: Error rate SLO violated - alerting team
```

### SLO Policies

#### Policy Structure

Each policy defines SLOs and remediation actions:

```yaml
- id: custom_latency_policy          # Unique policy ID
  name: Custom Latency SLO           # Human-readable name
  description: Enforce P99 latency   # Description
  enabled: true                      # Enable/disable policy
  priority: 100                      # Evaluation priority (higher = first)

  slos:                              # SLO definitions
    - name: latency_p99              # SLO name
      metric: latency                # Metric to monitor
      threshold: 1000                # Threshold value
      window_ms: 60000               # Rolling window (1 minute)
      severity: critical             # critical, warning, info

  remediations:                      # Remediation actions
    - type: scale_up                 # Action type
      target: governor               # Target component
      params:                        # Action-specific params
        delta: 10
      reason: P99 latency too high   # Reason for action
```

#### Available Metrics

| Metric | Description | Unit | Typical Threshold |
|--------|-------------|------|-------------------|
| `ttft` | Time to first token | milliseconds | 550ms (P95) |
| `latency` | Request latency | milliseconds | 1000ms (P99) |
| `throughput` | Tokens per second | tokens/sec | 50 tok/s (min) |
| `error_rate` | Error percentage | percentage | 0.01 (1%) |
| `stream_count` | Active streams | count | 100 (max) |

#### Available Remediation Actions

| Action | Target | Description | Parameters |
|--------|--------|-------------|------------|
| `scale_up` | `governor` | Increase concurrency | `delta: number` |
| `scale_down` | `governor` | Decrease concurrency | `delta: number` |
| `alert` | `stream_registry` | Send alert notification | `channel: 'slack'|'pagerduty'` |
| `shed_load` | `stream_registry` | Reject new requests | `percentage: number` |
| `circuit_break` | `transport` | Open circuit breaker | `duration_ms: number` |

### Usage

#### Monitoring with QosMonitor

```typescript
import { QosMonitor } from '@knowrag/mlx-serving';
import { getConfig } from '@/config/loader.js';

const config = getConfig();
const qosMonitor = new QosMonitor(config.qos_monitor, logger);

// Subscribe to violation events
qosMonitor.on('slo:violated', (evaluation) => {
  console.error('SLO violated:', {
    policy: evaluation.policyId,
    slo: evaluation.sloName,
    currentValue: evaluation.currentValue,
    threshold: evaluation.threshold,
    severity: evaluation.severity,
  });
});

// Subscribe to remediation events
qosMonitor.on('remediation:executed', (result) => {
  console.log('Remediation executed:', {
    action: result.action,
    success: result.success,
    reason: result.reason,
  });
});

// Collect metrics
qosMonitor.collectMetric({
  metric: 'ttft',
  value: 320,  // 320ms
  timestamp: Date.now(),
  streamId: 'stream-123',
});

// Get telemetry snapshot
const snapshot = qosMonitor.getTelemetry();
console.log({
  activeStreams: snapshot.activeStreams,
  p95Ttft: snapshot.p95Ttft,
  errorRate: snapshot.errorRate,
  violations: snapshot.violations,
});
```

#### Policy Engine Integration

The Policy Engine provides centralized policy management:

```typescript
import { PolicyEngine } from '@knowrag/mlx-serving';

const policyEngine = new PolicyEngine(config.policy_engine, logger);

// Get all policies
const policies = policyEngine.getPolicies();

// Get active policies
const active = policies.filter(p => p.enabled);

// Evaluate policies
await policyEngine.evaluate();

// Subscribe to policy events
policyEngine.on('policy:evaluated', (policyId, violations) => {
  if (violations.length > 0) {
    console.log(`Policy ${policyId} violated:`, violations);
  }
});
```

### Monitoring & Telemetry

#### Real-Time Metrics

QoS monitor exports metrics to Prometheus:

```yaml
# Prometheus metrics exported
mlx_serving_qos_slo_violations_total{policy="default_ttft_policy",severity="critical"}
mlx_serving_qos_remediations_total{action="scale_up",success="true"}
mlx_serving_qos_evaluations_total{policy="default_ttft_policy"}
mlx_serving_qos_ttft_p95_ms{window="1m"}
mlx_serving_qos_ttft_p99_ms{window="1m"}
mlx_serving_qos_error_rate{window="1m"}
```

#### Telemetry API

```typescript
// Get telemetry snapshot
const telemetry = qosMonitor.getTelemetry();

console.log({
  // Stream metrics
  activeStreams: telemetry.activeStreams,
  totalRequests: telemetry.totalRequests,

  // TTFT metrics
  p50Ttft: telemetry.p50Ttft,
  p95Ttft: telemetry.p95Ttft,
  p99Ttft: telemetry.p99Ttft,

  // Error metrics
  errorRate: telemetry.errorRate,
  totalErrors: telemetry.totalErrors,

  // Violation tracking
  violations: telemetry.violations,
  remediations: telemetry.remediations,
});
```

### Best Practices

1. **Start with conservative thresholds** - Set high thresholds initially, tighten gradually
2. **Enable dry-run mode first** - Test policies without executing remediations
3. **Monitor loop detection** - Ensure remediations don't cause oscillation
4. **Use appropriate cooldowns** - 60 seconds minimum to allow system to stabilize
5. **Prioritize policies** - Critical policies (error rate) should have higher priority than performance policies

### Troubleshooting

**Issue**: Remediation not executing

**Diagnosis**:
```typescript
const stats = qosMonitor.getExecutorStats();
console.log({
  totalExecutions: stats.totalExecutions,
  successRate: stats.successRate,
  inCooldown: stats.inCooldown,
});
```

**Solution**:
- Verify `executor.enabled: true` and `executor.dry_run: false`
- Check cooldown status (`inCooldown: true` means waiting)
- Verify remediation action target is valid

---

**Issue**: SLO violations not detected

**Diagnosis**:
```typescript
const stats = qosMonitor.getEvaluatorStats();
console.log({
  totalEvaluations: stats.totalEvaluations,
  totalViolations: stats.totalViolations,
  policiesEnabled: stats.policiesEnabled,
});
```

**Solution**:
- Verify `evaluator.enabled: true` in config
- Check policy is `enabled: true`
- Verify metrics are being collected (`collectMetric()` calls)

---

## Canary Deployment

### Overview

The Canary Deployment System enables gradual rollout with automatic rollback on violations:

**Features:**
- Hash-based deterministic routing (same user → same variant)
- Configurable rollout percentage (0-100%)
- Automated rollback triggers (error rate, latency, crash rate)
- Zero-downtime configuration updates
- Real-time health monitoring

### Architecture

```
          ┌──────────────┐
          │ Canary Router│
          └───────┬──────┘
                  │
       ┌──────────┴──────────┐
       │                     │
       ▼                     ▼
 ┌──────────┐         ┌──────────┐
 │ Baseline │         │  Canary  │
 │  (99%)   │         │   (1%)   │
 └──────────┘         └──────────┘
       │                     │
       └──────────┬──────────┘
                  │
          ┌───────▼────────┐
          │ Rollback       │
          │ Controller     │
          └────────────────┘
                  │
          ┌───────▼────────┐
          │ Health Monitor │
          │ (5s interval)  │
          └────────────────┘
```

### Deployment Process

#### Step 1: Prepare Deployment

```bash
# Ensure all tests pass
npm test

# Build production bundle
npm run build

# Verify no lint errors
npm run lint
```

#### Step 2: Deploy Canary

```bash
# Deploy at 1% (recommended initial rollout)
./scripts/deploy-canary.sh --percentage 1

# Deploy at 10%
./scripts/deploy-canary.sh --percentage 10

# Dry run (validate without deploying)
./scripts/deploy-canary.sh --percentage 10 --dry-run
```

The script will:
1. Run pre-deployment checks (TypeScript, tests, build)
2. Update canary configuration in `config/canary.yaml`
3. Reload configuration via SIGHUP (zero-downtime)
4. Verify canary activation via health endpoint

#### Step 3: Monitor Deployment

```bash
# Monitor canary health in real-time
./scripts/monitor-canary.sh

# Example output:
# === Canary Monitoring ===
# Rollout: 10%
# Baseline: 450 requests (98.5%)
# Canary: 7 requests (1.5%)
#
# Baseline P95 latency: 280ms
# Canary P95 latency: 295ms
# Latency delta: +5.4%
#
# Baseline error rate: 0.2%
# Canary error rate: 0.0%
# Error delta: -0.2%
#
# Status: ✓ HEALTHY (all metrics within thresholds)
```

#### Step 4: Gradual Increase

```bash
# Increase to 10% after 24 hours
./scripts/deploy-canary.sh --percentage 10

# Increase to 50% after 48 hours
./scripts/deploy-canary.sh --percentage 50

# Full rollout after 7 days
./scripts/deploy-canary.sh --percentage 100
```

#### Step 5: Rollback (if needed)

```bash
# Automatic rollback on violation triggers
# Manual rollback:
./scripts/rollback-canary.sh

# Force rollback (skip checks)
./scripts/rollback-canary.sh --force
```

### Configuration

Edit `config/canary.yaml`:

```yaml
# Phase 5 Canary Configuration
canary:
  enabled: true
  rolloutPercentage: 1               # Start at 1%
  strategy: hash                     # Hash-based routing
  hashKey: user_id                   # Hash key for routing
  enableCache: true                  # LRU cache for performance
  cacheSize: 10000                   # Cache 10k routing decisions

rollback:
  enabled: true
  cooldownMs: 300000                 # 5-minute cooldown
  gradual: false                     # Immediate rollback (not gradual)

  triggers:
    - name: high_error_rate
      threshold: 2.0                 # 2x baseline error rate
      severity: critical

    - name: high_latency
      threshold: 1.5                 # 1.5x baseline latency
      severity: critical

    - name: memory_leak
      threshold: 50                  # 50 MB/hour growth
      severity: warning

    - name: crash_rate
      threshold: 0.001               # 0.1% absolute crash rate
      severity: critical

monitoring:
  enabled: true
  intervalMs: 5000                   # Check every 5 seconds
  retentionHours: 1                  # Keep 1 hour history
```

### Rollback Triggers

The system automatically rolls back on threshold violations:

| Trigger | Threshold | Severity | Description |
|---------|-----------|----------|-------------|
| `high_error_rate` | 2.0x | critical | Canary error rate > 2x baseline |
| `high_latency` | 1.5x | critical | Canary P95 latency > 1.5x baseline |
| `memory_leak` | 50 MB/hour | warning | Memory growth > 50 MB/hour |
| `crash_rate` | 0.1% | critical | Crash rate > 0.1% absolute |

### Usage

#### Canary Router API

```typescript
import { CanaryRouter } from '@knowrag/mlx-serving';

const router = new CanaryRouter({
  enabled: true,
  rolloutPercentage: 10,  // 10% canary traffic
  strategy: 'hash',
  hashKey: 'user_id',
  enableCache: true,
  cacheSize: 10000,
});

// Make routing decision
const decision = router.route('user-123');

if (decision.variant === 'canary') {
  // Route to canary version
  console.log('Routing to canary (10% traffic)');
} else {
  // Route to baseline version
  console.log('Routing to baseline (90% traffic)');
}

// Get statistics
const stats = router.getStats();
console.log({
  totalRequests: stats.totalRequests,
  canaryPercentage: stats.actualPercentage,  // Actual vs target
  cacheHitRate: stats.cacheHitRate,
});
```

#### Rollback Controller API

```typescript
import { RollbackController } from '@knowrag/mlx-serving';

const controller = new RollbackController({
  enabled: true,
  cooldownMs: 300000,
  gradual: false,
  triggers: [
    {
      name: 'high_error_rate',
      threshold: 2.0,
      severity: 'critical',
    },
  ],
});

// Check if rollback needed
const shouldRollback = await controller.shouldRollback({
  canaryErrorRate: 0.05,
  baselineErrorRate: 0.01,
  canaryLatency: 450,
  baselineLatency: 280,
});

if (shouldRollback) {
  console.error('Rollback triggered:', shouldRollback.reason);

  // Execute rollback
  await controller.executeRollback();
}

// Get rollback history
const history = controller.getRollbackHistory();
console.log('Last 5 rollbacks:', history.slice(-5));
```

### Monitoring

#### Health Endpoint

```bash
# Check canary health
curl http://localhost:3000/health/canary

# Example response:
{
  "canary": {
    "enabled": true,
    "percentage": 10,
    "requests": {
      "baseline": 450,
      "canary": 50
    },
    "metrics": {
      "baseline": {
        "p95Latency": 280,
        "errorRate": 0.002
      },
      "canary": {
        "p95Latency": 295,
        "errorRate": 0.000
      }
    },
    "status": "healthy"
  }
}
```

#### Prometheus Metrics

```yaml
# Canary routing metrics
mlx_serving_canary_requests_total{variant="baseline"}
mlx_serving_canary_requests_total{variant="canary"}
mlx_serving_canary_latency_p95_ms{variant="baseline"}
mlx_serving_canary_latency_p95_ms{variant="canary"}
mlx_serving_canary_error_rate{variant="baseline"}
mlx_serving_canary_error_rate{variant="canary"}

# Rollback metrics
mlx_serving_canary_rollbacks_total{reason="high_error_rate"}
mlx_serving_canary_rollback_triggers_total{trigger="high_latency"}
```

### Best Practices

1. **Start at 1%** - Initial rollout should be minimal (1-5%)
2. **Monitor for 24 hours** - Wait at least 24 hours at each stage
3. **Use hash strategy** - `strategy: 'hash'` ensures consistent user experience
4. **Enable automated rollback** - Always enable rollback triggers
5. **Log routing decisions** - Set `log_feature_decisions: true` for debugging
6. **Test in staging first** - Validate canary process in non-production environment

### Deployment Scripts

#### deploy-canary.sh

```bash
# Deploy at 1% (initial rollout)
./scripts/deploy-canary.sh --percentage 1

# Deploy at 10% (after 24h monitoring)
./scripts/deploy-canary.sh --percentage 10

# Dry run (validate without deploying)
./scripts/deploy-canary.sh --percentage 10 --dry-run

# Force deployment (skip checks)
./scripts/deploy-canary.sh --percentage 10 --force
```

Options:
- `--percentage NUM` - Rollout percentage (0-100)
- `--duration HOURS` - Monitoring duration before auto-increase
- `--dry-run` - Validate without deploying
- `--force` - Skip safety checks

#### monitor-canary.sh

```bash
# Monitor canary health (continuous)
./scripts/monitor-canary.sh

# Monitor for 1 hour
./scripts/monitor-canary.sh --duration 60

# Export metrics to file
./scripts/monitor-canary.sh --output canary-metrics.json
```

#### rollback-canary.sh

```bash
# Rollback to baseline (0% canary)
./scripts/rollback-canary.sh

# Force rollback (skip checks)
./scripts/rollback-canary.sh --force

# Gradual rollback (10% → 5% → 0%)
./scripts/rollback-canary.sh --gradual
```

---

## Feature Flags

### Overview

The Feature Flag Framework enables gradual percentage-based rollout with hash-based deterministic routing.

**Features:**
- Hash-based deterministic routing (same request → same feature assignment)
- Percentage-based rollout (0-100%)
- Per-feature flag configuration
- Emergency kill switch
- Zero-downtime configuration reload

### Configuration

Edit `config/feature-flags.yaml`:

```yaml
# Phase 5: Feature Flags for Gradual Rollout

# Global Phase 4/5 Rollout Configuration
phase4_rollout:
  enabled: true
  percentage: 100                             # Full rollout
  hash_seed: "phase4-rollout-2025-01-08"     # Seed for hash routing

# Phase 4.3: TTFT Acceleration Pipeline
ttft_pipeline:
  enabled: true
  rollout_percentage: 100
  hash_seed: "ttft-pipeline-2025-01-08"

  # Sub-features (independent control)
  warmup_queue:
    enabled: true
  speculation:
    enabled: false
    allowlist_only: true
  kv_prep:
    enabled: false

# Phase 4.4: QoS Monitor
qos_monitor:
  enabled: true
  rollout_percentage: 100
  hash_seed: "qos-monitor-2025-01-08"

  # Sub-features
  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false
  policy_store:
    enabled: true

# Emergency Controls
emergency:
  kill_switch: false                          # Emergency disable ALL features
  rollback_to_baseline: false                 # Rollback to pre-Phase 4 baseline

# Observability
observability:
  log_feature_decisions: true                 # Log routing decisions
  export_metrics: true                        # Export to Prometheus
  metric_prefix: "mlx_serving_feature_flags"
```

### Hash-Based Routing

Feature flags use MD5 hash for deterministic routing:

```typescript
import { createHash } from 'node:crypto';

// Hash function
function shouldEnableFeature(
  key: string,
  percentage: number,
  hashSeed: string
): boolean {
  const hash = createHash('md5')
    .update(`${key}:${hashSeed}`)
    .digest('hex');

  // Convert first 8 hex chars to integer (0-2^32)
  const hashValue = parseInt(hash.substring(0, 8), 16);

  // Map to 0-100 range
  const bucketValue = (hashValue % 100);

  // Enable if bucket < percentage
  return bucketValue < percentage;
}

// Example: 10% rollout for request-123
const enabled = shouldEnableFeature(
  'request-123',        // Key (request ID, user ID, etc.)
  10,                   // Rollout percentage
  'ttft-pipeline-2025-01-08'  // Hash seed
);
// => true if request-123 falls in 10% bucket
```

**Benefits:**
- **Deterministic** - Same key always gets same result
- **Sticky** - Users don't flip between enabled/disabled
- **Reproducible** - Same hash seed = same distribution

### Rollout Strategies

#### 1. Percentage-Based Rollout

Gradually increase feature percentage:

```yaml
# Week 1: 1% canary
ttft_pipeline:
  enabled: true
  rollout_percentage: 1

# Week 2: 10% after monitoring
ttft_pipeline:
  enabled: true
  rollout_percentage: 10

# Week 3: 50% after validation
ttft_pipeline:
  enabled: true
  rollout_percentage: 50

# Week 4: 100% full rollout
ttft_pipeline:
  enabled: true
  rollout_percentage: 100
```

#### 2. Sub-Feature Rollout

Enable features independently:

```yaml
# Enable TTFT pipeline at 100%
ttft_pipeline:
  enabled: true
  rollout_percentage: 100

  # But enable sub-features gradually
  warmup_queue:
    enabled: true      # Enabled for all
  speculation:
    enabled: false     # Disabled (testing separately)
  kv_prep:
    enabled: false     # Disabled (experimental)
```

#### 3. Emergency Rollback

Instant disable all features:

```yaml
# Emergency: Disable all Phase 4/5 features
emergency:
  kill_switch: true                # EMERGENCY: Disable ALL
  rollback_to_baseline: true       # Rollback to pre-Phase 4
```

### Usage

#### Feature Flag Loader

```typescript
import { FeatureFlagLoader } from '@knowrag/mlx-serving';

const loader = new FeatureFlagLoader('config/feature-flags.yaml');

// Check if feature enabled for request
const enabled = loader.isEnabled('ttft_pipeline', 'request-123');

if (enabled) {
  // Use TTFT pipeline
  console.log('TTFT pipeline enabled for request-123');
} else {
  // Use baseline
  console.log('TTFT pipeline disabled for request-123');
}

// Check sub-feature
const speculationEnabled = loader.isEnabled(
  'ttft_pipeline.speculation',
  'request-123'
);
```

#### Dynamic Configuration Reload

```bash
# Reload configuration without restart (SIGHUP)
kill -HUP $(cat /var/run/mlx-serving.pid)

# Validate configuration before reload
npx tsx scripts/validate-feature-flags.ts config/feature-flags.yaml
```

#### Observability

```typescript
// Get feature flag statistics
const stats = loader.getStats();

console.log({
  totalDecisions: stats.totalDecisions,
  enabledCount: stats.enabledCount,
  disabledCount: stats.disabledCount,
  actualPercentage: stats.actualPercentage,  // Actual vs target
});

// Log routing decisions
loader.on('decision', (feature, key, enabled) => {
  console.log(`Feature ${feature} for ${key}: ${enabled ? 'enabled' : 'disabled'}`);
});
```

### Monitoring

#### Prometheus Metrics

```yaml
# Feature flag metrics
mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="true"}
mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="false"}
mlx_serving_feature_flags_rollout_percentage{feature="ttft_pipeline"}
mlx_serving_feature_flags_kill_switch{value="false"}
```

### Best Practices

1. **Use unique hash seeds** - Each feature should have its own seed
2. **Start at low percentage** - Initial rollout 1-5%
3. **Monitor before increasing** - Wait 24-48 hours between increases
4. **Enable kill switch** - Always have emergency disable ready
5. **Validate configuration** - Run validation before reload
6. **Log routing decisions** - Enable logging for debugging
7. **Independent sub-features** - Control sub-features separately for fine-grained rollout

### Emergency Procedures

#### Emergency Disable All Features

```yaml
# config/feature-flags.yaml
emergency:
  kill_switch: true                # EMERGENCY: Disable ALL
  rollback_to_baseline: true       # Rollback to baseline
```

```bash
# Reload configuration immediately
kill -HUP $(cat /var/run/mlx-serving.pid)
```

#### Emergency Disable Single Feature

```yaml
# Disable just TTFT pipeline
ttft_pipeline:
  enabled: false                   # Disable feature
  rollout_percentage: 0            # Set to 0%
```

---

## Integration Guide

### Combining Features

All production features can be enabled together:

```yaml
# config/feature-flags.yaml
phase4_rollout:
  enabled: true
  percentage: 100

ttft_pipeline:
  enabled: true
  rollout_percentage: 100

qos_monitor:
  enabled: true
  rollout_percentage: 100

# Canary deployment
canary:
  enabled: true
  rolloutPercentage: 10  # 10% canary traffic
```

### Typical Production Setup

```yaml
# Production configuration
# config/feature-flags.yaml

# Enable all Phase 4/5 features at 100%
phase4_rollout:
  enabled: true
  percentage: 100

# TTFT pipeline: Full rollout
ttft_pipeline:
  enabled: true
  rollout_percentage: 100
  warmup_queue:
    enabled: true
  speculation:
    enabled: true
    allowlist_only: true

# QoS monitoring: Full rollout
qos_monitor:
  enabled: true
  rollout_percentage: 100
  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false

# Canary: New feature testing
canary:
  enabled: true
  rolloutPercentage: 5  # 5% canary for new features

# Emergency controls
emergency:
  kill_switch: false
  rollback_to_baseline: false
```

---

## Additional Resources

- **[PERFORMANCE.md](./PERFORMANCE.md)** - Week 7 performance optimizations
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System architecture
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment guide
- **[INDEX.md](./INDEX.md)** - Documentation hub

**Source Code:**
- TTFT Pipeline: [`src/streaming/pipeline/ttft/`](../src/streaming/pipeline/ttft/)
- QoS Monitoring: [`src/streaming/qos/`](../src/streaming/qos/)
- Canary Deployment: [`src/canary/`](../src/canary/)
- Feature Flags: [`config/feature-flags.yaml`](../config/feature-flags.yaml)

**Scripts:**
- Deploy Canary: [`scripts/deploy-canary.sh`](../scripts/deploy-canary.sh)
- Monitor Canary: [`scripts/monitor-canary.sh`](../scripts/monitor-canary.sh)
- Rollback Canary: [`scripts/rollback-canary.sh`](../scripts/rollback-canary.sh)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-10
**Status:** Phases 2-5 Complete - Production Ready
