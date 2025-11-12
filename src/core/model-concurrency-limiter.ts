/**
 * Model-Size-Aware Concurrency Limiter
 *
 * Dynamically limits concurrent streams based on model size to prevent
 * Metal GPU queue overflow crashes (SIGABRT).
 *
 * Architecture:
 * - Detects model size from model ID pattern matching
 * - Enforces hard limits on concurrent streams per model tier
 * - Queues overflow requests with FIFO processing
 * - Graceful backpressure with configurable timeout
 *
 * Model Tiers (based on parameter count):
 * - Tier 1: 30B+ models → 2-3 concurrent streams max
 * - Tier 2: 13-27B models → 4-5 concurrent streams max
 * - Tier 3: 7-13B models → 6-8 concurrent streams max
 * - Tier 4: 3-7B models → 8-10 concurrent streams max
 * - Tier 5: <3B models → 10+ concurrent streams
 *
 * Phase 5 Week 3: Metal GPU Stability Fix
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { getConfig } from '../config/loader.js';

/**
 * Model tier based on parameter count
 */
export enum ModelTier {
  TIER_1_30B_PLUS = '30B+',
  TIER_2_13B_TO_27B = '13-27B',
  TIER_3_7B_TO_13B = '7-13B',
  TIER_4_3B_TO_7B = '3-7B',
  TIER_5_UNDER_3B = '<3B',
}

/**
 * Concurrency limits per model tier
 */
interface TierLimits {
  tier: ModelTier;
  maxConcurrent: number;
  queueDepth: number;
  queueTimeoutMs: number;
}

type PerModelStatSnapshot = {
  tier: ModelTier;
  active: number;
  queued: number;
  maxConcurrent: number;
  queueDepth: number;
};

/**
 * Default tier limits (conservative for Metal GPU stability)
 */
const DEFAULT_TIER_LIMITS: Record<ModelTier, TierLimits> = {
  [ModelTier.TIER_1_30B_PLUS]: {
    tier: ModelTier.TIER_1_30B_PLUS,
    maxConcurrent: 2,
    queueDepth: 10,
    queueTimeoutMs: 60000, // 1 minute
  },
  [ModelTier.TIER_2_13B_TO_27B]: {
    tier: ModelTier.TIER_2_13B_TO_27B,
    maxConcurrent: 4,
    queueDepth: 20,
    queueTimeoutMs: 45000, // 45 seconds
  },
  [ModelTier.TIER_3_7B_TO_13B]: {
    tier: ModelTier.TIER_3_7B_TO_13B,
    maxConcurrent: 6,
    queueDepth: 30,
    queueTimeoutMs: 30000, // 30 seconds
  },
  [ModelTier.TIER_4_3B_TO_7B]: {
    tier: ModelTier.TIER_4_3B_TO_7B,
    maxConcurrent: 8,
    queueDepth: 40,
    queueTimeoutMs: 30000,
  },
  [ModelTier.TIER_5_UNDER_3B]: {
    tier: ModelTier.TIER_5_UNDER_3B,
    maxConcurrent: 10,
    queueDepth: 50,
    queueTimeoutMs: 30000,
  },
};

/**
 * Queued request
 */
interface QueuedRequest {
  requestId: string;
  modelId: string;
  enqueuedAt: number;
  timeoutMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Concurrency limiter events
 */
export interface ConcurrencyLimiterEvents {
  admitted: (modelId: string, tier: ModelTier) => void;
  queued: (modelId: string, tier: ModelTier, queueDepth: number) => void;
  released: (modelId: string, tier: ModelTier) => void;
  timeout: (requestId: string, modelId: string) => void;
  rejected: (modelId: string, reason: string) => void;
}

/**
 * Model-Size-Aware Concurrency Limiter
 *
 * Prevents Metal GPU crashes by limiting concurrent streams based on model size.
 * Implements FIFO queue for overflow requests with graceful backpressure.
 */
export class ModelConcurrencyLimiter extends EventEmitter<ConcurrencyLimiterEvents> {
  private logger?: Logger;
  private enabled: boolean;
  private tierLimits: Map<ModelTier, TierLimits>;

  // Per-model active request tracking
  private activeRequests: Map<string, Set<string>>; // modelId → Set<requestId>

  // Per-model request queues (FIFO)
  private requestQueues: Map<string, QueuedRequest[]>; // modelId → Queue

  // Statistics
  private totalAdmitted = 0;
  private totalQueued = 0;
  private totalReleased = 0;
  private totalTimeouts = 0;
  private totalRejected = 0;

  constructor(logger?: Logger) {
    super();
    this.logger = logger;

    const config = getConfig();
    this.enabled = config.model_concurrency_limiter?.enabled ?? true;

    // Initialize tier limits (use config overrides if provided)
    this.tierLimits = new Map();
    for (const [tier, defaults] of Object.entries(DEFAULT_TIER_LIMITS)) {
      const tierKey = tier as ModelTier;
      const configOverride = config.model_concurrency_limiter?.tier_limits?.[tierKey];
      this.tierLimits.set(tierKey, {
        ...defaults,
        ...configOverride,
      });
    }

    this.activeRequests = new Map();
    this.requestQueues = new Map();

    this.logger?.info(
      {
        enabled: this.enabled,
        tierLimits: Object.fromEntries(this.tierLimits),
      },
      'ModelConcurrencyLimiter initialized'
    );
  }

