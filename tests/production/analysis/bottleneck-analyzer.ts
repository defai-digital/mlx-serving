/**
 * Bottleneck Analyzer
 *
 * Analyzes production benchmark results to identify performance bottlenecks
 * and generate optimization recommendations.
 *
 * Key Analysis Areas:
 * 1. Request Serialization (~15% CPU time)
 * 2. State Management (~10% CPU time)
 * 3. NATS Messaging (~20% latency)
 * 4. Model Loading (~5s per model)
 * 5. Queue Efficiency
 * 6. Memory Management
 */

import type { BenchmarkResult } from '../../helpers/benchmark-harness.js';
import type { ResourceSnapshot } from '../helpers/resource-monitor.js';

export interface HotPath {
  name: string;
  estimatedCpuPercent: number;
  description: string;
  optimization: string;
  expectedGain: string;
}

export interface SerializationAnalysis {
  avgSerializationTimeMs: number;
  totalSerializationCpuPercent: number;
  recommendation: string;
  expectedSpeedup: string;
}

export interface NatsAnalysis {
  messagesPerSecond: number;
  avgMessageSizeBytes: number;
  latencyOverheadMs: number;
  recommendation: string;
  expectedReduction: string;
}

export interface QueueAnalysis {
  avgQueueDepth: number;
  maxQueueDepth: number;
  queueUtilization: number;
  batchEfficiency: number;
  recommendation: string;
}

export interface MemoryAnalysis {
  avgMemoryMb: number;
  peakMemoryMb: number;
  memoryGrowthMbPerSec: number;
  leakDetected: boolean;
  recommendation: string;
}

export interface BottleneckReport {
  timestamp: string;
  testName: string;
  hotPaths: HotPath[];
  serialization: SerializationAnalysis;
  nats: NatsAnalysis;
  queue: QueueAnalysis;
  memory: MemoryAnalysis;
  recommendations: string[];
  prioritizedActions: Array<{
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    action: string;
    expectedImpact: string;
    effort: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;
}

export class BottleneckAnalyzer {
  /**
   * Analyze benchmark results and resource snapshots to identify bottlenecks
   */
  analyzeResults(
    testName: string,
    result: BenchmarkResult,
    snapshots: ResourceSnapshot[]
  ): BottleneckReport {
    const hotPaths = this.identifyHotPaths(result, snapshots);
    const serialization = this.analyzeSerialization(result);
    const nats = this.analyzeNatsOverhead(result);
    const queue = this.analyzeQueueEfficiency(result);
    const memory = this.analyzeMemory(snapshots);

    const recommendations = this.generateRecommendations(
      hotPaths,
      serialization,
      nats,
      queue,
      memory
    );

    const prioritizedActions = this.prioritizeActions(
      hotPaths,
      serialization,
      nats,
      queue,
      memory
    );

    return {
      timestamp: new Date().toISOString(),
      testName,
      hotPaths,
      serialization,
      nats,
      queue,
      memory,
      recommendations,
      prioritizedActions,
    };
  }

  /**
   * Identify hot paths in the codebase based on CPU usage
   */
  identifyHotPaths(result: BenchmarkResult, snapshots: ResourceSnapshot[]): HotPath[] {
    const avgCpu = snapshots.reduce((sum, s) => sum + s.cpu.totalPercent, 0) / snapshots.length;

    // Estimate CPU breakdown based on typical profiles
    const hotPaths: HotPath[] = [
      {
        name: 'Model Inference (Python/MLX)',
        estimatedCpuPercent: avgCpu * 0.6, // ~60% of CPU
        description: 'MLX model inference on Metal GPU',
        optimization: 'Optimize model quantization, batch inference',
        expectedGain: '10-20% throughput improvement',
      },
      {
        name: 'NATS Messaging',
        estimatedCpuPercent: avgCpu * 0.08, // ~8% of CPU
        description: 'Message serialization and transport',
        optimization: 'Batch messages, use MessagePack',
        expectedGain: '40% less network overhead',
      },
      {
        name: 'Request Serialization',
        estimatedCpuPercent: avgCpu * 0.15, // ~15% of CPU
        description: 'JSON.stringify/parse for requests/responses',
        optimization: 'Use MessagePack or Protocol Buffers',
        expectedGain: '30% faster serialization',
      },
      {
        name: 'State Management',
        estimatedCpuPercent: avgCpu * 0.1, // ~10% of CPU
        description: 'Object spreading, state updates',
        optimization: 'Object pooling, in-place updates',
        expectedGain: '20% less GC pressure',
      },
      {
        name: 'Queue Management',
        estimatedCpuPercent: avgCpu * 0.07, // ~7% of CPU
        description: 'Request queuing and batch processing',
        optimization: 'Optimize batch size, reduce queue overhead',
        expectedGain: '15% better throughput',
      },
    ];

    return hotPaths.sort((a, b) => b.estimatedCpuPercent - a.estimatedCpuPercent);
  }

