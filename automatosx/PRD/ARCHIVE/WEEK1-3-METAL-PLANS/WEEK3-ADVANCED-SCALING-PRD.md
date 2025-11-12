# PRD: Week 3 - Advanced Optimization + Horizontal Scaling

**Version**: v0.11.0
**Status**: Ready for Implementation
**Priority**: P1 (High Impact, Low-Medium Risk)
**Target Timeline**: Week 3 (7 days)
**Prerequisites**: Week 1 & Week 2 Complete
**Owner**: Core Infrastructure Team
**Last Updated**: 2025-11-09

---

## Executive Summary

Week 3 completes the optimization journey by adding **advanced memory management**, **intelligent request scheduling**, and **horizontal scaling infrastructure**. This week focuses on:

1. **Weight Prefetching & Memory Pinning** (reduce P99 variance)
2. **Advanced Request Scheduling** (optimize concurrent workloads)
3. **Multi-Model Serving** (fast model switching)
4. **Horizontal Scaling Infrastructure** (scale beyond single instance)

### Goals

**Performance** (Single Instance):
- **+10-15% latency reduction** (weight prefetching, memory pinning)
- **+15-20% throughput under load** (advanced scheduling)
- **<100ms model switching** (multi-model optimization)
- **-20-30% P99 variance** (memory stability)

**Scalability** (Multi-Instance):
- **Linear scaling** to N instances (load balancing)
- **Distributed KV cache** (shared state across instances)
- **Smart request routing** (latency-aware, load-aware)
- **>95% resource utilization** (optimal instance packing)

**Combined Target** (Week 1 + 2 + 3):
- **Week 1**: +40-60% (119-136 tok/s)
- **Week 2**: +10-15% (131-157 tok/s)
- **Week 3**: +10-15% single + scale-out
- **Single Instance**: **144-181 tok/s** (+70-113% from 84.96 baseline)
- **Multi-Instance (3x)**: **430-540 tok/s** (near-linear scaling)

### Principles

1. **Production Ready**: All optimizations battle-tested
2. **Low-Medium Risk**: No experimental features
3. **Horizontal Scale**: Design for multi-instance deployment
4. **Operational Excellence**: Monitoring, alerting, auto-healing
5. **Cost Efficiency**: Optimize resource utilization

---

## Background & Prerequisites

### Week 1 & 2 Deliverables (Prerequisites)

**Required from Week 1**:
- ✅ Metal Memory Pool (+10-15%)
- ✅ Blit Queue I/O Overlap (-15-20% TTFT)
- ✅ Command Buffer Ring (+5-10% GPU util)

**Required from Week 2**:
- ✅ CPU Parallel Tokenizer (+10-12%)
- ✅ Enhanced KV Cache Pool (+20-30% multi-turn)
- ✅ Canary deployment system
- ✅ A/B testing framework
- ✅ Regression detection

**Week 2 Performance Baseline**:
- Throughput: **131-157 tok/s** (assuming Week 1 + 2 gains)
- TTFT: **8.7-9.2ms**
- Multi-turn: **6.4-7.3ms/tok**
- P99 latency: ~15-20ms (estimated)

### Current Bottlenecks (After Week 1 & 2)

With Metal and CPU optimizations in place, new bottlenecks emerge:

```
Single Instance Performance Profile:
├─ Compute (GPU):           7.5ms (85%)  ← Highly optimized
├─ Memory Access:           0.8ms (9%)   ← NEW BOTTLENECK (weight loading)
├─ Scheduling Overhead:     0.4ms (5%)   ← NEW BOTTLENECK (request queueing)
└─ Other:                   0.1ms (1%)

Concurrent Workload Issues:
├─ Request queueing latency        ← Needs priority scheduling
├─ Model switching overhead        ← Needs multi-model optimization
└─ Single-instance capacity limit  ← Needs horizontal scaling
```

**Key Insight**: Single instance is near-optimal. Further gains require:
1. **Memory optimization** (reduce weight loading overhead)
2. **Intelligent scheduling** (optimize concurrent requests)
3. **Horizontal scaling** (break single-instance ceiling)

