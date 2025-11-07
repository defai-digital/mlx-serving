# KR Serve MLX v1.2.0 – Generate Request Batching Architecture

> **Catchphrase:** Great architecture is invisible - it enables teams, evolves gracefully, and pays dividends over decades.

## Purpose & Outcomes
- Ship generation batching in v1.2.0 with a 5⭐ priority, targeting **≥90% reduction in JSON‑RPC generate() invocations** under load.
- Preserve per-request semantics (stream IDs, cancellation, telemetry) while collapsing IPC chatter.
- Provide a forward-compatible architecture that can evolve with speculative decoding, guardrails, and future model orchestration.

Success Criteria:
- IPC reduction ≥90% when ≥8 concurrent generate requests arrive within the batching window.
- Added latency from queuing ≤4 ms p95; no regression to first-token time p50.
- Works with existing StreamRegistry backpressure and abort semantics without code changes in calling code.

## Current State
1. `GeneratorFactory.createGenerator()` registers a stream with `StreamRegistry`, then calls `JsonRpcTransport.request('generate', …)` per request.
2. Python runtime handles each request individually, spawning a `stream_generate()` task per stream.
3. Transport-level multiplexing only covers non-streaming RPCs (`tokenize`, `check_draft`). There is no combine for `generate`.
4. Every generation handshake costs one IPC round-trip, limiting throughput and increasing context switching cost.

### Pain Points
- High-churn workloads (chat UIs, batch summarization) issue tens of requests per second → runtime spends measurable CPU on framing JSON alone.
- No priority awareness; urgent UI streams contend with background speculative fetches.
- Unable to reason about batching telemetry for streaming operations.

## Target Architecture Overview
```
Engine.createGenerator()
    │
    │ 1. StreamRegistry.register(streamId,…)
    │
    ├─► GenerateBatcher.enqueue(request, opts)
    │          │
    │          ├─ hold ≤3 ms (priority-aware window)
    │          ▼
    ├─► JsonRpcTransport.request('batch_generate', {requests:[…]})
    │          │
    │          ▼
    ├─◄ Batch response fan-out (per-request promise resolution)
    │
    ▼
StreamRegistry handles stream.* notifications (unchanged)

Python runtime:
batch_generate()
  ├─ validate & group by model
  ├─ await self.generate(req) per entry (asyncio.gather)
  └─ return [{success,result|error}] with isolation
```

## TypeScript Layer – `GenerateBatcher`

### Responsibilities
- Queue `generate` envelopes before they hit the transport.
- Honor per-request `AbortSignal`, timeout, and priority hints.
- Dispatch `batch_generate` calls and de-multiplex responses.
- Feed back metrics for adaptive sizing and governance dashboards.

### API
```ts
type GeneratePriority = 'urgent' | 'default' | 'background';

interface GenerateBatchOptions {
  priority?: GeneratePriority;
  signal?: AbortSignal;
  timeoutMs?: number;
  telemetry?: { requestId: string };
}

batcher.enqueue(rpcParams: GenerateParams, options?: GenerateBatchOptions): Promise<GenerateResponse>
```

`GeneratorFactory` will:
1. Acquire/keep streamId as today.
2. Register stream with `StreamRegistry`.
3. Call `generateBatcher.enqueue()` instead of `transport.request('generate', …)`.
4. Fall back to single request when batcher is disabled or runtime lacks the capability.

### Queue Structure
- **Partition key:** `(model_id, draft_model?, guidance?.mode)` to avoid mixing fundamentally different execution paths. Keeps speculative decoding pairs together.
- **Entry fields:** request payload, resolve/reject callbacks, `enqueuedAt`, `priority`, `signal`, `timeoutMs`.
- **Priority tiers:** urgent=high (UI interactions, default when `options.priority==='urgent'` or `signal` already aborted soon), default=normal, background=low (pre-warm, analytics).

### Batching Window Strategy
- **Bi-modal hold:**
  - `min_hold_ms` = 0.75 ms for urgent/default traffic when queue length < target.
  - `max_hold_ms` = 3 ms absolute cap (configurable).
