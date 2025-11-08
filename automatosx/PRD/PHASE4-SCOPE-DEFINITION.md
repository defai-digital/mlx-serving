# Phase 4 Scope – Advanced Stream Optimization

## 1. Context & Current State
- **Project**: mlx-serving performance optimization (TypeScript + Python hybrid serving runtime).
- **Current performance**: ~96% of mlx-engine baseline when adaptive stream features are disabled due to race-condition bugs (`config/runtime.yaml`).
- **Phases 1-3 delivered**: caching layer, multi-worker runtime, adaptive batching, resilience, streaming controller, lifecycle optimizations.
- **Remaining gap**: Streaming stack operates in “safe mode.” Adaptive limits are off, batching is conservative, and transport still uses HTTP/1.1 long polling. This suppresses concurrency gains achieved elsewhere and keeps TTFT above enterprise SLOs.
- **Production risk**: Without predictable TTFT and high-concurrency streaming, customer-facing workloads (conversational UX, assistants, internal copilots) experience lag spikes and stream rejection. Observability and GPU work add value later, but unblocking streaming is the fastest route to ROI and unlocks the already-built caching + multi-worker architecture.

## 2. Option Evaluation

| Option | Value | Effort | Key Risks | Verdict |
|--------|-------|--------|-----------|---------|
| **A. Observability & Monitoring** | Improves visibility but does not unblock throughput or TTFT. | Medium | Insight without remediation still leaves poor UX. | Schedule post-streaming; not Phase 4. |
| **B. Testing & Validation** | Raises confidence but does not deliver net-new capability. Can be embedded alongside feature work. | Medium-High | Hard to justify without unblocking features first. | Integrate test coverage into Phase 4, but not the headline focus. |
| **C. Advanced Stream Optimization** | Directly targets bottleneck preventing Phase 3 gains, boosts TTFT + concurrency, fixes disabled config. | Medium | Requires coordination across TS + Python + transport layers. | **Chosen focus** – highest ROI and removes production blocker. |
| **D. GPU Optimization & Batching** | Potential long-term upside (speculative decoding, KV cache sharing) but high complexity and GPU-specific tuning. | High | Needs stable streaming foundation first; higher R&D risk. | Defer until streaming stable. |

**Decision**: Invest Phase 4 in **Advanced Stream Optimization** to unlock the expected 120-150% performance envelope and deliver user-perceived responsiveness improvements that drive adoption.

## 3. Phase 4 Goals & Success Metrics
1. **TTFT Reliability**: Median Time-To-First-Token ≤ **550 ms** and 95p ≤ **900 ms** for Gemma 2 27B at 32 concurrent streams (down from ~1.1 s median today).
2. **Throughput Boost**: ≥ **30%** tokens/sec improvement on streaming workloads vs. current Phase 3 build, measured via benchmarks/gemma27b-stream-high-concurrency.
3. **Stream Capacity**: Support **75 concurrent active streams** with <2% rejection rate and auto-scale down within 5 s when load drops.
4. **Protocol Efficiency**: Reduce per-request connection overhead by **40%** via HTTP/2 multiplexing + SSE/WebSocket fallback, keeping bandwidth overhead <5%.
5. **Stability**: <0.5% stream cancellations attributable to infrastructure (tracked via per-stream metrics) across 24h soak tests.

## 4. Scope & Deliverables

### 4.1 Adaptive Stream Governor (Bug Fix + Control Loop Hardening)
- **Description**: Repair stream cleanup timing bug, re-enable `adaptive_limits`, and tune control-loop parameters (min/max streams, utilization thresholds, TTFT target).
- **Deliverables**:
  - Deterministic cleanup scheduler tied to StreamRegistry lifecycle events.
  - PID-style controller leveraging per-stream TTFT/latency metrics.
  - Feature flag + canary plan to re-enable adaptive limits progressively.
