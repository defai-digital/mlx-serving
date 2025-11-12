import { describe, it, expect, beforeEach } from 'vitest';
import { HardwareReporter } from '@/distributed/worker/hardware-reporter.js';

describe('HardwareReporter', () => {
  let reporter: HardwareReporter;

  beforeEach(() => {
    reporter = new HardwareReporter();
  });

  describe('getHardwareProfile()', () => {
    it('should return hardware profile on initialization', () => {
      const hardware = reporter.getHardwareProfile();

      expect(hardware).toBeDefined();
      expect(hardware.chipModel).toBeTruthy();
      expect(hardware.gpuCores).toBeGreaterThan(0);
      expect(hardware.cpuCores).toBeGreaterThan(0);
      expect(hardware.unifiedMemoryGB).toBeGreaterThan(0);
    });

    it('should include chip generation', () => {
      const hardware = reporter.getHardwareProfile();

      expect(hardware.chipGeneration).toBeGreaterThanOrEqual(1);
      expect(hardware.chipGeneration).toBeLessThanOrEqual(5);
    });

    it('should include chip variant', () => {
      const hardware = reporter.getHardwareProfile();

      expect(['Base', 'Pro', 'Max', 'Ultra']).toContain(hardware.variant);
    });

    it('should include Metal version', () => {
      const hardware = reporter.getHardwareProfile();

      expect(hardware.metalVersion).toBeTruthy();
    });

    it('should include OS version', () => {
      const hardware = reporter.getHardwareProfile();

      expect(hardware.osVersion).toBeTruthy();
    });

    it('should include detection timestamp', () => {
      const hardware = reporter.getHardwareProfile();

      expect(hardware.detectedAt).toBeGreaterThan(0);
      expect(hardware.detectedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('getCapabilities()', () => {
    it('should calculate worker capabilities', () => {
      const capabilities = reporter.getCapabilities();

      expect(capabilities).toBeDefined();
      expect(capabilities.maxConcurrent).toBeGreaterThan(0);
      expect(capabilities.supportedModelTiers).toBeInstanceOf(Array);
      expect(capabilities.supportedModelTiers.length).toBeGreaterThan(0);
      expect(capabilities.availableMemoryGB).toBeGreaterThan(0);
    });

    it('should support at least small models', () => {
      const capabilities = reporter.getCapabilities();

      expect(capabilities.supportedModelTiers).toContain('<3B');
    });

    it('should have reasonable max concurrent', () => {
      const capabilities = reporter.getCapabilities();

      expect(capabilities.maxConcurrent).toBeGreaterThan(0);
      expect(capabilities.maxConcurrent).toBeLessThan(100);
    });

    it('should reserve memory for system', () => {
      const hardware = reporter.getHardwareProfile();
      const capabilities = reporter.getCapabilities();

      // Available memory should be less than total (20% reserved)
      expect(capabilities.availableMemoryGB).toBeLessThan(hardware.unifiedMemoryGB);
      expect(capabilities.availableMemoryGB).toBeGreaterThan(0);
    });
  });

  describe('getCpuUsage()', () => {
    it('should return CPU usage percentage', async () => {
      const usage = await reporter.getCpuUsage();

      expect(usage).toBeGreaterThanOrEqual(0);
      expect(usage).toBeLessThanOrEqual(100);
    });

    it('should track CPU usage changes over time', async () => {
      const usage1 = await reporter.getCpuUsage();

      // Wait a bit for delta calculation
      await new Promise((resolve) => setTimeout(resolve, 100));

      const usage2 = await reporter.getCpuUsage();

      // Both readings should be valid
      expect(usage1).toBeGreaterThanOrEqual(0);
      expect(usage1).toBeLessThanOrEqual(100);
      expect(usage2).toBeGreaterThanOrEqual(0);
      expect(usage2).toBeLessThanOrEqual(100);
    });

    it('should handle errors gracefully', async () => {
      // Should not throw
      const usage = await reporter.getCpuUsage();

      expect(usage).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMemoryUsage()', () => {
    it('should return memory usage in GB', () => {
      const usage = reporter.getMemoryUsage();

      expect(usage).toBeGreaterThan(0);
      expect(usage).toBeLessThan(1000); // <1TB (sanity check)
    });

    it('should return reasonable memory usage', () => {
      const hardware = reporter.getHardwareProfile();
      const usage = reporter.getMemoryUsage();

      // Memory usage should be less than total
      expect(usage).toBeLessThanOrEqual(hardware.unifiedMemoryGB);
    });
  });

  describe('getAvailableMemory()', () => {
    it('should return available memory in GB', () => {
      const available = reporter.getAvailableMemory();

      expect(available).toBeGreaterThan(0);
      expect(available).toBeLessThan(1000); // <1TB (sanity check)
    });

    it('should be less than total memory', () => {
      const hardware = reporter.getHardwareProfile();
      const available = reporter.getAvailableMemory();

      expect(available).toBeLessThanOrEqual(hardware.unifiedMemoryGB);
    });

    it('should be inversely related to memory usage', () => {
      const usage = reporter.getMemoryUsage();
      const available = reporter.getAvailableMemory();

      // Used + available should be close to total
      const hardware = reporter.getHardwareProfile();
      const total = hardware.unifiedMemoryGB;

      expect(usage + available).toBeCloseTo(total, 1);
    });
  });

  describe('getGpuUtilization()', () => {
    it('should return 0 (not implemented yet)', () => {
      const utilization = reporter.getGpuUtilization();

      expect(utilization).toBe(0);
    });
  });

  describe('supported model tiers', () => {
    it('should support tiers based on hardware', () => {
      const hardware = reporter.getHardwareProfile();
      const capabilities = reporter.getCapabilities();

      // Minimum: always support small models
      expect(capabilities.supportedModelTiers).toContain('<3B');

      // High-end hardware should support larger models
      if (hardware.gpuCores >= 30 && hardware.unifiedMemoryGB >= 64) {
        expect(capabilities.supportedModelTiers).toContain('30B+');
      }

      if (hardware.gpuCores >= 20 && hardware.unifiedMemoryGB >= 32) {
        expect(capabilities.supportedModelTiers).toContain('13-27B');
      }

      if (hardware.gpuCores >= 15 && hardware.unifiedMemoryGB >= 16) {
        expect(capabilities.supportedModelTiers).toContain('7-13B');
      }

      if (hardware.gpuCores >= 10 && hardware.unifiedMemoryGB >= 8) {
        expect(capabilities.supportedModelTiers).toContain('3-7B');
      }
    });

    it('should have tiers ordered by capability', () => {
      const capabilities = reporter.getCapabilities();
      const allTiers: string[] = ['30B+', '13-27B', '7-13B', '3-7B', '<3B'];

      // Check that supported tiers appear in correct order
      let lastIndex = -1;
      for (const tier of capabilities.supportedModelTiers) {
        const index = allTiers.indexOf(tier);
        expect(index).toBeGreaterThan(lastIndex);
        lastIndex = index;
      }
    });
  });
});
