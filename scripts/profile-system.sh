#!/bin/bash
# Profile mlx-serving to identify actual bottlenecks

set -e

echo "╔═══════════════════════════════════════╗"
echo "║  Profiling mlx-serving               ║"
echo "╚═══════════════════════════════════════╝"
echo

# 1. Python profiling
echo "1. Python Runtime Profiling (cProfile)..."
echo "   Running 10 requests with profiling..."

.mlx-serving-venv/bin/python -m cProfile -o /tmp/kr-serve-profile.stats python/runtime.py &
PID=$!
sleep 2

# Send test requests
for i in {1..10}; do
    echo '{"jsonrpc":"2.0","id":'$i',"method":"runtime/info"}' | .mlx-serving-venv/bin/python python/runtime.py > /dev/null 2>&1 || true
done

kill $PID 2>/dev/null || true

echo "   ✅ Profile saved to /tmp/kr-serve-profile.stats"
echo

# 2. Analyze profile
echo "2. Top 20 time-consuming functions:"
.mlx-serving-venv/bin/python -c "
import pstats
p = pstats.Stats('/tmp/kr-serve-profile.stats')
p.strip_dirs().sort_stats('cumulative').print_stats(20)
" 2>/dev/null || echo "   (Profile data not available)"

echo
echo "═══ Profiling Complete ═══"
echo
echo "Next steps:"
echo "1. Review profile: python3 -m pstats /tmp/kr-serve-profile.stats"
echo "2. Focus C++ optimization on top functions"
echo "3. Re-benchmark after optimization"
