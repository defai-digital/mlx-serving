/**
 * Real Model Loader
 *
 * Handles loading, warming up, and unloading real MLX models
 * for production validation testing.
 *
 * Supports:
 * - Model loading and caching
 * - Warmup with real inference requests
 * - Model statistics tracking
 * - Resource monitoring during load
 */

import { Engine } from '@/api/engine.js';
import type { LoadModelOptions } from '@/types/models.js';

export interface ModelStats {
  modelId: string;
  loaded: boolean;
  loadTimeMs: number;
  warmupTimeMs: number;
  warmupRequests: number;
  memoryUsageMb: number;
}

export interface WarmupConfig {
  numRequests: number;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Real model loader for production testing
 */
export class RealModelLoader {
  private engine: Engine;
  private loadedModels: Map<string, ModelStats> = new Map();

  constructor() {
    this.engine = new Engine();
  }

  /**
   * Load a real MLX model
   */
  async loadModel(modelId: string, options?: Partial<LoadModelOptions>): Promise<void> {
    const loadStartTime = Date.now();

    console.log(`Loading model: ${modelId}`);

    try {
      await this.engine.loadModel(modelId, options);

      const loadTimeMs = Date.now() - loadStartTime;

      // Track loaded model
      this.loadedModels.set(modelId, {
        modelId,
        loaded: true,
        loadTimeMs,
        warmupTimeMs: 0,
        warmupRequests: 0,
        memoryUsageMb: this.getCurrentMemoryUsage(),
      });

      console.log(`✅ Model loaded in ${loadTimeMs}ms`);
    } catch (error: any) {
      console.error(`❌ Failed to load model ${modelId}:`, error.message);
      throw error;
    }
  }

  /**
   * Warmup model with real inference requests
   */
  async warmupModel(modelId: string, config: WarmupConfig): Promise<void> {
    const stats = this.loadedModels.get(modelId);
    if (!stats) {
      throw new Error(`Model ${modelId} not loaded. Call loadModel() first.`);
    }

    const warmupStartTime = Date.now();
    const prompt = config.prompt || 'Hello, how are you?';
    const maxTokens = config.maxTokens || 50;
    const temperature = config.temperature || 0.7;

    console.log(`Warming up model with ${config.numRequests} requests...`);

    for (let i = 0; i < config.numRequests; i++) {
      try {
        await this.engine.generate({
          modelId,
          prompt,
          maxTokens,
          temperature,
        });
      } catch (error: any) {
        console.warn(`Warmup request ${i + 1} failed:`, error.message);
      }
    }

    const warmupTimeMs = Date.now() - warmupStartTime;

    // Update stats
    stats.warmupTimeMs = warmupTimeMs;
    stats.warmupRequests = config.numRequests;
    stats.memoryUsageMb = this.getCurrentMemoryUsage();

    console.log(`✅ Warmup complete in ${warmupTimeMs}ms`);
  }

  /**
   * Unload a model
   */
  async unloadModel(modelId: string): Promise<void> {
    const stats = this.loadedModels.get(modelId);
    if (!stats) {
      console.warn(`Model ${modelId} not tracked in loader`);
      return;
    }

    console.log(`Unloading model: ${modelId}`);

    try {
      await this.engine.unloadModel(modelId);

      stats.loaded = false;
      this.loadedModels.delete(modelId);

      console.log(`✅ Model unloaded`);
    } catch (error: any) {
      console.error(`❌ Failed to unload model:`, error.message);
      throw error;
    }
  }

  /**
   * Get stats for a loaded model
   */
  getModelStats(modelId: string): ModelStats | undefined {
    return this.loadedModels.get(modelId);
  }

  /**
   * Get all loaded models
   */
  getAllLoadedModels(): ModelStats[] {
    return Array.from(this.loadedModels.values());
  }

  /**
   * Check if model is loaded
   */
  isModelLoaded(modelId: string): boolean {
    const stats = this.loadedModels.get(modelId);
    return stats?.loaded ?? false;
  }

  /**
   * Get current memory usage in MB
   */
  private getCurrentMemoryUsage(): number {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024);
  }

  /**
   * Cleanup all loaded models
   */
  async cleanup(): Promise<void> {
    const modelIds = Array.from(this.loadedModels.keys());

    console.log(`Cleaning up ${modelIds.length} models...`);

    for (const modelId of modelIds) {
      try {
        await this.unloadModel(modelId);
      } catch (error: any) {
        console.error(`Failed to cleanup model ${modelId}:`, error.message);
      }
    }
  }
}
