# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**mlx-serving** is a production-ready TypeScript MLX serving engine for Apple Silicon with comprehensive Zod validation, advanced state management, and enterprise-grade reliability.

**Key Technologies:**
- TypeScript (Node.js 22+, strict mode, NodeNext module resolution)
- Python 3.11+ runtime (MLX model inference via JSON-RPC)
- Zod v3.22.4 for runtime validation
- Vitest for testing
- Apple Silicon M3+ required (Metal 3.3+)

**Current Status:** v0.11.0-alpha.1 - Week 3 Memory Management + Multi-Model + Scaling (850+/850+ tests passing, 0 lint errors)

---

## Essential Commands

### Build & Development
```bash
# Full build (TypeScript → ESM + CJS + DTS)
npm run build

# Type checking only (no build)
npm run typecheck

# Lint (ESLint with max-warnings=0)
npm run lint

# Format code
npm run format

# Watch mode for development
npm run dev
```

### Testing
```bash
# Run all tests (Vitest)
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Coverage report (80% threshold)
npm run test:coverage

# Run specific test file
npx vitest run tests/unit/validation/model-schema.test.ts

# Run tests matching pattern
npx vitest run --grep "LoadModelOptions"
```

### Python Environment Setup
```bash
# Initialize Python virtual environment (.kr-mlx-venv)
npm run setup

# Alternative: Direct script execution
npm run prepare:python

# Setup MLX engine (downloads dependencies)
npm run setup:mlx-engine
```

### Native Module (Metal + CPU + Memory Optimizations - REQUIRED for Week 1, 2 & 3)
```bash
# Build native module with Metal + CPU + Memory optimizations (+70-113% performance boost)
cd native && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .

# Or use the script
bash scripts/build-native.sh

# Note: Week 1 Metal + Week 2 CPU + Week 3 Memory optimizations require the native module
# Week 1 Components: Memory Pool, Blit Queue, Command Buffer Ring
# Week 2 Components: CPU-Parallelized Tokenizer, Enhanced KV Cache Pool
# Week 3 Components: Weight Manager (pinning & prefetching)
```

### Benchmarks
```bash
# Flexible benchmark tool (customizable)
npm run bench:flexible

# Quick test (10 questions)
npm run bench:quick

# Comparison test (100 questions, both engines)
npm run bench:compare

# Run specific benchmark
npm run bench:ipc
npm run bench:ttft
npm run bench:throughput

# Run all benchmarks
npm run bench:all

# Generate markdown report
npm run bench:report

# Comparison benchmarks
npm run bench:apple-to-apple
npm run bench:50-questions
npm run bench:100-questions

# Custom flexible benchmark
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --compare both \
  --output results/custom.json
```

---

## Architecture

### High-Level Data Flow

```
TypeScript API (src/api/)
    ↓ Zod validation
State Management (src/core/)
    ↓ JSON-RPC over stdio
Python Runtime (python/)
    ↓ MLX Python bindings
Metal GPU (Apple Silicon)
```

### Directory Structure

