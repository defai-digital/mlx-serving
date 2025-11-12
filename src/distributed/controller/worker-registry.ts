/**
 * Worker Registry
 *
 * Manages worker lifecycle with model skills tracking.
 * Stores workers with their capabilities, hardware profiles, and available models.
 */

import type {
  WorkerRegistration,
  WorkerHeartbeat,
  WorkerMetrics,
  ModelSkills,
} from '../types/messages.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Extended worker information with status tracking
 */
export interface WorkerInfo {
  workerId: string;
  hostname: string;
  ip: string;
  port: number;
  skills: ModelSkills;
  status: 'online' | 'offline' | 'degraded';
  metrics?: WorkerMetrics;
  lastHeartbeat: number;
  registeredAt: number;
  priority: number;
  tags: string[];
}

/**
 * Worker Registry
 *
 * Central registry for managing worker nodes in the cluster.
 * Tracks worker status, capabilities, and metrics.
 *
 * @example
 * ```typescript
 * const registry = new WorkerRegistry();
 *
 * // Add worker
 * registry.addWorker(registration);
 *
 * // Update metrics
 * registry.updateWorker(heartbeat);
 *
 * // Query workers
 * const online = registry.getOnlineWorkers();
 * const worker = registry.getWorker(workerId);
 * ```
 */
export class WorkerRegistry {
  private workers: Map<string, WorkerInfo> = new Map();
  private logger: Logger;

  constructor() {
    this.logger = createLogger('WorkerRegistry');
  }

  /**
   * Add or update worker from registration message
   *
   * @param registration - Worker registration message with skills
   */
  addWorker(registration: WorkerRegistration): void {
    const existing = this.workers.get(registration.workerId);

    if (existing) {
      // Update existing worker (re-registration)
      this.logger.info('Worker re-registered', {
        workerId: registration.workerId,
        hostname: registration.hostname,
        modelsCount: registration.skills.availableModels.length,
      });

      existing.hostname = registration.hostname;
      existing.ip = registration.ip;
      existing.port = registration.port;
      existing.skills = registration.skills;
      existing.status = registration.status;
      existing.lastHeartbeat = registration.timestamp;
    } else {
      // Add new worker
      const workerInfo: WorkerInfo = {
        workerId: registration.workerId,
        hostname: registration.hostname,
        ip: registration.ip,
        port: registration.port,
        skills: registration.skills,
        status: registration.status,
        lastHeartbeat: registration.timestamp,
        registeredAt: registration.timestamp,
        priority: 50, // Default priority
        tags: [],
      };

      this.workers.set(registration.workerId, workerInfo);

      this.logger.info('Worker registered', {
        workerId: registration.workerId,
        hostname: registration.hostname,
        ip: registration.ip,
        modelsCount: registration.skills.availableModels.length,
        models: registration.skills.availableModels,
      });
    }
  }

  /**
   * Update worker from heartbeat message
   *
   * @param heartbeat - Worker heartbeat with metrics
   */
  updateWorker(heartbeat: WorkerHeartbeat): void {
    const worker = this.workers.get(heartbeat.workerId);

    if (!worker) {
      this.logger.warn('Heartbeat from unknown worker', {
        workerId: heartbeat.workerId,
      });
      return;
    }

    worker.status = heartbeat.status;
    worker.metrics = heartbeat.metrics;
    worker.lastHeartbeat = heartbeat.timestamp;

    this.logger.debug('Worker heartbeat received', {
      workerId: heartbeat.workerId,
      status: heartbeat.status,
      activeRequests: heartbeat.metrics.activeRequests,
    });
  }

  /**
   * Remove worker from registry
   *
   * @param workerId - Worker ID to remove
   */
  removeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);

    if (!worker) {
      this.logger.warn('Attempted to remove unknown worker', { workerId });
      return;
    }

    this.workers.delete(workerId);

    this.logger.info('Worker removed', {
      workerId,
      hostname: worker.hostname,
    });
  }

  /**
   * Mark worker as offline
   *
   * @param workerId - Worker ID to mark offline
   */
  markOffline(workerId: string): void {
    const worker = this.workers.get(workerId);

    if (!worker) {
      this.logger.warn('Attempted to mark unknown worker offline', { workerId });
      return;
    }

    if (worker.status !== 'offline') {
      worker.status = 'offline';

      this.logger.warn('Worker marked offline', {
        workerId,
        hostname: worker.hostname,
        lastHeartbeat: new Date(worker.lastHeartbeat).toISOString(),
      });
    }
  }

  /**
   * Get worker by ID
   *
   * @param workerId - Worker ID to retrieve
   * @returns Worker info or undefined if not found
   */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get all workers
   *
   * @returns Array of all workers
   */
  getAllWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get online workers only
   *
   * @returns Array of online workers
   */
  getOnlineWorkers(): WorkerInfo[] {
    return this.getAllWorkers().filter((w) => w.status === 'online');
  }

  /**
   * Get offline workers only
   *
   * @returns Array of offline workers
   */
  getOfflineWorkers(): WorkerInfo[] {
    return this.getAllWorkers().filter((w) => w.status === 'offline');
  }

  /**
   * Get total worker count
   *
   * @returns Total number of workers
   */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Get online worker count
   *
   * @returns Number of online workers
   */
  getOnlineWorkerCount(): number {
    return this.getOnlineWorkers().length;
  }

  /**
   * Check if worker exists
   *
   * @param workerId - Worker ID to check
   * @returns True if worker exists
   */
  hasWorker(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  /**
   * Clear all workers
   *
   * Useful for testing or reset scenarios
   */
  clear(): void {
    const count = this.workers.size;
    this.workers.clear();

    this.logger.info('Worker registry cleared', { count });
  }
}
