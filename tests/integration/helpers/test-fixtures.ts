/**
 * Test Fixtures for Phase 4/5 Integration Tests
 *
 * Provides mock implementations and test data generators for integration testing.
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type { StreamRegistryEvents } from '../../../src/bridge/stream-registry.js';
import type { Config } from '../../../src/config/loader.js';
import type { FeatureFlagConfig } from '../../../src/config/feature-flag-loader.js';

/**
 * Mock Logger (no-op logger for tests)
 */
export function createMockLogger(): Logger {
  const noop = (): void => {};
  const mockLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    child: () => mockLogger,
    level: 'silent',
    isLevelEnabled: () => false,
  } as unknown as Logger;

  return mockLogger;
}

/**
 * Mock StreamRegistry for testing
 */
export class MockStreamRegistry extends EventEmitter<StreamRegistryEvents> {
  private streams = new Map<string, { status: string; stats?: Record<string, unknown> }>();
  private aggregateMetrics = {
    timestamp: Date.now(),
    totalStreams: 0,
    activeStreams: 0,
    completedStreams: 0,
    cancelledStreams: 0,
    averageTTFT: 0,
    averageThroughput: 0,
    currentLimit: 100,
    utilizationRate: 0,
  };

  register(
    streamId: string,
    signal?: AbortSignal,
    timeout?: number
  ): Promise<{ streamId: string; tokensGenerated: number; tokensPerSecond: number; timeToFirstToken: number; totalTime: number }> {
    this.streams.set(streamId, { status: 'active' });
    this.aggregateMetrics.activeStreams++;
    this.aggregateMetrics.totalStreams++;
    this.aggregateMetrics.utilizationRate = this.aggregateMetrics.activeStreams / this.aggregateMetrics.currentLimit;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }

      signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });

      if (timeout) {
        setTimeout(() => {
          reject(new Error('timed out'));
        }, timeout);
      }
    });
  }

  /**
   * Simulate stream completion
   */
  simulateCompletion(
    streamId: string,
    stats = { streamId, tokensGenerated: 100, tokensPerSecond: 50, timeToFirstToken: 200, totalTime: 2000 }
  ): void {
    this.streams.set(streamId, { status: 'completed', stats });
    this.aggregateMetrics.activeStreams--;
    this.aggregateMetrics.completedStreams++;
    this.aggregateMetrics.utilizationRate = this.aggregateMetrics.activeStreams / this.aggregateMetrics.currentLimit;
    this.emit('completed', streamId, stats);
  }

  /**
   * Simulate stream error
   */
  simulateError(streamId: string, error: string): void {
    this.streams.set(streamId, { status: 'failed' });
    this.aggregateMetrics.activeStreams--;
    this.aggregateMetrics.utilizationRate = this.aggregateMetrics.activeStreams / this.aggregateMetrics.currentLimit;
    this.emit('error', streamId, error);
  }

  /**
   * Simulate metrics export
   */
  simulateMetricsExport(): void {
    this.aggregateMetrics.timestamp = Date.now();
    this.emit('metricsExport', this.aggregateMetrics);
  }

  getAggregateMetrics(): { timestamp: number; activeStreams: number; totalStreams: number; completedStreams: number; cancelledStreams: number; averageTTFT: number; averageThroughput: number; currentLimit: number; utilizationRate: number } {
    return { ...this.aggregateMetrics, timestamp: Date.now() };
  }

  clear(): void {
    this.streams.clear();
    this.aggregateMetrics = {
      timestamp: Date.now(),
      totalStreams: 0,
      activeStreams: 0,
      completedStreams: 0,
      cancelledStreams: 0,
      averageTTFT: 0,
      averageThroughput: 0,
      currentLimit: 100,
      utilizationRate: 0,
    };
  }
}

/**
 * Create test configuration with Phase 4/5 enabled
 */