```
src/
├── api/              # Public-facing Engine API
│   ├── engine.ts     # Main Engine class (high-level facade)
│   ├── mlx-engine.ts # Simplified MLXEngine wrapper
│   └── errors.ts     # Error types & Zod error conversion
├── bridge/           # TypeScript ↔ Python IPC
│   ├── python-runner.ts      # Python process lifecycle
│   ├── jsonrpc-transport.ts  # JSON-RPC message handling
│   ├── ops-multiplexer.ts    # Request routing
│   └── stream-registry.ts    # Streaming response management
├── core/             # Core services & state management
│   ├── model-manager.ts         # Model loading/unloading
│   ├── batch-queue.ts           # Request batching
│   ├── generate-batcher.ts      # Generation request batching
│   ├── generator-factory.ts     # Generator creation
│   ├── coalescing-registry.ts   # Request coalescing
│   ├── prompt-cache.ts          # LRU cache with TTL
│   ├── request-deduplicator.ts  # Request deduplication
│   ├── model-lifecycle-manager.ts  # Model lifecycle & GPU coordination
│   └── model-concurrency-limiter.ts  # 4-layer concurrency fix
├── scheduling/       # Week 3: Priority scheduling
│   ├── PriorityScheduler.ts     # Priority-based request scheduling
│   ├── SchedulerMetrics.ts      # Scheduler metrics tracking
│   └── index.ts                 # Module exports
├── models/           # Week 3: Multi-model serving
│   ├── ModelRegistry.ts         # Centralized model registry
│   ├── ModelSwitcher.ts         # Intelligent model switching
│   ├── LruModelCache.ts         # LRU-based model caching
│   └── index.ts                 # Module exports
├── scaling/          # Week 3: Horizontal scaling
│   ├── LoadBalancer.ts          # Load balancing across instances
│   ├── DistributedCache.ts      # Distributed caching layer
│   ├── InstanceRegistry.ts      # Instance registry & health checks
│   └── index.ts                 # Module exports
├── streaming/        # Advanced streaming features (Phases 2-4)
│   ├── pipeline/ttft/    # TTFT accelerator pipeline
│   ├── qos/              # QoS monitoring & remediation
│   └── registry/         # Stream lifecycle management
├── canary/           # Canary deployment system (Phase 5)
│   ├── canary-router.ts     # Traffic splitting
│   ├── rollback-controller.ts  # Automated rollback
│   └── feature-flag-loader.ts  # Feature flag system
├── integration/      # QoS ↔ StreamRegistry integration (Phase 5)
├── types/            # TypeScript types & Zod schemas
│   ├── schemas/      # Zod validation schemas (Phase 1)
│   │   ├── common.ts
│   │   ├── model.ts
│   │   ├── generator.ts
│   │   ├── tokenizer.ts
│   │   ├── config.ts
│   │   ├── jsonrpc.ts
│   │   ├── telemetry.ts
│   │   └── events.ts
│   └── *.ts          # TypeScript interfaces
├── config/           # Runtime configuration loader
├── utils/            # Utilities (model downloader, image encoding)
├── telemetry/        # OpenTelemetry integration
└── services/         # High-level services

python/
├── runtime.py        # Main Python JSON-RPC server
├── models/           # MLX model loaders
├── adapters/         # Outlines adapter (structured output)
├── gpu_scheduler.py  # GPU scheduling to prevent crashes
└── native/           # C++ native module bindings (optional)

native/               # C++ acceleration (Week 1: Metal, Week 2: CPU, Week 3: Memory)
├── CMakeLists.txt
├── src/              # C++/Objective-C++ implementation
│   ├── kr_metal_memory_pool.mm      # Pre-allocated MTLHeap buffers (Week 1)
│   ├── kr_blit_queue.mm             # Async I/O overlap with MTLBlitCommandEncoder (Week 1)
│   ├── kr_command_buffer_ring.mm    # Double/triple buffering (Week 1)
│   ├── kr_cpu_tokenizer.cpp         # CPU-parallelized tokenizer with OpenMP (Week 2)
│   ├── kr_kv_cache_pool.cpp         # Enhanced KV cache pool with prefix sharing (Week 2)
│   └── kr_weight_manager.mm         # Weight pinning & prefetching (Week 3)
├── bindings/         # pybind11 Python bindings
│   ├── metal_pool_bindings.cpp      # Memory pool Python interface (Week 1)
│   ├── blit_queue_bindings.cpp      # Blit queue Python interface (Week 1)
│   ├── command_ring_bindings.cpp    # Command ring Python interface (Week 1)
│   ├── cpu_tokenizer_bindings.cpp   # CPU tokenizer Python interface (Week 2)
│   ├── kv_cache_bindings.cpp        # KV cache pool Python interface (Week 2)
│   └── weight_manager_bindings.cpp  # Weight manager Python interface (Week 3)
└── include/          # Headers
    └── kr_weight_manager.h          # Weight manager header (Week 3)

tests/
├── unit/             # Unit tests (mocked dependencies)
├── integration/      # Integration tests (real Python runtime)
├── security/         # Security/vulnerability tests
├── contracts/        # API contract tests
└── helpers/          # Test utilities
```

### Key Architectural Concepts

**1. JSON-RPC Bridge Pattern**
- TypeScript communicates with Python via JSON-RPC over stdio
- `JsonRpcTransport` handles message serialization/deserialization
- `OpsMultiplexer` routes requests to correct handler
- Streaming responses managed by `StreamRegistry`

**2. Zod Validation**
- All API boundaries validated at runtime with Zod schemas (9 modules)
- Located in `src/types/schemas/`
- See `docs/ZOD_SCHEMAS.md` for comprehensive guide
- Pattern: Normalize → Validate → Execute

**3. State Management**
- Circuit breakers prevent cascading failures
- Request queuing prevents Metal GPU crashes
- Batch queue optimizes throughput
- Stream registry manages backpressure

**4. Model Loading**
- Models cached in `~/.cache/huggingface/hub/`
- `ModelManager` handles load/unload lifecycle
- Support for draft models (speculative decoding)
- Vision models supported (LLaVA, Qwen-VL, Phi-3-Vision)

