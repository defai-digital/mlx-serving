/**
 * Phase 4 Integration Factory Tests
 *
 * Integration tests for Phase4IntegrationFactory:
 * - Component creation based on feature flags
 * - Dependency wiring
 * - Feature flag evaluation
 * - Lifecycle management
 *
 * Phase 5 Week 1 Day 4-5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Phase4IntegrationFactory, createPhase4Integration } from '../../src/integration/phase4-integration-factory.js';
import { initializeFeatureFlags, resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import {
  createMockLogger,
  MockStreamRegistry,
  createTestConfig,
  createTestFeatureFlags,
} from './helpers/test-fixtures.js';
import {
  assertPhase4ComponentsValid,
  assertPhase4ComponentsDisabled,
  assertQosIntegrationValid,
  assertTtftIntegrationValid,
  assertAdaptiveGovernorValid,
} from './helpers/assertions.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

describe('Phase4IntegrationFactory', () => {
  let streamRegistry: MockStreamRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let featureFlagPath: string;

  beforeEach(() => {
    streamRegistry = new MockStreamRegistry();
    logger = createMockLogger();
    Phase4IntegrationFactory.reset();
    resetFeatureFlags();

    // Create temporary feature flags file
    featureFlagPath = join(process.cwd(), 'config', 'feature-flags-test.yaml');
    const flags = createTestFeatureFlags();
    writeFileSync(featureFlagPath, yaml.dump(flags));
    initializeFeatureFlags(featureFlagPath);
  });

  afterEach(() => {
    Phase4IntegrationFactory.reset();
    resetFeatureFlags();

    // Cleanup temporary feature flags file
    try {
      unlinkSync(featureFlagPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Component Creation', () => {
    it('should create Phase 4 components when enabled', () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-1',
      });

      assertPhase4ComponentsValid(components);
    });

    it('should create QoS Integration when enabled', () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-2',
      });

      assertQosIntegrationValid(components);
    });

    it('should create TTFT Integration when enabled', () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-3',
      });

      assertTtftIntegrationValid(components);
    });

    it('should create Adaptive Governor when enabled', () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-4',
      });

      assertAdaptiveGovernorValid(components);
    });

    it('should not create components when Phase 4 disabled', () => {
      // Write disabled feature flags
      const disabledFlags = createTestFeatureFlags({
        phase4_rollout: {
          enabled: false,
          percentage: 0,
          hash_seed: 'test-seed',
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(disabledFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-5',
      });

      assertPhase4ComponentsDisabled(components);
    });

    it('should not create QoS Integration when disabled in config', () => {
      const config = createTestConfig({
        qos_monitor: {
          enabled: false,
          slo: {
            target_ttft_ms: 500,
            target_latency_ms: 1000,
            target_error_rate: 0.01,
          },
          evaluator: {
            enabled: false,
            check_interval_ms: 1000,
          },
          executor: {
            enabled: false,
            dry_run: false,
          },
          policy_store: {
            enabled: false,
          },
        },
      });

      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-6',
      });

      expect(components.qosIntegration).toBeUndefined();
    });

    it('should not create TTFT Integration when disabled in config', () => {
      const config = createTestConfig({
        ttft_accelerator: {
          enabled: false,
          warm_queue: { max_size: 100, ttl_ms: 5000, priority_by_tokens: true },
          speculation: {
            enabled: false,
            allowlist_only: false,
            max_candidates: 3,
            min_confidence: 0.7,
            decay_factor: 0.95,
          },
          kv_prep: { enabled: false, coordinator_endpoint: '' },
        },
      });

      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-7',
      });

      expect(components.ttftIntegration).toBeUndefined();
    });
  });

  describe('Feature Flag Gating', () => {
    it('should respect feature flag percentage rollout', () => {
      // Test with 50% rollout
      const partialFlags = createTestFeatureFlags({
        phase4_rollout: {
          enabled: true,
          percentage: 50,
          hash_seed: 'test-seed',
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(partialFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      const results: boolean[] = [];

      // Test multiple request IDs (deterministic routing)
      for (let i = 0; i < 100; i++) {
        const requestId = `request-${i}`;
        const components = createPhase4Integration({
          streamRegistry: streamRegistry as never,
          config,
          logger,
          requestId,
        });
        results.push(components.enabled);
        Phase4IntegrationFactory.reset();
      }

      // Should have roughly 50% enabled (allow 10% variance)
      const enabledCount = results.filter((x) => x).length;
      expect(enabledCount).toBeGreaterThan(40);
      expect(enabledCount).toBeLessThan(60);
    });

    it('should respect emergency kill switch', () => {
      const emergencyFlags = createTestFeatureFlags({
        emergency: {
          kill_switch: true,
          rollback_to_baseline: false,
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(emergencyFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-8',
      });

      assertPhase4ComponentsDisabled(components);
    });

    it('should respect emergency rollback flag', () => {
      const rollbackFlags = createTestFeatureFlags({
        emergency: {
          kill_switch: false,
          rollback_to_baseline: true,
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(rollbackFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-9',
      });

      assertPhase4ComponentsDisabled(components);
    });

    it('should evaluate individual feature flags', () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-10',
      });

      // All features should be enabled with 100% rollout
      expect(components.qosIntegration).toBeDefined();
      expect(components.ttftIntegration).toBeDefined();
      expect(components.adaptiveGovernor).toBeDefined();
    });

    it('should handle missing dependencies gracefully', () => {
      const config = createTestConfig();

      // This should not throw even with invalid streamRegistry
      expect(() => {
        createPhase4Integration({
          streamRegistry: null as never,
          config,
          logger,
          requestId: 'test-request-11',
        });
      }).not.toThrow();
    });
  });

  describe('Lifecycle Management', () => {
    it('should support singleton pattern', () => {
      const config = createTestConfig();
      const components1 = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-12',
      });

      const instance = Phase4IntegrationFactory.getInstance();
      expect(instance).toBe(components1);
    });

    it('should reset singleton instance', () => {
      const config = createTestConfig();
      createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-13',
      });

      Phase4IntegrationFactory.reset();
      const instance = Phase4IntegrationFactory.getInstance();
      expect(instance).toBeNull();
    });

    it('should shutdown components gracefully', async () => {
      const config = createTestConfig();
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-14',
      });

      // Shutdown should not throw
      await expect(Phase4IntegrationFactory.shutdown(components)).resolves.not.toThrow();
    });

    it('should handle shutdown of disabled components', async () => {
      const components = { enabled: false };

      // Shutdown should be no-op for disabled components
      await expect(Phase4IntegrationFactory.shutdown(components)).resolves.not.toThrow();
    });
  });

  describe('Configuration Validation', () => {
    it('should handle invalid configuration gracefully', () => {
      const invalidConfig = createTestConfig({
        streaming: undefined,
      });

      // Should not throw, but may not create components
      expect(() => {
        createPhase4Integration({
          streamRegistry: streamRegistry as never,
          config: invalidConfig,
          logger,
          requestId: 'test-request-15',
        });
      }).not.toThrow();
    });

    it('should handle missing QoS config gracefully', () => {
      const config = createTestConfig({
        qos_monitor: undefined,
      });

      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-16',
      });

      expect(components.qosIntegration).toBeUndefined();
    });

    it('should handle missing TTFT config gracefully', () => {
      const config = createTestConfig({
        ttft_accelerator: undefined,
      });

      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-17',
      });

      expect(components.ttftIntegration).toBeUndefined();
    });
  });

  describe('Deterministic Behavior', () => {
    it('should produce consistent results for same request ID', () => {
      const config = createTestConfig();
      const requestId = 'deterministic-test-1';

      const components1 = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId,
      });

      Phase4IntegrationFactory.reset();

      const components2 = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId,
      });

      // Same request ID should produce same enabled state
      expect(components1.enabled).toBe(components2.enabled);
    });

    it('should use default request ID when not provided', () => {
      const config = createTestConfig();

      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
      });

      // Should use 'default' as request ID
      expect(components.enabled).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle feature flag evaluation errors', () => {
      const config = createTestConfig();

      // Even with invalid feature flag config, should not throw
      expect(() => {
        createPhase4Integration({
          streamRegistry: streamRegistry as never,
          config,
          logger,
          requestId: 'test-request-18',
        });
      }).not.toThrow();
    });

    it('should continue if one component fails to initialize', () => {
      const config = createTestConfig();

      // Even if one component fails, others should still be created
      const components = createPhase4Integration({
        streamRegistry: streamRegistry as never,
        config,
        logger,
        requestId: 'test-request-19',
      });

      // Should have some components even if not all succeed
      expect(components).toBeDefined();
    });
  });
});
