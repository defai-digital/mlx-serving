# Production Features Examples

**Enterprise-grade production features for mlx-serving (Phases 2-5)**

---

## Overview

This directory contains working examples demonstrating production-ready features:

1. **[QoS Monitoring](./01-qos-monitoring.ts)** - SLO evaluation and automated remediation
2. **[Canary Deployment](./02-canary-deployment.ts)** - Hash-based traffic splitting with rollback
3. **[Feature Flags](./03-feature-flags.ts)** - Percentage-based gradual rollout

**Production Benefits**:
- **TTFT**: 30-40% improvement with TTFT pipeline
- **Reliability**: SLO enforcement with auto-remediation
- **Safety**: Zero-downtime canary deployments with automatic rollback
- **Control**: Gradual feature rollout with deterministic routing

---

## Prerequisites

```bash
# Install package
npm install @knowrag/mlx-serving

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
# QoS monitoring example
npx tsx examples/production/01-qos-monitoring.ts

# Canary deployment example
npx tsx examples/production/02-canary-deployment.ts

# Feature flags example
npx tsx examples/production/03-feature-flags.ts
```

---

## Example 1: QoS Monitoring

**File**: [01-qos-monitoring.ts](./01-qos-monitoring.ts)

**What it demonstrates**:
- Configuring QoS SLO policies
- Real-time SLO evaluation
- Automated remediation on violations
- Policy-based quality control

**Key features**:
- TDigest percentile tracking (P50, P95, P99)
- Policy engine with multiple policies
- Dry-run mode for safe testing
- Prometheus metrics export

**Configuration**:
```yaml
# config/runtime.yaml
qos_monitor:
  enabled: true
  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false
  policy_store:
    enabled: true

# config/feature-flags.yaml
qos_monitor:
  enabled: true
  rollout_percentage: 100
```

---

## Example 2: Canary Deployment

**File**: [02-canary-deployment.ts](./02-canary-deployment.ts)

**What it demonstrates**:
- Hash-based traffic splitting
- Deterministic routing (same user → same version)
- Automated rollback on SLO violations
- Gradual rollout strategy

**Key features**:
- Configurable rollout percentage (1-100%)
- Hash-based routing (MD5)
- Automatic rollback controller
- Health check monitoring

**Configuration**:
```yaml
# config/feature-flags.yaml
canary:
  enabled: true
  rolloutPercentage: 10  # 10% canary traffic
  strategy: hash
  hashKey: user_id
  hashSeed: "canary-2025-01-08"

  # Rollback controller
  rollback:
    enabled: true
    errorRateThreshold: 0.05  # 5% error rate
    p99LatencyThreshold: 500  # 500ms P99
    evaluationWindow: 300     # 5 minutes
```

---

## Example 3: Feature Flags

**File**: [03-feature-flags.ts](./03-feature-flags.ts)

**What it demonstrates**:
- Percentage-based gradual rollout
- Hash-based deterministic routing
- Feature flag configuration
- Sub-feature control

**Key features**:
- Deterministic hash routing
- Independent sub-features
- Zero-downtime configuration reload
- Emergency kill switch

**Configuration**:
```yaml
# config/feature-flags.yaml
ttft_pipeline:
  enabled: true
  rollout_percentage: 10  # 10% rollout
  hash_seed: "ttft-pipeline-2025-01-08"

  warmup_queue:
    enabled: true
  speculation:
    enabled: false
    allowlist_only: true

emergency:
  kill_switch: false
  rollback_to_baseline: false
```

---

## TTFT Acceleration Pipeline

The TTFT pipeline is enabled via feature flags and provides:

1. **Tokenizer Warm Queue**: Parallel tokenization during model initialization (20-30ms TTFT improvement)
2. **First-Token Speculation**: Speculate first token for repeated prompts (50-100ms improvement)
3. **KV Cache Prefetch**: Experimental KV cache preparation

**Configuration**:
```yaml
# config/feature-flags.yaml
ttft_pipeline:
  enabled: true
  rollout_percentage: 100

  warmup_queue:
    enabled: true
  speculation:
    enabled: false  # Experimental
    allowlist_only: true
  kv_prep:
    enabled: false  # Experimental
```

**Result**: 30-40% TTFT reduction on average

---

## Progressive Rollout Strategy

Recommended rollout schedule for production features:

| Stage | Percentage | Duration | Action |
|-------|-----------|----------|--------|
| **Canary** | 1% | 24 hours | Initial validation |
| **Small** | 10% | 48 hours | Monitor metrics |
| **Medium** | 50% | 72 hours | Validate stability |
| **Full** | 100% | 7+ days | Complete rollout |

**Example rollout**:
```yaml
# Week 1: 1% canary
ttft_pipeline:
  rollout_percentage: 1

# Week 2: 10% after validation
ttft_pipeline:
  rollout_percentage: 10

# Week 3: 50% after stability
ttft_pipeline:
  rollout_percentage: 50

# Week 4: 100% full rollout
ttft_pipeline:
  rollout_percentage: 100
```

