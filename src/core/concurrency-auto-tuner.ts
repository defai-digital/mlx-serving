/**
 * Adaptive Concurrency Auto-Tuner
 *
 * Automatically adjusts concurrency limits based on:
 * 1. Hardware detection (chip model, GPU cores, memory)
 * 2. Runtime health monitoring (crashes, latency, memory pressure)
 * 3. Learned optimal settings (persistent cache)
 *
 * Usage:
 *   const tuner = new ConcurrencyAutoTuner();
 *   await tuner.initialize();
 *   const limits = tuner.getLimitsForModel(modelId);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectHardware,
  recommendConcurrency,
  printHardwareProfile,
  type HardwareProfile,
  type ConcurrencyRecommendation,
} from './hardware-detector.js';
import type { ModelTier, TierLimit } from '../types/concurrency.js';

interface LearnedProfile {
  modelId: string;
  modelTier: ModelTier;
  hardwareFingerprint: string;
  optimalLimits: TierLimit;
  confidence: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastUpdated: number;
  learnedAt: number;
}

interface TuningCache {
  version: string;
  hardware: HardwareProfile;
  profiles: Record<string, LearnedProfile>;
  createdAt: number;
  lastUpdated: number;
}

interface HealthMetrics {
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  memoryPressure: number; // 0-1 scale
  recentCrashes: number;
}

export class ConcurrencyAutoTuner {
  private hardware: HardwareProfile | null = null;
  private recommendations: ConcurrencyRecommendation | null = null;
  private cache: TuningCache | null = null;
  private cacheFile: string;
  private healthHistory: Map<string, HealthMetrics[]> = new Map();
  private initialized = false;

  constructor(cacheDir?: string) {
    const dir = cacheDir || path.join(os.homedir(), '.mlx-serving');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.cacheFile = path.join(dir, 'concurrency-tuning.json');
  }

  /**
   * Initialize the auto-tuner (hardware detection + cache loading)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Detect hardware
    this.hardware = detectHardware();
    this.recommendations = recommendConcurrency(this.hardware);

    // Load cache
    this.loadCache();

    // Validate cache against current hardware
    if (this.cache && !this.isHardwareMatch(this.cache.hardware, this.hardware)) {
      console.warn('Hardware changed since last run - resetting tuning cache');
      this.cache = this.createFreshCache();
      this.saveCache();
    }

    // Create fresh cache if none exists
    if (!this.cache) {
      this.cache = this.createFreshCache();
      this.saveCache();
    }

    this.initialized = true;

    console.log(printHardwareProfile(this.hardware, this.recommendations));
  }

  /**
   * Get recommended concurrency limits for a specific model
   */
  getLimitsForModel(modelId: string, modelTier: ModelTier): TierLimit {
    if (!this.initialized || !this.recommendations) {
      throw new Error('Auto-tuner not initialized - call initialize() first');
    }

    // Check if we have learned optimal limits for this model
    const fingerprint = this.getHardwareFingerprint();
    const cacheKey = `${modelId}:${fingerprint}`;

    if (this.cache?.profiles[cacheKey]) {
      const learned = this.cache.profiles[cacheKey];

      // Use learned limits if confidence is high and recent
      const ageMs = Date.now() - learned.lastUpdated;
      const isRecent = ageMs < 7 * 24 * 60 * 60 * 1000; // 7 days
      const isConfident = learned.confidence > 0.7;

      if (isRecent && isConfident) {
        console.log(`Using learned limits for ${modelId} (confidence: ${(learned.confidence * 100).toFixed(1)}%)`);
        return learned.optimalLimits;
      }
    }

    // Fall back to hardware-based recommendations
    return this.recommendations[modelTier];
  }

  /**
   * Report health metrics for adaptive tuning
   */
  reportHealth(modelId: string, modelTier: ModelTier, metrics: HealthMetrics): void {
    if (!this.initialized || !this.cache) return;

    // Store health history
    if (!this.healthHistory.has(modelId)) {
      this.healthHistory.set(modelId, []);
    }
    const history = this.healthHistory.get(modelId)!;
    history.push({ ...metrics, timestamp: Date.now() } as HealthMetrics & { timestamp: number });

    // Keep only recent history (last 100 samples)
    if (history.length > 100) {
      history.shift();
    }

    // Update learned profile
    this.updateLearnedProfile(modelId, modelTier, metrics);
  }

  /**
   * Suggest limit adjustment based on health metrics
   */
  suggestAdjustment(modelId: string, modelTier: ModelTier, currentLimits: TierLimit): TierLimit | null {
    const history = this.healthHistory.get(modelId);
    if (!history || history.length < 10) {
      return null; // Not enough data
    }

    // Analyze recent health (last 20 samples)
    const recent = history.slice(-20);
    const avgSuccessRate = recent.reduce((sum, h) => sum + h.successRate, 0) / recent.length;
    const avgLatency = recent.reduce((sum, h) => sum + h.avgLatencyMs, 0) / recent.length;
    const avgMemoryPressure = recent.reduce((sum, h) => sum + h.memoryPressure, 0) / recent.length;
    const totalCrashes = recent.reduce((sum, h) => sum + h.recentCrashes, 0);

    // Decision rules
    const shouldIncrease =
      avgSuccessRate > 0.98 && // High success rate
      avgLatency < 5000 && // Low latency
      avgMemoryPressure < 0.7 && // Low memory pressure
      totalCrashes === 0; // No crashes

    const shouldDecrease =
      avgSuccessRate < 0.9 || // Low success rate
      avgLatency > 10000 || // High latency
      avgMemoryPressure > 0.85 || // High memory pressure
      totalCrashes > 0; // Crashes detected

    if (shouldIncrease) {
      // Increase by 20%
      return {
        maxConcurrent: Math.min(currentLimits.maxConcurrent + 1, currentLimits.maxConcurrent * 1.2),
        queueDepth: Math.min(currentLimits.queueDepth + 5, currentLimits.queueDepth * 1.2),
        queueTimeoutMs: currentLimits.queueTimeoutMs,
      };
    }

    if (shouldDecrease) {
      // Decrease by 30%
      return {
        maxConcurrent: Math.max(1, Math.round(currentLimits.maxConcurrent * 0.7)),
        queueDepth: Math.max(5, Math.round(currentLimits.queueDepth * 0.7)),
        queueTimeoutMs: currentLimits.queueTimeoutMs,
      };
    }

    return null; // No adjustment needed
  }

  /**
   * Get hardware profile
   */
  getHardwareProfile(): HardwareProfile | null {
    return this.hardware;
  }

  /**
   * Get current recommendations
   */
  getRecommendations(): ConcurrencyRecommendation | null {
    return this.recommendations;
  }

  /**
   * Get learned profiles summary
   */
  getLearnedProfiles(): LearnedProfile[] {
    if (!this.cache) return [];
    return Object.values(this.cache.profiles);
  }

  /**
   * Export tuning data for analysis
   */
  exportTuningData(): TuningCache | null {
    return this.cache;
  }

  // Private methods

  private createFreshCache(): TuningCache {
    return {
      version: '1.0.0',
      hardware: this.hardware!,
      profiles: {},
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf-8');
        this.cache = JSON.parse(data);
      }
    } catch (error) {
      console.warn('Failed to load tuning cache:', error);
      this.cache = null;
    }
  }

  private saveCache(): void {
    if (!this.cache) return;

    try {
      this.cache.lastUpdated = Date.now();
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save tuning cache:', error);
    }
  }

  private updateLearnedProfile(modelId: string, modelTier: ModelTier, metrics: HealthMetrics): void {
    if (!this.cache) return;

    const fingerprint = this.getHardwareFingerprint();
    const cacheKey = `${modelId}:${fingerprint}`;

    let profile = this.cache.profiles[cacheKey];

    if (!profile) {
      // Create new profile
      profile = {
        modelId,
        modelTier,
        hardwareFingerprint: fingerprint,
        optimalLimits: this.recommendations![modelTier],
        confidence: 0.1,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        lastUpdated: Date.now(),
        learnedAt: Date.now(),
      };
      this.cache.profiles[cacheKey] = profile;
    }

    // Update metrics (exponential moving average)
    const alpha = 0.2; // Learning rate
    profile.avgLatencyMs = profile.avgLatencyMs * (1 - alpha) + metrics.avgLatencyMs * alpha;
    profile.p95LatencyMs = profile.p95LatencyMs * (1 - alpha) + metrics.p95LatencyMs * alpha;

    // Update confidence based on sample size and success rate
    profile.totalRequests += 1;
    profile.successfulRequests += metrics.successRate;
    profile.failedRequests += 1 - metrics.successRate;

    const successRate = profile.successfulRequests / profile.totalRequests;
    const sampleConfidence = Math.min(1.0, profile.totalRequests / 100); // Max confidence at 100 samples
    profile.confidence = successRate * sampleConfidence;

    profile.lastUpdated = Date.now();

    // Save cache periodically
    if (profile.totalRequests % 10 === 0) {
      this.saveCache();
    }
  }

  private getHardwareFingerprint(): string {
    if (!this.hardware) return 'unknown';

    // Create unique fingerprint based on hardware
    return `${this.hardware.chipModel}-${this.hardware.gpuCores}c-${this.hardware.unifiedMemoryGB}gb`;
  }

  private isHardwareMatch(cached: HardwareProfile, current: HardwareProfile): boolean {
    return (
      cached.chipModel === current.chipModel &&
      cached.gpuCores === current.gpuCores &&
      Math.abs(cached.unifiedMemoryGB - current.unifiedMemoryGB) <= 1 // Allow 1GB difference
    );
  }
}
