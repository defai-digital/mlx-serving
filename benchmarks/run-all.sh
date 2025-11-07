#!/bin/bash

# Comprehensive Benchmark Runner
# Runs benchmarks for kr-mlx-lm, mlx-lm, and mlx-engine

set -e

echo "================================"
echo "MLX Framework Benchmark Suite"
echo "================================"
echo ""

# Create results directory
mkdir -p benchmarks/results

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if model exists
if [ ! -d "./models/llama-3.2-3b-instruct" ]; then
    echo -e "${RED}Error: Model not found at ./models/llama-3.2-3b-instruct${NC}"
    echo "Please download the model first."
    exit 1
fi

# 1. Run kr-mlx-lm benchmark
echo -e "${BLUE}[1/3] Running kr-mlx-lm benchmark...${NC}"
pnpm tsx benchmarks/kr-mlx-lm/benchmark.ts
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ kr-mlx-lm benchmark complete${NC}"
else
    echo -e "${RED}✗ kr-mlx-lm benchmark failed${NC}"
fi
echo ""

# 2. Run mlx-lm benchmark
echo -e "${BLUE}[2/3] Running mlx-lm benchmark...${NC}"
.kr-mlx-venv/bin/python benchmarks/mlx-lm/benchmark.py
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ mlx-lm benchmark complete${NC}"
else
    echo -e "${RED}✗ mlx-lm benchmark failed${NC}"
fi
echo ""

# 3. Run mlx-engine benchmark (if available)
echo -e "${BLUE}[3/3] Running mlx-engine benchmark...${NC}"
if .kr-mlx-venv/bin/python -c "import mlx_engine" 2>/dev/null; then
    .kr-mlx-venv/bin/python benchmarks/mlx-engine/benchmark.py
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ mlx-engine benchmark complete${NC}"
    else
        echo -e "${RED}✗ mlx-engine benchmark failed${NC}"
    fi
else
    echo -e "${RED}⚠ mlx-engine not installed, skipping...${NC}"
    echo "Install with: .kr-mlx-venv/bin/pip install mlx-engine"
fi
echo ""

# 4. Generate comparison report
echo -e "${BLUE}[4/4] Generating comparison report...${NC}"
pnpm tsx benchmarks/compare-results.ts
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Comparison report generated${NC}"
else
    echo -e "${RED}✗ Failed to generate comparison report${NC}"
fi
echo ""

echo "================================"
echo "Benchmark Suite Complete!"
echo "================================"
echo ""
echo "Results available in:"
echo "  - benchmarks/results/*.json (raw data)"
echo "  - benchmarks/results/comparison.md (comparison report)"
echo ""
