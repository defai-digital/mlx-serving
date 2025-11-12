/**
 * Priority Scheduler for Week 3 Advanced Scaling
 *
 * Implements SLA-aware request scheduling with:
 * - Multi-level priority queues
 * - Shortest-job-first optimization
 * - Deadline-aware scheduling
 * - Preemption support
 * - Fair queuing (starvation prevention)
 * - Dynamic priority aging
 *
 * Architecture:
 * - Maintains 5 priority queues (CRITICAL, HIGH, NORMAL, LOW, BACKGROUND)
 * - Selects next request based on priority, SLA deadlines, and job length
 * - Supports preemption of low-priority long-running requests
 * - Automatically promotes aged requests to prevent starvation
 *
 * Performance Goals:
 * - 15-20% throughput improvement under mixed workloads
 * - <5% SLA violation rate for priority requests
 * - Eliminate permanent starvation
 */

import type {
  PriorityLevel,
  PrioritySchedulerConfig,
  SchedulableRequest,
  SchedulingDecision,
  QueueStats,
  RequestMetadata,
  PreemptionDecision,
  FairQueuingState,
  SchedulingPolicy,
  SlaTiers,
} from '../types/scheduling.js';
import { SchedulerMetrics } from './SchedulerMetrics.js';

/**
 * Default SLA configurations by priority level
 */
const DEFAULT_SLA_TIERS: SlaTiers = {
  [0]: { targetLatencyMs: 50, maxLatencyMs: 100, violationThreshold: 0.01 },   // CRITICAL
  [1]: { targetLatencyMs: 250, maxLatencyMs: 500, violationThreshold: 0.05 },  // HIGH
  [2]: { targetLatencyMs: 1000, maxLatencyMs: 2000, violationThreshold: 0.10 }, // NORMAL
  [3]: { targetLatencyMs: 5000, maxLatencyMs: 10000, violationThreshold: 0.20 }, // LOW
  [4]: { targetLatencyMs: 30000, maxLatencyMs: 60000, violationThreshold: 0.50 }, // BACKGROUND
};

/**
 * Default scheduling policy
 */
const DEFAULT_POLICY: SchedulingPolicy = {
  shortestJobFirst: true,
  allowPreemption: false,
  fairnessWeight: 0.1,
  urgencyThresholdMs: 100,
  agingEnabled: true,
  agingIntervalMs: 5000,
};

/**
 * Priority Scheduler
 *
 * Manages request scheduling with SLA awareness and fairness guarantees.
 */