  /**
   * Detect model tier from model ID
   *
   * Pattern matching rules:
   * - 30B, 34B, 70B, 72B, etc. → TIER_1
   * - 13B, 14B, 27B, etc. → TIER_2
   * - 7B, 8B, 9B, 10B, etc. → TIER_3
   * - 3B, 4B, 5B, 6B, etc. → TIER_4
   * - 1B, 2B, etc. → TIER_5
   */
  private detectModelTier(modelId: string): ModelTier {
    const lowerModelId = modelId.toLowerCase();

    // Extract parameter count from model ID
    // Common patterns: "qwen3-30b", "gemma-27b", "phi-3-7b", "llama-3.1-70b"
    const paramMatch = lowerModelId.match(/(\d+(?:\.\d+)?)b(?!yte)/);

    if (!paramMatch) {
      // No parameter count found, assume medium-sized model
      this.logger?.warn({ modelId }, 'Cannot detect model size, defaulting to TIER_3');
      return ModelTier.TIER_3_7B_TO_13B;
    }

    const paramCount = parseFloat(paramMatch[1]);

    if (paramCount >= 30) {
      return ModelTier.TIER_1_30B_PLUS;
    } else if (paramCount >= 13) {
      return ModelTier.TIER_2_13B_TO_27B;
    } else if (paramCount >= 7) {
      return ModelTier.TIER_3_7B_TO_13B;
    } else if (paramCount >= 3) {
      return ModelTier.TIER_4_3B_TO_7B;
    } else {
      return ModelTier.TIER_5_UNDER_3B;
    }
  }

  /**
   * Acquire a concurrency slot (or queue if at limit)
   *
   * @param modelId - Model identifier
   * @param requestId - Unique request identifier
   * @returns Promise that resolves when slot is available
   * @throws Error if queue is full or request times out
   */
  public async acquire(modelId: string, requestId: string): Promise<void> {
    if (!this.enabled) {
      // Limiter disabled, admit immediately
      return;
    }

    const tier = this.detectModelTier(modelId);
    const limits = this.tierLimits.get(tier);

    if (!limits) {
      this.logger?.error({ tier, modelId }, 'No limits configured for tier');
      throw new Error(`No concurrency limits configured for tier: ${tier}`);
    }

    // Check if we can admit immediately
    const activeSet = this.activeRequests.get(modelId) || new Set();

    if (activeSet.size < limits.maxConcurrent) {
      // Admit immediately
      activeSet.add(requestId);
      this.activeRequests.set(modelId, activeSet);
      this.totalAdmitted++;

      try {
        this.emit('admitted', modelId, tier);
      } catch (err) {
        this.logger?.error({ err, modelId, tier }, 'Error emitting admitted event');
      }

      this.logger?.debug(
        { modelId, requestId, tier, active: activeSet.size, limit: limits.maxConcurrent },
        'Request admitted'
      );

      return;
    }

    // At capacity, check queue depth
    const queue = this.requestQueues.get(modelId) || [];

    if (queue.length >= limits.queueDepth) {
      this.totalRejected++;

      try {
        this.emit('rejected', modelId, `Queue full (${queue.length}/${limits.queueDepth})`);
      } catch (err) {
        this.logger?.error({ err, modelId }, 'Error emitting rejected event');
      }

      throw new Error(
        `Concurrency limit reached for ${modelId} (tier: ${tier}, ` +
        `active: ${activeSet.size}/${limits.maxConcurrent}, ` +
        `queued: ${queue.length}/${limits.queueDepth}). ` +
        `Please retry later or reduce concurrent requests.`
      );
    }

    // Queue the request
    return new Promise<void>((resolve, reject) => {
      const queued: QueuedRequest = {
        requestId,
        modelId,
        enqueuedAt: Date.now(),
        timeoutMs: limits.queueTimeoutMs,
        resolve,
        reject,
      };

      // Setup timeout
      queued.timeoutHandle = setTimeout(() => {
        this.handleQueueTimeout(queued);
      }, limits.queueTimeoutMs);

      queue.push(queued);
      this.requestQueues.set(modelId, queue);
      this.totalQueued++;

      try {
        this.emit('queued', modelId, tier, queue.length);
      } catch (err) {
        this.logger?.error({ err, modelId, tier }, 'Error emitting queued event');
      }

      this.logger?.info(
        {
          modelId,
          requestId,
          tier,
          queueDepth: queue.length,
          queueLimit: limits.queueDepth,
          active: activeSet.size,
          maxConcurrent: limits.maxConcurrent,
        },
        'Request queued (at concurrency limit)'
      );
    });
  }

