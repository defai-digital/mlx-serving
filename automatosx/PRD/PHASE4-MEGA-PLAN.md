# Phase 4 Mega-Plan: Complete Implementation Strategy

## Executive Summary

**Goal**: Complete all 4 Phase 4 deliverables for Advanced Stream Optimization  
**Status**: Phase 4.1 core components done (80%); 4.2-4.4 pending  
**Estimated Total**: ~3 weeks (23-28 engineer-days)  
**Approach**: Incremental implementation with feature flags and continuous testing

---

## Implementation Sequence

### Week 1: Phase 4.1 Completion + Phase 4.2 Start

**Phase 4.1 Final Steps** (Days 1-2)
1. Add configuration to runtime.yaml
2. Update config/loader.ts with TypeScript types
3. Verify TypeScript compilation
4. Basic integration tests
5. Documentation

**Phase 4.2 Start: HTTP/2 Multiplexing** (Days 3-5)
1. HTTP/2 session pool manager
2. SSE writer with zero-copy chunks
3. Basic protocol benchmarks

### Week 2: Phase 4.2 Completion + Phase 4.3

**Phase 4.2 Completion** (Days 6-8)
1. WebSocket gateway fallback
2. ConnectionPool integration
3. Protocol comparison benchmarks
4. Performance validation

**Phase 4.3: TTFT Accelerator** (Days 9-12)
1. Tokenizer warm queue (TypeScript)
2. Python KV cache coordinator
3. Speculative token provider
4. Cross-language integration

### Week 3: Phase 4.4 + Integration

**Phase 4.4: QoS Telemetry** (Days 13-16)
1. SLO evaluator
2. Remediation executor
3. Policy engine
4. Chaos/soak tests

**Final Integration** (Days 17-18)
1. End-to-end testing
2. Performance benchmarks
3. Documentation
4. Rollout plan

---

## Detailed Breakdown

### Phase 4.1: Adaptive Stream Governor (FINISH)

**Files to Create/Modify**:
```yaml
config/runtime.yaml:
  streaming:
    phase4:
      adaptive_governor:
        enabled: false  # Disabled by default
        target_ttft_ms: 550
        max_concurrent: 80
        min_concurrent: 16
        pid:
          kp: 0.35
          ki: 0.08
          kd: 0.15
          integral_saturation: 200
          sample_interval_ms: 200
        cleanup:
          sweep_interval_ms: 100
          max_stale_lifetime_ms: 500
        tenant_budgets:
          default:
            hard_limit: 20
            burst_limit: 32
            decay_ms: 60000
```

```typescript
// src/config/loader.ts additions
interface Config {
  // ... existing ...
  streaming: {
    phase4: {
      adaptive_governor: {
        enabled: boolean;
        target_ttft_ms: number;
        max_concurrent: number;
        min_concurrent: number;
        pid: {
          kp: number;
          ki: number;
          kd: number;
          integral_saturation: number;
          sample_interval_ms: number;
        };
        cleanup: {
          sweep_interval_ms: number;
          max_stale_lifetime_ms: number;
        };
        tenant_budgets: Record<string, {
          hard_limit: number;
          burst_limit: number;
          decay_ms: number;
        }>;
      };
    };
  };
}
```

**Testing**: Unit tests for PID controller, integration test with StreamRegistry

---

### Phase 4.2: Transport Multiplexing

**New Files**:
```
src/transport/http2/Http2Pool.ts
src/transport/http2/SessionManager.ts
src/transport/http2/SseWriter.ts
src/transport/ws/WebSocketGateway.ts
benchmarks/streaming/protocol_bench.ts
```

**Core Components**:

1. **Http2Pool** (~300 lines)
   - Session pooling (max 16 sessions)
   - Stream allocation (100 streams/session)
   - GOAWAY handling
   - Backpressure tracking

2. **SseWriter** (~200 lines)
   - Zero-copy chunk reuse
   - Header compression
   - Event formatting (data, id, retry)
   - Backpressure via response.write()

3. **WebSocketGateway** (~250 lines)
   - Bidirectional control
   - Frame size limits
   - Heartbeat/ping handling
   - Integration with StreamingController

4. **Benchmark Harness** (~150 lines)
   - HTTP/1.1 vs HTTP/2 comparison
   - Concurrency tiers: 32/50/75/100
   - Metrics: TTFT, throughput, CPU, connections

**Expected Impact**: 15-20% faster TTFT, 20% lower CPU

---

### Phase 4.3: TTFT Accelerator Pipeline

**New Files**:
```
src/streaming/pipeline/ttft/TokenizerWarmQueue.ts
src/streaming/pipeline/ttft/HintHasher.ts
src/streaming/pipeline/ttft/SpeculativeProvider.ts
python/runtime/ttft.py
python/runtime/kv_prep_coordinator.py
```

**Core Components**:

1. **TokenizerWarmQueue** (~200 lines)
   - Priority queue by estimated tokens
   - TTL-based expiry (800ms)
   - Overflow handling
   - Integration with StreamingController admission

2. **SpeculativeProvider** (~150 lines)
   - Prompt hash → candidate tokens
   - Success/failure tracking
   - Rollback on mismatch
   - Allowlist-based enablement

3. **Python KV Coordinator** (~200 lines)
   - gRPC metadata listener
   - KV cache prefetch
   - First-token speculation
   - Status events

**Expected Impact**: 30-40% drop in median TTFT

---

### Phase 4.4: Stream QoS Telemetry

