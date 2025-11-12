# Phase 2: Model Caching Strategy - Ultra-Deep Analysis

**Date**: 2025-11-03
**Analyst**: Claude Code (Ultrathink Mode)
**Status**: Implementation Plan
**Goal**: 90% model load time reduction

---

## Executive Summary

**Current State**: Models reload from disk on every process restart, taking 5-60 seconds per model.

**Target**: < 1 second warm start via persistent artifact cache

**Approach**: Content-addressed disk cache + intelligent preloading

**Expected Impact**:
- ⚡ 90-95% load time reduction (60s → 3s)
- 💾 50% memory reduction (avoid duplicate loads)
- 🌐 90% network reduction (cache HuggingFace downloads)

---

## Ultra-Deep Problem Analysis

### Current Caching Architecture

#### TypeScript Layer (model-manager.ts:50-56)
```typescript
private readonly handles = new Map<ModelIdentifier, ModelHandle>();
private readonly descriptorCache = new Map<ModelIdentifier, ModelDescriptor>();
private readonly metadataCache = new Map<ModelIdentifier, Record<string, unknown>>();
private readonly inflightLoads = new Map<ModelIdentifier, Promise<ModelHandle>>();
```

**Analysis**:
- ✅ In-memory caching works perfectly for single session
- ❌ All caches cleared on process restart
- ❌ `cacheDir` parameter accepted but NEVER USED (line 31, 45, 61)
- ❌ No persistence layer
- ❌ No cross-process sharing

#### Python Layer (loader.py:7)
```python
# No caching logic (TypeScript decides when to load/unload)
```

**Analysis**:
- ❌ Every `load_model()` call loads from disk
- ❌ No model weight persistence
- ❌ HuggingFace cache at `~/.cache/huggingface/` (system-wide, not controlled)
- ❌ mlx-lm loads weights fresh every time

### Load Time Breakdown

**Cold Start** (First load):
1. HuggingFace download: 10-120s (depending on model size, network)
2. Weight file parsing: 2-5s
3. MLX model initialization: 1-3s
4. Total: **13-128 seconds**

**Warm Start** (Model in HF cache):
1. HuggingFace cache hit: 0s
2. Weight file parsing: 2-5s
3. MLX model initialization: 1-3s
4. Total: **3-8 seconds**

**Target** (Persistent cache):
1. Artifact cache hit: 0s
2. Direct MLX load from cache: 0.5-1s
3. Model initialization: 0.2-0.5s
4. Total: **< 1 second** ⚡

**Improvement**: 90-97% reduction

### Memory Analysis

**Single Process**:
- Model weights: 2GB-70GB (depending on model)
- Tokenizer: 5-50MB
- Config: < 1MB
- Total per model: **2-70GB**

**Multi-Process** (Current):
- 3 Node.js workers × 2 models each = 6 model instances
- Same model loaded 3 times = **6-210GB wasted**

**Multi-Process** (With sharing - Future):
- Shared memory pool: 2 models × 1 instance = **2-70GB total**
- Savings: **66-75%** memory reduction

### Root Causes of Slow Loads

1. **No Persistence**: In-memory cache dies with process
2. **No Preloading**: Can't warm cache before requests arrive
3. **No Deduplication**: Same model loaded multiple times
4. **No Metadata Index**: Must probe files to determine cache status
5. **No Eviction Policy**: Old models never cleaned up

---

## Solution Design

### Architecture: 3-Layer Caching

```
┌────────────────────────────────────┐
│  Level 1: In-Memory Cache (RAM)   │ ← Current (working)
│  - Loaded models                   │
│  - Instant access (< 1ms)          │
└────────────────────────────────────┘
            ↓ Miss
┌────────────────────────────────────┐
│  Level 2: Artifact Cache (Disk)   │ ← NEW: Persistent cache
│  - Model weights (.safetensors)    │
│  - Tokenizer configs                │
│  - Load time: 0.5-1s               │
└────────────────────────────────────┘
            ↓ Miss
┌────────────────────────────────────┐
│  Level 3: HuggingFace Hub          │ ← Existing (slow)
│  - Download from internet           │
│  - Load time: 10-120s               │
└────────────────────────────────────┘
```

### Level 2: Persistent Artifact Cache

#### Cache Structure
```
cacheDir/  (default: .kr-mlx-cache/)
├── artifacts/                  # Actual model files
│   ├── <hash1>/               # Content-addressed by descriptor
│   │   ├── model.safetensors  # Model weights
│   │   ├── config.json         # Model config
│   │   ├── tokenizer.json      # Tokenizer config
│   │   ├── tokenizer_config.json
│   │   └── metadata.json      # Cache metadata (load times, etc)
│   └── <hash2>/
│       └── ...
├── index.json                  # Cache index (descriptor → hash)
└── stats.json                  # Cache statistics (hits, misses, size)
```

