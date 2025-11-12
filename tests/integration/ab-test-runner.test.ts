/**
 * A/B Test Runner Integration Tests
 *
 * Tests the complete A/B testing workflow with real engines.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine, type Engine } from '../../src/api/engine.js';
import {
  ABTestRunner,
  createTestWorkload,
  saveTestResults,
  loadTestWorkload,
  type ABTestConfig,
} from '../../src/testing/index.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('ABTestRunner Integration', () => {
  let baselineEngine: Engine;
  let variantEngine: Engine;
  const testModel = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  const tmpDir = 'automatosx/tmp/ab-test-integration';

  beforeAll(async () => {
    // Create temp directory
    if (!existsSync(tmpDir)) {
      await mkdir(tmpDir, { recursive: true });
    }

    // Initialize engines
    baselineEngine = await createEngine();
    variantEngine = await createEngine();

    // Load models
    await baselineEngine.loadModel({ model: testModel });
    await variantEngine.loadModel({ model: testModel });
  }, 120000); // 2 minute timeout for model loading

  afterAll(async () => {
    await baselineEngine.shutdown();
    await variantEngine.shutdown();
  });

  it('should create test workload from prompts', () => {
    const prompts = ['Hello', 'World', 'Test'];
    const workload = createTestWorkload(testModel, prompts, {
      maxTokens: 50,
      temperature: 0.7,
    });

    expect(workload).toHaveLength(3);
    expect(workload[0]).toMatchObject({
      id: 'test-1',
      prompt: 'Hello',
      model: testModel,
      maxTokens: 50,
      temperature: 0.7,
    });
  });

  it('should run A/B test with minimal workload', async () => {
    const prompts = [
      'What is 2+2?',
      'Explain TypeScript.',
      'What is MLX?',
      'Describe Python.',
      'What is Node.js?',
      'Explain async/await.',
      'What is a Promise?',
      'Describe REST API.',
      'What is JSON?',
      'Explain GraphQL.',
      'What is Docker?',
      'Describe Kubernetes.',
      'What is CI/CD?',
      'Explain Git.',
      'What is testing?',
      'Describe debugging.',
      'What is profiling?',
      'Explain caching.',
      'What is batching?',
      'Describe streaming.',
      'What is HTTP/2?',
      'Explain WebSocket.',
      'What is TLS?',
      'Describe OAuth.',
      'What is JWT?',
      'Explain CORS.',
      'What is CSP?',
      'Describe XSS.',
      'What is CSRF?',
      'Explain SQL injection.',
    ];

    const workload = createTestWorkload(testModel, prompts, {
      maxTokens: 20,
      temperature: 0.7,
    });

    const config: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      minSampleSize: 30,
      confidenceLevel: 0.95,
      alpha: 0.05,
      concurrent: false,
      warmupRuns: 0, // Skip warmup for faster test
      timeoutMs: 30000,
      verbose: false,
    };

    const runner = new ABTestRunner(config);
    const results = await runner.run();

    // Validate results structure
    expect(results).toBeDefined();
    expect(results.timestamp).toBeDefined();
    expect(results.testDurationMs).toBeGreaterThan(0);
    expect(results.totalTestCases).toBe(30);

    // Validate baseline metrics
    expect(results.baseline.metrics.totalRequests).toBe(30);
    expect(results.baseline.metrics.successfulRequests).toBeGreaterThan(0);
    expect(results.baseline.metrics.successRate).toBeGreaterThan(0);
    expect(results.baseline.metrics.latency.mean).toBeGreaterThan(0);
    expect(results.baseline.metrics.ttft.mean).toBeGreaterThan(0);
    expect(results.baseline.metrics.throughput.mean).toBeGreaterThan(0);

    // Validate variant metrics
    expect(results.variant.metrics.totalRequests).toBe(30);
    expect(results.variant.metrics.successfulRequests).toBeGreaterThan(0);
    expect(results.variant.metrics.successRate).toBeGreaterThan(0);
    expect(results.variant.metrics.latency.mean).toBeGreaterThan(0);
    expect(results.variant.metrics.ttft.mean).toBeGreaterThan(0);
    expect(results.variant.metrics.throughput.mean).toBeGreaterThan(0);

    // Validate statistical comparison
    expect(results.comparison.throughput).toBeDefined();
    expect(results.comparison.throughput.improvement).toBeDefined();
    expect(results.comparison.throughput.tTest).toBeDefined();
    expect(results.comparison.throughput.tTest.pValue).toBeGreaterThanOrEqual(0);
    expect(results.comparison.throughput.tTest.pValue).toBeLessThanOrEqual(1);
    expect(results.comparison.throughput.effectSize).toBeDefined();

    expect(results.comparison.ttft).toBeDefined();
    expect(results.comparison.latency).toBeDefined();

    // Validate decision
    expect(results.decision).toBeDefined();
    expect(results.decision.recommendation).toMatch(/^(go|no-go|inconclusive)$/);
    expect(results.decision.reasons).toBeInstanceOf(Array);
    expect(results.decision.reasons.length).toBeGreaterThan(0);
    expect(results.decision.confidenceLevel).toBe(0.95);

    // Since we're testing the same engine against itself, results should be inconclusive
    // (no significant difference expected)
    expect(results.decision.recommendation).toBe('inconclusive');
  }, 180000); // 3 minute timeout

  it('should save and load test results', async () => {
    const prompts = Array.from({ length: 30 }, (_, i) => `Test prompt ${i + 1}`);
    const workload = createTestWorkload(testModel, prompts, {
      maxTokens: 10,
      temperature: 0.7,
    });

    const config: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      minSampleSize: 30,
      confidenceLevel: 0.95,
      warmupRuns: 0,
      verbose: false,
    };

    const runner = new ABTestRunner(config);
    const results = await runner.run();

    // Save results
    const resultsPath = join(tmpDir, 'test-results.json');
    await saveTestResults(resultsPath, results);
    expect(existsSync(resultsPath)).toBe(true);

    // Load and verify
    const loadedContent = await readFile(resultsPath, 'utf-8');
    const loadedResults = JSON.parse(loadedContent);
    expect(loadedResults.timestamp).toBe(results.timestamp);
    expect(loadedResults.totalTestCases).toBe(results.totalTestCases);
  }, 120000);

  it('should save and load test workload', async () => {
    const prompts = ['Test 1', 'Test 2', 'Test 3'];
    const workload = createTestWorkload(testModel, prompts);

    // Save workload
    const workloadPath = join(tmpDir, 'test-workload.json');
    await writeFile(workloadPath, JSON.stringify(workload, null, 2), 'utf-8');

    // Load workload
    const loadedWorkload = await loadTestWorkload(workloadPath);
    expect(loadedWorkload).toHaveLength(3);
    expect(loadedWorkload[0].prompt).toBe('Test 1');
  });

  it('should handle validation errors', () => {
    const prompts = ['Test']; // Only 1 test case (< minSampleSize)
    const workload = createTestWorkload(testModel, prompts);

    const config: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      minSampleSize: 30,
    };

    expect(() => new ABTestRunner(config)).toThrow('Test workload must have at least 30 test cases');
  });

  it('should validate confidence level', () => {
    const prompts = Array.from({ length: 30 }, (_, i) => `Test ${i}`);
    const workload = createTestWorkload(testModel, prompts);

    const config: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      confidenceLevel: 1.5, // Invalid
    };

    expect(() => new ABTestRunner(config)).toThrow('Confidence level must be between 0 and 1');
  });

  it('should validate alpha', () => {
    const prompts = Array.from({ length: 30 }, (_, i) => `Test ${i}`);
    const workload = createTestWorkload(testModel, prompts);

    const config: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      alpha: -0.05, // Invalid
    };

    expect(() => new ABTestRunner(config)).toThrow('Alpha must be between 0 and 1');
  });

  it('should handle different confidence levels', async () => {
    const prompts = Array.from({ length: 30 }, (_, i) => `Prompt ${i + 1}`);
    const workload = createTestWorkload(testModel, prompts, { maxTokens: 10 });

    // Test with 99% confidence
    const config99: ABTestConfig = {
      baselineEngine,
      variantEngine,
      testWorkload: workload,
      confidenceLevel: 0.99,
      warmupRuns: 0,
      verbose: false,
    };

    const runner99 = new ABTestRunner(config99);
    const results99 = await runner99.run();

    expect(results99.decision.confidenceLevel).toBe(0.99);
    expect(results99.comparison.throughput.tTest.confidenceLevel).toBe(0.99);

    // 99% CI should be wider than 95% CI
    const [lower99, upper99] = results99.comparison.throughput.tTest.confidenceInterval;
    expect(upper99 - lower99).toBeGreaterThan(0);
  }, 120000);
});