export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const baseConfig: Config = {
    batch_queue: {
      enabled: true,
      max_batch_size: 8,
      flush_interval_ms: 100,
    },
    generate_batcher: {
      enabled: true,
      min_batch_size: 1,
      max_batch_size: 8,
      min_hold_ms: 10,
      max_hold_ms: 100,
      background_hold_extension_ms: 50,
      target_batch_time_ms: 50,
      pause_on_backpressure_ms: 100,
    },
    request_deduplication: {
      enabled: false,
      ttl_ms: 30000,
      max_entries: 1000,
      max_payload_bytes: 1048576,
    },
    prompt_cache: {
      enabled: false,
      max_entries: 100,
      max_total_tokens: 100000,
      max_total_bytes: 10485760,
      ttl_ms: 300000,
      cleanup_interval_ms: 60000,
    },
    request_coalescing: {
      enabled: false,
      max_subscribers: 10,
      timeout_ms: 5000,
    },
    runtime_router: {
      enabled: false,
      worker_count: 1,
      routing_strategy: 'round-robin',
      health_check_interval_ms: 5000,
      worker_restart_delay_ms: 1000,
      sticky_session_enabled: false,
      sticky_session_ttl_ms: 300000,
    },
    python_runtime_manager: {
      enabled: false,
      worker_count: 1,
      heartbeat_interval_ms: 1000,
      heartbeat_timeout_ms: 5000,
    },
    adaptive_batch_coordinator: {
      enabled: false,
      python_rpc_method: 'get_optimal_batch_size',
      update_interval_ms: 5000,
      default_batch_size: 4,
      min_batch_size: 1,
      max_batch_size: 16,
      rpc_timeout_ms: 1000,
    },
    retry_policy: {
      enabled: false,
      max_attempts: 3,
      initial_delay_ms: 100,
      max_delay_ms: 5000,
      backoff_multiplier: 2,
      jitter: 0.1,
      retryable_errors: [],
    },
    circuit_breaker: {
      enabled: false,
      failure_threshold: 5,
      recovery_timeout_ms: 30000,
      half_open_max_calls: 3,
      half_open_success_threshold: 2,
      failure_window_ms: 60000,
    },
    streaming: {
      phase4: {
        adaptive_governor: {
          enabled: true,
          pid_controller: {
            kp: 0.5,
            ki: 0.1,
            kd: 0.05,
            setpoint: 0.8,
            output_min: 0,
            output_max: 100,
          },
          target_throughput: 50,
          max_concurrent_streams: 10,
          backpressure_threshold: 0.9,
        },
      },
    },
    ttft_accelerator: {
      enabled: true,
      warm_queue: {
        max_size: 100,
        ttl_ms: 5000,
        priority_by_tokens: true,
      },
      speculation: {
        enabled: true,
        allowlist_only: false,
        max_candidates: 3,
        min_confidence: 0.7,
        decay_factor: 0.95,
      },
      kv_prep: {
        enabled: false,
        coordinator_endpoint: 'http://localhost:9000',
      },
    },
    qos_monitor: {
      enabled: true,
      slo: {
        target_ttft_ms: 500,
        target_latency_ms: 1000,
        target_error_rate: 0.01,
      },
      evaluator: {
        enabled: true,
        check_interval_ms: 1000,
      },
      executor: {
        enabled: true,
        dry_run: false,
      },
      policy_store: {
        enabled: true,
      },
    },
  } as unknown as Config;

  return { ...baseConfig, ...overrides } as unknown as Config;
}

/**
 * Create test feature flag configuration
 */
export function createTestFeatureFlags(overrides: Partial<FeatureFlagConfig> = {}): FeatureFlagConfig {
  const baseConfig: FeatureFlagConfig = {
    phase4_rollout: {
      enabled: true,
      percentage: 100,
      hash_seed: 'test-seed',
    },
    adaptive_governor: {
      enabled: true,
      rollout_percentage: 100,
      hash_seed: 'test-seed-governor',
    },
    http2_transport: {
      enabled: false,
      rollout_percentage: 0,
      hash_seed: 'test-seed-http2',
    },
    ttft_pipeline: {
      enabled: true,
      rollout_percentage: 100,
      hash_seed: 'test-seed-ttft',
      warmup_queue: { enabled: true },
      speculation: { enabled: true, allowlist_only: false },
      kv_prep: { enabled: false },
    },
    qos_monitor: {
      enabled: true,
      rollout_percentage: 100,
      hash_seed: 'test-seed-qos',
      evaluator: { enabled: true },
      executor: { enabled: true, dry_run: false },
      policy_store: { enabled: true },
    },
    qos_integration: {
      enabled: true,
      rollout_percentage: 100,
      hash_seed: 'test-seed-qos-integration',
    },
    emergency: {
      kill_switch: false,
      rollback_to_baseline: false,
    },
    observability: {
      log_feature_decisions: false,
      export_metrics: false,
      metric_prefix: 'test_',
    },
    config_reload: {
      enabled: false,
      validate_on_reload: true,
      rollback_on_error: true,
    },
  };

  return { ...baseConfig, ...overrides };
}

/**
 * Generate test stream IDs
 */
export function generateStreamId(prefix = 'test-stream'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Generate test request IDs
 */
export function generateRequestId(prefix = 'test-req'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Sleep utility for async tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for event with timeout
 */
export function waitForEvent<T>(
  emitter: EventEmitter,
  eventName: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(eventName, handler);
      reject(new Error(`Timeout waiting for event: ${eventName}`));
    }, timeoutMs);

    const handler = (...args: unknown[]): void => {
      clearTimeout(timeout);
      // If T is a tuple type, return all arguments as an array
      // Otherwise return the first argument
      resolve((args.length === 1 ? args[0] : args) as T);
    };

    emitter.once(eventName, handler);
  });
}
