#!/usr/bin/env node
/**
 * Postinstall script for mlx-serving
 * Sets up Python environment automatically after npm install
 *
 * This script:
 * 1. Detects if we're in a user installation (not a dev environment)
 * 2. Creates Python virtual environment (.mlx-serving-venv)
 * 3. Installs MLX dependencies (mlx-lm, mlx-vlm, outlines)
 *
 * Exit codes:
 * - 0: Success or graceful skip (already installed, dev mode, etc.)
 *
 * Note: This script uses pure Node.js (no TypeScript/tsx) so it works
 * when users install the package via npm without needing devDependencies.
 */

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { resolve } = require('path');

// Paths relative to the package root
const PACKAGE_ROOT = resolve(__dirname, '..');
const VENV_PATH = resolve(PACKAGE_ROOT, '.mlx-serving-venv');
const REQUIREMENTS_PATH = resolve(PACKAGE_ROOT, 'python', 'requirements.txt');

// Check if we're in a development environment (git repo exists)
const isDevMode = existsSync(resolve(PACKAGE_ROOT, '.git'));

/**
 * Check if Python venv already exists
 */
function venvExists() {
  return existsSync(VENV_PATH);
}

/**
 * Find the best available Python command
 * Prefer Python 3.11 or 3.12 for MLX compatibility
 */
function findPythonCommand() {
  const candidates = ['python3.12', 'python3.11', 'python3'];

  for (const cmd of candidates) {
    const result = spawnSync(cmd, ['--version'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.status === 0) {
      const version = result.stdout.trim();
      console.log(`✓ Found ${cmd}: ${version}`);
      return cmd;
    }
  }

  return null;
}

/**
 * Create Python virtual environment
 */
function createVenv(pythonCmd) {
  console.log('Creating virtual environment...');
  const result = spawnSync(pythonCmd, ['-m', 'venv', VENV_PATH], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  });

  if (result.status !== 0) {
    console.error('❌ Failed to create virtual environment');
    return false;
  }

  console.log('✓ Virtual environment created\n');
  return true;
}

/**
 * Get pip path based on platform
 */
function getPipPath() {
  return process.platform === 'win32'
    ? resolve(VENV_PATH, 'Scripts', 'pip')
    : resolve(VENV_PATH, 'bin', 'pip');
}

/**
 * Get Python path based on platform
 */
function getPythonPath() {
  return process.platform === 'win32'
    ? resolve(VENV_PATH, 'Scripts', 'python')
    : resolve(VENV_PATH, 'bin', 'python');
}

/**
 * Upgrade pip in the virtual environment
 */
function upgradePip(pipPath) {
  console.log('Upgrading pip...');
  const result = spawnSync(pipPath, ['install', '--upgrade', 'pip'], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  });

  if (result.status !== 0) {
    console.error('⚠️  Warning: Failed to upgrade pip, but continuing...');
    return true; // Non-critical, continue anyway
  }

  console.log('✓ Pip upgraded\n');
  return true;
}

/**
 * Install Python dependencies from requirements.txt
 */
function installDependencies(pipPath) {
  console.log('Installing Python dependencies...');
  console.log('This may take a few minutes...\n');

  const result = spawnSync(pipPath, ['install', '-r', REQUIREMENTS_PATH], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  });

  if (result.status !== 0) {
    console.error('❌ Failed to install Python dependencies');
    return false;
  }

  console.log('\n✓ Dependencies installed\n');
  return true;
}

/**
 * Verify MLX installation
 */
function verifyInstallation(pythonPath) {
  console.log('Verifying MLX installation...');

  const result = spawnSync(
    pythonPath,
    ['-c', 'import mlx, mlx_lm, mlx_vlm; print("OK")'],
    {
      stdio: 'pipe',
      encoding: 'utf8',
      cwd: PACKAGE_ROOT,
    }
  );

  if (result.status !== 0 || !result.stdout.includes('OK')) {
    console.error('❌ Failed to verify MLX installation');
    console.error(result.stderr);
    return false;
  }

  console.log('✓ MLX libraries verified\n');
  return true;
}

/**
 * Run the complete Python environment setup
 */
function setupPythonEnvironment() {
  console.log('📦 mlx-serving: Setting up Python environment...\n');

  // Step 1: Find Python
  const pythonCmd = findPythonCommand();
  if (!pythonCmd) {
    console.error('❌ Python 3 not found. Please install Python 3.11 or 3.12');
    console.error('   Download from: https://www.python.org/downloads/\n');
    return false;
  }

  // Step 2: Create venv
  if (!createVenv(pythonCmd)) {
    return false;
  }

  const pipPath = getPipPath();
  const pythonPath = getPythonPath();

  // Step 3: Upgrade pip
  if (!upgradePip(pipPath)) {
    return false;
  }

  // Step 4: Install dependencies
  if (!installDependencies(pipPath)) {
    return false;
  }

  // Step 5: Verify installation
  if (!verifyInstallation(pythonPath)) {
    return false;
  }

  console.log('✅ Python environment ready!\n');
  return true;
}

/**
 * Main postinstall logic
 */
function main() {
  // Skip if in development mode
  if (isDevMode) {
    console.log('🔧 Development mode detected, skipping automatic Python setup.');
    console.log('   Run "npm run prepare:python" manually when needed.\n');
    return 0;
  }

  // Skip if venv already exists
  if (venvExists()) {
    console.log('✓ Python environment already exists, skipping setup.\n');
    return 0;
  }

  // Check if requirements.txt exists
  if (!existsSync(REQUIREMENTS_PATH)) {
    console.error('⚠️  Warning: python/requirements.txt not found, skipping Python setup.');
    console.error('   This package may not work correctly.\n');
    return 0;
  }

  // Run Python environment setup
  const success = setupPythonEnvironment();

  // Graceful degradation: Don't fail the install if Python setup fails
  // Users can manually run setup later
  if (!success) {
    console.error('\n⚠️  Python setup failed, but package installation will continue.');
    console.error('   To fix this manually, run from the package directory:');
    console.error('   cd node_modules/@defai.digital/mlx-serving && npm run prepare:python\n');
  }

  return 0; // Always return 0 (graceful degradation)
}

// Run main and exit with status code
const exitCode = main();
process.exit(exitCode);
