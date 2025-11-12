/**
 * Scheduler Metrics for Week 3 Priority Scheduler
 *
 * Tracks queue depth, wait times, SLA violations, and preemption statistics.
 * Provides detailed performance metrics for monitoring and optimization.
 */

import { safeAverage, safeDivide } from '@/utils/math-helpers.js';
import { PriorityLevel } from '../types/scheduling.js';
import type { RequestMetadata, SlaConfig } from '../types/scheduling.js';

/**
 * Wait time statistics
 */
export interface WaitTimeStats {
  /**
   * Average wait time in milliseconds
   */
  avg: number;

  /**
   * Median wait time in milliseconds
   */
  median: number;

  /**
   * 95th percentile wait time
   */
  p95: number;

  /**
   * 99th percentile wait time
   */
  p99: number;

  /**
   * Minimum wait time
   */
  min: number;

  /**
   * Maximum wait time
   */
  max: number;
}

/**
 * SLA violation statistics
 */
export interface SlaViolationStats {
  /**
   * Total requests completed
   */
  totalCompleted: number;

  /**
   * Number of SLA violations
   */
  violations: number;

  /**
   * Violation rate (0-1)
   */
  violationRate: number;

  /**
   * Average latency overage for violations (milliseconds)
   */
  avgOverageMs: number;

  /**
   * Maximum latency overage observed
   */
  maxOverageMs: number;
}

/**
 * Preemption statistics
 */
export interface PreemptionStats {
  /**
   * Total preemption events
   */
  totalPreemptions: number;

  /**
   * Requests currently preempted (waiting to resume)
   */
  currentlyPreempted: number;

  /**
   * Average preemption duration (milliseconds)
   */
  avgPreemptionDuration: number;

  /**
   * Preemptions by priority level
   */
  preemptionsByPriority: Record<PriorityLevel, number>;
}

/**
 * Throughput statistics
 */
export interface ThroughputStats {
  /**
   * Requests completed in last minute
   */
  requestsPerMinute: number;

  /**
   * Requests completed by priority
   */
  completedByPriority: Record<PriorityLevel, number>;

  /**
   * Average processing time (milliseconds)
   */
  avgProcessingTime: number;
}

/**
 * Starvation prevention statistics
 */
export interface StarvationStats {
  /**
   * Maximum wait time by priority
   */
  maxWaitByPriority: Record<PriorityLevel, number>;

  /**
   * Number of aging bumps (priority promotions)
   */
  agingBumps: number;

  /**
   * Fairness interventions (forced low-priority scheduling)
   */
  fairnessInterventions: number;
}

/**
 * Complete scheduler metrics
 */
export interface SchedulerMetricsSnapshot {
  /**
   * Current queue depth by priority
   */
  queueDepth: Record<PriorityLevel, number>;

  /**
   * Total queue size
   */
  totalQueueSize: number;

  /**
   * Wait time statistics by priority
   */
  waitTimes: Record<PriorityLevel, WaitTimeStats>;

  /**
   * SLA violation statistics by priority
   */
  slaViolations: Record<PriorityLevel, SlaViolationStats>;

  /**
   * Preemption statistics
   */
  preemptions: PreemptionStats;

  /**
   * Throughput statistics
   */
  throughput: ThroughputStats;

  /**
   * Starvation prevention statistics
   */
  starvation: StarvationStats;

  /**
   * Snapshot timestamp
   */
  timestamp: number;
}

/**
 * Request completion record
 */
interface CompletionRecord {
  priority: PriorityLevel;
  queuedAt: number;
  startedAt: number;
  completedAt: number;
  slaDeadline?: number;
  wasPreempted: boolean;
  preemptionDuration: number;
}

/**
 * Scheduler Metrics Collector
 *
 * Tracks and computes performance metrics for the priority scheduler.
 */
export class SchedulerMetrics {
  private queueDepthByPriority: Map<PriorityLevel, number> = new Map();
  private completionRecords: CompletionRecord[] = [];
  private readonly maxRecords = 10000; // Keep last 10k completions
  private preemptedRequests: Map<string, { priority: PriorityLevel; preemptedAt: number }> = new Map();
  private agingBumpCount = 0;
  private fairnessInterventionCount = 0;
  private completedByPriority: Map<PriorityLevel, number> = new Map();

  constructor() {
    // Initialize maps
    for (let i = 0; i <= 4; i++) {
      this.queueDepthByPriority.set(i as PriorityLevel, 0);
      this.completedByPriority.set(i as PriorityLevel, 0);
    }
  }

  /**
   * Record request queued
   */
  public recordQueued(priority: PriorityLevel): void {
    const current = this.queueDepthByPriority.get(priority) || 0;
    this.queueDepthByPriority.set(priority, current + 1);
  }

  /**
   * Record request dequeued (started execution)
   */
  public recordDequeued(priority: PriorityLevel): void {
    const current = this.queueDepthByPriority.get(priority) || 0;
    this.queueDepthByPriority.set(priority, Math.max(0, current - 1));
  }

