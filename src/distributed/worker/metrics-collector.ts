/**
 * Metrics Collector
 *
 * Tracks request metrics with rolling window for performance analysis.
 */

import { createLogger, type Logger } from '../utils/logger.js';

export interface RequestMetric {
  latencyMs: number;
  tokensGenerated: number;
  modelId: string;
  timestamp: number;
  success: boolean;
}

export interface WorkerMetrics {
  requests: {
    total: number;
    success: number;
    error: number;
  };
  latency: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  throughput: {
    tokensPerSecond: number;
    requestsPerSecond: number;
  };
  models: Record<
    string,
    {
      requestCount: number;
      avgLatency: number;
    }
  >;
}

export class MetricsCollector {
  private requests: RequestMetric[] = [];
  private readonly maxSamples: number;
  private readonly logger: Logger;
  private totalRequests = 0;
  private totalSuccess = 0;
  private totalErrors = 0;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
    this.logger = createLogger('MetricsCollector');
  }

  /**
   * Record a successful request
   */
  recordRequest(latencyMs: number, tokensGenerated: number, modelId: string): void {
    const metric: RequestMetric = {
      latencyMs,
      tokensGenerated,
      modelId,
      timestamp: Date.now(),
      success: true,
    };

    this.requests.push(metric);
    this.totalRequests++;
    this.totalSuccess++;

    // Trim to max samples (rolling window)
    if (this.requests.length > this.maxSamples) {
      this.requests.shift();
    }

    this.logger.debug('Request recorded', {
      latencyMs,
      tokensGenerated,
      modelId,
    });
  }

  /**
   * Record a failed request
   */
  recordError(error: Error): void {
    this.totalRequests++;
    this.totalErrors++;

    this.logger.debug('Error recorded', { error: error.message });
  }

  /**
   * Get current metrics
   */
  getMetrics(): WorkerMetrics {
    const successfulRequests = this.requests.filter((r) => r.success);

    if (successfulRequests.length === 0) {
      return this.getEmptyMetrics();
    }

    // Calculate latency metrics
    const latencies = successfulRequests.map((r) => r.latencyMs).sort((a, b) => a - b);
    const latencyMin = latencies[0];
    const latencyMax = latencies[latencies.length - 1];
    const latencyAvg = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
    const latencyP50 = this.percentile(latencies, 0.5);
    const latencyP95 = this.percentile(latencies, 0.95);
    const latencyP99 = this.percentile(latencies, 0.99);

    // Calculate throughput
    const totalTokens = successfulRequests.reduce((sum, r) => sum + r.tokensGenerated, 0);
    const totalTimeSeconds = successfulRequests.reduce((sum, r) => sum + r.latencyMs, 0) / 1000;
    const tokensPerSecond = totalTimeSeconds > 0 ? totalTokens / totalTimeSeconds : 0;

    // Calculate requests per second (last 60 seconds)
    const now = Date.now();
    const recentRequests = successfulRequests.filter((r) => now - r.timestamp < 60000);
    const requestsPerSecond = recentRequests.length / 60;

    // Calculate per-model metrics
    const modelMetrics: Record<string, { requestCount: number; avgLatency: number }> = {};
    for (const request of successfulRequests) {
      if (!modelMetrics[request.modelId]) {
        modelMetrics[request.modelId] = { requestCount: 0, avgLatency: 0 };
      }
      modelMetrics[request.modelId].requestCount++;
    }

    // Calculate average latency per model
    for (const modelId in modelMetrics) {
      const modelRequests = successfulRequests.filter((r) => r.modelId === modelId);
      const modelLatencies = modelRequests.map((r) => r.latencyMs);
      modelMetrics[modelId].avgLatency =
        modelLatencies.reduce((sum, val) => sum + val, 0) / modelLatencies.length;
    }

    return {
      requests: {
        total: this.totalRequests,
        success: this.totalSuccess,
        error: this.totalErrors,
      },
      latency: {
        min: latencyMin,
        max: latencyMax,
        avg: latencyAvg,
        p50: latencyP50,
        p95: latencyP95,
        p99: latencyP99,
      },
      throughput: {
        tokensPerSecond,
        requestsPerSecond,
      },
      models: modelMetrics,
    };
  }

  /**
   * Get average latency
   */
  getAverageLatency(): number {
    const successfulRequests = this.requests.filter((r) => r.success);
    if (successfulRequests.length === 0) return 0;

    const totalLatency = successfulRequests.reduce((sum, r) => sum + r.latencyMs, 0);
    return totalLatency / successfulRequests.length;
  }

  /**
   * Get throughput (tokens/second)
   */
  getThroughput(): number {
    const successfulRequests = this.requests.filter((r) => r.success);
    if (successfulRequests.length === 0) return 0;

    const totalTokens = successfulRequests.reduce((sum, r) => sum + r.tokensGenerated, 0);
    const totalTimeSeconds = successfulRequests.reduce((sum, r) => sum + r.latencyMs, 0) / 1000;

    return totalTimeSeconds > 0 ? totalTokens / totalTimeSeconds : 0;
  }

  /**
   * Get error rate (0-1)
   */
  getErrorRate(): number {
    if (this.totalRequests === 0) return 0;
    return this.totalErrors / this.totalRequests;
  }

  /**
   * Reset metrics
   */
  reset(): void {
    this.requests = [];
    this.totalRequests = 0;
    this.totalSuccess = 0;
    this.totalErrors = 0;
    this.logger.info('Metrics reset');
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;

    const index = Math.ceil(sortedValues.length * p) - 1;
    return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
  }

  /**
   * Get empty metrics
   */
  private getEmptyMetrics(): WorkerMetrics {
    return {
      requests: {
        total: this.totalRequests,
        success: this.totalSuccess,
        error: this.totalErrors,
      },
      latency: {
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      },
      throughput: {
        tokensPerSecond: 0,
        requestsPerSecond: 0,
      },
      models: {},
    };
  }
}
