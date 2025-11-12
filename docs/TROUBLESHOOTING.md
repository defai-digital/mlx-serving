# Troubleshooting Guide

**Common issues and solutions for mlx-serving**

---

## Table of Contents

1. [Installation Issues](#installation-issues)
2. [Runtime Errors](#runtime-errors)
3. [Performance Issues](#performance-issues)
4. [Week 7 Optimization Issues](#week-7-optimization-issues)
5. [Production Feature Issues](#production-feature-issues)
6. [Model Loading Issues](#model-loading-issues)
7. [Configuration Issues](#configuration-issues)
8. [Getting Help](#getting-help)

---

## Installation Issues

### Issue: "Platform not supported" error

**Symptoms**:
```
Error: mlx-serving requires Apple Silicon (M3+) hardware
Platform check failed: darwin/arm64 required
```

**Diagnosis**:
```bash
# Check platform
uname -sm
# Should output: Darwin arm64

# Check macOS version
sw_vers
# Should be: 26.0+ (Darwin 25.0.0+)

# Check CPU
sysctl machdep.cpu.brand_string
# Should show: Apple M3 (or newer)
```

**Solution**:
- mlx-serving requires **Apple Silicon M3 or newer**
- macOS 26.0+ (Darwin 25.0.0+) is required
- M1/M2 are **not supported** (Metal 3.3+ required)

---

### Issue: Python setup fails

**Symptoms**:
```
npm run setup fails with "Python module not found"
```

**Diagnosis**:
```bash
# Check Python version
python3 --version
# Should be: Python 3.11.x or 3.12.x

# Check if venv exists
ls -la .kr-mlx-venv/
# Should show virtual environment directory

# Try manual setup
python3 -m venv .kr-mlx-venv
source .kr-mlx-venv/bin/activate
pip install -r python/requirements.txt
```

**Solution**:
```bash
# Remove existing venv
rm -rf .kr-mlx-venv

# Run setup again
npm run setup

# Verify installation
.kr-mlx-venv/bin/python -c "import mlx; print(mlx.__version__)"
```

---

### Issue: npm install fails

**Symptoms**:
```
npm install hangs or fails with timeout
```

**Diagnosis**:
```bash
# Check Node.js version
node --version
# Should be: v22.0.0 or higher

# Check npm version
npm --version
# Should be: 10.0.0 or higher
```

**Solution**:
```bash
# Update Node.js to 22.0.0+
# Then:
npm cache clean --force
npm install
```

---

## Runtime Errors

### Issue: "Engine failed to initialize"

**Symptoms**:
```typescript
const engine = await createEngine();
// Error: Python runtime failed to start
```

**Diagnosis**:
```bash
# Test Python runtime directly
echo '{"jsonrpc":"2.0","id":1,"method":"runtime/info"}' | \
  PYTHONPATH=./python .kr-mlx-venv/bin/python python/runtime.py

# Should output: {"jsonrpc":"2.0","id":1,"result":{...}}
```

**Solution**:
```typescript
// Enable verbose logging
const engine = await createEngine({ verbose: true });

// Monitor Python stderr
engine.on('stderr', (data) => console.error('[Python]', data));

// Check for specific error messages in logs
```

---

### Issue: "Model not found" error

**Symptoms**:
```
Error: Model 'mlx-community/Llama-3.2-3B-Instruct-4bit' not found
```

**Diagnosis**:
```bash
# Check HuggingFace cache
ls ~/.cache/huggingface/hub/

# Check model download
ls ~/.cache/huggingface/hub/models--mlx-community--Llama-3.2-3B-Instruct-4bit/
```

**Solution**:
```typescript
// Model will auto-download on first use
// Wait for download to complete (can take 5-10 minutes)

// Check download progress:
// ls ~/.cache/huggingface/hub/

// Or manually download:
// git lfs install
// git clone https://huggingface.co/mlx-community/Llama-3.2-3B-Instruct-4bit \
//   ~/.cache/huggingface/hub/models--mlx-community--Llama-3.2-3B-Instruct-4bit
```

---

### Issue: Metal GPU error

**Symptoms**:
```
Metal GPU error: SIGTRAP or SIGABRT crash
```

**Diagnosis**:
```bash
# Check Metal version
system_profiler SPDisplaysDataType | grep Metal
# Should show: Metal 3.3 or higher

# Check model size vs available memory
sysctl hw.memsize
```

**Solution for large models (30B+)**:

Edit `config/runtime.yaml`:
```yaml
mlx:
  concurrency_limit: 1  # REQUIRED for 30B+ models
  force_metal_sync: true
```

**Solution for repeated crashes**:
```typescript
// Use smaller models for testing
model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'  // 2-3GB RAM

// Instead of:
model: 'mlx-community/Qwen2.5-32B-Instruct-4bit'  // 20-30GB RAM
```

---

### Issue: "JSON-RPC timeout"

**Symptoms**:
```
Error: Request timeout after 30000ms
```

**Diagnosis**:
```typescript
// Enable verbose logging
const engine = await createEngine({ verbose: true });

// Check if Python runtime is responsive
const info = engine.getInfo();
console.log('Status:', info.status, 'PID:', info.pid);
```

**Solution**:

Edit `config/runtime.yaml`:
```yaml
# Increase timeouts for large models
timeouts:
  generate: 120000   # 2 minutes (default: 30s)
  loadModel: 180000  # 3 minutes (default: 60s)
```

---

## Performance Issues

### Issue: Slow first request (5+ seconds)

**Symptoms**:
- First request takes 5-10 seconds
- Subsequent requests are fast

**Diagnosis**:
```bash
# Check if model preloading is enabled
grep -A5 "model_preload:" config/runtime.yaml
```

**Solution**:

Enable model preloading in `config/runtime.yaml`:
```yaml
model_preload:
  enabled: true
  models:
    - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"
      warmup_requests: 3
      max_tokens: 10
```

**Result**: First request: 5,200ms → 50ms (104x faster)

---

### Issue: Low throughput

**Symptoms**:
- Throughput < 20 tok/s on M3 Pro/Max
- Expected: 50-80 tok/s for small models

**Diagnosis**:
```typescript
// Check batch queue stats
const stats = engine.getBatchQueueStats();
console.log({
  enabled: stats.enabled,
  avgBatchSize: stats.avgBatchSize,
  throughput: stats.throughput,
});
```

**Solution**:

Enable adaptive batching in `config/runtime.yaml`:
```yaml
batch_queue:
  enabled: true
  adaptive_sizing: true
  target_latency_ms: 100
  min_batch_size: 1
  max_batch_size: 8
```

**Result**: 10-15% throughput improvement

---

### Issue: High memory usage / frequent GC

**Symptoms**:
- High memory usage (> 50GB for small models)
- Frequent garbage collection pauses

**Diagnosis**:
```bash
# Monitor memory usage
top -pid $(pgrep -f "python.*runtime.py")

# Check object pool stats
# (in TypeScript code)
const stats = objectPool.getStats();
console.log('Hit rate:', stats.hitRate);
```

**Solution**:

Object pooling is enabled by default in Week 7. Verify configuration:

```typescript
// Check pool usage
const pool = new ObjectPool<MyObject>(
  () => createObject(),
  (obj) => resetObject(obj),
  { maxSize: 100, preallocate: 10 }  // Increase if needed
);
```

**Result**: 20% GC reduction

---

### Issue: Slow JSON serialization

**Symptoms**:
- High CPU usage during streaming
- Slow chunk delivery

**Solution**:

FastJsonCodec is enabled by default in Week 7. No configuration needed.

If you disabled it, re-enable in `src/bridge/jsonrpc-transport.ts`:
```typescript
import { FastJsonCodec } from './serializers.js';

// Use FastJsonCodec instead of JSON.stringify/parse
const codec = new FastJsonCodec();
```

**Result**: 2-3x faster JSON serialization

---

## Week 7 Optimization Issues

### Issue: Model preloading not working

**Symptoms**:
- First request still slow (5+ seconds)
- Preload configuration ignored

**Diagnosis**:
```typescript
// Check preload stats
const stats = engine.getPreloadStats();
console.log('Preloaded models:', stats.preloadedModels.length);
```

**Solution**:
1. Check `config/runtime.yaml`:
   ```yaml
   model_preload:
     enabled: true  # Must be true
   ```

2. Verify model_id matches exactly:
   ```yaml
   models:
     - model_id: "mlx-community/Llama-3.2-3B-Instruct-4bit"  # Exact match required
   ```

3. Check logs for preload errors:
   ```typescript
   const engine = await createEngine({ verbose: true });
   ```

---

### Issue: Object pool not reducing GC

**Symptoms**:
- Still seeing high GC pressure
- Pool hit rate < 50%

**Diagnosis**:
```typescript
const stats = pool.getStats();
console.log({
  hitRate: stats.hitRate,
  totalCreated: stats.totalCreated,
  reuseCount: stats.reuseCount,
});
```

**Solution**:
1. Increase pool size:
   ```typescript
   const pool = new ObjectPool<T>(factory, reset, {
     maxSize: 200,  // Increase from default 100
     preallocate: 50,  // Preallocate more objects
   });
   ```

2. Verify reset function clears all state:
   ```typescript
   function resetObject(obj: MyObject): void {
     obj.field1 = null;
     obj.field2 = '';
     // Clear ALL fields
   }
   ```

---

### Issue: Adaptive batching not improving throughput

**Symptoms**:
- No throughput gain with batching enabled
- Batch size always 1

**Diagnosis**:
```typescript
const stats = engine.getBatchQueueStats();
console.log({
  avgBatchSize: stats.avgBatchSize,  // Should be > 1
  throughput: stats.throughput,
});
```

**Solution**:
1. Batching requires concurrent requests:
   ```typescript
   // Send multiple requests concurrently
   const promises = [
     engine.generate({ prompt: 'Q1' }),
     engine.generate({ prompt: 'Q2' }),
     engine.generate({ prompt: 'Q3' }),
   ];
   await Promise.all(promises);
   ```

2. Adjust target latency:
   ```yaml
   batch_queue:
     target_latency_ms: 150  # Increase if avg batch size is too low
   ```

---

## Production Feature Issues

### Issue: QoS violations not triggering remediation

**Symptoms**:
- SLO violations detected but no remediation actions
- Dry-run mode active

**Diagnosis**:
```typescript
const qosStats = engine.getQosStats();
console.log({
  violations: qosStats.violations,
  remediations: qosStats.remediations,
  dryRun: qosStats.dryRun,
});
```

**Solution**:

Edit `config/runtime.yaml`:
```yaml
qos_monitor:
  executor:
    dry_run: false  # Must be false for real remediation
```

---

### Issue: Canary not receiving traffic

**Symptoms**:
- 10% rollout configured but no traffic to canary
- All requests go to baseline

**Diagnosis**:
```typescript
const canaryStats = engine.getCanaryStats();
console.log({
  totalRequests: canaryStats.totalRequests,
  canaryRequests: canaryStats.canaryRequests,
  actualPercentage: canaryStats.actualPercentage,
});
```

**Solution**:

Edit `config/feature-flags.yaml`:
```yaml
canary:
  enabled: true           # Must be true
  rolloutPercentage: 10   # Must be > 0
  hash_seed: "canary-2025-01-08"  # Must be present
```

---

### Issue: Feature flag not enabling

**Symptoms**:
- Feature always disabled despite configuration
- isEnabled() always returns false

**Diagnosis**:
```typescript
const config = loader.getConfig('ttft_pipeline');
console.log({
  enabled: config.enabled,
  percentage: config.rollout_percentage,
  hashSeed: config.hash_seed,
});
```

**Solution**:

Edit `config/feature-flags.yaml`:
```yaml
ttft_pipeline:
  enabled: true           # Must be true
  rollout_percentage: 10  # Must be > 0
  hash_seed: "valid-seed" # Must be present

# Check emergency kill switch
emergency:
  kill_switch: false  # Must be false
```

---

### Issue: Inconsistent feature flag routing

**Symptoms**:
- Same key getting different results
- Non-deterministic routing

**Diagnosis**:
```typescript
// Test consistency
const key = 'user-123';
const results = [];
for (let i = 0; i < 10; i++) {
  results.push(loader.isEnabled('ttft_pipeline', key));
}
console.log('Consistent:', results.every(r => r === results[0]));
```

**Solution**:
1. Use hash strategy (not random):
   ```yaml
   ttft_pipeline:
     strategy: hash  # Use hash, not random
   ```

2. Don't change hash seed:
   ```yaml
   hash_seed: "ttft-2025"  # Keep seed constant
   ```

---

## Model Loading Issues

### Issue: Model download stalls

**Symptoms**:
- Model download starts but never completes
- Hangs at 50-80% progress

**Diagnosis**:
```bash
# Check download progress
ls -lh ~/.cache/huggingface/hub/models--mlx-community--*/

# Check network connection
ping huggingface.co
```

**Solution**:
```bash
# Remove incomplete download
rm -rf ~/.cache/huggingface/hub/models--mlx-community--*

# Try manual download with git
git lfs install
cd ~/.cache/huggingface/hub/
git clone https://huggingface.co/mlx-community/Llama-3.2-3B-Instruct-4bit \
  models--mlx-community--Llama-3.2-3B-Instruct-4bit
```

---

### Issue: Vision model not loading

**Symptoms**:
```
Error: Vision model support not available
```

**Diagnosis**:
```bash
# Check mlx-vlm installation
.kr-mlx-venv/bin/python -c "import mlx_vlm; print(mlx_vlm.__version__)"
```

**Solution**:
```bash
# Reinstall mlx-vlm
source .kr-mlx-venv/bin/activate
pip install --upgrade mlx-vlm
```

---

### Issue: Structured output not working

**Symptoms**:
- Model ignores JSON schema
- Output not valid JSON

**Diagnosis**:
```bash
# Check Outlines installation
.kr-mlx-venv/bin/python -c "import outlines; print(outlines.__version__)"
```

**Solution**:
1. Use simpler schema:
   ```typescript
   // Too complex
   const schema = { /* 100+ properties */ };

   // Better
   const schema = {
     type: "object",
     properties: {
       name: { type: "string" },
       age: { type: "integer" },
     },
   };
   ```

2. Use stronger prompts:
   ```typescript
   prompt: "Generate valid JSON matching this schema: {...}"
   ```

---

## Configuration Issues

### Issue: Configuration not reloading

**Symptoms**:
- Changed `runtime.yaml` but no effect
- Old configuration still active

**Diagnosis**:
```bash
# Check if file was saved
cat config/runtime.yaml | grep "model_preload"

# Check for YAML syntax errors
npx js-yaml config/runtime.yaml
```

**Solution**:
1. Restart engine:
   ```typescript
   await engine.close();
   const engine = await createEngine();  // Reloads config
   ```

2. Or send SIGHUP (for feature flags):
   ```bash
   kill -HUP $(cat /var/run/mlx-serving.pid)
   ```

---

### Issue: Invalid YAML syntax

**Symptoms**:
```
Error: Invalid YAML in config/runtime.yaml
```

**Diagnosis**:
```bash
# Validate YAML
npx js-yaml config/runtime.yaml
# Or:
python3 -c "import yaml; yaml.safe_load(open('config/runtime.yaml'))"
```

**Solution**:
- Fix indentation (2 spaces, no tabs)
- Quote strings with special characters
- Check for missing colons

---

## Getting Help

### Self-Diagnosis

Before asking for help, collect this information:

```bash
# System information
uname -sm
sw_vers
sysctl machdep.cpu.brand_string

# Node.js and npm versions
node --version
npm --version

# Python version
.kr-mlx-venv/bin/python --version

# MLX version
.kr-mlx-venv/bin/python -c "import mlx; print(mlx.__version__)"

# Package version
npm list @defai.digital/mlx-serving

# Recent error logs
# (enable verbose mode in engine)
```

### Documentation

- **[Quick Start](./QUICK_START.md)** - 5-minute getting started
- **[Performance Guide](./PERFORMANCE.md)** - Week 7 optimizations
- **[Production Features](./PRODUCTION_FEATURES.md)** - Enterprise features
- **[Feature Flags](./FEATURE_FLAGS.md)** - Feature flag system
- **[Full Documentation](./INDEX.md)** - Documentation hub

### Examples

- [Performance Examples](../examples/performance/) - Week 7 optimization examples
- [Production Examples](../examples/production/) - Enterprise feature examples

### Community Support

- **Issues**: [GitHub Issues](https://github.com/defai-digital/mlx-serving/issues)
- **Discussions**: [GitHub Discussions](https://github.com/defai-digital/mlx-serving/discussions)

### Filing a Bug Report

Include:
1. System information (see Self-Diagnosis above)
2. Minimal reproduction code
3. Expected behavior vs actual behavior
4. Full error message and stack trace
5. Configuration files (runtime.yaml, feature-flags.yaml)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Maintained By**: mlx-serving Team
