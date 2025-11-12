/**
 * Math Helper Utilities
 *
 * Safe mathematical operations that guard against division by zero,
 * NaN propagation, and other edge cases.
 */

/**
 * Calculate safe average of an array of numbers
 *
 * Guards against division by zero and empty arrays
 *
 * @param values - Array of numbers to average
 * @param defaultValue - Value to return if array is empty (default: 0)
 * @returns Average of values, or defaultValue if array is empty
 *
 * @example
 * ```typescript
 * safeAverage([1, 2, 3])        // => 2
 * safeAverage([])               // => 0
 * safeAverage([], 100)          // => 100
 * safeAverage([10, 20, 30])     // => 20
 * ```
 */
export function safeAverage(values: number[], defaultValue = 0): number {
  if (!values || values.length === 0) {
    return defaultValue;
  }

  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

/**
 * Calculate safe division that guards against division by zero
 *
 * @param numerator - Numerator
 * @param denominator - Denominator
 * @param defaultValue - Value to return if denominator is 0 (default: 0)
 * @returns numerator / denominator, or defaultValue if denominator is 0
 *
 * @example
 * ```typescript
 * safeDivide(10, 2)        // => 5
 * safeDivide(10, 0)        // => 0
 * safeDivide(10, 0, 100)   // => 100
 * ```
 */
export function safeDivide(numerator: number, denominator: number, defaultValue = 0): number {
  if (denominator === 0) {
    return defaultValue;
  }

  return numerator / denominator;
}

/**
 * Calculate safe sum that guards against NaN propagation
 *
 * @param values - Array of numbers to sum
 * @param defaultValue - Value to return if array is empty (default: 0)
 * @returns Sum of values, or defaultValue if array is empty
 *
 * @example
 * ```typescript
 * safeSum([1, 2, 3])        // => 6
 * safeSum([])               // => 0
 * safeSum([], 100)          // => 100
 * ```
 */
export function safeSum(values: number[], defaultValue = 0): number {
  if (!values || values.length === 0) {
    return defaultValue;
  }

  return values.reduce((acc, val) => acc + val, 0);
}
