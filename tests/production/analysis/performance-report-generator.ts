/**
 * Performance Report Generator
 *
 * Generates comprehensive production performance reports from benchmark results.
 *
 * Report Sections:
 * 1. Executive Summary
 * 2. Baseline Metrics (throughput, latency, error rate)
 * 3. Load Test Results (sustained, spike, stress, soak)
 * 4. SLA Compliance (p50: 5s, p95: 12s, p99: 20s)
 * 5. Resource Usage (CPU, memory, GPU)
 * 6. Bottleneck Analysis
 * 7. Prioritized Recommendations
 */

import type { BenchmarkResult } from '../../helpers/benchmark-harness.js';
import type { ResourceSnapshot } from '../helpers/resource-monitor.js';
import type { BottleneckReport } from './bottleneck-analyzer.js';
import { BottleneckAnalyzer } from './bottleneck-analyzer.js';

export interface BaselineMetrics {
  throughputReqSec: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  errorRate: number;
  successRate: number;
  totalRequests: number;
}

export interface LoadTestResult {
  testName: string;
  duration: string;
  model: string;
  targetRps: number;
  actualRps: number;
  totalRequests: number;
  errorRate: number;
  latencyP95Ms: number;
  memoryTrendMbPerSec: number;
  status: 'PASS' | 'FAIL';
  issues: string[];
}

export interface SLAReport {
  p50Target: number;
  p50Actual: number;
  p50Compliant: boolean;
  p95Target: number;
  p95Actual: number;
  p95Compliant: boolean;
  p99Target: number;
  p99Actual: number;
  p99Compliant: boolean;
  errorRateTarget: number;
  errorRateActual: number;
  errorRateCompliant: boolean;
  overallCompliant: boolean;
}

export interface ResourceReport {
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  memoryGrowthMbPerSec: number;
  memoryLeakDetected: boolean;
}

export interface Recommendation {
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'Performance' | 'Reliability' | 'Resource' | 'Architecture';
  recommendation: string;
  expectedImpact: string;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface ProductionReport {
  generatedAt: string;
  version: string;
  summary: {
    totalTests: number;
    testsPassedCount: number;
    testsFailedCount: number;
    overallStatus: 'PRODUCTION_READY' | 'NEEDS_ATTENTION' | 'NOT_READY';
  };
  baseline: BaselineMetrics;
  loadTests: LoadTestResult[];
  slaCompliance: SLAReport;
  resourceUsage: ResourceReport;
  bottlenecks: BottleneckReport;
  recommendations: Recommendation[];
}

export class PerformanceReportGenerator {
  private analyzer = new BottleneckAnalyzer();

  /**
   * Generate comprehensive production report
   */
  generateReport(
    baselineResult: BenchmarkResult,
    loadTestResults: Array<{ name: string; result: BenchmarkResult; snapshots: ResourceSnapshot[]; model: string; targetRps: number }>,
    snapshots: ResourceSnapshot[]
  ): ProductionReport {
    const baseline = this.extractBaselineMetrics(baselineResult);
    const loadTests = this.processLoadTests(loadTestResults);
    const slaCompliance = this.calculateSLACompliance(baselineResult);
    const resourceUsage = this.analyzeResourceUsage(snapshots);
    const bottlenecks = this.analyzer.analyzeResults('Production Baseline', baselineResult, snapshots);
    const recommendations = this.generateRecommendations(
      loadTests,
      slaCompliance,
      resourceUsage,
      bottlenecks
    );

    const testsPassedCount = loadTests.filter((lt) => lt.status === 'PASS').length;
    const testsFailedCount = loadTests.filter((lt) => lt.status === 'FAIL').length;
    const overallStatus = this.determineOverallStatus(
      testsPassedCount,
      testsFailedCount,
      slaCompliance,
      resourceUsage
    );

    return {
      generatedAt: new Date().toISOString(),
      version: '0.8.0',
      summary: {
        totalTests: loadTests.length,
        testsPassedCount,
        testsFailedCount,
        overallStatus,
      },
      baseline,
      loadTests,
      slaCompliance,
      resourceUsage,
      bottlenecks,
      recommendations,
    };
  }