---

## Optimization 1: Weight Prefetching & Memory Pinning

### Problem Statement

**Current Behavior**:
- Model weights loaded on-demand from disk/memory
- Page faults during inference cause latency spikes
- TLB misses due to non-contiguous memory
- No proactive weight warming

**Impact**:
- P99 latency variance: ±30-40% (unpredictable spikes)
- Cold start latency: 2-3 seconds
- Memory fragmentation over time
- GPU stalls waiting for weight data

**Example Latency Distribution** (current):
```
P50:  8.5ms  ← Good (optimized path)
P95:  12.3ms ← Acceptable
P99:  18.7ms ← BAD (spikes due to page faults)
P999: 32.1ms ← VERY BAD (cold start)
```

### Solution: Intelligent Weight Management

**Architecture**:
```cpp
// native/include/kr_weight_manager.h
class WeightManager {
public:
    struct Config {
        bool pin_weights = true;              // Pin critical weights
        bool prefetch_enabled = true;         // Prefetch next layer
        size_t warmup_buffer_mb = 512;        // Memory to pre-warm
        int prefetch_threads = 2;             // Background prefetch threads
    };

    // Pin model weights in memory (prevent swapping)
    void pinModelWeights(const std::vector<MTLBuffer*>& weights);

    // Prefetch next layer weights before needed
    void prefetchLayer(int layer_index);

    // Warm up memory on model load
    void warmupModel(const ModelConfig& config);

    // Memory-mapped weight loading (zero-copy)
    MTLBuffer* loadWeightsMapped(const std::string& path);

private:
    // Use mlock() to pin pages
    void pinMemory(void* addr, size_t length);

    // Intelligent prefetcher (uses model graph)
    class WeightPrefetcher;
    std::unique_ptr<WeightPrefetcher> prefetcher_;
};
```

### Implementation Strategy

**Phase 1: Memory Pinning** (Day 1)

```cpp
// native/src/weight_manager.mm
void WeightManager::pinModelWeights(const std::vector<MTLBuffer*>& weights) {
    for (auto* weight : weights) {
        // Get buffer pointer
        void* ptr = [weight contents];
        size_t length = [weight length];

        // Pin memory (prevent swapping)
        int result = mlock(ptr, length);
        if (result != 0) {
            logger.warning("Failed to pin weight buffer: " + std::string(strerror(errno)));
            // Non-fatal: continue without pinning
        } else {
            pinned_weights_.push_back({ptr, length});
        }
    }

    logger.info("Pinned " + std::to_string(pinned_weights_.size()) + " weight buffers");
}

WeightManager::~WeightManager() {
    // Unpin on cleanup
    for (auto& [ptr, length] : pinned_weights_) {
        munlock(ptr, length);
    }
}
```

**Phase 2: Intelligent Prefetching** (Day 1)

```cpp
// native/src/weight_prefetcher.cpp
class WeightPrefetcher {
public:
    WeightPrefetcher(const ModelGraph& graph) : graph_(graph) {
        // Analyze model graph to determine prefetch order
        analyzePrefetchOrder();
    }

    void prefetchNextLayer(int current_layer) {
        // Prefetch next 1-2 layers in background
        for (int next_layer = current_layer + 1;
             next_layer <= current_layer + 2 && next_layer < graph_.num_layers();
             ++next_layer) {

            auto& layer_weights = graph_.getLayerWeights(next_layer);

            // Async prefetch (non-blocking)
            std::thread([this, layer_weights]() {
                for (auto* weight : layer_weights) {
                    // Touch pages to bring into memory
                    this->touchPages(weight);
                }
            }).detach();
        }
    }

private:
    void touchPages(MTLBuffer* buffer) {
        // Touch every page to trigger prefetch
        void* ptr = [buffer contents];
        size_t length = [buffer length];
        size_t page_size = getpagesize();  // 16KB on Apple Silicon

        for (size_t offset = 0; offset < length; offset += page_size) {
            // Volatile read to prevent compiler optimization
            volatile char dummy = *((char*)ptr + offset);
            (void)dummy;
        }
    }

    void analyzePrefetchOrder() {
        // Build dependency graph for optimal prefetch order
        // (e.g., attention weights before FFN weights)
    }

    ModelGraph graph_;
};
```