**5. Performance Optimizations**
- **Request Deduplication**: Collapses identical concurrent requests into shared Promises (1s TTL)
- **Prompt Cache**: LRU cache with 5-minute TTL for repeated prompts (10k entries)
- **Request Coalescing**: Multiplexes streaming responses to multiple subscribers
- **4-Layer Concurrency Fix**: Prevents Metal GPU crashes with large models (30B+)
- **TTFT Acceleration**: Warm queue, speculation, KV prep
- **QoS Monitoring**: SLO evaluation and policy-based remediation
- **Week 1 Metal Optimizations**: Metal Memory Pool (+10-15%), Blit Queue I/O Overlap (+15-20% TTFT), Command Buffer Ring (+5-10% GPU util)
- **Week 2 CPU Optimizations**: CPU-Parallelized Tokenizer (+10-12% latency reduction), Enhanced KV Cache Pool (+20-30% multi-turn)
- **Week 3 Advanced Features**: Weight Pinning & Prefetching (+10-15%), Priority Scheduling, Multi-Model Serving, Horizontal Scaling
- All optimizations feature-flagged and disabled by default

**6. Reliability & Production Features (Phases 2-5 + Week 2)**
- **Dynamic Batching**: Adaptive batch sizing for optimal throughput
- **TTFT Pipeline**: Tokenizer warm queue, speculative decoding, KV cache preparation
- **QoS System**: Real-time monitoring, SLO evaluation, automated remediation
- **Canary Deployment**: Traffic splitting with automatic rollback on violations (Week 2 enhanced)
- **Feature Flags**: Percentage-based rollout with hash-based deterministic routing
- **A/B Testing Framework**: Statistical validation with Welch's t-test and Cohen's d (Week 2)
- **Regression Detection**: Real-time monitoring with automated rollback trigger (Week 2)

---

## Performance Optimizations & Reliability

### Week 2: CPU Optimizations + Production Infrastructure (v0.10.0-alpha.1)

Two native CPU optimizations plus production hardening provide 10-15% additional throughput:

#### 1. CPU-Parallelized Tokenizer (`native/src/kr_cpu_tokenizer.cpp`)

**Purpose**: Multi-threaded tokenization reduces latency by -60% tokenization time.

**How it works**:
- OpenMP parallelization for batch tokenization
- Apple Accelerate framework integration for SIMD operations
- Configurable thread count (default: 8 threads)
- Graceful fallback to serial processing on errors
- Comprehensive performance metrics tracking

**Configuration** (`config/runtime.yaml`):
```yaml
cpu_optimizations:
  tokenizer:
    enabled: false  # Default disabled for safety
    num_threads: 8  # CPU thread count
    batch_size: 16  # Optimal batch size for parallelization
```

**Expected gain**: +10-12% latency reduction, -60% tokenization time

#### 2. Enhanced KV Cache Pool (`native/src/kr_kv_cache_pool.cpp`)

**Purpose**: MLX-level KV cache with prefix sharing for multi-turn conversations.

**How it works**:
- LRU eviction with configurable capacity (default: 100 entries)
- Prefix sharing for multi-turn conversation efficiency
- TTL-based expiration (default: 5 minutes)
- Per-entry statistics tracking (hits, prefix matches)
- Memory-efficient storage with automatic cleanup

**Configuration** (`config/runtime.yaml`):
```yaml
cpu_optimizations:
  kv_cache_pool:
    enabled: false  # Default disabled for safety
    max_entries: 100
    ttl_seconds: 300  # 5 minutes
    enable_prefix_sharing: true
```

**Expected gain**: +20-30% multi-turn conversation performance

#### 3. Production Infrastructure (Week 2)

**Canary Deployment System** (`src/canary/`)
- 4-stage gradual rollout: 10% → 25% → 50% → 100%
- Deterministic hash-based traffic routing
- Automated rollback on performance regression (>5% degradation)
- Zero-downtime deployment
- 19 integration tests passing

**A/B Testing Framework** (`src/canary/ab-testing.ts`)
- Statistical validation with Welch's t-test
- 95% confidence intervals
- Cohen's d effect size calculation
- Automated go/no-go decisions
- 20 unit tests passing

**Automated Regression Detection** (`src/canary/regression-detector.ts`)
- Real-time performance monitoring
- TDigest percentile calculation (P50, P95, P99)
- Multi-channel alerting (Slack, PagerDuty, Webhook)
- Prometheus/Grafana integration
- Automated rollback trigger

#### Enabling CPU Optimizations

**Step 1**: Build native module (REQUIRED)
```bash
cd native && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
```

**Step 2**: Enable in `config/runtime.yaml`
```yaml
cpu_optimizations:
  tokenizer:
    enabled: true
    num_threads: 8
  kv_cache_pool:
    enabled: true
    max_entries: 100
```

**Step 3**: Restart engine to apply changes

**Expected total gain (Week 1 + Week 2)**: +54-84% throughput (131-157 tok/s from 84.96 tok/s baseline)

