#!/usr/bin/env tsx
/**
 * Prepare Python environment for mlx-serving.
 * Creates/updates .mlx-serving-venv and installs MLX dependencies.
 */

import { execa } from 'execa';
import { existsSync } from 'fs';
import { resolve } from 'path';

const PROJECT_ROOT = process.cwd();
const VENV_PATH = resolve(PROJECT_ROOT, '.mlx-serving-venv');
const REQUIREMENTS_PATH = resolve(PROJECT_ROOT, 'python', 'requirements.txt');
const IS_WINDOWS = process.platform === 'win32';

async function findPythonCommand(): Promise<string> {
  const candidates = ['python3.12', 'python3.11', 'python3'];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execa(candidate, ['--version']);
      console.log(`✓ Found ${candidate}: ${stdout.trim()}`);
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    'Python 3.11+ is required. Install Python 3.11 or 3.12 from https://www.python.org/downloads/.'
  );
}

async function ensureVenv(pythonCmd: string): Promise<void> {
  if (existsSync(VENV_PATH)) {
    console.log(`✓ Virtual environment already exists at ${VENV_PATH}`);
    return;
  }

  console.log(`Creating virtual environment at ${VENV_PATH}...`);
  await execa(pythonCmd, ['-m', 'venv', VENV_PATH], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
  console.log('✓ Virtual environment created\n');
}

function getPipPath(): string {
  return IS_WINDOWS ? resolve(VENV_PATH, 'Scripts', 'pip') : resolve(VENV_PATH, 'bin', 'pip');
}

function getPythonPath(): string {
  return IS_WINDOWS ? resolve(VENV_PATH, 'Scripts', 'python') : resolve(VENV_PATH, 'bin', 'python');
}

async function upgradePip(pipPath: string): Promise<void> {
  console.log('Upgrading pip inside virtual environment...');
  await execa(pipPath, ['install', '--upgrade', 'pip'], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
  console.log('✓ Pip upgraded\n');
}

async function installDependencies(pipPath: string): Promise<void> {
  if (!existsSync(REQUIREMENTS_PATH)) {
    throw new Error(`Missing requirements file at ${REQUIREMENTS_PATH}`);
  }

  console.log('Installing MLX Python dependencies (mlx, mlx-lm, mlx-vlm)...');
  await execa(pipPath, ['install', '-r', REQUIREMENTS_PATH], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
  console.log('✓ Dependencies installed\n');
}

async function verifyRuntime(pythonPath: string): Promise<void> {
  console.log('Verifying MLX runtime import...');
  const { stdout } = await execa(pythonPath, ['-c', 'import mlx, mlx_lm, mlx_vlm; print("OK")'], {
    cwd: PROJECT_ROOT,
  });

  if (!stdout.includes('OK')) {
    throw new Error('Failed to verify MLX runtime inside the virtual environment.');
  }

  console.log('✓ MLX runtime ready\n');
}

async function main(): Promise<void> {
  console.log('🐍 Preparing Python environment for mlx-serving...\n');

  const pythonCmd = await findPythonCommand();
  await ensureVenv(pythonCmd);

  const pipPath = getPipPath();
  const pythonPath = getPythonPath();

  await upgradePip(pipPath);
  await installDependencies(pipPath);
  await verifyRuntime(pythonPath);

  console.log('✅ Python environment ready!');
  if (IS_WINDOWS) {
    console.log(`Activate with: ${VENV_PATH}\\Scripts\\activate`);
  } else {
    console.log(`Activate with: source ${VENV_PATH}/bin/activate`);
  }
}

main().catch((error) => {
  console.error('\nError setting up Python environment:', error);
  process.exit(1);
});