  /**
   * Extract baseline metrics from benchmark result
   */
  private extractBaselineMetrics(result: BenchmarkResult): BaselineMetrics {
    return {
      throughputReqSec: result.requestsPerSec,
      latencyP50Ms: result.latencyP50,
      latencyP95Ms: result.latencyP95,
      latencyP99Ms: result.latencyP99,
      errorRate: result.errorRate,
      successRate: result.successfulRequests / result.totalRequests,
      totalRequests: result.totalRequests,
    };
  }

  /**
   * Process load test results
   */
  private processLoadTests(
    loadTestResults: Array<{ name: string; result: BenchmarkResult; snapshots: ResourceSnapshot[]; model: string; targetRps: number }>
  ): LoadTestResult[] {
    return loadTestResults.map(({ name, result, snapshots, model, targetRps }) => {
      const memoryValues = snapshots.map((s) => s.memory.rssMb);
      const firstHalf = memoryValues.slice(0, Math.floor(memoryValues.length / 2));
      const secondHalf = memoryValues.slice(Math.floor(memoryValues.length / 2));
      const firstHalfAvg = firstHalf.reduce((sum, m) => sum + m, 0) / firstHalf.length;
      const secondHalfAvg = secondHalf.reduce((sum, m) => sum + m, 0) / secondHalf.length;
      const memoryTrendMbPerSec = (secondHalfAvg - firstHalfAvg) / (snapshots.length / 2);

      const issues: string[] = [];
      if (result.errorRate > 0.15) issues.push(`High error rate: ${(result.errorRate * 100).toFixed(1)}%`);
      if (memoryTrendMbPerSec > 0.5) issues.push(`Memory leak detected: ${memoryTrendMbPerSec.toFixed(4)}MB/sec`);
      if (result.latencyP95 > 15000) issues.push(`High p95 latency: ${result.latencyP95.toFixed(0)}ms`);

      const status: 'PASS' | 'FAIL' = issues.length === 0 ? 'PASS' : 'FAIL';

      return {
        testName: name,
        duration: this.formatDuration(result.durationMs),
        model,
        targetRps,
        actualRps: result.requestsPerSec,
        totalRequests: result.totalRequests,
        errorRate: result.errorRate,
        latencyP95Ms: result.latencyP95,
        memoryTrendMbPerSec,
        status,
        issues,
      };
    });
  }

  /**
   * Calculate SLA compliance
   */
  private calculateSLACompliance(result: BenchmarkResult): SLAReport {
    const SLA = {
      p50Target: 5000, // 5s
      p95Target: 12000, // 12s
      p99Target: 20000, // 20s
      errorRateTarget: 0.05, // 5%
    };

    const p50Compliant = result.latencyP50 <= SLA.p50Target;
    const p95Compliant = result.latencyP95 <= SLA.p95Target;
    const p99Compliant = result.latencyP99 <= SLA.p99Target;
    const errorRateCompliant = result.errorRate <= SLA.errorRateTarget;
    const overallCompliant = p50Compliant && p95Compliant && p99Compliant && errorRateCompliant;

    return {
      p50Target: SLA.p50Target,
      p50Actual: result.latencyP50,
      p50Compliant,
      p95Target: SLA.p95Target,
      p95Actual: result.latencyP95,
      p95Compliant,
      p99Target: SLA.p99Target,
      p99Actual: result.latencyP99,
      p99Compliant,
      errorRateTarget: SLA.errorRateTarget,
      errorRateActual: result.errorRate,
      errorRateCompliant,
      overallCompliant,
    };
  }

