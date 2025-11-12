/**
 * Resource Manager
 *
 * Monitors system resources (memory, GPU) and provides graceful degradation
 * under resource pressure.
 */

import * as os from 'os';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Resource limits configuration
 */
export interface ResourceLimitsConfig {
  /** Soft memory limit in GB (start warning) */
  softMemoryLimitGB: number;
  /** Hard memory limit in GB (reject requests) */
  hardMemoryLimitGB: number;
  /** Check interval in milliseconds */
  checkIntervalMs: number;
}

/**
 * Resource status
 */
export interface ResourceStatus {
  memoryUsedGB: number;
  memoryTotalGB: number;
  memoryUsagePercent: number;
  underPressure: boolean;
  shouldReject: boolean;
}

/**
 * Resource Manager
 *
 * Monitors system resources and enforces limits.
 *
 * @example
 * ```typescript
 * const resourceManager = new ResourceManager({
 *   softMemoryLimitGB: 8,
 *   hardMemoryLimitGB: 10,
 *   checkIntervalMs: 5000,
 * });
 *
 * await resourceManager.start();
 *
 * if (resourceManager.shouldRejectRequest()) {
 *   throw new Error('Resource pressure, rejecting request');
 * }
 * ```
 */
export class ResourceManager {
  private checkInterval?: NodeJS.Timeout;
  private logger: Logger;
  private currentStatus: ResourceStatus;

  constructor(private config: ResourceLimitsConfig) {
    this.logger = createLogger('ResourceManager');
    this.currentStatus = {
      memoryUsedGB: 0,
      memoryTotalGB: 0,
      memoryUsagePercent: 0,
      underPressure: false,
      shouldReject: false,
    };
  }

  /**
   * Start resource monitoring
   */
  start(): void {
    this.logger.info('Starting resource monitoring', {
      softLimitGB: this.config.softMemoryLimitGB,
      hardLimitGB: this.config.hardMemoryLimitGB,
      checkIntervalMs: this.config.checkIntervalMs,
    });

    // Initial check
    this.checkResources();

    // Periodic checks
    this.checkInterval = setInterval(() => {
      this.checkResources();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop resource monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      this.logger.info('Resource monitoring stopped');
    }
  }

  /**
   * Check current resource usage
   */
  private checkResources(): void {
    const memoryUsage = this.getCurrentMemory();
    const totalMemory = os.totalmem() / (1024 ** 3); // Convert to GB

    const memoryUsedGB = memoryUsage;
    const memoryUsagePercent = (memoryUsedGB / totalMemory) * 100;

    const underPressure = memoryUsedGB >= this.config.softMemoryLimitGB;
    const shouldReject = memoryUsedGB >= this.config.hardMemoryLimitGB;

    this.currentStatus = {
      memoryUsedGB,
      memoryTotalGB: totalMemory,
      memoryUsagePercent,
      underPressure,
      shouldReject,
    };

    if (shouldReject) {
      this.logger.error('Hard memory limit exceeded, rejecting new requests', {
        memoryUsedGB,
        hardLimitGB: this.config.hardMemoryLimitGB,
      });
    } else if (underPressure) {
      this.logger.warn('Soft memory limit exceeded, system under pressure', {
        memoryUsedGB,
        softLimitGB: this.config.softMemoryLimitGB,
      });
    } else {
      this.logger.debug('Resource check OK', {
        memoryUsedGB,
        memoryUsagePercent: memoryUsagePercent.toFixed(1) + '%',
      });
    }
  }

  /**
   * Get current memory usage in GB
   */
  getCurrentMemory(): number {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return usedMem / (1024 ** 3); // Convert to GB
  }

  /**
   * Check if new request should be rejected due to resource pressure
   */
  shouldRejectRequest(): boolean {
    return this.currentStatus.shouldReject;
  }

  /**
   * Check if system is under resource pressure
   */
  isUnderPressure(): boolean {
    return this.currentStatus.underPressure;
  }

  /**
   * Get current resource status
   */
  getStatus(): ResourceStatus {
    return { ...this.currentStatus };
  }

  /**
   * Force immediate resource check
   */
  forceCheck(): ResourceStatus {
    this.checkResources();
    return this.getStatus();
  }
}