- **Adaptive per priority:**
  - Urgent: immediate flush if queue non-empty.
  - Default: wait until `min_hold_ms`, extend to `max_hold_ms` only when batch size below minimum.
  - Background: may hold up to `max_hold_ms + 2 ms` to accumulate work but never block urgent flushes (background entries stored separately and siphoned into upcoming batch if slots remain).
- Timer resets on flush. Implementation reuses a small timer pool to avoid GC churn.

### Priority Queue Mechanics
- Maintain three internal FIFO deques (urgent/default/background) per partition.
- Dispatch order per batch: consume urgent first, then default, then background to fill target size.
- Background entries can be preempted: if queue is full of background work and an urgent request arrives, flush occurs immediately even if batch below minimum.
- Provide instrumentation counters: `enqueuedByPriority`, `promotedBackground`, `urgentFlushes`.

### Adaptive Batch Sizing
- Track rolling metrics (window = last 100 batches):
  - `batch_dispatch_ms` (transport request duration).
  - `queue_wait_ms` (dispatch time − enqueue time).
  - `active_streams` snapshot from `StreamRegistry`.
- Compute dynamic target size:
  - Base target = configured `min_batch_size` (default 2).
  - If `queue_wait_p95 < 1.5 ms` **and** `batch_dispatch_p50 < target_batch_time_ms` (default 12 ms) **and** `active_streams` < `stream_limit * 0.8`, increase target by 2 (clamped to `max_batch_size`).
  - If `queue_wait_p95 > 4 ms` **or** dispatch time exceeds target by 30%, reduce target by half (down to minimum).
- Allow burst override: when `StreamRegistry` reports available slots < requested batch size, shrink batch to remaining capacity to avoid oversubscription.
- Expose `getStats()` for telemetry pipelines and CLI debugging (mirrors existing `BatchQueue` stats layout).

### Integration with StreamRegistry & Transport
- `GenerateBatcher` receives a reference to `StreamRegistry` to read `getActiveCount()` and optionally expose `getCapacitySnapshot()` (new helper returning `{ active, limit }`).
- Registration order remains unchanged: `GeneratorFactory` registers before enqueueing, ensuring we do not lose early notifications.
- Abort handling:
  - Before dispatch: if signal aborts, remove entry, cancel `StreamRegistry` handle, reject promise.
  - After dispatch: rely on existing `StreamRegistry` cancellation semantics (unchanged).
- Transport call uses existing retry & circuit-breaker path: `transport.request('batch_generate', ...)`.
- Backpressure: when `StreamRegistry` emits `backpressure` or `slowConsumer`, batcher pauses new dispatches (configurable `pause_on_backpressure_ms`, default 20 ms) to allow consumers to catch up.

### Telemetry
- Emit events via existing telemetry hooks (`telemetry?.onBatchDispatched`) capturing:
  - Batch size, hold time, priority mix, dispatch duration.
  - Rejection counts (e.g., due to capability fallback or aborts).
- Feed metrics into `engine.getBatchStats()` (extend response with `generate` section).

## Python Layer – `batch_generate`

### Handler Contract
```python
async def batch_generate(self, params: Dict[str, Any]) -> Dict[str, Any]:
    # params: {"requests": [GenerateParams & {"stream_id": str}]}
    # returns: {"results": [{"success": bool, "result": {...} | None, "error": str | None}]}
```

### Flow
1. Validate `requests` is a non-empty list; short-circuit to `{"results": []}` when empty.
2. Group entries by `(model_id, draft_model)` purely for diagnostics (generation still per-request).
3. Create tasks:
   - For each request, call `self.generate(req)` *directly* (reuse existing logic for validation, stream task creation, telemetry).
   - Wrap in try/except; convert exceptions via `_serialize_error`.
   - Preserve order by storing index alongside task.
4. Await using `asyncio.gather(..., return_exceptions=True)` to avoid cascading failures.
5. Assemble result array aligning with original ordering.

### Additional Considerations
- Enforce per-request stream ID uniqueness; raise an informative error when duplicates detected inside a batch (prevents clobbering `self.stream_tasks`).
- Optional telemetry: record batch size, processing time, dispatch groups (for future tuning).
- Advertise new capability in `runtime/info`: add `"batch_generate"`.
- Maintain backwards compatibility by keeping `generate` unchanged.

