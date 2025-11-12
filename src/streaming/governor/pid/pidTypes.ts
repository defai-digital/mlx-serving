/**
 * PID Controller Types
 *
 * Type definitions for the PID controller used in adaptive stream admission control.
 * Pure functional implementation for deterministic behavior and testability.
 */

/**
 * PID controller configuration
 */
export interface PidConfig {
  /** Proportional gain */
  kp: number;
  /** Integral gain */
  ki: number;
  /** Derivative gain */
  kd: number;
  /** Maximum integral accumulation (anti-windup) */
  integralSaturation: number;
  /** Sample interval in milliseconds */
  sampleIntervalMs: number;
}

/**
 * PID controller internal state
 */
export interface PidState {
  /** Previous error value for derivative calculation */
  prevError: number;
  /** Accumulated integral error */
  integral: number;
  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * PID controller output
 */
export interface PidOutput {
  /** Control output value */
  output: number;
  /** Updated PID state */
  state: PidState;
  /** Debug information */
  debug?: {
    proportional: number;
    integral: number;
    derivative: number;
    error: number;
    dt: number;
  };
}

/**
 * Create initial PID state
 */
export function createPidState(): PidState {
  return {
    prevError: 0,
    integral: 0,
    lastUpdate: Date.now(),
  };
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
