/**
 * Instance Registry (Week 3)
 *
 * Manages discovery, health monitoring, and auto-scaling of MLX instances.
 *
 * Features:
 * - Instance discovery and registration
 * - Health monitoring and heartbeats
 * - Auto-scaling triggers based on load
 * - Load metrics aggregation
 * - Prometheus metrics export
 */

import type {
  InstanceInfo,
  InstanceRegistryConfig,
  RegistryMetrics,
  ScalingEvent,
} from '@/types/scaling.js';
import { HealthStatus, CircuitState } from '@/types/scaling.js';

/**
 * Instance Registry
 *
 * Central registry for managing multiple MLX instances.
 */
export class InstanceRegistry {
  private config: InstanceRegistryConfig;
  private instances: Map<string, InstanceInfo> = new Map();
  private discoveryInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private scalingEvents: ScalingEvent[] = [];
  private lastScaleUpTime = 0;
  private lastScaleDownTime = 0;

  // Event handlers
  private onInstanceAddedHandlers: Array<(instance: InstanceInfo) => void> = [];
  private onInstanceRemovedHandlers: Array<(instanceId: string) => void> = [];
  private onScalingEventHandlers: Array<(event: ScalingEvent) => void> = [];

  constructor(config: InstanceRegistryConfig) {
    this.config = config;
  }

