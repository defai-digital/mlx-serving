/**
 * Model Pre-Warmer
 * Pre-loads models on worker startup to eliminate cold-start latency
 */

import type { Engine } from '@/api/engine.js';
import { createLogger, type Logger } from '../utils/logger.js';

export type PreWarmPriority = 'high' | 'medium' | 'low';

export interface PreWarmModelConfig {
  model: string;
  priority: PreWarmPriority;
}

export interface PreWarmConfig {
  enabled: boolean;
  models: PreWarmModelConfig[];
  timeoutPerModelMs: number;
  parallel: boolean;
  registerWhen: 'warming' | 'complete';
}

export interface PreWarmStatus {
  total: number;
  completed: number;
  failed: number;
  inProgress: string | null;
  startedAt: number;
  completedAt: number | null;
  errors: Array<{ model: string; error: string }>;
}

export class ModelPreWarmer {
  private status: PreWarmStatus;
  private logger: Logger;
  private aborted: boolean = false;
  private warmedModels: string[] = [];

  constructor(
    private engine: Engine,
    private config: PreWarmConfig
  ) {
    this.status = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: null,
      startedAt: 0,
      completedAt: null,
      errors: [],
    };
    this.logger = createLogger('ModelPreWarmer');
  }

  /**
   * Start pre-warming models
   */
  async warmModels(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('Pre-warming disabled');
      return;
    }

    if (this.config.models.length === 0) {
      this.logger.info('No models to pre-warm');
      return;
    }

    this.status.startedAt = Date.now();
    this.status.total = this.config.models.length;

    // Sort by priority (high → medium → low)
    const sorted = this.sortByPriority(this.config.models);

    this.logger.info('Starting model pre-warming', {
      models: sorted.length,
      parallel: this.config.parallel,
      mode: this.config.parallel ? 'parallel' : 'sequential',
    });

    try {
      if (this.config.parallel) {
        await this.warmParallel(sorted);
      } else {
        await this.warmSequential(sorted);
      }
    } catch (error) {
      this.logger.error('Pre-warming interrupted', {
        error: (error as Error).message,
      });
    }

    this.status.completedAt = Date.now();
    const duration = this.status.completedAt - this.status.startedAt;

    this.logger.info('Pre-warming complete', {
      total: this.status.total,
      completed: this.status.completed,
      failed: this.status.failed,
      durationMs: duration,
      successRate: ((this.status.completed / this.status.total) * 100).toFixed(1) + '%',
    });
  }

  /**
   * Warm models sequentially (recommended for GPU stability)
   */
  private async warmSequential(models: PreWarmModelConfig[]): Promise<void> {
    for (const { model, priority } of models) {
      if (this.aborted) {
        this.logger.info('Pre-warming aborted');
        break;
      }

      await this.warmModel(model, priority);
    }
  }

  /**
   * Warm models in parallel (faster but may cause GPU issues)
   */
  private async warmParallel(models: PreWarmModelConfig[]): Promise<void> {
    const promises = models.map(({ model, priority }) =>
      this.warmModel(model, priority)
    );
    await Promise.allSettled(promises);
  }

  /**
   * Warm single model
   */
  private async warmModel(modelId: string, priority: PreWarmPriority): Promise<void> {
    this.status.inProgress = modelId;
    const startTime = Date.now();

    this.logger.info('Warming model', { modelId, priority });

    try {
      // Step 1: Load model with timeout
      await this.withTimeout(
        this.engine.loadModel({ model: modelId }),
        this.config.timeoutPerModelMs,
        `Loading ${modelId} timeout`
      );

      // Step 2: Generate short warmup sequence (warms Metal GPU)
      await this.withTimeout(
        this.generateWarmup(modelId),
        5000,
        `Warmup generation timeout`
      );

      const duration = Date.now() - startTime;
      this.status.completed++;
      this.warmedModels.push(modelId);

      this.logger.info('Model warmed successfully', {
        modelId,
        priority,
        durationMs: duration,
      });
    } catch (error) {
      this.status.failed++;
      const errorMessage = (error as Error).message;

      this.logger.error('Model warming failed', {
        modelId,
        priority,
        error: errorMessage,
      });

      this.status.errors.push({
        model: modelId,
        error: errorMessage,
      });
    } finally {
      this.status.inProgress = null;
    }
  }

  /**
   * Generate short warmup sequence to warm up Metal GPU
   */
  private async generateWarmup(modelId: string): Promise<void> {
    try {
      const generator = await this.engine.createGenerator({
        model: modelId,
        prompt: 'Hello',
        maxTokens: 1,
        temperature: 0.7,
      });

      // Consume the generator
      for await (const _chunk of generator) {
        // Just consume tokens
        break; // Only need first token to warm up
      }
    } catch (error) {
      // Warmup generation failed, but model is loaded
      this.logger.warn('Warmup generation failed', {
        modelId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Execute promise with timeout
   * Bug Fix #9: Clear timeout on success to prevent timer leak
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string = 'Operation timeout'
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Sort models by priority
   */
  private sortByPriority(models: PreWarmModelConfig[]): PreWarmModelConfig[] {
    const priorityOrder: Record<PreWarmPriority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    return [...models].sort((a, b) => {
      const aPriority = priorityOrder[a.priority];
      const bPriority = priorityOrder[b.priority];
      return aPriority - bPriority;
    });
  }

  /**
   * Get pre-warming status
   */
  getStatus(): PreWarmStatus {
    return {
      ...this.status,
      errors: [...this.status.errors],
    };
  }

  /**
   * Check if pre-warming is complete
   */
  isComplete(): boolean {
    return this.status.completedAt !== null;
  }

  /**
   * Get completion percentage (0-100)
   */
  getProgress(): number {
    if (this.status.total === 0) return 100;

    const processed = this.status.completed + this.status.failed;
    return Math.round((processed / this.status.total) * 100);
  }

  /**
   * Check if any models were successfully warmed
   */
  hasWarmModels(): boolean {
    return this.status.completed > 0;
  }

  /**
   * Get list of successfully warmed models
   */
  getWarmedModels(): string[] {
    return [...this.warmedModels];
  }

  /**
   * Abort pre-warming (for graceful shutdown)
   */
  abort(): void {
    this.aborted = true;
    this.logger.info('Pre-warming abort requested');
  }
}
