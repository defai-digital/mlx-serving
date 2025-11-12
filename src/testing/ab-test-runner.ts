/**
 * A/B Test Runner for Performance Comparison
 *
 * Executes parallel A/B tests with statistical validation:
 * - Runs baseline and variant engines on identical workloads
 * - Collects performance metrics (throughput, TTFT, P95/P99)
 * - Performs statistical significance testing (t-test)
 * - Calculates confidence intervals (95%, 99%)
 * - Provides clear go/no-go criteria
 *
 * Week 2: A/B Testing Framework
 */

import { safeDivide } from '@/utils/math-helpers.js';
import type { Engine, GeneratorParams } from '../types/index.js';
import {
  calculateSampleStatistics,
  welchTTest,
  calculateEffectSize,

  formatPValue,

  type SampleStatistics,
  type WelchTTestResult,
  type EffectSize,
} from './statistical-analysis.js';

/**
 * Test case for A/B testing
 */
export interface TestCase {
  id: string;
  prompt: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  expectedMinTokens?: number;
}

/**
 * Performance metrics for a single request
 */
export interface RequestMetrics {
  testCaseId: string;
  ttftMs: number;
  latencyMs: number;
  tokensGenerated: number;
  tokensPerSecond: number;
  success: boolean;
  error?: string;
}

/**
 * Aggregated performance metrics
 */
export interface PerformanceMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;

  // Latency statistics
  latency: SampleStatistics;

  // TTFT statistics
  ttft: SampleStatistics;

  // Throughput statistics
  throughput: SampleStatistics;

  // Token statistics
  totalTokens: number;
  avgTokensPerRequest: number;
}

/**
 * A/B test configuration
 */
export interface ABTestConfig {
  /** Baseline engine */
  baselineEngine: Engine;

  /** Variant (canary) engine */
  variantEngine: Engine;

  /** Test workload */
  testWorkload: TestCase[];

  /** Minimum sample size (default: 30) */
  minSampleSize?: number;

  /** Confidence level (default: 0.95 for 95%) */
  confidenceLevel?: number;

  /** Significance level (default: 0.05 for 5%) */
  alpha?: number;

  /** Run tests concurrently (default: false for fairness) */
  concurrent?: boolean;

  /** Warmup runs before measurement (default: 3) */
  warmupRuns?: number;

  /** Timeout per request in ms (default: 30000) */
  timeoutMs?: number;

  /** Verbose logging */
  verbose?: boolean;
}

/**
 * A/B test results
 */
export interface ABTestResults {
  /** Test metadata */
  timestamp: string;
  testDurationMs: number;
  totalTestCases: number;

  /** Baseline metrics */
  baseline: {
    name: string;
    metrics: PerformanceMetrics;
  };

  /** Variant metrics */
  variant: {
    name: string;
    metrics: PerformanceMetrics;
  };

  /** Statistical comparison */
  comparison: {
    // Throughput comparison
    throughput: {
      improvement: number; // Percentage improvement
      tTest: WelchTTestResult;
      effectSize: EffectSize;
      significant: boolean;
    };

    // TTFT comparison
    ttft: {
      improvement: number; // Percentage improvement (negative = faster)
      tTest: WelchTTestResult;
      effectSize: EffectSize;
      significant: boolean;
    };

    // Latency comparison
    latency: {
      improvement: number; // Percentage improvement (negative = faster)
      tTest: WelchTTestResult;
      effectSize: EffectSize;
      significant: boolean;
    };
  };

  /** Go/no-go decision */
  decision: {
    recommendation: 'go' | 'no-go' | 'inconclusive';
    reasons: string[];
    confidenceLevel: number;
  };
}

/**
 * A/B Test Runner
 */
export class ABTestRunner {
  private config: Required<ABTestConfig>;

  constructor(config: ABTestConfig) {
    // Apply defaults
    this.config = {
      ...config,
      minSampleSize: config.minSampleSize ?? 30,
      confidenceLevel: config.confidenceLevel ?? 0.95,
      alpha: config.alpha ?? 0.05,
      concurrent: config.concurrent ?? false,
      warmupRuns: config.warmupRuns ?? 3,
      timeoutMs: config.timeoutMs ?? 30000,
      verbose: config.verbose ?? false,
    };

    // Validate configuration
    this.validateConfig();
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    if (this.config.testWorkload.length < this.config.minSampleSize) {
      throw new Error(
        `Test workload must have at least ${this.config.minSampleSize} test cases ` +
          `(got ${this.config.testWorkload.length})`
      );
    }

    if (this.config.confidenceLevel <= 0 || this.config.confidenceLevel >= 1) {
      throw new Error('Confidence level must be between 0 and 1');
    }

    if (this.config.alpha <= 0 || this.config.alpha >= 1) {
      throw new Error('Alpha must be between 0 and 1');
    }
  }

