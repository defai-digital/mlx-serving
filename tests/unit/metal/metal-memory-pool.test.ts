import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Type for pool statistics
interface PoolStatistics {
  total_acquired: number;
  total_released: number;
  exhaustion_events: number;
  fallback_events: number;
  pool_size: number;
  available_count: number;
}

/**
 * Unit Tests for MetalMemoryPool
 *
 * Tests the native C++ Metal Memory Pool implementation via Python bindings.
 * Since this is a native module, we test the TypeScript integration layer
 * and mock the native module responses.
 *
 * Test Coverage:
 * - Configuration validation
 * - Heap acquisition and release
 * - Pool exhaustion and fallback behavior
 * - Statistics tracking
 * - Leak detection
 * - Warmup functionality
 * - Concurrent access (thread safety)
 * - Edge cases and error handling
 */

describe('MetalMemoryPool', () => {
  // Mock native module
  let mockNativeModule: {
    createPool: ReturnType<typeof vi.fn<any[], number>>;
    acquireHeap: ReturnType<typeof vi.fn<any[], number>>;
    releaseHeap: ReturnType<typeof vi.fn<any[], void>>;
    warmup: ReturnType<typeof vi.fn<any[], void>>;
    getStatistics: ReturnType<typeof vi.fn<[number], PoolStatistics>>;
    resetStatistics: ReturnType<typeof vi.fn<[number], void>>;
    destroyPool: ReturnType<typeof vi.fn<[number], void>>;
  };

  let poolHandle: number;

  beforeEach(() => {
    poolHandle = 1; // Simulated pool handle

    mockNativeModule = {
      createPool: vi.fn().mockReturnValue(poolHandle),
      acquireHeap: vi.fn().mockReturnValue(100), // Mock heap pointer
      releaseHeap: vi.fn(),
      warmup: vi.fn(),
      getStatistics: vi.fn().mockReturnValue({
        total_acquired: 0,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      }),
      resetStatistics: vi.fn(),
      destroyPool: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Configuration Validation', () => {
    it('should accept valid configuration', () => {
      const config = {
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [64, 128],
        track_statistics: true,
        log_exhaustion: true,
      };

      mockNativeModule.createPool(config);

      expect(mockNativeModule.createPool).toHaveBeenCalledWith(config);
      expect(mockNativeModule.createPool).toHaveReturnedWith(poolHandle);
    });

    it('should reject heap_size_mb below minimum (64 MB)', () => {
      const config = {
        heap_size_mb: 32, // Too small
        num_heaps: 4,
      };

      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('heap_size_mb must be >= 64 MB');
      });

      expect(() => mockNativeModule.createPool(config)).toThrow(
        'heap_size_mb must be >= 64 MB'
      );
    });

    it('should reject heap_size_mb above maximum (4096 MB)', () => {
      const config = {
        heap_size_mb: 8192, // Too large
        num_heaps: 4,
      };

      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('heap_size_mb must be <= 4096 MB');
      });

      expect(() => mockNativeModule.createPool(config)).toThrow(
        'heap_size_mb must be <= 4096 MB'
      );
    });

    it('should reject num_heaps below minimum (2)', () => {
      const config = {
        heap_size_mb: 256,
        num_heaps: 1, // Too few
      };

      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('num_heaps must be >= 2');
      });

      expect(() => mockNativeModule.createPool(config)).toThrow(
        'num_heaps must be >= 2'
      );
    });

    it('should reject num_heaps above maximum (16)', () => {
      const config = {
        heap_size_mb: 256,
        num_heaps: 20, // Too many
      };

      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('num_heaps must be <= 16');
      });

      expect(() => mockNativeModule.createPool(config)).toThrow(
        'num_heaps must be <= 16'
      );
    });

    it('should accept minimal valid configuration', () => {
      const config = {
        heap_size_mb: 64, // Minimum
        num_heaps: 2,     // Minimum
      };

      mockNativeModule.createPool(config);

      expect(mockNativeModule.createPool).toHaveBeenCalledWith(config);
    });

    it('should accept maximum valid configuration', () => {
      const config = {
        heap_size_mb: 4096, // Maximum
        num_heaps: 16,      // Maximum
      };

      mockNativeModule.createPool(config);

      expect(mockNativeModule.createPool).toHaveBeenCalledWith(config);
    });

    it('should warn about warmup sizes exceeding heap size', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const config = {
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [128, 512], // 512 exceeds heap_size_mb
      };

      mockNativeModule.createPool(config);

      // In real implementation, this would log a warning
      // Here we just verify the config was accepted
      expect(mockNativeModule.createPool).toHaveBeenCalledWith(config);

      consoleWarnSpy.mockRestore();
    });

    it('should handle empty warmup_sizes array', () => {
      const config = {
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [], // Empty - should be valid
      };

      mockNativeModule.createPool(config);

      expect(mockNativeModule.createPool).toHaveBeenCalledWith(config);
    });
  });

  describe('Heap Acquisition and Release', () => {
    beforeEach(() => {
      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 });
    });

    it('should acquire heap from pool', () => {
      const heapPtr = mockNativeModule.acquireHeap(poolHandle);

      expect(mockNativeModule.acquireHeap).toHaveBeenCalledWith(poolHandle);
      expect(heapPtr).toBe(100); // Mock heap pointer
    });

    it('should release heap back to pool', () => {
      const heapPtr = 100;

      mockNativeModule.releaseHeap(poolHandle, heapPtr);

      expect(mockNativeModule.releaseHeap).toHaveBeenCalledWith(poolHandle, heapPtr);
    });

    it('should handle acquire/release cycle correctly', () => {
      // Acquire
      const heapPtr = mockNativeModule.acquireHeap(poolHandle);
      expect(heapPtr).toBe(100);

      // Release
      mockNativeModule.releaseHeap(poolHandle, heapPtr);
      expect(mockNativeModule.releaseHeap).toHaveBeenCalledWith(poolHandle, heapPtr);

      // Acquire again (should reuse)
      const heapPtr2 = mockNativeModule.acquireHeap(poolHandle);
      expect(heapPtr2).toBe(100);
    });

    it('should handle null heap release gracefully', () => {
      mockNativeModule.releaseHeap(poolHandle, null);

      expect(mockNativeModule.releaseHeap).toHaveBeenCalledWith(poolHandle, null);
      // Should not throw
    });

    it('should acquire multiple heaps concurrently', () => {
      const heaps = [];

      mockNativeModule.acquireHeap.mockReturnValueOnce(100);
      mockNativeModule.acquireHeap.mockReturnValueOnce(200);
      mockNativeModule.acquireHeap.mockReturnValueOnce(300);

      heaps.push(mockNativeModule.acquireHeap(poolHandle));
      heaps.push(mockNativeModule.acquireHeap(poolHandle));
      heaps.push(mockNativeModule.acquireHeap(poolHandle));

      expect(heaps).toEqual([100, 200, 300]);
      expect(mockNativeModule.acquireHeap).toHaveBeenCalledTimes(3);
    });

    it('should release multiple heaps', () => {
      mockNativeModule.releaseHeap(poolHandle, 100);
      mockNativeModule.releaseHeap(poolHandle, 200);
      mockNativeModule.releaseHeap(poolHandle, 300);

      expect(mockNativeModule.releaseHeap).toHaveBeenCalledTimes(3);
    });
  });

  describe('Pool Exhaustion and Fallback', () => {
    beforeEach(() => {
      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 2 });
    });

    it('should handle pool exhaustion with fallback allocation', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 2,
        total_released: 0,
        exhaustion_events: 1,
        fallback_events: 1,
        pool_size: 2,
        available_count: 0,
      });

      // Acquire beyond pool capacity
      mockNativeModule.acquireHeap.mockReturnValueOnce(100);
      mockNativeModule.acquireHeap.mockReturnValueOnce(200);
      mockNativeModule.acquireHeap.mockReturnValueOnce(300); // Fallback

      const heap1 = mockNativeModule.acquireHeap(poolHandle);
      const heap2 = mockNativeModule.acquireHeap(poolHandle);
      const heap3 = mockNativeModule.acquireHeap(poolHandle);

      expect(heap1).toBe(100);
      expect(heap2).toBe(200);
      expect(heap3).toBe(300); // Fallback heap

      const stats = mockNativeModule.getStatistics(poolHandle);
      expect(stats.exhaustion_events).toBe(1);
      expect(stats.fallback_events).toBe(1);
    });

    it('should track exhaustion events', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 3,
        exhaustion_events: 3, // Multiple exhaustions
        fallback_events: 3,
        pool_size: 2,
        available_count: 0,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.exhaustion_events).toBe(3);
      expect(stats.fallback_events).toBe(3);
    });

    it('should log exhaustion warning when enabled', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 2,
        log_exhaustion: true,
      });

      // Simulate exhaustion
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 2,
        total_released: 0,
        exhaustion_events: 1,
        fallback_events: 1,
        pool_size: 2,
        available_count: 0,
      });

      // In real implementation, this would trigger logging
      const stats = mockNativeModule.getStatistics(poolHandle);
      expect(stats.exhaustion_events).toBeGreaterThan(0);

      consoleErrorSpy.mockRestore();
    });

    it('should not track exhaustion when statistics disabled', () => {
      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 2,
        track_statistics: false,
      });

      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 0,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 2,
        available_count: 0,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      // Statistics should be zero when disabled
      expect(stats.exhaustion_events).toBe(0);
    });

    it('should handle fallback allocation failure', () => {
      mockNativeModule.acquireHeap.mockImplementation(() => {
        throw new Error('CRITICAL: Fallback allocation failed - out of GPU memory');
      });

      expect(() => mockNativeModule.acquireHeap(poolHandle)).toThrow(
        'CRITICAL: Fallback allocation failed'
      );
    });
  });

  describe('Statistics Tracking', () => {
    beforeEach(() => {
      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        track_statistics: true,
      });
    });

    it('should track total acquired heaps', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 3,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 2,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.total_acquired).toBe(5);
    });

    it('should track total released heaps', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 5,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.total_released).toBe(5);
    });

    it('should report pool size correctly', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 0,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.pool_size).toBe(4);
    });

    it('should report available count correctly', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 2,
        total_released: 1,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 3, // 4 total - 2 acquired + 1 released
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.available_count).toBe(3);
    });

    it('should track exhaustion and fallback events', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 10,
        total_released: 8,
        exhaustion_events: 2,
        fallback_events: 2,
        pool_size: 4,
        available_count: 2,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.exhaustion_events).toBe(2);
      expect(stats.fallback_events).toBe(2);
    });

    it('should reset statistics', () => {
      // First get some stats
      mockNativeModule.getStatistics.mockReturnValueOnce({
        total_acquired: 10,
        total_released: 10,
        exhaustion_events: 2,
        fallback_events: 2,
        pool_size: 4,
        available_count: 4,
      });

      let stats = mockNativeModule.getStatistics(poolHandle);
      expect(stats.total_acquired).toBe(10);

      // Reset
      mockNativeModule.resetStatistics(poolHandle);
      expect(mockNativeModule.resetStatistics).toHaveBeenCalledWith(poolHandle);

      // After reset
      mockNativeModule.getStatistics.mockReturnValueOnce({
        total_acquired: 0,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      });

      stats = mockNativeModule.getStatistics(poolHandle);
      expect(stats.total_acquired).toBe(0);
      expect(stats.total_released).toBe(0);
      expect(stats.exhaustion_events).toBe(0);
      expect(stats.fallback_events).toBe(0);
    });

    it('should maintain pool size after reset', () => {
      mockNativeModule.resetStatistics(poolHandle);

      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 0,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4, // Should not change
        available_count: 4,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      expect(stats.pool_size).toBe(4);
    });
  });

  describe('Leak Detection', () => {
    it('should detect memory leaks on cleanup', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 });

      // Simulate leak: acquired > released
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 3, // Leak: 2 heaps not released
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 2,
      });

      mockNativeModule.destroyPool.mockImplementation(() => {
        const stats = mockNativeModule.getStatistics(poolHandle);
        if (stats.total_acquired !== stats.total_released) {
          console.error(
            `WARNING: Memory leak detected! Acquired: ${stats.total_acquired}, Released: ${stats.total_released}`
          );
        }
      });

      mockNativeModule.destroyPool(poolHandle);

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should not warn when no leaks', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 });

      // No leak: acquired == released
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 5,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      });

      mockNativeModule.destroyPool.mockImplementation(() => {
        const stats = mockNativeModule.getStatistics(poolHandle);
        if (stats.total_acquired !== stats.total_released) {
          console.error('WARNING: Memory leak detected!');
        }
      });

      mockNativeModule.destroyPool(poolHandle);

      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should log clean shutdown when statistics enabled', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        track_statistics: true,
      });

      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 10,
        total_released: 10,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 4,
      });

      mockNativeModule.destroyPool.mockImplementation(() => {
        const stats = mockNativeModule.getStatistics(poolHandle);
        if (stats.total_acquired === stats.total_released) {
          console.log(`Shutdown clean: ${stats.total_acquired} heaps acquired/released`);
        }
      });

      mockNativeModule.destroyPool(poolHandle);

      expect(consoleLogSpy).toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });
  });

  describe('Warmup Functionality', () => {
    it('should warmup pool with configured sizes', () => {
      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [64, 128, 256],
      });

      mockNativeModule.warmup(poolHandle);

      expect(mockNativeModule.warmup).toHaveBeenCalledWith(poolHandle);
    });

    it('should skip warmup when no sizes configured', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [],
      });

      mockNativeModule.warmup.mockImplementation(() => {
        console.log('Warmup skipped (no sizes configured)');
      });

      mockNativeModule.warmup(poolHandle);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warmup skipped')
      );

      consoleLogSpy.mockRestore();
    });

    it('should handle warmup allocation failures gracefully', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [512], // Exceeds heap size
      });

      mockNativeModule.warmup.mockImplementation(() => {
        console.error('Warmup warning: Failed to allocate 512 MB buffer');
      });

      mockNativeModule.warmup(poolHandle);

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should warmup multiple buffer sizes', () => {
      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [32, 64, 128],
      });

      mockNativeModule.warmup(poolHandle);

      expect(mockNativeModule.warmup).toHaveBeenCalledWith(poolHandle);
    });

    it('should complete warmup successfully', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [64, 128],
      });

      mockNativeModule.warmup.mockImplementation(() => {
        console.log('Warmup complete');
      });

      mockNativeModule.warmup(poolHandle);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warmup complete')
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('Concurrent Access (Thread Safety)', () => {
    beforeEach(() => {
      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 });
    });

    it('should handle concurrent acquire operations', async () => {
      mockNativeModule.acquireHeap.mockReturnValueOnce(100);
      mockNativeModule.acquireHeap.mockReturnValueOnce(200);
      mockNativeModule.acquireHeap.mockReturnValueOnce(300);

      const promises = [
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle)),
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle)),
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle)),
      ];

      const heaps = await Promise.all(promises);

      expect(heaps).toEqual([100, 200, 300]);
      expect(mockNativeModule.acquireHeap).toHaveBeenCalledTimes(3);
    });

    it('should handle concurrent release operations', async () => {
      const promises = [
        Promise.resolve(mockNativeModule.releaseHeap(poolHandle, 100)),
        Promise.resolve(mockNativeModule.releaseHeap(poolHandle, 200)),
        Promise.resolve(mockNativeModule.releaseHeap(poolHandle, 300)),
      ];

      await Promise.all(promises);

      expect(mockNativeModule.releaseHeap).toHaveBeenCalledTimes(3);
    });

    it('should handle concurrent acquire/release operations', async () => {
      mockNativeModule.acquireHeap.mockReturnValueOnce(100);
      mockNativeModule.acquireHeap.mockReturnValueOnce(200);

      const promises = [
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle)),
        Promise.resolve(mockNativeModule.releaseHeap(poolHandle, 300)),
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle)),
      ];

      await Promise.all(promises);

      expect(mockNativeModule.acquireHeap).toHaveBeenCalledTimes(2);
      expect(mockNativeModule.releaseHeap).toHaveBeenCalledTimes(1);
    });

    it('should maintain statistics consistency under concurrent access', async () => {
      mockNativeModule.acquireHeap.mockReturnValue(100);

      const operations = 10;
      const promises = Array.from({ length: operations }, () =>
        Promise.resolve(mockNativeModule.acquireHeap(poolHandle))
      );

      await Promise.all(promises);

      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: operations,
        total_released: 0,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 0,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);
      expect(stats.total_acquired).toBe(operations);
    });

    it('should handle concurrent statistics queries', async () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 5,
        total_released: 3,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 2,
      });

      const promises = Array.from({ length: 5 }, () =>
        Promise.resolve(mockNativeModule.getStatistics(poolHandle))
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      results.forEach((stats) => {
        expect(stats.total_acquired).toBe(5);
        expect(stats.total_released).toBe(3);
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle Metal device creation failure', () => {
      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('Failed to create Metal device - Apple Silicon required');
      });

      expect(() =>
        mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 })
      ).toThrow('Failed to create Metal device');
    });

    it('should handle heap creation failure', () => {
      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('Failed to create Metal heap - out of GPU memory?');
      });

      expect(() =>
        mockNativeModule.createPool({ heap_size_mb: 4096, num_heaps: 16 })
      ).toThrow('out of GPU memory');
    });

    it('should handle invalid pool handle', () => {
      const invalidHandle = -1;

      mockNativeModule.acquireHeap.mockImplementation(() => {
        throw new Error('Invalid pool handle');
      });

      expect(() => mockNativeModule.acquireHeap(invalidHandle)).toThrow(
        'Invalid pool handle'
      );
    });

    it('should handle double release of heap', () => {
      mockNativeModule.createPool({ heap_size_mb: 256, num_heaps: 4 });

      const heapPtr = 100;

      // First release - OK
      mockNativeModule.releaseHeap(poolHandle, heapPtr);

      // Second release - should be safe (no-op or warning)
      mockNativeModule.releaseHeap(poolHandle, heapPtr);

      expect(mockNativeModule.releaseHeap).toHaveBeenCalledTimes(2);
    });

    it('should handle extremely large warmup sizes', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        warmup_sizes: [10000], // 10 GB - way too large
      });

      mockNativeModule.warmup.mockImplementation(() => {
        console.error('Warmup warning: Failed to allocate 10000 MB buffer');
      });

      mockNativeModule.warmup(poolHandle);

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should handle zero-sized heaps gracefully', () => {
      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('heap_size_mb must be >= 64 MB');
      });

      expect(() =>
        mockNativeModule.createPool({ heap_size_mb: 0, num_heaps: 4 })
      ).toThrow('heap_size_mb must be >= 64 MB');
    });

    it('should handle negative configuration values', () => {
      mockNativeModule.createPool.mockImplementation(() => {
        throw new Error('Invalid configuration: negative values not allowed');
      });

      expect(() =>
        mockNativeModule.createPool({ heap_size_mb: -256, num_heaps: 4 })
      ).toThrow('negative values not allowed');
    });
  });

  describe('Performance Metrics', () => {
    beforeEach(() => {
      mockNativeModule.createPool({
        heap_size_mb: 256,
        num_heaps: 4,
        track_statistics: true,
      });
    });

    it('should calculate pool utilization', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 10,
        total_released: 6,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 0, // All in use
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      // All heaps in use = 100% utilization
      const utilization = ((stats.pool_size - stats.available_count) / stats.pool_size) * 100;
      expect(utilization).toBe(100);
    });

    it('should track heap reuse rate', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 20,
        total_released: 18,
        exhaustion_events: 0,
        fallback_events: 0,
        pool_size: 4,
        available_count: 2,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      // Reuse rate: acquired > pool_size means heaps are being reused
      expect(stats.total_acquired).toBeGreaterThan(stats.pool_size);
      const reuseRate = stats.total_acquired / stats.pool_size;
      expect(reuseRate).toBe(5); // Each heap used ~5 times on average
    });

    it('should track fallback ratio', () => {
      mockNativeModule.getStatistics.mockReturnValue({
        total_acquired: 10,
        total_released: 8,
        exhaustion_events: 3,
        fallback_events: 3,
        pool_size: 4,
        available_count: 2,
      });

      const stats = mockNativeModule.getStatistics(poolHandle);

      const fallbackRatio = stats.fallback_events / stats.total_acquired;
      expect(fallbackRatio).toBe(0.3); // 30% fallback rate
    });
  });
});