  /**
   * Analyze resource usage
   */
  private analyzeResourceUsage(snapshots: ResourceSnapshot[]): ResourceReport {
    const cpuValues = snapshots.map((s) => s.cpu.totalPercent);
    const memoryValues = snapshots.map((s) => s.memory.rssMb);

    const avgCpuPercent = cpuValues.reduce((sum, c) => sum + c, 0) / cpuValues.length;
    const peakCpuPercent = Math.max(...cpuValues);
    const avgMemoryMb = memoryValues.reduce((sum, m) => sum + m, 0) / memoryValues.length;
    const peakMemoryMb = Math.max(...memoryValues);

    const firstHalf = memoryValues.slice(0, Math.floor(memoryValues.length / 2));
    const secondHalf = memoryValues.slice(Math.floor(memoryValues.length / 2));
    const firstHalfAvg = firstHalf.reduce((sum, m) => sum + m, 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((sum, m) => sum + m, 0) / secondHalf.length;
    const memoryGrowthMbPerSec = (secondHalfAvg - firstHalfAvg) / (snapshots.length / 2);
    const memoryLeakDetected = memoryGrowthMbPerSec > 0.5;

    return {
      avgCpuPercent,
      peakCpuPercent,
      avgMemoryMb,
      peakMemoryMb,
      memoryGrowthMbPerSec,
      memoryLeakDetected,
    };
  }

  /**
   * Generate prioritized recommendations
   */
  private generateRecommendations(
    loadTests: LoadTestResult[],
    slaCompliance: SLAReport,
    resourceUsage: ResourceReport,
    bottlenecks: BottleneckReport
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Memory leak (CRITICAL)
    if (resourceUsage.memoryLeakDetected) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'Reliability',
        recommendation:
          'Memory leak detected. Investigate object pooling, event listener cleanup, and cache eviction.',
        expectedImpact: 'Prevent crashes and improve system stability',
        effort: 'HIGH',
      });
    }

    // SLA violations (HIGH)
    if (!slaCompliance.overallCompliant) {
      if (!slaCompliance.p95Compliant) {
        recommendations.push({
          priority: 'HIGH',
          category: 'Performance',
          recommendation: `p95 latency exceeds SLA (${slaCompliance.p95Actual.toFixed(0)}ms > ${slaCompliance.p95Target}ms). Optimize hot paths.`,
          expectedImpact: 'Meet SLA requirements',
          effort: 'MEDIUM',
        });
      }
      if (!slaCompliance.errorRateCompliant) {
        recommendations.push({
          priority: 'HIGH',
          category: 'Reliability',
          recommendation: `Error rate exceeds SLA (${(slaCompliance.errorRateActual * 100).toFixed(1)}% > ${slaCompliance.errorRateTarget * 100}%). Improve error handling.`,
          expectedImpact: 'Reduce failures and improve reliability',
          effort: 'MEDIUM',
        });
      }
    }

    // Load test failures (HIGH)
    const failedTests = loadTests.filter((lt) => lt.status === 'FAIL');
    if (failedTests.length > 0) {
      failedTests.forEach((test) => {
        recommendations.push({
          priority: 'HIGH',
          category: 'Reliability',
          recommendation: `${test.testName} failed: ${test.issues.join(', ')}`,
          expectedImpact: 'Improve production readiness',
          effort: 'MEDIUM',
        });
      });
    }

    // Bottleneck recommendations (MEDIUM)
    bottlenecks.prioritizedActions.forEach((action) => {
      const priority = action.priority === 'HIGH' ? 'HIGH' : action.priority === 'MEDIUM' ? 'MEDIUM' : 'LOW';
      recommendations.push({
        priority: priority as 'HIGH' | 'MEDIUM' | 'LOW',
        category: 'Performance',
        recommendation: action.action,
        expectedImpact: action.expectedImpact,
        effort: action.effort,
      });
    });