**Phase 3: Model Warmup** (Day 2)

```python
# python/models/weight_warmup.py
class ModelWarmup:
    def __init__(self, model, weight_manager):
        self.model = model
        self.weight_manager = weight_manager

    def warmup(self):
        """Warm up model by running dummy inference"""
        logger.info("Warming up model weights...")

        # Pin critical weights
        critical_weights = self.get_critical_weights()
        self.weight_manager.pin_model_weights(critical_weights)

        # Run dummy inference to warm caches
        dummy_input = self.create_dummy_input()
        _ = self.model.generate(dummy_input, max_tokens=10)

        # Prefetch common layers
        self.weight_manager.warmup_model(self.model.config)

        logger.info("Model warmup complete")

    def get_critical_weights(self):
        """Get weights for first 2-3 layers (hot path)"""
        return [
            self.model.layers[0].weights,
            self.model.layers[1].weights,
            self.model.embedding.weights,
        ]
```

### Expected Performance Gains

**P99 Latency Reduction**:
```
Current P99: 18.7ms (with page faults)
With pinned weights: 12.3ms (-34% reduction)
With prefetching: 10.8ms (-42% reduction)

P99 variance:
  Before: ±30-40%
  After:  ±8-12% (stable)
```

**Cold Start Improvement**:
```
Current cold start: 2.5 seconds
With warmup: 0.3 seconds (-88% reduction)
```

**Average Latency**:
```
Before: 8.8ms
After:  7.5ms (-15% reduction)
```

**Target**: **+10-15% latency reduction**, **-20-30% P99 variance**

### Feature Configuration

```yaml
# config/runtime.yaml
advanced_optimizations:
  weight_management:
    enabled: false               # DEFAULT: disabled for safety
    pin_critical_weights: true   # Pin first N layers
    pin_all_weights: false       # Pin entire model (high memory pressure)
    prefetch_enabled: true       # Background prefetching
    prefetch_threads: 2          # Prefetch thread count
    warmup_on_load: true         # Warm up model on load
    warmup_buffer_mb: 512        # Memory to pre-warm
    use_mmap: true               # Memory-mapped weight loading
```

---

## Optimization 2: Advanced Request Scheduling

### Problem Statement

**Current Behavior**:
- FIFO request queue (first-in, first-out)
- No priority differentiation
- No SLA awareness
- Suboptimal batching under mixed workloads

**Impact**:
- High-priority requests blocked by low-priority
- Long requests block short requests (head-of-line blocking)
- Inefficient resource utilization
- Poor performance under concurrent load

**Example** (current FIFO):
```
Queue: [Long req (1000 tok), Short req (10 tok), Short req (10 tok)]

Execution:
  Long req:  10.0s  ← Blocks queue
  Short req: 0.1s   ← Delayed 10s
  Short req: 0.1s   ← Delayed 10.1s

Total time: 10.2s
Avg latency: 6.8s per request (poor)
```

### Solution: Priority-Based Scheduling with SLA Tiers

