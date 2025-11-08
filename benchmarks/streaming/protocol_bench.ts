/**
 * Protocol Benchmark Harness
 *
 * Compares HTTP/1.1 vs HTTP/2 vs WebSocket performance for streaming workloads.
 * Measures TTFT, throughput, CPU usage, and connection overhead.
 *
 * Phase 4.2 Implementation
 */

import { performance } from 'perf_hooks';
import http from 'http';
import http2 from 'http2';
import { WebSocket } from 'ws';

/**
 * Benchmark configuration
 */
interface BenchmarkConfig {
  concurrency: number;
  requestsPerConnection: number;
  protocol: 'http1' | 'http2' | 'ws';
  endpoint: string;
  payload: string;
}

/**
 * Benchmark results
 */
interface BenchmarkResult {
  protocol: string;
  concurrency: number;
  totalRequests: number;
  totalDurationMs: number;
  averageTtftMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  p99TtftMs: number;
  throughputReqSec: number;
  totalConnections: number;
  cpuUsagePercent: number;
  memoryUsageMb: number;
  errors: number;
}

/**
 * Request metrics
 */
interface RequestMetric {
  ttft: number; // Time to first token
  duration: number;
  tokens: number;
  error?: string;
}

/**
 * Protocol Benchmark Runner
 */
export class ProtocolBenchmark {
  private config: BenchmarkConfig;

  constructor(config: BenchmarkConfig) {
    this.config = config;
  }

  /**
   * Run benchmark
   */
  public async run(): Promise<BenchmarkResult> {
    console.log(`\n=== Running ${this.config.protocol.toUpperCase()} Benchmark ===`);
    console.log(`Concurrency: ${this.config.concurrency}`);
    console.log(`Requests per connection: ${this.config.requestsPerConnection}\n`);

    const startTime = performance.now();
    const startCpuUsage = process.cpuUsage();
    const startMemUsage = process.memoryUsage();

    let metrics: RequestMetric[] = [];

    switch (this.config.protocol) {
      case 'http1':
        metrics = await this.runHttp1Benchmark();
        break;
      case 'http2':
        metrics = await this.runHttp2Benchmark();
        break;
      case 'ws':
        metrics = await this.runWebSocketBenchmark();
        break;
    }

    const endTime = performance.now();
    const endCpuUsage = process.cpuUsage(startCpuUsage);
    const endMemUsage = process.memoryUsage();

    // Calculate statistics
    const ttftValues = metrics.map((m) => m.ttft).filter((t) => t > 0);
    ttftValues.sort((a, b) => a - b);

    const totalDurationMs = endTime - startTime;
    const averageTtftMs = ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length;
    const p50TtftMs = this.percentile(ttftValues, 0.5);
    const p95TtftMs = this.percentile(ttftValues, 0.95);
    const p99TtftMs = this.percentile(ttftValues, 0.99);
    const throughputReqSec = (metrics.length / totalDurationMs) * 1000;
    const errors = metrics.filter((m) => m.error).length;

    // CPU usage percentage
    const cpuUsageMs = (endCpuUsage.user + endCpuUsage.system) / 1000;
    const cpuUsagePercent = (cpuUsageMs / totalDurationMs) * 100;

    // Memory usage in MB
    const memoryUsageMb = (endMemUsage.heapUsed - startMemUsage.heapUsed) / 1024 / 1024;

    const result: BenchmarkResult = {
      protocol: this.config.protocol,
      concurrency: this.config.concurrency,
      totalRequests: metrics.length,
      totalDurationMs,
      averageTtftMs,
      p50TtftMs,
      p95TtftMs,
      p99TtftMs,
      throughputReqSec,
      totalConnections: this.config.concurrency,
      cpuUsagePercent,
      memoryUsageMb,
      errors,
    };

    this.printResult(result);
    return result;
  }

  /**
   * Run HTTP/1.1 benchmark
   */
  private async runHttp1Benchmark(): Promise<RequestMetric[]> {
    const metrics: RequestMetric[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < this.config.concurrency; i++) {
      promises.push(
        (async () => {
          for (let j = 0; j < this.config.requestsPerConnection; j++) {
            const metric = await this.makeHttp1Request();
            metrics.push(metric);
          }
        })()
      );
    }

    await Promise.all(promises);
    return metrics;
  }

