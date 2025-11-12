/**
 * Worker Registry Unit Tests
 *
 * Tests for worker lifecycle management with model skills tracking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerRegistry, type WorkerInfo } from '@/distributed/controller/worker-registry.js';
import type { WorkerRegistration, WorkerHeartbeat } from '@/distributed/types/messages.js';

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry();
  });

  describe('addWorker', () => {
    it('should add new worker with skills', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: ['mlx-community/Llama-3.2-3B-Instruct-4bit'],
          modelPaths: {
            'mlx-community/Llama-3.2-3B-Instruct-4bit': '/models/llama',
          },
          totalModelSize: 4000000000,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      const worker = registry.getWorker(registration.workerId);
      expect(worker).toBeDefined();
      expect(worker?.workerId).toBe(registration.workerId);
      expect(worker?.hostname).toBe(registration.hostname);
      expect(worker?.skills.availableModels).toEqual(['mlx-community/Llama-3.2-3B-Instruct-4bit']);
    });

    it('should update existing worker on re-registration', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: ['model-1'],
          modelPaths: { 'model-1': '/path/1' },
          totalModelSize: 1000,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      // Re-register with different skills
      const updatedRegistration: WorkerRegistration = {
        ...registration,
        skills: {
          availableModels: ['model-1', 'model-2'],
          modelPaths: { 'model-1': '/path/1', 'model-2': '/path/2' },
          totalModelSize: 2000,
          lastScanned: Date.now(),
        },
        timestamp: Date.now() + 1000,
      };

      registry.addWorker(updatedRegistration);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.skills.availableModels).toHaveLength(2);
      expect(worker?.skills.availableModels).toContain('model-2');
    });

    it('should set default priority and tags', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.priority).toBe(50);
      expect(worker?.tags).toEqual([]);
    });
  });

  describe('updateWorker', () => {
    it('should update worker metrics from heartbeat', () => {
      // First add worker
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      // Update with heartbeat
      const heartbeat: WorkerHeartbeat = {
        workerId: registration.workerId,
        status: 'online',
        metrics: {
          cpuUsagePercent: 50,
          memoryUsedGB: 8,
          gpuUtilizationPercent: 75,
          activeRequests: 3,
          totalRequestsHandled: 100,
          avgLatencyMs: 250,
          modelsLoaded: ['model-1'],
        },
        timestamp: Date.now() + 5000,
      };

      registry.updateWorker(heartbeat);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.metrics?.activeRequests).toBe(3);
      expect(worker?.metrics?.cpuUsagePercent).toBe(50);
      expect(worker?.lastHeartbeat).toBe(heartbeat.timestamp);
    });

    it('should handle heartbeat from unknown worker', () => {
      const heartbeat: WorkerHeartbeat = {
        workerId: 'unknown-worker-id',
        status: 'online',
        metrics: {
          cpuUsagePercent: 50,
          memoryUsedGB: 8,
          gpuUtilizationPercent: 75,
          activeRequests: 0,
          totalRequestsHandled: 0,
          avgLatencyMs: 0,
          modelsLoaded: [],
        },
        timestamp: Date.now(),
      };

      // Should not throw
      expect(() => registry.updateWorker(heartbeat)).not.toThrow();
    });

    it('should update worker status from heartbeat', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      const heartbeat: WorkerHeartbeat = {
        workerId: registration.workerId,
        status: 'degraded',
        metrics: {
          cpuUsagePercent: 90,
          memoryUsedGB: 15,
          gpuUtilizationPercent: 95,
          activeRequests: 10,
          totalRequestsHandled: 100,
          avgLatencyMs: 500,
          modelsLoaded: [],
        },
        timestamp: Date.now() + 5000,
      };

      registry.updateWorker(heartbeat);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.status).toBe('degraded');
    });
  });

  describe('removeWorker', () => {
    it('should remove worker from registry', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);
      expect(registry.hasWorker(registration.workerId)).toBe(true);

      registry.removeWorker(registration.workerId);
      expect(registry.hasWorker(registration.workerId)).toBe(false);
    });

    it('should handle removing unknown worker', () => {
      expect(() => registry.removeWorker('unknown-id')).not.toThrow();
    });
  });

  describe('markOffline', () => {
    it('should mark worker as offline', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      registry.markOffline(registration.workerId);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.status).toBe('offline');
    });

    it('should handle marking unknown worker offline', () => {
      expect(() => registry.markOffline('unknown-id')).not.toThrow();
    });

    it('should not change status if already offline', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'offline',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);
      registry.markOffline(registration.workerId);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.status).toBe('offline');
    });
  });

  describe('getWorker', () => {
    it('should return worker by ID', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      const worker = registry.getWorker(registration.workerId);
      expect(worker).toBeDefined();
      expect(worker?.workerId).toBe(registration.workerId);
    });

    it('should return undefined for unknown worker', () => {
      const worker = registry.getWorker('unknown-id');
      expect(worker).toBeUndefined();
    });
  });

  describe('getAllWorkers', () => {
    it('should return all workers', () => {
      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      const reg2: WorkerRegistration = {
        workerId: '223e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-2',
        ip: '192.168.1.102',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      registry.addWorker(reg2);

      const workers = registry.getAllWorkers();
      expect(workers).toHaveLength(2);
    });

    it('should return empty array when no workers', () => {
      const workers = registry.getAllWorkers();
      expect(workers).toEqual([]);
    });
  });

  describe('getOnlineWorkers', () => {
    it('should return only online workers', () => {
      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      const reg2: WorkerRegistration = {
        workerId: '223e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-2',
        ip: '192.168.1.102',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'offline',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      registry.addWorker(reg2);

      const onlineWorkers = registry.getOnlineWorkers();
      expect(onlineWorkers).toHaveLength(1);
      expect(onlineWorkers[0].workerId).toBe(reg1.workerId);
    });
  });

  describe('getOfflineWorkers', () => {
    it('should return only offline workers', () => {
      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      const reg2: WorkerRegistration = {
        workerId: '223e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-2',
        ip: '192.168.1.102',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'offline',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      registry.addWorker(reg2);

      const offlineWorkers = registry.getOfflineWorkers();
      expect(offlineWorkers).toHaveLength(1);
      expect(offlineWorkers[0].workerId).toBe(reg2.workerId);
    });
  });

  describe('getWorkerCount', () => {
    it('should return total worker count', () => {
      expect(registry.getWorkerCount()).toBe(0);

      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      expect(registry.getWorkerCount()).toBe(1);
    });
  });

  describe('getOnlineWorkerCount', () => {
    it('should return online worker count', () => {
      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      const reg2: WorkerRegistration = {
        workerId: '223e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-2',
        ip: '192.168.1.102',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'offline',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      registry.addWorker(reg2);

      expect(registry.getOnlineWorkerCount()).toBe(1);
    });
  });

  describe('hasWorker', () => {
    it('should return true if worker exists', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      expect(registry.hasWorker(registration.workerId)).toBe(true);
    });

    it('should return false if worker does not exist', () => {
      expect(registry.hasWorker('unknown-id')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all workers', () => {
      const reg1: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(reg1);
      expect(registry.getWorkerCount()).toBe(1);

      registry.clear();
      expect(registry.getWorkerCount()).toBe(0);
    });
  });

  describe('worker with no skills', () => {
    it('should handle worker with empty skills', () => {
      const registration: WorkerRegistration = {
        workerId: '123e4567-e89b-12d3-a456-426614174000',
        hostname: 'worker-1',
        ip: '192.168.1.101',
        port: 8080,
        skills: {
          availableModels: [],
          modelPaths: {},
          totalModelSize: 0,
          lastScanned: Date.now(),
        },
        status: 'online',
        timestamp: Date.now(),
      };

      registry.addWorker(registration);

      const worker = registry.getWorker(registration.workerId);
      expect(worker?.skills.availableModels).toEqual([]);
      expect(worker?.skills.modelPaths).toEqual({});
    });
  });
});