**Documentation**:
- `automatosx/PRD/WEEK2-PRD.md` - Week 2 Product Requirements Document
- `automatosx/PRD/WEEK2-ACTION-PLAN.md` - Week 2 Implementation Plan
- `automatosx/PRD/WEEK2-COMPLETION-REPORT.md` - Week 2 Completion Status

### Week 3: Memory Management + Multi-Model + Scaling (v0.11.0-alpha.1)

Advanced memory management, priority scheduling, multi-model serving, and horizontal scaling infrastructure provide 10-15% additional throughput plus enterprise features:

#### 1. Advanced Memory Management (`native/src/kr_weight_manager.mm`)

**Purpose**: Weight pinning & prefetching reduces model-switch latency by ~60%.

**How it works**:
- Unified memory pinning for frequently-used models (prevents eviction)
- Predictive weight prefetching based on usage patterns
- Lazy weight loading for infrequently-used models
- Memory pressure monitoring with automatic adaptation
- Comprehensive metrics tracking (pin hits, prefetch accuracy, memory usage)

**Configuration** (`config/runtime.yaml`):
```yaml
memory_management:
  weight_manager:
    enabled: false  # Default disabled for safety
    max_pinned_models: 3  # Number of models to keep pinned
    prefetch_threshold: 0.7  # Confidence threshold for prefetching
    lazy_load_threshold: 0.3  # Usage threshold for lazy loading
```

**Expected gain**: +10-15% throughput (single instance), -60% model-switch latency

#### 2. Priority-Based Request Scheduling (`src/scheduling/PriorityScheduler.ts`)

**Purpose**: Priority queues ensure high-priority requests are served first.

**How it works**:
- 4-tier priority system (critical, high, normal, low)
- Configurable queue depths per priority level
- Starvation prevention with aging mechanism
- Comprehensive metrics (queue depths, wait times, service times)
- Dynamic priority adjustment based on SLO violations

**Configuration** (`config/runtime.yaml`):
```yaml
scheduling:
  priority_scheduler:
    enabled: false  # Default disabled for safety
    max_queue_depth: 1000
    aging_interval_ms: 5000  # Promote aged requests
```

**Use case**: SLA-tiered services, real-time vs batch workloads

#### 3. Multi-Model Serving (`src/models/ModelRegistry.ts`, `ModelSwitcher.ts`)

**Purpose**: Serve multiple models with intelligent caching and switching.

**How it works**:
- Centralized model registry with metadata tracking
- LRU-based model cache with configurable capacity
- Intelligent model switching with minimal latency
- Automatic model preloading based on usage patterns
- Per-model statistics tracking (load count, usage, memory)

**Configuration** (`config/runtime.yaml`):
```yaml
multi_model:
  enabled: false  # Default disabled for safety
  max_loaded_models: 5
  model_ttl_seconds: 600  # 10 minutes
  preload_threshold: 0.8  # Preload at 80% usage
```

**Use case**: Multi-tenant serving, A/B testing with multiple model variants

#### 4. Horizontal Scaling Infrastructure (`src/scaling/`)

**Purpose**: Scale across multiple Mac instances with load balancing.

**How it works**:
- **Load Balancer** (`LoadBalancer.ts`): Round-robin, least-connections, or weighted routing
- **Distributed Cache** (`DistributedCache.ts`): Redis-backed shared cache across instances
- **Instance Registry** (`InstanceRegistry.ts`): Health checks, automatic failover
- Real-time metrics aggregation across cluster
- Consistent hashing for session affinity

**Configuration** (`config/runtime.yaml`):
```yaml
horizontal_scaling:
  enabled: false  # Default disabled for safety
  load_balancer:
    strategy: "least_connections"  # round_robin, least_connections, weighted
  distributed_cache:
    redis_url: "redis://localhost:6379"
    ttl_seconds: 300
  instance_registry:
    health_check_interval_ms: 10000
```

**Performance (3 instances)**: 520 tok/s (6.1x baseline), 180 req/s throughput

#### Enabling Week 3 Features

**Step 1**: Build native module (REQUIRED for weight manager)
```bash
cd native && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
```

**Step 2**: Enable in `config/runtime.yaml`
```yaml
memory_management:
  weight_manager:
    enabled: true
    max_pinned_models: 3

scheduling:
  priority_scheduler:
    enabled: true

multi_model:
  enabled: true
  max_loaded_models: 5

horizontal_scaling:
  enabled: true
  load_balancer:
    strategy: "least_connections"
```

**Step 3**: Restart engine to apply changes

**Expected total gain (Week 1 + Week 2 + Week 3)**:
- **Single instance**: +70-113% throughput (144-181 tok/s from 84.96 tok/s baseline)
- **3 instances**: 520 tok/s (6.1x baseline), 180 req/s

