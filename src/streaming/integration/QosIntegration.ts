/**
 * QoS Integration Layer
 *
 * Connects StreamRegistry with QosMonitor for real-time SLO monitoring.
 * Automatically records TTFT, throughput, and error metrics for QoS evaluation.
 *
 * Phase 4.4 Integration
 */

import type { Logger } from 'pino';
import type { StreamRegistry, StreamRegistryEvents } from '../../bridge/stream-registry.js';
import { QosMonitor } from '../qos/QosMonitor.js';
import type { QosMonitorConfig } from '../qos/QosMonitor.js';
import type { MetricSample } from '../qos/types.js';

/**
 * QoS Integration Configuration
 */
export interface QosIntegrationConfig {
  enabled: boolean;
  qosMonitor: QosMonitorConfig;
  sampleRate?: number; // Sample every Nth metric (default: 1 = all)
}

/**
 * QoS Integration
 *
 * Bridges StreamRegistry and QosMonitor to enable automated SLO monitoring.
 * Listens to StreamRegistry events and converts them to QoS metrics.
 */
export class QosIntegration {
  private readonly streamRegistry: StreamRegistry;
  private readonly qosMonitor?: QosMonitor;
  private readonly config: QosIntegrationConfig;
  private readonly logger?: Logger;
  private sampleCounter = 0;

  // Metrics tracking
  private totalStreams = 0;
  private errorCount = 0;
  private ttftSum = 0;
  private ttftCount = 0;
  private throughputSum = 0;
  private throughputCount = 0;

  constructor(
    streamRegistry: StreamRegistry,
    config: QosIntegrationConfig,
    logger?: Logger
  ) {
    this.streamRegistry = streamRegistry;
    this.config = config;
    this.logger = logger;

    if (this.config.enabled) {
      this.qosMonitor = new QosMonitor(config.qosMonitor, logger);
      this.setupEventListeners();
      this.qosMonitor.start();
      this.logger?.info('QoS integration enabled');
    } else {
      this.logger?.info('QoS integration disabled');
    }
  }

  /**
   * Setup event listeners on StreamRegistry
   */
  private setupEventListeners(): void {
    if (!this.qosMonitor) {
      return;
    }

    // Listen to stream completion for TTFT and throughput metrics
    this.streamRegistry.on('completed', (streamId, stats) => {
      this.handleStreamCompleted(streamId, stats);
    });

    // Listen to errors for error rate metric
    this.streamRegistry.on('error', (streamId, error) => {
      this.handleStreamError(streamId, error);
    });

    // Listen to metrics export for aggregate data
    this.streamRegistry.on('metricsExport', (metrics) => {
      this.handleMetricsExport(metrics);
    });

    this.logger?.debug('QoS event listeners registered');
  }

  /**
   * Handle stream completion event
   */
  private handleStreamCompleted(streamId: string, stats: StreamRegistryEvents['completed'] extends (streamId: string, stats: infer S) => void ? S : never): void {
    if (!this.qosMonitor || !this.shouldSample()) {
      return;
    }

    this.totalStreams++;

    // Record TTFT metric
    if (stats.timeToFirstToken > 0) {
      const ttftSample: MetricSample = {
        metric: 'ttft',
        value: stats.timeToFirstToken,
        timestamp: Date.now(),
        streamId,
      };

      this.qosMonitor.recordMetric(ttftSample);

      this.ttftSum += stats.timeToFirstToken;
      this.ttftCount++;
    }

    // Record throughput metric (convert to tokens/sec if needed)
    if (stats.tokensPerSecond > 0) {
      const throughputSample: MetricSample = {
        metric: 'throughput',
        value: stats.tokensPerSecond,
        timestamp: Date.now(),
        streamId,
      };

      this.qosMonitor.recordMetric(throughputSample);

      this.throughputSum += stats.tokensPerSecond;
      this.throughputCount++;
    }

    this.logger?.debug(
      { streamId, ttft: stats.timeToFirstToken, throughput: stats.tokensPerSecond },
      'Recorded QoS metrics for completed stream'
    );
  }

