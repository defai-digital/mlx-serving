# A/B Testing Framework - Quick Reference

**Week 2: Statistical Validation System**

---

## Quick Start (30 seconds)

```typescript
import { createEngine } from 'mlx-serving';
import { ABTestRunner, createTestWorkload } from 'mlx-serving/testing';

// 1. Create test workload (min 30 prompts)
const prompts = ['Prompt 1', 'Prompt 2', /* ... 28 more */];
const workload = createTestWorkload('model-id', prompts);

// 2. Initialize engines
const baseline = await createEngine();
const variant = await createEngine();

// 3. Run A/B test
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: workload,
});

const results = await runner.run();

// 4. Check decision
if (results.decision.recommendation === 'go') {
  console.log('✓ Safe to deploy');
} else {
  console.log('✗ Keep baseline');
}
```

---

## Key Concepts

### Test Workload
- **Minimum**: 30 test cases
- **Recommended**: 50+ for medium effects, 100+ for small effects
- **Format**: `{ id, prompt, model, maxTokens, temperature }`

### Statistical Tests
- **Welch's t-test**: Tests if difference is statistically significant
- **P-value**: Probability of result occurring by chance (< 0.05 = significant)
- **Effect size**: Measures practical significance (Cohen's d)

### Decisions
- **Go**: Significant improvement, no degradations
- **No-Go**: Any significant degradation
- **Inconclusive**: No significant changes (need more data)

---

## API Reference

### ABTestRunner

```typescript
interface ABTestConfig {
  baselineEngine: Engine;         // Current/baseline engine
  variantEngine: Engine;          // New/canary engine
  testWorkload: TestCase[];       // Tests to run
  minSampleSize?: number;         // Default: 30
  confidenceLevel?: number;       // Default: 0.95 (95%)
  alpha?: number;                 // Default: 0.05 (5%)
  concurrent?: boolean;           // Default: false (sequential)
  warmupRuns?: number;            // Default: 3
  timeoutMs?: number;             // Default: 30000 (30s)
  verbose?: boolean;              // Default: false
}
```

### Helper Functions

```typescript
// Create test workload
createTestWorkload(model: string, prompts: string[], options?: {
  maxTokens?: number;
  temperature?: number;
}): TestCase[]

// Save results to JSON
saveTestResults(filePath: string, results: ABTestResults): Promise<void>

// Load workload from JSON
loadTestWorkload(filePath: string): Promise<TestCase[]>
```

### Statistical Functions

```typescript
// Sample statistics
calculateSampleStatistics(values: number[]): SampleStatistics

// Welch's t-test
welchTTest(baseline: number[], variant: number[], confidenceLevel?: number): WelchTTestResult

// Cohen's d effect size
calculateEffectSize(baseline: number[], variant: number[]): EffectSize

// Sample size calculator
calculateSampleSize(effectSize: number, alpha?: number, power?: number): SampleSizeResult
```

---

## Results Interpretation

### Reading Test Output

```
Throughput (tokens/sec):
  Improvement: +15.23%
  p = 0.002
  Effect size: 0.68 (medium)
  Significant: YES
```

**Interpretation:**
- **+15.23%**: Variant is 15.23% faster
- **p = 0.002**: 0.2% chance this is random (< 5% = significant)
- **0.68 (medium)**: Medium practical effect
- **YES**: Statistically significant improvement

### P-Value Guide
- **p < 0.001**: Highly significant (***)
- **p < 0.01**: Moderately significant (**)
- **p < 0.05**: Weakly significant (*)
- **p ≥ 0.05**: Not significant (ns)

### Effect Size Guide (Cohen's d)
- **|d| < 0.2**: Negligible (not meaningful)
- **0.2 ≤ |d| < 0.5**: Small effect
- **0.5 ≤ |d| < 0.8**: Medium effect
- **|d| ≥ 0.8**: Large effect

---

## Common Patterns

### Pattern 1: Basic Comparison

```typescript
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: createTestWorkload(modelId, prompts),
});

const results = await runner.run();
```

### Pattern 2: High Confidence (99%)

```typescript
const runner = new ABTestRunner({
  baselineEngine: baseline,
  variantEngine: variant,
  testWorkload: workload,
  confidenceLevel: 0.99,  // More conservative
  alpha: 0.01,            // Stricter threshold
});
```

### Pattern 3: Save/Load Workload

```typescript
// Save workload for reproducibility
const workload = createTestWorkload(modelId, prompts);
await writeFile('workload.json', JSON.stringify(workload));

// Load later
const loaded = await loadTestWorkload('workload.json');
const results = await runner.run();
await saveTestResults('results.json', results);
```

### Pattern 4: Power Analysis

```typescript
import { calculateSampleSize } from 'mlx-serving/testing';

// How many samples for medium effect?
const { requiredSampleSize } = calculateSampleSize(
  0.5,   // Cohen's d (medium effect)
  0.05,  // α (5% false positive)
  0.8    // Power (80% detection)
);

console.log(`Need ${requiredSampleSize} samples per group`);
// Output: "Need 64 samples per group"
```

---

## Decision Matrix

| Throughput | TTFT | Latency | Decision | Action |
|-----------|------|---------|----------|--------|
| ✓ Better | ○ Same | ○ Same | **Go** | Deploy variant |
| ✓ Better | ✓ Better | ○ Same | **Go** | Deploy variant |
| ○ Same | ✗ Worse | ○ Same | **No-Go** | Keep baseline |
| ✗ Worse | ○ Same | ○ Same | **No-Go** | Keep baseline |
| ○ Same | ○ Same | ○ Same | **Inconclusive** | Need more data |

Legend:
- ✓ = Significant improvement
- ✗ = Significant degradation
- ○ = No significant change

---

## Best Practices

### ✅ DO
- Use minimum 30 test cases (50+ recommended)
- Use sequential execution for fair comparison
- Include warmup runs to eliminate cold-start
- Check both p-value AND effect size
- Use production-like prompts

### ❌ DON'T
- Don't use < 30 samples (unreliable)
- Don't rely only on p-value (check effect size!)
- Don't test under different conditions
- Don't cherry-pick results
- Don't ignore success/failure rates

---

## Sample Size Guide

| Effect Size | α = 0.05, Power = 0.8 | α = 0.01, Power = 0.9 |
|-------------|----------------------|----------------------|
| Small (0.2) | 394 per group | 842 per group |
| Medium (0.5) | 64 per group | 133 per group |
| Large (0.8) | 26 per group | 52 per group |

**Rule of Thumb**: Use 50-100 samples for typical A/B tests.

---

## Troubleshooting

### Issue: "Inconclusive" decision

**Possible causes:**
1. Sample size too small (increase to 50-100)
2. Effect size too small to detect (check raw metrics)
3. High variance in results (check stability)

**Solutions:**
- Increase sample size
- Check if difference is meaningful
- Verify test conditions are stable

### Issue: High p-value but visible difference

**Explanation:**
- Difference exists but not statistically significant
- Likely due to small sample size or high variance

**Solutions:**
- Increase sample size (2x-4x)
- Check for outliers in data
- Verify test setup

### Issue: Low p-value but negligible effect

**Explanation:**
- Statistically significant but not practically meaningful
- Common with very large sample sizes

**Solutions:**
- Check effect size interpretation
- Consider if improvement is worth deployment cost
- Focus on practical significance

---

## Example Output

```
================================================================================
A/B TEST RESULTS
================================================================================

Timestamp: 2025-11-09T15:30:00.000Z
Duration: 180.45s
Test cases: 50

--- BASELINE ---
Success rate: 100.00% (50/50)
Total tokens: 5234

Throughput (tokens/sec):
  Mean:   84.23
  Median: 83.91
  P95:    92.15
  P99:    95.67
  StdDev: 8.45

--- VARIANT ---
Success rate: 100.00% (50/50)
Total tokens: 5198

Throughput (tokens/sec):
  Mean:   97.12
  Median: 96.88
  P95:    105.34
  P99:    108.92
  StdDev: 9.21

--- STATISTICAL COMPARISON ---
Confidence level: 95.0%

Throughput (tokens/sec):
  Improvement: +15.31%
  p = 0.001
  Effect size: 0.72 (medium)
  Significant: YES

--- DECISION ---
Recommendation: GO

Reasons:
  ✓ Throughput improved by 15.31% (p = 0.001, medium effect)
  ○ TTFT change (-2.34%) not statistically significant (p = 0.234)
  ○ Latency change (+1.12%) not statistically significant (p = 0.567)

================================================================================
```

---

## Integration with Canary Deployment

```typescript
import { CanaryRouter } from 'mlx-serving/canary';
import { ABTestRunner } from 'mlx-serving/testing';

async function validateCanary(
  baseline: Engine,
  canary: Engine,
  workload: TestCase[]
) {
  const runner = new ABTestRunner({
    baselineEngine: baseline,
    variantEngine: canary,
    testWorkload: workload,
  });

  const results = await runner.run();

  if (results.decision.recommendation === 'go') {
    // Safe to increase canary traffic
    return { safe: true, results };
  } else {
    // Rollback canary
    return { safe: false, results };
  }
}
```

---

## References

- **Full Guide**: `/docs/AB_TESTING_GUIDE.md`
- **Examples**: `/examples/ab-test-example.ts`
- **Source**: `/src/testing/`
- **Tests**: `/tests/unit/testing/`, `/tests/integration/ab-test-runner.test.ts`