**Documentation**:
- `automatosx/PRD/WEEK3-PRD.md` - Week 3 Product Requirements Document
- `automatosx/PRD/WEEK3-ACTION-PLAN.md` - Week 3 Implementation Plan
- `automatosx/PRD/WEEK3-COMPLETION-REPORT.md` - Week 3 Completion Status

### Week 1: Metal-Layer Optimizations (v0.9.0-alpha.1)

Three native Metal optimizations provide 40-60% throughput improvement:

#### 1. Metal Memory Pool (`native/src/kr_metal_memory_pool.mm`)

**Purpose**: Pre-allocated MTLHeap buffers eliminate per-request allocation overhead.

**How it works**:
- Pre-allocates MTLHeap with configurable size (default: 256MB)
- Maintains pool of ready-to-use MTLBuffers
- Warmup functionality for common buffer sizes
- Comprehensive statistics tracking (hits, misses, allocations)
- Graceful fallback on pool exhaustion

**Configuration** (`config/runtime.yaml`):
```yaml
metal_optimizations:
  memory_pool:
    enabled: false  # Default disabled for safety
    heap_size_mb: 256
    pool_size: 32
    warmup_sizes: [1024, 4096, 16384, 65536]
```

**Expected gain**: +10-15% throughput improvement

#### 2. Blit Queue I/O Overlap (`native/src/kr_blit_queue.mm`)

**Purpose**: Asynchronous data transfer with MTLBlitCommandEncoder reduces TTFT.

**How it works**:
- Dedicated MTLCommandQueue for blit operations
- MTLSharedEvent synchronization (no busy-wait CPU polling)
- Overlaps tokenization → upload → compute → download
- Comprehensive metrics tracking (transfer times, wait times)

**Configuration** (`config/runtime.yaml`):
```yaml
metal_optimizations:
  blit_queue:
    enabled: false  # Default disabled for safety
    queue_priority: 1  # 0=low, 1=normal, 2=high
```

**Expected gain**: +15-20% TTFT reduction

#### 3. Command Buffer Ring (`native/src/kr_command_buffer_ring.mm`)

**Purpose**: Double/triple buffering improves GPU utilization.

**How it works**:
- Configurable ring size (2-3 buffers)
- Round-robin buffer acquisition
- Metal completion handler integration
- Statistics tracking (submissions, completions, waits)

**Configuration** (`config/runtime.yaml`):
```yaml
metal_optimizations:
  command_buffer_ring:
    enabled: false  # Default disabled for safety
    ring_size: 2  # 2 or 3
```

**Expected gain**: +5-10% GPU utilization improvement

#### Enabling Metal Optimizations

**Step 1**: Build native module (REQUIRED)
```bash
cd native && mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
cmake --build .
```

**Step 2**: Enable in `config/runtime.yaml`
```yaml
metal_optimizations:
  memory_pool:
    enabled: true
  blit_queue:
    enabled: true
  command_buffer_ring:
    enabled: true
```

**Step 3**: Restart engine to apply changes

**Expected Week 1 gain**: +40-60% throughput (119-136 tok/s from 84.96 tok/s baseline)

**Week 1 Documentation**:
- `docs/METAL_OPTIMIZATIONS.md` - Main overview (647 lines)
- `docs/METAL_MEMORY_POOL.md` - Memory pool detailed guide (635 lines)
- `docs/BLIT_QUEUE.md` - Blit queue detailed guide (654 lines)
- `docs/COMMAND_BUFFER_RING.md` - Command ring detailed guide (621 lines)

### Caching Layers

Three caching layers improve throughput on duplicate-heavy workloads:

### 1. Request Deduplicator (`src/core/request-deduplicator.ts`)

**Purpose**: Collapse identical concurrent requests into a shared Promise to avoid redundant Python invocations.

**How it works**:
- Uses SHA256 fingerprinting of request parameters (model, prompt, temperature, etc.)
- Maintains a TTL-based Map<fingerprint, Promise<GenerateResponse>>
- First request creates Promise, concurrent identical requests share it
- 1-second TTL by default
- Automatic rejection propagation prevents cache poisoning

**Configuration** (`config/runtime.yaml`):
```yaml
request_deduplication:
  enabled: false  # Default disabled for safety
  ttl_ms: 1000
  max_entries: 1000
  max_payload_bytes: 1048576  # 1MB
```

**When to use**: High concurrency with duplicate requests (e.g., load testing, rate limiting)

### 2. Prompt Cache (`src/core/prompt-cache.ts`)

**Purpose**: Long-lived cache for completed generation results, providing faster-than-backend responses.

**How it works**:
- LRU eviction with configurable capacity (default: 10k entries)
- Size-aware eviction (tracks tokens + bytes)
- 5-minute TTL by default
- Optional disk persistence for cache survival across restarts
- Automatic cleanup timer removes expired entries