  /**
   * Record request completed
   */
  public recordCompleted(
    metadata: RequestMetadata,
    startedAt: number,
    completedAt: number,
    slaConfig?: SlaConfig
  ): void {
    const record: CompletionRecord = {
      priority: metadata.priority,
      queuedAt: metadata.queuedAt,
      startedAt,
      completedAt,
      slaDeadline: metadata.deadline,
      wasPreempted: false,
      preemptionDuration: 0,
    };

    // Check if request was preempted
    if (this.preemptedRequests.has(metadata.id)) {
      const preemptionInfo = this.preemptedRequests.get(metadata.id)!;
      record.wasPreempted = true;
      record.preemptionDuration = startedAt - preemptionInfo.preemptedAt;
      this.preemptedRequests.delete(metadata.id);
    }

    this.completionRecords.push(record);

    // Trim old records
    if (this.completionRecords.length > this.maxRecords) {
      this.completionRecords = this.completionRecords.slice(-this.maxRecords);
    }

    // Update completed count
    const count = this.completedByPriority.get(metadata.priority) || 0;
    this.completedByPriority.set(metadata.priority, count + 1);
  }

  /**
   * Record request preempted
   */
  public recordPreempted(metadata: RequestMetadata): void {
    this.preemptedRequests.set(metadata.id, {
      priority: metadata.priority,
      preemptedAt: Date.now(),
    });
  }

  /**
   * Record aging bump (priority promotion)
   */
  public recordAgingBump(): void {
    this.agingBumpCount++;
  }

  /**
   * Record fairness intervention
   */
  public recordFairnessIntervention(): void {
    this.fairnessInterventionCount++;
  }

  /**
   * Calculate wait time statistics for a priority level
   */
  private calculateWaitTimeStats(priority: PriorityLevel): WaitTimeStats {
    const records = this.completionRecords
      .filter(r => r.priority === priority)
      .map(r => r.startedAt - r.queuedAt);

    if (records.length === 0) {
      return { avg: 0, median: 0, p95: 0, p99: 0, min: 0, max: 0 };
    }

    records.sort((a, b) => a - b);

    return {
      avg: safeAverage(records),
      median: this.percentile(records, 50),
      p95: this.percentile(records, 95),
      p99: this.percentile(records, 99),
      min: records[0],
      max: records[records.length - 1],
    };
  }

  /**
   * Calculate SLA violation statistics for a priority level
   */
  private calculateSlaViolations(
    priority: PriorityLevel,
    slaConfig?: SlaConfig
  ): SlaViolationStats {
    const records = this.completionRecords.filter(r => r.priority === priority);

    if (records.length === 0) {
      return {
        totalCompleted: 0,
        violations: 0,
        violationRate: 0,
        avgOverageMs: 0,
        maxOverageMs: 0,
      };
    }

    let violations = 0;
    let totalOverage = 0;
    let maxOverage = 0;

    for (const record of records) {
      const latency = record.completedAt - record.queuedAt;
      const deadline = record.slaDeadline || (record.queuedAt + (slaConfig?.maxLatencyMs || Infinity));

      if (latency > (slaConfig?.maxLatencyMs || Infinity)) {
        violations++;
        const overage = latency - (slaConfig?.maxLatencyMs || 0);
        totalOverage += overage;
        maxOverage = Math.max(maxOverage, overage);
      }
    }

    return {
      totalCompleted: records.length,
      violations,
      violationRate: safeDivide(violations, records.length),
      avgOverageMs: safeDivide(totalOverage, violations),
      maxOverageMs: maxOverage,
    };
  }

  /**
   * Calculate preemption statistics
   */
  private calculatePreemptionStats(): PreemptionStats {
    const preemptedRecords = this.completionRecords.filter(r => r.wasPreempted);
    const preemptionsByPriority: Record<PriorityLevel, number> = {
      [PriorityLevel.CRITICAL]: 0,
      [PriorityLevel.HIGH]: 0,
      [PriorityLevel.NORMAL]: 0,
      [PriorityLevel.LOW]: 0,
      [PriorityLevel.BACKGROUND]: 0,
    };

    for (const record of preemptedRecords) {
      preemptionsByPriority[record.priority]++;
    }

    const preemptionDurations = preemptedRecords.map(r => r.preemptionDuration);
    const avgDuration = safeAverage(preemptionDurations);

    return {
      totalPreemptions: preemptedRecords.length,
      currentlyPreempted: this.preemptedRequests.size,
      avgPreemptionDuration: avgDuration,
      preemptionsByPriority,
    };
  }

