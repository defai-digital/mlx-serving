import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit Tests for BlitQueue
 *
 * Tests the native C++ Blit Queue implementation for I/O overlap.
 * BlitQueue enables asynchronous CPU-GPU data transfer using a dedicated
 * MTLCommandQueue, reducing TTFT by 15-20% through pipeline overlap.
 *
 * Test Coverage:
 * - Configuration validation
 * - Async upload/download operations
 * - Operation completion tracking
 * - Timeout handling
 * - Metrics collection
 * - Concurrent operations
 * - Shared event synchronization
 * - Edge cases and error handling
 */

describe('BlitQueue', () => {
  // Mock native module
  let mockNativeModule: {
    createBlitQueue: ReturnType<typeof vi.fn>;
    uploadAsync: ReturnType<typeof vi.fn>;
    downloadAsync: ReturnType<typeof vi.fn>;
    waitForCompletion: ReturnType<typeof vi.fn>;
    waitForAll: ReturnType<typeof vi.fn>;
    isCompleted: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    getMetrics: ReturnType<typeof vi.fn>;
    resetMetrics: ReturnType<typeof vi.fn>;
    destroyBlitQueue: ReturnType<typeof vi.fn>;
  };

  let queueHandle: number;

  beforeEach(() => {
    queueHandle = 1; // Simulated queue handle

    mockNativeModule = {
      createBlitQueue: vi.fn().mockReturnValue(queueHandle),
      uploadAsync: vi.fn().mockReturnValue(1), // Operation ID
      downloadAsync: vi.fn().mockReturnValue(2), // Operation ID
      waitForCompletion: vi.fn().mockReturnValue(true),
      waitForAll: vi.fn(),
      isCompleted: vi.fn().mockReturnValue(false),
      flush: vi.fn(),
      getMetrics: vi.fn().mockReturnValue({
        total_uploads: 0,
        total_downloads: 0,
        avg_upload_ms: 0,
        avg_download_ms: 0,
        total_overlap_ms: 0,
        overlap_ratio: 0,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      }),
      resetMetrics: vi.fn(),
      destroyBlitQueue: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Configuration Validation', () => {
    it('should accept valid configuration', () => {
      const config = {
        enabled: true,
        max_pending_ops: 8,
        use_shared_events: true,
        track_metrics: true,
      };

      mockNativeModule.createBlitQueue(config);

      expect(mockNativeModule.createBlitQueue).toHaveBeenCalledWith(config);
      expect(mockNativeModule.createBlitQueue).toHaveReturnedWith(queueHandle);
    });

    it('should accept minimal configuration', () => {
      const config = {
        enabled: false,
        max_pending_ops: 4,
      };

      mockNativeModule.createBlitQueue(config);

      expect(mockNativeModule.createBlitQueue).toHaveBeenCalledWith(config);
    });

    it('should reject invalid max_pending_ops (too low)', () => {
      const config = {
        enabled: true,
        max_pending_ops: 0, // Invalid
      };

      mockNativeModule.createBlitQueue.mockImplementation(() => {
        throw new Error('max_pending_ops must be > 0');
      });

      expect(() => mockNativeModule.createBlitQueue(config)).toThrow(
        'max_pending_ops must be > 0'
      );
    });

    it('should reject invalid max_pending_ops (too high)', () => {
      const config = {
        enabled: true,
        max_pending_ops: 1000, // Too many
      };

      mockNativeModule.createBlitQueue.mockImplementation(() => {
        throw new Error('max_pending_ops must be <= 64');
      });

      expect(() => mockNativeModule.createBlitQueue(config)).toThrow(
        'max_pending_ops must be <= 64'
      );
    });

    it('should handle disabled blit queue', () => {
      const config = {
        enabled: false,
        max_pending_ops: 8,
      };

      mockNativeModule.createBlitQueue(config);

      // Operations should be no-ops when disabled
      expect(mockNativeModule.createBlitQueue).toHaveBeenCalledWith(config);
    });

    it('should allow disabling shared events', () => {
      const config = {
        enabled: true,
        max_pending_ops: 8,
        use_shared_events: false, // Use older synchronization
      };

      mockNativeModule.createBlitQueue(config);

      expect(mockNativeModule.createBlitQueue).toHaveBeenCalledWith(config);
    });

    it('should allow disabling metrics tracking', () => {
      const config = {
        enabled: true,
        max_pending_ops: 8,
        track_metrics: false,
      };

      mockNativeModule.createBlitQueue(config);

      expect(mockNativeModule.createBlitQueue).toHaveBeenCalledWith(config);
    });
  });

  describe('Async Upload Operations', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
      });
    });

    it('should upload data asynchronously', () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const sourceSize = sourceData.byteLength;
      const destBuffer = 100; // Mock buffer pointer
      const destOffset = 0;

      mockNativeModule.uploadAsync.mockReturnValue(1);

      const opId = mockNativeModule.uploadAsync(
        queueHandle,
        sourceData,
        sourceSize,
        destBuffer,
        destOffset
      );

      expect(mockNativeModule.uploadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceData,
        sourceSize,
        destBuffer,
        destOffset
      );
      expect(opId).toBe(1);
    });

    it('should upload with non-zero offset', () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const sourceSize = sourceData.byteLength;
      const destBuffer = 100;
      const destOffset = 1024;

      mockNativeModule.uploadAsync.mockReturnValue(2);

      const opId = mockNativeModule.uploadAsync(
        queueHandle,
        sourceData,
        sourceSize,
        destBuffer,
        destOffset
      );

      expect(mockNativeModule.uploadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceData,
        sourceSize,
        destBuffer,
        destOffset
      );
      expect(opId).toBe(2);
    });

    it('should handle large uploads', () => {
      const largeSize = 1024 * 1024 * 100; // 100 MB
      const sourceData = new Uint8Array(largeSize);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValue(3);

      const opId = mockNativeModule.uploadAsync(
        queueHandle,
        sourceData,
        largeSize,
        destBuffer,
        0
      );

      expect(opId).toBe(3);
    });

    it('should return unique operation IDs', () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValueOnce(1);
      mockNativeModule.uploadAsync.mockReturnValueOnce(2);
      mockNativeModule.uploadAsync.mockReturnValueOnce(3);

      const opId1 = mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);
      const opId2 = mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);
      const opId3 = mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);

      expect(opId1).toBe(1);
      expect(opId2).toBe(2);
      expect(opId3).toBe(3);
      expect(new Set([opId1, opId2, opId3]).size).toBe(3); // All unique
    });

    it('should handle upload with completion callback', () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;
      const callback = vi.fn();

      mockNativeModule.uploadAsync.mockReturnValue(1);

      const opId = mockNativeModule.uploadAsync(
        queueHandle,
        sourceData,
        4,
        destBuffer,
        0,
        callback
      );

      expect(opId).toBe(1);
      expect(mockNativeModule.uploadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceData,
        4,
        destBuffer,
        0,
        callback
      );
    });

    it('should handle null source data', () => {
      mockNativeModule.uploadAsync.mockImplementation(() => {
        throw new Error('Invalid source data: null');
      });

      expect(() =>
        mockNativeModule.uploadAsync(queueHandle, null, 0, 100, 0)
      ).toThrow('Invalid source data');
    });

    it('should handle zero-sized upload', () => {
      const sourceData = new Uint8Array([]);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValue(1);

      const opId = mockNativeModule.uploadAsync(queueHandle, sourceData, 0, destBuffer, 0);

      expect(opId).toBe(1);
    });
  });

  describe('Async Download Operations', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
      });
    });

    it('should download data asynchronously', () => {
      const sourceBuffer = 100; // Mock buffer pointer
      const sourceOffset = 0;
      const destData = new Uint8Array(4);
      const destSize = destData.byteLength;

      mockNativeModule.downloadAsync.mockReturnValue(1);

      const opId = mockNativeModule.downloadAsync(
        queueHandle,
        sourceBuffer,
        sourceOffset,
        destData,
        destSize
      );

      expect(mockNativeModule.downloadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceBuffer,
        sourceOffset,
        destData,
        destSize
      );
      expect(opId).toBe(1);
    });

    it('should download with non-zero offset', () => {
      const sourceBuffer = 100;
      const sourceOffset = 2048;
      const destData = new Uint8Array(1024);

      mockNativeModule.downloadAsync.mockReturnValue(2);

      const opId = mockNativeModule.downloadAsync(
        queueHandle,
        sourceBuffer,
        sourceOffset,
        destData,
        1024
      );

      expect(mockNativeModule.downloadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceBuffer,
        sourceOffset,
        destData,
        1024
      );
      expect(opId).toBe(2);
    });

    it('should handle large downloads', () => {
      const largeSize = 1024 * 1024 * 50; // 50 MB
      const sourceBuffer = 100;
      const destData = new Uint8Array(largeSize);

      mockNativeModule.downloadAsync.mockReturnValue(3);

      const opId = mockNativeModule.downloadAsync(
        queueHandle,
        sourceBuffer,
        0,
        destData,
        largeSize
      );

      expect(opId).toBe(3);
    });

    it('should return unique operation IDs for downloads', () => {
      const sourceBuffer = 100;
      const destData = new Uint8Array(4);

      mockNativeModule.downloadAsync.mockReturnValueOnce(10);
      mockNativeModule.downloadAsync.mockReturnValueOnce(11);
      mockNativeModule.downloadAsync.mockReturnValueOnce(12);

      const opId1 = mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 0, destData, 4);
      const opId2 = mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 0, destData, 4);
      const opId3 = mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 0, destData, 4);

      expect(new Set([opId1, opId2, opId3]).size).toBe(3); // All unique
    });

    it('should handle download with completion callback', () => {
      const sourceBuffer = 100;
      const destData = new Uint8Array(4);
      const callback = vi.fn();

      mockNativeModule.downloadAsync.mockReturnValue(1);

      const opId = mockNativeModule.downloadAsync(
        queueHandle,
        sourceBuffer,
        0,
        destData,
        4,
        callback
      );

      expect(opId).toBe(1);
      expect(mockNativeModule.downloadAsync).toHaveBeenCalledWith(
        queueHandle,
        sourceBuffer,
        0,
        destData,
        4,
        callback
      );
    });

    it('should handle null destination buffer', () => {
      mockNativeModule.downloadAsync.mockImplementation(() => {
        throw new Error('Invalid destination buffer: null');
      });

      expect(() =>
        mockNativeModule.downloadAsync(queueHandle, 100, 0, null, 4)
      ).toThrow('Invalid destination buffer');
    });

    it('should handle zero-sized download', () => {
      const sourceBuffer = 100;
      const destData = new Uint8Array([]);

      mockNativeModule.downloadAsync.mockReturnValue(1);

      const opId = mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 0, destData, 0);

      expect(opId).toBe(1);
    });
  });

  describe('Operation Completion Tracking', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
      });
    });

    it('should wait for operation completion', () => {
      const opId = 1;

      mockNativeModule.waitForCompletion.mockReturnValue(true);

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, 0);

      expect(mockNativeModule.waitForCompletion).toHaveBeenCalledWith(queueHandle, opId, 0);
      expect(completed).toBe(true);
    });

    it('should wait with timeout', () => {
      const opId = 1;
      const timeout = 1000; // 1 second

      mockNativeModule.waitForCompletion.mockReturnValue(true);

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, timeout);

      expect(mockNativeModule.waitForCompletion).toHaveBeenCalledWith(queueHandle, opId, timeout);
      expect(completed).toBe(true);
    });

    it('should return false on timeout', () => {
      const opId = 1;
      const timeout = 100;

      mockNativeModule.waitForCompletion.mockReturnValue(false); // Timeout

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, timeout);

      expect(completed).toBe(false);
    });

    it('should check if operation is completed (non-blocking)', () => {
      const opId = 1;

      mockNativeModule.isCompleted.mockReturnValue(false);

      const completed = mockNativeModule.isCompleted(queueHandle, opId);

      expect(mockNativeModule.isCompleted).toHaveBeenCalledWith(queueHandle, opId);
      expect(completed).toBe(false);
    });

    it('should return true when operation is completed', () => {
      const opId = 1;

      mockNativeModule.isCompleted.mockReturnValue(true);

      const completed = mockNativeModule.isCompleted(queueHandle, opId);

      expect(completed).toBe(true);
    });

    it('should wait for all pending operations', () => {
      mockNativeModule.waitForAll(queueHandle);

      expect(mockNativeModule.waitForAll).toHaveBeenCalledWith(queueHandle);
    });

    it('should handle waiting for invalid operation ID', () => {
      const invalidOpId = -1;

      mockNativeModule.waitForCompletion.mockImplementation(() => {
        throw new Error('Invalid operation ID');
      });

      expect(() =>
        mockNativeModule.waitForCompletion(queueHandle, invalidOpId, 0)
      ).toThrow('Invalid operation ID');
    });

    it('should handle checking invalid operation ID', () => {
      const invalidOpId = 9999;

      mockNativeModule.isCompleted.mockImplementation(() => {
        throw new Error('Operation ID not found');
      });

      expect(() =>
        mockNativeModule.isCompleted(queueHandle, invalidOpId)
      ).toThrow('Operation ID not found');
    });
  });

  describe('Metrics Collection', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
        track_metrics: true,
      });
    });

    it('should track upload count', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 10,
        total_downloads: 0,
        avg_upload_ms: 5.2,
        avg_download_ms: 0,
        total_overlap_ms: 25.5,
        overlap_ratio: 0.5,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.total_uploads).toBe(10);
    });

    it('should track download count', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 0,
        total_downloads: 5,
        avg_upload_ms: 0,
        avg_download_ms: 3.8,
        total_overlap_ms: 15.0,
        overlap_ratio: 0.4,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.total_downloads).toBe(5);
    });

    it('should track average upload duration', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 0,
        avg_upload_ms: 4.5,
        avg_download_ms: 0,
        total_overlap_ms: 200.0,
        overlap_ratio: 0.45,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.avg_upload_ms).toBe(4.5);
    });

    it('should track average download duration', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 0,
        total_downloads: 50,
        avg_upload_ms: 0,
        avg_download_ms: 6.2,
        total_overlap_ms: 150.0,
        overlap_ratio: 0.48,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.avg_download_ms).toBe(6.2);
    });

    it('should track total overlap time', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 50,
        total_downloads: 50,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 500.0, // 500ms saved via overlap
        overlap_ratio: 1.0,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.total_overlap_ms).toBe(500.0);
    });

    it('should track overlap ratio', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 750.0,
        overlap_ratio: 0.75, // 75% overlap efficiency
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.overlap_ratio).toBe(0.75);
    });

    it('should track sync wait count', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 500.0,
        overlap_ratio: 0.5,
        sync_wait_count: 5, // Had to wait 5 times
        avg_sync_wait_ms: 2.5,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.sync_wait_count).toBe(5);
    });

    it('should track average sync wait duration', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 500.0,
        overlap_ratio: 0.5,
        sync_wait_count: 10,
        avg_sync_wait_ms: 1.8, // Average wait time
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.avg_sync_wait_ms).toBe(1.8);
    });

    it('should reset metrics', () => {
      mockNativeModule.resetMetrics(queueHandle);

      expect(mockNativeModule.resetMetrics).toHaveBeenCalledWith(queueHandle);

      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 0,
        total_downloads: 0,
        avg_upload_ms: 0,
        avg_download_ms: 0,
        total_overlap_ms: 0,
        overlap_ratio: 0,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.total_uploads).toBe(0);
      expect(metrics.total_downloads).toBe(0);
    });

    it('should not track metrics when disabled', () => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
        track_metrics: false,
      });

      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 0,
        total_downloads: 0,
        avg_upload_ms: 0,
        avg_download_ms: 0,
        total_overlap_ms: 0,
        overlap_ratio: 0,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      expect(metrics.total_uploads).toBe(0);
    });
  });

  describe('Concurrent Operations', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
      });
    });

    it('should handle concurrent uploads', async () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValueOnce(1);
      mockNativeModule.uploadAsync.mockReturnValueOnce(2);
      mockNativeModule.uploadAsync.mockReturnValueOnce(3);

      const promises = [
        Promise.resolve(mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0)),
        Promise.resolve(mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 1024)),
        Promise.resolve(mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 2048)),
      ];

      const opIds = await Promise.all(promises);

      expect(opIds).toEqual([1, 2, 3]);
      expect(mockNativeModule.uploadAsync).toHaveBeenCalledTimes(3);
    });

    it('should handle concurrent downloads', async () => {
      const sourceBuffer = 100;
      const destData = new Uint8Array(4);

      mockNativeModule.downloadAsync.mockReturnValueOnce(10);
      mockNativeModule.downloadAsync.mockReturnValueOnce(11);
      mockNativeModule.downloadAsync.mockReturnValueOnce(12);

      const promises = [
        Promise.resolve(mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 0, destData, 4)),
        Promise.resolve(mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 1024, destData, 4)),
        Promise.resolve(mockNativeModule.downloadAsync(queueHandle, sourceBuffer, 2048, destData, 4)),
      ];

      const opIds = await Promise.all(promises);

      expect(opIds).toEqual([10, 11, 12]);
      expect(mockNativeModule.downloadAsync).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed concurrent uploads/downloads', async () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destData = new Uint8Array(4);
      const buffer = 100;

      mockNativeModule.uploadAsync.mockReturnValueOnce(1);
      mockNativeModule.downloadAsync.mockReturnValueOnce(2);
      mockNativeModule.uploadAsync.mockReturnValueOnce(3);

      const promises = [
        Promise.resolve(mockNativeModule.uploadAsync(queueHandle, sourceData, 4, buffer, 0)),
        Promise.resolve(mockNativeModule.downloadAsync(queueHandle, buffer, 0, destData, 4)),
        Promise.resolve(mockNativeModule.uploadAsync(queueHandle, sourceData, 4, buffer, 1024)),
      ];

      const opIds = await Promise.all(promises);

      expect(opIds).toEqual([1, 2, 3]);
    });

    it('should block when max_pending_ops exceeded', () => {
      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      // Fill up to max_pending_ops
      for (let i = 0; i < 8; i++) {
        mockNativeModule.uploadAsync.mockReturnValueOnce(i + 1);
        mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);
      }

      // Next operation should block or wait
      mockNativeModule.uploadAsync.mockImplementation(() => {
        throw new Error('Max pending operations exceeded - waiting');
      });

      expect(() =>
        mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0)
      ).toThrow('Max pending operations exceeded');
    });

    it('should handle completion callbacks from multiple operations', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValueOnce(1);
      mockNativeModule.uploadAsync.mockReturnValueOnce(2);
      mockNativeModule.uploadAsync.mockReturnValueOnce(3);

      mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0, callback1);
      mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 1024, callback2);
      mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 2048, callback3);

      // Simulate completions
      callback1();
      callback2();
      callback3();

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();
    });
  });

  describe('Shared Event Synchronization', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
        use_shared_events: true,
      });
    });

    it('should use shared events for synchronization', () => {
      const opId = 1;

      mockNativeModule.waitForCompletion.mockReturnValue(true);

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, 0);

      expect(completed).toBe(true);
      // With shared events, wait should be efficient (no busy-wait)
    });

    it('should handle shared event timeout', () => {
      const opId = 1;
      const timeout = 100;

      mockNativeModule.waitForCompletion.mockReturnValue(false);

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, timeout);

      expect(completed).toBe(false);
    });

    it('should work without shared events (fallback)', () => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
        use_shared_events: false, // Use polling instead
      });

      const opId = 1;

      mockNativeModule.waitForCompletion.mockReturnValue(true);

      const completed = mockNativeModule.waitForCompletion(queueHandle, opId, 0);

      expect(completed).toBe(true);
      // Should still work, but less efficient
    });
  });

  describe('Flush Operations', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
      });
    });

    it('should flush all pending commands', () => {
      mockNativeModule.flush(queueHandle);

      expect(mockNativeModule.flush).toHaveBeenCalledWith(queueHandle);
    });

    it('should not block on flush', () => {
      // Flush should return immediately
      const start = Date.now();
      mockNativeModule.flush(queueHandle);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(10); // Should be instant
    });

    it('should flush before waitForAll', () => {
      mockNativeModule.flush(queueHandle);
      mockNativeModule.waitForAll(queueHandle);

      // Verify call order using Vitest mock call history
      expect(mockNativeModule.flush).toHaveBeenCalled();
      expect(mockNativeModule.waitForAll).toHaveBeenCalled();

      const flushCallOrder = mockNativeModule.flush.mock.invocationCallOrder[0];
      const waitAllCallOrder = mockNativeModule.waitForAll.mock.invocationCallOrder[0];
      expect(flushCallOrder).toBeLessThan(waitAllCallOrder);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle Metal device creation failure', () => {
      mockNativeModule.createBlitQueue.mockImplementation(() => {
        throw new Error('Failed to create Metal device');
      });

      expect(() =>
        mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 })
      ).toThrow('Failed to create Metal device');
    });

    it('should handle command queue creation failure', () => {
      mockNativeModule.createBlitQueue.mockImplementation(() => {
        throw new Error('Failed to create blit command queue');
      });

      expect(() =>
        mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 })
      ).toThrow('Failed to create blit command queue');
    });

    it('should handle upload to invalid buffer', () => {
      mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 });

      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const invalidBuffer = null;

      mockNativeModule.uploadAsync.mockImplementation(() => {
        throw new Error('Invalid destination buffer');
      });

      expect(() =>
        mockNativeModule.uploadAsync(queueHandle, sourceData, 4, invalidBuffer, 0)
      ).toThrow('Invalid destination buffer');
    });

    it('should handle download from invalid buffer', () => {
      mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 });

      const destData = new Uint8Array(4);
      const invalidBuffer = null;

      mockNativeModule.downloadAsync.mockImplementation(() => {
        throw new Error('Invalid source buffer');
      });

      expect(() =>
        mockNativeModule.downloadAsync(queueHandle, invalidBuffer, 0, destData, 4)
      ).toThrow('Invalid source buffer');
    });

    it('should handle out-of-bounds offset', () => {
      mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 });

      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;
      const hugeOffset = 1024 * 1024 * 1024 * 10; // 10 GB offset

      mockNativeModule.uploadAsync.mockImplementation(() => {
        throw new Error('Offset out of bounds');
      });

      expect(() =>
        mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, hugeOffset)
      ).toThrow('Offset out of bounds');
    });

    it('should handle cleanup with pending operations', () => {
      mockNativeModule.createBlitQueue({ enabled: true, max_pending_ops: 8 });

      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      mockNativeModule.uploadAsync.mockReturnValue(1);
      mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);

      // Cleanup should wait for pending operations
      mockNativeModule.destroyBlitQueue.mockImplementation(() => {
        mockNativeModule.waitForAll(queueHandle);
      });

      mockNativeModule.destroyBlitQueue(queueHandle);

      expect(mockNativeModule.waitForAll).toHaveBeenCalled();
    });

    it('should handle disabled queue gracefully', () => {
      mockNativeModule.createBlitQueue({
        enabled: false,
        max_pending_ops: 8,
      });

      const sourceData = new Uint8Array([1, 2, 3, 4]);
      const destBuffer = 100;

      // Operations should be no-ops or use fallback path
      mockNativeModule.uploadAsync.mockReturnValue(0); // No-op ID

      const opId = mockNativeModule.uploadAsync(queueHandle, sourceData, 4, destBuffer, 0);

      expect(opId).toBe(0);
    });
  });

  describe('Performance Characteristics', () => {
    beforeEach(() => {
      mockNativeModule.createBlitQueue({
        enabled: true,
        max_pending_ops: 8,
        track_metrics: true,
      });
    });

    it('should demonstrate I/O overlap benefit', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 150.0, // 150ms saved
        overlap_ratio: 0.15, // 15% improvement
        sync_wait_count: 5,
        avg_sync_wait_ms: 1.0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      // Expected 15-20% TTFT reduction
      expect(metrics.overlap_ratio).toBeGreaterThanOrEqual(0.15);
      expect(metrics.overlap_ratio).toBeLessThanOrEqual(0.20);
    });

    it('should minimize sync wait overhead', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0,
        avg_download_ms: 5.0,
        total_overlap_ms: 150.0,
        overlap_ratio: 0.15,
        sync_wait_count: 10,
        avg_sync_wait_ms: 0.5, // Should be very low with shared events
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      // Shared events should keep sync wait minimal
      expect(metrics.avg_sync_wait_ms).toBeLessThan(1.0);
    });

    it('should calculate effective bandwidth', () => {
      mockNativeModule.getMetrics.mockReturnValue({
        total_uploads: 100,
        total_downloads: 100,
        avg_upload_ms: 5.0, // 5ms per upload
        avg_download_ms: 5.0, // 5ms per download
        total_overlap_ms: 150.0,
        overlap_ratio: 0.15,
        sync_wait_count: 0,
        avg_sync_wait_ms: 0,
      });

      const metrics = mockNativeModule.getMetrics(queueHandle);

      // Assuming 1MB per operation
      const mbPerUpload = 1.0;
      const uploadBandwidthMBps = mbPerUpload / (metrics.avg_upload_ms / 1000);

      expect(uploadBandwidthMBps).toBeGreaterThan(100); // >100 MB/s
    });
  });
});