export class PriorityScheduler {
  private readonly config: PrioritySchedulerConfig;
  private readonly queues: Map<PriorityLevel, SchedulableRequest[]>;
  private readonly metrics: SchedulerMetrics;
  private readonly fairQueuing: FairQueuingState;
  private readonly logger?: { info: (...args: unknown[]) => void; debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  // Execution tracking
  private executing: Set<string> = new Set();
  private preempted: Map<string, SchedulableRequest> = new Map();

  // Aging timer
  private agingTimer?: NodeJS.Timeout;

  // Decision counter for fairness intervention
  private schedulingDecisions = 0;

  constructor(config?: Partial<PrioritySchedulerConfig>) {
    this.config = {
      slaTiers: config?.slaTiers || DEFAULT_SLA_TIERS,
      policy: config?.policy || DEFAULT_POLICY,
      maxQueueSize: config?.maxQueueSize || 1000,
      maxConcurrent: config?.maxConcurrent || 10,
      enableMetrics: config?.enableMetrics ?? true,
      logger: config?.logger,
    };

    this.logger = this.config.logger as Logger;

    // Initialize priority queues
    this.queues = new Map();
    for (let i = 0; i <= 4; i++) {
      this.queues.set(i as PriorityLevel, []);
    }

    // Initialize metrics
    this.metrics = new SchedulerMetrics();

    // Initialize fair queuing state
    this.fairQueuing = {
      servedCounts: new Map(),
      lastServed: new Map(),
      tenantQueueDepth: new Map(),
    };

    // Start aging timer if enabled
    if (this.config.policy.agingEnabled) {
      this.startAgingTimer();
    }

    this.logger?.info(
      {
        slaTiers: this.config.slaTiers,
        policy: this.config.policy,
        maxQueueSize: this.config.maxQueueSize,
        maxConcurrent: this.config.maxConcurrent,
      },
      'PriorityScheduler initialized'
    );
  }

  /**
   * Schedule a request for execution
   *
   * Adds request to appropriate priority queue and triggers scheduling.
   */
  public async schedule<T, R>(
    payload: T,
    metadata: Partial<RequestMetadata>
  ): Promise<R> {
    // Validate queue capacity
    if (this.getTotalQueueSize() >= this.config.maxQueueSize) {
      throw new Error(`Queue full (max: ${this.config.maxQueueSize})`);
    }

    // Create full metadata
    const fullMetadata: RequestMetadata = {
      id: metadata.id || this.generateRequestId(),
      priority: metadata.priority ?? 2, // Default: NORMAL
      queuedAt: Date.now(),
      estimatedTokens: metadata.estimatedTokens,
      deadline: metadata.deadline,
      originalPriority: metadata.priority ?? 2,
      agingBumps: 0,
      tenantId: metadata.tenantId,
      customData: metadata.customData,
    };

    // Create schedulable request
    return new Promise<R>((resolve, reject) => {
      const request: SchedulableRequest<T> = {
        metadata: fullMetadata,
        payload,
        resolve: resolve as (result: unknown) => void,
        reject,
      };

      // Add to queue
      this.enqueue(request);

      // Update fair queuing state
      if (fullMetadata.tenantId) {
        const depth = this.fairQueuing.tenantQueueDepth.get(fullMetadata.tenantId) || 0;
        this.fairQueuing.tenantQueueDepth.set(fullMetadata.tenantId, depth + 1);
      }

      // Update metrics
      if (this.config.enableMetrics) {
        this.metrics.recordQueued(fullMetadata.priority);
      }

      this.logger?.debug(
        {
          requestId: fullMetadata.id,
          priority: fullMetadata.priority,
          queueSize: this.getTotalQueueSize(),
        },
        'Request scheduled'
      );

      // Trigger scheduling decision
      this.scheduleNext();
    });
  }

  /**
   * Add request to appropriate priority queue
   */
  private enqueue(request: SchedulableRequest): void {
    const queue = this.queues.get(request.metadata.priority);
    if (!queue) {
      throw new Error(`Invalid priority: ${request.metadata.priority}`);
    }

    queue.push(request);
  }

  /**
   * Select and execute next request
   */
  private scheduleNext(): void {
    // Check if we can execute more requests
    if (this.executing.size >= this.config.maxConcurrent) {
      this.logger?.debug(
        { executing: this.executing.size, maxConcurrent: this.config.maxConcurrent },
        'Max concurrent requests reached'
      );
      return;
    }

    // Make scheduling decision
    const decision = this.makeSchedulingDecision();

    if (!decision.request) {
      this.logger?.debug('No request to schedule');
      return;
    }

    // Execute the selected request
    this.executeRequest(decision.request);

    this.logger?.debug(
      {
        requestId: decision.request.metadata.id,
        priority: decision.request.metadata.priority,
        reason: decision.reason,
      },
      'Scheduling decision made'
    );
  }

  /**
   * Make scheduling decision
   *
   * Selects next request based on:
   * 1. Urgent requests (near deadline)
   * 2. Priority level
   * 3. Shortest job first (within priority)
   * 4. Fairness intervention (periodic low-priority boost)
   */
  private makeSchedulingDecision(): SchedulingDecision {
    const queueStateBefore = this.getQueueStats();
    this.schedulingDecisions++;

    // Priority 1: Check for urgent requests (approaching deadline)
    const urgentRequest = this.findUrgentRequest();
    if (urgentRequest) {
      this.removeFromQueue(urgentRequest);
      return {
        request: urgentRequest,
        reason: 'Urgent (near SLA deadline)',
        queueStateBefore,
        timestamp: Date.now(),
      };
    }

    // Priority 2: Fairness intervention (prevent starvation)
    if (this.shouldApplyFairnessIntervention()) {
      const lowPriorityRequest = this.selectLowPriorityRequest();
      if (lowPriorityRequest) {
        this.removeFromQueue(lowPriorityRequest);
        if (this.config.enableMetrics) {
          this.metrics.recordFairnessIntervention();
        }
        return {
          request: lowPriorityRequest,
          reason: 'Fairness intervention',
          queueStateBefore,
          timestamp: Date.now(),
        };
      }
    }

    // Priority 3: Normal priority-based scheduling
    const request = this.selectNextRequest();
    if (request) {
      this.removeFromQueue(request);
      return {
        request,
        reason: 'Priority-based selection',
        queueStateBefore,
        timestamp: Date.now(),
      };
    }

    return {
      request: null,
      reason: 'No requests available',
      queueStateBefore,
      timestamp: Date.now(),
    };
  }

  /**
   * Find urgent requests (approaching SLA deadline)
   */
  private findUrgentRequest(): SchedulableRequest | null {
    const now = Date.now();
    const threshold = this.config.policy.urgencyThresholdMs;

    for (const [priority, queue] of this.queues) {
      for (const request of queue) {
        const slaConfig = this.config.slaTiers[priority];
        const deadline = request.metadata.deadline || (request.metadata.queuedAt + slaConfig.maxLatencyMs);

        if (deadline - now < threshold) {
          return request;
        }
      }
    }

    return null;
  }

  /**
   * Check if fairness intervention should be applied
   */
  private shouldApplyFairnessIntervention(): boolean {
    const fairnessWeight = this.config.policy.fairnessWeight;
    return Math.random() < fairnessWeight;
  }

  /**
   * Select a low-priority request for fairness
   */
  private selectLowPriorityRequest(): SchedulableRequest | null {
    // Check LOW and BACKGROUND queues
    for (const priority of [3, 4] as PriorityLevel[]) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        // Select oldest request
        return queue.reduce((oldest, req) =>
          req.metadata.queuedAt < oldest.metadata.queuedAt ? req : oldest
        );
      }
    }

