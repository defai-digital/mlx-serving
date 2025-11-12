/**
 * Metrics Collector - Real-time metrics collection and comparison for canary deployments
 *
 * Features:
 * - Time-series metrics storage (1-hour sliding window)
 * - Percentile calculations (P50/P95/P99)
 * - Error rate tracking
 * - Resource utilization monitoring
 * - Baseline vs canary comparison
 * - Health assessment
 *
 * @module canary/metrics-collector
 */

import { safeAverage, safeDivide } from '@/utils/math-helpers.js';
import { cpuUsage, memoryUsage } from 'node:process';

/**
 * Metrics snapshot for a single variant at a point in time
 */
export interface MetricsSnapshot {
  /** Timestamp (ms since epoch) */
  timestamp: number;

  /** Variant: baseline or canary */
  variant: 'baseline' | 'canary';

  // Request metrics
  /** Total request count */
  requestCount: number;

  /** Successful request count */
  successCount: number;

  /** Error count */
  errorCount: number;

  /** Error rate (0.0-1.0) */
  errorRate: number;

  // Latency metrics (milliseconds)
  latency: {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };

  // Throughput metrics
  throughput: {
    requestsPerSecond: number;
    tokensPerSecond?: number;
  };

  // Resource metrics
  resources: {
    cpuPercent: number;
    memoryMB: number;
    memoryGrowthRate: number; // MB/hour
  };
}

/**
 * Comparison result between baseline and canary
 */
export interface ComparisonResult {
  /** Timestamp (ms) */
  timestamp: number;

  /** Baseline snapshot */
  baseline: MetricsSnapshot;

  /** Canary snapshot */
  canary: MetricsSnapshot;

  // Deltas (canary - baseline)
  deltas: {
    /** Error rate delta (absolute %) */
    errorRateDelta: number;

    /** P95 latency delta (ms) */
    p95LatencyDelta: number;

    /** P95 latency delta (%) */
    p95LatencyDeltaPercent: number;

    /** Memory growth rate delta (MB/hour) */
    memoryGrowthDelta: number;
  };

  // Health assessment
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
    recommendations: string[];
  };
}

/**
 * Internal request record
 */
interface RequestRecord {
  variant: 'baseline' | 'canary';
  latencyMs: number;
  success: boolean;
  error?: Error;
  timestamp: number;
  tokens?: number;
}

/**
 * Metrics Collector - Collects and compares metrics
 */
export class MetricsCollector {
  // Request history (1-hour sliding window)
  private requests: Map<'baseline' | 'canary', RequestRecord[]>;

  // Window size (1 hour = 3600 seconds)
  private readonly windowMs = 60 * 60 * 1000;

  // Aggregation interval (5 seconds)
  private readonly aggregationIntervalMs = 5000;

  // Resource baselines for growth rate calculation
  private baselineMemoryMB = 0;
  private canaryMemoryMB = 0;
  private lastMemoryCheckTime = Date.now();

  /**
   * Create a new MetricsCollector
   */
  constructor() {
    this.requests = new Map([
      ['baseline', []],
      ['canary', []],
    ]);

    // Initialize memory baselines
    const mem = memoryUsage();
    this.baselineMemoryMB = mem.heapUsed / 1024 / 1024;
    this.canaryMemoryMB = mem.heapUsed / 1024 / 1024;
  }

  /**
   * Record a request completion
   *
   * @param variant - baseline or canary
   * @param latencyMs - Request latency in milliseconds
   * @param success - Whether request succeeded
   * @param error - Error object if failed
   * @param tokens - Number of tokens generated (optional)
   */
  recordRequest(
    variant: 'baseline' | 'canary',
    latencyMs: number,
    success: boolean,
    error?: Error,
    tokens?: number
  ): void {
    const record: RequestRecord = {
      variant,
      latencyMs,
      success,
      error,
      timestamp: Date.now(),
      tokens,
    };

    const variantRequests = this.requests.get(variant)!;
    variantRequests.push(record);

    // Clean old requests outside window
    this.cleanOldRequests(variant);
  }

  /**
   * Clean requests older than window size
   */
  private cleanOldRequests(variant: 'baseline' | 'canary'): void {
    const cutoffTime = Date.now() - this.windowMs;
    const variantRequests = this.requests.get(variant)!;

    // Find first index within window
    let firstValidIndex = 0;
    while (
      firstValidIndex < variantRequests.length &&
      variantRequests[firstValidIndex].timestamp < cutoffTime
    ) {
      firstValidIndex++;
    }

    // Remove old requests
    if (firstValidIndex > 0) {
      variantRequests.splice(0, firstValidIndex);
    }
  }

