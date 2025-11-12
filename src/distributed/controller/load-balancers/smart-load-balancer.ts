/**
 * Smart Load Balancer
 *
 * 3-phase worker selection algorithm:
 * Phase 0: Check session affinity (if enabled and session exists)
 * Phase 1: Filter by skills (which models worker can serve)
 * Phase 2: Filter by hardware (GPU memory requirements)
 * Phase 3: Sort by load (prefer less loaded workers)
 *
 * Final selection: Round-robin among least loaded workers
 */

import type { WorkerInfo } from '../worker-registry.js';
import type { InferenceRequest } from '../../types/messages.js';
import { SessionRegistry } from '../session-registry.js';
import { createLogger, type Logger } from '../../utils/logger.js';

/**
 * Load balancer interface
 */
export interface LoadBalancer {
  selectWorker(workers: WorkerInfo[], request: InferenceRequest, sessionId?: string): WorkerInfo;
  reset(): void;
}

/**
 * Smart Load Balancer Options
 */
export interface SmartLoadBalancerOptions {
  /** Enable session affinity */
  enableSessionAffinity?: boolean;
  /** Session affinity TTL (ms) */
  sessionTtlMs?: number;
  /** Session cleanup interval (ms) */
  sessionCleanupIntervalMs?: number;
}

/**
 * Smart Load Balancer
 *
 * Selects workers based on:
 * 0. Session Affinity: If sessionId provided, route to same worker
 * 1. Skills: Worker must have the requested model
 * 2. Hardware: Worker should have enough GPU memory (preferred)
 * 3. Load: Prefer worker with fewer active requests
 * 4. Round-robin: Break ties with round-robin
 *
 * @example
 * ```typescript
 * const balancer = new SmartLoadBalancer({
 *   enableSessionAffinity: true,
 *   sessionTtlMs: 1800000, // 30 minutes
 * });
 * const worker = balancer.selectWorker(workers, request, sessionId);
 * ```
 */
export class SmartLoadBalancer implements LoadBalancer {
  private currentIndex = 0;
  private logger: Logger;
  private sessionRegistry?: SessionRegistry;
  private options: SmartLoadBalancerOptions;

  constructor(options: SmartLoadBalancerOptions = {}) {
    this.options = {
      enableSessionAffinity: options.enableSessionAffinity ?? false,
      sessionTtlMs: options.sessionTtlMs !== undefined ? options.sessionTtlMs : 1800000, // 30 minutes
      sessionCleanupIntervalMs: options.sessionCleanupIntervalMs !== undefined ? options.sessionCleanupIntervalMs : 60000, // 1 minute
    };

    this.logger = createLogger('SmartLoadBalancer');

    // Initialize session registry if enabled
    if (this.options.enableSessionAffinity) {
      const ttlMs = this.options.sessionTtlMs!;
      const cleanupIntervalMs = this.options.sessionCleanupIntervalMs!;

      this.sessionRegistry = new SessionRegistry({
        ttlMs,
        cleanupIntervalMs,
      });
      this.logger.info('Session affinity enabled', {
        ttlMs,
      });
    }
  }