  /**
   * Run A/B test
   */
  async run(): Promise<ABTestResults> {
    const startTime = Date.now();
    this.log('Starting A/B test...');
    this.log(`Workload: ${this.config.testWorkload.length} test cases`);
    this.log(`Mode: ${this.config.concurrent ? 'concurrent' : 'sequential'}`);
    this.log(`Confidence level: ${(this.config.confidenceLevel * 100).toFixed(1)}%`);

    // Warmup (if enabled)
    if (this.config.warmupRuns > 0) {
      await this.warmup();
    }

    // Run baseline engine
    this.log('\n=== Running Baseline Engine ===');
    const baselineResults = await this.runWorkload(this.config.baselineEngine, 'baseline');

    // Run variant engine
    this.log('\n=== Running Variant Engine ===');
    const variantResults = await this.runWorkload(this.config.variantEngine, 'variant');

    // Calculate metrics
    const baselineMetrics = this.calculateMetrics(baselineResults);
    const variantMetrics = this.calculateMetrics(variantResults);

    // Perform statistical analysis
    const comparison = this.compareMetrics(baselineResults, variantResults);

    // Make go/no-go decision
    const decision = this.makeDecision(comparison);

    const testDurationMs = Date.now() - startTime;

    const results: ABTestResults = {
      timestamp: new Date().toISOString(),
      testDurationMs,
      totalTestCases: this.config.testWorkload.length,
      baseline: {
        name: 'baseline',
        metrics: baselineMetrics,
      },
      variant: {
        name: 'variant',
        metrics: variantMetrics,
      },
      comparison,
      decision,
    };

    this.printResults(results);

    return results;
  }

  /**
   * Warmup both engines
   */
  private async warmup(): Promise<void> {
    this.log(`\n=== Warmup (${this.config.warmupRuns} runs) ===`);

    const warmupCases = this.config.testWorkload.slice(0, Math.min(3, this.config.testWorkload.length));

    for (let i = 0; i < this.config.warmupRuns; i++) {
      this.log(`Warmup run ${i + 1}/${this.config.warmupRuns}...`);

      // Warmup baseline
      await this.runWorkload(this.config.baselineEngine, 'baseline-warmup', warmupCases);

      // Warmup variant
      await this.runWorkload(this.config.variantEngine, 'variant-warmup', warmupCases);
    }

    this.log('Warmup complete\n');
  }

