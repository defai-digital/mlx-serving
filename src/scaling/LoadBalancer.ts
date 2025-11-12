/**
 * Load Balancer (Week 3)
 *
 * Intelligent request routing across multiple MLX instances with:
 * - Multiple routing strategies (round-robin, least-loaded, latency-aware)
 * - Circuit breaker pattern for fault tolerance
 * - Health checking and automatic failover
 * - Request retry logic
 * - Comprehensive metrics
 */

import type {
  InstanceInfo,
  LoadBalancerConfig,
  LoadBalancingStrategy,
  RoutingDecision,
  LoadBalancerMetrics,
} from '@/types/scaling.js';
import { HealthStatus, CircuitState } from '@/types/scaling.js';
import type { GeneratorParams } from '@/types/generators.js';
import { safeAverage } from '@/utils/math-helpers.js';

/**
 * Load Balancer
 *
 * Routes requests to healthy instances using configurable strategies.
 */
export class LoadBalancer {
  private instances: Map<string, InstanceInfo> = new Map();
  private config: LoadBalancerConfig;
  private roundRobinIndex = 0;
  private healthCheckInterval?: NodeJS.Timeout;

  // Metrics
  private totalRequests = 0;
  private totalFailures = 0;
  private requestsPerInstance: Map<string, number> = new Map();
  private failuresPerInstance: Map<string, number> = new Map();
  private latencySamplesPerInstance: Map<string, number[]> = new Map();

  constructor(config: LoadBalancerConfig) {
    this.config = config;
  }

  /**
   * Start health checking
   */
  start(): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks().catch((error) => {
        console.error('Health check error:', error);
      });
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Stop health checking
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  /**
   * Register a new instance
   */
  registerInstance(instance: InstanceInfo): void {
    this.instances.set(instance.id, instance);
    this.requestsPerInstance.set(instance.id, 0);
    this.failuresPerInstance.set(instance.id, 0);
    this.latencySamplesPerInstance.set(instance.id, []);
  }

  /**
   * Unregister an instance
   */
  unregisterInstance(instanceId: string): void {
    this.instances.delete(instanceId);
    this.requestsPerInstance.delete(instanceId);
    this.failuresPerInstance.delete(instanceId);
    this.latencySamplesPerInstance.delete(instanceId);
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
   * Route a request to an instance
   */
  async route(request: GeneratorParams): Promise<RoutingDecision> {
    this.totalRequests++;

    // Get healthy instances
    const healthyInstances = this.getHealthyInstances();

    if (healthyInstances.length === 0) {
      throw new Error('No healthy instances available');
    }

    // Select instance based on strategy
    let selectedInstance: InstanceInfo;
    let reason: string;

    switch (this.config.strategy) {
      case 'round-robin':
        selectedInstance = this.selectRoundRobin(healthyInstances);
        reason = 'Round-robin selection';
        break;

      case 'least-loaded':
        selectedInstance = this.selectLeastLoaded(healthyInstances);
        reason = 'Least loaded instance';
        break;

      case 'latency-aware':
        selectedInstance = this.selectLatencyAware(healthyInstances, request);
        reason = 'Lowest estimated latency';
        break;

      case 'consistent-hash':
        selectedInstance = this.selectConsistentHash(healthyInstances, request);
        reason = 'Consistent hash routing';
        break;

      default:
        selectedInstance = healthyInstances[0];
        reason = 'Fallback to first instance';
    }

    // Increment request counter
    const currentCount = this.requestsPerInstance.get(selectedInstance.id) || 0;
    this.requestsPerInstance.set(selectedInstance.id, currentCount + 1);

    // Calculate estimated latency
    const estimatedLatencyMs = this.estimateLatency(selectedInstance, request);

    // Get alternatives (other healthy instances)
    const alternatives = healthyInstances.filter((i) => i.id !== selectedInstance.id);

    return {
      instance: selectedInstance,
      reason,
      estimatedLatencyMs,
      alternatives,
    };
  }

  /**
   * Report request success
   */
  reportSuccess(instanceId: string, latencyMs: number): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return;
    }

    // Update latency samples
    const samples = this.latencySamplesPerInstance.get(instanceId) || [];
    samples.push(latencyMs);

    // Keep only last 100 samples
    if (samples.length > 100) {
      samples.shift();
    }

    this.latencySamplesPerInstance.set(instanceId, samples);

    // Update average latency
    // BUG FIX: Use safeAverage to guard against empty samples array
    instance.avgLatencyMs = safeAverage(samples);

    // Reset consecutive failures
    instance.consecutiveFailures = 0;

