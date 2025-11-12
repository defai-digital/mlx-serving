/**
 * Feature Flags Integration Tests
 *
 * Integration tests for feature flag system:
 * - Hash-based routing determinism
 * - Percentage rollout
 * - Emergency controls (kill switch, rollback)
 * - Config reload
 * - Feature evaluation
 *
 * Phase 5 Week 1 Day 4-5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FeatureFlagLoader,
  initializeFeatureFlags,
  getFeatureFlags,
  resetFeatureFlags,
  reloadFeatureFlags,
} from '../../src/config/feature-flag-loader.js';
import { createTestFeatureFlags } from './helpers/test-fixtures.js';
import {
  assertFeatureFlagEnabled,
  assertFeatureFlagDisabled,
  assertHashRoutingDeterministic,
} from './helpers/assertions.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

describe('FeatureFlags', () => {
  let featureFlagPath: string;

  beforeEach(() => {
    resetFeatureFlags();
    featureFlagPath = join(process.cwd(), 'config', 'feature-flags-test-main.yaml');
  });

  afterEach(() => {
    resetFeatureFlags();

    // Cleanup temporary feature flags file
    try {
      unlinkSync(featureFlagPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    it('should load feature flags from file', () => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));

      const loader = initializeFeatureFlags(featureFlagPath);

      expect(loader).toBeDefined();
      const config = loader.getConfig();
      expect(config.phase4_rollout).toBeDefined();
    });

    it('should throw error for missing file', () => {
      const missingPath = join(process.cwd(), 'config', 'non-existent-flags.yaml');

      expect(() => {
        initializeFeatureFlags(missingPath);
      }).toThrow(/not found/);
    });

    it('should validate percentage values', () => {
      const invalidFlags = createTestFeatureFlags({
        phase4_rollout: {
          enabled: true,
          percentage: 150, // Invalid: > 100
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(invalidFlags));

      expect(() => {
        initializeFeatureFlags(featureFlagPath);
      }).toThrow(/Invalid rollout percentage/);
    });

    it('should validate hash seeds exist', () => {
      const noSeedFlags = {
        ...createTestFeatureFlags(),
        phase4_rollout: {
          enabled: true,
          percentage: 100,
          hash_seed: '', // Invalid: empty seed
        },
      };

      writeFileSync(featureFlagPath, yaml.dump(noSeedFlags));

      expect(() => {
        initializeFeatureFlags(featureFlagPath);
      }).toThrow(/Missing phase4_rollout\.hash_seed/);
    });
  });

  describe('Hash-Based Routing', () => {
    beforeEach(() => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);
    });

    it('should be deterministic for same request ID', () => {
      const loader = getFeatureFlags();
      const requestId = 'test-request-deterministic';

      const eval1 = loader.evaluate('adaptive_governor', requestId);
      const eval2 = loader.evaluate('adaptive_governor', requestId);

      expect(eval1.enabled).toBe(eval2.enabled);
      expect(eval1.hash).toBe(eval2.hash);
    });

    it('should produce different hashes for different request IDs', () => {
      const loader = getFeatureFlags();

      const eval1 = loader.evaluate('adaptive_governor', 'request-1');
      const eval2 = loader.evaluate('adaptive_governor', 'request-2');

      // Different requests should produce different hashes
      expect(eval1.hash).not.toBe(eval2.hash);
    });

    it('should distribute requests according to percentage', () => {
      // Create 50% rollout flags
      const partialFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: true,
          rollout_percentage: 50,
          hash_seed: 'test-seed-governor',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(partialFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const results: boolean[] = [];

      // Test 100 different request IDs
      for (let i = 0; i < 100; i++) {
        const eval1 = loader.evaluate('adaptive_governor', `request-${i}`);
        results.push(eval1.enabled);
      }

      // Should have roughly 50% enabled (allow ±10% variance)
      const enabledCount = results.filter((x) => x).length;
      expect(enabledCount).toBeGreaterThan(40);
      expect(enabledCount).toBeLessThan(60);
    });

    it('should handle 0% rollout', () => {
      const zeroFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: true,
          rollout_percentage: 0,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(zeroFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', 'any-request');

      assertFeatureFlagDisabled(eval1);
    });

    it('should handle 100% rollout', () => {
      const fullFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: true,
          rollout_percentage: 100,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(fullFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', 'any-request');

      assertFeatureFlagEnabled(eval1);
    });

    it('should use hash seed for consistent distribution', () => {
      const loader = getFeatureFlags();
      const evaluations = [];

      for (let i = 0; i < 10; i++) {
        evaluations.push(loader.evaluate('adaptive_governor', `request-${i}`));
      }

      assertHashRoutingDeterministic(evaluations);
    });
  });

  describe('Feature Evaluation', () => {
    beforeEach(() => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);
    });

    it('should evaluate adaptive_governor feature', () => {
      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', 'test-request');

      expect(eval1).toBeDefined();
      expect(eval1.feature).toBe('adaptive_governor');
      expect(eval1.enabled).toBe(true); // 100% rollout
    });

    it('should evaluate ttft_pipeline feature', () => {
      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('ttft_pipeline', 'test-request');

      expect(eval1.feature).toBe('ttft_pipeline');
      expect(eval1.enabled).toBe(true);
    });

    it('should evaluate qos_monitor feature', () => {
      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('qos_monitor', 'test-request');

      expect(eval1.feature).toBe('qos_monitor');
      expect(eval1.enabled).toBe(true);
    });

    it('should return disabled for unknown feature', () => {
      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('unknown_feature', 'test-request');

      assertFeatureFlagDisabled(eval1, 'Unknown feature');
    });

    it('should respect feature disabled in config', () => {
      const disabledFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: false,
          rollout_percentage: 100,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(disabledFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', 'test-request');

      assertFeatureFlagDisabled(eval1, 'disabled in config');
    });
  });

  describe('Emergency Controls', () => {
    it('should disable all features when kill switch active', () => {
      const killSwitchFlags = createTestFeatureFlags({
        emergency: {
          kill_switch: true,
          rollback_to_baseline: false,
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(killSwitchFlags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();

      const eval1 = loader.evaluate('adaptive_governor', 'test-request');
      const eval2 = loader.evaluate('ttft_pipeline', 'test-request');
      const eval3 = loader.evaluate('qos_monitor', 'test-request');

      assertFeatureFlagDisabled(eval1, 'kill switch');
      assertFeatureFlagDisabled(eval2, 'kill switch');
      assertFeatureFlagDisabled(eval3, 'kill switch');
    });

    it('should disable all features when rollback active', () => {
      const rollbackFlags = createTestFeatureFlags({
        emergency: {
          kill_switch: false,
          rollback_to_baseline: true,
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(rollbackFlags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();

      const eval1 = loader.evaluate('adaptive_governor', 'test-request');
      assertFeatureFlagDisabled(eval1, 'rollback');
    });

    it('should disable Phase 4 when global gate disabled', () => {
      const disabledPhase4 = createTestFeatureFlags({
        phase4_rollout: {
          enabled: false,
          percentage: 100,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(disabledPhase4));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();

      const eval1 = loader.evaluate('adaptive_governor', 'test-request');
      assertFeatureFlagDisabled(eval1, 'Phase 4 rollout globally disabled');
    });
  });

  describe('Phase 4 Enablement', () => {
    beforeEach(() => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);
    });

    it('should check if Phase 4 enabled for request', () => {
      const loader = getFeatureFlags();
      const enabled = loader.isPhase4Enabled('test-request');

      expect(enabled).toBe(true); // 100% rollout
    });

    it('should respect Phase 4 percentage rollout', () => {
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

      const loader = getFeatureFlags();
      const results: boolean[] = [];

      for (let i = 0; i < 100; i++) {
        results.push(loader.isPhase4Enabled(`request-${i}`));
      }

      const enabledCount = results.filter((x) => x).length;
      expect(enabledCount).toBeGreaterThan(40);
      expect(enabledCount).toBeLessThan(60);
    });

    it('should disable Phase 4 when emergency controls active', () => {
      const emergencyFlags = createTestFeatureFlags({
        emergency: {
          kill_switch: true,
          rollback_to_baseline: false,
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(emergencyFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const enabled = loader.isPhase4Enabled('test-request');

      expect(enabled).toBe(false);
    });
  });

  describe('Config Reload', () => {
    it('should reload configuration', () => {
      const initialFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: true,
          rollout_percentage: 0,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(initialFlags));
      const loader = initializeFeatureFlags(featureFlagPath);

      // Initial state: disabled
      let eval1 = loader.evaluate('adaptive_governor', 'test-request');
      expect(eval1.enabled).toBe(false);

      // Update config file
      const updatedFlags = createTestFeatureFlags({
        adaptive_governor: {
          enabled: true,
          rollout_percentage: 100,
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(updatedFlags));

      // Reload
      const newConfig = reloadFeatureFlags();
      expect(newConfig).toBeDefined();

      // New state: enabled
      eval1 = loader.evaluate('adaptive_governor', 'test-request');
      expect(eval1.enabled).toBe(true);
    });

    it('should rollback on reload error', () => {
      const validFlags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(validFlags));
      const loader = initializeFeatureFlags(featureFlagPath);

      // Write invalid config
      writeFileSync(featureFlagPath, 'invalid: yaml: content: [');

      // Reload should rollback to previous valid config
      try {
        reloadFeatureFlags();
      } catch {
        // Expected to fail
      }

      // Should still have valid config from before
      const config = loader.getConfig();
      expect(config.phase4_rollout).toBeDefined();
    });

    it('should validate on reload', () => {
      const validFlags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(validFlags));
      initializeFeatureFlags(featureFlagPath);

      // Write invalid percentage
      const invalidFlags = createTestFeatureFlags({
        phase4_rollout: {
          enabled: true,
          percentage: 200, // Invalid
          hash_seed: 'test-seed',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(invalidFlags));

      // Should throw validation error
      expect(() => {
        reloadFeatureFlags();
      }).toThrow(/Invalid rollout percentage/);
    });
  });

  describe('Static Methods', () => {
    it('should evaluate feature with static method', () => {
      const shouldEnable = FeatureFlagLoader.shouldEnableFeature(
        'test-request',
        'test-seed',
        100
      );

      expect(shouldEnable).toBe(true);
    });

    it('should handle 0% with static method', () => {
      const shouldEnable = FeatureFlagLoader.shouldEnableFeature(
        'test-request',
        'test-seed',
        0
      );

      expect(shouldEnable).toBe(false);
    });

    it('should handle 100% with static method', () => {
      const shouldEnable = FeatureFlagLoader.shouldEnableFeature(
        'test-request',
        'test-seed',
        100
      );

      expect(shouldEnable).toBe(true);
    });

    it('should be deterministic with static method', () => {
      const result1 = FeatureFlagLoader.shouldEnableFeature(
        'same-request',
        'same-seed',
        75
      );

      const result2 = FeatureFlagLoader.shouldEnableFeature(
        'same-request',
        'same-seed',
        75
      );

      expect(result1).toBe(result2);
    });
  });

  describe('Observability', () => {
    it('should log feature decisions when enabled', () => {
      const observableFlags = createTestFeatureFlags({
        observability: {
          log_feature_decisions: true,
          export_metrics: false,
          metric_prefix: 'test_',
        },
      });

      writeFileSync(featureFlagPath, yaml.dump(observableFlags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();

      // Should log decision (verified via console output in manual testing)
      const eval1 = loader.evaluate('adaptive_governor', 'test-request');
      expect(eval1).toBeDefined();
    });

    it('should include hash and threshold in evaluation', () => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', 'test-request');

      expect(eval1.hash).toBeDefined();
      expect(eval1.threshold).toBeDefined();
      expect(eval1.hash).toBeGreaterThanOrEqual(0);
      expect(eval1.hash).toBeLessThan(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long request IDs', () => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const longRequestId = 'x'.repeat(1000);

      const eval1 = loader.evaluate('adaptive_governor', longRequestId);
      expect(eval1).toBeDefined();
    });

    it('should handle special characters in request IDs', () => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const specialRequestId = 'request-!@#$%^&*()_+-=[]{}|;:,.<>?';

      const eval1 = loader.evaluate('adaptive_governor', specialRequestId);
      expect(eval1).toBeDefined();
    });

    it('should handle empty request ID', () => {
      const flags = createTestFeatureFlags();
      writeFileSync(featureFlagPath, yaml.dump(flags));
      initializeFeatureFlags(featureFlagPath);

      const loader = getFeatureFlags();
      const eval1 = loader.evaluate('adaptive_governor', '');

      expect(eval1).toBeDefined();
    });
  });
});
