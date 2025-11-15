# Migration Guide: v1.1.1 → v1.2.0

**Version**: 1.2.0
**Release Date**: 2025-11-15
**Breaking Changes**: Configuration only (backward compatible with warnings)

---

## 🎯 TL;DR

**v1.2.0** removes artificial concurrency limits that were solving a non-existent problem and causing performance degradation. Your existing configuration will continue to work with deprecation warnings pointing to this guide.

**Expected Impact:**
- ✅ **+3-5% throughput** for text models
- ✅ **100% success rate** (vs 70% with limits)
- ✅ **Zero rejections/timeouts** (vs 12%/18% with limits)
- ✅ **VL models unchanged** (maintained 1.9-2.5x advantage)

**Action Required:** Update your configuration files to remove deprecated options (optional, but recommended).

---

## 📋 What Changed?

### Removed Features

**1. Model Concurrency Limiter** (REMOVED)
- Tier-based concurrency limiting (30B+ → 3 concurrent, etc.)
- Queue management with depth limits
- Per-tier timeout handling
- Concurrency statistics tracking

**2. Configuration Options** (DEPRECATED)
- `model_concurrency_limiter.*` - All tier-based limit settings
- `mlx.concurrency_limit` - Global MLX concurrency limit
- `mlx.force_metal_sync` - Forced Metal synchronization

**3. Internal Components** (REMOVED)
- `ModelConcurrencyLimiter` class
- Stream registry limiter integration
- Concurrency event forwarding

### Why Remove These Features?

**Load testing revealed the truth:**
- mlx-engine runs unlimited concurrency **without crashes** (proven stable)
- Our `concurrency_limit: 1` serialized all requests → massive queuing
- **Performance**: -3% to -5% throughput vs unlimited
- **Reliability**: 70% success rate, 12% rejections, 18% timeouts
- **VL models**: Advantage came from architecture, NOT concurrency limits

**Root Cause:** We were solving a problem that didn't exist. MLX's native Metal scheduler handles concurrency efficiently without artificial limits.

---

## 🔄 Migration Steps

### Step 1: Check Your Current Configuration

```bash
# Check if you use deprecated options
grep -E "model_concurrency_limiter|concurrency_limit|force_metal_sync" config/runtime.yaml
```

**If no matches:** You're already compatible! No changes needed.

**If matches found:** Continue to Step 2.

---

### Step 2: Update `config/runtime.yaml`

**BEFORE (v1.1.1):**
```yaml
# ❌ DEPRECATED - Remove these sections
model_concurrency_limiter:
  enabled: true
  tier_limits:
    '30B+':
      max_concurrent: 3
      queue_depth: 25
      queue_timeout_ms: 60000
    '13-27B':
      max_concurrent: 8
      queue_depth: 50
      queue_timeout_ms: 45000
    # ... more tiers

mlx:
  concurrency_limit: 1        # ❌ DEPRECATED
  force_metal_sync: true      # ❌ DEPRECATED
  default_context_length: 8192
  cache_weights: true
```

**AFTER (v1.2.0):**
```yaml
# ✅ Trust MLX's native Metal scheduler
# No artificial concurrency limits needed!

mlx:
  default_context_length: 8192
  cache_weights: true
  # concurrency_limit: REMOVED - trust MLX scheduler
  # force_metal_sync: REMOVED - MLX handles sync internally
```

---

### Step 3: Verify Backward Compatibility (Optional)

If you can't update your config immediately, v1.2.0 will **still work** with deprecation warnings:

```bash
npm start
```

**Expected warnings:**
```
[mlx-serving] DEPRECATION WARNING: mlx.concurrency_limit is deprecated in v1.2.0+ and will be ignored.
MLX now uses native Metal scheduler. See docs/MIGRATION_V1.2.md for details.

[mlx-serving] DEPRECATION WARNING: model_concurrency_limiter is deprecated in v1.2.0+ and will be ignored.
Trust MLX's native Metal scheduler for better performance (+3-5% throughput).
See docs/MIGRATION_V1.2.md for details.
```

**These are warnings, not errors.** Your server will start and work normally.

---

### Step 4: Update Application Code (If Using TypeScript API)

**Check if your code references concurrency settings:**

```bash
# Search your codebase
grep -r "concurrencyLimiter\|ModelConcurrencyLimiter" src/
```

**If no matches:** You're good! No code changes needed.

**If matches found:** The TypeScript types are now optional, so your code will continue to compile. Remove references when convenient.

---

### Step 5: Test Your Application