**Configuration** (`config/runtime.yaml`):
```yaml
prompt_cache:
  enabled: false  # Default disabled for safety
  max_entries: 10000
  max_total_tokens: 100000000
  max_total_bytes: 1073741824  # 1GB
  ttl_ms: 300000  # 5 minutes
  cleanup_interval_ms: 30000
  persistence:
    enabled: false
    path: ".cache/prompt-cache.json"
    save_interval_ms: 60000
```

**When to use**: Workloads with frequently repeated prompts (e.g., chatbots, documentation Q&A)

### 3. Request Coalescing Registry (`src/core/coalescing-registry.ts`)

**Purpose**: Multiplex streaming responses from a single backend invocation to multiple subscribers.

**How it works**:
- Tracks in-flight requests by fingerprint
- Shares a single Python inference call across N concurrent clients
- Each subscriber gets its own ReadableStream
- Primary stream chunks broadcast to all active subscribers
- Backpressure-aware with automatic cleanup

**Configuration** (`config/runtime.yaml`):
```yaml
request_coalescing:
  enabled: false  # Default disabled for safety
  max_subscribers: 100
  timeout: 5000  # 5 seconds
```

**When to use**: Multiple clients requesting identical streaming generations simultaneously

### 4-Layer Concurrency Fix

**Critical for large models (30B+)** - Prevents SIGTRAP/SIGABRT crashes:

**Layer 1**: Models package import fix (scheduled_generator accessible)
**Layer 2**: MLX semaphore in `python/models/generator.py` (limit=1 serializes Metal access)
**Layer 3**: Sequential batch_generate in `python/runtime.py` (no asyncio.gather)
**Layer 4**: MLX concurrency config in `config/runtime.yaml`:

```yaml
mlx:
  concurrency_limit: 1  # REQUIRED for 30B+ models
  force_metal_sync: true
```

**Result**: 100% reliability (validated with 100/100 concurrent requests on Qwen3-30B)

### Feature Flags

All optimizations are **disabled by default** for safety. Enable via `config/runtime.yaml`:

```yaml
# Enable all Phase 1 optimizations
request_deduplication:
  enabled: true

prompt_cache:
  enabled: true

request_coalescing:
  enabled: true
```

### Monitoring Performance

Check optimization effectiveness:

```typescript
// Request Deduplicator stats
const dedupStats = deduplicator.getStats();
console.log(`Hit rate: ${dedupStats.hitRate * 100}%`);

// Prompt Cache stats
const cacheStats = promptCache.getStats();
console.log(`Cache hit rate: ${cacheStats.hitRate * 100}%`);
console.log(`Size: ${cacheStats.size} / ${cacheStats.maxEntries}`);

// Coalescing Registry stats
const coalescingStats = coalescingRegistry.getStats();
console.log(`Coalescing ratio: ${coalescingStats.coalescingRatio * 100}%`);
```

### Benchmarking Performance Gains

Use the flexible benchmark tool to measure improvements:

```bash
# Baseline (optimizations disabled)
npx tsx benchmarks/flexible-benchmark.ts \
  --questions 100 \
  --compare mlx-serving

# With optimizations enabled
# (edit config/runtime.yaml first)
npx tsx benchmarks/flexible-benchmark.ts \
  --questions 100 \
  --compare mlx-serving
```

**Expected gains**:
- Request Deduplication: 10-20% on duplicate-heavy workloads
- Prompt Cache: 50-80% on repeated prompts (after warm-up)
- Request Coalescing: 10-30% on concurrent identical requests

---

## Working with Zod Schemas

### Schema Locations
All Zod schemas are in `src/types/schemas/`:
- `model.ts` - LoadModelOptions, ModelDescriptor
- `generator.ts` - GeneratorParams, structured output
- `tokenizer.ts` - TokenizeRequest, TokenizeResponse
- `config.ts` - RuntimeConfig (60+ properties)
- `jsonrpc.ts` - JSON-RPC message validation
- `telemetry.ts` - OpenTelemetry configuration
- `events.ts` - Event payload schemas

### Adding New Validation
1. Define schema in appropriate file under `src/types/schemas/`
2. Export from `src/types/schemas/index.ts`
3. Use `.safeParse()` for validation with error handling
4. Convert Zod errors to EngineClientError via `zodErrorToEngineError()`
5. Add tests in `tests/unit/validation/`

### Validation Pattern
```typescript
import { LoadModelOptionsSchema } from '@/types/schemas/index.js';
import { zodErrorToEngineError } from '@/api/errors.js';

// Validate input
const result = LoadModelOptionsSchema.safeParse(options);
if (!result.success) {
  throw zodErrorToEngineError(result.error, 'VALIDATION_ERROR');
}

// Use validated data
const validated = result.data;
```

---

## Testing Guidelines