**Architecture**:
```typescript
// src/scheduling/priority-scheduler.ts
enum RequestPriority {
  CRITICAL = 0,   // <100ms SLA (interactive)
  HIGH = 1,       // <500ms SLA (real-time)
  NORMAL = 2,     // <2s SLA (standard)
  LOW = 3,        // <10s SLA (batch)
  BACKGROUND = 4, // Best-effort
}

interface SchedulingPolicy {
  // Priority-based queue
  priorityQueues: Map<RequestPriority, Request[]>;

  // SLA-aware scheduling
  slaDeadlines: Map<string, number>;  // request_id -> deadline_timestamp

  // Shortest-job-first optimization
  estimatedDuration: (request: Request) => number;

  // Preemption support
  canPreempt: boolean;
}

class PriorityScheduler {
  private queues: Map<RequestPriority, Request[]>;
  private config: SchedulerConfig;

  async schedule(request: Request): Promise<void> {
    // Calculate priority
    const priority = this.calculatePriority(request);

    // Add to appropriate queue
    this.queues.get(priority).push(request);

    // Trigger scheduling decision
    await this.scheduleNext();
  }

  private async scheduleNext(): Promise<void> {
    // Select next request to execute
    const request = this.selectNextRequest();

    if (!request) return;

    // Check if we should preempt current execution
    if (this.shouldPreempt(request)) {
      await this.preemptCurrent(request);
    } else {
      await this.execute(request);
    }
  }

  private selectNextRequest(): Request | null {
    // Priority 1: Check SLA deadlines (urgent requests)
    const urgentReq = this.findUrgentRequest();
    if (urgentReq) return urgentReq;

    // Priority 2: Highest priority queue
    for (const priority of [CRITICAL, HIGH, NORMAL, LOW, BACKGROUND]) {
      const queue = this.queues.get(priority);
      if (queue.length > 0) {
        // Shortest-job-first within priority tier
        return this.shortestJobFirst(queue);
      }
    }

    return null;
  }

  private shortestJobFirst(queue: Request[]): Request {
    // Estimate duration for each request
    return queue.reduce((shortest, req) => {
      const shortestDuration = this.estimateDuration(shortest);
      const reqDuration = this.estimateDuration(req);
      return reqDuration < shortestDuration ? req : shortest;
    });
  }

  private estimateDuration(request: Request): number {
    // Estimate based on:
    // - Prompt length (tokenization cost)
    // - max_tokens parameter
    // - Model complexity
    // - Historical data (if available)

    const promptTokens = this.estimateTokenCount(request.prompt);
    const maxTokens = request.maxTokens || 100;

    // Simple linear model (calibrate with real data)
    const msPerToken = 9.0;  // Based on Week 2 performance
    return (promptTokens + maxTokens) * msPerToken;
  }

  private findUrgentRequest(): Request | null {
    const now = Date.now();

    for (const [priority, queue] of this.queues) {
      for (const request of queue) {
        const deadline = this.slaDeadlines.get(request.id);
        if (deadline && deadline - now < 100) {  // <100ms to deadline
          return request;
        }
      }
    }

    return null;
  }
}
```

### Advanced Batching Strategies

**Batch Composition Optimization**:
```typescript
// src/scheduling/batch-optimizer.ts
class BatchOptimizer {
  optimizeBatch(requests: Request[]): Request[] {
    // Goal: Maximize throughput while respecting SLAs

    // Strategy 1: Homogeneous batching
    // Group similar-length requests together
    const grouped = this.groupBySimilarLength(requests);

    // Strategy 2: Priority balancing
    // Include mix of priorities to prevent starvation
    const balanced = this.balancePriorities(grouped);

    // Strategy 3: Deadline-aware batching
    // Ensure no request exceeds SLA
    const deadline_aware = this.filterByDeadline(balanced);

    return deadline_aware;
  }

  private groupBySimilarLength(requests: Request[]): Request[][] {
    // Bucket by estimated token count
    const buckets = new Map<number, Request[]>();

    for (const req of requests) {
      const tokens = this.estimateTokens(req);
      const bucket = Math.floor(tokens / 100) * 100;  // 100-token buckets

      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
      }
      buckets.get(bucket).push(req);
    }

    return Array.from(buckets.values());
  }

  private balancePriorities(groups: Request[][]): Request[] {
    // Ensure each batch has mix of priorities
    // Prevents low-priority starvation

    const batch = [];
    const priorities = [CRITICAL, HIGH, NORMAL, LOW];

    for (const priority of priorities) {
      const count = this.getBatchQuota(priority);

      for (const group of groups) {
        const matching = group.filter(r => r.priority === priority);
        batch.push(...matching.slice(0, count));
      }
    }

    return batch;
  }
}
```

