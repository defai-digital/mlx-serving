/**
 * Benchmark Report Generator
 *
 * Generates comprehensive reports from benchmark results in multiple formats.
 * Supports console, JSON, CSV, and Markdown output.
 */

import { writeFile } from 'fs/promises';
import { formatNumber, formatBytes, formatDuration, formatStatsRow } from './utils.js';
import type {
  BenchmarkSuiteResult,
  IpcBenchmarkResult,
  TtftBenchmarkResult,
  ThroughputBenchmarkResult,
  ReportOptions,
} from './types.js';

/**
 * Generate console report
 */
export function generateConsoleReport(suite: BenchmarkSuiteResult): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║          kr-mlx-lm Performance Benchmark Report                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Environment
  console.log('Environment:');
  console.log(`  Node.js:     ${suite.environment.nodeVersion}`);
  console.log(`  Platform:    ${suite.environment.platform} (${suite.environment.arch})`);
  console.log(`  CPUs:        ${suite.environment.cpus}`);
  console.log(`  Memory:      ${suite.environment.totalMemoryMB} MB`);
  console.log(`  Timestamp:   ${suite.timestamp}`);

  // IPC Results
  if (suite.ipc && suite.ipc.length > 0) {
    console.log('\n' + '='.repeat(64));
    console.log('IPC Overhead Benchmark');
    console.log('='.repeat(64) + '\n');

    const grouped = new Map<string, IpcBenchmarkResult[]>();
    for (const result of suite.ipc) {
      const key = result.name.split(' - ')[0];
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(result);
    }

    for (const [payloadType, results] of grouped) {
      console.log(`${payloadType}:`);
      console.log(
        '  ' + ['Codec', 'Encode', 'Decode', 'Total', 'Size', 'Ratio'].map((h) => h.padEnd(14)).join(' ')
      );
      console.log('  ' + '-'.repeat(84));

      for (const result of results) {
        const encodeAvg = result.encodeStats.mean;
        const decodeAvg = result.decodeStats.mean;
        const ratio = result.compressionRatio ? `${result.compressionRatio.toFixed(2)}x` : '-';

        console.log(
          '  ' +
            [
              result.codec.padEnd(14),
              formatNumber(encodeAvg, 3, 12),
              formatNumber(decodeAvg, 3, 12),
              formatNumber(encodeAvg + decodeAvg, 3, 12),
              formatBytes(result.totalBytes).padEnd(14),
              ratio.padEnd(14),
            ].join(' ')
        );
      }
      console.log('');
    }
  }

  // TTFT Results
  if (suite.ttft && suite.ttft.length > 0) {
    console.log('='.repeat(64));
    console.log('TTFT (Time To First Token) Benchmark');
    console.log('='.repeat(64) + '\n');

    for (const result of suite.ttft) {
      console.log(`Model: ${result.modelId}`);
      console.log('  ' + ['Type', 'Mean', 'Median', 'P95', 'P99'].map((h) => h.padEnd(14)).join(' '));
      console.log('  ' + '-'.repeat(70));

      console.log(
        '  ' +
          [
            'Cold Start'.padEnd(14),
            formatNumber(result.coldStart.mean, 2, 12),
            formatNumber(result.coldStart.median, 2, 12),
            formatNumber(result.coldStart.p95, 2, 12),
            formatNumber(result.coldStart.p99, 2, 12),
          ].join(' ')
      );

      console.log(
        '  ' +
          [
            'Warm Start'.padEnd(14),
            formatNumber(result.warmStart.mean, 2, 12),
            formatNumber(result.warmStart.median, 2, 12),
            formatNumber(result.warmStart.p95, 2, 12),
            formatNumber(result.warmStart.p99, 2, 12),
          ].join(' ')
      );

      const speedup = (result.coldStart.mean / result.warmStart.mean).toFixed(2);
      console.log(`  Warm speedup: ${speedup}x\n`);
    }
  }

  // Throughput Results
  if (suite.throughput && suite.throughput.length > 0) {
    console.log('='.repeat(64));
    console.log('Throughput Benchmark');
    console.log('='.repeat(64) + '\n');

    const streaming = suite.throughput.filter((r) => r.streaming);
    const nonStreaming = suite.throughput.filter((r) => !r.streaming);

    const printThroughputTable = (title: string, results: ThroughputBenchmarkResult[]) => {
      if (results.length === 0) return;

      console.log(`${title}:`);
      console.log('  ' + ['Test', 'Tokens', 'Mean (t/s)', 'P95 (t/s)'].map((h) => h.padEnd(18)).join(' '));
      console.log('  ' + '-'.repeat(72));

      for (const result of results) {
        const name = result.name.replace('Throughput - ', '').slice(0, 18);
        console.log(
          '  ' +
            [
              name.padEnd(18),
              result.tokensGenerated.toString().padEnd(18),
              formatNumber(result.tokensPerSecond.mean, 2, 16),
              formatNumber(result.tokensPerSecond.p95, 2, 16),
            ].join(' ')
        );
      }
      console.log('');
    };

    printThroughputTable('Streaming', streaming);
    printThroughputTable('Non-Streaming', nonStreaming);
  }

  console.log('='.repeat(64));
  console.log('Report generated successfully');
  console.log('='.repeat(64) + '\n');
}

