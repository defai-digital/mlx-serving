/**
 * Helper to check if mlx-vlm is available
 *
 * Vision tests require the mlx-vlm library which is an optional dependency.
 * This helper checks availability by attempting to load a vision model and
 * inspecting the error message.
 */

import { createEngine } from '../../src/api/engine.js';
import { getMlxSkipReason } from './model-availability.js';

let visionSupport: boolean | null = null;

/**
 * Check if mlx-vlm is available in the Python runtime
 *
 * v1.2.0 OPTIMIZATION: Use lightweight capability check instead of loading full 7B model
 * This reduces check time from 4-5s to <100ms
 *
 * @returns Promise<boolean> - true if mlx-vlm is available
 */
export async function hasVisionSupport(): Promise<boolean> {
  // Cache the result to avoid repeated checks
  if (visionSupport !== null) {
    return visionSupport;
  }

  const mlxSkipReason = getMlxSkipReason();
  if (mlxSkipReason) {
    visionSupport = false;
    return visionSupport;
  }

  try {
    const engine = await createEngine();

    try {
      // v1.2.0: Check runtime capabilities instead of loading model
      // This is 40-50x faster (4-5s → <100ms)
      const info = await engine.getRuntimeInfo();

      // Vision support is available if runtime exposes vision capabilities
      const hasVisionCapabilities =
        info.capabilities.includes('load_vision_model') &&
        info.capabilities.includes('generate_with_image');

      visionSupport = hasVisionCapabilities;
    } catch (error) {
      // If getRuntimeInfo() fails, assume no vision support
      visionSupport = false;
    } finally {
      await engine.dispose();
    }
  } catch (error) {
    // If engine creation fails, assume no vision support
    visionSupport = false;
  }

  return visionSupport;
}

/**
 * Check if mlx-vlm is NOT available
 * For use with test.skipIf()
 */
export async function noVisionSupport(): Promise<boolean> {
  return !(await hasVisionSupport());
}
