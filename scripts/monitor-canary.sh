#!/bin/bash
#
# monitor-canary.sh - Real-time canary monitoring dashboard
#
# Usage:
#   ./scripts/monitor-canary.sh [--interval SECONDS]
#
# Examples:
#   ./scripts/monitor-canary.sh              # Default 5s interval
#   ./scripts/monitor-canary.sh --interval 10  # 10s interval
#

set -euo pipefail

# Configuration
INTERVAL=5
HEALTH_ENDPOINT="http://localhost:3000/health/canary"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate interval
if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [ "$INTERVAL" -lt 1 ]; then
  echo "Error: Interval must be a positive integer"
  exit 1
fi

echo -e "${GREEN}=== Phase 5 Canary Monitor ===${NC}"
echo "Interval: ${INTERVAL}s (Ctrl+C to exit)"
echo ""
echo "Press Ctrl+C to stop monitoring"
echo ""

# Check dependencies
if ! command -v curl > /dev/null 2>&1; then
  echo -e "${RED}Error: curl is required but not installed${NC}"
  exit 1
fi

HAS_JQ=false
if command -v jq > /dev/null 2>&1; then
  HAS_JQ=true
fi

# Main monitoring loop
while true; do
  # Clear screen
  clear

  # Header
  echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║          Phase 5 Canary Monitor - $(date +'%H:%M:%S')          ║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # Fetch canary status
  STATUS=$(curl -s "$HEALTH_ENDPOINT" 2>/dev/null || echo "{}")

  if [ "$HAS_JQ" = true ] && [ -n "$STATUS" ] && [ "$STATUS" != "{}" ]; then
    # Parse with jq
    ROLLOUT=$(echo "$STATUS" | jq -r '.rolloutPercentage // "N/A"')
    ENABLED=$(echo "$STATUS" | jq -r '.enabled // "N/A"')

    # Baseline metrics
    B_REQUESTS=$(echo "$STATUS" | jq -r '.baseline.requestCount // 0')
    B_ERROR_RATE=$(echo "$STATUS" | jq -r '.baseline.errorRate // 0')
    B_P95=$(echo "$STATUS" | jq -r '.baseline.latency.p95 // 0')
    B_CPU=$(echo "$STATUS" | jq -r '.baseline.resources.cpuPercent // 0')
    B_MEMORY=$(echo "$STATUS" | jq -r '.baseline.resources.memoryMB // 0')

    # Canary metrics
    C_REQUESTS=$(echo "$STATUS" | jq -r '.canary.requestCount // 0')
    C_ERROR_RATE=$(echo "$STATUS" | jq -r '.canary.errorRate // 0')
    C_P95=$(echo "$STATUS" | jq -r '.canary.latency.p95 // 0')
    C_CPU=$(echo "$STATUS" | jq -r '.canary.resources.cpuPercent // 0')
    C_MEMORY=$(echo "$STATUS" | jq -r '.canary.resources.memoryMB // 0')

    # Deltas
    ERROR_DELTA=$(echo "$STATUS" | jq -r '.deltas.errorRateDelta // 0')
    LATENCY_DELTA=$(echo "$STATUS" | jq -r '.deltas.p95LatencyDelta // 0')
    LATENCY_DELTA_PCT=$(echo "$STATUS" | jq -r '.deltas.p95LatencyDeltaPercent // 0')

    # Health
    HEALTH_STATUS=$(echo "$STATUS" | jq -r '.health.status // "unknown"')
    HEALTH_ISSUES=$(echo "$STATUS" | jq -r '.health.issues // [] | length')

    # Display rollout status
    echo -e "${BLUE}Rollout Status:${NC}"
    echo "  Enabled: $ENABLED"
    echo "  Percentage: ${ROLLOUT}%"
    echo ""

    # Display baseline metrics
    echo -e "${BLUE}Baseline (99%):${NC}"
    printf "  Requests:   %10d\n" "$B_REQUESTS"
    printf "  Error Rate: %9.2f%%\n" "$(echo "$B_ERROR_RATE * 100" | bc -l 2>/dev/null || echo "$B_ERROR_RATE")"
    printf "  P95 Latency:%9.0fms\n" "$B_P95"
    printf "  CPU:        %9.0f%%\n" "$B_CPU"
    printf "  Memory:     %9.0fMB\n" "$B_MEMORY"
    echo ""

    # Display canary metrics
    echo -e "${BLUE}Canary (1%):${NC}"
    printf "  Requests:   %10d\n" "$C_REQUESTS"
    printf "  Error Rate: %9.2f%%\n" "$(echo "$C_ERROR_RATE * 100" | bc -l 2>/dev/null || echo "$C_ERROR_RATE")"
    printf "  P95 Latency:%9.0fms\n" "$C_P95"
    printf "  CPU:        %9.0f%%\n" "$C_CPU"
    printf "  Memory:     %9.0fMB\n" "$C_MEMORY"
    echo ""

    # Display deltas
    echo -e "${BLUE}Deltas (Canary - Baseline):${NC}"
    printf "  Error Rate: %+9.3f%%\n" "$(echo "$ERROR_DELTA * 100" | bc -l 2>/dev/null || echo "$ERROR_DELTA")"
    printf "  P95 Latency:%+9.0fms (%+.1f%%)\n" "$LATENCY_DELTA" "$LATENCY_DELTA_PCT"
    echo ""

    # Display health status
    echo -e "${BLUE}Health:${NC}"

    case "$HEALTH_STATUS" in
      healthy)
        echo -e "  Status: ${GREEN}HEALTHY${NC}"
        ;;
      degraded)
        echo -e "  Status: ${YELLOW}DEGRADED${NC}"
        ;;
      critical)
        echo -e "  Status: ${RED}CRITICAL${NC}"
        ;;
      *)
        echo "  Status: ${HEALTH_STATUS}"
        ;;
    esac

    echo "  Issues: $HEALTH_ISSUES"

    # Show issues if any
    if [ "$HEALTH_ISSUES" -gt 0 ]; then
      echo ""
      echo -e "${RED}Issues:${NC}"
      echo "$STATUS" | jq -r '.health.issues[] | "  - " + .'
    fi

    # Show recommendations
    RECOMMENDATIONS=$(echo "$STATUS" | jq -r '.health.recommendations // [] | length')
    if [ "$RECOMMENDATIONS" -gt 0 ]; then
      echo ""
      echo -e "${YELLOW}Recommendations:${NC}"
      echo "$STATUS" | jq -r '.health.recommendations[] | "  - " + .'
    fi

  else
    # Fallback: display raw JSON or error
    if [ -n "$STATUS" ] && [ "$STATUS" != "{}" ]; then
      echo "$STATUS"
    else
      echo -e "${RED}Error: Could not connect to $HEALTH_ENDPOINT${NC}"
      echo ""
      echo "Make sure mlx-serving is running."
    fi
  fi

  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo "Next update in ${INTERVAL}s... (Ctrl+C to exit)"

  # Sleep
  sleep "$INTERVAL"
done
