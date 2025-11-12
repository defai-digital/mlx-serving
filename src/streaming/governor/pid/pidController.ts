/**
 * PID Controller Implementation
 *
 * Pure-function PID (Proportional-Integral-Derivative) controller
 * for adaptive stream concurrency limits.
 *
 * Features:
 * - Anti-windup protection via integral saturation
 * - Derivative kick prevention
 * - Guard against NaN/Inf outputs
 * - Deterministic for unit testing
 */

import { type PidConfig, type PidState, type PidOutput, clamp } from './pidTypes.js';

/**
 * Update PID controller with new error measurement
 *
 * Algorithm based on Phase 4 Implementation Guide (lines 492-514):
 * 1. Calculate time delta (dt) since last update
 * 2. Compute proportional term: kp * error
 * 3. Update integral with saturation: clamp(integral + error * dt)
 * 4. Compute derivative: kd * (error - prevError) / dt
 * 5. Combine terms and guard against instability
 *
 * @param state - Current PID state
 * @param config - PID configuration
 * @param error - Current error (measured - target)
 * @param currentTime - Current timestamp in milliseconds
 * @returns PID output and updated state
 */
export function updatePid(
  state: PidState,
  config: PidConfig,
  error: number,
  currentTime: number = Date.now()
): PidOutput {
  // Calculate time delta in seconds
  const dt = (currentTime - state.lastUpdate) / 1000;

  // Guard against invalid dt
  if (dt <= 0 || !Number.isFinite(dt)) {
    return {
      output: 0,
      state,
      debug: {
        proportional: 0,
        integral: state.integral,
        derivative: 0,
        error,
        dt,
      },
    };
  }

  // Proportional term
  const proportional = config.kp * error;

  // Integral term with anti-windup
  const newIntegral = clamp(
    state.integral + error * dt,
    -config.integralSaturation,
    config.integralSaturation
  );
  const integral = config.ki * newIntegral;

  // Derivative term (derivative kick prevention via error derivative)
  const derivative = config.kd * ((error - state.prevError) / dt);

  // Combine terms
  const rawOutput = proportional + integral + derivative;

  // Guard against NaN/Inf
  const output = Number.isFinite(rawOutput) ? rawOutput : 0;

  // Updated state
  const newState: PidState = {
    prevError: error,
    integral: newIntegral,
    lastUpdate: currentTime,
  };

  return {
    output,
    state: newState,
    debug: {
      proportional,
      integral,
      derivative,
      error,
      dt,
    },
  };
}

/**
 * Reset PID state (clear integral and previous error)
 */
export function resetPid(state: PidState): PidState {
  return {
    prevError: 0,
    integral: 0,
    lastUpdate: state.lastUpdate,
  };
}
