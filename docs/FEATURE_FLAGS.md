# Feature Flags Reference

**mlx-serving Phase 5: Gradual Rollout Control**

---

## Quick Reference

Feature flags enable percentage-based gradual rollout with hash-based deterministic routing.

**Configuration File**: [`config/feature-flags.yaml`](../config/feature-flags.yaml)

For complete documentation, see **[PRODUCTION_FEATURES.md - Feature Flags](./PRODUCTION_FEATURES.md#feature-flags)**.

---

## Available Feature Flags

| Feature | Status | Default | Description |
|---------|--------|---------|-------------|
| `phase4_rollout` | ✅ Stable | 100% | Global Phase 4/5 features |
| `ttft_pipeline` | ✅ Stable | 100% | TTFT acceleration (warm queue, speculation) |
| `qos_monitor` | ✅ Stable | 100% | QoS monitoring & remediation |
| `adaptive_governor` | ⚠️ Experimental | 0% | PID-based admission control |
| `http2_transport` | ⚠️ Experimental | 0% | HTTP/2 multiplexed transport |

---

## Quick Start

### Enable a Feature

Edit `config/feature-flags.yaml`:

```yaml
# Enable TTFT pipeline at 10% rollout
ttft_pipeline:
  enabled: true
  rollout_percentage: 10                     # 10% of traffic
  hash_seed: "ttft-pipeline-2025-01-08"     # Deterministic routing seed
```

### Reload Configuration

```bash
# Zero-downtime configuration reload (SIGHUP)
kill -HUP $(cat /var/run/mlx-serving.pid)
```

### Verify Feature Status

```typescript
import { FeatureFlagLoader } from '@knowrag/mlx-serving';

const loader = new FeatureFlagLoader('config/feature-flags.yaml');

// Check if feature enabled for specific request
const enabled = loader.isEnabled('ttft_pipeline', 'request-123');
console.log(`TTFT pipeline for request-123: ${enabled}`);
```

---

## Configuration Structure

```yaml
# Feature flag structure
feature_name:
  enabled: boolean                  # Master switch
  rollout_percentage: number        # 0-100 (percentage of traffic)
  hash_seed: string                 # Seed for deterministic hash routing

  # Optional sub-features (independent control)
  sub_feature:
    enabled: boolean

# Emergency controls
emergency:
  kill_switch: boolean              # Emergency disable ALL features
  rollback_to_baseline: boolean     # Rollback to pre-Phase 4 state

# Observability
observability:
  log_feature_decisions: boolean    # Log routing decisions
  export_metrics: boolean           # Export Prometheus metrics
```

---

## Hash-Based Routing

Feature flags use MD5 hash for **deterministic routing**:

```typescript
// Pseudo-code for hash-based routing
function shouldEnableFeature(
  key: string,           // Request ID, user ID, session ID, etc.
  percentage: number,    // Rollout percentage (0-100)
  hashSeed: string       // Unique seed per feature
): boolean {
  const hash = md5(`${key}:${hashSeed}`);
  const bucketValue = parseInt(hash.substring(0, 8), 16) % 100;
  return bucketValue < percentage;
}
```

**Benefits:**
- **Deterministic** - Same key always gets same result
- **Sticky** - Users don't flip between enabled/disabled
- **Reproducible** - Same hash seed = same distribution

**Example:**
```typescript
// Request 'user-123' with 10% rollout
shouldEnableFeature('user-123', 10, 'ttft-2025') // => true/false (consistent)
```

---

## Rollout Strategy

### Recommended Rollout Schedule

| Stage | Percentage | Duration | Action |
|-------|-----------|----------|--------|
| **Canary** | 1% | 24 hours | Initial validation |
| **Small** | 10% | 48 hours | Monitor metrics |
| **Medium** | 50% | 72 hours | Validate stability |
| **Full** | 100% | 7+ days | Complete rollout |

### Progressive Rollout Example

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

## Feature Flag Details

### Global Phase 4/5 Rollout

```yaml
phase4_rollout:
  enabled: true
  percentage: 100
  hash_seed: "phase4-rollout-2025-01-08"
```

**Controls:** All Phase 4/5 features globally

**Use Case:** Emergency disable all new features

---

### TTFT Pipeline

```yaml
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
```

**Features:**
- Tokenizer warm queue (20-30ms TTFT improvement)
- First-token speculation (50-100ms for repeated prompts)
- KV cache prefetch (experimental)

**Documentation:** [PRODUCTION_FEATURES.md - TTFT Pipeline](./PRODUCTION_FEATURES.md#ttft-acceleration-pipeline)

---

### QoS Monitor

```yaml
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
```

**Features:**
- Real-time SLO monitoring
- Policy-based auto-remediation
- TDigest percentile tracking (P50, P95, P99)

**Documentation:** [PRODUCTION_FEATURES.md - QoS Monitoring](./PRODUCTION_FEATURES.md#qos-monitoring)

---

### Adaptive Governor (Experimental)

```yaml
adaptive_governor:
  enabled: false
  rollout_percentage: 0
  hash_seed: "adaptive-governor-2025-01-08"
```

**Status:** ⚠️ Experimental

**Features:**
- PID-based admission control
- Replaces heuristic with PID controller

**Warning:** May cause Metal GPU crashes with high concurrency

---

### HTTP/2 Transport (Experimental)

```yaml
http2_transport:
  enabled: false
  rollout_percentage: 0
  hash_seed: "http2-transport-2025-01-08"
```

**Status:** ⚠️ Experimental

**Features:**
- HTTP/2 multiplexed transport
- Lower connection overhead vs HTTP/1.1

**Target:** 15-20% TTFT improvement, 20% CPU reduction

---

## Emergency Controls

### Kill Switch (Emergency Disable All)

```yaml
emergency:
  kill_switch: true                 # Disable ALL Phase 4/5 features
  rollback_to_baseline: true        # Rollback to pre-Phase 4 behavior
```

**Use Case:** Emergency rollback on critical incident

**Effect:** Immediately disables all feature-flagged functionality

---

### Disable Single Feature

```yaml
# Disable just TTFT pipeline
ttft_pipeline:
  enabled: false                   # Master switch off
  rollout_percentage: 0            # 0% traffic
```

**Use Case:** Isolated feature issue

---

## Monitoring

### Prometheus Metrics

```yaml
# Feature flag routing decisions
mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="true"} 1234
mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="false"} 8766

# Rollout percentage (gauge)
mlx_serving_feature_flags_rollout_percentage{feature="ttft_pipeline"} 10

# Kill switch status
mlx_serving_feature_flags_kill_switch{value="false"} 0
```

### Logging

Enable decision logging in `config/feature-flags.yaml`:

```yaml
observability:
  log_feature_decisions: true
  export_metrics: true
  metric_prefix: "mlx_serving_feature_flags"
```

**Log output:**
```
[INFO] Feature flag decision: ttft_pipeline for request-123 => enabled
[INFO] Feature flag decision: ttft_pipeline for request-456 => disabled
```

---

## Best Practices

### 1. Use Unique Hash Seeds

Each feature should have its own seed:

```yaml
ttft_pipeline:
  hash_seed: "ttft-pipeline-2025-01-08"      # Unique seed

qos_monitor:
  hash_seed: "qos-monitor-2025-01-08"        # Different seed
```

**Why:** Prevents correlation between features (independent rollout)

---

### 2. Start at Low Percentage

Initial rollout should be 1-5%:

```yaml
new_feature:
  enabled: true
  rollout_percentage: 1    # Start at 1%
```

**Why:** Limits blast radius, easier to detect issues

---

### 3. Monitor Before Increasing

Wait 24-48 hours between rollout stages:

```
Day 0:  1% rollout  → Monitor 24h
Day 1:  10% rollout → Monitor 48h
Day 3:  50% rollout → Monitor 72h
Day 6:  100% full rollout
```

**Why:** Time to detect latent issues, validate metrics

---

### 4. Enable Kill Switch

Always have emergency disable ready:

```yaml
emergency:
  kill_switch: false               # Ready but not active
  rollback_to_baseline: false
```

**Why:** Quick recovery path on incidents

---

### 5. Independent Sub-Features

Control sub-features separately:

```yaml
ttft_pipeline:
  enabled: true
  rollout_percentage: 100         # Full rollout

  warmup_queue:
    enabled: true                 # Enable warmup (stable)
  speculation:
    enabled: false                # Disable speculation (testing separately)
```

**Why:** Fine-grained control, isolate issues

---

## Validation

### Validate Configuration

```bash
# Validate feature flags before reload
npx tsx scripts/validate-feature-flags.ts config/feature-flags.yaml

# Example output:
# ✓ Configuration valid
# ✓ All rollout percentages in range [0, 100]
# ✓ All hash seeds present
# ✓ No circular dependencies
```

### Test Feature Routing

```typescript
import { FeatureFlagLoader } from '@knowrag/mlx-serving';

const loader = new FeatureFlagLoader('config/feature-flags.yaml');

// Test routing for different keys
const keys = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5'];

for (const key of keys) {
  const enabled = loader.isEnabled('ttft_pipeline', key);
  console.log(`${key}: ${enabled ? 'canary' : 'baseline'}`);
}

// Example output (10% rollout):
// user-1: baseline
// user-2: canary
// user-3: baseline
// user-4: baseline
// user-5: baseline
```

---

## Troubleshooting

### Feature Not Enabling

**Issue:** Feature always disabled despite configuration

**Diagnosis:**
```typescript
const config = loader.getConfig('ttft_pipeline');
console.log({
  enabled: config.enabled,
  percentage: config.rollout_percentage,
  hashSeed: config.hash_seed,
});
```

**Common Causes:**
- `enabled: false` in config
- `rollout_percentage: 0`
- Missing hash seed
- Kill switch enabled

**Solution:**
```yaml
ttft_pipeline:
  enabled: true                    # Must be true
  rollout_percentage: 10           # Must be > 0
  hash_seed: "valid-seed"          # Must be present
```

---

### Inconsistent Routing

**Issue:** Same key getting different results

**Diagnosis:**
```typescript
// Test consistency
const key = 'user-123';
const results = [];

for (let i = 0; i < 10; i++) {
  results.push(loader.isEnabled('ttft_pipeline', key));
}

console.log(`Consistency: ${results.every(r => r === results[0])}`);
```

**Common Causes:**
- Hash seed changed between calls
- Using `random` strategy instead of `hash`

**Solution:**
```yaml
ttft_pipeline:
  strategy: hash                   # Use hash, not random
  hash_seed: "ttft-2025"           # Don't change seed
```

---

### Kill Switch Not Working

**Issue:** Features still enabled with kill switch on

**Diagnosis:**
```typescript
const killSwitch = loader.getKillSwitch();
console.log(`Kill switch: ${killSwitch}`);
```

**Solution:**
```yaml
emergency:
  kill_switch: true                # Must be exactly 'true'
  rollback_to_baseline: true       # Enable rollback
```

---

## API Reference

### FeatureFlagLoader

```typescript
import { FeatureFlagLoader } from '@knowrag/mlx-serving';

// Load configuration
const loader = new FeatureFlagLoader('config/feature-flags.yaml');

// Check if feature enabled for key
const enabled = loader.isEnabled(
  'ttft_pipeline',    // Feature name
  'request-123'       // Routing key (request ID, user ID, etc.)
);

// Get feature configuration
const config = loader.getConfig('ttft_pipeline');
console.log({
  enabled: config.enabled,
  percentage: config.rollout_percentage,
  hashSeed: config.hash_seed,
});

// Get all feature flags
const allFlags = loader.getAllFlags();

// Get statistics
const stats = loader.getStats();
console.log({
  totalDecisions: stats.totalDecisions,
  enabledCount: stats.enabledCount,
  actualPercentage: stats.actualPercentage,
});

// Reload configuration (zero-downtime)
await loader.reload();

// Subscribe to decision events
loader.on('decision', (feature, key, enabled) => {
  console.log(`Feature ${feature} for ${key}: ${enabled}`);
});
```

---

## Additional Resources

- **[PRODUCTION_FEATURES.md](./PRODUCTION_FEATURES.md)** - Complete production features guide
- **[PERFORMANCE.md](./PERFORMANCE.md)** - Week 7 performance optimizations
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment and operations guide
- **[INDEX.md](./INDEX.md)** - Documentation hub

**Configuration Files:**
- [`config/feature-flags.yaml`](../config/feature-flags.yaml) - Feature flag configuration
- [`config/runtime.yaml`](../config/runtime.yaml) - Runtime configuration

**Source Code:**
- Feature Flag Loader: [`src/config/feature-flag-loader.ts`](../src/config/feature-flag-loader.ts)
- Canary Router: [`src/canary/canary-router.ts`](../src/canary/canary-router.ts)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-10
**Status:** Phase 5 Complete - Production Ready
