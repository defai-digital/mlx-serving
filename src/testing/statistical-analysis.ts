/**
 * Statistical Analysis Module for A/B Testing
 *
 * Provides statistical methods for performance comparison validation:
 * - Welch's t-test (for unequal variances)
 * - Confidence interval calculation (95%, 99%)
 * - Effect size calculation (Cohen's d)
 * - Sample size determination
 * - P-value computation
 *
 * Week 2: Statistical Validation System
 */

/**
 * Sample statistics
 */
export interface SampleStatistics {
  n: number;
  mean: number;
  variance: number;
  stdDev: number;
  min: number;
  max: number;
  median: number;
  p95: number;
  p99: number;
}

/**
 * Welch's t-test result (for unequal variances)
 */
export interface WelchTTestResult {
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  significant: boolean;
  confidenceInterval: [number, number];
  confidenceLevel: number;
}

/**
 * Effect size calculation (Cohen's d)
 */
export interface EffectSize {
  cohensD: number;
  interpretation: 'negligible' | 'small' | 'medium' | 'large';
  description: string;
}

/**
 * Sample size calculation result
 */
export interface SampleSizeResult {
  requiredSampleSize: number;
  power: number;
  alpha: number;
  effectSize: number;
}

/**
 * Calculate sample statistics from array of values
 */
export function calculateSampleStatistics(values: number[]): SampleStatistics {
  if (values.length === 0) {
    throw new Error('Cannot calculate statistics for empty array');
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  // Mean
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  // Variance and standard deviation
  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  // Percentiles
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  return {
    n,
    mean,
    variance,
    stdDev,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    p95,
    p99,
  };
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number {
  if (p < 0 || p > 100) {
    throw new Error('Percentile must be between 0 and 100');
  }

  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Perform Welch's t-test (two-sample, unequal variances)
 *
 * Tests null hypothesis: μ₁ = μ₂ (no difference between groups)
 * Alternative hypothesis: μ₁ ≠ μ₂ (two-tailed test)
 *
 * @param baseline - Baseline sample values
 * @param variant - Variant sample values
 * @param confidenceLevel - Confidence level (default: 0.95 for 95%)
 * @returns Welch's t-test result with p-value and confidence interval
 */
export function welchTTest(
  baseline: number[],
  variant: number[],
  confidenceLevel = 0.95
): WelchTTestResult {
  // Calculate sample statistics
  const stats1 = calculateSampleStatistics(baseline);
  const stats2 = calculateSampleStatistics(variant);

  // Welch's t-statistic
  // t = (x̄₁ - x̄₂) / √(s₁²/n₁ + s₂²/n₂)
  const meanDiff = stats2.mean - stats1.mean;
  const se = Math.sqrt(stats1.variance / stats1.n + stats2.variance / stats2.n);
  const tStatistic = meanDiff / se;

  // Welch-Satterthwaite degrees of freedom
  // df = (s₁²/n₁ + s₂²/n₂)² / ((s₁²/n₁)²/(n₁-1) + (s₂²/n₂)²/(n₂-1))
  const s1_n1 = stats1.variance / stats1.n;
  const s2_n2 = stats2.variance / stats2.n;
  const df = Math.pow(s1_n1 + s2_n2, 2) / (Math.pow(s1_n1, 2) / (stats1.n - 1) + Math.pow(s2_n2, 2) / (stats2.n - 1));

  // Two-tailed p-value
  const pValue = 2 * (1 - studentTCDF(Math.abs(tStatistic), df));

  // Confidence interval for mean difference
  const alpha = 1 - confidenceLevel;
  const tCritical = studentTQuantile(1 - alpha / 2, df);
  const marginOfError = tCritical * se;
  const confidenceInterval: [number, number] = [meanDiff - marginOfError, meanDiff + marginOfError];

  return {
    tStatistic,
    degreesOfFreedom: df,
    pValue,
    significant: pValue < alpha,
    confidenceInterval,
    confidenceLevel,
  };
}

/**
 * Calculate Cohen's d effect size
 *
 * Measures standardized difference between two means:
 * - d < 0.2: negligible
 * - 0.2 ≤ d < 0.5: small
 * - 0.5 ≤ d < 0.8: medium
 * - d ≥ 0.8: large
 *
 * @param baseline - Baseline sample values
 * @param variant - Variant sample values
 * @returns Effect size with interpretation
 */
export function calculateEffectSize(baseline: number[], variant: number[]): EffectSize {
  const stats1 = calculateSampleStatistics(baseline);
  const stats2 = calculateSampleStatistics(variant);

  // Pooled standard deviation
  // s_pooled = √((n₁-1)·s₁² + (n₂-1)·s₂²) / (n₁ + n₂ - 2)
  const pooledVariance =
    ((stats1.n - 1) * stats1.variance + (stats2.n - 1) * stats2.variance) / (stats1.n + stats2.n - 2);
  const pooledStdDev = Math.sqrt(pooledVariance);

  // Cohen's d = (x̄₂ - x̄₁) / s_pooled
  const cohensD = (stats2.mean - stats1.mean) / pooledStdDev;
  const absCohensD = Math.abs(cohensD);

  let interpretation: EffectSize['interpretation'];
  let description: string;

  if (absCohensD < 0.2) {
    interpretation = 'negligible';
    description = 'Negligible effect size (< 0.2)';
  } else if (absCohensD < 0.5) {
    interpretation = 'small';
    description = 'Small effect size (0.2-0.5)';
  } else if (absCohensD < 0.8) {
    interpretation = 'medium';
    description = 'Medium effect size (0.5-0.8)';
  } else {
    interpretation = 'large';
    description = 'Large effect size (≥ 0.8)';
  }

  return {
    cohensD,
    interpretation,
    description,
  };
}

/**
 * Calculate required sample size for desired power
 *
 * Uses approximation for two-sample t-test with equal sample sizes:
 * n ≈ 2·(z_α/2 + z_β)² / δ²
 *
 * where:
 * - z_α/2 is the critical value for significance level α (two-tailed)
 * - z_β is the critical value for power (1 - β)
 * - δ is the effect size (Cohen's d)
 *
 * @param effectSize - Expected Cohen's d effect size
 * @param alpha - Significance level (default: 0.05 for 5%)
 * @param power - Desired statistical power (default: 0.8 for 80%)
 * @returns Required sample size per group
 */
export function calculateSampleSize(
  effectSize: number,
  alpha = 0.05,
  power = 0.8
): SampleSizeResult {
  if (effectSize <= 0) {
    throw new Error('Effect size must be positive');
  }
  if (alpha <= 0 || alpha >= 1) {
    throw new Error('Alpha must be between 0 and 1');
  }
  if (power <= 0 || power >= 1) {
    throw new Error('Power must be between 0 and 1');
  }

  // Critical values for two-tailed test
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);

  // Sample size calculation (per group)
  const n = (2 * Math.pow(zAlpha + zBeta, 2)) / Math.pow(effectSize, 2);
  const requiredSampleSize = Math.ceil(n);

  return {
    requiredSampleSize,
    power,
    alpha,
    effectSize,
  };
}

/**
 * Student's t-distribution CDF (cumulative distribution function)
 *
 * Approximation using normal distribution for df > 30,
 * otherwise uses numerical integration.
 *
 * @param t - t-statistic
 * @param df - Degrees of freedom
 * @returns Probability P(T ≤ t)
 */
function studentTCDF(t: number, df: number): number {
  // For large df (> 30), t-distribution approximates normal distribution
  if (df > 30) {
    return normalCDF(t);
  }

  // For small df, use numerical integration (trapezoid rule)
  // Integrate t-density from -∞ to t
  const steps = 1000;
  const range = 10; // Integrate from -range to t
  const dx = (t + range) / steps;

  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = -range + i * dx;
    const y = studentTPDF(x, df);
    const weight = i === 0 || i === steps ? 0.5 : 1;
    sum += weight * y;
  }

  return Math.min(1, Math.max(0, sum * dx));
}

/**
 * Student's t-distribution PDF (probability density function)
 */
function studentTPDF(x: number, df: number): number {
  const numerator = gamma((df + 1) / 2);
  const denominator = Math.sqrt(df * Math.PI) * gamma(df / 2);
  const factor = Math.pow(1 + (x * x) / df, -(df + 1) / 2);
  return (numerator / denominator) * factor;
}

/**
 * Student's t-distribution quantile function (inverse CDF)
 *
 * Returns t-value such that P(T ≤ t) = p
 *
 * @param p - Probability (0 < p < 1)
 * @param df - Degrees of freedom
 * @returns t-value
 */
function studentTQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error('Probability must be between 0 and 1');
  }

  // For large df, use normal approximation
  if (df > 30) {
    return normalQuantile(p);
  }

  // Newton-Raphson iteration to find t such that CDF(t) = p
  let t = normalQuantile(p); // Initial guess from normal distribution
  let iterations = 0;
  const maxIterations = 100;
  const tolerance = 1e-6;

  while (iterations < maxIterations) {
    const cdf = studentTCDF(t, df);
    const pdf = studentTPDF(t, df);

    if (Math.abs(cdf - p) < tolerance) {
      break;
    }

    // Newton-Raphson step
    t = t - (cdf - p) / pdf;
    iterations++;
  }

  return t;
}