**New Files**:
```
src/streaming/qos/QosEvaluator.ts
src/streaming/qos/RemediationExecutor.ts
src/streaming/qos/SloPolicyStore.ts
tests/streaming/chaos_test.ts
```

**Core Components**:

1. **QosEvaluator** (~250 lines)
   - 60-second sliding window
   - TDigest percentiles
   - SLO breach detection
   - Policy matching

2. **RemediationExecutor** (~200 lines)
   - Action dispatcher
   - Cooldown tracking
   - Loop detection
   - Safe-mode escalation

3. **Policies** (config-driven)
   - Per-tenant SLOs
   - Action sequences
   - Severity levels
   - Alert channels

**Expected Impact**: <0.5% infra cancellations, auto-remediation

---

## Testing Strategy

### Unit Tests
- PID controller (steady-state, step response, windup)
- Cleanup scheduler (out-of-order events)
- HTTP/2 session manager (GOAWAY, RST_STREAM)
- Tokenizer warm queue (ordering, TTL, overflow)
- QoS policy parser (validation)

### Integration Tests
- Governor + StreamRegistry
- HTTP/2 + StreamingController
- TTFT pipeline + Python runtime
- QoS + Governor interaction

### Benchmarks
- Protocol comparison (HTTP/1.1 vs HTTP/2)
- TTFT with/without pipeline
- Throughput at various concurrency levels
- CPU/memory usage

### Soak Tests
- 24-hour @ 75 concurrent streams
- Chaos injection (network failures)
- Tenant burst scenarios
- Safe-mode fallback validation

---

## Success Criteria (All Phase 4)

| Metric | Baseline | Target | Tool |
|--------|----------|--------|------|
| Median TTFT | ~1100ms | ≤550ms | benchmark |
| P95 TTFT | ~1800ms | ≤900ms | soak test |
| Throughput | 100% | +30% | benchmark |
| Max Streams | 50 | 75 | soak test |
| Connection Overhead | 100% | -40% | protocol bench |
| Infra Cancellations | N/A | <0.5% | QoS metrics |

---

## Risk Mitigation

### Technical Risks
1. **HTTP/2 TLS Config**: Requires Node 20+, proper certs
   - Mitigation: Fallback to HTTP/1.1, test certificates

2. **TTFT Speculation Mismatch**: Wrong tokens sent to client
   - Mitigation: Correction events, allowlist-only enablement

3. **QoS Remediation Loops**: Oscillation between states
   - Mitigation: Cooldown periods, loop detection, manual override

### Operational Risks
1. **Feature Flag Misconfiguration**: Accidentally enable unstable features
   - Mitigation: All features default disabled, canary rollout

2. **Performance Regression**: New features slower than baseline
   - Mitigation: Benchmark gates in CI, rollback procedures

3. **Integration Conflicts**: Phase 4 breaks existing functionality
   - Mitigation: Backward compatibility tests, feature isolation

---

## Rollout Plan

### Phase 4.1 Rollout
1. Deploy with `enabled: false`
2. Enable for internal testing (10%)
3. Monitor PID behavior, adjust gains
4. Gradual rollout: 10% → 50% → 100%

### Phase 4.2 Rollout
1. Deploy HTTP/2 with fallback
2. Test with small batch (5%)
3. Protocol comparison benchmarks
4. Enable for 50% → 100%

### Phase 4.3 Rollout
1. Deploy with speculation disabled
2. Enable warm queue only (no speculation)
3. Add allowlist prompts gradually
4. Monitor mismatch rates

### Phase 4.4 Rollout
1. Deploy with QoS in observe-only mode
2. Validate breach detection
3. Enable remediation for low-severity actions
4. Full automation after 1-week soak

---

## Dependencies & Prerequisites

### Infrastructure
- Node.js 20+ for HTTP/2
- TLS certificates configured
- gRPC metadata support for Python coordination

### Code
- Phase 3 StreamingController operational
- Existing StreamRegistry working
- Metrics infrastructure available

### Testing
- Benchmark harness extended
- Chaos testing framework
- 24-hour soak test environment

---

## Timeline

**Total**: 18 working days (~3.6 weeks for 1 engineer, ~2 weeks for 2 engineers)

**Parallel Track Optimization**:
- Week 1: 4.1 completion (1 eng) + 4.2 start (1 eng)
- Week 2: 4.2 finish + 4.3 (both engineers)
- Week 3: 4.4 (1 eng) + testing/integration (1 eng)

**Milestones**:
- Day 5: Phase 4.1 complete, TypeScript compiling
- Day 10: HTTP/2 working, benchmarks show improvement
- Day 15: TTFT accelerator functional, metrics tracked
- Day 18: QoS active, all Phase 4 features integrated

---

## Next Immediate Actions

1. **Finish Phase 4.1 Configuration** (30 min)
   - Add YAML config
   - Update TypeScript types
   - Run typecheck

2. **Verify Phase 4.1 Compilation** (15 min)
   - `npm run typecheck`
   - Fix any import/export issues

3. **Begin Phase 4.2 Implementation** (Day 1-2)
   - Create Http2Pool skeleton
   - Implement SessionManager
   - Basic SSE writer

4. **Continuous Testing** (Throughout)
   - Unit test each component
   - Integration test after each phase
   - Benchmark before/after

---

**Document**: Phase 4 Mega-Plan  
**Created**: 2025-11-08  
**Author**: Claude Code (Anthropic)  
**Status**: Ready for execution