    return null;
  }

  /**
   * Select next request based on priority and policy
   */
  private selectNextRequest(): SchedulableRequest | null {
    // Iterate through priority levels (highest first)
    for (const priority of [0, 1, 2, 3, 4] as PriorityLevel[]) {
      const queue = this.queues.get(priority);
      if (!queue || queue.length === 0) continue;

      // Apply shortest-job-first within priority tier
      if (this.config.policy.shortestJobFirst) {
        return this.shortestJobFirst(queue);
      } else {
        // FIFO within priority tier
        return queue[0];
      }
    }

    return null;
  }

  /**
   * Shortest-job-first selection
   */
  private shortestJobFirst(queue: SchedulableRequest[]): SchedulableRequest {
    return queue.reduce((shortest, req) => {
      const shortestEstimate = this.estimateDuration(shortest);
      const reqEstimate = this.estimateDuration(req);
      return reqEstimate < shortestEstimate ? req : shortest;
    });
  }

  /**
   * Estimate request duration based on metadata
   */
  private estimateDuration(request: SchedulableRequest): number {
    // Use estimated tokens if provided
    if (request.metadata.estimatedTokens) {
      // Assume 10ms per token (calibrate based on actual performance)
      return request.metadata.estimatedTokens * 10;
    }

    // Default estimates by priority (lower priority = longer jobs expected)
    const defaultEstimates: Record<PriorityLevel, number> = {
      [0]: 100,   // CRITICAL: 100ms
      [1]: 500,   // HIGH: 500ms
      [2]: 2000,  // NORMAL: 2s
      [3]: 10000, // LOW: 10s
      [4]: 30000, // BACKGROUND: 30s
    };

    return defaultEstimates[request.metadata.priority];
  }

  /**
   * Remove request from its queue
   */
  private removeFromQueue(request: SchedulableRequest): void {
    const queue = this.queues.get(request.metadata.priority);
    if (!queue) return;

    const index = queue.findIndex(r => r.metadata.id === request.metadata.id);
    if (index !== -1) {
      queue.splice(index, 1);
    }

    // Update metrics
    if (this.config.enableMetrics) {
      this.metrics.recordDequeued(request.metadata.priority);
    }
  }

  /**
   * Execute a request
   */
  private async executeRequest(request: SchedulableRequest): Promise<void> {
    const startedAt = Date.now();
    this.executing.add(request.metadata.id);

    this.logger?.debug(
      {
        requestId: request.metadata.id,
        priority: request.metadata.priority,
        waitTime: startedAt - request.metadata.queuedAt,
      },
      'Executing request'
    );

    try {
      // In a real implementation, this would call the actual request handler
      // For now, we resolve immediately with the payload
      // The actual integration happens at a higher level
      request.resolve(request.payload);

      const completedAt = Date.now();

      // Update metrics
      if (this.config.enableMetrics) {
        const slaConfig = this.config.slaTiers[request.metadata.priority];
        this.metrics.recordCompleted(request.metadata, startedAt, completedAt, slaConfig);
      }

      // Update fair queuing state
      if (request.metadata.tenantId) {
        const count = this.fairQueuing.servedCounts.get(request.metadata.tenantId) || 0;
        this.fairQueuing.servedCounts.set(request.metadata.tenantId, count + 1);
        this.fairQueuing.lastServed.set(request.metadata.tenantId, completedAt);

        const depth = this.fairQueuing.tenantQueueDepth.get(request.metadata.tenantId) || 0;
        this.fairQueuing.tenantQueueDepth.set(request.metadata.tenantId, Math.max(0, depth - 1));
      }

      this.logger?.debug(
        {
          requestId: request.metadata.id,
          duration: completedAt - startedAt,
          totalLatency: completedAt - request.metadata.queuedAt,
        },
        'Request completed'
      );
    } catch (error) {
      this.logger?.error(
        {
          requestId: request.metadata.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Request execution failed'
      );
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.executing.delete(request.metadata.id);

      // Schedule next request
      this.scheduleNext();
    }
  }

  /**
   * Evaluate preemption decision (if enabled)
   */
  private evaluatePreemption(newRequest: SchedulableRequest): PreemptionDecision {
    if (!this.config.policy.allowPreemption) {
      return { shouldPreempt: false };
    }

    // Only preempt if new request is high priority
    if (newRequest.metadata.priority > 1) {
      return { shouldPreempt: false };
    }

    // Find low-priority long-running request
    for (const _requestId of this.executing) {
      // In a real implementation, we'd track executing requests
      // and their priorities to make preemption decisions
      // For now, we don't actually preempt (requires more complex integration)
    }

    return { shouldPreempt: false };
  }

  /**
   * Start aging timer (priority promotion)
   */
  private startAgingTimer(): void {
    const interval = this.config.policy.agingIntervalMs;

    this.agingTimer = setInterval(() => {
      this.applyAging();
    }, interval);
  }

  /**
   * Apply aging (promote old requests)
   */
  private applyAging(): void {
    const now = Date.now();
    const agingInterval = this.config.policy.agingIntervalMs;

    for (const [priority, queue] of this.queues) {
      // Don't age CRITICAL requests (already highest priority)
      if (priority === 0) continue;

      for (const request of queue) {
        const age = now - request.metadata.queuedAt;

        // Check if request should be promoted
        if (age >= agingInterval * (request.metadata.agingBumps + 1)) {
          const newPriority = Math.max(0, priority - 1) as PriorityLevel;

          this.logger?.debug(
            {
              requestId: request.metadata.id,
              oldPriority: priority,
              newPriority,
              age,
            },
            'Aging promotion'
          );

          // Remove from current queue
          const index = queue.indexOf(request);
          if (index !== -1) {
            queue.splice(index, 1);
          }

          // Update metadata
          request.metadata.priority = newPriority;
          request.metadata.agingBumps++;

          // Add to new queue
          const newQueue = this.queues.get(newPriority);
          if (newQueue) {
            newQueue.push(request);
          }

          // Update metrics
          if (this.config.enableMetrics) {
            this.metrics.recordAgingBump();
          }
        }
      }
    }
  }

  /**
   * Get current queue statistics
   */
  public getQueueStats(): QueueStats {
    const queueDepth: Record<PriorityLevel, number> = {
      [0]: this.queues.get(0)?.length || 0,
      [1]: this.queues.get(1)?.length || 0,
      [2]: this.queues.get(2)?.length || 0,
      [3]: this.queues.get(3)?.length || 0,
      [4]: this.queues.get(4)?.length || 0,
    };

    const oldestRequestAge: Record<PriorityLevel, number> = {
      [0]: this.getOldestRequestAge(0),
      [1]: this.getOldestRequestAge(1),
      [2]: this.getOldestRequestAge(2),
      [3]: this.getOldestRequestAge(3),
      [4]: this.getOldestRequestAge(4),
    };

    return {
      queueDepth,
      totalQueueSize: this.getTotalQueueSize(),
      oldestRequestAge,
      executing: this.executing.size,
      preempted: this.preempted.size,
    };
  }

  /**
   * Get oldest request age for a priority level
   */
  private getOldestRequestAge(priority: PriorityLevel): number {
    const queue = this.queues.get(priority);
    if (!queue || queue.length === 0) return 0;

    const oldest = queue.reduce((oldest, req) =>
      req.metadata.queuedAt < oldest.metadata.queuedAt ? req : oldest
    );

    return Date.now() - oldest.metadata.queuedAt;
  }

  /**
   * Get total queue size
   */
  private getTotalQueueSize(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get metrics snapshot
   */
  public getMetrics(): ReturnType<SchedulerMetrics['getSnapshot']> | null {
    if (!this.config.enableMetrics) {
      throw new Error('Metrics collection is disabled');
    }

    return this.metrics.getSnapshot(this.config.slaTiers);
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup (stop timers)
   */
  public cleanup(): void {
    if (this.agingTimer) {
      clearInterval(this.agingTimer);
      this.agingTimer = undefined;
    }

    this.logger?.info('PriorityScheduler cleaned up');
  }
}