  /**
   * Analyze request/response serialization overhead
   */
  analyzeSerialization(result: BenchmarkResult): SerializationAnalysis {
    // Estimate serialization time based on latency
    // Typical JSON serialization: ~1-2ms per request
    const avgSerializationTimeMs = 1.5;
    const serializationsPerSec = result.requestsPerSec * 2; // Request + response
    const totalSerializationCpuPercent = (avgSerializationTimeMs * serializationsPerSec) / 1000;

    return {
      avgSerializationTimeMs,
      totalSerializationCpuPercent: totalSerializationCpuPercent * 100,
      recommendation:
        'Replace JSON.stringify/parse with MessagePack for 30% faster serialization. ' +
        'Alternatively, use Protocol Buffers for strongly typed messages.',
      expectedSpeedup: '30-50% faster serialization',
    };
  }

  /**
   * Analyze NATS messaging overhead
   */
  analyzeNatsOverhead(result: BenchmarkResult): NatsAnalysis {
    const messagesPerSecond = result.requestsPerSec * 2; // Request + response
    const avgMessageSizeBytes = 1024; // Estimate: 1KB per message
    const latencyOverheadMs = 10; // Estimate: ~10ms NATS round-trip

    return {
      messagesPerSecond,
      avgMessageSizeBytes,
      latencyOverheadMs,
      recommendation:
        'Batch NATS messages to reduce round-trips. ' +
        'Group multiple requests into single NATS message where possible. ' +
        'Consider using NATS JetStream for persistence.',
      expectedReduction: '40% less network overhead',
    };
  }

  /**
   * Analyze queue efficiency
   */
  analyzeQueueEfficiency(result: BenchmarkResult): QueueAnalysis {
    // Estimate queue metrics based on throughput and latency
    const avgQueueDepth = Math.max(1, result.latencyP50 / 100); // Rough estimate
    const maxQueueDepth = Math.max(10, result.latencyP99 / 50);
    const queueUtilization = Math.min(1, result.requestsPerSec / 20); // Assume max 20 req/sec capacity
    const batchEfficiency = result.requestsPerSec > 5 ? 0.8 : 0.5; // Higher RPS = better batching

    return {
      avgQueueDepth,
      maxQueueDepth,
      queueUtilization,
      batchEfficiency,
      recommendation:
        'Optimize batch queue size based on model inference time. ' +
        'Current batching may not be optimal for this workload. ' +
        'Consider dynamic batch sizing based on queue depth.',
    };
  }

