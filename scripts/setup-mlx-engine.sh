#!/bin/bash
# Setup script for mlx-engine comparison benchmarks
# This script automates the installation and setup of mlx-engine

set -e

MLX_ENGINE_DIR="${MLX_ENGINE_DIR:-/tmp/mlx-engine}"
PYTHON_VERSION="python3.11"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     mlx-engine Setup for Comparison Benchmarks                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check for Python 3.11
echo "🔍 Checking for Python 3.11..."
if ! command -v $PYTHON_VERSION &> /dev/null; then
    echo "❌ Python 3.11 not found"
    echo ""
    echo "Please install Python 3.11:"
    echo "  brew install python@3.11"
    echo ""
    exit 1
fi
echo "✅ Python 3.11 found: $($PYTHON_VERSION --version)"
echo ""

# Clone mlx-engine if not exists
if [ -d "$MLX_ENGINE_DIR" ]; then
    echo "📁 mlx-engine already exists at: $MLX_ENGINE_DIR"
    read -p "Do you want to update it? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🔄 Updating mlx-engine..."
        cd "$MLX_ENGINE_DIR"
        git pull origin main
    fi
else
    echo "📦 Cloning mlx-engine to: $MLX_ENGINE_DIR"
    git clone --depth 1 https://github.com/lmstudio-ai/mlx-engine.git "$MLX_ENGINE_DIR"
fi
echo ""

# Setup Python virtual environment
cd "$MLX_ENGINE_DIR"

if [ -d ".venv" ]; then
    echo "🐍 Python virtual environment already exists"
    read -p "Do you want to recreate it? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🗑️  Removing old virtual environment..."
        rm -rf .venv
        echo "🐍 Creating new Python virtual environment..."
        $PYTHON_VERSION -m venv .venv
    fi
else
    echo "🐍 Creating Python virtual environment..."
    $PYTHON_VERSION -m venv .venv
fi
echo ""

# Activate virtual environment and install dependencies
echo "📚 Installing Python dependencies..."
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -U -r requirements.txt
echo "✅ Dependencies installed"
echo ""

# Verify installation
echo "🔍 Verifying mlx-engine installation..."
if python -c "import mlx_engine" 2>/dev/null; then
    echo "✅ mlx-engine module loaded successfully"
else
    echo "❌ Failed to load mlx-engine module"
    exit 1
fi
echo ""

# Check for test models
echo "🔍 Checking for test models..."
MODEL_PATH="../../models/llama-3.2-3b-instruct"
if [ -d "$MODEL_PATH" ]; then
    echo "✅ Test model found: $MODEL_PATH"
else
    echo "⚠️  Test model not found: $MODEL_PATH"
    echo ""
    echo "You need to download a test model. Options:"
    echo ""
    echo "  1. Using LM Studio CLI:"
    echo "     lms get mlx-community/Meta-Llama-3.2-3B-Instruct-4bit"
    echo ""
    echo "  2. Ensure model exists at:"
    echo "     models/llama-3.2-3b-instruct/"
    echo ""
fi
echo ""

# Run quick test
echo "🧪 Running quick test..."
if python -c "
from mlx_engine.generate import load_model
print('✅ mlx-engine is ready for benchmarks')
" 2>/dev/null; then
    echo "✅ Test passed"
else
    echo "⚠️  Test failed, but mlx-engine is installed"
fi
echo ""

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                  Setup Complete! 🎉                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "mlx-engine location: $MLX_ENGINE_DIR"
echo "Python environment: $MLX_ENGINE_DIR/.venv"
echo ""
echo "Next steps:"
echo ""
echo "  1. Download test model (if not already done):"
echo "     lms get mlx-community/Meta-Llama-3.2-3B-Instruct-4bit"
echo ""
echo "  2. Run comparison benchmark:"
echo "     pnpm bench:comparison"
echo ""
echo "To manually test mlx-engine:"
echo "  cd $MLX_ENGINE_DIR"
echo "  source .venv/bin/activate"
echo "  python demo.py --model ../../models/llama-3.2-3b-instruct --prompt 'Test'"
echo ""
