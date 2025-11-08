# mlx-serving Performance Optimization PRD

## 1. Executive Summary
mlx-serving currently delivers 94–96% of mlx-engine throughput while unlocking advanced TypeScript-driven orchestration capabilities. To convert this architectural advantage into durable market differentiation, we will execute a three-phase optimization program that adds request-level intelligence, multi-worker scaling, and production-grade resilience. Combined, these phases aim to elevate mlx-serving to 120–150% of mlx-engine performance under real-world concurrency while maintaining a 100% success rate. The initiative focuses on outcomes for platform engineers and product teams who need predictable low-latency inference, operational safety, and observability out of the box.

## 2. Problem Statement
- Customers perceive mlx-serving as “almost as fast” as mlx-engine, making it hard to justify adopting the more complex hybrid stack.
- Duplicate-heavy workloads (chat support bots, content personalization) waste compute because identical prompts are handled independently.
- Python-side single-worker bottlenecks limit horizontal scaling despite Node.js being able to sustain 10k+ concurrent connections.
- Lack of adaptive batching and resiliency patterns increases tail latency when load spikes, constraining peak throughput.
- Without a clear performance roadmap and milestones, stakeholders lack confidence in prioritizing mlx-serving for production launches.

## 3. Goals & Success Metrics
| Goal | Metric | Target |
| --- | --- | --- |
| Surpass mlx-engine throughput on duplicate-heavy workloads | Tok/s vs mlx-engine for Qwen3-30B | ≥110% by end of Phase 1 |
| Improve overall throughput under mixed workloads | Avg tok/s across benchmark suite | ≥105% by end of Phase 2 |
| Sustain high performance at 100+ concurrent users | Tok/s @ P95 latency < 120ms | ≥120% of mlx-engine by end of Phase 3 |
| Maintain reliability | Success rate | 100% |
| Enhance observability | Metrics coverage | Add request dedupe, batching, worker health dashboards |

## 4. User Stories
1. **Platform Engineer**: “As a platform engineer, I need mlx-serving to dedupe identical prompts automatically so I can shrink GPU bills without writing custom caching logic.”
2. **Inference SRE**: “As an SRE, I want adaptive batching and multi-worker routing so I can meet latency SLOs during traffic spikes without manual reconfiguration.”
3. **Product Owner**: “As a product owner, I need clear telemetry and restart-safe upgrades so I can ship features without fear of downtime.”
4. **Data Scientist**: “As a data scientist, I want consistent throughput across model families so my experimentation workflows don’t stall.”

## 5. Technical Requirements
### Phase 1 – Quick Wins (1–2 days)
- **Request Deduplication**: 1-second TTL cache at TypeScript layer keyed by model + prompt fingerprint. Serve cached tokens and metrics.
- **Prompt Cache (LRU 10k entries)**: Configurable capacity, eviction stats, manual flush API.
- **Request Coalescing**: Merge identical concurrent requests into a single Python inference; fan-out streaming responses.
- **Metrics**: Counters for cache hits, coalesced groups, saved tok/s; dashboards in Grafana template.

### Phase 2 – Advanced Scaling (1 week)
- **Multi-worker Routing**: Run multiple Python processes per model with round-robin (default) and latency-aware (beta) policies; health checks and back-pressure.
- **Adaptive Batching**: Port kr-serve-mlx batching heuristics; dynamic batch size based on queue depth and latency budget with per-model overrides.
- **Smart Retry Logic**: Exponential backoff with jitter for transient Python worker failures; configurable retry budget with tracing annotations.
- **Observability**: Traces linking API request → worker → model; add per-worker utilization metrics.

### Phase 3 – Production Hardening (2 weeks)
- **Connection Pooling**: Reuse Python IPC/HTTP connections; maintain warm pools with leak detection.
- **Streaming Optimizations**: Chunk rebalancing to reduce head-of-line blocking; flow control for slow clients.
- **Memory Management**: Auto-unload idle models; pre-warm frequently accessed models; expose admin API hooks.
- **Zero-downtime Restarts**: Rolling worker upgrades with draining; watchdog ensuring traffic never drops below redundancy threshold.
- **Fault Tolerance**: Graceful degradation (serve cached responses, downscale batch size) and configurable fallbacks.

## 6. Architecture Diagrams (Descriptions)
1. **Phase 1 Flow**: Client → Node.js API (dedupe + coalescing cache) → Single Python worker → Model. Diagram highlights cache lookup path, coalesced promise fan-out, cache metrics bus.
2. **Phase 2 Flow**: Client → API layer → Routing fabric (round-robin / latency-aware) → Worker pool → Adaptive batcher → Model. Show retry loop and telemetry pipeline to Prometheus/OpenTelemetry.
3. **Phase 3 Flow**: Multi-stage pipeline with connection pool, streaming controller, memory manager, and rolling restart coordinator. Emphasize watchdog feedback loop and fault-tolerance circuit breakers.

## 7. Risk Analysis
| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cache inconsistency or stale data | Wrong responses delivered | Short TTL, cache versioning, per-request bypass flag |
| Coalescing delays | Added latency for long-running prompts | Timeout fallback to individual requests, per-model toggles |
| Multi-worker synchronization bugs | Crashes or double work | Health probes, circuit breakers, canary deployment |
| Adaptive batching regression | P95 latency spikes | Guardrails: max batch size, latency SLA alarms |
| Connection pooling leaks | Resource exhaustion | Pool monitoring, auto-prune, integration tests |
| Zero-downtime restart complexity | Operational errors | Runbooks, staged rollout, observability alerts |

## 8. Timeline & Milestones
| Phase | Duration | Milestones |
| --- | --- | --- |
| Phase 1 | Days 1–2 | Caching subsystem merged, cache metrics dashboards live, benchmark report showing ≥110% tok/s on duplicate workloads |
| Phase 2 | Days 3–9 | Worker pool GA, adaptive batching enabled on Qwen3/Gemma models, reliability report with 0 regressions |
| Phase 3 | Days 10–24 | Connection pooling + streaming optimizations in prod, memory manager + zero-downtime restart verified in staging, final benchmark hitting ≥120% throughput at 100 concurrency |

## 9. Acceptance Criteria
- [ ] Phase 1 benchmarks show ≥110% tok/s vs mlx-engine for duplicate-heavy tests while keeping 100% success rate.
- [ ] Phase 2 mixed workload benchmark improves ≥5% over baseline with no increase in P95 latency.
- [ ] Phase 3 high-concurrency benchmark (≥100 concurrent users) sustains ≥120% throughput with P95 latency < 120ms.
- [ ] Observability dashboards cover cache metrics, worker health, batch sizes, and restart status.
- [ ] Runbooks/docs published for enabling/disabling each feature flag.

## 10. Testing Strategy
- **Unit Tests**: Cache eviction logic, request fingerprinting, routing selection, retry/backoff, connection pool lifecycle.
- **Integration Tests**: End-to-end duplicate request scenarios, multi-worker failover, adaptive batching under synthetic load, zero-downtime restart rehearsals.
- **Load Tests**: Benchmark suite leveraging Qwen3-30B and Gemma 2 27B at increasing concurrency, measuring tok/s, success rate, P95/P99 latency.
- **Chaos / Fault Injection**: Simulate worker crashes, network jitter, slow clients to validate retries, flow control, and degradation paths.
- **Observability Validation**: Ensure metrics/traces/logs capture dedupe hits, batch sizes, worker states; verify dashboard alerts fire on threshold breaches.