/**
 * Generate JSON report
 */
export async function generateJsonReport(suite: BenchmarkSuiteResult, outputPath: string): Promise<void> {
  const json = JSON.stringify(suite, null, 2);
  await writeFile(outputPath, json);
  console.log(`JSON report saved to: ${outputPath}`);
}

/**
 * Generate CSV report
 */
export async function generateCsvReport(suite: BenchmarkSuiteResult, outputPath: string): Promise<void> {
  const rows: string[] = [];

  // Header
  rows.push('Type,Name,Metric,Mean,Median,P95,P99,Min,Max,StdDev');

  // IPC results
  if (suite.ipc) {
    for (const result of suite.ipc) {
      const baseRow = `IPC,${result.name}`;
      rows.push(`${baseRow},Encode,${formatStatsRow(result.encodeStats).join(',')}`);
      rows.push(`${baseRow},Decode,${formatStatsRow(result.decodeStats).join(',')}`);
    }
  }

  // TTFT results
  if (suite.ttft) {
    for (const result of suite.ttft) {
      const baseRow = `TTFT,${result.modelId}`;
      rows.push(`${baseRow},ColdStart,${formatStatsRow(result.coldStart).join(',')}`);
      rows.push(`${baseRow},WarmStart,${formatStatsRow(result.warmStart).join(',')}`);
    }
  }

  // Throughput results
  if (suite.throughput) {
    for (const result of suite.throughput) {
      const baseRow = `Throughput,${result.name}`;
      rows.push(`${baseRow},TokensPerSec,${formatStatsRow(result.tokensPerSecond).join(',')}`);
      rows.push(`${baseRow},Latency,${formatStatsRow(result.avgLatencyMs).join(',')}`);
    }
  }

  await writeFile(outputPath, rows.join('\n'));
  console.log(`CSV report saved to: ${outputPath}`);
}

/**
 * Generate Markdown report
 */