  /**
   * Start registry
   */
  start(): void {
    // Start auto-discovery if enabled
    if (this.config.autoDiscovery) {
      this.discoveryInterval = setInterval(() => {
        this.performDiscovery().catch((_error) => {
          // console.error('Discovery error:', _error);
        });
      }, this.config.discoveryIntervalMs);
    }

    // Start cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleInstances();
    }, this.config.instanceTimeoutMs);

    // Start auto-scaling if enabled
    if (this.config.enableAutoScaling) {
      setInterval(() => {
        this.evaluateAutoScaling().catch((_error) => {
          // console.error('Auto-scaling evaluation error:', _error);
        });
      }, 5000); // Check every 5 seconds
    }
  }

  /**
   * Stop registry
   */
  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = undefined;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /**
   * Register a new instance
   */
  registerInstance(instance: InstanceInfo): void {
    const existing = this.instances.get(instance.id);

    this.instances.set(instance.id, instance);

    if (!existing) {
      // New instance
      // console.log(`Instance registered: ${instance.id} (${instance.endpoint})`);

      // Emit instance added event
      for (const handler of this.onInstanceAddedHandlers) {
        handler(instance);
      }

      // Record scaling event
      this.recordScalingEvent({
        type: 'instance-added',
        timestamp: Date.now(),
        instanceCount: this.instances.size,
        utilization: this.calculateUtilization(),
        reason: `Instance ${instance.id} registered`,
      });
    }
  }

  /**
   * Unregister an instance
   */
  unregisterInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);

    if (instance) {
      this.instances.delete(instanceId);

      // console.log(`Instance unregistered: ${instanceId}`);

      // Emit instance removed event
      for (const handler of this.onInstanceRemovedHandlers) {
        handler(instanceId);
      }

      // Record scaling event
      this.recordScalingEvent({
        type: 'instance-removed',
        timestamp: Date.now(),
        instanceCount: this.instances.size,
        utilization: this.calculateUtilization(),
        reason: `Instance ${instanceId} unregistered`,
      });
    }
  }

  /**
   * Get instance by ID
   */
  getInstance(instanceId: string): InstanceInfo | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all instances
   */
  getAllInstances(): InstanceInfo[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get healthy instances
   */
  getHealthyInstances(): InstanceInfo[] {
    return Array.from(this.instances.values()).filter(
      (instance) => instance.health === HealthStatus.HEALTHY
    );
  }

  /**
   * Update instance heartbeat
   */
  updateHeartbeat(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.lastHealthCheck = Date.now();
    }
  }

  /**
   * Update instance load
   */
  updateInstanceLoad(instanceId: string, load: number): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.currentLoad = load;
    }
  }

  /**
   * Update instance health
   */
  updateInstanceHealth(instanceId: string, health: HealthStatus): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.health = health;
    }
  }

  /**
   * Perform instance discovery
   */
  private async performDiscovery(): Promise<void> {
    // This is a placeholder for service discovery
    // In production, this would integrate with:
    // - Kubernetes service discovery
    // - Consul
    // - etcd
    // - AWS ECS/EKS service discovery
    // - etc.

    // console.log('Performing instance discovery...');
    // Implementation depends on deployment environment
  }

  /**
   * Clean up stale instances
   */
  private cleanupStaleInstances(): void {
    const now = Date.now();
    const timeout = this.config.instanceTimeoutMs;

    for (const [id, instance] of this.instances) {
      const age = now - instance.lastHealthCheck;

      if (age > timeout) {
        // console.log(`Removing stale instance: ${id} (${age}ms since last heartbeat)`);
        this.unregisterInstance(id);
      }
    }
  }

  /**
   * Calculate overall utilization
   */
  private calculateUtilization(): number {
    const instances = Array.from(this.instances.values());

    if (instances.length === 0) {
      return 0;
    }

    const totalCapacity = instances.reduce((sum, i) => sum + i.capacity, 0);
    const totalLoad = instances.reduce((sum, i) => sum + i.currentLoad, 0);

    return totalCapacity > 0 ? totalLoad / totalCapacity : 0;
  }

  /**
   * Evaluate auto-scaling
   */
  private async evaluateAutoScaling(): Promise<void> {
    const now = Date.now();
    const utilization = this.calculateUtilization();
    const instanceCount = this.instances.size;

    const { autoScaling } = this.config;
    const {
      minInstances,
      maxInstances,
      scaleUpThreshold,
      scaleDownThreshold,
      scaleUpCooldownMs,
      scaleDownCooldownMs,
    } = autoScaling;

    // Check if we should scale up
    if (
      utilization > scaleUpThreshold &&
      instanceCount < maxInstances &&
      now - this.lastScaleUpTime > scaleUpCooldownMs
    ) {
      // console.log(
      //   `Auto-scaling: Scale up triggered (utilization: ${(utilization * 100).toFixed(1)}%)`
      // );

      this.lastScaleUpTime = now;

      // Emit scaling event
      this.recordScalingEvent({
        type: 'scale-up',
        timestamp: now,
        instanceCount,
        utilization,
        reason: `Utilization ${(utilization * 100).toFixed(1)}% > threshold ${(scaleUpThreshold * 100).toFixed(1)}%`,
      });

      // Trigger scale up (implementation depends on environment)
      await this.triggerScaleUp();
    }

    // Check if we should scale down
    if (
      utilization < scaleDownThreshold &&
      instanceCount > minInstances &&
      now - this.lastScaleDownTime > scaleDownCooldownMs
    ) {
      // console.log(`Auto-scaling: Scale down triggered (utilization: ${(utilization * 100).toFixed(1)}%}`);

      this.lastScaleDownTime = now;

      // Emit scaling event
      this.recordScalingEvent({
        type: 'scale-down',
        timestamp: now,
        instanceCount,
        utilization,
        reason: `Utilization ${(utilization * 100).toFixed(1)}% < threshold ${(scaleDownThreshold * 100).toFixed(1)}%`,
      });

      // Trigger scale down (implementation depends on environment)
      await this.triggerScaleDown();
    }
  }

  /**
   * Trigger scale up
   */
  private async triggerScaleUp(): Promise<void> {
    // This is a placeholder for auto-scaling
    // In production, this would integrate with:
    // - Kubernetes HPA
    // - AWS Auto Scaling
    // - GCP Managed Instance Groups
    // - Azure VM Scale Sets
    // - etc.

    // console.log('Triggering scale up...');
    // Implementation depends on deployment environment
  }

  /**
   * Trigger scale down
   */
  private async triggerScaleDown(): Promise<void> {
    // This is a placeholder for auto-scaling
    // In production, this would integrate with orchestration platform

    // console.log('Triggering scale down...');
    // Implementation depends on deployment environment

    // For now, we can remove the least utilized instance
    const instances = Array.from(this.instances.values());
    const sorted = instances.sort((a, b) => {
      const aUtil = a.capacity > 0 ? a.currentLoad / a.capacity : 0;
      const bUtil = b.capacity > 0 ? b.currentLoad / b.capacity : 0;
      return aUtil - bUtil;
    });

    if (sorted.length > 0 && sorted[0].currentLoad === 0) {
      // Remove idle instance
      this.unregisterInstance(sorted[0].id);
    }
  }

  /**
   * Record scaling event
   */
  private recordScalingEvent(event: ScalingEvent): void {
    this.scalingEvents.push(event);

    // Keep only last 100 events
    if (this.scalingEvents.length > 100) {
      this.scalingEvents.shift();
    }

    // Emit event
    for (const handler of this.onScalingEventHandlers) {
      handler(event);
    }
  }

  /**
   * Get registry metrics
   */
  getMetrics(): RegistryMetrics {
    const instances = Array.from(this.instances.values());
    const healthyCount = instances.filter((i) => i.health === HealthStatus.HEALTHY).length;
    const degradedCount = instances.filter((i) => i.health === HealthStatus.DEGRADED).length;
    const unhealthyCount = instances.filter((i) => i.health === HealthStatus.UNHEALTHY).length;

    const totalCapacity = instances.reduce((sum, i) => sum + i.capacity, 0);
    const totalLoad = instances.reduce((sum, i) => sum + i.currentLoad, 0);
    const avgUtilization = this.calculateUtilization();

    // Count scaling events in last hour
    const oneHourAgo = Date.now() - 3600000;
    const scalingEventsLastHour = this.scalingEvents.filter((e) => e.timestamp > oneHourAgo).length;

    const lastScalingEvent =
      this.scalingEvents.length > 0 ? this.scalingEvents[this.scalingEvents.length - 1] : undefined;

    return {
      totalInstances: instances.length,
      healthyInstances: healthyCount,
      degradedInstances: degradedCount,
      unhealthyInstances: unhealthyCount,
      totalCapacity,
      totalLoad,
      avgUtilization,
      scalingEventsLastHour,
      lastScalingEvent,
    };
  }

  /**
   * Get scaling events
   */
  getScalingEvents(limit?: number): ScalingEvent[] {
    const events = [...this.scalingEvents].reverse();
    return limit ? events.slice(0, limit) : events;
  }

  /**
   * Export Prometheus metrics
   */
  exportPrometheusMetrics(): string {
    const metrics = this.getMetrics();
    const lines: string[] = [];

    // Instance count
    lines.push('# HELP mlx_serving_instances_total Total number of instances');
    lines.push('# TYPE mlx_serving_instances_total gauge');
    lines.push(`mlx_serving_instances_total ${metrics.totalInstances}`);

    // Healthy instances
    lines.push('# HELP mlx_serving_instances_healthy Number of healthy instances');
    lines.push('# TYPE mlx_serving_instances_healthy gauge');
    lines.push(`mlx_serving_instances_healthy ${metrics.healthyInstances}`);

    // Degraded instances
    lines.push('# HELP mlx_serving_instances_degraded Number of degraded instances');
    lines.push('# TYPE mlx_serving_instances_degraded gauge');
    lines.push(`mlx_serving_instances_degraded ${metrics.degradedInstances}`);

    // Unhealthy instances
    lines.push('# HELP mlx_serving_instances_unhealthy Number of unhealthy instances');
    lines.push('# TYPE mlx_serving_instances_unhealthy gauge');
    lines.push(`mlx_serving_instances_unhealthy ${metrics.unhealthyInstances}`);

    // Total capacity
    lines.push('# HELP mlx_serving_capacity_total Total capacity in tokens/second');
    lines.push('# TYPE mlx_serving_capacity_total gauge');
    lines.push(`mlx_serving_capacity_total ${metrics.totalCapacity}`);

    // Total load
    lines.push('# HELP mlx_serving_load_total Total load in tokens/second');
    lines.push('# TYPE mlx_serving_load_total gauge');
    lines.push(`mlx_serving_load_total ${metrics.totalLoad}`);

    // Average utilization
    lines.push('# HELP mlx_serving_utilization_avg Average utilization (0-1)');
    lines.push('# TYPE mlx_serving_utilization_avg gauge');
    lines.push(`mlx_serving_utilization_avg ${metrics.avgUtilization.toFixed(4)}`);

    // Scaling events
    lines.push('# HELP mlx_serving_scaling_events_hour Scaling events in last hour');
    lines.push('# TYPE mlx_serving_scaling_events_hour gauge');
    lines.push(`mlx_serving_scaling_events_hour ${metrics.scalingEventsLastHour}`);

    // Per-instance metrics
    for (const instance of this.instances.values()) {
      const labels = `instance="${instance.id}",endpoint="${instance.endpoint}"`;

      // Instance capacity
      lines.push(`mlx_serving_instance_capacity{${labels}} ${instance.capacity}`);

      // Instance load
      lines.push(`mlx_serving_instance_load{${labels}} ${instance.currentLoad}`);

      // Instance latency
      lines.push(`mlx_serving_instance_latency_ms{${labels}} ${instance.avgLatencyMs}`);

      // Instance health (0=unknown, 1=healthy, 2=degraded, 3=unhealthy)
      const healthValue =
        instance.health === HealthStatus.HEALTHY
          ? 1
          : instance.health === HealthStatus.DEGRADED
            ? 2
            : instance.health === HealthStatus.UNHEALTHY
              ? 3
              : 0;
      lines.push(`mlx_serving_instance_health{${labels}} ${healthValue}`);

      // Circuit state (0=closed, 1=half-open, 2=open)
      const circuitValue =
        instance.circuitState === CircuitState.CLOSED
          ? 0
          : instance.circuitState === CircuitState.HALF_OPEN
            ? 1
            : 2;
      lines.push(`mlx_serving_instance_circuit_state{${labels}} ${circuitValue}`);
    }

    return lines.join('\n');
  }

  /**
   * Register event handler for instance added
   */
  onInstanceAdded(handler: (instance: InstanceInfo) => void): void {
    this.onInstanceAddedHandlers.push(handler);
  }

  /**
   * Register event handler for instance removed
   */
  onInstanceRemoved(handler: (instanceId: string) => void): void {
    this.onInstanceRemovedHandlers.push(handler);
  }

  /**
   * Register event handler for scaling events
   */
  onScalingEvent(handler: (event: ScalingEvent) => void): void {
    this.onScalingEventHandlers.push(handler);
  }
}

/**
 * Default instance registry configuration
 */
export const DEFAULT_INSTANCE_REGISTRY_CONFIG: InstanceRegistryConfig = {
  autoDiscovery: false,
  discoveryIntervalMs: 30000, // 30 seconds
  instanceTimeoutMs: 60000, // 1 minute
  enableAutoScaling: false,
  autoScaling: {
    minInstances: 1,
    maxInstances: 10,
    targetUtilization: 0.7,
    scaleUpThreshold: 0.8,
    scaleDownThreshold: 0.3,
    scaleUpCooldownMs: 300000, // 5 minutes
    scaleDownCooldownMs: 600000, // 10 minutes
  },
  enablePrometheusMetrics: true,
  metricsPort: 9090,
};