### Expected Performance Gains

**Latency Improvement** (mixed workload):
```
Before (FIFO):
  Short requests (10 tok):  Avg 6.8s (blocked)
  Long requests (1000 tok): Avg 10.0s

After (Priority + SJF):
  Short requests:  Avg 0.2s (-97%)
  Long requests:   Avg 10.5s (+5%, acceptable)

Overall avg latency: -60% for short requests
```

**Throughput Under Load**:
```
Concurrent load (10 requests):
  Before: 92 tok/s (queueing overhead)
  After:  152 tok/s (+65% under load)
```

**SLA Compliance**:
```
Before: 70% requests meet SLA
After:  95% requests meet SLA
```

**Target**: **+15-20% throughput under concurrent load**, **95% SLA compliance**

### Feature Configuration

```yaml
# config/runtime.yaml
advanced_optimizations:
  priority_scheduling:
    enabled: false               # DEFAULT: disabled for safety
    use_sjf: true                # Shortest-job-first within priority
    preemption_enabled: false    # Preempt long requests for urgent
    sla_tiers:
      critical: 100              # 100ms SLA
      high: 500                  # 500ms SLA
      normal: 2000               # 2s SLA
      low: 10000                 # 10s SLA
      background: null           # Best-effort

    batch_optimization:
      enabled: true
      homogeneous_batching: true # Group similar-length requests
      priority_balancing: true   # Prevent starvation
      deadline_aware: true       # Respect SLA deadlines
```

---

## Optimization 3: Multi-Model Serving

### Problem Statement

**Current Behavior**:
- Each model loaded independently
- Model switching requires full unload/reload
- No shared state between models
- Cold start on every model switch

**Impact**:
- Model switching latency: 2-5 seconds
- Memory waste (duplicate layers)
- No resource sharing
- Poor multi-model efficiency

### Solution: Shared Weight Pool + Fast Switching

**Architecture**:
```python
# python/models/multi_model_manager.py
class MultiModelManager:
    def __init__(self, max_models=3):
        self.max_models = max_models
        self.models = {}  # model_id -> Model
        self.lru = []     # LRU tracking
        self.shared_weights = SharedWeightPool()

    def get_or_load(self, model_id):
        """Get model from cache or load"""
        if model_id in self.models:
            # Hit: Move to end of LRU
            self.lru.remove(model_id)
            self.lru.append(model_id)
            return self.models[model_id]
        else:
            # Miss: Load model
            if len(self.models) >= self.max_models:
                self.evict_lru()

            model = self.load_model_fast(model_id)
            self.models[model_id] = model
            self.lru.append(model_id)
            return model

    def load_model_fast(self, model_id):
        """Fast model loading with shared weights"""
        # Check for shared weights (e.g., same architecture)
        shared = self.shared_weights.find_shared(model_id)

        if shared:
            # Reuse embedding/decoder weights (Llama-3-8B, Llama-3-7B share structure)
            model = Model(model_id, shared_weights=shared)
            logger.info(f"Loaded {model_id} with shared weights (fast path)")
        else:
            # Full load (slower)
            model = Model(model_id)
            logger.info(f"Loaded {model_id} (full load)")

        return model

    def switch_model(self, from_model_id, to_model_id):
        """Switch between models efficiently"""
        # Warm up target model in background
        if to_model_id not in self.models:
            self.prefetch_model(to_model_id)

        # Get target model (may still be loading)
        target = self.get_or_load(to_model_id)

        # Wait for warmup if needed
        target.wait_until_ready()

        return target
```

### Shared Weight Pool