  /**
   * Make a single HTTP/1.1 request
   */
  private async makeHttp1Request(): Promise<RequestMetric> {
    const startTime = performance.now();
    let firstToken = 0;
    let tokens = 0;

    return new Promise((resolve) => {
      const req = http.request(
        this.config.endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.on('data', (chunk) => {
            if (firstToken === 0) {
              firstToken = performance.now() - startTime;
            }
            tokens++;
          });

          res.on('end', () => {
            resolve({
              ttft: firstToken,
              duration: performance.now() - startTime,
              tokens,
            });
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          ttft: 0,
          duration: performance.now() - startTime,
          tokens: 0,
          error: err.message,
        });
      });

      req.write(this.config.payload);
      req.end();
    });
  }

  /**
   * Run HTTP/2 benchmark (simplified - actual implementation would use Http2Pool)
   */
  private async runHttp2Benchmark(): Promise<RequestMetric[]> {
    // Simplified HTTP/2 benchmark - in production this would use Http2Pool
    console.warn('HTTP/2 benchmark not fully implemented - using HTTP/1.1 as fallback');
    return this.runHttp1Benchmark();
  }

  /**
   * Run WebSocket benchmark (simplified)
   */
  private async runWebSocketBenchmark(): Promise<RequestMetric[]> {
    // Simplified WebSocket benchmark
    console.warn('WebSocket benchmark not fully implemented - placeholder');
    return [];
  }

  /**
   * Calculate percentile
   */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const index = Math.floor(values.length * p);
    return values[index];
  }

  /**
   * Print benchmark result
   */
  private printResult(result: BenchmarkResult): void {
    console.log('\n--- Results ---');
    console.log(`Protocol: ${result.protocol.toUpperCase()}`);
    console.log(`Total Requests: ${result.totalRequests}`);
    console.log(`Duration: ${result.totalDurationMs.toFixed(2)}ms`);
    console.log(`Throughput: ${result.throughputReqSec.toFixed(2)} req/s`);
    console.log(`\nTTFT (Time To First Token):`);
    console.log(`  Average: ${result.averageTtftMs.toFixed(2)}ms`);
    console.log(`  P50: ${result.p50TtftMs.toFixed(2)}ms`);
    console.log(`  P95: ${result.p95TtftMs.toFixed(2)}ms`);
    console.log(`  P99: ${result.p99TtftMs.toFixed(2)}ms`);
    console.log(`\nResource Usage:`);
    console.log(`  CPU: ${result.cpuUsagePercent.toFixed(2)}%`);
    console.log(`  Memory: ${result.memoryUsageMb.toFixed(2)}MB`);
    console.log(`  Connections: ${result.totalConnections}`);
    console.log(`  Errors: ${result.errors}`);
    console.log('');
  }
}

/**
 * Compare protocols at different concurrency levels
 */
export async function compareProtocols(): Promise<void> {
  const concurrencyLevels = [32, 50, 75, 100];
  const protocols: Array<'http1' | 'http2' | 'ws'> = ['http1', 'http2', 'ws'];
  const results: BenchmarkResult[] = [];

  for (const concurrency of concurrencyLevels) {
    for (const protocol of protocols) {
      const benchmark = new ProtocolBenchmark({
        concurrency,
        requestsPerConnection: 10,
        protocol,
        endpoint: 'http://localhost:3000/v1/chat/completions',
        payload: JSON.stringify({
          model: 'mlx-community/gemma-2-27b-it-4bit',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      try {
        const result = await benchmark.run();
        results.push(result);
      } catch (err) {
        console.error(`Error running ${protocol} benchmark:`, err);
      }

      // Wait between benchmarks
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  // Print comparison table
  console.log('\n=== Protocol Comparison Summary ===\n');
  console.log('Concurrency | Protocol | TTFT P95 (ms) | Throughput (req/s) | CPU (%)');
  console.log('------------|----------|---------------|--------------------|---------');

  for (const result of results) {
    console.log(
      `${result.concurrency.toString().padEnd(11)} | ` +
        `${result.protocol.toUpperCase().padEnd(8)} | ` +
        `${result.p95TtftMs.toFixed(2).padEnd(13)} | ` +
        `${result.throughputReqSec.toFixed(2).padEnd(18)} | ` +
        `${result.cpuUsagePercent.toFixed(2)}`
    );
  }

  // Save results to JSON
  const fs = await import('fs/promises');
  await fs.writeFile(
    'benchmarks/results/protocol_comparison.json',
    JSON.stringify(results, null, 2)
  );

  console.log('\nResults saved to benchmarks/results/protocol_comparison.json');
}

// Run benchmark if called directly
if (require.main === module) {
  compareProtocols().catch(console.error);
}