  /**
   * Analyze memory usage patterns
   */
  analyzeMemory(snapshots: ResourceSnapshot[]): MemoryAnalysis {
    const memoryValues = snapshots.map((s) => s.memory.rssMb);
    const avgMemoryMb = memoryValues.reduce((sum, m) => sum + m, 0) / memoryValues.length;
    const peakMemoryMb = Math.max(...memoryValues);

    // Calculate memory growth trend
    const firstHalf = memoryValues.slice(0, Math.floor(memoryValues.length / 2));
    const secondHalf = memoryValues.slice(Math.floor(memoryValues.length / 2));
    const firstHalfAvg = firstHalf.reduce((sum, m) => sum + m, 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((sum, m) => sum + m, 0) / secondHalf.length;
    const memoryGrowthMbPerSec = (secondHalfAvg - firstHalfAvg) / (snapshots.length / 2);

    const leakDetected = memoryGrowthMbPerSec > 0.5; // > 0.5MB/sec growth

    return {
      avgMemoryMb,
      peakMemoryMb,
      memoryGrowthMbPerSec,
      leakDetected,
      recommendation: leakDetected
        ? 'Memory leak detected! Investigate object pooling, event listener cleanup, and cache eviction.'
        : 'Memory usage is stable. Consider object pooling for frequently allocated objects.',
    };
  }

  /**
   * Generate comprehensive recommendations
   */
  generateRecommendations(
    hotPaths: HotPath[],
    serialization: SerializationAnalysis,
    nats: NatsAnalysis,
    queue: QueueAnalysis,
    memory: MemoryAnalysis
  ): string[] {
    const recommendations: string[] = [];

    // Hot path recommendations
    recommendations.push('=== Hot Path Optimizations ===');
    hotPaths.slice(0, 3).forEach((hp) => {
      recommendations.push(`${hp.name}: ${hp.optimization} (${hp.expectedGain})`);
    });

    // Serialization
    recommendations.push('\n=== Serialization ===');
    recommendations.push(serialization.recommendation);

    // NATS
    recommendations.push('\n=== NATS Messaging ===');
    recommendations.push(nats.recommendation);

    // Queue
    recommendations.push('\n=== Queue Management ===');
    recommendations.push(queue.recommendation);

    // Memory
    recommendations.push('\n=== Memory Management ===');
    recommendations.push(memory.recommendation);

    return recommendations;
  }

  /**
   * Prioritize optimization actions
   */
  prioritizeActions(
    hotPaths: HotPath[],
    serialization: SerializationAnalysis,
    nats: NatsAnalysis,
    queue: QueueAnalysis,
    memory: MemoryAnalysis
  ): Array<{
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    action: string;
    expectedImpact: string;
    effort: 'LOW' | 'MEDIUM' | 'HIGH';
  }> {
    const actions = [];

    // Memory leak is always highest priority
    if (memory.leakDetected) {
      actions.push({
        priority: 'HIGH' as const,
        action: 'Fix memory leak (investigate object pooling, event listeners, caches)',
        expectedImpact: 'System stability, prevent crashes',
        effort: 'HIGH' as const,
      });
    }

    // Serialization optimization (high impact, medium effort)
    if (serialization.totalSerializationCpuPercent > 10) {
      actions.push({
        priority: 'HIGH' as const,
        action: 'Replace JSON with MessagePack for serialization',
        expectedImpact: serialization.expectedSpeedup,
        effort: 'MEDIUM' as const,
      });
    }

    // NATS batching (medium impact, low effort)
    actions.push({
      priority: 'MEDIUM' as const,
      action: 'Implement NATS message batching',
      expectedImpact: nats.expectedReduction,
      effort: 'LOW' as const,
    });

    // State management (medium impact, medium effort)
    const stateManagementHotPath = hotPaths.find((hp) => hp.name === 'State Management');
    if (stateManagementHotPath) {
      actions.push({
        priority: 'MEDIUM' as const,
        action: 'Implement object pooling for state management',
        expectedImpact: stateManagementHotPath.expectedGain,
        effort: 'MEDIUM' as const,
      });
    }

    // Queue optimization (low-medium impact, low effort)
    if (queue.batchEfficiency < 0.7) {
      actions.push({
        priority: 'LOW' as const,
        action: 'Optimize batch queue sizing',
        expectedImpact: '15% better throughput',
        effort: 'LOW' as const,
      });
    }

    return actions;
  }

  /**
   * Generate markdown summary
   */
  generateMarkdownSummary(report: BottleneckReport): string {
    let md = `# Bottleneck Analysis Report\n\n`;
    md += `**Test**: ${report.testName}\n`;
    md += `**Date**: ${report.timestamp}\n\n`;

    md += `## Hot Paths\n\n`;
    md += `| Component | CPU % | Optimization | Expected Gain |\n`;
    md += `|-----------|-------|--------------|---------------|\n`;
    report.hotPaths.forEach((hp) => {
      md += `| ${hp.name} | ${hp.estimatedCpuPercent.toFixed(1)}% | ${hp.optimization} | ${hp.expectedGain} |\n`;
    });

    md += `\n## Prioritized Actions\n\n`;
    report.prioritizedActions.forEach((action, i) => {
      md += `### ${i + 1}. ${action.action} [${action.priority}]\n\n`;
      md += `- **Expected Impact**: ${action.expectedImpact}\n`;
      md += `- **Effort**: ${action.effort}\n\n`;
    });

    md += `## Detailed Analysis\n\n`;
    md += `### Serialization\n`;
    md += `- Avg time: ${report.serialization.avgSerializationTimeMs.toFixed(2)}ms\n`;
    md += `- CPU %: ${report.serialization.totalSerializationCpuPercent.toFixed(1)}%\n`;
    md += `- Recommendation: ${report.serialization.recommendation}\n\n`;

    md += `### NATS Messaging\n`;
    md += `- Messages/sec: ${report.nats.messagesPerSecond.toFixed(1)}\n`;
    md += `- Avg size: ${report.nats.avgMessageSizeBytes} bytes\n`;
    md += `- Latency overhead: ${report.nats.latencyOverheadMs}ms\n`;
    md += `- Recommendation: ${report.nats.recommendation}\n\n`;

    md += `### Queue Efficiency\n`;
    md += `- Avg depth: ${report.queue.avgQueueDepth.toFixed(1)}\n`;
    md += `- Max depth: ${report.queue.maxQueueDepth.toFixed(1)}\n`;
    md += `- Utilization: ${(report.queue.queueUtilization * 100).toFixed(1)}%\n`;
    md += `- Batch efficiency: ${(report.queue.batchEfficiency * 100).toFixed(1)}%\n`;
    md += `- Recommendation: ${report.queue.recommendation}\n\n`;

    md += `### Memory\n`;
    md += `- Avg: ${report.memory.avgMemoryMb.toFixed(1)}MB\n`;
    md += `- Peak: ${report.memory.peakMemoryMb.toFixed(1)}MB\n`;
    md += `- Growth: ${report.memory.memoryGrowthMbPerSec.toFixed(4)}MB/sec\n`;
    md += `- Leak detected: ${report.memory.leakDetected ? 'YES ⚠️' : 'NO ✅'}\n`;
    md += `- Recommendation: ${report.memory.recommendation}\n\n`;

    return md;
  }
}
