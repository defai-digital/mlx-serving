#!/bin/bash
# Build kr-serve-mlx native acceleration module

set -e

echo "╔═══════════════════════════════════════╗"
echo "║  Building Native Acceleration        ║"
echo "╚═══════════════════════════════════════╝"
echo

# Get Python executable from venv first
if [ -f ".kr-mlx-venv/bin/python" ]; then
    PYTHON_EXE="$(pwd)/.kr-mlx-venv/bin/python"
else
    PYTHON_EXE=$(which python3)
fi
echo "Using Python: $PYTHON_EXE"

# Check prerequisites
if ! command -v cmake &> /dev/null; then
    echo "❌ Error: CMake not found"
    echo "Install with: brew install cmake"
    exit 1
fi

if ! $PYTHON_EXE -c "import pybind11" &> /dev/null; then
    echo "❌ Error: pybind11 not found"
    echo "Install with: $PYTHON_EXE -m pip install pybind11"
    exit 1
fi

# Create build directory
BUILD_DIR="native/build"
mkdir -p "$BUILD_DIR"

# Configure
echo
echo "Configuring..."
cmake -S native -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DPython3_EXECUTABLE="$PYTHON_EXE" \
    -DBUILD_TESTS=OFF \
    -DBUILD_BENCHMARKS=OFF

# Build
echo
echo "Building..."
NUM_CORES=$(sysctl -n hw.ncpu)
cmake --build "$BUILD_DIR" --config Release -j"$NUM_CORES"

# Check output (find .so file with any suffix)
MODULE_FILE=$(find "$BUILD_DIR" -name "krserve_native*.so" -type f | head -1)

if [ -n "$MODULE_FILE" ]; then
    echo
    echo "✅ Build successful!"
    echo "Module: $MODULE_FILE"
    echo
    echo "Size: $(du -h "$MODULE_FILE" | cut -f1)"
    echo "Linked libraries:"
    otool -L "$MODULE_FILE" | grep -E "(Metal|Foundation)" || true
else
    echo
    echo "❌ Build failed - module not found"
    exit 1
fi

# Test import
echo
echo "Testing Python import..."
export PYTHONPATH="$BUILD_DIR:$PYTHONPATH"
if python3 -c "import krserve_native; print(f'✅ Import successful: krserve_native v{krserve_native.get_version()}')" 2>/dev/null; then
    echo "✅ Module can be imported"
else
    echo "⚠️  Warning: Module built but import failed"
    python3 -c "import krserve_native" 2>&1 || true
fi

echo
echo "═══ Next Steps ═══"
echo "1. Add to Python path: export PYTHONPATH=\"$(pwd)/$BUILD_DIR:\$PYTHONPATH\""
echo "2. Test in Python: python3 -c 'import krserve_native; print(krserve_native.get_version())'"
echo "3. Run benchmarks: ./scripts/benchmark-native.sh"