/**
 * Standard normal CDF (cumulative distribution function)
 *
 * Approximation using error function
 */
function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/**
 * Standard normal quantile function (inverse CDF)
 *
 * Approximation using rational function (Beasley-Springer-Moro algorithm)
 */
function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error('Probability must be between 0 and 1');
  }

  // Coefficients for rational approximation
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.383577518672690e2,
    -3.066479806614716e1,
    2.506628277459239e0,
  ];

  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];

  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838e0,
    -2.549732539343734e0,
    4.374664141464968e0,
    2.938163982698783e0,
  ];

  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    // Lower region
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    // Central region
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    // Upper region
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

/**
 * Error function (erf)
 *
 * Approximation using Abramowitz and Stegun formula
 */
function erf(x: number): number {
  // Constants
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  // Save the sign of x
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  // A&S formula
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Gamma function
 *
 * Approximation using Lanczos approximation
 */
function gamma(z: number): number {
  // Lanczos coefficients
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    // Reflection formula
    return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  }

  z -= 1;

  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }

  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Format p-value for display
 */
export function formatPValue(p: number): string {
  if (p < 0.001) {
    return 'p < 0.001';
  }
  if (p < 0.01) {
    return `p = ${p.toFixed(3)}`;
  }
  return `p = ${p.toFixed(2)}`;
}

/**
 * Determine statistical significance level
 */
export function getSignificanceLevel(p: number): 'highly' | 'moderately' | 'weakly' | 'not' {
  if (p < 0.001) return 'highly';
  if (p < 0.01) return 'moderately';
  if (p < 0.05) return 'weakly';
  return 'not';
}