export async function generateMarkdownReport(suite: BenchmarkSuiteResult, outputPath: string): Promise<void> {
  const lines: string[] = [];

  lines.push('# kr-mlx-lm Performance Benchmark Report\n');

  // Environment
  lines.push('## Environment\n');
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| Node.js | ${suite.environment.nodeVersion} |`);
  lines.push(`| Platform | ${suite.environment.platform} (${suite.environment.arch}) |`);
  lines.push(`| CPUs | ${suite.environment.cpus} |`);
  lines.push(`| Memory | ${suite.environment.totalMemoryMB} MB |`);
  lines.push(`| Timestamp | ${suite.timestamp} |\n`);

  // IPC Results
  if (suite.ipc && suite.ipc.length > 0) {
    lines.push('## IPC Overhead Benchmark\n');

    const grouped = new Map<string, IpcBenchmarkResult[]>();
    for (const result of suite.ipc) {
      const key = result.name.split(' - ')[0];
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(result);
    }

    for (const [payloadType, results] of grouped) {
      lines.push(`### ${payloadType}\n`);
      lines.push('| Codec | Encode (ms) | Decode (ms) | Total (ms) | Size | Compression |');
      lines.push('|-------|-------------|-------------|------------|------|-------------|');

      for (const result of results) {
        const encode = result.encodeStats.mean.toFixed(3);
        const decode = result.decodeStats.mean.toFixed(3);
        const total = (result.encodeStats.mean + result.decodeStats.mean).toFixed(3);
        const size = formatBytes(result.totalBytes);
        const ratio = result.compressionRatio ? `${result.compressionRatio.toFixed(2)}x` : '-';

        lines.push(`| ${result.codec} | ${encode} | ${decode} | ${total} | ${size} | ${ratio} |`);
      }
      lines.push('');
    }
  }

  // TTFT Results
  if (suite.ttft && suite.ttft.length > 0) {
    lines.push('## TTFT (Time To First Token) Benchmark\n');

    for (const result of suite.ttft) {
      lines.push(`### ${result.modelId}\n`);
      lines.push('| Type | Mean (ms) | Median (ms) | P95 (ms) | P99 (ms) |');
      lines.push('|------|-----------|-------------|----------|----------|');

      lines.push(
        `| Cold Start | ${result.coldStart.mean.toFixed(2)} | ${result.coldStart.median.toFixed(2)} | ${result.coldStart.p95.toFixed(2)} | ${result.coldStart.p99.toFixed(2)} |`
      );
      lines.push(
        `| Warm Start | ${result.warmStart.mean.toFixed(2)} | ${result.warmStart.median.toFixed(2)} | ${result.warmStart.p95.toFixed(2)} | ${result.warmStart.p99.toFixed(2)} |`
      );

      const speedup = (result.coldStart.mean / result.warmStart.mean).toFixed(2);
      lines.push(`\n**Warm speedup:** ${speedup}x\n`);
    }
  }

  // Throughput Results
  if (suite.throughput && suite.throughput.length > 0) {
    lines.push('## Throughput Benchmark\n');

    const streaming = suite.throughput.filter((r) => r.streaming);
    const nonStreaming = suite.throughput.filter((r) => !r.streaming);

    const printTable = (title: string, results: ThroughputBenchmarkResult[]) => {
      if (results.length === 0) return;

      lines.push(`### ${title}\n`);
      lines.push('| Test | Tokens | Mean (tokens/sec) | P95 (tokens/sec) |');
      lines.push('|------|--------|-------------------|------------------|');

      for (const result of results) {
        const name = result.name.replace('Throughput - ', '');
        lines.push(
          `| ${name} | ${result.tokensGenerated} | ${result.tokensPerSecond.mean.toFixed(2)} | ${result.tokensPerSecond.p95.toFixed(2)} |`
        );
      }
      lines.push('');
    };

    printTable('Streaming', streaming);
    printTable('Non-Streaming', nonStreaming);
  }

  await writeFile(outputPath, lines.join('\n'));
  console.log(`Markdown report saved to: ${outputPath}`);
}

/**
 * Generate report in specified format
 */
export async function generateReport(suite: BenchmarkSuiteResult, options: ReportOptions): Promise<void> {
  switch (options.format) {
    case 'console':
      generateConsoleReport(suite);
      break;

    case 'json':
      if (!options.output) throw new Error('Output path required for JSON format');
      await generateJsonReport(suite, options.output);
      break;

    case 'csv':
      if (!options.output) throw new Error('Output path required for CSV format');
      await generateCsvReport(suite, options.output);
      break;

    case 'markdown':
      if (!options.output) throw new Error('Output path required for Markdown format');
      await generateMarkdownReport(suite, options.output);
      break;

    default:
      throw new Error(`Unknown report format: ${options.format}`);
  }
}
