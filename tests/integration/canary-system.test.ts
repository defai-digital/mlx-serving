/**
 * Integration tests for Canary Deployment System
 *
 * Tests:
 * - Traffic routing with deterministic hashing
 * - 4-stage gradual rollout (10% → 25% → 50% → 100%)
 * - Automated rollback on performance regression
 * - Manual rollback capability
 * - Health monitoring and metrics collection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pino, type Logger } from 'pino';
import {
  CanaryManager,
  CanaryRouter,
  RollbackController,
  MetricsCollector,
  DEFAULT_CANARY_CONFIG,
  DEFAULT_TRIGGERS,
  type CanaryManagerConfig,
  type ComparisonResult,
} from '../../src/canary/index.js';

// Mock Engine interface
interface MockEngine {
  id: string;
  generate: (params: { prompt: string }) => Promise<string>;
  processRequest: (params: any) => Promise<any>;
}

describe('Canary Deployment System - Integration', () => {
  let baselineEngine: MockEngine;
  let canaryEngine: MockEngine;
  let logger: Logger;

  beforeEach(() => {
    // Create mock engines
    baselineEngine = {
      id: 'baseline',
      generate: vi.fn(async (params) => `Baseline response: ${params.prompt}`),
      processRequest: vi.fn(async (params) => ({ ...params, engine: 'baseline' })),
    };

    canaryEngine = {
      id: 'canary',
      generate: vi.fn(async (params) => `Canary response: ${params.prompt}`),
      processRequest: vi.fn(async (params) => ({ ...params, engine: 'canary' })),
    };

    // Create logger
    logger = pino({ level: 'silent' }); // Silent for tests
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('CanaryRouter', () => {
    it('should route 100% traffic to baseline when disabled', () => {
      const router = new CanaryRouter({
        enabled: false,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const results = Array.from({ length: 100 }, (_, i) =>
        router.route(`user${i}`)
      );

      const canaryCount = results.filter((r) => r.variant === 'canary').length;
      expect(canaryCount).toBe(0);
    });

    it('should route approximately correct percentage with hash strategy', () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 25,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const results = Array.from({ length: 1000 }, (_, i) =>
        router.route(`user${i}`)
      );

      const canaryCount = results.filter((r) => r.variant === 'canary').length;
      const actualPercentage = (canaryCount / 1000) * 100;

      // Allow 5% variance
      expect(actualPercentage).toBeGreaterThanOrEqual(20);
      expect(actualPercentage).toBeLessThanOrEqual(30);
    });

    it('should provide deterministic routing for same user', () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const results = Array.from({ length: 10 }, () => router.route('user123'));

      const variants = results.map((r) => r.variant);
      const firstVariant = variants[0];

      // All results should be the same
      expect(variants.every((v) => v === firstVariant)).toBe(true);
    });

    it('should update percentage zero-downtime', () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 10,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      // Route at 10%
      const before = Array.from({ length: 1000 }, (_, i) =>
        router.route(`user${i}`)
      );
      const beforeCanary = before.filter((r) => r.variant === 'canary').length;

      // Update to 50%
      router.updatePercentage(50);

      // Route at 50%
      const after = Array.from({ length: 1000 }, (_, i) =>
        router.route(`user${i + 1000}`)
      );
      const afterCanary = after.filter((r) => r.variant === 'canary').length;

      expect(beforeCanary).toBeLessThan(150); // ~10%
      expect(afterCanary).toBeGreaterThan(400); // ~50%
    });

    it('should cache routing decisions', () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
        enableCache: true,
      });

      // First call - cache miss
      const first = router.route('user123');
      expect(first.cached).toBe(false);

      // Second call - cache hit
      const second = router.route('user123');
      expect(second.cached).toBe(true);
      expect(second.variant).toBe(first.variant);
    });
  });

  describe('MetricsCollector', () => {
    it('should record requests and calculate statistics', () => {
      const collector = new MetricsCollector();

      // Record baseline requests
      collector.recordRequest('baseline', 100, true);
      collector.recordRequest('baseline', 150, true);
      collector.recordRequest('baseline', 200, false, new Error('Test error'));

      // Record canary requests
      collector.recordRequest('canary', 110, true);
      collector.recordRequest('canary', 160, true);

      const baseline = collector.getSnapshot('baseline');
      const canary = collector.getSnapshot('canary');

      expect(baseline.requestCount).toBe(3);
      expect(baseline.successCount).toBe(2);
      expect(baseline.errorCount).toBe(1);
      expect(baseline.errorRate).toBeCloseTo(1 / 3);

      expect(canary.requestCount).toBe(2);
      expect(canary.successCount).toBe(2);
      expect(canary.errorRate).toBe(0);
    });

    it('should calculate percentiles correctly', () => {
      const collector = new MetricsCollector();

      // Record latencies: 100, 200, 300, 400, 500
      for (let i = 1; i <= 5; i++) {
        collector.recordRequest('baseline', i * 100, true);
      }

      const snapshot = collector.getSnapshot('baseline');

      expect(snapshot.latency.p50).toBeCloseTo(300, 0);
      // P95 with 5 samples is at index 3.8, interpolated between 400 and 500
      expect(snapshot.latency.p95).toBeGreaterThanOrEqual(400);
      expect(snapshot.latency.p95).toBeLessThanOrEqual(500);
      expect(snapshot.latency.max).toBe(500);
    });

    it('should compare baseline vs canary health', () => {
      const collector = new MetricsCollector();

      // Baseline: healthy
      for (let i = 0; i < 10; i++) {
        collector.recordRequest('baseline', 100, true);
      }

      // Canary: degraded (high latency)
      for (let i = 0; i < 10; i++) {
        collector.recordRequest('canary', 200, true);
      }

      const comparison = collector.compare();

      expect(comparison.baseline.latency.mean).toBeCloseTo(100);
      expect(comparison.canary.latency.mean).toBeCloseTo(200);
      expect(comparison.deltas.p95LatencyDelta).toBeGreaterThan(0);
      expect(comparison.health.status).toBe('degraded');
    });
  });

  describe('RollbackController', () => {
    it('should trigger rollback on high error rate', async () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const controller = new RollbackController(
        {
          enabled: true,
          triggers: DEFAULT_TRIGGERS,
          cooldownMs: 1000,
          gradual: false,
        },
        router
      );

      // Create comparison with high canary error rate
      const comparison: ComparisonResult = {
        timestamp: Date.now(),
        baseline: {
          timestamp: Date.now(),
          variant: 'baseline',
          requestCount: 100,
          successCount: 99,
          errorCount: 1,
          errorRate: 0.01,
          latency: { mean: 100, p50: 100, p95: 150, p99: 200, max: 250 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        canary: {
          timestamp: Date.now(),
          variant: 'canary',
          requestCount: 100,
          successCount: 70,
          errorCount: 30,
          errorRate: 0.3,
          latency: { mean: 100, p50: 100, p95: 150, p99: 200, max: 250 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        deltas: {
          errorRateDelta: 0.29,
          p95LatencyDelta: 0,
          p95LatencyDeltaPercent: 0,
          memoryGrowthDelta: 0,
        },
        health: {
          status: 'critical',
          issues: ['High error rate'],
          recommendations: ['Consider rollback'],
        },
      };

      const evaluation = await controller.evaluate(comparison);

      expect(evaluation.shouldRollback).toBe(true);
      expect(evaluation.severity).toBe('critical');
      expect(evaluation.triggers).toContain('high_error_rate');
    });

    it('should trigger rollback on high latency', async () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const controller = new RollbackController(
        {
          enabled: true,
          triggers: DEFAULT_TRIGGERS,
          cooldownMs: 1000,
          gradual: false,
        },
        router
      );

      const comparison: ComparisonResult = {
        timestamp: Date.now(),
        baseline: {
          timestamp: Date.now(),
          variant: 'baseline',
          requestCount: 100,
          successCount: 100,
          errorCount: 0,
          errorRate: 0,
          latency: { mean: 100, p50: 100, p95: 100, p99: 100, max: 100 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        canary: {
          timestamp: Date.now(),
          variant: 'canary',
          requestCount: 100,
          successCount: 100,
          errorCount: 0,
          errorRate: 0,
          latency: { mean: 200, p50: 200, p95: 200, p99: 200, max: 200 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        deltas: {
          errorRateDelta: 0,
          p95LatencyDelta: 100,
          p95LatencyDeltaPercent: 100,
          memoryGrowthDelta: 0,
        },
        health: {
          status: 'critical',
          issues: ['High latency'],
          recommendations: ['Consider rollback'],
        },
      };

      const evaluation = await controller.evaluate(comparison);

      expect(evaluation.shouldRollback).toBe(true);
      expect(evaluation.triggers).toContain('high_latency');
    });

    it('should enforce cooldown period', async () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const controller = new RollbackController(
        {
          enabled: true,
          triggers: DEFAULT_TRIGGERS,
          cooldownMs: 10000, // 10 seconds
          gradual: false,
        },
        router
      );

      // Execute first rollback
      await controller.rollback('Test rollback');

      expect(controller.isInCooldown()).toBe(true);
      expect(controller.getCooldownRemaining()).toBeGreaterThan(0);

      // Wait for cooldown
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be in cooldown
      expect(controller.isInCooldown()).toBe(true);
    });

    it('should track rollback history', async () => {
      const router = new CanaryRouter({
        enabled: true,
        rolloutPercentage: 50,
        strategy: 'hash',
        hashKey: 'user_id',
      });

      const controller = new RollbackController(
        {
          enabled: true,
          triggers: DEFAULT_TRIGGERS,
          cooldownMs: 100,
          gradual: false,
        },
        router
      );

      // Execute multiple rollbacks
      await controller.rollback('Rollback 1');
      await new Promise((resolve) => setTimeout(resolve, 150)); // Wait for cooldown
      await controller.rollback('Rollback 2');

      const history = controller.getHistory();

      expect(history.length).toBe(2);
      expect(history[0].trigger).toBe('Rollback 2'); // Most recent first
      expect(history[1].trigger).toBe('Rollback 1');
    });
  });

  describe('CanaryManager - Full Integration', () => {
    it('should initialize with default configuration', () => {
      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        {},
        logger
      );

      const status = manager.getStatus();

      expect(status.stage).toBe('off');
      expect(status.percentage).toBe(0);
      expect(status.health).toBe('healthy');
      expect(status.canAdvance).toBe(false);
    });

    it('should route requests through baseline and canary engines', async () => {
      const config: Partial<CanaryManagerConfig> = {
        ...DEFAULT_CANARY_CONFIG,
        enabled: true,
        initialStage: '50%',
        router: {
          enabled: true,
          rolloutPercentage: 50,
          strategy: 'hash',
          hashKey: 'user_id',
        },
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      // Route 100 requests
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          manager.route(`user${i}`, async (engine, variant) => {
            return { engine: engine.id, variant };
          })
        )
      );

      const canaryCount = results.filter((r) => r.variant === 'canary').length;
      const baselineCount = results.filter((r) => r.variant === 'baseline').length;

      expect(canaryCount + baselineCount).toBe(100);
      // Should be approximately 50/50 (allow variance)
      expect(canaryCount).toBeGreaterThan(30);
      expect(canaryCount).toBeLessThan(70);

      await manager.shutdown();
    });

    it('should advance through stages manually', async () => {
      const config: Partial<CanaryManagerConfig> = {
        enabled: true,
        initialStage: 'off',
        autoAdvance: false,
        minRequestsPerStage: 10,
        minStageWaitMs: 100,
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      expect(manager.getStatus().stage).toBe('off');

      // Process enough requests
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          manager.route(`user${i}`, async (engine) => engine.id)
        )
      );

      // Wait minimum duration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Manual advance to 10%
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('10%');

      // Manual advance to 25%
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('25%');

      // Manual advance to 50%
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('50%');

      // Manual advance to 100%
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('100%');

      const history = manager.getHistory();
      expect(history.length).toBe(4);

      await manager.shutdown();
    });

    it('should rollback on performance regression', async () => {
      const config: Partial<CanaryManagerConfig> = {
        enabled: true,
        initialStage: '25%',
        autoAdvance: false,
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      // Simulate regression
      const comparison: ComparisonResult = {
        timestamp: Date.now(),
        baseline: {
          timestamp: Date.now(),
          variant: 'baseline',
          requestCount: 100,
          successCount: 100,
          errorCount: 0,
          errorRate: 0,
          latency: { mean: 100, p50: 100, p95: 100, p99: 100, max: 100 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        canary: {
          timestamp: Date.now(),
          variant: 'canary',
          requestCount: 100,
          successCount: 50,
          errorCount: 50,
          errorRate: 0.5,
          latency: { mean: 100, p50: 100, p95: 100, p99: 100, max: 100 },
          throughput: { requestsPerSecond: 10 },
          resources: { cpuPercent: 50, memoryMB: 100, memoryGrowthRate: 0 },
        },
        deltas: {
          errorRateDelta: 0.5,
          p95LatencyDelta: 0,
          p95LatencyDeltaPercent: 0,
          memoryGrowthDelta: 0,
        },
        health: {
          status: 'critical',
          issues: ['High error rate'],
          recommendations: ['Rollback immediately'],
        },
      };

      await manager.rollback('Performance regression detected', comparison);

      const status = manager.getStatus();
      expect(status.stage).toBe('off');
      expect(status.percentage).toBe(0);

      const history = manager.getHistory();
      expect(history[0].type).toBe('rollback');
      expect(history[0].reason).toContain('regression');

      await manager.shutdown();
    });

    it('should pause and resume deployment', async () => {
      const config: Partial<CanaryManagerConfig> = {
        enabled: true,
        initialStage: '50%',
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      expect(manager.getStatus().percentage).toBe(50);

      // Pause deployment
      await manager.pause();
      const stats = manager.getRouterStats();
      expect(stats.actualPercentage).toBe(0);

      // Resume deployment
      await manager.resume();
      expect(manager.getStatus().percentage).toBe(50);

      await manager.shutdown();
    });

    it('should reset deployment state', async () => {
      const config: Partial<CanaryManagerConfig> = {
        enabled: true,
        initialStage: '50%',
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      // Process some requests
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          manager.route(`user${i}`, async (engine) => engine.id)
        )
      );

      // Reset
      await manager.reset();

      const status = manager.getStatus();
      expect(status.stage).toBe('off');
      expect(status.percentage).toBe(0);
      expect(status.requestsProcessed).toBe(0);

      await manager.shutdown();
    });
  });

  describe('End-to-End Canary Deployment', () => {
    it('should execute full 4-stage rollout with metrics collection', async () => {
      const config: Partial<CanaryManagerConfig> = {
        enabled: false, // Disable health monitoring to prevent auto-rollback
        initialStage: 'off',
        autoAdvance: false,
        minRequestsPerStage: 20,
        minStageWaitMs: 100,
        healthCheckIntervalMs: 50,
        router: {
          enabled: true, // Keep routing enabled
          rolloutPercentage: 0,
          strategy: 'hash',
          hashKey: 'user_id',
        },
      };

      const manager = new CanaryManager(
        baselineEngine as any,
        canaryEngine as any,
        config,
        logger
      );

      // Verify initial stage
      expect(manager.getStatus().stage).toBe('off');

      // Stage 1: Advance to 10%
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          manager.route(`user${i}`, async (engine) => engine.id)
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('10%');

      // Stage 2: Advance to 25%
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          manager.route(`user${i + 100}`, async (engine) => engine.id)
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('25%');

      // Stage 3: Advance to 50%
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          manager.route(`user${i + 200}`, async (engine) => engine.id)
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('50%');

      // Stage 4: Advance to 100%
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          manager.route(`user${i + 300}`, async (engine) => engine.id)
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await manager.advance(true);
      expect(manager.getStatus().stage).toBe('100%');

      // Verify metrics collection
      const metrics = manager.getMetrics();
      expect(metrics.baseline.requestCount).toBeGreaterThan(0);
      expect(metrics.canary.requestCount).toBeGreaterThan(0);

      // Verify router stats
      const routerStats = manager.getRouterStats();
      expect(routerStats.totalRequests).toBeGreaterThan(0);

      await manager.shutdown();
    });
  });
});
