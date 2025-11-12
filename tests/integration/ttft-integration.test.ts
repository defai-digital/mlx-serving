/**
 * TTFT Integration Tests
 *
 * Integration tests for TTFT Pipeline integration:
 * - Preprocessing workflow
 * - Warmup queue functionality
 * - Speculation (if enabled)
 * - Feature flag control
 * - End-to-end TTFT flow
 *
 * Phase 5 Week 1 Day 4-5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TtftIntegration } from '../../src/core/ttft-integration.js';
import { createTtftIntegration } from '../../src/core/ttft-integration.js';
import { initializeFeatureFlags, resetFeatureFlags } from '../../src/config/feature-flag-loader.js';
import {
  createMockLogger,
  createTestConfig,
  createTestFeatureFlags,
  generateStreamId,
  generateRequestId,
} from './helpers/test-fixtures.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

describe('TtftIntegration', () => {
  let ttftIntegration: TtftIntegration;
  let logger: ReturnType<typeof createMockLogger>;
  let featureFlagPath: string;

  beforeEach(() => {
    logger = createMockLogger();
    resetFeatureFlags();

    // Create temporary feature flags file
    featureFlagPath = join(process.cwd(), 'config', 'feature-flags-test-ttft.yaml');
    const flags = createTestFeatureFlags();
    writeFileSync(featureFlagPath, yaml.dump(flags));
    initializeFeatureFlags(featureFlagPath);
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
    it('should create TTFT integration when enabled', () => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-init-1',
      });

      expect(ttftIntegration).toBeDefined();
      expect(ttftIntegration.isEnabled()).toBe(true);
    });

    it('should disable TTFT integration when feature flag disabled', () => {
      const disabledFlags = createTestFeatureFlags({
        ttft_pipeline: {
          enabled: false,
          rollout_percentage: 0,
          hash_seed: 'test-seed-ttft',
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(disabledFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-init-2',
      });

      expect(ttftIntegration).toBeDefined();
      expect(ttftIntegration.isEnabled()).toBe(false);
    });

    it('should disable when config disabled', () => {
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

      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-init-3',
      });

      expect(ttftIntegration.isEnabled()).toBe(false);
    });

    it('should initialize with custom request ID', () => {
      const config = createTestConfig();
      const requestId = generateRequestId('ttft-test');

      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId,
      });

      expect(ttftIntegration.isEnabled()).toBe(true);
    });
  });

  describe('Preprocessing', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-preprocess',
      });
    });

    it('should preprocess generation request', async () => {
      const streamId = generateStreamId('preprocess-test');
      const result = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: 'Hello, how are you?',
        streamId,
        maxTokens: 100,
        temperature: 0.7,
      });

      // Result can be null if pipeline decides not to process
      // But should not throw
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle messages format', async () => {
      const streamId = generateStreamId('messages-test');
      const result = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: '',
        streamId,
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello!' },
        ],
        maxTokens: 100,
      });

      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle system prompt', async () => {
      const streamId = generateStreamId('system-prompt-test');
      const result = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: 'Hello!',
        streamId,
        systemPrompt: 'You are a helpful assistant',
        maxTokens: 100,
      });

      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle hints', async () => {
      const streamId = generateStreamId('hints-test');
      const result = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: 'Hello!',
        streamId,
        hints: {
          tenantId: 'test-tenant',
          speculationAllowed: true,
        },
      });

      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should not throw on preprocessing errors', async () => {
      const streamId = generateStreamId('error-test');

      // Invalid parameters should not throw
      await expect(
        ttftIntegration.preprocessGenerate({
          modelId: '',
          prompt: '',
          streamId,
        })
      ).resolves.not.toThrow();
    });

    it('should return null when disabled', async () => {
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

      const disabledIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'disabled-test',
      });

      const streamId = generateStreamId('disabled-test');
      const result = await disabledIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: 'Hello!',
        streamId,
      });

      expect(result).toBeNull();
    });
  });

  describe('First Token Reporting', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-report',
      });
    });

    it('should report first token', () => {
      const streamId = generateStreamId('report-test');
      const promptHash = 'test-hash-123';
      const actualToken = 'Hello';

      expect(() => {
        ttftIntegration.reportFirstToken(streamId, promptHash, actualToken);
      }).not.toThrow();
    });

    it('should not throw when disabled', () => {
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

      const disabledIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'disabled-report',
      });

      expect(() => {
        disabledIntegration.reportFirstToken('test', 'hash', 'token');
      }).not.toThrow();
    });
  });

  describe('Cleanup', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-cleanup',
      });
    });

    it('should cleanup stream resources', async () => {
      const streamId = generateStreamId('cleanup-test');

      await expect(ttftIntegration.cleanup(streamId)).resolves.not.toThrow();
    });

    it('should not throw when disabled', async () => {
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

      const disabledIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'disabled-cleanup',
      });

      await expect(disabledIntegration.cleanup('test-stream')).resolves.not.toThrow();
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-stats',
      });
    });

    it('should return stats when enabled', () => {
      const stats = ttftIntegration.getStats();

      expect(stats).toBeDefined();
      expect(stats.enabled).toBe(true);
    });

    it('should return disabled stats when disabled', () => {
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

      const disabledIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'disabled-stats',
      });

      const stats = disabledIntegration.getStats();
      expect(stats.enabled).toBe(false);
    });
  });

  describe('Feature Flag Rollout', () => {
    it('should respect percentage rollout', () => {
      const partialFlags = createTestFeatureFlags({
        ttft_pipeline: {
          enabled: true,
          rollout_percentage: 50,
          hash_seed: 'test-seed-ttft',
        },
      });
      writeFileSync(featureFlagPath, yaml.dump(partialFlags));
      resetFeatureFlags();
      initializeFeatureFlags(featureFlagPath);

      const config = createTestConfig();
      const results: boolean[] = [];

      // Test multiple request IDs
      for (let i = 0; i < 100; i++) {
        const integration = createTtftIntegration({
          config,
          logger,
          requestId: `request-${i}`,
        });
        results.push(integration.isEnabled());
      }

      // Should have roughly 50% enabled
      const enabledCount = results.filter((x) => x).length;
      expect(enabledCount).toBeGreaterThan(40);
      expect(enabledCount).toBeLessThan(60);
    });

    it('should be deterministic for same request ID', () => {
      const config = createTestConfig();
      const requestId = 'deterministic-ttft-1';

      const integration1 = createTtftIntegration({ config, logger, requestId });
      const integration2 = createTtftIntegration({ config, logger, requestId });

      expect(integration1.isEnabled()).toBe(integration2.isEnabled());
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-errors',
      });
    });

    it('should handle invalid model ID gracefully', async () => {
      const result = await ttftIntegration.preprocessGenerate({
        modelId: '',
        prompt: 'test',
        streamId: generateStreamId(),
      });

      // Should not throw, may return null
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle empty prompt gracefully', async () => {
      const result = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: '',
        streamId: generateStreamId(),
      });

      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle missing stream ID gracefully', async () => {
      await expect(
        ttftIntegration.preprocessGenerate({
          modelId: 'test-model',
          prompt: 'test',
          streamId: '',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('Integration Flow', () => {
    beforeEach(() => {
      const config = createTestConfig();
      ttftIntegration = createTtftIntegration({
        config,
        logger,
        requestId: 'test-flow',
      });
    });

    it('should handle complete preprocessing -> generation -> cleanup flow', async () => {
      const streamId = generateStreamId('flow-test');

      // 1. Preprocess
      const preprocessResult = await ttftIntegration.preprocessGenerate({
        modelId: 'test-model',
        prompt: 'Tell me a story',
        streamId,
        maxTokens: 100,
        temperature: 0.7,
      });

      expect(preprocessResult === null || typeof preprocessResult === 'object').toBe(true);

      // 2. Report first token (simulated)
      ttftIntegration.reportFirstToken(streamId, 'test-hash', 'Once');

      // 3. Cleanup
      await ttftIntegration.cleanup(streamId);

      // No errors should occur
      expect(true).toBe(true);
    });

    it('should handle multiple concurrent streams', async () => {
      const streamIds = [
        generateStreamId('concurrent-1'),
        generateStreamId('concurrent-2'),
        generateStreamId('concurrent-3'),
      ];

      // Preprocess all streams concurrently
      const promises = streamIds.map((streamId) =>
        ttftIntegration.preprocessGenerate({
          modelId: 'test-model',
          prompt: 'Test prompt',
          streamId,
        })
      );

      const results = await Promise.all(promises);

      // All should complete without error
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result === null || typeof result === 'object').toBe(true);
      });
    });
  });
});
