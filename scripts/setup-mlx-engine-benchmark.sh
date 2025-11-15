#!/bin/bash
################################################################################
# mlx-engine Benchmark Setup Script
#
# This script sets up mlx-engine for fair benchmarking against mlx-serving.
# It creates a proper Python 3.11 environment and installs mlx-engine from source.
#
# Requirements:
#   - macOS 14.0 (Sonoma) or later
#   - Python 3.11 (will check and guide if missing)
#   - Git
#
# Usage:
#   bash scripts/setup-mlx-engine-benchmark.sh
#
# What it does:
#   1. Checks Python 3.11 availability
#   2. Creates Python 3.11 venv at .mlx-engine-venv/
#   3. Clones mlx-engine to /tmp/mlx-engine
#   4. Installs all mlx-engine dependencies
#   5. Verifies the installation
#
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print functions
print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

print_step() {
    echo -e "${BLUE}➜${NC} $1"
}

################################################################################
# Step 1: Check System Requirements
################################################################################

print_header "Step 1: Checking System Requirements"

# Check macOS version
MACOS_VERSION=$(sw_vers -productVersion)
print_info "macOS Version: $MACOS_VERSION"

MACOS_MAJOR=$(echo "$MACOS_VERSION" | cut -d'.' -f1)
if [ "$MACOS_MAJOR" -lt 14 ]; then
    print_error "macOS 14.0 (Sonoma) or later required. Current: $MACOS_VERSION"
    exit 1
fi
print_success "macOS version OK"

# Check for Python 3.11
print_step "Looking for Python 3.11..."

PYTHON311=""
if command -v python3.11 &> /dev/null; then
    PYTHON311="python3.11"
    PYTHON_VERSION=$($PYTHON311 --version 2>&1 | awk '{print $2}')
    print_success "Found Python 3.11: $PYTHON_VERSION at $(which $PYTHON311)"
elif command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
    PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d'.' -f1)
    PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d'.' -f2)

    if [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -eq 11 ]; then
        PYTHON311="python3"
        print_success "Found Python 3.11: $PYTHON_VERSION at $(which python3)"
    fi
fi

if [ -z "$PYTHON311" ]; then
    print_error "Python 3.11 not found!"
    echo ""
    echo "Please install Python 3.11:"
    echo "  brew install python@3.11"
    echo ""
    echo "After installation, run this script again."
    exit 1
fi

# Check for git
if ! command -v git &> /dev/null; then
    print_error "Git not found! Please install: xcode-select --install"
    exit 1
fi
print_success "Git found: $(git --version)"

echo ""

################################################################################
# Step 2: Create Python 3.11 Virtual Environment
################################################################################

print_header "Step 2: Setting Up Python Virtual Environment"

VENV_DIR=".mlx-engine-venv"

if [ -d "$VENV_DIR" ]; then
    print_info "Virtual environment already exists at $VENV_DIR"
    read -p "Do you want to recreate it? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_step "Removing existing venv..."
        rm -rf "$VENV_DIR"
    else
        print_info "Using existing venv"
        PYTHON_BIN="$VENV_DIR/bin/python"
        print_success "Python venv ready: $($PYTHON_BIN --version)"
        echo ""
        # Skip to next step
        SKIP_VENV_CREATION=true
    fi
fi

if [ -z "$SKIP_VENV_CREATION" ]; then
    print_step "Creating Python 3.11 virtual environment..."
    $PYTHON311 -m venv "$VENV_DIR"
    print_success "Virtual environment created"

    PYTHON_BIN="$VENV_DIR/bin/python"
    PIP_BIN="$VENV_DIR/bin/pip"

    print_step "Upgrading pip..."
    $PIP_BIN install --upgrade pip setuptools wheel > /dev/null 2>&1
    print_success "pip upgraded to $($PIP_BIN --version | awk '{print $2}')"
fi

PYTHON_BIN="$VENV_DIR/bin/python"
PIP_BIN="$VENV_DIR/bin/pip"

echo ""

################################################################################
# Step 3: Clone mlx-engine Repository
################################################################################

print_header "Step 3: Setting Up mlx-engine Repository"

MLX_ENGINE_DIR="/tmp/mlx-engine"

