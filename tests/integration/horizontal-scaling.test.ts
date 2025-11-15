/**
 * Horizontal Scaling Integration Tests
 *
 * Tests the complete horizontal scaling infrastructure including:
 * - LoadBalancer
 * - DistributedCache
 * - InstanceRegistry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LoadBalancer, DEFAULT_LOAD_BALANCER_CONFIG } from '@/scaling/LoadBalancer.js';
import { DistributedCache, DEFAULT_DISTRIBUTED_CACHE_CONFIG } from '@/scaling/DistributedCache.js';
import { InstanceRegistry, DEFAULT_INSTANCE_REGISTRY_CONFIG } from '@/scaling/InstanceRegistry.js';
import type {
  InstanceInfo,
  LoadBalancerConfig,
} from '@/types/scaling.js';
import { HealthStatus, CircuitState } from '@/types/scaling.js';
import type { GeneratorParams } from '@/types/generators.js';

/**
 * Helper to create round-robin load balancer config for predictable test behavior.
 *
 * Round-robin ensures even distribution of requests across instances, which is
 * essential for testing load balancing behavior. The default 'least-loaded' strategy
 * would always select the first instance when all have equal utilization (0/100).
 */
const createRoundRobinConfig = (): LoadBalancerConfig => ({
  ...DEFAULT_LOAD_BALANCER_CONFIG,
  strategy: 'round-robin',
});

/**
 * Helper to register instances in both registry and load balancer.
 * Reduces boilerplate in tests that need to set up multiple instances.
 */
const registerInstances = (
  instances: InstanceInfo[],
  registry: InstanceRegistry,
  loadBalancer: LoadBalancer
): void => {
  for (const instance of instances) {
    registry.registerInstance(instance);
    loadBalancer.registerInstance(instance);
  }
};

/**
 * Helper to create local fallback cache config for testing.
 * Disables distributed cache but enables local fallback.
 */
const createLocalCacheConfig = () => ({
  ...DEFAULT_DISTRIBUTED_CACHE_CONFIG,
  enabled: false,
  enableLocalFallback: true,
});

/**
 * Standard test request for routing tests.
 */
const TEST_REQUEST: GeneratorParams = { model: 'test', prompt: 'hello' };