```python
# python/models/shared_weight_pool.py
class SharedWeightPool:
    def __init__(self):
        self.weight_cache = {}  # layer_hash -> MLXArray

    def find_shared(self, model_id):
        """Find shareable weights for model"""
        model_family = self.get_model_family(model_id)

        # Same family? Share weights
        # e.g., Llama-3-8B and Llama-3-8B-Instruct share most weights
        if model_family in ['llama-3', 'qwen-2.5']:
            return self.weight_cache.get(model_family)

        return None

    def add_weights(self, model_id, weights):
        """Add weights to shared pool"""
        family = self.get_model_family(model_id)
        self.weight_cache[family] = weights

    def get_model_family(self, model_id):
        """Determine model family from ID"""
        if 'llama-3' in model_id.lower():
            return 'llama-3'
        elif 'qwen' in model_id.lower():
            return 'qwen-2.5'
        # ... etc
        return model_id
```

### Expected Performance Gains

**Model Switching Latency**:
```
Cold load (current): 2.5 seconds
Warm load (shared weights): 0.3 seconds (-88%)
Hot load (cached): 0.05 seconds (-98%)
```

**Memory Efficiency**:
```
3 models × 4GB each = 12GB (current)
3 models with sharing = 6GB (-50%)
```

**Target**: **<100ms model switching** (warm cache), **-50% memory usage** (multi-model)

### Feature Configuration

```yaml
# config/runtime.yaml
advanced_optimizations:
  multi_model:
    enabled: false               # DEFAULT: disabled for safety
    max_cached_models: 3         # Max models in memory
    shared_weights: true         # Share weights between similar models
    prefetch_enabled: true       # Background prefetch on switch
    warmup_on_switch: true       # Run warmup inference
```

---

## Optimization 4: Horizontal Scaling Infrastructure

### Problem Statement

**Single Instance Limits**:
- Maximum throughput: ~180 tok/s (after Week 1-3 optimizations)
- Single point of failure
- Limited by single GPU capacity
- Cannot scale beyond single M4 Ultra

**Need**: Scale to N instances to break single-instance ceiling

### Solution: Load-Balanced Multi-Instance Architecture

**Architecture**:
```
┌──────────────────────────────────────────────────────┐
│  Load Balancer (NATS / gRPC)                         │
│  - Latency-aware routing                             │
│  - Load-aware routing                                │
│  - Health checking                                   │
└────────────┬─────────────────────────────────────────┘
             │
    ┌────────┴────────┬────────────┬────────────┐
    │                 │            │            │
┌───▼────┐    ┌──────▼───┐  ┌────▼──────┐  ┌──▼──────┐
│Instance│    │Instance  │  │Instance   │  │Instance │
│   #1   │    │   #2     │  │   #3      │  │  #N     │
│(M4 Pro)│    │(M4 Max)  │  │(M4 Ultra) │  │ ...     │
└────────┘    └──────────┘  └───────────┘  └─────────┘
  180 tok/s    180 tok/s     180 tok/s       180 tok/s

Total: N × 180 tok/s (near-linear scaling)
```

### Load Balancer Implementation