---

## Monitoring and Observability

### Prometheus Metrics

All production features export Prometheus metrics:

```yaml
# QoS metrics
mlx_serving_qos_slo_violations_total{policy="ttft_p99"}
mlx_serving_qos_remediation_actions_total{action="scale_down"}
mlx_serving_qos_ttft_p99_ms

# Canary metrics
mlx_serving_canary_requests_total{version="baseline"}
mlx_serving_canary_requests_total{version="canary"}
mlx_serving_canary_error_rate{version="canary"}

# Feature flag metrics
mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="true"}
mlx_serving_feature_flags_rollout_percentage{feature="ttft_pipeline"}
```

### Logging

Enable decision logging for debugging:

```yaml
# config/feature-flags.yaml
observability:
  log_feature_decisions: true
  export_metrics: true
  metric_prefix: "mlx_serving_feature_flags"
```

---

## Emergency Controls

### Kill Switch (Emergency Disable All)

```yaml
# config/feature-flags.yaml
emergency:
  kill_switch: true                 # Disable ALL Phase 4/5 features
  rollback_to_baseline: true        # Rollback to pre-Phase 4 behavior
```

**Use case**: Critical incident requiring immediate rollback

### Disable Single Feature

```yaml
# Disable just TTFT pipeline
ttft_pipeline:
  enabled: false
  rollout_percentage: 0
```

**Use case**: Isolated feature issue

### Rollback Configuration

```yaml
# config/feature-flags.yaml
canary:
  rollback:
    enabled: true
    errorRateThreshold: 0.05    # 5% error rate triggers rollback
    p99LatencyThreshold: 500    # 500ms P99 triggers rollback
    evaluationWindow: 300       # 5 minutes evaluation window
    cooldownPeriod: 600         # 10 minutes cooldown
```

---

## Best Practices

### 1. Start with Low Percentage

Initial rollout should be 1-5%:

```yaml
new_feature:
  enabled: true
  rollout_percentage: 1  # Start at 1%
```

### 2. Monitor Before Increasing

Wait 24-48 hours between rollout stages:

```
Day 0:  1% rollout  → Monitor 24h
Day 1:  10% rollout → Monitor 48h
Day 3:  50% rollout → Monitor 72h
Day 6:  100% full rollout
```

### 3. Use Unique Hash Seeds

Each feature should have its own seed:

```yaml
ttft_pipeline:
  hash_seed: "ttft-pipeline-2025-01-08"

qos_monitor:
  hash_seed: "qos-monitor-2025-01-08"
```

### 4. Enable Kill Switch

Always have emergency disable ready:

```yaml
emergency:
  kill_switch: false  # Ready but not active
  rollback_to_baseline: false
```

### 5. Test in Dry-Run Mode First

Test remediation policies without executing actions:

```yaml
qos_monitor:
  executor:
    dry_run: true  # Log actions without executing
```

---

## Troubleshooting

### QoS violations not triggering remediation

**Issue**: SLO violations detected but no remediation actions

**Diagnosis**:
```typescript
const qosStats = engine.getQosStats();
console.log({
  violations: qosStats.violations,
  remediations: qosStats.remediations,
  dryRun: qosStats.dryRun,
});
```

**Solution**:
- Check `executor.dry_run: false` in config
- Verify policy thresholds are correct
- Check executor logs for errors

### Canary not receiving traffic

**Issue**: 10% rollout configured but no traffic to canary

**Diagnosis**:
```typescript
const canaryStats = engine.getCanaryStats();
console.log({
  totalRequests: canaryStats.totalRequests,
  canaryRequests: canaryStats.canaryRequests,
  percentage: canaryStats.actualPercentage,
});
```

**Solution**:
- Verify `canary.enabled: true`
- Check `rolloutPercentage > 0`
- Ensure hash_seed is present
- Check routing key is unique per request

### Feature flag not enabling

**Issue**: Feature always disabled despite configuration

**Solution**:
```yaml
feature_name:
  enabled: true           # Must be true
  rollout_percentage: 10  # Must be > 0
  hash_seed: "valid-seed" # Must be present
```

---

## Additional Resources

- **[PRODUCTION_FEATURES.md](../../docs/PRODUCTION_FEATURES.md)** - Complete production features guide
- **[FEATURE_FLAGS.md](../../docs/FEATURE_FLAGS.md)** - Feature flag system reference
- **[PERFORMANCE.md](../../docs/PERFORMANCE.md)** - Week 7 performance optimizations
- **[Quick Start](../../docs/QUICK_START.md)** - 5-minute getting started guide
- **[Documentation Index](../../docs/INDEX.md)** - Full documentation hub

**Configuration Files**:
- [`config/feature-flags.yaml`](../../config/feature-flags.yaml) - Feature flag configuration
- [`config/runtime.yaml`](../../config/runtime.yaml) - Runtime configuration

---

**Last Updated**: 2025-11-10
**Version**: 0.8.0
**Status**: Phase 5 Complete - Production Ready
