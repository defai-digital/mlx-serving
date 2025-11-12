/**
 * Resource Monitor
 *
 * Tracks CPU, memory, and GPU usage during production testing.
 * Provides periodic snapshots and analysis of resource consumption.
 */

export interface MemoryStats {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
}

export interface CpuStats {
  userPercent: number;
  systemPercent: number;
  totalPercent: number;
}

export interface GpuStats {
  utilizationPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureCelsius: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  memory: MemoryStats;
  cpu: CpuStats;
  gpu?: GpuStats;
}

/**
 * Resource monitoring utility for production testing
 */
export class ResourceMonitor {
  private snapshots: ResourceSnapshot[] = [];
  private monitoringInterval?: NodeJS.Timeout;
  private startTime: number = 0;
  private lastCpuUsage?: NodeJS.CpuUsage;

  /**
   * Start monitoring resources at specified interval
   */
  startMonitoring(intervalMs: number = 1000): void {
    this.startTime = Date.now();
    this.lastCpuUsage = process.cpuUsage();

    // Take initial snapshot
    this.snapshots.push(this.captureSnapshot());

    // Setup periodic monitoring
    this.monitoringInterval = setInterval(() => {
      this.snapshots.push(this.captureSnapshot());
    }, intervalMs);

    console.log(`Resource monitoring started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      console.log(`Resource monitoring stopped (${this.snapshots.length} snapshots)`);
    }
  }

  /**
   * Get latest snapshot
   */
  getSnapshot(): ResourceSnapshot {
    return this.captureSnapshot();
  }

  /**
   * Get all collected snapshots
   */
  getAllSnapshots(): ResourceSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Get current CPU usage as percentage
   */
  getCpuUsage(): CpuStats {
    const currentUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();

    // Convert microseconds to percentage
    const totalUs = currentUsage.user + currentUsage.system;
    const elapsedMs = 1000; // Assume 1 second between calls
    const totalPercent = (totalUs / 1000 / elapsedMs) * 100;

    return {
      userPercent: (currentUsage.user / 1000 / elapsedMs) * 100,
      systemPercent: (currentUsage.system / 1000 / elapsedMs) * 100,
      totalPercent: Math.min(100, totalPercent),
    };
  }

  /**
   * Get current memory usage
   */
  getMemoryUsage(): MemoryStats {
    const usage = process.memoryUsage();

    return {
      heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
      rssMb: Math.round(usage.rss / 1024 / 1024),
      externalMb: Math.round(usage.external / 1024 / 1024),
    };
  }

  /**
   * Get GPU usage (placeholder - Metal API not available in Node.js)
   */
  getGpuUsage(): GpuStats | undefined {
    // Note: Metal GPU profiling requires native bindings or external tools
    // For now, return undefined. In future, could integrate with:
    // - Metal Performance HUD
    // - powermetrics CLI
    // - Native Metal bindings
    return undefined;
  }

  /**
   * Analyze resource usage trends
   */
  analyzeUsage(): {
    memory: { avgMb: number; peakMb: number; trendMbPerSec: number };
    cpu: { avgPercent: number; peakPercent: number };
  } {
    if (this.snapshots.length === 0) {
      return {
        memory: { avgMb: 0, peakMb: 0, trendMbPerSec: 0 },
        cpu: { avgPercent: 0, peakPercent: 0 },
      };
    }

    // Memory analysis
    const memoryUsages = this.snapshots.map(s => s.memory.rssMb);
    const avgMemoryMb = memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length;
    const peakMemoryMb = Math.max(...memoryUsages);

    // Calculate memory trend (MB/sec)
    const durationSec = (Date.now() - this.startTime) / 1000;
    const memoryChange = memoryUsages[memoryUsages.length - 1] - memoryUsages[0];
    const memoryTrend = memoryChange / durationSec;

    // CPU analysis
    const cpuUsages = this.snapshots.map(s => s.cpu.totalPercent);
    const avgCpuPercent = cpuUsages.reduce((a, b) => a + b, 0) / cpuUsages.length;
    const peakCpuPercent = Math.max(...cpuUsages);

    return {
      memory: {
        avgMb: Math.round(avgMemoryMb),
        peakMb: peakMemoryMb,
        trendMbPerSec: parseFloat(memoryTrend.toFixed(2)),
      },
      cpu: {
        avgPercent: parseFloat(avgCpuPercent.toFixed(1)),
        peakPercent: parseFloat(peakCpuPercent.toFixed(1)),
      },
    };
  }

  /**
   * Reset all collected data
   */
  reset(): void {
    this.snapshots = [];
    this.startTime = Date.now();
    this.lastCpuUsage = process.cpuUsage();
  }

  /**
   * Capture current resource snapshot
   */
  private captureSnapshot(): ResourceSnapshot {
    return {
      timestamp: Date.now(),
      memory: this.getMemoryUsage(),
      cpu: this.getCpuUsage(),
      gpu: this.getGpuUsage(),
    };
  }
}