  /**
   * Release a concurrency slot
   *
   * @param modelId - Model identifier
   * @param requestId - Request identifier to release
   */
  public release(modelId: string, requestId: string): void {
    if (!this.enabled) {
      return;
    }

    const tier = this.detectModelTier(modelId);
    const activeSet = this.activeRequests.get(modelId);

    if (!activeSet || !activeSet.has(requestId)) {
      this.logger?.warn(
        { modelId, requestId },
        'Attempted to release non-active request'
      );
      return;
    }

    // Release the slot
    activeSet.delete(requestId);
    if (activeSet.size === 0) {
      this.activeRequests.delete(modelId);
    }

    this.totalReleased++;

    try {
      this.emit('released', modelId, tier);
    } catch (err) {
      this.logger?.error({ err, modelId, tier }, 'Error emitting released event');
    }

    this.logger?.debug(
      { modelId, requestId, tier, remainingActive: activeSet.size },
      'Request released'
    );

    // Process next queued request if any
    this.processQueue(modelId);
  }

  /**
   * Process the next queued request for a model
   */
  private processQueue(modelId: string): void {
    const queue = this.requestQueues.get(modelId);
    if (!queue || queue.length === 0) {
      return;
    }

    const tier = this.detectModelTier(modelId);
    const limits = this.tierLimits.get(tier);
    if (!limits) {
      return;
    }

    const activeSet = this.activeRequests.get(modelId) || new Set();

    // Admit next request if below limit
    if (activeSet.size < limits.maxConcurrent) {
      const next = queue.shift();
      if (next) {
        // Clear timeout
        if (next.timeoutHandle) {
          clearTimeout(next.timeoutHandle);
        }

        // Admit request
        activeSet.add(next.requestId);
        this.activeRequests.set(modelId, activeSet);
        this.totalAdmitted++;

        try {
          this.emit('admitted', modelId, tier);
        } catch (err) {
          this.logger?.error({ err, modelId, tier }, 'Error emitting admitted event');
        }

        const queueWaitMs = Date.now() - next.enqueuedAt;
        this.logger?.info(
          {
            modelId,
            requestId: next.requestId,
            tier,
            queueWaitMs,
            remainingQueue: queue.length,
          },
          'Queued request admitted'
        );

        // Resolve the acquire() promise
        next.resolve();
      }
    }
  }

  /**
   * Handle queue timeout
   */
  private handleQueueTimeout(queued: QueuedRequest): void {
    const { requestId, modelId } = queued;

    // Remove from queue
    const queue = this.requestQueues.get(modelId);
    if (queue) {
      const index = queue.findIndex((q) => q.requestId === requestId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }

    this.totalTimeouts++;

    try {
      this.emit('timeout', requestId, modelId);
    } catch (err) {
      this.logger?.error({ err, requestId, modelId }, 'Error emitting timeout event');
    }

    this.logger?.warn(
      { requestId, modelId, timeoutMs: queued.timeoutMs },
      'Queued request timed out'
    );

    queued.reject(
      new Error(
        `Request ${requestId} timed out after ${queued.timeoutMs}ms in queue ` +
        `waiting for concurrency slot (model: ${modelId})`
      )
    );
  }

  /**
   * Get current statistics
   */
  public getStats(): {
    enabled: boolean;
    totalAdmitted: number;
    totalQueued: number;
    totalReleased: number;
    totalTimeouts: number;
    totalRejected: number;
    perModelStats: Record<string, {
      tier: ModelTier;
      active: number;
      queued: number;
      maxConcurrent: number;
      queueDepth: number;
    }>;
  } {
    const perModelStats: Record<string, PerModelStatSnapshot> = {};

    for (const modelId of new Set([
      ...this.activeRequests.keys(),
      ...this.requestQueues.keys(),
    ])) {
      const tier = this.detectModelTier(modelId);
      const limits = this.tierLimits.get(tier);
      const active = this.activeRequests.get(modelId)?.size || 0;
      const queued = this.requestQueues.get(modelId)?.length || 0;

      perModelStats[modelId] = {
        tier,
        active,
        queued,
        maxConcurrent: limits?.maxConcurrent || 0,
        queueDepth: limits?.queueDepth || 0,
      };
    }

    return {
      enabled: this.enabled,
      totalAdmitted: this.totalAdmitted,
      totalQueued: this.totalQueued,
      totalReleased: this.totalReleased,
      totalTimeouts: this.totalTimeouts,
      totalRejected: this.totalRejected,
      perModelStats,
    };
  }

  /**
   * Cleanup all queued requests
   */
  public cleanup(): void {
    // Clear all timeouts
    for (const queue of this.requestQueues.values()) {
      for (const queued of queue) {
        if (queued.timeoutHandle) {
          clearTimeout(queued.timeoutHandle);
        }
        queued.reject(new Error('ModelConcurrencyLimiter shutdown'));
      }
    }

    this.activeRequests.clear();
    this.requestQueues.clear();

    this.logger?.info('ModelConcurrencyLimiter cleaned up');
  }
}
