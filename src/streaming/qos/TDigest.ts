/**
 * Simplified TDigest for Percentile Calculation
 *
 * Streaming percentile approximation algorithm for high-accuracy
 * P50, P95, P99 estimation without storing all samples.
 *
 * Based on Ted Dunning's TDigest algorithm (simplified version).
 *
 * Phase 4.4 Implementation
 */

interface Centroid {
  mean: number;
  weight: number;
}

/**
 * Simplified TDigest for streaming percentile calculation
 */
export class TDigest {
  private centroids: Centroid[] = [];
  private compression: number;
  private count = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;

  constructor(compression = 100) {
    this.compression = compression;
  }

  /**
   * Add a value to the digest
   */
  public add(value: number, weight = 1): void {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return;
    }

    this.count += weight;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);

    // Simple insertion: add centroid and merge if needed
    this.centroids.push({ mean: value, weight });

    if (this.centroids.length > this.compression * 2) {
      this.compress();
    }
  }

  /**
   * Get percentile (0.0 to 1.0)
   */
  public percentile(q: number): number {
    if (this.count === 0) {
      return NaN;
    }

    if (q <= 0) {
      return this.min;
    }

    if (q >= 1) {
      return this.max;
    }

    if (this.centroids.length === 0) {
      return NaN;
    }

    // Sort centroids by mean
    this.centroids.sort((a, b) => a.mean - b.mean);

    const index = q * this.count;
    let weightSoFar = 0;

    for (const centroid of this.centroids) {
      weightSoFar += centroid.weight;

      if (weightSoFar >= index) {
        return centroid.mean;
      }
    }

    // Fallback to max
    return this.max;
  }

  /**
   * Get minimum value
   */
  public getMin(): number {
    return this.min;
  }

  /**
   * Get maximum value
   */
  public getMax(): number {
    return this.max;
  }

  /**
   * Get count of samples
   */
  public getCount(): number {
    return this.count;
  }

  /**
   * Compress centroids to reduce memory usage
   */
  private compress(): void {
    if (this.centroids.length <= this.compression) {
      return;
    }

    // Sort by mean
    this.centroids.sort((a, b) => a.mean - b.mean);

    // Merge adjacent centroids
    const compressed: Centroid[] = [];
    let current = this.centroids[0];

    for (let i = 1; i < this.centroids.length; i++) {
      const next = this.centroids[i];

      // Merge if close enough
      if (compressed.length < this.compression) {
        const combinedWeight = current.weight + next.weight;
        const combinedMean =
          (current.mean * current.weight + next.mean * next.weight) / combinedWeight;

        current = {
          mean: combinedMean,
          weight: combinedWeight,
        };
      } else {
        compressed.push(current);
        current = next;
      }
    }

    compressed.push(current);
    this.centroids = compressed;
  }

  /**
   * Reset the digest
   */
  public reset(): void {
    this.centroids = [];
    this.count = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  /**
   * Get mean of all values
   */
  public getMean(): number {
    if (this.count === 0) {
      return NaN;
    }

    let weightedSum = 0;
    for (const centroid of this.centroids) {
      weightedSum += centroid.mean * centroid.weight;
    }

    return weightedSum / this.count;
  }
}