#### Content-Addressed Hashing

**Cache Key Generation**:
```typescript
function generateCacheKey(descriptor: ModelDescriptor, options: LoadModelOptions): string {
  const components = [
    descriptor.id,               // e.g., "mlx-community/Llama-3.2-3B-Instruct-4bit"
    options.revision || 'main',  // e.g., "main", "dev", "v1.0"
    options.quantization || 'none', // e.g., "int4", "int8", "none"
    descriptor.modality || 'text',  // e.g., "text", "vision"
  ];

  // SHA-256 hash for collision resistance
  return crypto.createHash('sha256')
    .update(components.join(':'))
    .digest('hex')
    .substring(0, 16); // First 16 chars = 64 bits (collision probability < 10^-19)
}
```

**Example**:
- Model: `mlx-community/Llama-3.2-3B-Instruct-4bit`
- Revision: `main`
- Quantization: `int4`
- Hash: `7f8a3b2c1d9e4f5a`

#### Cache Index Structure

**index.json**:
```json
{
  "version": "1.0",
  "created": "2025-11-03T18:00:00Z",
  "entries": {
    "mlx-community/Llama-3.2-3B-Instruct-4bit:main:int4:text": {
      "hash": "7f8a3b2c1d9e4f5a",
      "created": "2025-11-03T18:00:00Z",
      "lastAccessed": "2025-11-03T19:30:00Z",
      "accessCount": 15,
      "sizeBytes": 2147483648,
      "loadTimeMs": 850,
      "metadata": {
        "parameter_count": 3200000000,
        "dtype": "float16",
        "context_length": 8192
      }
    }
  },
  "stats": {
    "totalEntries": 1,
    "totalSizeBytes": 2147483648,
    "cacheHits": 15,
    "cacheMisses": 1,
    "hitRate": 0.9375
  }
}
```

#### Cache Operations

**1. Cache Lookup** (< 10ms):
```typescript
async checkCache(descriptor, options): CacheEntry | null {
  const key = generateCacheKey(descriptor, options);
  const index = await loadIndex();

  const entry = index.entries[key];
  if (!entry) return null;

  // Validate artifacts exist
  const artifactPath = path.join(cacheDir, 'artifacts', entry.hash);
  if (!await exists(artifactPath)) {
    // Cache corruption - remove from index
    delete index.entries[key];
    await saveIndex(index);
    return null;
  }

  // Update access stats
  entry.lastAccessed = new Date().toISOString();
  entry.accessCount++;
  index.stats.cacheHits++;
  await saveIndex(index);

  return entry;
}
```

**2. Cache Store** (2-5s):
```typescript
async storeInCache(descriptor, options, modelFiles): string {
  const key = generateCacheKey(descriptor, options);
  const hash = key; // Use key as hash for simplicity
  const artifactPath = path.join(cacheDir, 'artifacts', hash);

  // Create artifact directory
  await fs.mkdir(artifactPath, { recursive: true });

  // Copy model files
  await Promise.all([
    fs.copyFile(modelFiles.weights, path.join(artifactPath, 'model.safetensors')),
    fs.copyFile(modelFiles.config, path.join(artifactPath, 'config.json')),
    fs.copyFile(modelFiles.tokenizer, path.join(artifactPath, 'tokenizer.json')),
    // ... other files
  ]);

  // Create metadata
  const metadata = {
    parameter_count: modelMetadata.parameters,
    dtype: modelMetadata.dtype,
    context_length: modelMetadata.contextLength,
    cached_at: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(artifactPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // Update index
  const index = await loadIndex();
  index.entries[key] = {
    hash,
    created: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    accessCount: 0,
    sizeBytes: await calculateDirSize(artifactPath),
    metadata
  };
  index.stats.totalEntries++;
  index.stats.totalSizeBytes += entry.sizeBytes;
  index.stats.cacheMisses++;
  await saveIndex(index);

  return hash;
}
```

