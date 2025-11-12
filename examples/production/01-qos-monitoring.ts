/**
 * QoS Monitoring Example
 *
 * Demonstrates QoS monitoring with SLO evaluation and automated remediation.
 *
 * Features:
 * - Real-time SLO monitoring (TTFT P99, throughput)
 * - Policy-based remediation (scale up/down, reject requests)
 * - TDigest percentile tracking
 * - Prometheus metrics export
 *
 * Prerequisites:
 * 1. Edit config/runtime.yaml to enable qos_monitor
 * 2. Edit config/feature-flags.yaml to enable qos_monitor
 * 3. npm run setup (if not already done)
 *
 * Run: npx tsx examples/production/01-qos-monitoring.ts
 */

import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  console.log('=== QoS Monitoring Example ===\n');

  // Step 1: Create engine with QoS monitoring enabled
  console.log('Creating engine with QoS monitoring...');
  const engine = await createEngine({
    verbose: false,
  });

  console.log('Engine created.\n');

  // Step 2: Check QoS configuration
  console.log('Checking QoS configuration...');
  const qosConfig = engine.getQosConfig();
  console.log(`  - QoS enabled: ${qosConfig.enabled}`);
  console.log(`  - Evaluator enabled: ${qosConfig.evaluator.enabled}`);
  console.log(`  - Executor enabled: ${qosConfig.executor.enabled}`);
  console.log(`  - Dry-run mode: ${qosConfig.executor.dryRun}`);
  console.log(`  - Policy store enabled: ${qosConfig.policyStore.enabled}\n`);

  // Step 3: Get initial QoS statistics
  console.log('Initial QoS statistics:');
  let stats = engine.getQosStats();
  console.log(`  - Total requests: ${stats.totalRequests}`);
  console.log(`  - SLO violations: ${stats.violations}`);
  console.log(`  - Remediation actions: ${stats.remediations}`);
  console.log(`  - TTFT P50: ${stats.ttftP50}ms`);
  console.log(`  - TTFT P95: ${stats.ttftP95}ms`);
  console.log(`  - TTFT P99: ${stats.ttftP99}ms\n`);

  // Step 4: Send requests and monitor SLO compliance
  console.log('=== Sending Requests (SLO Monitoring) ===\n');

  const prompts = [
    'What is the capital of France?',
    'What is 2 + 2?',
    'What is the meaning of life?',
    'What is the speed of light?',
    'What is the largest planet?',
  ];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    console.log(`Request ${i + 1}/${prompts.length}: "${prompt}"`);
    const startTime = Date.now();

    const generator = engine.generate({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      prompt,
      maxTokens: 50,
    });

    let firstTokenTime: number | null = null;
    let tokens = 0;

    for await (const chunk of generator) {
      if (firstTokenTime === null) {
        firstTokenTime = Date.now() - startTime;
      }
      tokens++;
    }

    const totalTime = Date.now() - startTime;
    const throughput = tokens / (totalTime / 1000);

    console.log(`  - TTFT: ${firstTokenTime}ms`);
    console.log(`  - Tokens: ${tokens}`);
    console.log(`  - Throughput: ${throughput.toFixed(2)} tok/s`);

    // Check if SLO was violated
    const currentStats = engine.getQosStats();
    if (currentStats.violations > stats.violations) {
      console.log(`  ⚠️ SLO VIOLATION DETECTED`);
      console.log(`  - Total violations: ${currentStats.violations}`);
      console.log(`  - Remediation actions: ${currentStats.remediations}`);
    } else {
      console.log(`  ✅ SLO compliant`);
    }
    console.log();

    stats = currentStats;
  }

  // Step 5: Get final QoS statistics
  console.log('=== Final QoS Statistics ===');
  stats = engine.getQosStats();
  console.log(`  - Total requests: ${stats.totalRequests}`);
  console.log(`  - SLO violations: ${stats.violations}`);
  console.log(`  - Violation rate: ${(stats.violationRate * 100).toFixed(2)}%`);
  console.log(`  - Remediation actions: ${stats.remediations}`);
  console.log();

  console.log('TTFT Percentiles:');
  console.log(`  - P50: ${stats.ttftP50}ms`);
  console.log(`  - P95: ${stats.ttftP95}ms`);
  console.log(`  - P99: ${stats.ttftP99}ms`);
  console.log();

  console.log('Throughput:');
  console.log(`  - Avg: ${stats.avgThroughput.toFixed(2)} tok/s`);
  console.log(`  - Min: ${stats.minThroughput.toFixed(2)} tok/s`);
  console.log(`  - Max: ${stats.maxThroughput.toFixed(2)} tok/s\n`);

  // Step 6: Demonstrate policy evaluation
  console.log('=== QoS Policies ===');
  const policies = engine.getQosPolicies();
  console.log(`Active policies: ${policies.length}`);

  for (const policy of policies) {
    console.log(`\nPolicy: ${policy.name}`);
    console.log(`  - Type: ${policy.type}`);
    console.log(`  - Metric: ${policy.metric}`);
    console.log(`  - Threshold: ${policy.threshold}`);
    console.log(`  - Window: ${policy.windowMs}ms`);
    console.log(`  - Action: ${policy.action}`);
    console.log(`  - Enabled: ${policy.enabled}`);
  }
  console.log();

  // Step 7: Simulate SLO violation (if dry-run mode)
  if (qosConfig.executor.dryRun) {
    console.log('=== Dry-Run Mode Demo ===');
    console.log('QoS executor is in dry-run mode.');
    console.log('Remediation actions will be logged but not executed.');
    console.log();
    console.log('Example remediation actions that would be taken:');
    console.log('  - Scale down batch size (high TTFT)');
    console.log('  - Reject requests (overload)');
    console.log('  - Scale up batch size (low throughput)');
    console.log();
    console.log('To enable real remediation, set in config/runtime.yaml:');
    console.log('  qos_monitor.executor.dry_run: false\n');
  }

  // Step 8: Prometheus metrics example
  console.log('=== Prometheus Metrics ===');
  console.log('QoS metrics exported to Prometheus:');
  console.log();
  console.log('# SLO violations counter');
  console.log(`mlx_serving_qos_slo_violations_total{policy="ttft_p99"} ${stats.violations}`);
  console.log();
  console.log('# Remediation actions counter');
  console.log(`mlx_serving_qos_remediation_actions_total{action="scale_down"} ${stats.remediations}`);
  console.log();
  console.log('# TTFT percentiles');
  console.log(`mlx_serving_qos_ttft_p50_ms ${stats.ttftP50}`);
  console.log(`mlx_serving_qos_ttft_p95_ms ${stats.ttftP95}`);
  console.log(`mlx_serving_qos_ttft_p99_ms ${stats.ttftP99}`);
  console.log();
  console.log('# Throughput');
  console.log(`mlx_serving_qos_throughput_avg ${stats.avgThroughput}`);
  console.log();

  // Cleanup
  await engine.close();
  console.log('Engine closed.');
}

// Configuration example:
console.log(`
Configuration Required:
=======================

1. Edit config/runtime.yaml:

qos_monitor:
  enabled: true
  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false  # Set to false for real remediation
  policy_store:
    enabled: true

2. Edit config/feature-flags.yaml:

qos_monitor:
  enabled: true
  rollout_percentage: 100
  hash_seed: "qos-monitor-2025-01-08"

  evaluator:
    enabled: true
  executor:
    enabled: true
    dry_run: false
  policy_store:
    enabled: true

Then run this example.
`);

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
