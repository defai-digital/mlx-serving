/**
 * WebSocketGateway Timer Leak Prevention Tests
 *
 * Validates BUG-017 fix: Heartbeat timer leak prevention
 * Tests defensive timer cleanup patterns in WebSocketGateway
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketGateway } from '../../src/transport/ws/WebSocketGateway.js';
import type { WebSocketGatewayConfig } from '../../src/transport/ws/WebSocketGateway.js';
import pino from 'pino';

describe('WebSocketGateway Timer Leak Prevention (BUG-017)', () => {
  let gateway: WebSocketGateway;
  let logger: pino.Logger;
  const config: WebSocketGatewayConfig = {
    maxConnections: 100,
    maxFrameSizeBytes: 1048576, // 1MB
    idleTimeoutMs: 60000, // 1 minute
    heartbeatIntervalMs: 100, // 100ms for faster testing
  };

  beforeEach(() => {
    logger = pino({ level: 'silent' }); // Silent for tests
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.shutdown();
    }
  });

  /**
   * Test 1: Verify no timer leaks on rapid initialize/shutdown cycles
   *
   * This tests the defensive cleanup pattern in startHeartbeat():
   * - Lines 323-327: Clears existing timer before setting new one
   */
  it('should not leak timers on rapid initialize/shutdown cycles', async () => {
    gateway = new WebSocketGateway(config, logger);

    // Measure initial timer handles
    const getActiveTimers = (): NodeJS.Timeout[] => {
      return (process as any)._getActiveHandles().filter(
        (handle: any) => handle.constructor.name === 'Timeout'
      );
    };

    const initialTimerCount = getActiveTimers().length;

    // 100 rapid initialization cycles
    // Each cycle creates heartbeat and cleanup timers, then shuts down
    for (let i = 0; i < 100; i++) {
      gateway.initialize();
      await gateway.shutdown();
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Wait for any pending timers to clear
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalTimerCount = getActiveTimers().length;

    // Final timer count should be same or less than initial
    // (allowing +1 for the setTimeout above)
    expect(finalTimerCount).toBeLessThanOrEqual(initialTimerCount + 1);
  });

  /**
   * Test 2: Verify heartbeat timer is cleared on shutdown
   *
   * This tests the cleanup in shutdown() method:
   * - Lines 419-423: Clears heartbeatTimer
   * - Lines 425-428: Clears cleanupTimer
   */
  it('should clear heartbeat timer on shutdown', async () => {
    gateway = new WebSocketGateway(config, logger);
    gateway.initialize();

    // Wait for heartbeat timer to be created
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify timer is active (private field access for testing)
    const heartbeatTimer = (gateway as any).heartbeatTimer;
    expect(heartbeatTimer).toBeDefined();

    // Shutdown should clear the timer
    await gateway.shutdown();

    // Verify timer is cleared
    const heartbeatTimerAfter = (gateway as any).heartbeatTimer;
    expect(heartbeatTimerAfter).toBeUndefined();
  });

  /**
   * Test 3: Verify cleanup timer is cleared on shutdown
   */
  it('should clear cleanup timer on shutdown', async () => {
    gateway = new WebSocketGateway(config, logger);
    gateway.initialize();

    // Wait for cleanup timer to be created
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify timer is active
    const cleanupTimer = (gateway as any).cleanupTimer;
    expect(cleanupTimer).toBeDefined();

    // Shutdown should clear the timer
    await gateway.shutdown();

    // Verify timer is cleared
    const cleanupTimerAfter = (gateway as any).cleanupTimer;
    expect(cleanupTimerAfter).toBeUndefined();
  });

  /**
   * Test 4: Verify defensive cleanup on multiple initialize calls
   *
   * This tests the defensive pattern in startHeartbeat():
   * - Lines 323-327: "Clear any existing timer (defensive cleanup)"
   */
  it('should not accumulate timers on multiple initialize calls without shutdown', async () => {
    gateway = new WebSocketGateway(config, logger);

    // Initialize multiple times without shutdown
    // Each initialize should clear the previous timer
    for (let i = 0; i < 10; i++) {
      gateway.initialize();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Count active timers
    const activeTimers = (process as any)
      ._getActiveHandles()
      .filter((handle: any) => handle.constructor.name === 'Timeout');

    // Should have at most 2 timers: heartbeat + cleanup
    // (plus 1 for the setTimeout above)
    expect(activeTimers.length).toBeLessThanOrEqual(3);
  });

  /**
   * Test 5: Stress test - 1000 rapid cycles
   *
   * This is an extreme stress test to verify no leaks under heavy churn
   */
  it('should handle 1000 rapid initialize/shutdown cycles without leaking', async () => {
    gateway = new WebSocketGateway(config, logger);

    const getActiveTimers = (): number => {
      return (process as any)._getActiveHandles().filter(
        (handle: any) => handle.constructor.name === 'Timeout'
      ).length;
    };

    const initialCount = getActiveTimers();

    // 1000 cycles - this should complete in ~5 seconds
    for (let i = 0; i < 1000; i++) {
      gateway.initialize();
      await gateway.shutdown();
    }

    // Force GC
    if (global.gc) {
      global.gc();
    }

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 300));

    const finalCount = getActiveTimers();

    // No leaks: final count should be within 2 of initial
    expect(finalCount).toBeLessThanOrEqual(initialCount + 2);
  });

  /**
   * Test 6: Verify timers are actually running (not just created)
   *
   * This verifies the timers are functional, not just stored
   */
  it('should execute heartbeat callback periodically', async () => {
    let heartbeatCount = 0;

    // Spy on sendHeartbeats method
    const originalSendHeartbeats = (WebSocketGateway.prototype as any).sendHeartbeats;
    (WebSocketGateway.prototype as any).sendHeartbeats = function () {
      heartbeatCount++;
      return originalSendHeartbeats.call(this);
    };

    gateway = new WebSocketGateway(
      { ...config, heartbeatIntervalMs: 50 }, // Fast heartbeat for testing
      logger
    );
    gateway.initialize();

    // Wait for multiple heartbeats (50ms interval × 5 = 250ms)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Should have executed multiple times
    expect(heartbeatCount).toBeGreaterThanOrEqual(3);

    // Restore original method
    (WebSocketGateway.prototype as any).sendHeartbeats = originalSendHeartbeats;
  });

  /**
   * Test 7: Verify shutdown is idempotent
   *
   * Multiple shutdown calls should not cause errors
   */
  it('should handle multiple shutdown calls gracefully', async () => {
    gateway = new WebSocketGateway(config, logger);
    gateway.initialize();

    // Multiple shutdowns should not throw
    await gateway.shutdown();
    await gateway.shutdown();
    await gateway.shutdown();

    // No errors should be thrown
    expect(true).toBe(true);
  });

  /**
   * Test 8: Memory leak test with long-running gateway
   *
   * This tests for leaks during normal operation (no churn)
   */
  it('should not leak memory during long-running operation', async () => {
    gateway = new WebSocketGateway(
      { ...config, heartbeatIntervalMs: 10 }, // Very fast heartbeat
      logger
    );
    gateway.initialize();

    const getMemoryUsage = () => {
      if (global.gc) global.gc();
      return process.memoryUsage().heapUsed;
    };

    // Baseline memory
    const initialMemory = getMemoryUsage();

    // Run for 1 second with rapid heartbeats (10ms interval = 100 heartbeats)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Final memory
    const finalMemory = getMemoryUsage();

    // Memory growth should be minimal (< 1MB)
    const memoryGrowth = finalMemory - initialMemory;
    expect(memoryGrowth).toBeLessThan(1024 * 1024); // < 1MB growth
  });
});
