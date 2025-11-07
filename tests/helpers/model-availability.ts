/**
 * Helper to check if local models are available for testing
 *
 * Integration tests require local models to be present. This helper checks
 * for model availability by verifying the existence of required model files.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SUPPORTED_PLATFORMS = new Set(['darwin']);
const SUPPORTED_ARCHS = new Set(['arm64', 'x64']);

/**
 * Determine whether the host can run MLX without aborting.
 * Bug #1 P0: Skip integration tests on platforms where MLX is known to crash.
 */
export function getMlxSkipReason(): string | null {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    return `MLX runtime requires macOS (detected ${process.platform})`;
  }
  if (!SUPPORTED_ARCHS.has(process.arch)) {
    return `Unsupported architecture for MLX runtime: ${process.arch}`;
  }
  return null;
}

export function isMlxSupported(): boolean {
  return getMlxSkipReason() === null;
}

/**
 * Check if a model directory exists and has required files
 *
 * @param modelPath - Relative or absolute path to the model directory
 * @returns boolean - true if model is available
 */
export function hasModel(modelPath: string): boolean {
  try {
    // Check if directory exists
    if (!existsSync(modelPath)) {
      return false;
    }

    // Check for essential model files (at least config.json should exist)
    const configPath = join(modelPath, 'config.json');
    return existsSync(configPath);
  } catch {
    return false;
  }
}

/**
 * Check if ALL specified models are available
 *
 * @param modelPaths - Array of model paths to check
 * @returns boolean - true if all models are available
 */
export function hasAllModels(modelPaths: string[]): boolean {
  return modelPaths.every((path) => hasModel(path));
}

/**
 * Check if the standard test model is available
 *
 * @returns boolean - true if llama-3.2-3b-instruct is available
 */
export function hasTestModel(): boolean {
  return hasModel('./models/llama-3.2-3b-instruct');
}

/**
 * Check if draft model pairing is available for testing
 *
 * @returns boolean - true if both primary and draft models are available
 */
export function hasDraftModelPair(): boolean {
  return hasAllModels([
    './models/llama-3-8b-instruct',
    './models/llama-3.2-3b-instruct',
  ]);
}