if [ -d "$MLX_ENGINE_DIR" ]; then
    print_info "mlx-engine already exists at $MLX_ENGINE_DIR"
    read -p "Do you want to update it? (Y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        print_step "Updating mlx-engine repository..."
        cd "$MLX_ENGINE_DIR"
        git pull origin main
        cd - > /dev/null
        print_success "Repository updated"
    else
        print_info "Using existing repository"
    fi
else
    print_step "Cloning mlx-engine from GitHub..."
    git clone https://github.com/lmstudio-ai/mlx-engine.git "$MLX_ENGINE_DIR"
    print_success "Repository cloned to $MLX_ENGINE_DIR"
fi

echo ""

################################################################################
# Step 4: Install mlx-engine Dependencies
################################################################################

print_header "Step 4: Installing mlx-engine Dependencies"

if [ ! -f "$MLX_ENGINE_DIR/requirements.txt" ]; then
    print_error "requirements.txt not found in mlx-engine!"
    print_error "Expected location: $MLX_ENGINE_DIR/requirements.txt"
    exit 1
fi

print_step "Installing dependencies from requirements.txt..."
print_info "This may take several minutes (installing mlx, transformers, etc.)"

$PIP_BIN install -r "$MLX_ENGINE_DIR/requirements.txt"

print_success "All dependencies installed"

echo ""

################################################################################
# Step 5: Verify Installation
################################################################################

print_header "Step 5: Verifying Installation"

print_step "Testing mlx-engine import..."

VERIFY_SCRIPT="
import sys
sys.path.insert(0, '/tmp/mlx-engine')

try:
    from mlx_engine.generate import load_model, create_generator, tokenize
    import mlx.core as mx
    print('✓ mlx-engine imports successful')
    print(f'✓ MLX version: {mx.__version__}')
except ImportError as e:
    print(f'✗ Import failed: {e}')
    sys.exit(1)
"

if $PYTHON_BIN -c "$VERIFY_SCRIPT"; then
    print_success "mlx-engine verification passed"
else
    print_error "mlx-engine verification failed"
    exit 1
fi

echo ""

################################################################################
# Step 6: Installation Complete
################################################################################

print_header "Installation Complete!"

echo ""
echo "mlx-engine is now set up and ready for benchmarking!"
echo ""
echo "Setup Summary:"
echo "  • Python Environment: $VENV_DIR"
echo "  • Python Version: $($PYTHON_BIN --version)"
echo "  • mlx-engine Location: $MLX_ENGINE_DIR"
echo "  • pip packages: $($ PIP_BIN list | wc -l | xargs) packages installed"
echo ""
echo "To run benchmarks:"
echo "  pnpm run bench:llm benchmarks/comprehensive-benchmark-v1.1.1-small-first.yaml"
echo ""
echo "The benchmark will automatically use:"
echo "  • mlx-engine from: $MLX_ENGINE_DIR"
echo "  • Python from: $VENV_DIR/bin/python"
echo ""
print_success "You're ready to benchmark!"

################################################################################
# Optional: Quick Test
################################################################################

read -p "Do you want to run a quick test? (Y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    echo ""
    print_header "Running Quick Test"

    TEST_SCRIPT="
import sys
sys.path.insert(0, '/tmp/mlx-engine')

from mlx_engine.generate import load_model, create_generator
import mlx.core as mx

print('Testing with a tiny model (this may take a minute)...')
print('Note: If this is your first time, it will download the model.')

# Test with smallest possible model
model_name = 'mlx-community/Qwen2.5-0.5B-Instruct-4bit'
print(f'Loading: {model_name}')

try:
    model, tokenizer = load_model(model_name)
    generator = create_generator(model, tokenizer)

    print('✓ Model loaded successfully!')
    print('✓ Generator created successfully!')
    print('')
    print('mlx-engine is working correctly!')

except Exception as e:
    print(f'✗ Test failed: {e}')
    sys.exit(1)
"

    $PYTHON_BIN -c "$TEST_SCRIPT"

    if [ $? -eq 0 ]; then
        echo ""
        print_success "Quick test passed! mlx-engine is fully functional."
    else
        echo ""
        print_error "Quick test failed. Please check the error messages above."
    fi
fi

echo ""
print_success "Setup complete! Happy benchmarking! 🚀"