### Test Organization
- **Unit tests** (`tests/unit/`) - Mock all external dependencies
- **Integration tests** (`tests/integration/`) - Real Python runtime required
- **Security tests** (`tests/security/`) - Vulnerability testing
- **Contract tests** (`tests/contracts/`) - API compatibility

### Running Integration Tests
Integration tests require Python environment:
```bash
# Setup Python first
npm run setup

# Run all tests (includes integration)
npm test

# Run only integration tests
npx vitest run tests/integration/
```

### Test File Naming
- Unit: `*.test.ts` in `tests/unit/`
- Integration: `*.test.ts` in `tests/integration/`
- Follow existing structure: `tests/unit/validation/model-schema.test.ts`

### Mocking
- Use Vitest's `vi.mock()` for external dependencies
- Mock file: `tests/helpers/mock-runner.ts`
- Always isolate tests with `poolOptions.threads.isolate = true`

---

## Path Aliases

TypeScript path aliases (configured in `tsconfig.json`):
```typescript
import { Engine } from '@/api/engine.js';
import { ModelManager } from '@core/model-manager.js';
import { LoadModelOptionsSchema } from '@types/schemas/index.js';
import { PythonRunner } from '@bridge/python-runner.js';
```

**Important:** Always use `.js` extension in imports (even for `.ts` files) for ESM compatibility.

---

## Python Runtime

### Python Process Lifecycle
1. `PythonRunner` spawns Python subprocess running `python/runtime.py`
2. Communication via JSON-RPC over stdin/stdout
3. Python loads MLX models, performs inference
4. TypeScript receives streaming tokens via JSON-RPC

### Python Environment
- Virtual environment: `.kr-mlx-venv/`
- Dependencies: `python/requirements.txt`
- MLX framework version: >=3.3.0
- Auto-setup on `npm install` via `scripts/postinstall.cjs`

### Debugging Python Runtime
```bash
# Enable Python debug logging
export KR_MLX_LOG_LEVEL=debug

# Run Python runtime directly (for testing)
source .kr-mlx-venv/bin/activate
python python/runtime.py
```

---

## Planning Documents

All planning documents are in `automatosx/PRD/`:
- **mlx-serving-prd.md** - Product Requirements Document
- **mlx-serving-implementation-plan.md** - 5-phase implementation roadmap
- **PUBLISHING-CHECKLIST.md** - npm publishing guide
- **PROJECT_SUMMARY.md** - Executive summary

**Technical documentation:**
- `docs/ZOD_SCHEMAS.md` - Comprehensive Zod validation guide (9 schema modules)
- `docs/ARCHITECTURE.md` - Detailed architecture
- `docs/GUIDES.md` - User guides (structured output, vision models)
- `docs/DEPLOYMENT.md` - Deployment guide
- `docs/METAL_OPTIMIZATIONS.md` - Week 1 Metal optimizations overview (647 lines)
- `docs/METAL_MEMORY_POOL.md` - Metal Memory Pool detailed guide (635 lines)
- `docs/BLIT_QUEUE.md` - Blit Queue I/O Overlap detailed guide (654 lines)
- `docs/COMMAND_BUFFER_RING.md` - Command Buffer Ring detailed guide (621 lines)

**Week 2 documentation:**
- `automatosx/PRD/WEEK2-PRD.md` - Week 2 Product Requirements Document
- `automatosx/PRD/WEEK2-ACTION-PLAN.md` - Week 2 Implementation Plan
- `automatosx/PRD/WEEK2-COMPLETION-REPORT.md` - Week 2 Completion Status

**Week 3 documentation:**
- `automatosx/PRD/WEEK3-PRD.md` - Week 3 Product Requirements Document
- `automatosx/PRD/WEEK3-ACTION-PLAN.md` - Week 3 Implementation Plan
- `automatosx/PRD/WEEK3-COMPLETION-REPORT.md` - Week 3 Completion Status

**Latest reports:**
- `automatosx/tmp/BUG-FIX-COMPLETE-REPORT.md` - Production readiness validation

---

## Common Development Tasks

### Adding a New API Method
1. Add method signature to `src/types/engine.ts` interface
2. Add Zod schema to appropriate file in `src/types/schemas/`
3. Implement in `src/api/engine.ts`
4. Add Python handler in `python/runtime.py` if needed
5. Add tests in `tests/unit/` and `tests/integration/`
6. Update `docs/ZOD_SCHEMAS.md` if new schema added

### Modifying Validation
1. Update schema in `src/types/schemas/`
2. Run `npm run typecheck` to verify types
3. Run `npm test` to verify all tests pass
4. Update tests in `tests/unit/validation/` if needed