- **Expected impact**: +10-15% throughput via better concurrency utilization; stream rejection <2%.
- **Estimate**: 6 engineer-days (TypeScript + runtime tuning).

### 4.2 Transport Multiplexing & Protocol Upgrade
- **Description**: Introduce HTTP/2 multiplexing for all streaming endpoints with SSE default and WebSocket fallback for clients requiring bidirectional control.
- **Deliverables**:
  - Shared connection pool supporting parallel streams over HTTP/2.
  - SSE writer with zero-copy chunk reuse (integrates with existing chunk pooling).
  - WebSocket gateway for interactive clients, reusing StreamingController.
  - Benchmark harness comparing HTTP/1.1 vs HTTP/2 under 50, 75, 100 concurrent streams.
- **Expected impact**: 15-20% faster TTFT (fewer TCP handshakes), 20% lower CPU per stream.
- **Estimate**: 8-10 engineer-days (backend + infra).

### 4.3 TTFT Accelerator Pipeline
- **Description**: Reduce warm-up latency by prefetching model context, pipelining tokenizer->runtime work, and enabling “speculative first tokens” for deterministic prompts.
- **Deliverables**:
  - Tokenizer warm queue + request hinting (model params hashed).
  - Python runtime hook that starts KV cache prep upon stream registration.
  - Config-driven “first-token speculation” toggle with safeguards.
  - Metrics tying TTFT to each stage (enqueue, prep, first token emitted).
- **Expected impact**: 30-40% drop in median TTFT, better perceived responsiveness.
- **Estimate**: 5-7 engineer-days (TS coordination + Python hooks).

### 4.4 Stream QoS Telemetry & Auto-Remediation
- **Description**: Build guardrails that detect slow consumers/backpressure, throttle per-tenant streams, and trigger rollback to safe config if SLOs are violated.
- **Deliverables**:
  - SLO evaluator consuming per-stream metrics every 10 s.
  - Policy engine that adjusts stream limits or protocol mode (HTTP/2 → HTTP/1.1 fallback) automatically.
  - Alerting hooks (even basic logs/webhooks) for sustained SLO breaches.
  - Chaos/soak tests validating policy responses.
- **Expected impact**: Keeps error budget healthy, prevents regressions when features re-enabled.
- **Estimate**: 4-5 engineer-days (policy logic + testing).

## 5. Effort, Timeline & Dependencies
- **Total effort**: ~23-28 engineer-days (~4 weeks for a 2-person squad: TS + Python/infra).
- **Dependencies**:
  - Phase 3 StreamingController & per-stream metrics (already built) must remain stable.
  - Coordinated changes to `config/runtime.yaml` and streaming clients.
  - Benchmark harness + perf baselines (ensure reproducible test data before toggling flags).
- **Milestones**:
  1. Week 1: Adaptive Stream Governor fixes + soak tests.
  2. Week 2: HTTP/2 multiplexing + protocol benchmarks.
  3. Week 3: TTFT accelerator in staging, metric instrumentation.
  4. Week 4: QoS policy automation + production canary, final benchmarks.

## 6. Success Measurement Plan
- **Benchmarks**: Extend `benchmarks/streaming` suite to capture TTFT, throughput, CPU, and rejection rates before/after each feature flag change.
- **Rollout Strategy**: Feature flags per deliverable, canary on 10% traffic, bake for 48h before global enablement.
- **Exit Criteria**: All success metrics in Section 3 met or exceeded across two benchmark runs and one 24h soak test; regression suite (unit + integration) green; rollback plan validated.

## 7. Out of Scope
- GPU-side speculative decoding, KV cache sharing, or PagedAttention (Phase 5 candidate).
- New observability stack (Prometheus/Grafana) beyond targeted stream metrics needed for control loops.
- Broad test automation overhaul (only stream-focused validation is in scope).

---

Build the right thing, not just things right: Phase 4 doubles down on user-perceived latency and reliability so platform teams can trust mlx-serving for production-grade, real-time applications.