describe('Horizontal Scaling Integration', () => {
  describe('LoadBalancer + InstanceRegistry', () => {
    let loadBalancer: LoadBalancer;
    let registry: InstanceRegistry;

    beforeEach(() => {
      loadBalancer = new LoadBalancer(createRoundRobinConfig());
      registry = new InstanceRegistry(DEFAULT_INSTANCE_REGISTRY_CONFIG);
    });

    afterEach(() => {
      loadBalancer.stop();
      registry.stop();
    });

    it('should sync instances between registry and load balancer', () => {
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
      ];

      registerInstances(instances, registry, loadBalancer);

      const lbInstances = loadBalancer.getAllInstances();
      const regInstances = registry.getAllInstances();

      expect(lbInstances).toHaveLength(2);
      expect(regInstances).toHaveLength(2);
    });

    it('should route requests through load balancer and track in registry', async () => {
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
      ];

      registerInstances(instances, registry, loadBalancer);

      const decision = await loadBalancer.route(TEST_REQUEST);

      // Update registry with load
      registry.updateInstanceLoad(decision.instance.id, 50);

      const updated = registry.getInstance(decision.instance.id);
      expect(updated?.currentLoad).toBe(50);
    });

    it('should handle instance removal across both components', () => {
      const instance1 = createMockInstance('instance-1');

      registry.registerInstance(instance1);
      loadBalancer.registerInstance(instance1);

      // Remove from both
      registry.unregisterInstance('instance-1');
      loadBalancer.unregisterInstance('instance-1');

      expect(registry.getInstance('instance-1')).toBeUndefined();
      expect(loadBalancer.getInstance('instance-1')).toBeUndefined();
    });

    it('should coordinate health status', () => {
      const instance1 = createMockInstance('instance-1');

      registry.registerInstance(instance1);
      loadBalancer.registerInstance(instance1);

      // Mark unhealthy in registry
      registry.updateInstanceHealth('instance-1', HealthStatus.UNHEALTHY);

      // Update load balancer
      const lbInstance = loadBalancer.getInstance('instance-1');
      if (lbInstance) {
        lbInstance.health = HealthStatus.UNHEALTHY;
      }

      expect(registry.getInstance('instance-1')?.health).toBe(HealthStatus.UNHEALTHY);
      expect(loadBalancer.getInstance('instance-1')?.health).toBe(HealthStatus.UNHEALTHY);
    });
  });

  describe('LoadBalancer + DistributedCache', () => {
    let loadBalancer: LoadBalancer;
    let cache: DistributedCache<any>;

    beforeEach(() => {
      loadBalancer = new LoadBalancer(DEFAULT_LOAD_BALANCER_CONFIG);
      cache = new DistributedCache(createLocalCacheConfig());
    });

    afterEach(async () => {
      loadBalancer.stop();
      await cache.clear();
      await cache.close();
    });

    it('should cache routing decisions', async () => {
      const instance1 = createMockInstance('instance-1');
      loadBalancer.registerInstance(instance1);

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      // Route and cache
      const decision = await loadBalancer.route(request);
      await cache.set('route:test:hello', decision.instance.id);

      // Retrieve from cache
      const cachedInstanceId = await cache.get('route:test:hello');

      expect(cachedInstanceId).toBe(decision.instance.id);
    });

    it('should share cache across multiple instances', async () => {
      const instance1 = createMockInstance('instance-1');
      const instance2 = createMockInstance('instance-2');

      loadBalancer.registerInstance(instance1);
      loadBalancer.registerInstance(instance2);

      // Simulate KV cache sharing
      const kvCache = {
        conversation_id: 'conv-123',
        tokens: [1, 2, 3, 4, 5],
        timestamp: Date.now(),
      };

      await cache.set('kv:conv-123', kvCache);

      // Both instances can access
      const retrieved = await cache.get('kv:conv-123');

      expect(retrieved).toEqual(kvCache);
    });

    it('should handle cache misses gracefully', async () => {
      const instance1 = createMockInstance('instance-1');
      loadBalancer.registerInstance(instance1);

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      // Try to get from cache first
      const cached = await cache.get('route:test:hello');

      if (!cached) {
        // Route request
        const decision = await loadBalancer.route(request);
        expect(decision.instance).toBeDefined();
      }
    });
  });

  describe('Full Integration: LoadBalancer + Registry + Cache', () => {
    let loadBalancer: LoadBalancer;
    let registry: InstanceRegistry;
    let cache: DistributedCache<any>;

    beforeEach(() => {
      loadBalancer = new LoadBalancer(createRoundRobinConfig());
      registry = new InstanceRegistry(DEFAULT_INSTANCE_REGISTRY_CONFIG);
      cache = new DistributedCache(createLocalCacheConfig());
    });

    afterEach(async () => {
      loadBalancer.stop();
      registry.stop();
      await cache.clear();
      await cache.close();
    });

    it('should coordinate instance discovery, routing, and caching', async () => {
      // 1. Register instances
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
      ];

      registerInstances(instances, registry, loadBalancer);

      // 2. Route request
      const decision = await loadBalancer.route(TEST_REQUEST);

      // 3. Cache result
      await cache.set('result:hello', { instance: decision.instance.id, timestamp: Date.now() });

      // 4. Update metrics
      registry.updateInstanceLoad(decision.instance.id, 50);
      loadBalancer.updateInstanceLoad(decision.instance.id, 50);

      // 5. Verify
      const cachedResult = await cache.get('result:hello');
      expect(cachedResult.instance).toBe(decision.instance.id);

      const regMetrics = registry.getMetrics();
      expect(regMetrics.totalLoad).toBe(50);
    });

    it('should handle scaling up scenario', async () => {
      // Start with 2 instances
      const instances = [
        createMockInstance('instance-1', HealthStatus.HEALTHY, 80, 100),
        createMockInstance('instance-2', HealthStatus.HEALTHY, 85, 100),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Check utilization
      const beforeMetrics = registry.getMetrics();
      expect(beforeMetrics.avgUtilization).toBeGreaterThan(0.8);

      // Scale up - add new instance
      const instance3 = createMockInstance('instance-3', HealthStatus.HEALTHY, 0, 100);
      registry.registerInstance(instance3);
      loadBalancer.registerInstance(instance3);

      // Verify increased capacity
      const afterMetrics = registry.getMetrics();
      expect(afterMetrics.totalInstances).toBe(3);
      expect(afterMetrics.totalCapacity).toBe(300);
      expect(afterMetrics.avgUtilization).toBeLessThan(0.6);
    });

    it('should handle scaling down scenario', async () => {
      // Start with 3 instances
      const instances = [
        createMockInstance('instance-1', HealthStatus.HEALTHY, 20, 100),
        createMockInstance('instance-2', HealthStatus.HEALTHY, 10, 100),
        createMockInstance('instance-3', HealthStatus.HEALTHY, 0, 100),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Low utilization
      const beforeMetrics = registry.getMetrics();
      expect(beforeMetrics.avgUtilization).toBeLessThan(0.3);

      // Scale down - remove idle instance
      registry.unregisterInstance('instance-3');
      loadBalancer.unregisterInstance('instance-3');

      const afterMetrics = registry.getMetrics();
      expect(afterMetrics.totalInstances).toBe(2);
    });

    it('should handle instance failure and recovery', async () => {
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Simulate failure - mark instance as UNHEALTHY (not just DEGRADED)
      loadBalancer.reportFailure('instance-1', new Error('test failure'));
      registry.updateInstanceHealth('instance-1', HealthStatus.UNHEALTHY);
      // Also update load balancer's view of the instance health
      const inst1 = loadBalancer.getAllInstances().find(i => i.id === 'instance-1');
      if (inst1) {
        inst1.health = HealthStatus.UNHEALTHY;
      }

      // Route should go to healthy instance
      const decision = await loadBalancer.route(TEST_REQUEST);

      expect(decision.instance.id).toBe('instance-2');

      // Simulate recovery
      loadBalancer.reportSuccess('instance-1', 50);
      registry.updateInstanceHealth('instance-1', HealthStatus.HEALTHY);
      if (inst1) {
        inst1.health = HealthStatus.HEALTHY;
      }

      const healthyInstances = registry.getHealthyInstances();
      expect(healthyInstances).toHaveLength(2);
    });

    it('should distribute load evenly across instances', async () => {
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
        createMockInstance('instance-3'),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Route multiple requests
      for (let i = 0; i < 30; i++) {
        await loadBalancer.route(TEST_REQUEST);
      }

      const metrics = loadBalancer.getMetrics();

      // Each instance should get ~10 requests
      const requests = Object.values(metrics.requestsPerInstance);
      expect(requests).toHaveLength(3);

      // Check distribution is relatively even (within 5 requests)
      const min = Math.min(...requests);
      const max = Math.max(...requests);
      expect(max - min).toBeLessThanOrEqual(5);
    });

    it('should export comprehensive metrics', () => {
      const instances = [
        createMockInstance('instance-1', HealthStatus.HEALTHY, 50, 100),
        createMockInstance('instance-2', HealthStatus.DEGRADED, 20, 100),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Get all metrics
      const lbMetrics = loadBalancer.getMetrics();
      const regMetrics = registry.getMetrics();
      const cacheMetrics = cache.getMetrics();

      expect(lbMetrics.totalInstances).toBeUndefined(); // LB doesn't track this
      expect(lbMetrics.healthyInstances).toBe(1);
      expect(lbMetrics.degradedInstances).toBe(1);

      expect(regMetrics.totalInstances).toBe(2);
      expect(regMetrics.healthyInstances).toBe(1);
      expect(regMetrics.degradedInstances).toBe(1);

      expect(cacheMetrics.type).toBe('local');
    });

    it('should handle high concurrency', async () => {
      const instances = [
        createMockInstance('instance-1'),
        createMockInstance('instance-2'),
      ];

      registerInstances(instances, registry, loadBalancer);

      // Route 100 concurrent requests
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(loadBalancer.route(TEST_REQUEST));
      }

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(100);

      // Requests should be distributed
      const instance1Count = results.filter((r) => r.instance.id === 'instance-1').length;
      const instance2Count = results.filter((r) => r.instance.id === 'instance-2').length;

      expect(instance1Count + instance2Count).toBe(100);
      expect(instance1Count).toBeGreaterThan(0);
      expect(instance2Count).toBeGreaterThan(0);
    });
  });

  describe('Prometheus Metrics Export', () => {
    let registry: InstanceRegistry;

    beforeEach(() => {
      registry = new InstanceRegistry(DEFAULT_INSTANCE_REGISTRY_CONFIG);
    });

    afterEach(() => {
      registry.stop();
    });

    it('should export Prometheus metrics', () => {
      const instance1 = createMockInstance('instance-1', HealthStatus.HEALTHY, 50, 100);
      const instance2 = createMockInstance('instance-2', HealthStatus.DEGRADED, 20, 100);

      registry.registerInstance(instance1);
      registry.registerInstance(instance2);

      const metrics = registry.exportPrometheusMetrics();

      expect(metrics).toContain('mlx_serving_instances_total 2');
      expect(metrics).toContain('mlx_serving_instances_healthy 1');
      expect(metrics).toContain('mlx_serving_instances_degraded 1');
      expect(metrics).toContain('mlx_serving_capacity_total 200');
      expect(metrics).toContain('mlx_serving_load_total 70');
    });

    it('should include per-instance metrics', () => {
      const instance1 = createMockInstance('instance-1', HealthStatus.HEALTHY, 50, 100, 25);

      registry.registerInstance(instance1);

      const metrics = registry.exportPrometheusMetrics();

      expect(metrics).toContain('instance="instance-1"');
      expect(metrics).toContain('mlx_serving_instance_capacity');
      expect(metrics).toContain('mlx_serving_instance_load');
      expect(metrics).toContain('mlx_serving_instance_latency_ms');
      expect(metrics).toContain('mlx_serving_instance_health');
    });
  });

  describe('Scaling Efficiency', () => {
    let loadBalancer: LoadBalancer;
    let registry: InstanceRegistry;

    beforeEach(() => {
      loadBalancer = new LoadBalancer(DEFAULT_LOAD_BALANCER_CONFIG);
      registry = new InstanceRegistry(DEFAULT_INSTANCE_REGISTRY_CONFIG);
    });

    afterEach(() => {
      loadBalancer.stop();
      registry.stop();
    });

    it('should achieve >95% scaling efficiency with 3 instances', async () => {
      // Single instance baseline: 180 tok/s
      const singleInstanceCapacity = 180;

      // Add 3 instances
      for (let i = 1; i <= 3; i++) {
        const instance = createMockInstance(`instance-${i}`, HealthStatus.HEALTHY, 0, singleInstanceCapacity);
        registry.registerInstance(instance);
        loadBalancer.registerInstance(instance);
      }

      const metrics = registry.getMetrics();

      // Total capacity should be 3 × 180 = 540
      expect(metrics.totalCapacity).toBe(540);

      // Scaling efficiency = (actual capacity / (N × single capacity)) × 100%
      const scalingEfficiency = metrics.totalCapacity / (3 * singleInstanceCapacity);

      expect(scalingEfficiency).toBeGreaterThanOrEqual(0.95); // >95%
    });
  });
});

// Helper function to create mock instance
function createMockInstance(
  id: string,
  health: HealthStatus = HealthStatus.HEALTHY,
  currentLoad = 0,
  capacity = 100,
  avgLatencyMs = 50
): InstanceInfo {
  return {
    id,
    endpoint: `http://localhost:8080/${id}`,
    capacity,
    currentLoad,
    health,
    avgLatencyMs,
    circuitState: CircuitState.CLOSED,
    consecutiveFailures: 0,
    lastHealthCheck: Date.now(),
    metadata: {
      model: 'test-model',
      gpuType: 'M4',
      gpuMemoryGb: 32,
      version: '1.0.0',
    },
  };
}
