#!/usr/bin/env tsx
/**
 * Hardware Detection & Concurrency Recommendations
 *
 * CLI tool to detect Apple Silicon hardware and provide
 * recommended concurrency settings for different model sizes.
 *
 * Usage:
 *   npx tsx scripts/hardware-check.ts
 *   npx tsx scripts/hardware-check.ts --json
 *   npx tsx scripts/hardware-check.ts --model-size 30B
 */

import { detectHardware, recommendConcurrency, printHardwareProfile } from '../src/core/hardware-detector.js';
import { ConcurrencyAutoTuner } from '../src/core/concurrency-auto-tuner.js';

interface CliOptions {
  json: boolean;
  modelSize?: '30B+' | '13-27B' | '7-13B' | '3-7B' | '<3B';
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    json: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--model-size' && i + 1 < args.length) {
      options.modelSize = args[++i] as CliOptions['modelSize'];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
mlx-serving Hardware Detection Tool

Usage:
  npx tsx scripts/hardware-check.ts [options]

Options:
  --json              Output results in JSON format
  --model-size SIZE   Show specific recommendations for model size
                      (30B+, 13-27B, 7-13B, 3-7B, <3B)
  --verbose, -v       Show detailed information
  --help, -h          Show this help message

Examples:
  # Basic hardware detection
  npx tsx scripts/hardware-check.ts

  # Get JSON output for scripting
  npx tsx scripts/hardware-check.ts --json

  # Check recommendations for 30B+ models
  npx tsx scripts/hardware-check.ts --model-size 30B+

  # Verbose output with all details
  npx tsx scripts/hardware-check.ts --verbose
`);
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Detect hardware
  const hardware = detectHardware();
  const recommendations = recommendConcurrency(hardware);

  if (options.json) {
    // JSON output
    const output = {
      hardware,
      recommendations,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Pretty output
  console.log(printHardwareProfile(hardware, recommendations));

  // Model-specific recommendations
  if (options.modelSize) {
    const limits = recommendations[options.modelSize];
    console.log('\n' + '═'.repeat(60));
    console.log(`Specific Recommendations for ${options.modelSize} Models:`);
    console.log('═'.repeat(60));
    console.log(`  Max Concurrent Requests:  ${limits.maxConcurrent}`);
    console.log(`  Queue Depth:              ${limits.queueDepth}`);
    console.log(`  Confidence:               ${recommendations.confidence.toUpperCase()}`);
    console.log('');
  }

  // Performance expectations
  console.log('\n' + '═'.repeat(60));
  console.log('Performance Expectations:');
  console.log('═'.repeat(60));

  const perfTier = getPerformanceTier(hardware);
  console.log(`  Performance Tier:         ${perfTier.name}`);
  console.log(`  Expected Throughput:      ${perfTier.throughputRange}`);
  console.log(`  Recommended Use Case:     ${perfTier.useCase}`);
  console.log('');

  // Warnings and recommendations
  const warnings = getWarnings(hardware);
  if (warnings.length > 0) {
    console.log('⚠️  Warnings:');
    warnings.forEach((warning) => {
      console.log(`   - ${warning}`);
    });
    console.log('');
  }

  const tips = getOptimizationTips(hardware);
  if (tips.length > 0) {
    console.log('💡 Optimization Tips:');
    tips.forEach((tip) => {
      console.log(`   - ${tip}`);
    });
    console.log('');
  }

  // Learned profiles (if any)
  if (options.verbose) {
    const tuner = new ConcurrencyAutoTuner();
    await tuner.initialize();

    const learned = tuner.getLearnedProfiles();
    if (learned.length > 0) {
      console.log('\n' + '═'.repeat(60));
      console.log('Learned Concurrency Profiles:');
      console.log('═'.repeat(60));

      learned.forEach((profile) => {
        const age = Math.round((Date.now() - profile.lastUpdated) / (24 * 60 * 60 * 1000));
        console.log(`\n  Model: ${profile.modelId}`);
        console.log(`  Tier: ${profile.modelTier}`);
        console.log(
          `  Optimal: ${profile.optimalLimits.maxConcurrent} concurrent (queue: ${profile.optimalLimits.queueDepth})`,
        );
        console.log(`  Confidence: ${(profile.confidence * 100).toFixed(1)}%`);
        console.log(
          `  Success Rate: ${((profile.successfulRequests / profile.totalRequests) * 100).toFixed(1)}%`,
        );
        console.log(`  Avg Latency: ${profile.avgLatencyMs.toFixed(0)}ms`);
        console.log(`  Total Requests: ${profile.totalRequests}`);
        console.log(`  Last Updated: ${age} days ago`);
      });
      console.log('');
    }
  }

  // Configuration example
  console.log('═'.repeat(60));
  console.log('Configuration Example (config/runtime.yaml):');
  console.log('═'.repeat(60));
  console.log('model_concurrency:');
  console.log('  enabled: true');
  console.log('  tier_limits:');
  console.log(`    "30B+":       # max: ${recommendations['30B+'].maxConcurrent}, queue: ${recommendations['30B+'].queueDepth}`);
  console.log(`      max_concurrent: ${recommendations['30B+'].maxConcurrent}`);
  console.log(`      queue_depth: ${recommendations['30B+'].queueDepth}`);
  console.log(`    "13-27B":     # max: ${recommendations['13-27B'].maxConcurrent}, queue: ${recommendations['13-27B'].queueDepth}`);
  console.log(`      max_concurrent: ${recommendations['13-27B'].maxConcurrent}`);
  console.log(`      queue_depth: ${recommendations['13-27B'].queueDepth}`);
  console.log(`    "7-13B":      # max: ${recommendations['7-13B'].maxConcurrent}, queue: ${recommendations['7-13B'].queueDepth}`);
  console.log(`      max_concurrent: ${recommendations['7-13B'].maxConcurrent}`);
  console.log(`      queue_depth: ${recommendations['7-13B'].queueDepth}`);
  console.log(`    "3-7B":       # max: ${recommendations['3-7B'].maxConcurrent}, queue: ${recommendations['3-7B'].queueDepth}`);
  console.log(`      max_concurrent: ${recommendations['3-7B'].maxConcurrent}`);
  console.log(`      queue_depth: ${recommendations['3-7B'].queueDepth}`);
  console.log(`    "<3B":        # max: ${recommendations['<3B'].maxConcurrent}, queue: ${recommendations['<3B'].queueDepth}`);
  console.log(`      max_concurrent: ${recommendations['<3B'].maxConcurrent}`);
  console.log(`      queue_depth: ${recommendations['<3B'].queueDepth}`);
  console.log('');
}

