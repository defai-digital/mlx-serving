#!/bin/bash
##
## Example: Benchmark Gemma 2 27B with 200 questions
##
## This script demonstrates how to use the flexible benchmark tool
## to compare mlx-serving vs mlx-engine performance on a large model.
##
## Usage:
##   bash examples/benchmark-gemma-27b.sh
##

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Gemma 2 27B Benchmark - 200 Questions${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Configuration
MODEL="mlx-community/gemma-2-27b-it-4bit"
QUESTIONS=200
MAX_TOKENS=100
TEMPERATURE=0.7
OUTPUT_DIR="benchmarks/results"
OUTPUT_FILE="${OUTPUT_DIR}/gemma-27b-200q-$(date +%Y%m%d-%H%M%S).json"

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo -e "${GREEN}Configuration:${NC}"
echo "  Model:       $MODEL"
echo "  Questions:   $QUESTIONS"
echo "  Max Tokens:  $MAX_TOKENS"
echo "  Temperature: $TEMPERATURE"
echo "  Output:      $OUTPUT_FILE"
echo ""

# Check if model is available
echo -e "${YELLOW}Checking if model is available...${NC}"
if ! mlx-lm --model "$MODEL" --max-tokens 1 --prompt "test" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Model not found locally. Will download on first use.${NC}"
    echo -e "${YELLOW}   This may take several minutes (~50GB download).${NC}"
    echo ""
fi

# Run benchmark
echo -e "${GREEN}Starting benchmark...${NC}"
echo ""

tsx benchmarks/flexible-benchmark.ts \
  --model "$MODEL" \
  --questions "$QUESTIONS" \
  --max-tokens "$MAX_TOKENS" \
  --temperature "$TEMPERATURE" \
  --compare both \
  --output "$OUTPUT_FILE" \
  --verbose

# Print summary
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Benchmark Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "Results saved to: ${BLUE}$OUTPUT_FILE${NC}"
echo ""
echo "Quick analysis:"
echo "  # View winner"
echo "  jq '.comparison.winner' $OUTPUT_FILE"
echo ""
echo "  # View speedup"
echo "  jq '.comparison.speedup' $OUTPUT_FILE"
echo ""
echo "  # View mlx-serving throughput"
echo "  jq '.mlxServing.statistics.tokensPerSec.mean' $OUTPUT_FILE"
echo ""