    // Close circuit if half-open
    if (
      this.config.circuitBreaker.enabled &&
      instance.circuitState === CircuitState.HALF_OPEN
    ) {
      instance.circuitState = CircuitState.CLOSED;
    }
  }

  /**
   * Report request failure
   */
  reportFailure(instanceId: string, _error: Error): void {
    this.totalFailures++;

    const instance = this.instances.get(instanceId);
    if (!instance) {
      return;
    }

    // Increment failure counters
    const currentFailures = this.failuresPerInstance.get(instanceId) || 0;
    this.failuresPerInstance.set(instanceId, currentFailures + 1);

    instance.consecutiveFailures++;

    // Check circuit breaker
    if (this.config.circuitBreaker.enabled) {
      this.updateCircuitBreaker(instance);
    }

    // Mark instance as degraded if too many failures
    if (instance.consecutiveFailures >= 3 && instance.health === HealthStatus.HEALTHY) {
      instance.health = HealthStatus.DEGRADED;
    }
  }

  /**
   * Update circuit breaker state
   */
  private updateCircuitBreaker(instance: InstanceInfo): void {
    const { failureThreshold, resetTimeoutMs, successThreshold: _successThreshold } = this.config.circuitBreaker;

    // Open circuit if too many failures
    if (
      instance.consecutiveFailures >= failureThreshold &&
      instance.circuitState === CircuitState.CLOSED
    ) {
      instance.circuitState = CircuitState.OPEN;
      instance.health = HealthStatus.UNHEALTHY;

      // Schedule half-open attempt
      setTimeout(() => {
        if (instance.circuitState === CircuitState.OPEN) {
          instance.circuitState = CircuitState.HALF_OPEN;
          instance.health = HealthStatus.DEGRADED;
        }
      }, resetTimeoutMs);
    }
  }

  /**
   * Get healthy instances (excluding circuit-open)
   */
  private getHealthyInstances(): InstanceInfo[] {
    return Array.from(this.instances.values()).filter((instance) => {
      // Filter out unhealthy instances
      if (instance.health === HealthStatus.UNHEALTHY) {
        return false;
      }

      // Filter out open circuit instances
      if (this.config.circuitBreaker.enabled && instance.circuitState === CircuitState.OPEN) {
        return false;
      }

      return true;
    });
  }

  /**
   * Round-robin selection
   */
  private selectRoundRobin(instances: InstanceInfo[]): InstanceInfo {
    const index = this.roundRobinIndex % instances.length;
    this.roundRobinIndex++;
    return instances[index];
  }

  /**
   * Least-loaded selection
   */
  private selectLeastLoaded(instances: InstanceInfo[]): InstanceInfo {
    return instances.reduce((least, instance) => {
      const leastUtil = least.capacity > 0 ? least.currentLoad / least.capacity : 0;
      const instanceUtil = instance.capacity > 0 ? instance.currentLoad / instance.capacity : 0;
      return instanceUtil < leastUtil ? instance : least;
    });
  }

  /**
   * Latency-aware selection
   */
  private selectLatencyAware(instances: InstanceInfo[], request: GeneratorParams): InstanceInfo {
    const estimates = instances.map((instance) => ({
      instance,
      latency: this.estimateLatency(instance, request),
    }));

    return estimates.reduce((best, curr) =>
      curr.latency < best.latency ? curr : best
    ).instance;
  }

  /**
   * Consistent hash selection
   */
  private selectConsistentHash(instances: InstanceInfo[], request: GeneratorParams): InstanceInfo {
    // Hash the prompt to ensure same prompt goes to same instance
    const hash = this.hashString(request.prompt as string);
    const index = hash % instances.length;
    return instances[index];
  }

  /**
   * Estimate latency for instance
   */
  private estimateLatency(instance: InstanceInfo, _request: GeneratorParams): number {
    // Base latency from historical average
    let latency = instance.avgLatencyMs || 100;

    // Add queue delay based on current load
    const utilization = instance.capacity > 0 ? instance.currentLoad / instance.capacity : 0;
    const queueDelay = utilization * 50; // 50ms max queue delay
    latency += queueDelay;

    // Add penalty for degraded health
    if (instance.health === HealthStatus.DEGRADED) {
      latency *= 1.5;
    }

    return latency;
  }

  /**
   * Hash string to number (simple djb2 hash)
   */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
    }
    return Math.abs(hash);
  }

  /**
   * Perform health checks on all instances
   */
  private async performHealthChecks(): Promise<void> {
    const checks = Array.from(this.instances.values()).map((instance) =>
      this.checkInstanceHealth(instance)
    );

    await Promise.allSettled(checks);
  }

  /**
   * Check health of single instance
   */
  private async checkInstanceHealth(instance: InstanceInfo): Promise<void> {
    const startTime = Date.now();

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.healthCheckTimeoutMs);

      // Perform health check
      const response = await fetch(`${instance.endpoint}/health`, {
        signal: controller.signal,
        method: 'GET',
      });

      clearTimeout(timeoutId);

      const latency = Date.now() - startTime;

      if (response.ok) {
        // Instance is healthy
        instance.health = HealthStatus.HEALTHY;
        instance.consecutiveFailures = 0;
        instance.lastHealthCheck = Date.now();

        // Update latency
        const samples = this.latencySamplesPerInstance.get(instance.id) || [];
        samples.push(latency);
        if (samples.length > 100) {
          samples.shift();
        }
        this.latencySamplesPerInstance.set(instance.id, samples);
        // BUG FIX: Use safeAverage to guard against empty samples array
    instance.avgLatencyMs = safeAverage(samples);

        // Close circuit if open
        if (
          this.config.circuitBreaker.enabled &&
          instance.circuitState === CircuitState.HALF_OPEN
        ) {
          instance.circuitState = CircuitState.CLOSED;
        }
      } else {
        // Instance returned error
        instance.health = HealthStatus.DEGRADED;
        instance.consecutiveFailures++;
        instance.lastHealthCheck = Date.now();

        if (this.config.circuitBreaker.enabled) {
          this.updateCircuitBreaker(instance);
        }
      }
    } catch (error) {
      // Health check failed
      instance.health = HealthStatus.UNHEALTHY;
      instance.consecutiveFailures++;
      instance.lastHealthCheck = Date.now();

      if (this.config.circuitBreaker.enabled) {
        this.updateCircuitBreaker(instance);
      }

      console.error(`Health check failed for instance ${instance.id}:`, error);
    }
  }

  /**
   * Get load balancer metrics
   */
  getMetrics(): LoadBalancerMetrics {
    const instances = Array.from(this.instances.values());
    const healthyCount = instances.filter((i) => i.health === HealthStatus.HEALTHY).length;
    const degradedCount = instances.filter((i) => i.health === HealthStatus.DEGRADED).length;
    const unhealthyCount = instances.filter((i) => i.health === HealthStatus.UNHEALTHY).length;

    const totalCapacity = instances.reduce((sum, i) => sum + i.capacity, 0);
    const totalLoad = instances.reduce((sum, i) => sum + i.currentLoad, 0);

    const requestsPerInstance: Record<string, number> = {};
    const failuresPerInstance: Record<string, number> = {};
    const avgLatencyPerInstance: Record<string, number> = {};

    for (const instance of instances) {
      requestsPerInstance[instance.id] = this.requestsPerInstance.get(instance.id) || 0;
      failuresPerInstance[instance.id] = this.failuresPerInstance.get(instance.id) || 0;
      avgLatencyPerInstance[instance.id] = instance.avgLatencyMs;
    }

    return {
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      requestsPerInstance,
      failuresPerInstance,
      avgLatencyPerInstance,
      strategy: this.config.strategy,
      healthyInstances: healthyCount,
      degradedInstances: degradedCount,
      unhealthyInstances: unhealthyCount,
      totalCapacity,
      totalLoad,
      utilization: totalCapacity > 0 ? totalLoad / totalCapacity : 0,
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.requestsPerInstance.clear();
    this.failuresPerInstance.clear();
    this.latencySamplesPerInstance.clear();

    // Re-initialize for all instances
    for (const instance of this.instances.values()) {
      this.requestsPerInstance.set(instance.id, 0);
      this.failuresPerInstance.set(instance.id, 0);
      this.latencySamplesPerInstance.set(instance.id, []);
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
   * Get instance with retry logic
   */
  async routeWithRetry(request: GeneratorParams): Promise<RoutingDecision> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const decision = await this.route(request);

        // Check if circuit is open
        if (
          this.config.circuitBreaker.enabled &&
          decision.instance.circuitState === CircuitState.OPEN
        ) {
          throw new Error(`Circuit breaker open for instance ${decision.instance.id}`);
        }

        return decision;
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.config.maxRetries) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  }
}

/**
 * Default load balancer configuration
 */
export const DEFAULT_LOAD_BALANCER_CONFIG: LoadBalancerConfig = {
  strategy: 'least-loaded' as LoadBalancingStrategy,
  healthCheckIntervalMs: 10000, // 10 seconds
  healthCheckTimeoutMs: 5000, // 5 seconds
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    failureWindowMs: 60000, // 1 minute
    resetTimeoutMs: 30000, // 30 seconds
    successThreshold: 2,
  },
  maxRetries: 3,
  retryDelayMs: 1000, // 1 second
  enableTimeout: true,
  requestTimeoutMs: 30000, // 30 seconds
};