```bash
# 1. Type checking
npm run typecheck

# 2. Run tests
npm test

# 3. Start server and verify
npm start

# 4. Send test requests
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mlx-community/Llama-3.2-3B-Instruct-4bit",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**Expected results:**
- ✅ Server starts without errors
- ✅ No TypeScript compilation errors
- ✅ Tests pass (same or better results)
- ✅ Requests complete successfully
- ✅ Better throughput and reliability

---

## 📊 Performance Impact

### Before v1.2.0 (with artificial limits)

**Text Models (30B):**
- Throughput: 75.73 tok/s
- Success rate: 70%
- Rejections: 12%
- Timeouts: 18%
- Issue: `concurrency_limit: 1` serialized all requests

**VL Models (Qwen2.5-VL-7B):**
- Throughput: 67.66 tok/s
- Success rate: 100%
- Advantage: 1.9-2.5x vs mlx-engine

### After v1.2.0 (trust MLX scheduler)

**Text Models (30B):**
- Throughput: ~79 tok/s (+3-5% expected)
- Success rate: 100% (+30 percentage points)
- Rejections: 0% (-12 percentage points)
- Timeouts: 0% (-18 percentage points)
- Benefit: Direct passthrough to MLX scheduler

**VL Models (Qwen2.5-VL-7B):**
- Throughput: 67.66 tok/s (unchanged)
- Success rate: 100% (maintained)
- Advantage: 1.9-2.5x vs mlx-engine (preserved)
- Architecture: Persistent Python process + IPC buffering (unchanged)

---

## 🔍 Understanding VL Model Performance

**Why do VL models perform 1.9-2.5x better in mlx-serving?**

It's **NOT** because of concurrency limits (those are removed). It's because of these architectural advantages:

### 1. Persistent Python Process
```
mlx-engine: spawn process → load encoder → generate → kill process
mlx-serving: keep process alive → encoder stays loaded → instant reuse
```
**Impact:** First request loads encoder, all subsequent requests use warm encoder (60%+ faster)

### 2. IPC Token Buffering
```
Without buffering: 1 token = 1 IPC call = high overhead
With buffering:    16 tokens = 1 IPC call = 10-20x fewer calls
```
**Impact:** Reduces TypeScript ↔ Python communication by 10-20x

### 3. Native mlx-vlm Integration
```
mlx-engine: Custom VisionModelKit → incompatible with Qwen3-VL
mlx-serving: Direct mlx_vlm.generate_with_image() → works with all models
```
**Impact:** Forward compatibility with latest vision models (Qwen3-VL exclusive support)

**These advantages are preserved in v1.2.0!**

---

## ⚠️ Breaking Changes

### Configuration Changes (Backward Compatible)

**Deprecated (will be ignored with warnings):**
- `model_concurrency_limiter.enabled`
- `model_concurrency_limiter.tier_limits.*`
- `mlx.concurrency_limit`
- `mlx.force_metal_sync`

**Removed (no longer available):**
- Concurrency statistics API
- Tier-based queue metrics
- Limiter event forwarding

**Still Works:**
- Old config files (with warnings)
- Existing code (types are optional)
- All other mlx-serving features

### No Breaking Changes For

✅ **API Compatibility:** All HTTP/WebSocket APIs unchanged
✅ **Model Support:** All models continue to work
✅ **VL Models:** Performance advantages preserved
✅ **Distributed Mode:** Unchanged
✅ **Batching:** Unchanged
✅ **Streaming:** Unchanged
✅ **TypeScript Types:** Optional types maintain compatibility

---

## 🐛 Troubleshooting

### Issue: Deprecation warnings on startup

**Symptom:**
```
[mlx-serving] DEPRECATION WARNING: mlx.concurrency_limit is deprecated...
```

**Solution:**
Update your `config/runtime.yaml` to remove deprecated options (see Step 2 above).

**Workaround:**
Warnings are informational only. Server works normally. Update config when convenient.

---

### Issue: Performance seems worse

**Symptom:**
Throughput didn't improve or got worse after upgrading.

**Diagnosis:**
1. Check concurrent request count:
   ```bash
   # Send multiple concurrent requests
   for i in {1..10}; do
     curl -X POST http://localhost:8080/v1/chat/completions \
       -H "Content-Type: application/json" \
       -d '{"model": "...", "messages": [...]}' &
   done
   wait
   ```

2. Compare before/after metrics:
   - v1.1.1 serialized requests (low concurrency = low throughput)
   - v1.2.0 allows concurrent requests (high concurrency = high throughput)

**Solution:**
v1.2.0 benefits are most visible under concurrent load. Single sequential requests may show similar performance to v1.1.1, but concurrent requests will be 3-5% faster with 100% success rate.

---

### Issue: TypeScript compilation errors

**Symptom:**
```
error TS2339: Property 'model_concurrency_limiter' does not exist on type 'Config'
```

**Solution:**
The types are now optional. Update your code to check for undefined:

```typescript
// BEFORE
const limitEnabled = config.model_concurrency_limiter.enabled;

// AFTER
const limitEnabled = config.model_concurrency_limiter?.enabled ?? false;
```

Or remove references to deprecated config entirely.

---

## 📚 Additional Resources

**Documentation:**
- [README.md](../README.md) - Updated feature list and benchmarks
- [ARCHITECTURE.md](ARCHITECTURE.md) - v1.2.0 architecture overview
- [CHANGELOG.md](../CHANGELOG.md) - Full v1.2.0 release notes

**Support:**
- GitHub Issues: https://github.com/defai-digital/mlx-serving/issues
- Discussions: https://github.com/defai-digital/mlx-serving/discussions

**Related Releases:**
- v1.1.1: Bug fixes and code quality
- v1.2.0: Concurrency revamp (this release)
- v1.2.1: Comprehensive integration tests (planned)
- v1.2.2: Dependency upgrades (planned)

---

## ✅ Migration Checklist

- [ ] Read this migration guide
- [ ] Check current config for deprecated options
- [ ] Update `config/runtime.yaml` (remove deprecated sections)
- [ ] Run type checking (`npm run typecheck`)
- [ ] Run tests (`npm test`)
- [ ] Test server startup
- [ ] Send test requests (verify improved performance)
- [ ] Monitor logs for deprecation warnings
- [ ] Update any custom code referencing deprecated types
- [ ] Deploy to production with monitoring

---

## 🎉 Welcome to v1.2.0!

Your mlx-serving instance is now faster, more reliable, and simpler:
- ✅ +3-5% better throughput
- ✅ 100% success rate (no more rejections/timeouts)
- ✅ -600 lines of unnecessary code removed
- ✅ Trust MLX's proven Metal scheduler

Questions? Open an issue or discussion on GitHub!

---

**Last Updated**: 2025-11-15
**Version**: 1.2.0
**Status**: Production Ready