```typescript
// src/scaling/load-balancer.ts
interface Instance {
  id: string;
  endpoint: string;
  capacity: number;      // Max tok/s
  current_load: number;  // Current tok/s
  health: 'healthy' | 'degraded' | 'unhealthy';
  avg_latency_ms: number;
}

class LoadBalancer {
  private instances: Map<string, Instance> = new Map();
  private routingStrategy: 'round-robin' | 'least-loaded' | 'latency-aware' = 'least-loaded';

  async route(request: GenerateRequest): Promise<Instance> {
    // Filter healthy instances
    const healthy = Array.from(this.instances.values())
      .filter(i => i.health === 'healthy');

    if (healthy.length === 0) {
      throw new Error('No healthy instances available');
    }

    // Select instance based on strategy
    switch (this.routingStrategy) {
      case 'round-robin':
        return this.roundRobin(healthy);
      case 'least-loaded':
        return this.leastLoaded(healthy);
      case 'latency-aware':
        return this.latencyAware(healthy, request);
    }
  }

  private leastLoaded(instances: Instance[]): Instance {
    // Select instance with lowest load
    return instances.reduce((least, instance) => {
      const leastUtil = least.current_load / least.capacity;
      const instanceUtil = instance.current_load / instance.capacity;
      return instanceUtil < leastUtil ? instance : least;
    });
  }

  private latencyAware(instances: Instance[], request: GenerateRequest): Instance {
    // Estimate latency for each instance
    const estimates = instances.map(instance => ({
      instance,
      estimated_latency: this.estimateLatency(instance, request),
    }));

    // Select instance with lowest estimated latency
    return estimates.reduce((best, curr) =>
      curr.estimated_latency < best.estimated_latency ? curr : best
    ).instance;
  }

  private estimateLatency(instance: Instance, request: GenerateRequest): number {
    // Estimate based on:
    // - Current instance load
    // - Request size
    // - Historical latency

    const queueLatency = instance.current_load * 0.1;  // Queue delay
    const processingLatency = instance.avg_latency_ms;
    return queueLatency + processingLatency;
  }

  async healthCheck(): Promise<void> {
    // Periodic health check (every 5 seconds)
    for (const [id, instance] of this.instances) {
      try {
        const start = Date.now();
        const response = await fetch(`${instance.endpoint}/health`);
        const latency = Date.now() - start;

        if (response.ok) {
          instance.health = 'healthy';
          instance.avg_latency_ms = latency;
        } else {
          instance.health = 'degraded';
        }
      } catch (error) {
        instance.health = 'unhealthy';
        console.error(`Health check failed for instance ${id}:`, error);
      }
    }
  }
}
```

### Distributed KV Cache

**Problem**: KV cache is instance-local, not shared across instances.

**Solution**: Redis-based distributed KV cache

```typescript
// src/scaling/distributed-kv-cache.ts
import Redis from 'ioredis';

class DistributedKVCache {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async get(conversation_id: string): Promise<KVCache | null> {
    const cached = await this.redis.get(`kv:${conversation_id}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  }

  async set(conversation_id: string, kv_cache: KVCache, ttl_seconds: number = 300): Promise<void> {
    await this.redis.setex(
      `kv:${conversation_id}`,
      ttl_seconds,
      JSON.stringify(kv_cache)
    );
  }

  async delete(conversation_id: string): Promise<void> {
    await this.redis.del(`kv:${conversation_id}`);
  }
}
```

### Expected Performance Gains

**Scaling Efficiency**:
```
1 instance:  180 tok/s
2 instances: 350 tok/s (97% efficiency)
3 instances: 520 tok/s (96% efficiency)
4 instances: 690 tok/s (96% efficiency)

Near-linear scaling (>95% efficiency)
```

**Availability**:
```
Single instance: 99% uptime (single point of failure)
3 instances: 99.9% uptime (N-1 redundancy)
```

**Target**: **Linear scaling to N instances**, **>95% efficiency**, **99.9% uptime**

### Feature Configuration

```yaml
# config/runtime.yaml
horizontal_scaling:
  enabled: false               # DEFAULT: disabled for safety
  load_balancer:
    strategy: 'least-loaded'   # round-robin, least-loaded, latency-aware
    health_check_interval_ms: 5000
    instances:
      - id: 'instance-1'
        endpoint: 'http://localhost:8001'
        capacity: 180
      - id: 'instance-2'
        endpoint: 'http://localhost:8002'
        capacity: 180

  distributed_cache:
    enabled: false
    redis_url: 'redis://localhost:6379'
    ttl_seconds: 300
```

---

## Testing Strategy

### Unit Tests (40+ tests)

**Weight Manager**:
- ✅ Memory pinning correctness
- ✅ Prefetch scheduling
- ✅ Warmup effectiveness
- ✅ mlock() error handling

**Priority Scheduler**:
- ✅ Priority queue ordering
- ✅ SLA deadline enforcement
- ✅ Shortest-job-first logic
- ✅ Preemption correctness

**Multi-Model Manager**:
- ✅ Model caching
- ✅ LRU eviction
- ✅ Shared weight correctness
- ✅ Fast switching

**Load Balancer**:
- ✅ Routing algorithms
- ✅ Health checking
- ✅ Failover logic

### Integration Tests (25+ tests)

**End-to-End**:
- ✅ Weight manager with real inference
- ✅ Priority scheduling under mixed load
- ✅ Multi-model switching performance
- ✅ Load balancer with multiple instances

### Performance Benchmarks

**Weight Manager Benchmark**:
```bash
npx tsx benchmarks/weight-manager-benchmark.ts

