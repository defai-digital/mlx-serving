#!/usr/bin/env tsx
/**
 * Prepare Python environment for kr-mlx-lm
 * Creates venv and installs dependencies
 */

import { execa } from 'execa';
import { existsSync } from 'fs';
import { resolve } from 'path';

const VENV_PATH = resolve(process.cwd(), '.kr-mlx-venv');
const REQUIREMENTS_PATH = resolve(process.cwd(), 'python/requirements.txt');

async function main() {
  console.log('🐍 Setting up Python environment for kr-mlx-lm...\n');

  // Determine Python command - prefer python3.11 or python3.12 for MLX compatibility
  let pythonCmd = 'python3';
  try {
    await execa('python3.11', ['--version']);
    pythonCmd = 'python3.11';
    console.log('✓ Using Python 3.11 (MLX compatible)\n');
  } catch {
    try {
      await execa('python3.12', ['--version']);
      pythonCmd = 'python3.12';
      console.log('✓ Using Python 3.12 (MLX compatible)\n');
    } catch {
      console.log('⚠️  Warning: Using default python3 (may not be MLX compatible)\n');
    }
  }

  // Check if venv already exists
  if (existsSync(VENV_PATH)) {
    console.log('✓ Virtual environment already exists');
  } else {
    console.log('Creating virtual environment...');
    await execa(pythonCmd, ['-m', 'venv', VENV_PATH], { stdio: 'inherit' });
    console.log('✓ Virtual environment created\n');
  }

  // Determine pip path based on platform
  const pipPath =
    process.platform === 'win32'
      ? resolve(VENV_PATH, 'Scripts', 'pip')
      : resolve(VENV_PATH, 'bin', 'pip');

  // Upgrade pip
  console.log('Upgrading pip...');
  await execa(pipPath, ['install', '--upgrade', 'pip'], { stdio: 'inherit' });
  console.log('✓ Pip upgraded\n');

  // Install requirements
  console.log('Installing Python dependencies...');
  console.log('This may take a few minutes...\n');
  await execa(pipPath, ['install', '-r', REQUIREMENTS_PATH], { stdio: 'inherit' });
  console.log('\n✓ Dependencies installed\n');

  // Verify installation
  console.log('Verifying MLX installation...');
  const pythonPath =
    process.platform === 'win32'
      ? resolve(VENV_PATH, 'Scripts', 'python')
      : resolve(VENV_PATH, 'bin', 'python');

  try {
    // Newer MLX versions don't have __version__ attribute, so just check import
    const { stdout } = await execa(pythonPath, ['-c', 'import mlx, mlx_lm, mlx_vlm; print("OK")']);
    if (stdout.includes('OK')) {
      console.log(`✓ MLX libraries imported successfully\n`);
    }
  } catch (error) {
    console.error('✗ Failed to verify MLX installation');
    throw error;
  }

  console.log('✅ Python environment ready!');
  console.log(`\nTo activate manually:`);
  console.log(
    process.platform === 'win32'
      ? `.kr-mlx-venv\\Scripts\\activate`
      : `source .kr-mlx-venv/bin/activate`
  );
}

main().catch((error) => {
  console.error('Error setting up Python environment:', error);
  process.exit(1);
});