  /**
   * Select best worker for request using 4-phase algorithm
   *
   * @param workers - All available workers
   * @param request - Inference request
   * @param sessionId - Optional session ID for sticky routing
   * @returns Selected worker
   * @throws {Error} if no workers available or no workers can serve model
   */
  selectWorker(workers: WorkerInfo[], request: InferenceRequest, sessionId?: string): WorkerInfo {
    // Phase 0: Check session affinity
    if (sessionId && this.sessionRegistry) {
      const affinityWorkerId = this.sessionRegistry.getSession(sessionId);

      if (affinityWorkerId) {
        // Find worker in current worker list
        const affinityWorker = workers.find(
          (w) => w.workerId === affinityWorkerId && w.status === 'online'
        );

        if (affinityWorker) {
          this.logger.info('Using session affinity', {
            sessionId,
            workerId: affinityWorkerId,
            hostname: affinityWorker.hostname,
          });
          return affinityWorker;
        } else {
          // Worker is offline or not found - fallback to normal selection
          this.logger.warn('Session affinity worker not available, failing over', {
            sessionId,
            workerId: affinityWorkerId,
          });
          this.sessionRegistry.removeSession(sessionId);
        }
      }
    }
    // Filter to online workers only
    const onlineWorkers = workers.filter((w) => w.status === 'online');

    if (onlineWorkers.length === 0) {
      this.logger.error('No online workers available', {
        totalWorkers: workers.length,
      });
      throw new Error('No online workers available');
    }

    // Phase 1: Filter by skills (can serve this model?)
    const skilledWorkers = onlineWorkers.filter((w) =>
      w.skills.availableModels.includes(request.modelId)
    );

    if (skilledWorkers.length === 0) {
      this.logger.error('No workers can serve model', {
        model: request.modelId,
        onlineWorkers: onlineWorkers.length,
        availableModels: this.collectAvailableModels(onlineWorkers),
      });
      throw new Error(`No workers can serve model: ${request.modelId}`);
    }

    this.logger.debug('Phase 1: Skills filtering', {
      model: request.modelId,
      onlineWorkers: onlineWorkers.length,
      skilledWorkers: skilledWorkers.length,
    });

    // Phase 2: Filter by hardware (enough GPU memory?)
    const estimatedMemory = this.estimateModelMemory(request.modelId);
    const capableWorkers = skilledWorkers.filter((w) => {
      // If worker has no metrics, assume it's capable
      if (!w.metrics) return true;

      // Check if worker has enough available GPU memory
      // This is a rough estimate - in production, you'd want more precise tracking
      return true; // TODO: Implement GPU memory tracking
    });

    const eligibleWorkers = capableWorkers.length > 0 ? capableWorkers : skilledWorkers;

    this.logger.debug('Phase 2: Hardware filtering', {
      estimatedMemoryGB: estimatedMemory,
      skilledWorkers: skilledWorkers.length,
      capableWorkers: capableWorkers.length,
      eligibleWorkers: eligibleWorkers.length,
    });

    // Phase 3: Sort by load (prefer less loaded workers)
    const sortedByLoad = [...eligibleWorkers].sort((a, b) => {
      const loadA = a.metrics?.activeRequests ?? 0;
      const loadB = b.metrics?.activeRequests ?? 0;
      return loadA - loadB;
    });

    // Select least loaded worker (or round-robin among tied workers)
    const minLoad = sortedByLoad[0].metrics?.activeRequests ?? 0;
    const leastLoadedWorkers = sortedByLoad.filter(
      (w) => (w.metrics?.activeRequests ?? 0) === minLoad
    );

    this.logger.debug('Phase 3: Load-based selection', {
      minLoad,
      leastLoadedWorkersCount: leastLoadedWorkers.length,
    });

    // Round-robin among least loaded workers
    const selected = leastLoadedWorkers[this.currentIndex % leastLoadedWorkers.length];
    this.currentIndex++;

    // Create session affinity if session ID provided
    if (sessionId && this.sessionRegistry) {
      this.sessionRegistry.setSession(sessionId, selected.workerId);
      this.logger.debug('Session affinity created', {
        sessionId,
        workerId: selected.workerId,
      });
    }

    this.logger.info('Worker selected', {
      workerId: selected.workerId,
      hostname: selected.hostname,
      activeRequests: selected.metrics?.activeRequests ?? 0,
      model: request.modelId,
      sessionAffinity: sessionId ? 'created' : 'none',
      selectionPhases: {
        onlineWorkers: onlineWorkers.length,
        skilledWorkers: skilledWorkers.length,
        eligibleWorkers: eligibleWorkers.length,
        leastLoadedWorkers: leastLoadedWorkers.length,
      },
    });

    return selected;
  }

  /**
   * Remove sessions for offline worker
   *
   * @param workerId - Worker ID
   * @returns Number of sessions removed
   */
  removeSessionsForWorker(workerId: string): number {
    if (!this.sessionRegistry) {
      return 0;
    }
    return this.sessionRegistry.removeSessionsByWorker(workerId);
  }

  /**
   * Get session registry stats
   */
  getSessionStats(): ReturnType<NonNullable<typeof this.sessionRegistry>['getStats']> | undefined {
    return this.sessionRegistry?.getStats();
  }

  /**
   * Estimate model memory requirements from model name
   *
   * Rough heuristics based on common model sizes:
   * - 3B models: ~4GB
   * - 7B models: ~8GB
   * - 13B models: ~16GB
   * - 30B models: ~32GB
   *
   * @param modelName - Model name (e.g., "mlx-community/Llama-3.2-3B-Instruct-4bit")
   * @returns Estimated memory in GB
   */
  private estimateModelMemory(modelName: string): number {
    // Extract model size from name
    const lowerName = modelName.toLowerCase();

    // Check for explicit size indicators
    if (lowerName.includes('3b')) return 4;
    if (lowerName.includes('7b')) return 8;
    if (lowerName.includes('13b')) return 16;
    if (lowerName.includes('30b')) return 32;
    if (lowerName.includes('70b')) return 64;

    // Check for smaller models
    if (lowerName.includes('1b')) return 2;
    if (lowerName.includes('0.5b')) return 1;

    // Default assumption for unknown models
    return 8;
  }

  /**
   * Collect all available models from workers (for debugging)
   *
   * @param workers - Workers to collect models from
   * @returns Array of unique model names
   */
  private collectAvailableModels(workers: WorkerInfo[]): string[] {
    const models = new Set<string>();

    for (const worker of workers) {
      for (const model of worker.skills.availableModels) {
        models.add(model);
      }
    }

    return Array.from(models);
  }

  /**
   * Reset round-robin index
   *
   * Useful for testing or when you want to restart the rotation
   */
  reset(): void {
    this.currentIndex = 0;
    this.logger.debug('Load balancer reset');
  }
}
