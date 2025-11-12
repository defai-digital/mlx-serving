/**
 * Feature Flags Example
 *
 * Demonstrates percentage-based gradual rollout with hash-based deterministic routing.
 *
 * Features:
 * - Hash-based deterministic routing (same key → same result)
 * - Percentage-based rollout (0-100%)
 * - Independent sub-feature control
 * - Zero-downtime configuration reload
 * - Emergency kill switch
 *
 * Prerequisites:
 * 1. Edit config/feature-flags.yaml to configure feature flags
 * 2. npm run setup (if not already done)
 *
 * Run: npx tsx examples/production/03-feature-flags.ts
 */

import { FeatureFlagLoader } from '@knowrag/mlx-serving';

async function main() {
  console.log('=== Feature Flags Example ===\n');

  // Step 1: Load feature flag configuration
  console.log('Loading feature flag configuration...');
  const loader = new FeatureFlagLoader('config/feature-flags.yaml');

  console.log('Feature flags loaded.\n');

  // Step 2: Check available features
  console.log('=== Available Features ===\n');

  const features = ['phase4_rollout', 'ttft_pipeline', 'qos_monitor', 'adaptive_governor', 'http2_transport'];

  for (const feature of features) {
    const config = loader.getConfig(feature);
    console.log(`${feature}:`);
    console.log(`  - Enabled: ${config.enabled}`);
    console.log(`  - Rollout: ${config.rollout_percentage}%`);
    console.log(`  - Hash seed: ${config.hash_seed}`);
    console.log();
  }

  // Step 3: Test routing for specific keys
  console.log('=== Routing Test (10% Rollout) ===\n');

  const testKeys = Array.from({ length: 20 }, (_, i) => `user-${i + 1}`);
  let enabledCount = 0;

  console.log('Testing TTFT pipeline routing for 20 users:');
  for (const key of testKeys) {
    const enabled = loader.isEnabled('ttft_pipeline', key);
    if (enabled) {
      enabledCount++;
      console.log(`  - ${key}: ✨ enabled`);
    } else {
      console.log(`  - ${key}: ⏸️  disabled`);
    }
  }

  const actualPercentage = (enabledCount / testKeys.length) * 100;
  console.log();
  console.log('Routing distribution:');
  console.log(`  - Enabled: ${enabledCount} (${actualPercentage.toFixed(1)}%)`);
  console.log(`  - Disabled: ${testKeys.length - enabledCount} (${(100 - actualPercentage).toFixed(1)}%)`);
  console.log(`  - Expected: ~10% enabled\n`);

  // Step 4: Demonstrate deterministic routing
  console.log('=== Deterministic Routing ===\n');

  const stickyUser = 'user-sticky-123';
  console.log(`Testing deterministic routing for: ${stickyUser}`);
  console.log('Checking routing decision 5 times:');

  const decisions = [];
  for (let i = 0; i < 5; i++) {
    const enabled = loader.isEnabled('ttft_pipeline', stickyUser);
    decisions.push(enabled);
    console.log(`  Attempt ${i + 1}: ${enabled ? 'enabled' : 'disabled'}`);
  }

  const isConsistent = decisions.every(d => d === decisions[0]);
  console.log();
  console.log(`Consistency: ${isConsistent ? '✅ Deterministic (same result every time)' : '❌ Non-deterministic'}\n`);

  // Step 5: Test sub-features
  console.log('=== Sub-Features ===\n');

  console.log('TTFT Pipeline sub-features:');
  const ttftConfig = loader.getConfig('ttft_pipeline');

  if (ttftConfig.warmup_queue) {
    console.log(`  - Warmup Queue: ${ttftConfig.warmup_queue.enabled ? '✅ enabled' : '⏸️  disabled'}`);
  }
  if (ttftConfig.speculation) {
    console.log(`  - Speculation: ${ttftConfig.speculation.enabled ? '✅ enabled' : '⏸️  disabled'}`);
    console.log(`    Allowlist only: ${ttftConfig.speculation.allowlist_only}`);
  }
  if (ttftConfig.kv_prep) {
    console.log(`  - KV Prep: ${ttftConfig.kv_prep.enabled ? '✅ enabled' : '⏸️  disabled'}`);
  }
  console.log();

  // Step 6: Test different rollout percentages
  console.log('=== Rollout Percentage Impact ===\n');

  const percentages = [1, 10, 50, 100];
  const testUser = 'user-test-rollout';

  console.log(`Testing user: ${testUser}`);
  console.log('Hash-based routing results for different rollout percentages:');

  for (const percentage of percentages) {
    // Simulate different rollout percentages
    // In real usage, you would update config and reload
    console.log(`  - ${percentage}% rollout: Would need config update + reload`);
  }
  console.log();

  console.log('Note: To change rollout percentage:');
  console.log('  1. Edit config/feature-flags.yaml');
  console.log('  2. Send SIGHUP signal to reload config (zero-downtime)');
  console.log('  3. Or restart the service\n');

  // Step 7: Emergency controls
  console.log('=== Emergency Controls ===\n');

  const emergencyConfig = loader.getEmergencyConfig();
  console.log('Kill switch status:');
  console.log(`  - Kill switch: ${emergencyConfig.kill_switch ? '🔴 ACTIVE (all features disabled)' : '✅ inactive'}`);
  console.log(`  - Rollback to baseline: ${emergencyConfig.rollback_to_baseline ? '🔴 ACTIVE' : '⏸️  inactive'}`);
  console.log();

  if (!emergencyConfig.kill_switch) {
    console.log('To activate kill switch (emergency disable all):');
    console.log('  Edit config/feature-flags.yaml:');
    console.log('    emergency:');
    console.log('      kill_switch: true');
    console.log('      rollback_to_baseline: true');
    console.log();
  }

  // Step 8: Statistics
  console.log('=== Feature Flag Statistics ===\n');

  const stats = loader.getStats();
  console.log('Overall statistics:');
  console.log(`  - Total decisions: ${stats.totalDecisions}`);
  console.log(`  - Enabled count: ${stats.enabledCount}`);
  console.log(`  - Disabled count: ${stats.disabledCount}`);
  console.log(`  - Actual percentage: ${stats.actualPercentage.toFixed(2)}%\n`);

  // Step 9: Progressive rollout example
  console.log('=== Progressive Rollout Example ===\n');

  console.log('Recommended rollout schedule for new feature:');
  console.log();
  console.log('Week 1: 1% canary');
  console.log('  rollout_percentage: 1');
  console.log('  → Monitor for 24 hours');
  console.log();
  console.log('Week 2: 10% small rollout');
  console.log('  rollout_percentage: 10');
  console.log('  → Monitor for 48 hours');
  console.log();
  console.log('Week 3: 50% medium rollout');
  console.log('  rollout_percentage: 50');
  console.log('  → Monitor for 72 hours');
  console.log();
  console.log('Week 4: 100% full rollout');
  console.log('  rollout_percentage: 100');
  console.log('  → Complete rollout\n');

  // Step 10: Zero-downtime configuration reload
  console.log('=== Zero-Downtime Configuration Reload ===\n');

  console.log('To reload configuration without downtime:');
  console.log();
  console.log('1. Edit config/feature-flags.yaml');
  console.log('2. Send SIGHUP signal:');
  console.log('   kill -HUP $(cat /var/run/mlx-serving.pid)');
  console.log();
  console.log('Or programmatically:');
  console.log('   await loader.reload();');
  console.log();

  // Step 11: Prometheus metrics
  console.log('=== Prometheus Metrics ===\n');

  console.log('Feature flag decision metrics:');
  console.log(`mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="true"} ${stats.enabledCount}`);
  console.log(`mlx_serving_feature_flags_decisions_total{feature="ttft_pipeline",enabled="false"} ${stats.disabledCount}`);
  console.log();
  console.log('Rollout percentage gauge:');
  console.log(`mlx_serving_feature_flags_rollout_percentage{feature="ttft_pipeline"} 10`);
  console.log();
  console.log('Kill switch status:');
  console.log(`mlx_serving_feature_flags_kill_switch{value="${emergencyConfig.kill_switch}"} ${emergencyConfig.kill_switch ? '1' : '0'}`);
  console.log();

  // Step 12: Best practices
  console.log('=== Best Practices ===\n');

  console.log('1. Use unique hash seeds per feature');
  console.log('   → Prevents correlation between features');
  console.log();
  console.log('2. Start with low percentage (1-5%)');
  console.log('   → Limits blast radius');
  console.log();
  console.log('3. Monitor before increasing rollout');
  console.log('   → Wait 24-48 hours between stages');
  console.log();
  console.log('4. Enable kill switch');
  console.log('   → Quick recovery on incidents');
  console.log();
  console.log('5. Control sub-features independently');
  console.log('   → Fine-grained control, isolate issues');
  console.log();

  console.log('Example complete.');
}

// Configuration example:
console.log(`
Configuration Required:
=======================

Edit config/feature-flags.yaml:

# Global Phase 4/5 rollout
phase4_rollout:
  enabled: true
  rollout_percentage: 100
  hash_seed: "phase4-rollout-2025-01-08"

# TTFT Pipeline
ttft_pipeline:
  enabled: true
  rollout_percentage: 10  # 10% rollout
  hash_seed: "ttft-pipeline-2025-01-08"

  warmup_queue:
    enabled: true
  speculation:
    enabled: false
    allowlist_only: true
  kv_prep:
    enabled: false

# QoS Monitor
qos_monitor:
  enabled: true
  rollout_percentage: 100
  hash_seed: "qos-monitor-2025-01-08"

# Emergency controls
emergency:
  kill_switch: false
  rollback_to_baseline: false

# Observability
observability:
  log_feature_decisions: true
  export_metrics: true

Then run this example.
`);

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
