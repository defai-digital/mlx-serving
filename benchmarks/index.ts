#!/usr/bin/env node
/**
 * Benchmark Runner
 *
 * Main entry point for running performance benchmarks.
 * Supports running individual benchmarks or the complete suite.
 */

import { parseArgs } from 'node:util';
import { runIpcBenchmark, formatIpcResults } from './ipc-overhead.js';
import { runTtftBenchmark, formatTtftResults } from './ttft.js';
import { runThroughputBenchmark, formatThroughputResults } from './throughput.js';
import { generateReport } from './report.js';
import { getSystemInfo } from './utils.js';
import type { BenchmarkSuiteResult, BenchmarkConfig, ReportOptions } from './types.js';

/**
 * Available benchmark types
 */
type BenchmarkType = 'ipc' | 'ttft' | 'throughput' | 'all';

/**
 * CLI options
 */
interface CliOptions {
  benchmark: BenchmarkType;
  samples?: number;
  warmup?: number;
  verbose?: boolean;
  format?: 'console' | 'json' | 'csv' | 'markdown';
  output?: string;
}

/**
 * Parse CLI arguments
 */
function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      benchmark: {
        type: 'string',
        short: 'b',
        default: 'all',
      },
      samples: {
        type: 'string',
        short: 's',
      },
      warmup: {
        type: 'string',
        short: 'w',
      },
      verbose: {
        type: 'boolean',
        short: 'v',
        default: false,
      },
      format: {
        type: 'string',
        short: 'f',
        default: 'console',
      },
      output: {
        type: 'string',
        short: 'o',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const benchmark = values.benchmark as BenchmarkType;
  if (!['ipc', 'ttft', 'throughput', 'all'].includes(benchmark)) {
    console.error(`Invalid benchmark type: ${benchmark}`);
    printHelp();
    process.exit(1);
  }

  const format = values.format as 'console' | 'json' | 'csv' | 'markdown';
  if (!['console', 'json', 'csv', 'markdown'].includes(format)) {
    console.error(`Invalid format: ${format}`);
    printHelp();
    process.exit(1);
  }

  return {
    benchmark,
    samples: values.samples ? parseInt(values.samples, 10) : undefined,
    warmup: values.warmup ? parseInt(values.warmup, 10) : undefined,
    verbose: values.verbose,
    format,
    output: values.output,
  };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
kr-mlx-lm Performance Benchmark Runner

USAGE:
  pnpm bench [OPTIONS]

OPTIONS:
  -b, --benchmark <type>    Benchmark to run: ipc, ttft, throughput, all (default: all)
  -s, --samples <number>    Number of samples per test (default: varies by benchmark)
  -w, --warmup <number>     Number of warmup runs (default: 3)
  -v, --verbose             Enable verbose output
  -f, --format <format>     Report format: console, json, csv, markdown (default: console)
  -o, --output <path>       Output file path (required for json/csv/markdown formats)
  -h, --help                Show this help message

EXAMPLES:
  # Run all benchmarks with default settings
  pnpm bench

  # Run IPC benchmark with 100 samples
  pnpm bench -b ipc -s 100

  # Run TTFT benchmark with verbose output
  pnpm bench -b ttft -v

  # Run all benchmarks and export JSON report
  pnpm bench -b all -f json -o benchmarks/results/report.json

  # Run throughput benchmark and export Markdown report
  pnpm bench -b throughput -f markdown -o benchmarks/results/throughput.md
`);
}

/**
 * Run individual benchmark
 */
async function runBenchmark(type: BenchmarkType, config: BenchmarkConfig): Promise<BenchmarkSuiteResult> {
  const suite: BenchmarkSuiteResult = {
    timestamp: new Date().toISOString(),
    environment: getSystemInfo(),
  };

  if (type === 'ipc' || type === 'all') {
    console.log('\n🚀 Running IPC Overhead Benchmark...');
    suite.ipc = await runIpcBenchmark(config);
    if (type === 'ipc') {
      formatIpcResults(suite.ipc);
    }
  }

  if (type === 'ttft' || type === 'all') {
    console.log('\n🚀 Running TTFT Benchmark...');
    suite.ttft = await runTtftBenchmark(config);
    if (type === 'ttft') {
      formatTtftResults(suite.ttft);
    }
  }

  if (type === 'throughput' || type === 'all') {
    console.log('\n🚀 Running Throughput Benchmark...');
    suite.throughput = await runThroughputBenchmark(config);
    if (type === 'throughput') {
      formatThroughputResults(suite.throughput);
    }
  }

  return suite;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseCliArgs();

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║          kr-mlx-lm Performance Benchmark Suite                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const config: BenchmarkConfig = {
    samples: options.samples,
    warmupRuns: options.warmup,
    verbose: options.verbose,
  };

  try {
    const suite = await runBenchmark(options.benchmark, config);

    // Generate report
    const reportOptions: ReportOptions = {
      format: options.format,
      output: options.output,
    };

    if (options.benchmark === 'all') {
      await generateReport(suite, reportOptions);
    } else if (options.format !== 'console' && options.output) {
      // Individual benchmarks can also export to file
      await generateReport(suite, reportOptions);
    }

    console.log('\n✅ Benchmark completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runIpcBenchmark, runTtftBenchmark, runThroughputBenchmark, generateReport };
