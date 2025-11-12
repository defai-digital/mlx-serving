/**
 * Hardware Reporter
 *
 * Wraps hardware detection and provides real-time metrics for worker heartbeats.
 */

import { detectHardware, recommendConcurrency, type HardwareProfile } from '@/core/hardware-detector.js';
import type { ModelTier } from '@/types/concurrency.js';
import { createLogger, type Logger } from '../utils/logger.js';
import * as os from 'os';

export interface WorkerCapabilities {
  maxConcurrent: number;
  supportedModelTiers: ModelTier[];
  availableMemoryGB: number;
}

export class HardwareReporter {
  private hardware: HardwareProfile;
  private capabilities: WorkerCapabilities;
  private logger: Logger;
  private lastCpuUsage: { idle: number; total: number } = { idle: 0, total: 0 };

  constructor() {
    this.logger = createLogger('HardwareReporter');

    // Detect hardware on initialization
    this.hardware = detectHardware();
    this.logger.info('Hardware detected', {
      chipModel: this.hardware.chipModel,
      gpuCores: this.hardware.gpuCores,
      memoryGB: this.hardware.unifiedMemoryGB,
    });

    // Calculate capabilities
    this.capabilities = this.calculateCapabilities();
  }

  /**
   * Get complete hardware profile
   */
  getHardwareProfile(): HardwareProfile {
    return this.hardware;
  }

  /**
   * Get worker capabilities
   */
  getCapabilities(): WorkerCapabilities {
    return this.capabilities;
  }

  /**
   * Get current CPU usage (0-100%)
   */
  async getCpuUsage(): Promise<number> {
    try {
      const cpus = os.cpus();

      // Calculate total and idle time
      let idle = 0;
      let total = 0;

      for (const cpu of cpus) {
        for (const type in cpu.times) {
          total += cpu.times[type as keyof typeof cpu.times];
        }
        idle += cpu.times.idle;
      }

      // Calculate delta from last measurement
      const idleDelta = idle - this.lastCpuUsage.idle;
      const totalDelta = total - this.lastCpuUsage.total;

      // Update last measurement
      this.lastCpuUsage = { idle, total };

      // Calculate usage percentage
      const usage = totalDelta === 0 ? 0 : 100 - Math.floor((idleDelta / totalDelta) * 100);

      return Math.max(0, Math.min(100, usage));
    } catch (error) {
      this.logger.error('Failed to get CPU usage', error as Error);
      return 0;
    }
  }

  /**
   * Get current memory usage (GB)
   */
  getMemoryUsage(): number {
    try {
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;

      // Convert to GB
      return usedMemory / (1024 * 1024 * 1024);
    } catch (error) {
      this.logger.error('Failed to get memory usage', error as Error);
      return 0;
    }
  }

  /**
   * Get GPU utilization (0-100%)
   * TODO: Implement Metal GPU monitoring
   * For now, return 0 (not implemented)
   */
  getGpuUtilization(): number {
    // TODO: Implement with Metal performance counters
    // This requires native code or calling Metal APIs
    return 0;
  }

  /**
   * Get available memory (GB)
   */
  getAvailableMemory(): number {
    try {
      const freeMemory = os.freemem();
      return freeMemory / (1024 * 1024 * 1024);
    } catch (error) {
      this.logger.error('Failed to get available memory', error as Error);
      return 0;
    }
  }

  /**
   * Calculate worker capabilities based on hardware
   */
  private calculateCapabilities(): WorkerCapabilities {
    // Get concurrency recommendations
    const recommendations = recommendConcurrency(this.hardware);

    // Determine best tier for this hardware
    const tiers: ModelTier[] = ['30B+', '13-27B', '7-13B', '3-7B', '<3B'];
    const supportedModelTiers: ModelTier[] = [];

    // Add tiers that meet minimum requirements
    if (this.hardware.gpuCores >= 30 && this.hardware.unifiedMemoryGB >= 64) {
      supportedModelTiers.push('30B+');
    }
    if (this.hardware.gpuCores >= 20 && this.hardware.unifiedMemoryGB >= 32) {
      supportedModelTiers.push('13-27B');
    }
    if (this.hardware.gpuCores >= 15 && this.hardware.unifiedMemoryGB >= 16) {
      supportedModelTiers.push('7-13B');
    }
    if (this.hardware.gpuCores >= 10 && this.hardware.unifiedMemoryGB >= 8) {
      supportedModelTiers.push('3-7B');
    }
    supportedModelTiers.push('<3B'); // All devices support small models

    // Get max concurrent for best tier
    const bestTier = supportedModelTiers[0] || '<3B';
    const maxConcurrent = recommendations[bestTier].maxConcurrent;

    // Reserve 20% of memory for system
    const availableMemoryGB = this.hardware.unifiedMemoryGB * 0.8;

    return {
      maxConcurrent,
      supportedModelTiers,
      availableMemoryGB,
    };
  }
}