### Debugging JSON-RPC Issues
1. Enable debug logging: `export KR_MLX_LOG_LEVEL=debug`
2. Check `src/bridge/jsonrpc-transport.ts` for message handling
3. Check `src/bridge/ops-multiplexer.ts` for request routing
4. Check Python side: `python/runtime.py`

### Performance Optimization
1. **For large models (30B+)**: Ensure 4-layer concurrency fix is enabled in `config/runtime.yaml`:
   ```yaml
   mlx:
     concurrency_limit: 1
     force_metal_sync: true
   ```
2. Check batch queue settings in `src/core/batch-queue.ts`
3. Enable caching optimizations in `config/runtime.yaml`:
   - `request_deduplication.enabled: true`
   - `prompt_cache.enabled: true`
   - `request_coalescing.enabled: true`
4. **Enable Metal optimizations** (Week 1 - RECOMMENDED):
   - Build native module: `cd native && mkdir -p build && cd build && cmake .. && cmake --build .`
   - Enable in `config/runtime.yaml`:
     - `metal_optimizations.memory_pool.enabled: true`
     - `metal_optimizations.blit_queue.enabled: true`
     - `metal_optimizations.command_buffer_ring.enabled: true`
   - Expected gain: +40-60% throughput (119-136 tok/s)
5. Profile with: `bash scripts/profile-system.sh`
6. Run benchmarks: `npm run bench:all` or `npm run bench:flexible`
7. Monitor QoS metrics and cache stats via telemetry endpoints

**Current Performance**:
- **v0.8.0**: 19.5% faster than baseline (84.96 tok/s on Qwen3-30B-4bit)
- **v0.9.0-alpha.1** (expected with Metal optimizations): 40-60% faster (119-136 tok/s)
- **v0.10.0-alpha.1** (expected with Metal + CPU optimizations): 54-84% faster (131-157 tok/s)
- **v0.11.0-alpha.1** (expected with Metal + CPU + Memory optimizations):
  - **Single instance**: 70-113% faster (144-181 tok/s)
  - **3 instances**: 6.1x baseline (520 tok/s, 180 req/s)

### Running Custom Benchmarks
The flexible benchmark tool allows testing any MLX model with custom parameters:

```bash
# Quick 10-question test
npm run bench:quick

# Compare both engines (100 questions)
npm run bench:compare

# Custom benchmark with specific model
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/Qwen2.5-7B-Instruct-4bit" \
  --questions 50 \
  --max-tokens 200 \
  --temp 0.7 \
  --compare both

# Save results to file
npx tsx benchmarks/flexible-benchmark.ts \
  --model "mlx-community/gemma-2-27b-it-4bit" \
  --questions 200 \
  --output automatosx/tmp/benchmark-results.json
```

Available flags:
- `--model` or `-m`: Model name or path
- `--questions` or `-q`: Number of questions (1-10000+)
- `--compare` or `-c`: Engine to test (mlx-serving, mlx-engine, or both)
- `--max-tokens`: Max tokens per generation (default: 100)
- `--temp`: Temperature (default: 0.7)
- `--output` or `-o`: Output file path
- `--verbose` or `-v`: Verbose logging

---

## Git Workflow

### Branch Strategy
- Main branch: `main`
- Current status: v0.11.0-alpha.1 - Week 3 Memory Management + Multi-Model + Scaling (850+/850+ tests passing)

### Commit Message Format
Follow conventional commits:
```
<type>: <description>

Examples:
feat: Add Zod validation for GeneratorParams
fix: Fix race condition in StreamRegistry
docs: Update ZOD_SCHEMAS.md with new examples
test: Add integration tests for vision models
refactor: Simplify error handling in Engine
```

---

## System Requirements

**IMPORTANT:** This project requires:
- **macOS 26.0+** (Darwin 25.0.0+)
- **Apple Silicon M3 or newer** (M3 Pro/Max/Ultra recommended)
- **Node.js 22.0.0+**
- **Python 3.11-3.12**
- **Metal 3.3+** (included in macOS 26.0+)

The package will fail to install on non-Apple Silicon systems.

---

## AutomatosX Integration

This project uses [AutomatosX](https://github.com/defai-digital/automatosx) for AI agent orchestration with persistent memory.

### Key Commands

```bash
# List available agents
ax list agents

# Run an agent
ax run <agent-name> "task description"

# Search memory
ax memory search "keyword"
```

### Workspace Directories

- **`automatosx/PRD/`** - Planning documents, specs, architecture designs
- **`automatosx/tmp/`** - Temporary files, drafts, analysis outputs (auto-cleaned)

---

## Additional Resources

- **GitHub**: https://github.com/defai-digital/mlx-serving
- **Issues**: https://github.com/defai-digital/mlx-serving/issues
- **MLX Framework**: https://github.com/ml-explore/mlx
- **Zod Documentation**: https://zod.dev
