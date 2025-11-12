# A/B Testing Framework Guide

**Week 2: Statistical Validation System**

Comprehensive guide for using the A/B testing framework to validate performance improvements with statistical rigor.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Core Concepts](#core-concepts)
4. [Statistical Methods](#statistical-methods)
5. [API Reference](#api-reference)
6. [Best Practices](#best-practices)
7. [Examples](#examples)
8. [Interpretation Guide](#interpretation-guide)

---

## Overview

The A/B testing framework provides **statistically rigorous** performance comparison between baseline and variant engines. It implements industry-standard statistical methods to determine if performance improvements are real or just noise.

### Key Features

- **Parallel A/B Testing**: Run baseline and variant on identical workloads
- **Statistical Validation**: Welch's t-test with 95% confidence intervals
- **Effect Size Measurement**: Cohen's d to quantify practical significance
- **Go/No-Go Criteria**: Clear recommendations based on statistical evidence
- **Comprehensive Metrics**: Throughput, TTFT, latency (P50/P95/P99)

### When to Use

Use A/B testing when you need to:
- Validate performance optimizations before rollout
- Compare different configuration settings
- Evaluate new features or algorithms
- Make data-driven deployment decisions

---

## Quick Start

### Basic Usage

```typescript
import { createEngine } from 'mlx-serving';
import { ABTestRunner, createTestWorkload } from 'mlx-serving/testing';

// Create test workload (minimum 30 samples)
const prompts = [
  'What is TypeScript?',
  'Explain machine learning.',
  // ... at least 30 prompts total
];

const testWorkload = createTestWorkload('mlx-community/Qwen2.5-7B-Instruct-4bit', prompts, {
  maxTokens: 100,
  temperature: 0.7,
});

// Initialize engines
const baseline = await createEngine();
const variant = await createEngine();

await baseline.loadModel({ model: 'mlx-community/Qwen2.5-7B-Instruct-4bit' });
await variant.loadModel({ model: 'mlx-community/Qwen2.5-7B-Instruct-4bit' });

// Run A/B test
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload,
  confidenceLevel: 0.95, // 95% confidence
  verbose: true,
});

const results = await runner.run();

// Check decision
console.log(`Recommendation: ${results.decision.recommendation}`);
console.log(`Reasons:`, results.decision.reasons);
```

### Running the Example

```bash
tsx examples/ab-test-example.ts
```

---

## Core Concepts

### Test Workload

A **test workload** is a collection of test cases that both engines will execute:

```typescript
interface TestCase {
  id: string;              // Unique identifier
  prompt: string;          // Input prompt
  model: string;           // Model to use
  maxTokens?: number;      // Max tokens to generate
  temperature?: number;    // Sampling temperature
  expectedMinTokens?: number;  // Optional validation
}
```

**Requirements:**
- Minimum 30 test cases (for statistical power)
- Identical prompts for both engines (fairness)
- Representative of production workload

### Performance Metrics

Each test run collects:

```typescript
interface PerformanceMetrics {
  // Success metrics
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;

  // Latency statistics (P50, P95, P99, etc.)
  latency: SampleStatistics;

  // Time to First Token (TTFT)
  ttft: SampleStatistics;

  // Throughput (tokens/sec)
  throughput: SampleStatistics;

  // Token metrics
  totalTokens: number;
  avgTokensPerRequest: number;
}
```

### Statistical Comparison

For each metric (throughput, TTFT, latency):

```typescript
interface MetricComparison {
  improvement: number;        // Percentage improvement
  tTest: WelchTTestResult;   // Statistical significance
  effectSize: EffectSize;    // Practical significance (Cohen's d)
  significant: boolean;      // p < α?
}
```

### Go/No-Go Decision

Automated decision based on statistical evidence:

```typescript
interface Decision {
  recommendation: 'go' | 'no-go' | 'inconclusive';
  reasons: string[];         // Human-readable explanations
  confidenceLevel: number;   // e.g., 0.95 for 95%
}
```

**Decision Logic:**
- **Go**: At least one significant improvement, no degradations
- **No-Go**: Any significant degradation
- **Inconclusive**: No significant changes detected

---

## Statistical Methods

### Welch's t-test

Tests null hypothesis: μ₁ = μ₂ (no difference between groups)

**Why Welch's t-test?**
- Handles unequal variances (robust)
- Two-tailed test (detects both improvements and regressions)
- Industry standard for A/B testing

**Formula:**

```
t = (x̄₂ - x̄₁) / √(s₁²/n₁ + s₂²/n₂)

df = (s₁²/n₁ + s₂²/n₂)² / ((s₁²/n₁)²/(n₁-1) + (s₂²/n₂)²/(n₂-1))
```

**Interpretation:**
- **p < 0.001**: Highly significant
- **p < 0.01**: Moderately significant
- **p < 0.05**: Weakly significant (standard threshold)
- **p ≥ 0.05**: Not significant

### Confidence Intervals

95% confidence interval for mean difference:

```
[μ₂ - μ₁ - t_critical·SE, μ₂ - μ₁ + t_critical·SE]
```

**Interpretation:**
- If interval excludes 0: Significant difference
- If interval includes 0: No significant difference
- Width indicates precision (narrower = more precise)

### Effect Size (Cohen's d)

Measures **practical significance** (standardized difference):

```
d = (x̄₂ - x̄₁) / s_pooled

where s_pooled = √((n₁-1)·s₁² + (n₂-1)·s₂²) / (n₁ + n₂ - 2)
```

**Classification:**
- **|d| < 0.2**: Negligible effect
- **0.2 ≤ |d| < 0.5**: Small effect
- **0.5 ≤ |d| < 0.8**: Medium effect
- **|d| ≥ 0.8**: Large effect

**Why Effect Size Matters:**
- Statistical significance ≠ practical importance
- Large samples can detect tiny (irrelevant) differences
- Effect size quantifies **how much** improvement

### Sample Size Calculation

Determine required sample size for desired power:

```typescript
const { requiredSampleSize } = calculateSampleSize(
  0.5,    // Expected Cohen's d (medium effect)
  0.05,   // α (significance level)
  0.8     // Power (1 - β)
);
```

**Rule of Thumb:**
- Minimum 30 samples per group
- 50+ for medium effects (d = 0.5)
- 100+ for small effects (d = 0.2)

---

## API Reference

### ABTestRunner

Main class for running A/B tests.

```typescript
class ABTestRunner {
  constructor(config: ABTestConfig)
  async run(): Promise<ABTestResults>
}
```

#### Configuration

```typescript
interface ABTestConfig {
  baselineEngine: Engine;      // Baseline engine
  variantEngine: Engine;       // Variant (canary) engine
  testWorkload: TestCase[];    // Test cases to run
  minSampleSize?: number;      // Minimum samples (default: 30)
  confidenceLevel?: number;    // Confidence level (default: 0.95)
  alpha?: number;              // Significance level (default: 0.05)
  concurrent?: boolean;        // Run tests concurrently? (default: false)
  warmupRuns?: number;         // Warmup runs (default: 3)
  timeoutMs?: number;          // Timeout per request (default: 30000)
  verbose?: boolean;           // Verbose logging (default: false)
}
```

#### Results

```typescript
interface ABTestResults {
  timestamp: string;
  testDurationMs: number;
  totalTestCases: number;

  baseline: {
    name: string;
    metrics: PerformanceMetrics;
  };

  variant: {
    name: string;
    metrics: PerformanceMetrics;
  };

  comparison: {
    throughput: MetricComparison;
    ttft: MetricComparison;
    latency: MetricComparison;
  };

  decision: {
    recommendation: 'go' | 'no-go' | 'inconclusive';
    reasons: string[];
    confidenceLevel: number;
  };
}
```

### Helper Functions

#### createTestWorkload

Create test workload from prompts:

```typescript
function createTestWorkload(
  model: string,
  prompts: string[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    expectedMinTokens?: number;
  }
): TestCase[]
```

#### saveTestResults

Save results to JSON file:

```typescript
async function saveTestResults(
  filePath: string,
  results: ABTestResults
): Promise<void>
```

#### loadTestWorkload

Load test workload from JSON file:

```typescript
async function loadTestWorkload(filePath: string): Promise<TestCase[]>
```

### Statistical Functions

#### calculateSampleStatistics

Calculate statistics from sample:

```typescript
function calculateSampleStatistics(values: number[]): SampleStatistics
```

#### welchTTest

Perform Welch's t-test:

```typescript
function welchTTest(
  baseline: number[],
  variant: number[],
  confidenceLevel?: number
): WelchTTestResult
```

#### calculateEffectSize

Calculate Cohen's d:

```typescript
function calculateEffectSize(
  baseline: number[],
  variant: number[]
): EffectSize
```

#### calculateSampleSize

Determine required sample size:

```typescript
function calculateSampleSize(
  effectSize: number,
  alpha?: number,
  power?: number
): SampleSizeResult
```

---

## Best Practices

### 1. Sample Size

**Always use sufficient samples:**
- ✅ Minimum 30 test cases per group
- ✅ 50+ for detecting medium effects (d = 0.5)
- ✅ 100+ for small effects (d = 0.2)
- ❌ Avoid < 30 samples (unreliable)

### 2. Test Fairness

**Ensure fair comparison:**
- ✅ Identical test workload for both engines
- ✅ Sequential execution (no resource contention)
- ✅ Warmup runs to eliminate cold-start effects
- ❌ Avoid testing under different conditions

### 3. Representative Workload

**Use production-like prompts:**
- ✅ Real user queries
- ✅ Diverse prompt lengths
- ✅ Mix of tasks (QA, summarization, etc.)
- ❌ Avoid synthetic/trivial prompts

### 4. Statistical Rigor

**Follow statistical best practices:**
- ✅ Use 95% confidence level (α = 0.05)
- ✅ Report both p-value and effect size
- ✅ Check effect size interpretation
- ❌ Don't cherry-pick results

### 5. Interpretation

**Consider both statistical and practical significance:**
- ✅ p < 0.05 **and** medium/large effect → Strong evidence
- ⚠️ p < 0.05 but negligible effect → Statistically significant but irrelevant
- ⚠️ p ≥ 0.05 but large effect → May need more samples
- ❌ p ≥ 0.05 and small effect → No evidence of difference

---

## Examples

### Example 1: Basic A/B Test

```typescript
const prompts = generateTestPrompts(50); // At least 30
const workload = createTestWorkload(modelId, prompts);

const baseline = await createEngine();
const variant = await createEngine();

await baseline.loadModel({ model: modelId });
await variant.loadModel({ model: modelId });

const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: workload,
  confidenceLevel: 0.95,
  verbose: true,
});

const results = await runner.run();

if (results.decision.recommendation === 'go') {
  console.log('✓ Safe to deploy variant');
} else {
  console.log('✗ Keep baseline');
}
```

### Example 2: Custom Confidence Level

```typescript
// 99% confidence (more conservative)
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: workload,
  confidenceLevel: 0.99,  // Stricter threshold
  alpha: 0.01,            // p < 0.01 required
});
```

### Example 3: Concurrent Testing

```typescript
// Faster but may have resource contention
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: workload,
  concurrent: true,  // Run all tests in parallel
  warmupRuns: 5,     // More warmup for stability
});
```

### Example 4: Loading/Saving Workload

```typescript
// Save workload for reproducibility
const workload = createTestWorkload(modelId, prompts);
await writeFile('workload.json', JSON.stringify(workload, null, 2));

// Load for later use
const loadedWorkload = await loadTestWorkload('workload.json');

// Run test with saved workload
const results = await runner.run();
await saveTestResults('results.json', results);
```

### Example 5: Sample Size Planning

```typescript
import { calculateSampleSize } from 'mlx-serving/testing';

// Plan for medium effect (d = 0.5)
const { requiredSampleSize } = calculateSampleSize(
  0.5,   // Expected Cohen's d
  0.05,  // α (5% false positive rate)
  0.8    // Power (80% chance to detect effect)
);

console.log(`Need ${requiredSampleSize} samples per group`);
// Output: Need 64 samples per group
```

---

## Interpretation Guide

### Reading Test Results

#### Throughput Comparison

```
Throughput (tokens/sec):
  Improvement: +15.23%
  p = 0.002
  Effect size: 0.68 (medium)
  Significant: YES
```

**Interpretation:**
- ✓ Variant is 15.23% faster
- ✓ p = 0.002 < 0.05 → Statistically significant
- ✓ Cohen's d = 0.68 → Medium effect size
- **Conclusion**: Real, meaningful improvement

#### TTFT Comparison

```
TTFT (ms):
  Improvement: -8.45%
  p = 0.345
  Effect size: 0.15 (negligible)
  Significant: NO
```

**Interpretation:**
- ○ Variant is 8.45% faster (negative = improvement)
- ✗ p = 0.345 > 0.05 → Not statistically significant
- ○ Cohen's d = 0.15 → Negligible effect
- **Conclusion**: No evidence of difference (could be noise)

#### Latency Comparison

```
Latency (ms):
  Improvement: +12.67%
  p = 0.001
  Effect size: 0.82 (large)
  Significant: YES
```

**Interpretation:**
- ✗ Variant is 12.67% slower (positive = degradation)
- ✓ p = 0.001 < 0.05 → Statistically significant
- ✓ Cohen's d = 0.82 → Large effect size
- **Conclusion**: Significant degradation → No-go

### Decision Recommendations

#### Go

```
Recommendation: GO

Reasons:
  ✓ Throughput improved by 15.23% (p = 0.002, medium effect)
  ○ TTFT change (-2.34%) not statistically significant (p = 0.234)
  ○ Latency change (+1.12%) not statistically significant (p = 0.567)
```

**Safe to deploy**: At least one improvement, no degradations.

#### No-Go

```
Recommendation: NO-GO

Reasons:
  ✓ Throughput improved by 8.45% (p = 0.012, small effect)
  ✗ TTFT degraded by 15.67% (p = 0.001, large effect)
  ○ Latency change (+3.21%) not statistically significant (p = 0.089)
```

**Do not deploy**: Significant degradation detected.

#### Inconclusive

```
Recommendation: INCONCLUSIVE

Reasons:
  ○ Throughput change (+2.34%) not statistically significant (p = 0.456)
  ○ TTFT change (-1.23%) not statistically significant (p = 0.678)
  ○ Latency change (-0.89%) not statistically significant (p = 0.789)
```

**Need more data**: No significant changes detected. Consider:
- Increasing sample size
- Checking if difference is too small to detect
- Verifying test conditions

---

## Common Pitfalls

### Pitfall 1: Small Sample Size

❌ **Problem**: Testing with < 30 samples
```typescript
const workload = createTestWorkload(modelId, ['Test']); // Only 1 sample!
```

✅ **Solution**: Use minimum 30 samples
```typescript
const prompts = generatePrompts(50); // At least 30
const workload = createTestWorkload(modelId, prompts);
```

### Pitfall 2: Unfair Comparison

❌ **Problem**: Different conditions for baseline and variant
```typescript
// Baseline runs when system is idle
// Variant runs under load
```

✅ **Solution**: Sequential execution with warmup
```typescript
const runner = new ABTestRunner({
  ...config,
  concurrent: false,  // Fair comparison
  warmupRuns: 3,      // Eliminate cold-start
});
```

### Pitfall 3: Ignoring Effect Size

❌ **Problem**: Relying only on p-value
```typescript
if (results.comparison.throughput.tTest.pValue < 0.05) {
  deploy(); // But effect might be negligible!
}
```

✅ **Solution**: Check both p-value and effect size
```typescript
const { tTest, effectSize, improvement } = results.comparison.throughput;
if (tTest.pValue < 0.05 && effectSize.interpretation !== 'negligible') {
  deploy(); // Real, meaningful improvement
}
```

### Pitfall 4: Multiple Testing

❌ **Problem**: Running many A/B tests and cherry-picking
```typescript
// Test 20 variants, deploy the one with p < 0.05
// Increases false positive rate!
```

✅ **Solution**: Use Bonferroni correction or plan tests in advance
```typescript
// Adjust α for multiple comparisons
const alpha = 0.05 / numberOfTests;
```

---

## Summary

The A/B testing framework provides **rigorous statistical validation** for performance comparisons:

- ✅ Industry-standard methods (Welch's t-test, Cohen's d)
- ✅ Automated go/no-go decisions
- ✅ Comprehensive metrics (throughput, TTFT, latency)
- ✅ Production-ready implementation

**Key Takeaways:**
1. Use minimum 30 samples per group
2. Ensure fair comparison (identical workload, sequential execution)
3. Consider both statistical significance (p-value) and practical significance (effect size)
4. Follow automated recommendations but understand the statistics

---

## References

- Welch, B.L. (1947). "The generalization of 'Student's' problem when several different population variances are involved"
- Cohen, J. (1988). "Statistical Power Analysis for the Behavioral Sciences"
- Deng, A., et al. (2013). "Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data"