# Expected:
# P99 latency: 18.7ms → 10.8ms (-42%)
# P99 variance: ±35% → ±10%
```

**Priority Scheduler Benchmark**:
```bash
npx tsx benchmarks/priority-scheduler-benchmark.ts \
  --workload=mixed \
  --concurrency=10

# Expected:
# Avg latency (short): 6.8s → 0.2s (-97%)
# Throughput: 92 tok/s → 152 tok/s (+65%)
```

**Multi-Model Benchmark**:
```bash
npx tsx benchmarks/multi-model-benchmark.ts \
  --models=3 \
  --switches=100

# Expected:
# Cold switch: 2.5s → 0.3s (-88%)
# Warm switch: 2.5s → 0.05s (-98%)
```

**Scaling Benchmark**:
```bash
# Test with 3 instances
npx tsx benchmarks/horizontal-scaling-benchmark.ts \
  --instances=3

# Expected:
# 1 instance: 180 tok/s
# 3 instances: 520 tok/s (96% efficiency)
```

---

## Week 3 Success Metrics

### Performance Targets (Single Instance)

| Metric | Week 2 Baseline | Week 3 Target | Improvement |
|--------|-----------------|---------------|-------------|
| **Throughput** | 131-157 tok/s | **144-181 tok/s** | +10-15% |
| **P99 Latency** | 15-20ms | **10-12ms** | -33-40% |
| **P99 Variance** | ±30-40% | **±8-12%** | -70% |
| **Model Switch** | 2.5s | **<100ms** | -96% |
| **Concurrent (10req)** | 92 tok/s | **152 tok/s** | +65% |

### Scalability Targets (Multi-Instance)

| Instances | Throughput | Efficiency | Uptime |
|-----------|------------|------------|--------|
| 1x | 180 tok/s | 100% | 99% |
| 2x | 350 tok/s | 97% | 99.5% |
| 3x | 520 tok/s | 96% | 99.9% |
| 4x | 690 tok/s | 96% | 99.95% |

### Quality Targets

- ✅ **550+ tests passing** (530 → 550+)
- ✅ **0 crashes** (24-hour soak test)
- ✅ **95% SLA compliance**
- ✅ **Linear scaling** (>95% efficiency)

---

## Rollout Plan

### Stage 1: Development (Day 1-5)

**Day 1-2**: Weight Management
**Day 3-4**: Priority Scheduling
**Day 5**: Multi-Model Serving

### Stage 2: Scaling Infrastructure (Day 6)

**Day 6**: Load Balancer + Distributed Cache

### Stage 3: Deployment (Day 7)

**Day 7**: Integration testing, documentation, release

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| mlock() permission denied | Medium | Low | Graceful fallback, log warning |
| Prefetch overhead | Low | Medium | Tunable prefetch depth, disable if harmful |
| Priority scheduling complexity | Low | Medium | Extensive testing, fallback to FIFO |
| Load balancer single point of failure | Medium | High | Deploy LB in HA mode (multiple LBs) |
| Distributed cache latency | Medium | Medium | Local cache fallback, tunable TTL |

---

## Conclusion

**Week 3** delivers:
1. ✅ **+10-15% single-instance performance** (weight mgmt + scheduling)
2. ✅ **Horizontal scaling infrastructure** (scale to N instances)
3. ✅ **Multi-model serving** (<100ms switching)
4. ✅ **Production-grade reliability** (95% SLA, 99.9% uptime)

**Combined (Week 1 + 2 + 3)**:
- **Single Instance**: **+70-113%** (144-181 tok/s from 84.96 baseline)
- **3 Instances**: **520 tok/s** (6.1x baseline)

**Ready to Scale**: Week 3 Action Plan follows.
