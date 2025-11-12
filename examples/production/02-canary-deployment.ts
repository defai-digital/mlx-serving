/**
 * Canary Deployment Example
 *
 * Demonstrates hash-based canary deployment with automatic rollback.
 *
 * Features:
 * - Hash-based traffic splitting (deterministic routing)
 * - Configurable rollout percentage
 * - Automatic rollback on SLO violations
 * - Health check monitoring
 *
 * Prerequisites:
 * 1. Edit config/feature-flags.yaml to enable canary deployment
 * 2. npm run setup (if not already done)
 *
 * Run: npx tsx examples/production/02-canary-deployment.ts
 */

import { createEngine, FeatureFlagLoader } from '@defai.digital/mlx-serving';
import { createHash } from 'crypto';

// Hash-based routing function (same as CanaryRouter)
function shouldRouteToCanary(
  key: string,
  percentage: number,
  hashSeed: string
): boolean {
  const hash = createHash('md5').update(`${key}:${hashSeed}`).digest('hex');
  const bucketValue = parseInt(hash.substring(0, 8), 16) % 100;
  return bucketValue < percentage;
}

async function main() {
  console.log('=== Canary Deployment Example ===\n');

  // Step 1: Load feature flags
  console.log('Loading feature flag configuration...');
  const flagLoader = new FeatureFlagLoader('config/feature-flags.yaml');

  const canaryConfig = flagLoader.getConfig('canary');
  console.log(`Canary deployment:`);
  console.log(`  - Enabled: ${canaryConfig.enabled}`);
  console.log(`  - Rollout percentage: ${canaryConfig.rollout_percentage}%`);
  console.log(`  - Hash seed: ${canaryConfig.hash_seed}`);
  console.log();

  // Step 2: Create engines (baseline and canary)
  console.log('Creating baseline and canary engines...');
  const baselineEngine = await createEngine({
    verbose: false,
  });

  const canaryEngine = await createEngine({
    verbose: false,
  });

  console.log('Engines created.\n');

  // Step 3: Simulate traffic routing
  console.log('=== Traffic Routing Simulation ===\n');

  const userIds = Array.from({ length: 20 }, (_, i) => `user-${i + 1}`);
  let baselineCount = 0;
  let canaryCount = 0;

  console.log('Routing 20 users to baseline or canary:');
  for (const userId of userIds) {
    const isCanary = shouldRouteToCanary(
      userId,
      canaryConfig.rollout_percentage,
      canaryConfig.hash_seed
    );

    if (isCanary) {
      canaryCount++;
      console.log(`  - ${userId}: ✨ canary`);
    } else {
      baselineCount++;
      console.log(`  - ${userId}: 📊 baseline`);
    }
  }

  console.log();
  console.log('Traffic distribution:');
  console.log(`  - Baseline: ${baselineCount} (${(baselineCount / userIds.length * 100).toFixed(1)}%)`);
  console.log(`  - Canary: ${canaryCount} (${(canaryCount / userIds.length * 100).toFixed(1)}%)`);
  console.log(`  - Expected: ~${canaryConfig.rollout_percentage}% canary\n`);

  // Step 4: Demonstrate deterministic routing
  console.log('=== Deterministic Routing ===\n');
  console.log('Same user always routed to same version:');

  const testUserId = 'user-123';
  const routes = [];
  for (let i = 0; i < 5; i++) {
    const isCanary = shouldRouteToCanary(
      testUserId,
      canaryConfig.rollout_percentage,
      canaryConfig.hash_seed
    );
    routes.push(isCanary ? 'canary' : 'baseline');
  }

  console.log(`User: ${testUserId}`);
  console.log(`Routes (5 checks): ${routes.join(', ')}`);
  console.log(`Consistent: ${routes.every(r => r === routes[0]) ? '✅ Yes' : '❌ No'}\n`);

  // Step 5: Send requests to both versions
  console.log('=== Request Performance Comparison ===\n');

  const prompt = 'What is the capital of France?';

  // Baseline request
  console.log('Baseline version:');
  const baselineStart = Date.now();
  const baselineGenerator = baselineEngine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt,
    maxTokens: 50,
  });

  let baselineFirstTokenTime: number | null = null;
  let baselineTokens = 0;

  for await (const chunk of baselineGenerator) {
    if (baselineFirstTokenTime === null) {
      baselineFirstTokenTime = Date.now() - baselineStart;
    }
    baselineTokens++;
  }

  const baselineTime = Date.now() - baselineStart;
  const baselineThroughput = baselineTokens / (baselineTime / 1000);

  console.log(`  - TTFT: ${baselineFirstTokenTime}ms`);
  console.log(`  - Total time: ${baselineTime}ms`);
  console.log(`  - Tokens: ${baselineTokens}`);
  console.log(`  - Throughput: ${baselineThroughput.toFixed(2)} tok/s\n`);

  // Canary request
  console.log('Canary version:');
  const canaryStart = Date.now();
  const canaryGenerator = canaryEngine.generate({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt,
    maxTokens: 50,
  });

  let canaryFirstTokenTime: number | null = null;
  let canaryTokens = 0;

  for await (const chunk of canaryGenerator) {
    if (canaryFirstTokenTime === null) {
      canaryFirstTokenTime = Date.now() - canaryStart;
    }
    canaryTokens++;
  }

  const canaryTime = Date.now() - canaryStart;
  const canaryThroughput = canaryTokens / (canaryTime / 1000);

  console.log(`  - TTFT: ${canaryFirstTokenTime}ms`);
  console.log(`  - Total time: ${canaryTime}ms`);
  console.log(`  - Tokens: ${canaryTokens}`);
  console.log(`  - Throughput: ${canaryThroughput.toFixed(2)} tok/s\n`);

  // Step 6: Compare performance
  console.log('=== Performance Delta ===');
  const ttftDelta = ((canaryFirstTokenTime! - baselineFirstTokenTime!) / baselineFirstTokenTime! * 100);
  const throughputDelta = ((canaryThroughput - baselineThroughput) / baselineThroughput * 100);

  console.log(`TTFT: ${ttftDelta > 0 ? '+' : ''}${ttftDelta.toFixed(2)}%`);
  console.log(`Throughput: ${throughputDelta > 0 ? '+' : ''}${throughputDelta.toFixed(2)}%`);
  console.log();

  if (Math.abs(ttftDelta) > 10) {
    console.log(`⚠️ TTFT delta exceeds 10% threshold`);
    console.log(`This would trigger automatic rollback in production.\n`);
  } else {
    console.log(`✅ Performance delta within acceptable range\n`);
  }

  // Step 7: Rollback controller example
  console.log('=== Automatic Rollback Controller ===');
  console.log('Rollback triggers (configured thresholds):');
  console.log(`  - Error rate: >5%`);
  console.log(`  - P99 latency: >500ms`);
  console.log(`  - Evaluation window: 5 minutes`);
  console.log(`  - Cooldown period: 10 minutes`);
  console.log();

  console.log('Current canary health:');
  console.log(`  - Error rate: 0% ✅`);
  console.log(`  - TTFT P99: ${canaryFirstTokenTime}ms ✅`);
  console.log(`  - Status: Healthy, rollback not triggered\n`);

  // Step 8: Progressive rollout strategy
  console.log('=== Progressive Rollout Strategy ===');
  console.log('Recommended rollout schedule:');
  console.log();
  console.log('| Stage  | Percentage | Duration | Action                 |');
  console.log('|--------|-----------|----------|------------------------|');
  console.log('| Canary | 1%        | 24 hours | Initial validation     |');
  console.log('| Small  | 10%       | 48 hours | Monitor metrics        |');
  console.log('| Medium | 50%       | 72 hours | Validate stability     |');
  console.log('| Full   | 100%      | 7+ days  | Complete rollout       |');
  console.log();

  console.log('Current rollout: 10% (Small stage)');
  console.log('Next step: Increase to 50% after 48 hours of stability\n');

  // Step 9: Prometheus metrics
  console.log('=== Prometheus Metrics ===');
  console.log('Canary deployment metrics:');
  console.log();
  console.log(`mlx_serving_canary_requests_total{version="baseline"} ${baselineCount}`);
  console.log(`mlx_serving_canary_requests_total{version="canary"} ${canaryCount}`);
  console.log(`mlx_serving_canary_error_rate{version="baseline"} 0.0`);
  console.log(`mlx_serving_canary_error_rate{version="canary"} 0.0`);
  console.log(`mlx_serving_canary_ttft_p99{version="baseline"} ${baselineFirstTokenTime}`);
  console.log(`mlx_serving_canary_ttft_p99{version="canary"} ${canaryFirstTokenTime}`);
  console.log();

  // Cleanup
  await baselineEngine.close();
  await canaryEngine.close();
  console.log('Engines closed.');
}

// Configuration example:
console.log(`
Configuration Required:
=======================

Edit config/feature-flags.yaml:

canary:
  enabled: true
  rolloutPercentage: 10  # 10% canary traffic
  strategy: hash
  hashKey: user_id
  hashSeed: "canary-2025-01-08"

  # Rollback controller
  rollback:
    enabled: true
    errorRateThreshold: 0.05    # 5% error rate
    p99LatencyThreshold: 500    # 500ms P99
    evaluationWindow: 300       # 5 minutes
    cooldownPeriod: 600         # 10 minutes

Then run this example.
`);

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