interface PerformanceTier {
  name: string;
  throughputRange: string;
  useCase: string;
}

function getPerformanceTier(hardware: typeof import('../src/core/hardware-detector.js').HardwareProfile): PerformanceTier {
  const { variant, chipGeneration, gpuCores, unifiedMemoryGB } = hardware;

  // Ultra tier
  if (variant === 'Ultra' || gpuCores >= 60) {
    return {
      name: 'Ultra High Performance',
      throughputRange: '100-150+ tok/s (30B models)',
      useCase: 'Production serving, high concurrency (10-20+ users)',
    };
  }

  // Max tier
  if (variant === 'Max' || gpuCores >= 30) {
    return {
      name: 'High Performance',
      throughputRange: '80-120 tok/s (30B models)',
      useCase: 'Production serving, medium concurrency (5-10 users)',
    };
  }

  // Pro tier
  if (variant === 'Pro' || gpuCores >= 14) {
    return {
      name: 'Medium Performance',
      throughputRange: '60-90 tok/s (30B models)',
      useCase: 'Development, light production (2-5 users)',
    };
  }

  // Base tier
  return {
    name: 'Standard Performance',
    throughputRange: '40-70 tok/s (30B models)',
    useCase: 'Development, single-user testing',
  };
}

function getWarnings(hardware: typeof import('../src/core/hardware-detector.js').HardwareProfile): string[] {
  const warnings: string[] = [];

  // Memory warnings
  if (hardware.unifiedMemoryGB < 16) {
    warnings.push('Limited unified memory (<16GB) - large models (30B+) may not load');
  } else if (hardware.unifiedMemoryGB < 32) {
    warnings.push('Medium unified memory (16-32GB) - 30B+ models will work but with limited concurrency');
  }

  // GPU core warnings
  if (hardware.gpuCores < 10) {
    warnings.push('Low GPU core count (<10) - consider using smaller models (<7B) for better performance');
  }

  // Older generation warnings
  if (hardware.chipGeneration <= 1) {
    warnings.push('M1 generation chip - newer M3/M4 chips provide 30-50% better performance');
  }

  return warnings;
}

function getOptimizationTips(hardware: typeof import('../src/core/hardware-detector.js').HardwareProfile): string[] {
  const tips: string[] = [];

  // Memory tips
  if (hardware.unifiedMemoryGB >= 64) {
    tips.push('High memory available - consider enabling prompt cache for better performance');
  }

  // GPU tips
  if (hardware.gpuCores >= 30) {
    tips.push('High GPU core count - can handle higher concurrency than default limits');
  }

  // General tips
  tips.push('Close other GPU-intensive apps for best performance');
  tips.push('Monitor with Activity Monitor to check Metal memory usage');
  tips.push('Run `npx tsx scripts/hardware-check.ts --verbose` periodically to see learned optimizations');

  return tips;
}

// Run
main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