  /**
   * Calculate percentile from sorted array
   *
   * @param sorted - Sorted array of numbers
   * @param percentile - Percentile (0-100)
   * @returns Percentile value
   */
  private calculatePercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) return 0;

    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) {
      return sorted[lower];
    }

    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * Get current snapshot for a variant
   *
   * @param variant - baseline or canary
   * @returns Metrics snapshot
   */
  getSnapshot(variant: 'baseline' | 'canary'): MetricsSnapshot {
    const variantRequests = this.requests.get(variant)!;

    // Request metrics
    const requestCount = variantRequests.length;
    const successCount = variantRequests.filter((r) => r.success).length;
    const errorCount = requestCount - successCount;
    const errorRate = safeDivide(errorCount, requestCount);

    // Latency metrics
    const latencies = variantRequests.map((r) => r.latencyMs).sort((a, b) => a - b);
    const mean = safeAverage(latencies);
    const p50 = this.calculatePercentile(latencies, 50);
    const p95 = this.calculatePercentile(latencies, 95);
    const p99 = this.calculatePercentile(latencies, 99);
    const max = latencies.length > 0 ? latencies[latencies.length - 1] : 0;

    // Throughput metrics
    const windowSeconds = this.windowMs / 1000;
    const requestsPerSecond = requestCount / windowSeconds;

    const totalTokens = variantRequests.reduce((sum, r) => sum + (r.tokens || 0), 0);
    const tokensPerSecond = totalTokens / windowSeconds;

    // Resource metrics
    const mem = memoryUsage();
    const currentMemoryMB = mem.heapUsed / 1024 / 1024;

    // Calculate memory growth rate (MB/hour)
    const elapsedHours = (Date.now() - this.lastMemoryCheckTime) / (1000 * 60 * 60);
    const memoryGrowthRate =
      elapsedHours > 0
        ? (currentMemoryMB - (variant === 'baseline' ? this.baselineMemoryMB : this.canaryMemoryMB)) /
          elapsedHours
        : 0;

    // CPU usage (approximation)
    const cpu = cpuUsage();
    const cpuPercent = ((cpu.user + cpu.system) / 1000000) * 100; // microseconds to %

    return {
      timestamp: Date.now(),
      variant,
      requestCount,
      successCount,
      errorCount,
      errorRate,
      latency: {
        mean,
        p50,
        p95,
        p99,
        max,
      },
      throughput: {
        requestsPerSecond,
        tokensPerSecond: totalTokens > 0 ? tokensPerSecond : undefined,
      },
      resources: {
        cpuPercent,
        memoryMB: currentMemoryMB,
        memoryGrowthRate,
      },
    };
  }

  /**
   * Compare baseline vs canary
   *
   * @returns Comparison result with health assessment
   */
  compare(): ComparisonResult {
    const baseline = this.getSnapshot('baseline');
    const canary = this.getSnapshot('canary');

    // Calculate deltas
    const errorRateDelta = canary.errorRate - baseline.errorRate;
    const p95LatencyDelta = canary.latency.p95 - baseline.latency.p95;
    const p95LatencyDeltaPercent =
      baseline.latency.p95 > 0
        ? (p95LatencyDelta / baseline.latency.p95) * 100
        : 0;
    const memoryGrowthDelta =
      canary.resources.memoryGrowthRate - baseline.resources.memoryGrowthRate;

    // Health assessment
    const issues: string[] = [];
    const recommendations: string[] = [];
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

    // Check error rate (critical if > 2x baseline)
    if (canary.errorRate > baseline.errorRate * 2 && canary.errorRate > 0.01) {
      issues.push(
        `High error rate: ${(canary.errorRate * 100).toFixed(2)}% (baseline: ${(baseline.errorRate * 100).toFixed(2)}%)`
      );
      status = 'critical';
      recommendations.push('Consider immediate rollback');
    }

    // Check latency (warning if > 1.5x baseline)
    if (canary.latency.p95 > baseline.latency.p95 * 1.5) {
      issues.push(
        `High P95 latency: ${canary.latency.p95.toFixed(0)}ms (baseline: ${baseline.latency.p95.toFixed(0)}ms)`
      );
      if (status === 'healthy') status = 'degraded';
      recommendations.push('Investigate latency regression');
    }

    // Check memory growth (warning if > 50 MB/hour)
    if (canary.resources.memoryGrowthRate > 50) {
      issues.push(
        `High memory growth: ${canary.resources.memoryGrowthRate.toFixed(1)} MB/hour`
      );
      if (status === 'healthy') status = 'degraded';
      recommendations.push('Monitor for memory leaks');
    }

    // Positive health checks
    if (issues.length === 0) {
      if (p95LatencyDelta < 0) {
        recommendations.push('P95 latency improved - consider increasing rollout');
      }
      if (errorRateDelta < 0) {
        recommendations.push('Error rate improved - canary performing well');
      }
      if (canary.requestCount > 100 && status === 'healthy') {
        recommendations.push('Sufficient data collected - safe to proceed');
      }
    }

    return {
      timestamp: Date.now(),
      baseline,
      canary,
      deltas: {
        errorRateDelta,
        p95LatencyDelta,
        p95LatencyDeltaPercent,
        memoryGrowthDelta,
      },
      health: {
        status,
        issues,
        recommendations,
      },
    };
  }

  /**
   * Get time-series data for last N minutes
   *
   * @param minutes - Number of minutes to retrieve
   * @returns Time-series snapshots for both variants
   */
  getTimeSeries(minutes: number): {
    baseline: MetricsSnapshot[];
    canary: MetricsSnapshot[];
  } {
    const cutoffTime = Date.now() - minutes * 60 * 1000;

    // For simplicity, return current snapshot for each variant
    // In production, you'd aggregate data at intervals
    const baseline = this.getSnapshot('baseline');
    const canary = this.getSnapshot('canary');

    return {
      baseline: baseline.timestamp >= cutoffTime ? [baseline] : [],
      canary: canary.timestamp >= cutoffTime ? [canary] : [],
    };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.requests.set('baseline', []);
    this.requests.set('canary', []);

    const mem = memoryUsage();
    this.baselineMemoryMB = mem.heapUsed / 1024 / 1024;
    this.canaryMemoryMB = mem.heapUsed / 1024 / 1024;
    this.lastMemoryCheckTime = Date.now();
  }

  /**
   * Get total request counts
   */
  getTotalCounts(): {
    baseline: number;
    canary: number;
    total: number;
  } {
    const baselineCount = this.requests.get('baseline')!.length;
    const canaryCount = this.requests.get('canary')!.length;

    return {
      baseline: baselineCount,
      canary: canaryCount,
      total: baselineCount + canaryCount,
    };
  }
}
