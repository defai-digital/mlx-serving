import { existsSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../src/config/loader.js';

const config = getConfig();

const configuredPythonPath = path.join(process.cwd(), config.python_runtime.python_path);

/**
 * Resolve the python binary path the runtime will attempt to spawn.
 */
export function getPythonRuntimePath(): string {
  return process.env.KR_MLX_PYTHON_PATH ?? configuredPythonPath;
}

export function hasPythonRuntime(): boolean {
  try {
    return existsSync(getPythonRuntimePath());
  } catch {
    return false;
  }
}

export function getPythonRuntimeSkipReason(): string | null {
  if (hasPythonRuntime()) {
    return null;
  }
  return `Python runtime not found at ${getPythonRuntimePath()}`;
}
