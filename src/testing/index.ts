/**
 * A/B Testing Framework
 *
 * Week 2: Statistical Validation System
 *
 * Provides tools for performance comparison with statistical validation:
 * - A/B test execution with parallel baseline and variant runs
 * - Statistical significance testing (Welch's t-test)
 * - Confidence interval calculation (95%, 99%)
 * - Effect size measurement (Cohen's d)
 * - Go/no-go decision criteria
 */

export {
  ABTestRunner,
  createTestWorkload,
  loadTestWorkload,
  saveTestResults,
  type ABTestConfig,
  type ABTestResults,
  type TestCase,
  type RequestMetrics,
  type PerformanceMetrics,
} from './ab-test-runner.js';

export {
  calculateSampleStatistics,
  welchTTest,
  calculateEffectSize,
  calculateSampleSize,
  formatPValue,
  getSignificanceLevel,
  type SampleStatistics,
  type WelchTTestResult,
  type EffectSize,
  type SampleSizeResult,
} from './statistical-analysis.js';
