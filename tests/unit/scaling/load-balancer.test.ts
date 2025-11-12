/**
 * LoadBalancer Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LoadBalancer, DEFAULT_LOAD_BALANCER_CONFIG } from '@/scaling/LoadBalancer.js';
import type {
  InstanceInfo,
  LoadBalancerConfig,
  LoadBalancingStrategy,
} from '@/types/scaling.js';
import { HealthStatus, CircuitState } from '@/types/scaling.js';
import type { GeneratorParams } from '@/types/generators.js';

describe('LoadBalancer', () => {
  let loadBalancer: LoadBalancer;
  let config: LoadBalancerConfig;

  beforeEach(() => {
    config = { ...DEFAULT_LOAD_BALANCER_CONFIG };
    loadBalancer = new LoadBalancer(config);
  });

  afterEach(() => {
    loadBalancer.stop();
  });

  describe('Instance Management', () => {
    it('should register a new instance', () => {
      const instance: InstanceInfo = createMockInstance('instance-1');

      loadBalancer.registerInstance(instance);

      const retrieved = loadBalancer.getInstance('instance-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('instance-1');
    });

    it('should unregister an instance', () => {
      const instance: InstanceInfo = createMockInstance('instance-1');

      loadBalancer.registerInstance(instance);
      loadBalancer.unregisterInstance('instance-1');

      const retrieved = loadBalancer.getInstance('instance-1');
      expect(retrieved).toBeUndefined();
    });

    it('should get all instances', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));
      loadBalancer.registerInstance(createMockInstance('instance-2'));
      loadBalancer.registerInstance(createMockInstance('instance-3'));

      const instances = loadBalancer.getAllInstances();
      expect(instances).toHaveLength(3);
    });

    it('should update instance load', () => {
      const instance: InstanceInfo = createMockInstance('instance-1');
      loadBalancer.registerInstance(instance);

      loadBalancer.updateInstanceLoad('instance-1', 100);

      const updated = loadBalancer.getInstance('instance-1');
      expect(updated?.currentLoad).toBe(100);
    });
  });

  describe('Routing Strategies', () => {
    describe('Round Robin', () => {
      beforeEach(() => {
        config.strategy = 'round-robin' as LoadBalancingStrategy;
        loadBalancer = new LoadBalancer(config);
      });

      it('should distribute requests evenly', async () => {
        loadBalancer.registerInstance(createMockInstance('instance-1'));
        loadBalancer.registerInstance(createMockInstance('instance-2'));
        loadBalancer.registerInstance(createMockInstance('instance-3'));

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision1 = await loadBalancer.route(request);
        const decision2 = await loadBalancer.route(request);
        const decision3 = await loadBalancer.route(request);
        const decision4 = await loadBalancer.route(request);

        expect(decision1.instance.id).toBe('instance-1');
        expect(decision2.instance.id).toBe('instance-2');
        expect(decision3.instance.id).toBe('instance-3');
        expect(decision4.instance.id).toBe('instance-1');
      });

      it('should skip unhealthy instances', async () => {
        const instance1 = createMockInstance('instance-1');
        const instance2 = createMockInstance('instance-2', HealthStatus.UNHEALTHY);
        const instance3 = createMockInstance('instance-3');

        loadBalancer.registerInstance(instance1);
        loadBalancer.registerInstance(instance2);
        loadBalancer.registerInstance(instance3);

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision1 = await loadBalancer.route(request);
        const decision2 = await loadBalancer.route(request);

        // Should only route to instance-1 and instance-3
        expect([decision1.instance.id, decision2.instance.id]).not.toContain('instance-2');
      });
    });

    describe('Least Loaded', () => {
      beforeEach(() => {
        config.strategy = 'least-loaded' as LoadBalancingStrategy;
        loadBalancer = new LoadBalancer(config);
      });

      it('should route to instance with lowest load', async () => {
        const instance1 = createMockInstance('instance-1', HealthStatus.HEALTHY, 50, 100);
        const instance2 = createMockInstance('instance-2', HealthStatus.HEALTHY, 20, 100);
        const instance3 = createMockInstance('instance-3', HealthStatus.HEALTHY, 80, 100);

        loadBalancer.registerInstance(instance1);
        loadBalancer.registerInstance(instance2);
        loadBalancer.registerInstance(instance3);

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision = await loadBalancer.route(request);

        expect(decision.instance.id).toBe('instance-2');
        expect(decision.reason).toBe('Least loaded instance');
      });

      it('should adapt to changing load', async () => {
        loadBalancer.registerInstance(createMockInstance('instance-1', HealthStatus.HEALTHY, 10, 100));
        loadBalancer.registerInstance(createMockInstance('instance-2', HealthStatus.HEALTHY, 50, 100));

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision1 = await loadBalancer.route(request);
        expect(decision1.instance.id).toBe('instance-1');

        // Increase load on instance-1
        loadBalancer.updateInstanceLoad('instance-1', 90);

        const decision2 = await loadBalancer.route(request);
        expect(decision2.instance.id).toBe('instance-2');
      });
    });

    describe('Latency Aware', () => {
      beforeEach(() => {
        config.strategy = 'latency-aware' as LoadBalancingStrategy;
        loadBalancer = new LoadBalancer(config);
      });

      it('should route to instance with lowest estimated latency', async () => {
        const instance1 = createMockInstance('instance-1', HealthStatus.HEALTHY, 0, 100, 50);
        const instance2 = createMockInstance('instance-2', HealthStatus.HEALTHY, 0, 100, 20);
        const instance3 = createMockInstance('instance-3', HealthStatus.HEALTHY, 0, 100, 100);

        loadBalancer.registerInstance(instance1);
        loadBalancer.registerInstance(instance2);
        loadBalancer.registerInstance(instance3);

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision = await loadBalancer.route(request);

        expect(decision.instance.id).toBe('instance-2');
        expect(decision.reason).toBe('Lowest estimated latency');
      });

      it('should consider load in latency estimation', async () => {
        const instance1 = createMockInstance('instance-1', HealthStatus.HEALTHY, 90, 100, 20);
        const instance2 = createMockInstance('instance-2', HealthStatus.HEALTHY, 10, 100, 50);

        loadBalancer.registerInstance(instance1);
        loadBalancer.registerInstance(instance2);

        const request: GeneratorParams = { model: 'test', prompt: 'hello' };

        const decision = await loadBalancer.route(request);

        // Instance-2 should be selected despite higher base latency due to lower load
        expect(decision.instance.id).toBe('instance-2');
      });
    });

    describe('Consistent Hash', () => {
      beforeEach(() => {
        config.strategy = 'consistent-hash' as LoadBalancingStrategy;
        loadBalancer = new LoadBalancer(config);
      });

      it('should route same prompt to same instance', async () => {
        loadBalancer.registerInstance(createMockInstance('instance-1'));
        loadBalancer.registerInstance(createMockInstance('instance-2'));
        loadBalancer.registerInstance(createMockInstance('instance-3'));

        const request: GeneratorParams = { model: 'test', prompt: 'consistent prompt' };

        const decision1 = await loadBalancer.route(request);
        const decision2 = await loadBalancer.route(request);
        const decision3 = await loadBalancer.route(request);

        expect(decision1.instance.id).toBe(decision2.instance.id);
        expect(decision2.instance.id).toBe(decision3.instance.id);
      });

      it('should route different prompts to different instances', async () => {
        loadBalancer.registerInstance(createMockInstance('instance-1'));
        loadBalancer.registerInstance(createMockInstance('instance-2'));
        loadBalancer.registerInstance(createMockInstance('instance-3'));

        const request1: GeneratorParams = { model: 'test', prompt: 'prompt A' };
        const request2: GeneratorParams = { model: 'test', prompt: 'prompt B' };
        const request3: GeneratorParams = { model: 'test', prompt: 'prompt C' };

        const decision1 = await loadBalancer.route(request1);
        const decision2 = await loadBalancer.route(request2);
        const decision3 = await loadBalancer.route(request3);

        const instances = new Set([decision1.instance.id, decision2.instance.id, decision3.instance.id]);

        // Should distribute across instances
        expect(instances.size).toBeGreaterThan(1);
      });
    });
  });

  describe('Health Checking', () => {
    it('should start health checking', () => {
      loadBalancer.start();
      expect(loadBalancer['healthCheckInterval']).toBeDefined();
    });

    it('should stop health checking', () => {
      loadBalancer.start();
      loadBalancer.stop();
      expect(loadBalancer['healthCheckInterval']).toBeUndefined();
    });

    it('should filter out unhealthy instances', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1', HealthStatus.HEALTHY));
      loadBalancer.registerInstance(createMockInstance('instance-2', HealthStatus.UNHEALTHY));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.route(request);

      expect(decision.instance.id).toBe('instance-1');
    });

    it('should throw error when no healthy instances available', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1', HealthStatus.UNHEALTHY));
      loadBalancer.registerInstance(createMockInstance('instance-2', HealthStatus.UNHEALTHY));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      await expect(loadBalancer.route(request)).rejects.toThrow('No healthy instances available');
    });
  });

  describe('Circuit Breaker', () => {
    beforeEach(() => {
      config.circuitBreaker.enabled = true;
      config.circuitBreaker.failureThreshold = 3;
      loadBalancer = new LoadBalancer(config);
    });

    it('should open circuit after threshold failures', () => {
      const instance = createMockInstance('instance-1');
      loadBalancer.registerInstance(instance);

      // Report failures
      loadBalancer.reportFailure('instance-1', new Error('test error'));
      loadBalancer.reportFailure('instance-1', new Error('test error'));
      loadBalancer.reportFailure('instance-1', new Error('test error'));

      const updated = loadBalancer.getInstance('instance-1');
      expect(updated?.circuitState).toBe(CircuitState.OPEN);
      expect(updated?.health).toBe(HealthStatus.UNHEALTHY);
    });

    it('should reset failures on success', () => {
      const instance = createMockInstance('instance-1');
      loadBalancer.registerInstance(instance);

      // Report failures
      loadBalancer.reportFailure('instance-1', new Error('test error'));
      loadBalancer.reportFailure('instance-1', new Error('test error'));

      // Report success
      loadBalancer.reportSuccess('instance-1', 100);

      const updated = loadBalancer.getInstance('instance-1');
      expect(updated?.consecutiveFailures).toBe(0);
    });

    it('should close circuit on success in half-open state', () => {
      const instance = createMockInstance('instance-1');
      instance.circuitState = CircuitState.HALF_OPEN;
      loadBalancer.registerInstance(instance);

      loadBalancer.reportSuccess('instance-1', 100);

      const updated = loadBalancer.getInstance('instance-1');
      expect(updated?.circuitState).toBe(CircuitState.CLOSED);
    });

    it('should filter out open circuit instances', async () => {
      const instance1 = createMockInstance('instance-1');
      const instance2 = createMockInstance('instance-2');
      instance2.circuitState = CircuitState.OPEN;

      loadBalancer.registerInstance(instance1);
      loadBalancer.registerInstance(instance2);

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.route(request);

      expect(decision.instance.id).toBe('instance-1');
    });
  });

  describe('Metrics', () => {
    it('should track total requests', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      await loadBalancer.route(request);
      await loadBalancer.route(request);
      await loadBalancer.route(request);

      const metrics = loadBalancer.getMetrics();
      expect(metrics.totalRequests).toBe(3);
    });

    it('should track requests per instance', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));
      loadBalancer.registerInstance(createMockInstance('instance-2'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      await loadBalancer.route(request);
      await loadBalancer.route(request);

      const metrics = loadBalancer.getMetrics();
      const totalPerInstance = Object.values(metrics.requestsPerInstance).reduce((sum, count) => sum + count, 0);

      expect(totalPerInstance).toBe(2);
    });

    it('should track failures', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      loadBalancer.reportFailure('instance-1', new Error('test error'));
      loadBalancer.reportFailure('instance-1', new Error('test error'));

      const metrics = loadBalancer.getMetrics();
      expect(metrics.totalFailures).toBe(2);
      expect(metrics.failuresPerInstance['instance-1']).toBe(2);
    });

    it('should track average latency', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      loadBalancer.reportSuccess('instance-1', 100);
      loadBalancer.reportSuccess('instance-1', 200);
      loadBalancer.reportSuccess('instance-1', 150);

      const metrics = loadBalancer.getMetrics();
      expect(metrics.avgLatencyPerInstance['instance-1']).toBe(150);
    });

    it('should calculate utilization', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1', HealthStatus.HEALTHY, 50, 100));
      loadBalancer.registerInstance(createMockInstance('instance-2', HealthStatus.HEALTHY, 30, 100));

      const metrics = loadBalancer.getMetrics();
      expect(metrics.totalCapacity).toBe(200);
      expect(metrics.totalLoad).toBe(80);
      expect(metrics.utilization).toBe(0.4);
    });

    it('should count healthy/degraded/unhealthy instances', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1', HealthStatus.HEALTHY));
      loadBalancer.registerInstance(createMockInstance('instance-2', HealthStatus.HEALTHY));
      loadBalancer.registerInstance(createMockInstance('instance-3', HealthStatus.DEGRADED));
      loadBalancer.registerInstance(createMockInstance('instance-4', HealthStatus.UNHEALTHY));

      const metrics = loadBalancer.getMetrics();
      expect(metrics.healthyInstances).toBe(2);
      expect(metrics.degradedInstances).toBe(1);
      expect(metrics.unhealthyInstances).toBe(1);
    });

    it('should reset metrics', () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      loadBalancer.reportFailure('instance-1', new Error('test error'));

      loadBalancer.resetMetrics();

      const metrics = loadBalancer.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.totalFailures).toBe(0);
    });
  });

  describe('Retry Logic', () => {
    beforeEach(() => {
      config.maxRetries = 3;
      config.retryDelayMs = 10;
      loadBalancer = new LoadBalancer(config);
    });

    it('should retry on failure', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.routeWithRetry(request);

      expect(decision.instance).toBeDefined();
    });

    it('should throw after max retries', async () => {
      // No instances registered

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      await expect(loadBalancer.routeWithRetry(request)).rejects.toThrow();
    });
  });

  describe('Routing Decision', () => {
    it('should include alternatives', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));
      loadBalancer.registerInstance(createMockInstance('instance-2'));
      loadBalancer.registerInstance(createMockInstance('instance-3'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.route(request);

      expect(decision.alternatives).toHaveLength(2);
      expect(decision.alternatives.map(i => i.id)).not.toContain(decision.instance.id);
    });

    it('should include estimated latency', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.route(request);

      expect(decision.estimatedLatencyMs).toBeGreaterThan(0);
    });

    it('should include routing reason', async () => {
      loadBalancer.registerInstance(createMockInstance('instance-1'));

      const request: GeneratorParams = { model: 'test', prompt: 'hello' };

      const decision = await loadBalancer.route(request);

      expect(decision.reason).toBeDefined();
      expect(decision.reason.length).toBeGreaterThan(0);
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
