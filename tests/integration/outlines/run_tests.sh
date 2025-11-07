#!/bin/bash
# Test runner script for Outlines integration tests

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Find project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../../../.."
VENV_PATH="$PROJECT_ROOT/.kr-mlx-venv"

echo -e "${YELLOW}Outlines Integration Tests Runner${NC}"
echo "======================================"
echo ""

# Check if virtual environment exists
if [ ! -d "$VENV_PATH" ]; then
    echo -e "${RED}Error: Virtual environment not found at $VENV_PATH${NC}"
    echo "Run: pnpm prepare:python"
    exit 1
fi

# Activate virtual environment
PYTHON="$VENV_PATH/bin/python"

# Check if pytest is installed
if ! $PYTHON -m pytest --version > /dev/null 2>&1; then
    echo -e "${YELLOW}Installing pytest...${NC}"
    $PYTHON -m pip install pytest pytest-cov pytest-mock --quiet
fi

# Parse command line arguments
TEST_FILE=""
TEST_NAME=""
COVERAGE=false
VERBOSE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --coverage)
            COVERAGE=true
            shift
            ;;
        --verbose|-v)
            VERBOSE="-vv"
            shift
            ;;
        --file)
            TEST_FILE="$2"
            shift 2
            ;;
        --test)
            TEST_NAME="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Build test command
TEST_CMD="$PYTHON -m pytest"

if [ -n "$TEST_FILE" ]; then
    TEST_PATH="$SCRIPT_DIR/$TEST_FILE"
    if [ -n "$TEST_NAME" ]; then
        TEST_PATH="$TEST_PATH::$TEST_NAME"
    fi
else
    TEST_PATH="$SCRIPT_DIR"
fi

TEST_CMD="$TEST_CMD $TEST_PATH $VERBOSE"

if [ "$COVERAGE" = true ]; then
    TEST_CMD="$TEST_CMD --cov=python/adapters/outlines_adapter --cov-report=term-missing --cov-report=html"
fi

# Run tests
echo -e "${YELLOW}Running tests...${NC}"
echo "Command: $TEST_CMD"
echo ""

cd "$PROJECT_ROOT"
eval $TEST_CMD

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ All tests passed!${NC}"
else
    echo ""
    echo -e "${RED}✗ Tests failed with exit code $EXIT_CODE${NC}"
fi

exit $EXIT_CODE
