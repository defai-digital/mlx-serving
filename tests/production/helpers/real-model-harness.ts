/**
 * Real Model Benchmark Harness
 *
 * Extends BenchmarkHarness to work with real MLX models.
 * Handles model loading, warmup, and benchmarking with actual inference.
 */

import { BenchmarkHarness, type BenchmarkConfig, type BenchmarkResult } from '../../performance/infrastructure/benchmark-harness.js';
import { RealModelLoader, type WarmupConfig } from './model-loader.js';
import { Engine } from '@/api/engine.js';
import type { LoadModelOptions } from '@/types/models.js';

export interface RealModelBenchmarkConfig extends BenchmarkConfig {
  realModelId: string;
  loadOptions?: Partial<LoadModelOptions>;
  warmupRequests?: number;
  requestsPerSecond?: number;
}

/**
 * Benchmark harness for real MLX model testing
 */
export class RealModelBenchmarkHarness extends BenchmarkHarness {
  private testName: string;
  private loader: RealModelLoader;
  private engine: Engine;

  constructor(testName: string) {
    super();
    this.testName = testName;
    this.loader = new RealModelLoader();
    this.engine = new Engine();
  }

  /**
   * Benchmark name
   */
  name(): string {
    return this.testName;
  }

  /**
   * Load and warmup the model before benchmarking
   */
  async loadAndWarmup(config: RealModelBenchmarkConfig): Promise<void> {
    console.log(`Loading model: ${config.realModelId}`);

    // Load model
    await this.loader.loadModel(config.realModelId, config.loadOptions);

    // Warmup with specified number of requests
    const warmupRequests = config.warmupRequests || 5;
    const warmupConfig: WarmupConfig = {
      numRequests: warmupRequests,
      prompt: 'Hello, how are you?',
      maxTokens: 50,
      temperature: 0.7,
    };

    await this.loader.warmupModel(config.realModelId, warmupConfig);

    const stats = this.loader.getModelStats(config.realModelId);
    console.log(`Model loaded and warmed up:`);
    console.log(`  Load time: ${stats?.loadTimeMs}ms`);
    console.log(`  Warmup time: ${stats?.warmupTimeMs}ms`);
    console.log(`  Memory usage: ${stats?.memoryUsageMb}MB`);
  }

  /**
   * Warmup phase - just verify model is loaded
   */
  async warmup(config: BenchmarkConfig): Promise<void> {
    const realConfig = config as RealModelBenchmarkConfig;

    if (!this.loader.isModelLoaded(realConfig.realModelId)) {
      await this.loadAndWarmup(realConfig);
    }
  }

  /**
   * Main benchmark run with real model
   */
  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const realConfig = config as RealModelBenchmarkConfig;
    const modelId = realConfig.realModelId;

    if (!this.loader.isModelLoaded(modelId)) {
      throw new Error(`Model ${modelId} not loaded. Call loadAndWarmup() first.`);
    }

    const startTime = Date.now();
    const endTime = startTime + config.duration;
    const latencies: number[] = [];
    let errors = 0;
    let requestCount = 0;

    console.log(`Running benchmark for ${config.duration}ms with concurrency ${config.concurrency}`);

    // Calculate delay between batches to achieve target RPS
    const rps = realConfig.requestsPerSecond || config.concurrency;
    const batchDelayMs = (config.concurrency / rps) * 1000;

    while (Date.now() < endTime) {
      const batchStartTime = Date.now();

      // Send concurrent batch
      const promises = [];
      for (let i = 0; i < config.concurrency; i++) {
        const reqStartTime = Date.now();
        const promise = this.engine.generate({
          modelId,
          prompt: `Benchmark test request ${requestCount++}`,
          maxTokens: 100,
          temperature: 0.7,
        }).then(() => {
          latencies.push(Date.now() - reqStartTime);
        }).catch(() => {
          errors++;
        });
        promises.push(promise);
      }

      await Promise.all(promises);

      // Rate limiting delay
      const batchTime = Date.now() - batchStartTime;
      const delayNeeded = Math.max(0, batchDelayMs - batchTime);
      if (delayNeeded > 0) {
        await new Promise(resolve => setTimeout(resolve, delayNeeded));
      }
    }

    const actualDuration = Date.now() - startTime;

    return this.analyzeResults(
      this.testName,
      config,
      latencies,
      errors,
      actualDuration
    );
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.loader.cleanup();
  }

  /**
   * Get model stats
   */
  getModelStats(modelId: string) {
    return this.loader.getModelStats(modelId);
  }
}

/**
 * Helper function to create and run real model benchmark
 */
export async function runRealModelBenchmark(
  name: string,
  config: RealModelBenchmarkConfig
): Promise<BenchmarkResult> {
  const harness = new RealModelBenchmarkHarness(name);

  try {
    // Load and warmup model
    await harness.loadAndWarmup(config);

    // Run benchmark
    const result = await harness.execute(config);

    return result;
  } finally {
    // Cleanup
    await harness.cleanup();
  }
}