    // Sort by priority
    const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * Determine overall production readiness status
   */
  private determineOverallStatus(
    testsPassedCount: number,
    testsFailedCount: number,
    slaCompliance: SLAReport,
    resourceUsage: ResourceReport
  ): 'PRODUCTION_READY' | 'NEEDS_ATTENTION' | 'NOT_READY' {
    // Critical issues = NOT_READY
    if (resourceUsage.memoryLeakDetected) return 'NOT_READY';
    if (testsFailedCount > testsPassedCount) return 'NOT_READY';

    // SLA violations or test failures = NEEDS_ATTENTION
    if (!slaCompliance.overallCompliant) return 'NEEDS_ATTENTION';
    if (testsFailedCount > 0) return 'NEEDS_ATTENTION';

    // Otherwise = PRODUCTION_READY
    return 'PRODUCTION_READY';
  }

  /**
   * Generate markdown report
   */
  generateMarkdownReport(report: ProductionReport): string {
    let md = `# Production Performance Report\n\n`;
    md += `**Generated**: ${report.generatedAt}\n`;
    md += `**Version**: ${report.version}\n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n`;
    md += `**Overall Status**: ${this.formatStatus(report.summary.overallStatus)}\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Tests | ${report.summary.totalTests} |\n`;
    md += `| Passed | ${report.summary.testsPassedCount} |\n`;
    md += `| Failed | ${report.summary.testsFailedCount} |\n`;
    md += `| Success Rate | ${((report.summary.testsPassedCount / report.summary.totalTests) * 100).toFixed(1)}% |\n\n`;

    // Baseline Metrics
    md += `## Baseline Performance\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Throughput | ${report.baseline.throughputReqSec.toFixed(2)} req/sec |\n`;
    md += `| p50 Latency | ${report.baseline.latencyP50Ms.toFixed(2)}ms |\n`;
    md += `| p95 Latency | ${report.baseline.latencyP95Ms.toFixed(2)}ms |\n`;
    md += `| p99 Latency | ${report.baseline.latencyP99Ms.toFixed(2)}ms |\n`;
    md += `| Error Rate | ${(report.baseline.errorRate * 100).toFixed(2)}% |\n`;
    md += `| Success Rate | ${(report.baseline.successRate * 100).toFixed(2)}% |\n`;
    md += `| Total Requests | ${report.baseline.totalRequests.toLocaleString()} |\n\n`;

    // Load Tests
    md += `## Load Test Results\n\n`;
    md += `| Test | Duration | Target RPS | Actual RPS | Total Requests | Error Rate | p95 Latency | Status |\n`;
    md += `|------|----------|------------|------------|----------------|------------|-------------|--------|\n`;
    report.loadTests.forEach((lt) => {
      md += `| ${lt.testName} | ${lt.duration} | ${lt.targetRps} | ${lt.actualRps.toFixed(2)} | ${lt.totalRequests.toLocaleString()} | ${(lt.errorRate * 100).toFixed(1)}% | ${lt.latencyP95Ms.toFixed(0)}ms | ${lt.status === 'PASS' ? '✅' : '❌'} |\n`;
    });
    md += `\n`;

    // SLA Compliance
    md += `## SLA Compliance\n\n`;
    md += `| Metric | Target | Actual | Status |\n`;
    md += `|--------|--------|--------|--------|\n`;
    md += `| p50 Latency | ${report.slaCompliance.p50Target}ms | ${report.slaCompliance.p50Actual.toFixed(0)}ms | ${report.slaCompliance.p50Compliant ? '✅' : '❌'} |\n`;
    md += `| p95 Latency | ${report.slaCompliance.p95Target}ms | ${report.slaCompliance.p95Actual.toFixed(0)}ms | ${report.slaCompliance.p95Compliant ? '✅' : '❌'} |\n`;
    md += `| p99 Latency | ${report.slaCompliance.p99Target}ms | ${report.slaCompliance.p99Actual.toFixed(0)}ms | ${report.slaCompliance.p99Compliant ? '✅' : '❌'} |\n`;
    md += `| Error Rate | ${(report.slaCompliance.errorRateTarget * 100).toFixed(1)}% | ${(report.slaCompliance.errorRateActual * 100).toFixed(1)}% | ${report.slaCompliance.errorRateCompliant ? '✅' : '❌'} |\n\n`;

    // Resource Usage
    md += `## Resource Usage\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Avg CPU | ${report.resourceUsage.avgCpuPercent.toFixed(1)}% |\n`;
    md += `| Peak CPU | ${report.resourceUsage.peakCpuPercent.toFixed(1)}% |\n`;
    md += `| Avg Memory | ${report.resourceUsage.avgMemoryMb.toFixed(1)}MB |\n`;
    md += `| Peak Memory | ${report.resourceUsage.peakMemoryMb.toFixed(1)}MB |\n`;
    md += `| Memory Growth | ${report.resourceUsage.memoryGrowthMbPerSec.toFixed(4)}MB/sec |\n`;
    md += `| Memory Leak | ${report.resourceUsage.memoryLeakDetected ? 'YES ⚠️' : 'NO ✅'} |\n\n`;

    // Recommendations
    md += `## Recommendations\n\n`;
    const criticalRecs = report.recommendations.filter((r) => r.priority === 'CRITICAL');
    const highRecs = report.recommendations.filter((r) => r.priority === 'HIGH');
    const mediumRecs = report.recommendations.filter((r) => r.priority === 'MEDIUM');
    const lowRecs = report.recommendations.filter((r) => r.priority === 'LOW');

    if (criticalRecs.length > 0) {
      md += `### 🚨 CRITICAL\n\n`;
      criticalRecs.forEach((rec, i) => {
        md += `${i + 1}. **[${rec.category}]** ${rec.recommendation}\n`;
        md += `   - **Impact**: ${rec.expectedImpact}\n`;
        md += `   - **Effort**: ${rec.effort}\n\n`;
      });
    }

    if (highRecs.length > 0) {
      md += `### ⚠️ HIGH\n\n`;
      highRecs.forEach((rec, i) => {
        md += `${i + 1}. **[${rec.category}]** ${rec.recommendation}\n`;
        md += `   - **Impact**: ${rec.expectedImpact}\n`;
        md += `   - **Effort**: ${rec.effort}\n\n`;
      });
    }

    if (mediumRecs.length > 0) {
      md += `### 📋 MEDIUM\n\n`;
      mediumRecs.forEach((rec, i) => {
        md += `${i + 1}. **[${rec.category}]** ${rec.recommendation}\n`;
        md += `   - **Impact**: ${rec.expectedImpact}\n`;
        md += `   - **Effort**: ${rec.effort}\n\n`;
      });
    }

    if (lowRecs.length > 0) {
      md += `### ℹ️ LOW\n\n`;
      lowRecs.forEach((rec, i) => {
        md += `${i + 1}. **[${rec.category}]** ${rec.recommendation}\n`;
        md += `   - **Impact**: ${rec.expectedImpact}\n`;
        md += `   - **Effort**: ${rec.effort}\n\n`;
      });
    }

    return md;
  }

  /**
   * Export metrics to JSON
   */
  exportMetrics(report: ProductionReport, format: 'json' | 'csv'): string {
    if (format === 'json') {
      return JSON.stringify(report, null, 2);
    } else {
      // CSV format
      let csv = 'Test Name,Duration,Target RPS,Actual RPS,Total Requests,Error Rate,p95 Latency,Status\n';
      report.loadTests.forEach((lt) => {
        csv += `${lt.testName},${lt.duration},${lt.targetRps},${lt.actualRps.toFixed(2)},${lt.totalRequests},${(lt.errorRate * 100).toFixed(2)}%,${lt.latencyP95Ms.toFixed(0)},${lt.status}\n`;
      });
      return csv;
    }
  }

  /**
   * Format duration
   */
  private formatDuration(durationMs: number): string {
    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  /**
   * Format status with emoji
   */
  private formatStatus(status: 'PRODUCTION_READY' | 'NEEDS_ATTENTION' | 'NOT_READY'): string {
    switch (status) {
      case 'PRODUCTION_READY':
        return '✅ PRODUCTION READY';
      case 'NEEDS_ATTENTION':
        return '⚠️ NEEDS ATTENTION';
      case 'NOT_READY':
        return '❌ NOT READY';
    }
  }
}