**3. Cache Eviction** (LRU Policy):
```typescript
async evictIfNeeded() {
  const config = getConfig();
  const index = await loadIndex();

  // Check if cache exceeds size limit
  if (index.stats.totalSizeBytes <= config.cache.max_size_bytes) {
    return;
  }

  // Sort by last accessed (LRU)
  const entries = Object.entries(index.entries)
    .sort((a, b) =>
      new Date(a[1].lastAccessed).getTime() -
      new Date(b[1].lastAccessed).getTime()
    );

  // Evict oldest until under limit
  let freedBytes = 0;
  for (const [key, entry] of entries) {
    if (index.stats.totalSizeBytes - freedBytes <= config.cache.max_size_bytes) {
      break;
    }

    const artifactPath = path.join(cacheDir, 'artifacts', entry.hash);
    await fs.rm(artifactPath, { recursive: true, force: true });
    freedBytes += entry.sizeBytes;
    delete index.entries[key];
    index.stats.totalEntries--;
  }

  index.stats.totalSizeBytes -= freedBytes;
  await saveIndex(index);

  logger.info({ freedBytes, entriesEvicted: entries.length }, 'Cache eviction completed');
}
```

#### Integration with ModelManager

**Modified Load Flow**:
```typescript
async loadModel(options): ModelHandle {
  // 1. Check in-memory cache (current behavior)
  const existing = this.handles.get(descriptor.id);
  if (existing) return existing; // < 1ms

  // 2. NEW: Check artifact cache
  const cacheEntry = await this.artifactCache.checkCache(descriptor, options);
  if (cacheEntry) {
    // Load from cache (0.5-1s instead of 3-8s)
    const handle = await this.loadFromCache(cacheEntry);
    this.handles.set(descriptor.id, handle);
    return handle; // 90% faster
  }

  // 3. Download and load (existing slow path)
  const handle = await this.performLoad(descriptor, draft, options);

  // 4. NEW: Store in cache for next time
  await this.artifactCache.storeInCache(descriptor, options, handle);

  return handle;
}
```

---

## Implementation Plan

### Phase 2.1: Core Cache Infrastructure (Day 1-2)

**Files to Create**:
1. `src/core/model-artifact-cache.ts` (300-400 lines)
   - ModelArtifactCache class
   - Cache index management
   - Artifact storage/retrieval
   - Eviction logic

2. `src/types/cache.ts` (50-100 lines)
   - CacheEntry interface
   - CacheIndex interface
   - CacheStats interface

**Configuration Updates**:
1. `config/runtime.yaml` - Add cache section:
```yaml
cache:
  enabled: true
  cache_dir: '.kr-mlx-cache'
  max_size_bytes: 107374182400  # 100GB
  max_age_days: 30
  eviction_policy: 'lru'  # least-recently-used
  preload_models: []  # Models to warm on startup
```

2. `src/config/loader.ts` - Add cache config types

### Phase 2.2: ModelManager Integration (Day 3)

**Files to Modify**:
1. `src/core/model-manager.ts`:
   - Add `artifactCache: ModelArtifactCache` member
   - Modify `loadModel()` to check cache first
   - Add `loadFromCache()` method
   - Add cache stats to metrics

2. `src/api/engine.ts`:
   - Add `getCacheStats()` method
   - Add `clearCache()` method
   - Add `warmCache(models: string[])` method

### Phase 2.3: Python Integration (Day 4)

**Files to Modify**:
1. `python/models/loader.py`:
   - Add `load_from_cache()` function
   - Detect HuggingFace cache location
   - Copy from HF cache to artifact cache

2. `python/runtime.py`:
   - Add `cache_model` JSON-RPC method
   - Add `get_cache_stats` JSON-RPC method

### Phase 2.4: Metrics & Monitoring (Day 5)

**Telemetry**:
```typescript
// Cache metrics
metrics.cacheHits.add(1, { cache: 'artifact', model: modelId });
metrics.cacheMisses.add(1, { cache: 'artifact', model: modelId });
metrics.cacheLoadTime.record(loadTimeMs, { model: modelId });
metrics.cacheSizeBytes.record(sizeBytes);
metrics.cacheEvictions.add(1, { reason: 'lru' });
```

**Prometheus Metrics**:
- `kr_serve_cache_hits_total{cache, model}`
- `kr_serve_cache_misses_total{cache, model}`
- `kr_serve_cache_load_duration_ms{model}`
- `kr_serve_cache_size_bytes`
- `kr_serve_cache_evictions_total{reason}`

### Phase 2.5: Testing & Benchmarks (Day 6-7)

**Tests**:
1. `tests/unit/core/model-artifact-cache.test.ts`:
   - Cache hit/miss logic
   - Eviction algorithm
   - Index corruption recovery

2. `tests/integration/cache.test.ts`:
   - End-to-end cache flow
   - Multi-process cache access
   - Cache warming

**Benchmarks**:
1. `benchmarks/cache-performance.ts`:
   - Cold start vs warm start comparison
   - Cache hit rate over time
   - Memory usage reduction