  /**
   * Handle stream error event
   */
  private handleStreamError(streamId: string, error: string): void {
    if (!this.qosMonitor || !this.shouldSample()) {
      return;
    }

    this.errorCount++;
    this.totalStreams++;

    // Calculate error rate (errors / total streams)
    const errorRate = this.totalStreams > 0 ? this.errorCount / this.totalStreams : 0;

    const errorRateSample: MetricSample = {
      metric: 'error_rate',
      value: errorRate,
      timestamp: Date.now(),
      streamId,
    };

    this.qosMonitor.recordMetric(errorRateSample);

    this.logger?.debug(
      { streamId, error, errorRate },
      'Recorded error rate metric'
    );
  }

  /**
   * Handle metrics export event from StreamRegistry
   */
  private handleMetricsExport(metrics: Parameters<StreamRegistryEvents['metricsExport']>[0]): void {
    if (!this.qosMonitor) {
      return;
    }

    // Record aggregate TTFT if available
    if (metrics.averageTTFT > 0) {
      const ttftSample: MetricSample = {
        metric: 'ttft',
        value: metrics.averageTTFT,
        timestamp: metrics.timestamp,
      };

      this.qosMonitor.recordMetric(ttftSample);
    }

    // Record aggregate throughput if available
    if (metrics.averageThroughput > 0) {
      const throughputSample: MetricSample = {
        metric: 'throughput',
        value: metrics.averageThroughput,
        timestamp: metrics.timestamp,
      };

      this.qosMonitor.recordMetric(throughputSample);
    }

    this.logger?.trace(
      {
        avgTTFT: metrics.averageTTFT,
        avgThroughput: metrics.averageThroughput,
        activeStreams: metrics.activeStreams,
      },
      'Recorded aggregate QoS metrics'
    );
  }

  /**
   * Determine if we should sample this metric
   */
  private shouldSample(): boolean {
    const sampleRate = this.config.sampleRate ?? 1;

    if (sampleRate === 1) {
      return true;
    }

    this.sampleCounter++;

    if (this.sampleCounter >= sampleRate) {
      this.sampleCounter = 0;
      return true;
    }

    return false;
  }

  /**
   * Get QoS telemetry snapshot
   */
  public getTelemetry(): ReturnType<QosMonitor['getTelemetry']> | null {
    if (!this.qosMonitor) {
      return null;
    }

    const telemetry = this.qosMonitor.getTelemetry();

    // Enrich with StreamRegistry metrics
    const aggregateMetrics = this.streamRegistry.getAggregateMetrics();
    telemetry.totalStreams = aggregateMetrics.totalStreams;

    return telemetry;
  }

  /**
   * Get integration statistics
   */
  public getStats(): {
    enabled: boolean;
    totalStreams: number;
    errorCount: number;
    averageTTFT: number;
    averageThroughput: number;
    sampleRate: number;
  } {
    return {
      enabled: this.config.enabled,
      totalStreams: this.totalStreams,
      errorCount: this.errorCount,
      averageTTFT: this.ttftCount > 0 ? this.ttftSum / this.ttftCount : 0,
      averageThroughput: this.throughputCount > 0 ? this.throughputSum / this.throughputCount : 0,
      sampleRate: this.config.sampleRate ?? 1,
    };
  }

  /**
   * Stop QoS monitoring
   */
  public stop(): void {
    if (this.qosMonitor) {
      this.qosMonitor.stop();
      this.logger?.info('QoS integration stopped');
    }
  }

  /**
   * Clear QoS state
   */
  public clear(): void {
    if (this.qosMonitor) {
      this.qosMonitor.clear();
    }

    this.totalStreams = 0;
    this.errorCount = 0;
    this.ttftSum = 0;
    this.ttftCount = 0;
    this.throughputSum = 0;
    this.throughputCount = 0;
    this.sampleCounter = 0;

    this.logger?.info('QoS integration state cleared');
  }

  /**
   * Get QoS Monitor instance (for advanced usage)
   */
  public getQosMonitor(): QosMonitor | undefined {
    return this.qosMonitor;
  }
}