## Backwards Compatibility Strategy
- **Capability detection:** extend `engine.ensureRuntime()` to require `info.capabilities.includes('batch_generate')` before enabling the new batcher. Otherwise `GeneratorFactory` continues to call single `generate`.
- **Config toggle:** `config/runtime.yaml` gains `generate_batcher` section with `enabled`, `min_batch_size`, `max_batch_size`, `min_hold_ms`, `max_hold_ms`, `target_batch_time_ms`, `pause_on_backpressure_ms`, etc. Disabled → transparent fallback.
- **Fallback path:** even when enabled, individual requests bypass batching when:
  - Custom retry/timeout options incompatible with group semantics (configurable allow-list).
  - Debug flag `KR_MLX_DISABLE_GENERATE_BATCHING=1` set (for on-call mitigation).

## Implementation Plan

1. **Configuration & Capability Plumbing**
   - Add `generate_batcher` config block + typed loader support.
   - Update `runtime/info` & TypeScript capability check.
   - Extend `GeneratorFactoryOptions` to accept `generateBatcher`.

2. **TypeScript: GenerateBatcher**
   - Implement new class in `src/core/generate-batcher.ts` (mirrors `BatchQueue` structure).
   - Wire into `GeneratorFactory` (constructor injection, fallback logic, option for priority).
   - Extend `CreateGeneratorOptions` with `priority?: 'urgent' | 'default' | 'background'`.
   - Update telemetries & `engine.getBatchStats()` to surface new metrics.

3. **Python Runtime**
   - Implement `batch_generate` method reusing `self.generate`.
   - Register handler in `handle_request` switch & capability list.
   - Add regression tests for mixed-success batch responses.

4. **Integration & Observability**
   - Add CLI flag / API to pull batch stats (extend `BatchQueue` interfaces).
   - Update docs (README batching section, changelog).
   - Leverage existing telemetry hooks to capture batch metrics.

5. **Testing**
   - Unit tests: `GenerateBatcher` scheduling logic, abort semantics, adaptive resizing.
   - Integration tests (Node ↔ Python): verify multi-request call results in single `batch_generate`.
   - Load test scenario (benchmarks/): confirm ≥90% IPC drop and latency guardrails.
   - Backwards compatibility test with mocked runtime lacking capability.

6. **Rollout**
   - Ship behind config flag default-on for v1.2.0.
   - Provide runtime health metric dashboards (batch success/failure counts, queue latency).
   - Post-launch monitor IPC metrics and adjust config defaults if needed.

## Risks & Mitigations
- **Risk:** Queueing adds latency for low-concurrency workloads.  
  _Mitigation:_ `min_hold_ms < 1 ms`, dynamic shrink to 1-request batches when concurrency low.
- **Risk:** Burst of batched requests exceeds StreamRegistry limit.  
  _Mitigation:_ consult `streamRegistry.getActiveCount()` before dispatch; throttle when near limit.
- **Risk:** Abort semantics regress (request cancelled while queued).  
  _Mitigation:_ explicit signal listeners per entry; immediate removal + stream cancel before dispatch.
- **Risk:** Python runtime errors inside one request poison others.  
  _Mitigation:_ `asyncio.gather(..., return_exceptions=True)` with per-index result assembly.

## Observability & Metrics
- Extend telemetry payloads with:
  - `generate_batcher.batch_size`
  - `generate_batcher.queue_wait_ms` (p50/p95)
  - `generate_batcher.priority_mix`
  - `generate_batcher.fallback_count`
- Add `engine.getBatchStats().generate` section for CLI debugging (`kr serve status` style command).
- Compare IPC counts pre/post (transport exposes `multiplexer.stats`) to confirm ≥90% reduction.

## Open Items
- Determine default priority mapping from API surface (e.g., streaming UI = urgent, background summarization jobs explicit).
- Validate `StreamRegistry` API additions (e.g., `getCapacitySnapshot`) to avoid leaking private fields.
- Align telemetry schema with AutomatosX dashboards (Queenie to help once instrumentation is ready).

---

By delivering this architecture we tighten the feedback loop between TypeScript and Python, de-risk streaming workloads, and create a foundation that can scale with future concurrency and guardrail features—making the architecture effectively invisible while it quietly pays dividends for years.
