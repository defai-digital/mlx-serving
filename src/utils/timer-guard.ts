/**
 * Timer Lifecycle Management Guards
 *
 * Defensive patterns to prevent timer leaks by ensuring cleanup
 * on every set() call and providing explicit lifecycle management.
 *
 * Prevents bugs: BUG-015, BUG-017, BUG-019
 *
 * Usage:
 * ```typescript
 * const guard = new TimerGuard('heartbeat');
 * guard.set(() => sendHeartbeat(), 1000);
 * // Later...
 * guard.clear(); // Explicit cleanup
 * ```
 */

/**
 * Timer lifecycle management guard
 *
 * Prevents timer leaks by ensuring cleanup on every set() call.
 */
export class TimerGuard {
  private timer?: NodeJS.Timeout;
  private readonly name: string;

  constructor(name = 'anonymous') {
    this.name = name;
  }

  /**
   * Set a new timer (clears existing timer first)
   *
   * DEFENSIVE: Always clears existing timer before setting new one
   * to prevent accumulation of orphaned timers.
   */
  set(callback: () => void, delayMs: number): void {
    // CRITICAL: Always clear before setting to prevent leaks
    this.clear();
    this.timer = setTimeout(callback, delayMs);
  }

  /**
   * Set an interval (clears existing timer first)
   *
   * DEFENSIVE: Always clears existing timer before setting new one
   * to prevent accumulation of orphaned intervals.
   */
  setInterval(callback: () => void, intervalMs: number): void {
    // CRITICAL: Always clear before setting to prevent leaks
    this.clear();
    this.timer = setInterval(callback, intervalMs);
  }

  /**
   * Clear the timer if set
   *
   * Safe to call multiple times - idempotent.
   */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer); // Works for both setTimeout and setInterval
      this.timer = undefined;
    }
  }

  /**
   * Check if timer is active
   */
  isActive(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Get timer name (for debugging)
   */
  getName(): string {
    return this.name;
  }
}

/**
 * Multiple timer guard for managing several timers
 *
 * Useful for classes that need to manage multiple timers
 * (e.g., heartbeat, cleanup, metrics export).
 */
export class MultiTimerGuard {
  private timers = new Map<string, TimerGuard>();

  /**
   * Set a named timer
   */
  set(name: string, callback: () => void, delayMs: number): void {
    const guard = this.timers.get(name) ?? new TimerGuard(name);
    guard.set(callback, delayMs);
    this.timers.set(name, guard);
  }

  /**
   * Set a named interval
   */
  setInterval(name: string, callback: () => void, intervalMs: number): void {
    const guard = this.timers.get(name) ?? new TimerGuard(name);
    guard.setInterval(callback, intervalMs);
    this.timers.set(name, guard);
  }

  /**
   * Clear a specific timer
   */
  clear(name: string): void {
    this.timers.get(name)?.clear();
    this.timers.delete(name);
  }

  /**
   * Clear all timers
   */
  clearAll(): void {
    for (const [name] of this.timers) {
      this.clear(name);
    }
  }

  /**
   * Get active timer count
   */
  getActiveCount(): number {
    let count = 0;
    for (const guard of this.timers.values()) {
      if (guard.isActive()) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all timer names
   */
  getTimerNames(): string[] {
    return Array.from(this.timers.keys());
  }
}