  /**
   * Calculate throughput statistics
   */
  private calculateThroughputStats(): ThroughputStats {
    const oneMinuteAgo = Date.now() - 60000;
    const recentRecords = this.completionRecords.filter(r => r.completedAt >= oneMinuteAgo);

    const completedByPriority: Record<PriorityLevel, number> = {
      [PriorityLevel.CRITICAL]: this.completedByPriority.get(PriorityLevel.CRITICAL) || 0,
      [PriorityLevel.HIGH]: this.completedByPriority.get(PriorityLevel.HIGH) || 0,
      [PriorityLevel.NORMAL]: this.completedByPriority.get(PriorityLevel.NORMAL) || 0,
      [PriorityLevel.LOW]: this.completedByPriority.get(PriorityLevel.LOW) || 0,
      [PriorityLevel.BACKGROUND]: this.completedByPriority.get(PriorityLevel.BACKGROUND) || 0,
    };

    const processingTimes = this.completionRecords.map(r => r.completedAt - r.startedAt);
    const avgProcessingTime = safeAverage(processingTimes);

    return {
      requestsPerMinute: recentRecords.length,
      completedByPriority,
      avgProcessingTime,
    };
  }

  /**
   * Calculate starvation prevention statistics
   */
  private calculateStarvationStats(): StarvationStats {
    const maxWaitByPriority: Record<PriorityLevel, number> = {
      [PriorityLevel.CRITICAL]: 0,
      [PriorityLevel.HIGH]: 0,
      [PriorityLevel.NORMAL]: 0,
      [PriorityLevel.LOW]: 0,
      [PriorityLevel.BACKGROUND]: 0,
    };

    for (let priority = 0; priority <= 4; priority++) {
      const records = this.completionRecords
        .filter(r => r.priority === priority)
        .map(r => r.startedAt - r.queuedAt);

      maxWaitByPriority[priority as PriorityLevel] = records.length > 0
        ? Math.max(...records)
        : 0;
    }

    return {
      maxWaitByPriority,
      agingBumps: this.agingBumpCount,
      fairnessInterventions: this.fairnessInterventionCount,
    };
  }

  /**
   * Get complete metrics snapshot
   */
  public getSnapshot(slaConfigs?: Record<PriorityLevel, SlaConfig>): SchedulerMetricsSnapshot {
    const queueDepth: Record<PriorityLevel, number> = {
      [PriorityLevel.CRITICAL]: this.queueDepthByPriority.get(PriorityLevel.CRITICAL) || 0,
      [PriorityLevel.HIGH]: this.queueDepthByPriority.get(PriorityLevel.HIGH) || 0,
      [PriorityLevel.NORMAL]: this.queueDepthByPriority.get(PriorityLevel.NORMAL) || 0,
      [PriorityLevel.LOW]: this.queueDepthByPriority.get(PriorityLevel.LOW) || 0,
      [PriorityLevel.BACKGROUND]: this.queueDepthByPriority.get(PriorityLevel.BACKGROUND) || 0,
    };

    const waitTimes: Record<PriorityLevel, WaitTimeStats> = {
      [PriorityLevel.CRITICAL]: this.calculateWaitTimeStats(PriorityLevel.CRITICAL),
      [PriorityLevel.HIGH]: this.calculateWaitTimeStats(PriorityLevel.HIGH),
      [PriorityLevel.NORMAL]: this.calculateWaitTimeStats(PriorityLevel.NORMAL),
      [PriorityLevel.LOW]: this.calculateWaitTimeStats(PriorityLevel.LOW),
      [PriorityLevel.BACKGROUND]: this.calculateWaitTimeStats(PriorityLevel.BACKGROUND),
    };

    const slaViolations: Record<PriorityLevel, SlaViolationStats> = {
      [PriorityLevel.CRITICAL]: this.calculateSlaViolations(PriorityLevel.CRITICAL, slaConfigs?.[PriorityLevel.CRITICAL]),
      [PriorityLevel.HIGH]: this.calculateSlaViolations(PriorityLevel.HIGH, slaConfigs?.[PriorityLevel.HIGH]),
      [PriorityLevel.NORMAL]: this.calculateSlaViolations(PriorityLevel.NORMAL, slaConfigs?.[PriorityLevel.NORMAL]),
      [PriorityLevel.LOW]: this.calculateSlaViolations(PriorityLevel.LOW, slaConfigs?.[PriorityLevel.LOW]),
      [PriorityLevel.BACKGROUND]: this.calculateSlaViolations(PriorityLevel.BACKGROUND, slaConfigs?.[PriorityLevel.BACKGROUND]),
    };

    return {
      queueDepth,
      totalQueueSize: Object.values(queueDepth).reduce((sum, v) => sum + v, 0),
      waitTimes,
      slaViolations,
      preemptions: this.calculatePreemptionStats(),
      throughput: this.calculateThroughputStats(),
      starvation: this.calculateStarvationStats(),
      timestamp: Date.now(),
    };
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.queueDepthByPriority.clear();
    this.completionRecords = [];
    this.preemptedRequests.clear();
    this.agingBumpCount = 0;
    this.fairnessInterventionCount = 0;
    this.completedByPriority.clear();

    // Re-initialize
    for (let i = 0; i <= 4; i++) {
      this.queueDepthByPriority.set(i as PriorityLevel, 0);
      this.completedByPriority.set(i as PriorityLevel, 0);
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;

    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }
}