  /**
   * Run workload on an engine
   */
  private async runWorkload(
    engine: Engine,
    engineName: string,
    workload: TestCase[] = this.config.testWorkload
  ): Promise<RequestMetrics[]> {
    const results: RequestMetrics[] = [];

    if (this.config.concurrent) {
      // Concurrent execution (faster but may have resource contention)
      const promises = workload.map((testCase, idx) =>
        this.runTestCase(engine, testCase, idx, workload.length)
      );
      const settled = await Promise.allSettled(promises);

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Handle rejected promise
          results.push({
            testCaseId: 'unknown',
            ttftMs: 0,
            latencyMs: 0,
            tokensGenerated: 0,
            tokensPerSecond: 0,
            success: false,
            error: result.reason?.message || 'Unknown error',
          });
        }
      }
    } else {
      // Sequential execution (fairer comparison, no resource contention)
      for (let i = 0; i < workload.length; i++) {
        const testCase = workload[i];
        try {
          const metrics = await this.runTestCase(engine, testCase, i, workload.length);
          results.push(metrics);
        } catch (error) {
          results.push({
            testCaseId: testCase.id,
            ttftMs: 0,
            latencyMs: 0,
            tokensGenerated: 0,
            tokensPerSecond: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    return results;
  }

  /**
   * Run a single test case
   */
  private async runTestCase(
    engine: Engine,
    testCase: TestCase,
    index: number,
    total: number
  ): Promise<RequestMetrics> {
    this.log(`  [${index + 1}/${total}] ${testCase.id}...`);

    const params: GeneratorParams = {
      model: testCase.model,
      prompt: testCase.prompt,
      maxTokens: testCase.maxTokens ?? 100,
      temperature: testCase.temperature ?? 0.7,
      streaming: true,
    };

    const startTime = Date.now();
    let ttftMs = 0;
    let tokensGenerated = 0;
    let firstTokenReceived = false;

    try {
      // Create generator with timeout
      const generator = engine.createGenerator(params, {
        timeoutMs: this.config.timeoutMs,
      });

      // Consume tokens
      for await (const chunk of generator) {
        if (chunk.type === 'token') {
          tokensGenerated++;
          if (!firstTokenReceived) {
            ttftMs = Date.now() - startTime;
            firstTokenReceived = true;
          }
        }
      }

      const latencyMs = Date.now() - startTime;
      const tokensPerSecond = latencyMs > 0 ? (tokensGenerated / latencyMs) * 1000 : 0;

      return {
        testCaseId: testCase.id,
        ttftMs,
        latencyMs,
        tokensGenerated,
        tokensPerSecond,
        success: true,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        testCaseId: testCase.id,
        ttftMs,
        latencyMs,
        tokensGenerated,
        tokensPerSecond: 0,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Calculate aggregated metrics from request results
   */
  private calculateMetrics(results: RequestMetrics[]): PerformanceMetrics {
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (successful.length === 0) {
      throw new Error('No successful requests - cannot calculate metrics');
    }

    const latencies = successful.map((r) => r.latencyMs);
    const ttfts = successful.map((r) => r.ttftMs);
    const throughputs = successful.map((r) => r.tokensPerSecond);
    const totalTokens = successful.reduce((sum, r) => sum + r.tokensGenerated, 0);

    return {
      totalRequests: results.length,
      successfulRequests: successful.length,
      failedRequests: failed.length,
      successRate: safeDivide(successful.length, results.length),
      latency: calculateSampleStatistics(latencies),
      ttft: calculateSampleStatistics(ttfts),
      throughput: calculateSampleStatistics(throughputs),
      totalTokens,
      avgTokensPerRequest: safeDivide(totalTokens, successful.length),
    };
  }

  /**
   * Compare metrics using statistical tests
   */
  private compareMetrics(baseline: RequestMetrics[], variant: RequestMetrics[]): ABTestResults['comparison'] {
    // Filter successful requests only
    const baselineSuccess = baseline.filter((r) => r.success);
    const variantSuccess = variant.filter((r) => r.success);

    // Extract metrics
    const baselineThroughput = baselineSuccess.map((r) => r.tokensPerSecond);
    const variantThroughput = variantSuccess.map((r) => r.tokensPerSecond);

    const baselineTtft = baselineSuccess.map((r) => r.ttftMs);
    const variantTtft = variantSuccess.map((r) => r.ttftMs);

    const baselineLatency = baselineSuccess.map((r) => r.latencyMs);
    const variantLatency = variantSuccess.map((r) => r.latencyMs);

    // Statistical tests
    const throughputTest = welchTTest(baselineThroughput, variantThroughput, this.config.confidenceLevel);
    const throughputEffect = calculateEffectSize(baselineThroughput, variantThroughput);

    const ttftTest = welchTTest(baselineTtft, variantTtft, this.config.confidenceLevel);
    const ttftEffect = calculateEffectSize(baselineTtft, variantTtft);

    const latencyTest = welchTTest(baselineLatency, variantLatency, this.config.confidenceLevel);
    const latencyEffect = calculateEffectSize(baselineLatency, variantLatency);

    // Calculate percentage improvements
    const baselineThroughputStats = calculateSampleStatistics(baselineThroughput);
    const variantThroughputStats = calculateSampleStatistics(variantThroughput);
    const throughputImprovement =
      ((variantThroughputStats.mean - baselineThroughputStats.mean) / baselineThroughputStats.mean) * 100;

    const baselineTtftStats = calculateSampleStatistics(baselineTtft);
    const variantTtftStats = calculateSampleStatistics(variantTtft);
    const ttftImprovement = ((variantTtftStats.mean - baselineTtftStats.mean) / baselineTtftStats.mean) * 100;

    const baselineLatencyStats = calculateSampleStatistics(baselineLatency);
    const variantLatencyStats = calculateSampleStatistics(variantLatency);
    const latencyImprovement =
      ((variantLatencyStats.mean - baselineLatencyStats.mean) / baselineLatencyStats.mean) * 100;

    return {
      throughput: {
        improvement: throughputImprovement,
        tTest: throughputTest,
        effectSize: throughputEffect,
        significant: throughputTest.significant,
      },
      ttft: {
        improvement: ttftImprovement,
        tTest: ttftTest,
        effectSize: ttftEffect,
        significant: ttftTest.significant,
      },
      latency: {
        improvement: latencyImprovement,
        tTest: latencyTest,
        effectSize: latencyEffect,
        significant: latencyTest.significant,
      },
    };
  }

  /**
   * Make go/no-go decision based on statistical analysis
   */
  private makeDecision(comparison: ABTestResults['comparison']): ABTestResults['decision'] {
    const reasons: string[] = [];
    let goCount = 0;
    let noGoCount = 0;

    // Throughput analysis
    if (comparison.throughput.significant) {
      if (comparison.throughput.improvement > 0) {
        goCount++;
        reasons.push(
          `✓ Throughput improved by ${comparison.throughput.improvement.toFixed(2)}% ` +
            `(${formatPValue(comparison.throughput.tTest.pValue)}, ${comparison.throughput.effectSize.interpretation} effect)`
        );
      } else {
        noGoCount++;
        reasons.push(
          `✗ Throughput degraded by ${Math.abs(comparison.throughput.improvement).toFixed(2)}% ` +
            `(${formatPValue(comparison.throughput.tTest.pValue)}, ${comparison.throughput.effectSize.interpretation} effect)`
        );
      }
    } else {
      reasons.push(
        `○ Throughput change (${comparison.throughput.improvement > 0 ? '+' : ''}${comparison.throughput.improvement.toFixed(2)}%) ` +
          `not statistically significant (${formatPValue(comparison.throughput.tTest.pValue)})`
      );
    }

    // TTFT analysis (lower is better)
    if (comparison.ttft.significant) {
      if (comparison.ttft.improvement < 0) {
        goCount++;
        reasons.push(
          `✓ TTFT improved by ${Math.abs(comparison.ttft.improvement).toFixed(2)}% ` +
            `(${formatPValue(comparison.ttft.tTest.pValue)}, ${comparison.ttft.effectSize.interpretation} effect)`
        );
      } else {
        noGoCount++;
        reasons.push(
          `✗ TTFT degraded by ${comparison.ttft.improvement.toFixed(2)}% ` +
            `(${formatPValue(comparison.ttft.tTest.pValue)}, ${comparison.ttft.effectSize.interpretation} effect)`
        );
      }
    } else {
      reasons.push(
        `○ TTFT change (${comparison.ttft.improvement > 0 ? '+' : ''}${comparison.ttft.improvement.toFixed(2)}%) ` +
          `not statistically significant (${formatPValue(comparison.ttft.tTest.pValue)})`
      );
    }

    // Latency analysis (lower is better)
    if (comparison.latency.significant) {
      if (comparison.latency.improvement < 0) {
        goCount++;
        reasons.push(
          `✓ Latency improved by ${Math.abs(comparison.latency.improvement).toFixed(2)}% ` +
            `(${formatPValue(comparison.latency.tTest.pValue)}, ${comparison.latency.effectSize.interpretation} effect)`
        );
      } else {
        noGoCount++;
        reasons.push(
          `✗ Latency degraded by ${comparison.latency.improvement.toFixed(2)}% ` +
            `(${formatPValue(comparison.latency.tTest.pValue)}, ${comparison.latency.effectSize.interpretation} effect)`
        );
      }
    } else {
      reasons.push(
        `○ Latency change (${comparison.latency.improvement > 0 ? '+' : ''}${comparison.latency.improvement.toFixed(2)}%) ` +
          `not statistically significant (${formatPValue(comparison.latency.tTest.pValue)})`
      );
    }

    // Decision logic
    let recommendation: ABTestResults['decision']['recommendation'];

    if (noGoCount > 0) {
      // Any significant degradation = no-go
      recommendation = 'no-go';
    } else if (goCount > 0) {
      // At least one significant improvement and no degradations = go
      recommendation = 'go';
    } else {
      // No significant changes = inconclusive
      recommendation = 'inconclusive';
    }

    return {
      recommendation,
      reasons,
      confidenceLevel: this.config.confidenceLevel,
    };
  }

  /**
   * Print results to console
   */
  private printResults(results: ABTestResults): void {
    // console.log('\n' + '='.repeat(80));
    // console.log('A/B TEST RESULTS');
    // console.log('='.repeat(80));

    // console.log(`\nTimestamp: ${results.timestamp}`);
    // console.log(`Duration: ${(results.testDurationMs / 1000).toFixed(2)}s`);
    // console.log(`Test cases: ${results.totalTestCases}`);

    // Baseline metrics
    // console.log('\n--- BASELINE ---');
    this.printMetrics(results.baseline.metrics);

    // Variant metrics
    // console.log('\n--- VARIANT ---');
    this.printMetrics(results.variant.metrics);

    // Statistical comparison
    // console.log('\n--- STATISTICAL COMPARISON ---');
    // console.log(`Confidence level: ${(results.decision.confidenceLevel * 100).toFixed(1)}%`);

    // console.log('\nThroughput (tokens/sec):');
    // console.log(`  Improvement: ${results.comparison.throughput.improvement > 0 ? '+' : ''}${results.comparison.throughput.improvement.toFixed(2)}%`);
    // console.log(`  ${formatPValue(results.comparison.throughput.tTest.pValue)}`);
    // console.log(`  Effect size: ${results.comparison.throughput.effectSize.cohensD.toFixed(3)} (${results.comparison.throughput.effectSize.interpretation})`);
    // console.log(`  Significant: ${results.comparison.throughput.significant ? 'YES' : 'NO'}`);

    // console.log('\nTTFT (ms):');
    // console.log(`  Improvement: ${results.comparison.ttft.improvement > 0 ? '+' : ''}${results.comparison.ttft.improvement.toFixed(2)}%`);
    // console.log(`  ${formatPValue(results.comparison.ttft.tTest.pValue)}`);
    // console.log(`  Effect size: ${results.comparison.ttft.effectSize.cohensD.toFixed(3)} (${results.comparison.ttft.effectSize.interpretation})`);
    // console.log(`  Significant: ${results.comparison.ttft.significant ? 'YES' : 'NO'}`);

    // console.log('\nLatency (ms):');
    // console.log(`  Improvement: ${results.comparison.latency.improvement > 0 ? '+' : ''}${results.comparison.latency.improvement.toFixed(2)}%`);
    // console.log(`  ${formatPValue(results.comparison.latency.tTest.pValue)}`);
    // console.log(`  Effect size: ${results.comparison.latency.effectSize.cohensD.toFixed(3)} (${results.comparison.latency.effectSize.interpretation})`);
    // console.log(`  Significant: ${results.comparison.latency.significant ? 'YES' : 'NO'}`);

    // Decision
    // console.log('\n--- DECISION ---');
    // console.log(`Recommendation: ${results.decision.recommendation.toUpperCase()}`);
    // console.log('\nReasons:');
    for (const _reason of results.decision.reasons) {
      // console.log(`  ${_reason}`);
    }

    // console.log('\n' + '='.repeat(80));
  }

  /**
   * Print metrics summary
   */
  private printMetrics(metrics: PerformanceMetrics): void {
    // console.log(`Success rate: ${(metrics.successRate * 100).toFixed(2)}% (${metrics.successfulRequests}/${metrics.totalRequests})`);
    // console.log(`Total tokens: ${metrics.totalTokens}`);

    // console.log('\nThroughput (tokens/sec):');
    this.printStats(metrics.throughput);

    // console.log('\nTTFT (ms):');
    this.printStats(metrics.ttft);

    // console.log('\nLatency (ms):');
    this.printStats(metrics.latency);
  }

  /**
   * Print statistics summary
   */
  private printStats(_stats: SampleStatistics): void {
    // console.log(`  Mean:   ${_stats.mean.toFixed(2)}`);
    // console.log(`  Median: ${_stats.median.toFixed(2)}`);
    // console.log(`  P95:    ${_stats.p95.toFixed(2)}`);
    // console.log(`  P99:    ${_stats.p99.toFixed(2)}`);
    // console.log(`  StdDev: ${_stats.stdDev.toFixed(2)}`);
    // console.log(`  Range:  [${_stats.min.toFixed(2)}, ${_stats.max.toFixed(2)}]`);
  }

  /**
   * Log message (if verbose)
   */
  private log(_message: string): void {
    if (this.config.verbose) {
      // console.log(_message);
    }
  }
}

/**
 * Helper function to create test workload from prompts
 */
export function createTestWorkload(
  model: string,
  prompts: string[],
  options: {
    maxTokens?: number;
    temperature?: number;
    expectedMinTokens?: number;
  } = {}
): TestCase[] {
  return prompts.map((prompt, idx) => ({
    id: `test-${idx + 1}`,
    prompt,
    model,
    maxTokens: options.maxTokens ?? 100,
    temperature: options.temperature ?? 0.7,
    expectedMinTokens: options.expectedMinTokens,
  }));
}

/**
 * Helper function to load test workload from file
 */
export async function loadTestWorkload(filePath: string): Promise<TestCase[]> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content) as TestCase[];
}

/**
 * Helper function to save test results
 */
export async function saveTestResults(filePath: string, results: ABTestResults): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify(results, null, 2), 'utf-8');
}
