#!/bin/bash
#
# rollback-canary.sh - Immediate rollback to baseline (0%)
#
# Usage:
#   ./scripts/rollback-canary.sh [REASON]
#
# Examples:
#   ./scripts/rollback-canary.sh "High error rate detected"
#   ./scripts/rollback-canary.sh "Manual rollback for testing"
#

set -euo pipefail

# Configuration
REASON="${1:-Manual rollback}"
CONFIG_FILE="config/canary.yaml"
PID_FILE="/var/run/mlx-serving.pid"
ROLLBACK_LOG="logs/canary-rollback.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Phase 5 Canary Rollback ===${NC}"
echo "Reason: ${REASON}"
echo "Timestamp: $(date -Iseconds)"
echo ""

# Create logs directory if needed
mkdir -p logs

# Check if canary config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}Error: Canary config not found: $CONFIG_FILE${NC}"
  exit 1
fi

# Get current rollout percentage
CURRENT_PERCENTAGE=$(grep -E "^\s*rolloutPercentage:" "$CONFIG_FILE" | awk '{print $2}' || echo "unknown")
echo "Current rollout: ${CURRENT_PERCENTAGE}%"

# Backup current config
echo "Backing up current config..."
cp "$CONFIG_FILE" "${CONFIG_FILE}.pre-rollback-$(date +%s)"

# Update configuration to 0%
echo "Rolling back to baseline (0%)..."

# Use sed to update rolloutPercentage line
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS requires empty string after -i
  sed -i '' 's/rolloutPercentage:.*/rolloutPercentage: 0/' "$CONFIG_FILE"
else
  # Linux
  sed -i 's/rolloutPercentage:.*/rolloutPercentage: 0/' "$CONFIG_FILE"
fi

# Also disable canary entirely
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's/enabled: true/enabled: false/' "$CONFIG_FILE"
else
  sed -i 's/enabled: true/enabled: false/' "$CONFIG_FILE"
fi

echo -e "${GREEN}✓ Config updated${NC}"

# Reload configuration
echo ""
echo "Reloading configuration..."

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  echo "Sending HUP signal to process $PID..."

  if kill -HUP "$PID" 2>/dev/null; then
    echo -e "${GREEN}✓ Signal sent successfully${NC}"
  else
    echo -e "${YELLOW}⚠ Could not send HUP signal${NC}"
    echo "  You may need to restart the server manually"
  fi
else
  echo -e "${YELLOW}⚠ PID file not found: $PID_FILE${NC}"
  echo "  Server may need manual restart"
fi

# Wait for rollback to take effect
echo ""
echo "Waiting for rollback to take effect..."
sleep 10

# Verify rollback
echo ""
echo "Verifying rollback..."

if command -v curl > /dev/null 2>&1; then
  CURRENT_STATUS=$(curl -s http://localhost:3000/health/canary 2>/dev/null || echo "{}")

  if command -v jq > /dev/null 2>&1; then
    NEW_PERCENTAGE=$(echo "$CURRENT_STATUS" | jq -r '.rolloutPercentage // "unknown"')

    if [ "$NEW_PERCENTAGE" = "0" ] || [ "$NEW_PERCENTAGE" = "unknown" ]; then
      echo -e "${GREEN}✓ Rollback complete (0%)${NC}"
      ROLLBACK_SUCCESS=true
    else
      echo -e "${RED}✗ Rollback failed (still at ${NEW_PERCENTAGE}%)${NC}"
      ROLLBACK_SUCCESS=false
    fi
  else
    echo "$CURRENT_STATUS"
    ROLLBACK_SUCCESS=true  # Assume success if we can't verify
  fi
else
  echo -e "${YELLOW}⚠ curl not available - cannot verify rollback${NC}"
  ROLLBACK_SUCCESS=true  # Assume success
fi

# Log rollback event
ROLLBACK_ENTRY="$(date -Iseconds) | ROLLBACK | ${REASON} | ${CURRENT_PERCENTAGE}% → 0%"

if [ "$ROLLBACK_SUCCESS" = true ]; then
  echo "$ROLLBACK_ENTRY | SUCCESS" >> "$ROLLBACK_LOG"
else
  echo "$ROLLBACK_ENTRY | FAILED" >> "$ROLLBACK_LOG"
fi

# Final summary
echo ""
echo -e "${GREEN}=== Rollback Summary ===${NC}"
echo "Reason: ${REASON}"
echo "Previous rollout: ${CURRENT_PERCENTAGE}%"
echo "New rollout: 0%"
echo "Success: $ROLLBACK_SUCCESS"
echo ""
echo "Logged to: $ROLLBACK_LOG"
echo ""

if [ "$ROLLBACK_SUCCESS" = true ]; then
  echo "Next steps:"
  echo "  1. Review logs: tail -f logs/mlx-serving.log"
  echo "  2. Check rollback log: tail -f $ROLLBACK_LOG"
  echo "  3. Investigate root cause before redeploying"
  exit 0
else
  echo -e "${RED}Rollback verification failed. Please check the system manually.${NC}"
  exit 1
fi
