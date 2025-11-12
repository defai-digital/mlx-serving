#!/bin/bash
#
# deploy-canary.sh - Deploy Phase 5 with canary rollout
#
# Usage:
#   ./scripts/deploy-canary.sh [OPTIONS]
#
# Options:
#   --percentage NUM    Initial rollout percentage (default: 1)
#   --duration HOURS    Monitoring duration before auto-increase (default: 24)
#   --dry-run           Validate without deploying
#   --force             Skip safety checks
#
# Examples:
#   ./scripts/deploy-canary.sh                    # Deploy at 1%
#   ./scripts/deploy-canary.sh --percentage 10    # Deploy at 10%
#   ./scripts/deploy-canary.sh --dry-run          # Validate only
#

set -euo pipefail

# Configuration
PERCENTAGE=1
DURATION_HOURS=24
DRY_RUN=false
FORCE=false
CONFIG_FILE="config/canary.yaml"
PID_FILE="/var/run/mlx-serving.pid"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --percentage)
      PERCENTAGE="$2"
      shift 2
      ;;
    --duration)
      DURATION_HOURS="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate percentage
if ! [[ "$PERCENTAGE" =~ ^[0-9]+$ ]] || [ "$PERCENTAGE" -lt 0 ] || [ "$PERCENTAGE" -gt 100 ]; then
  echo -e "${RED}Error: Percentage must be 0-100${NC}"
  exit 1
fi

echo -e "${GREEN}=== Phase 5 Canary Deployment ===${NC}"
echo "Percentage: ${PERCENTAGE}%"
echo "Monitoring duration: ${DURATION_HOURS} hours"
echo "Dry run: ${DRY_RUN}"
echo ""

# Pre-deployment checks
if [ "$FORCE" = false ]; then
  echo "Running pre-deployment checks..."

  # Check TypeScript compilation
  echo "- TypeScript compilation..."
  if ! npm run typecheck > /dev/null 2>&1; then
    echo -e "${RED}✗ TypeScript compilation failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ TypeScript OK${NC}"

  # Check tests
  echo "- Running tests..."
  if ! npm run test > /dev/null 2>&1; then
    echo -e "${RED}✗ Tests failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Tests OK${NC}"

  # Check build
  echo "- Building..."
  if ! npm run build > /dev/null 2>&1; then
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Build OK${NC}"
else
  echo -e "${YELLOW}⚠ Skipping pre-deployment checks (--force)${NC}"
fi

# Create canary configuration
echo ""
echo "Updating canary config..."

if [ "$DRY_RUN" = false ]; then
  # Backup existing config
  if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "${CONFIG_FILE}.backup"
  fi

  # Write new config
  cat > "$CONFIG_FILE" <<EOF
# Phase 5 Canary Configuration
# Generated: $(date -Iseconds)

canary:
  enabled: true
  rolloutPercentage: ${PERCENTAGE}
  strategy: hash
  hashKey: user_id
  enableCache: true
  cacheSize: 10000

rollback:
  enabled: true
  cooldownMs: 300000  # 5 minutes
  gradual: false
  triggers:
    - name: high_error_rate
      threshold: 2.0  # 2x baseline
      severity: critical
    - name: high_latency
      threshold: 1.5  # 1.5x baseline
      severity: critical
    - name: memory_leak
      threshold: 50   # 50 MB/hour
      severity: warning
    - name: crash_rate
      threshold: 0.001  # 0.1% absolute increase
      severity: critical

monitoring:
  enabled: true
  intervalMs: 5000    # 5 seconds
  retentionHours: 1   # 1 hour history
EOF

  echo -e "${GREEN}✓ Config updated: $CONFIG_FILE${NC}"
else
  echo -e "${YELLOW}✓ Config generated (dry-run - not saved)${NC}"
  cat > /tmp/canary-config-preview.yaml <<EOF
canary:
  enabled: true
  rolloutPercentage: ${PERCENTAGE}
  strategy: hash
  hashKey: user_id

rollback:
  enabled: true
  triggers:
    - high_error_rate (2x)
    - high_latency (1.5x)
    - memory_leak (50 MB/hour)
EOF
  cat /tmp/canary-config-preview.yaml
fi

# Reload configuration (zero-downtime)
if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "Reloading configuration..."

  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    echo "Sending HUP signal to process $PID..."
    kill -HUP "$PID" || {
      echo -e "${YELLOW}⚠ Could not send HUP signal (process may not be running)${NC}"
    }
  else
    echo -e "${YELLOW}⚠ PID file not found: $PID_FILE${NC}"
    echo "  Server may need manual restart"
  fi

  # Wait for configuration to take effect
  echo "Waiting for configuration to take effect..."
  sleep 5
fi

# Verify canary is active
if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "Verifying canary activation..."

  if command -v curl > /dev/null 2>&1; then
    HEALTH=$(curl -s http://localhost:3000/health/canary || echo "{}")

    if command -v jq > /dev/null 2>&1; then
      echo "$HEALTH" | jq . || echo "$HEALTH"
    else
      echo "$HEALTH"
    fi
  else
    echo -e "${YELLOW}⚠ curl not available - skipping health check${NC}"
  fi
fi

# Final summary
echo ""
echo -e "${GREEN}=== Deployment Summary ===${NC}"

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}✓ Dry run successful${NC}"
  echo "  No changes were made to the system"
  echo "  Run without --dry-run to deploy"
else
  echo -e "${GREEN}✓ Canary deployed at ${PERCENTAGE}%${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Monitor with: ./scripts/monitor-canary.sh"
  echo "  2. Rollback with: ./scripts/rollback-canary.sh"
  echo "  3. Review logs: tail -f logs/mlx-serving.log"
  echo ""
  echo "Monitoring for ${DURATION_HOURS} hours..."
  echo "Automated rollback triggers are active."
fi

exit 0
