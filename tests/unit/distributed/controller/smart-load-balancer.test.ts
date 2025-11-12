/**
 * Smart Load Balancer Unit Tests
 *
 * Tests for 3-phase worker selection: Skills → Hardware → Load
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SmartLoadBalancer } from '@/distributed/controller/load-balancers/smart-load-balancer.js';
import type { WorkerInfo } from '@/distributed/controller/worker-registry.js';
import type { InferenceRequest } from '@/distributed/types/messages.js';

describe('SmartLoadBalancer', () => {
  let balancer: SmartLoadBalancer;

  beforeEach(() => {
    balancer = new SmartLoadBalancer();
  });

  describe('selectWorker - single worker', () => {
    it('should select single online worker', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['mlx-community/Llama-3.2-3B-Instruct-4bit'],
            modelPaths: { 'mlx-community/Llama-3.2-3B-Instruct-4bit': '/models/llama' },
            totalModelSize: 4000000000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-1');
    });

    it('should throw error if no workers available', () => {
      const workers: WorkerInfo[] = [];
      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        prompt: 'Hello',
      };

      expect(() => balancer.selectWorker(workers, request)).toThrow('No online workers available');
    });
  });

  describe('Phase 1: Skills filtering', () => {
    it('should filter workers by available models', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: { 'model-A': '/models/a' },
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-B'],
            modelPaths: { 'model-B': '/models/b' },
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-1');
    });

    it('should throw error if no workers have required model', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: { 'model-A': '/models/a' },
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-B',
        prompt: 'Hello',
      };

      expect(() => balancer.selectWorker(workers, request)).toThrow('No workers can serve model: model-B');
    });

    it('should handle multiple workers with same model', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A', 'model-B'],
            modelPaths: { 'model-A': '/models/a', 'model-B': '/models/b' },
            totalModelSize: 2000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: { 'model-A': '/models/a' },
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      // Should select one of the skilled workers
      expect(['worker-1', 'worker-2']).toContain(selected.workerId);
    });
  });

  describe('Phase 2: Hardware filtering (GPU memory)', () => {
    it('should estimate model memory correctly', () => {
      // Test via worker selection with different model sizes
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['mlx-community/Llama-3.2-3B-Instruct-4bit'],
            modelPaths: { 'mlx-community/Llama-3.2-3B-Instruct-4bit': '/models/llama' },
            totalModelSize: 4000000000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        prompt: 'Hello',
      };

      // Should successfully select (3B model needs ~4GB, estimation works)
      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-1');
    });

    it('should handle 7B model estimation', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['mlx-community/Llama-3.2-7B-Instruct-4bit'],
            modelPaths: {},
            totalModelSize: 8000000000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'mlx-community/Llama-3.2-7B-Instruct-4bit',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected).toBeDefined();
    });

    it('should handle 13B model estimation', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-13b'],
            modelPaths: {},
            totalModelSize: 16000000000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-13b',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected).toBeDefined();
    });

    it('should handle 30B model estimation', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-30b'],
            modelPaths: {},
            totalModelSize: 32000000000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-30b',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected).toBeDefined();
    });
  });

  describe('Phase 3: Load-based selection', () => {
    it('should prefer less loaded worker', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 50,
            memoryUsedGB: 8,
            gpuUtilizationPercent: 50,
            activeRequests: 5,
            totalRequestsHandled: 100,
            avgLatencyMs: 250,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 30,
            memoryUsedGB: 4,
            gpuUtilizationPercent: 30,
            activeRequests: 2,
            totalRequestsHandled: 50,
            avgLatencyMs: 200,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-2'); // Less loaded (2 vs 5)
    });

    it('should handle workers with no metrics', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 50,
            memoryUsedGB: 8,
            gpuUtilizationPercent: 50,
            activeRequests: 3,
            totalRequestsHandled: 100,
            avgLatencyMs: 250,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      // Worker without metrics is treated as having 0 active requests
      expect(selected.workerId).toBe('worker-1');
    });
  });

  describe('Round-robin among tied workers', () => {
    it('should round-robin among workers with same load', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 50,
            memoryUsedGB: 8,
            gpuUtilizationPercent: 50,
            activeRequests: 2,
            totalRequestsHandled: 100,
            avgLatencyMs: 250,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 50,
            memoryUsedGB: 8,
            gpuUtilizationPercent: 50,
            activeRequests: 2,
            totalRequestsHandled: 100,
            avgLatencyMs: 250,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-3',
          hostname: 'mac-3',
          ip: '192.168.1.103',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          metrics: {
            cpuUsagePercent: 50,
            memoryUsedGB: 8,
            gpuUtilizationPercent: 50,
            activeRequests: 2,
            totalRequestsHandled: 100,
            avgLatencyMs: 250,
            modelsLoaded: [],
          },
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      // Should cycle through all 3 workers
      const selected1 = balancer.selectWorker(workers, request);
      const selected2 = balancer.selectWorker(workers, request);
      const selected3 = balancer.selectWorker(workers, request);
      const selected4 = balancer.selectWorker(workers, request); // Should wrap around

      // All 3 workers should be selected
      const selectedIds = new Set([selected1.workerId, selected2.workerId, selected3.workerId]);
      expect(selectedIds.size).toBe(3);

      // Should wrap around (4th selection should match 1st)
      expect(selected4.workerId).toBe(selected1.workerId);
    });
  });

  describe('Offline worker filtering', () => {
    it('should skip offline workers', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'offline',
          lastHeartbeat: Date.now() - 30000,
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-2'); // Only online worker
    });

    it('should throw error if all workers are offline', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'offline',
          lastHeartbeat: Date.now() - 30000,
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      expect(() => balancer.selectWorker(workers, request)).toThrow('No online workers available');
    });
  });

  describe('reset', () => {
    it('should reset round-robin index', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
        {
          workerId: 'worker-2',
          hostname: 'mac-2',
          ip: '192.168.1.102',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      const selected1 = balancer.selectWorker(workers, request);
      balancer.reset();
      const selected2 = balancer.selectWorker(workers, request);

      // After reset, should start from beginning again
      expect(selected1.workerId).toBe(selected2.workerId);
    });
  });

  describe('Edge cases', () => {
    it('should handle degraded worker', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'degraded',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-A',
        prompt: 'Hello',
      };

      // Degraded workers are not online, should throw
      expect(() => balancer.selectWorker(workers, request)).toThrow('No online workers available');
    });

    it('should handle worker with multiple models', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['model-A', 'model-B', 'model-C'],
            modelPaths: {
              'model-A': '/models/a',
              'model-B': '/models/b',
              'model-C': '/models/c',
            },
            totalModelSize: 3000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'model-B',
        prompt: 'Hello',
      };

      const selected = balancer.selectWorker(workers, request);
      expect(selected.workerId).toBe('worker-1');
    });

    it('should handle very large model name', () => {
      const workers: WorkerInfo[] = [
        {
          workerId: 'worker-1',
          hostname: 'mac-1',
          ip: '192.168.1.101',
          port: 8080,
          skills: {
            availableModels: ['very-long-model-name-that-does-not-contain-size-indicator'],
            modelPaths: {},
            totalModelSize: 1000,
            lastScanned: Date.now(),
          },
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
          priority: 50,
          tags: [],
        },
      ];

      const request: InferenceRequest = {
        requestId: 'req-1',
        modelId: 'very-long-model-name-that-does-not-contain-size-indicator',
        prompt: 'Hello',
      };

      // Should use default memory estimate (8GB)
      const selected = balancer.selectWorker(workers, request);
      expect(selected).toBeDefined();
    });
  });
});
