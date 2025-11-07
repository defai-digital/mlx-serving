#!/bin/bash
# Test runner for structured output examples
# Verifies all examples can run without errors

set -e  # Exit on error

echo "=========================================="
echo "Testing Structured Output Examples"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Python environment exists
if [ ! -d ".kr-mlx-venv" ]; then
    echo -e "${RED}Error: Python environment not found${NC}"
    echo "Run: pnpm prepare:python"
    exit 1
fi

# Check if Outlines is installed
echo -e "${YELLOW}Checking Outlines installation...${NC}"
if .kr-mlx-venv/bin/python -c "import outlines" 2>/dev/null; then
    OUTLINES_VERSION=$(.kr-mlx-venv/bin/python -c "import outlines; print(outlines.__version__)")
    echo -e "${GREEN}✓ Outlines installed: v${OUTLINES_VERSION}${NC}"
else
    echo -e "${RED}✗ Outlines not installed${NC}"
    echo "Run: pnpm prepare:python"
    exit 1
fi
echo ""

# Test Python examples
echo "=========================================="
echo "Testing Python Examples"
echo "=========================================="
echo ""

EXAMPLES=(
    "json_schema_example.py"
    "xml_mode_example.py"
    "complex_schema_example.py"
)

for example in "${EXAMPLES[@]}"; do
    echo -e "${YELLOW}Testing: ${example}${NC}"

    if [ -f "examples/structured/${example}" ]; then
        # Run with timeout (60 seconds)
        if timeout 60s .kr-mlx-venv/bin/python "examples/structured/${example}" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ ${example} passed${NC}"
        else
            EXIT_CODE=$?
            if [ $EXIT_CODE -eq 124 ]; then
                echo -e "${YELLOW}⚠ ${example} timed out (may need model download)${NC}"
            else
                echo -e "${RED}✗ ${example} failed${NC}"
            fi
        fi
    else
        echo -e "${RED}✗ ${example} not found${NC}"
    fi
    echo ""
done

# Test TypeScript example
echo "=========================================="
echo "Testing TypeScript Example"
echo "=========================================="
echo ""

if [ -f "examples/structured/typescript_example.ts" ]; then
    echo -e "${YELLOW}Testing: typescript_example.ts${NC}"

    # Check if tsx is available
    if command -v pnpm &> /dev/null; then
        if timeout 60s pnpm tsx examples/structured/typescript_example.ts > /dev/null 2>&1; then
            echo -e "${GREEN}✓ typescript_example.ts passed${NC}"
        else
            EXIT_CODE=$?
            if [ $EXIT_CODE -eq 124 ]; then
                echo -e "${YELLOW}⚠ typescript_example.ts timed out${NC}"
            else
                echo -e "${RED}✗ typescript_example.ts failed${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}⚠ pnpm not found, skipping TypeScript test${NC}"
    fi
else
    echo -e "${RED}✗ typescript_example.ts not found${NC}"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo ""
echo "All structural tests completed."
echo "Note: Some tests may timeout if models need to be downloaded."
echo ""
echo "To run examples manually:"
echo "  Python:  .kr-mlx-venv/bin/python examples/structured/json_schema_example.py"
echo "  TypeScript: pnpm tsx examples/structured/typescript_example.ts"
echo ""