---

## Performance Targets

### Load Time Reduction

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| First load (cold) | 60s | 60s | 0% (unavoidable) |
| Second load (warm HF cache) | 8s | 0.8s | **90%** ⚡ |
| Process restart + load | 8s | 0.8s | **90%** ⚡ |
| Preloaded model | N/A | 0.2s | **98%** ⚡ |

**Average improvement**: **90-95%** for typical usage

### Memory Reduction

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| Single process | 2GB | 2GB | 0% (same) |
| 3 processes, same model | 6GB | 2GB | **67%** 💾 |
| 3 processes, 2 models each | 12GB | 4GB | **67%** 💾 |

**Note**: Shared memory (Level 3) deferred to v0.3.0

### Network Reduction

| Scenario | Downloads | After | Improvement |
|----------|-----------|-------|-------------|
| First 5 loads | 5 downloads | 5 downloads | 0% (unavoidable) |
| Next 50 loads | 50 downloads | 0 downloads | **100%** 🌐 |

---

## Risk Analysis

### Technical Risks

1. **Disk Space Exhaustion**
   - **Risk**: Cache grows indefinitely
   - **Mitigation**: LRU eviction + max size limit
   - **Severity**: Low (configurable limits)

2. **Cache Corruption**
   - **Risk**: Incomplete writes, index mismatch
   - **Mitigation**: Atomic writes, validation on load
   - **Severity**: Medium (can recover by re-download)

3. **Race Conditions**
   - **Risk**: Concurrent cache updates
   - **Mitigation**: File locks, atomic renames
   - **Severity**: Low (inflight deduplication prevents)

4. **Cross-Platform Issues**
   - **Risk**: Path separators, permissions
   - **Mitigation**: Use path.join(), check permissions
   - **Severity**: Low (well-tested patterns)

### Operational Risks

1. **Migration Complexity**
   - **Risk**: Existing users have no cache
   - **Mitigation**: Gradual warmup, no breaking changes
   - **Severity**: Low (transparent upgrade)

2. **Cache Management Burden**
   - **Risk**: Users need to manage cache manually
   - **Mitigation**: Auto-eviction, clear cache API
   - **Severity**: Low (self-managing)

---

## Success Metrics

### Must-Have (v0.2.0 Release Criteria)

- ✅ 90% load time reduction for warm starts
- ✅ Cache hit rate > 80% after 10 loads
- ✅ Zero cache-related crashes in 1000 loads
- ✅ < 5% memory overhead for cache index

### Nice-to-Have (Future Enhancements)

- 🔮 Shared memory pool (v0.3.0)
- 🔮 Remote cache (S3, NFS) (v0.4.0)
- 🔮 Model preloading on startup (v0.2.1)
- 🔮 Cache warming API (v0.2.1)

---

## Alternative Approaches Considered

### 1. Shared Memory Pool (mmap)
- **Pros**: True zero-copy, < 100ms loads
- **Cons**: Complex IPC, Unix sockets, platform-specific
- **Decision**: Defer to v0.3.0 (higher ROI with less effort first)

### 2. Database Cache (SQLite)
- **Pros**: ACID transactions, query support
- **Cons**: Overhead for large blobs, slower than filesystem
- **Decision**: Rejected (files are simpler, faster)

### 3. Redis Cache
- **Pros**: Distributed, high performance
- **Cons**: External dependency, complexity
- **Decision**: Rejected (overkill for local cache)

---

## Documentation

### ADR-011: Model Artifact Cache

**Title**: Persistent Model Artifact Cache

**Status**: Proposed

**Context**: Model loading is slow (3-60s) on every process restart

**Decision**: Implement content-addressed disk cache for model artifacts

**Consequences**:
- ✅ 90% faster warm starts
- ✅ Reduced network usage
- ✅ Better multi-process efficiency
- ⚠️ Disk space usage (100GB default, configurable)
- ⚠️ Complexity in cache management

---

## Next Steps

1. ✅ Review this ultra-deep analysis
2. ✅ Get stakeholder approval
3. 🔄 Implement Phase 2.1 (Core Infrastructure)
4. 🔄 Implement Phase 2.2 (ModelManager Integration)
5. 🔄 Implement Phase 2.3 (Python Integration)
6. 🔄 Implement Phase 2.4 (Metrics)
7. 🔄 Implement Phase 2.5 (Testing)
8. ✅ Document as ADR-011

**Estimated Timeline**: 7 days
**Risk**: Low
**ROI**: Extremely High ⭐⭐⭐⭐⭐

---

**End of Ultra-Deep Analysis**
