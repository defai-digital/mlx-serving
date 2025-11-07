# mlx-serving Architecture Analysis

## Purpose & Scope
- Capture the current state of `kr-serve-mlx` so we can rebrand and extend it as **mlx-serving**, keeping the TypeScript↔Python↔MLX bridge intact while leaning harder into TypeScript, Zod, and ReScript.
- Focus areas requested by Tony: understand the architecture layers (TypeScript API, Python bridge, MLX runtime), core production features (model lifecycle, streaming, structured output, multimodal support, GPU scheduler), technology stack, and modernization opportunities (broader Zod coverage, ReScript adoption, native module preservation).

## Architecture Overview
```
TypeScript API & Control Plane (src/api, src/core, src/config)
    • Engine facade (`src/api/engine.ts`) exposes async generators, telemetry hooks, EventEmitter events
    • Core services (`src/core/*`) manage queues, artifact cache, batching, model metadata
    • Config loader/normalizer (`src/config/*`, `src/compat/*`), telemetry bridge, CLI/postinstall scripts
        ↓ JSON-RPC 2.0 (Zod schemas in `src/bridge/serializers.ts`)
Python Bridge Layer (src/bridge/*)
    • `PythonRunner` (`src/bridge/python-runner.ts`) spawns & supervises python/runtime.py via execa/spawn
    • `JsonRpcTransport`, stream registry, notification router, ops multiplexer manage IPC sequencing
        ↓
Python Runtime & MLX Execution (python/*)
    • `python/runtime.py` handles requests, dispatches to adapters and MLX wrappers
    • `python/models/*` provides loaders, generators, tokenizer, vision loader, GPU scheduler
    • Structured output via Outlines adapter, telemetry exporter, GPU scheduler guardrails
        ↓
MLX / Metal Runtime (3rd-party) — no direct TS bindings; invoked via Python MLX APIs
```

### TypeScript API Layer
- **Engine facade** (`kr-serve-mlx/src/api/engine.ts`): EventEmitter-based surface that normalizes camelCase/snake_case calls, manages lifecycle (start/shutdown), wraps model, generator, and telemetry services. Implements circuit-breaker logic for the bridge and exposes async generators for token streaming.
- **Core services** (`src/core/model-manager.ts`, `generate-batcher.ts`, `request-queue.ts`, etc.): Provide model caching, concurrency limits, request batching, and metadata reconciliation. Warmup + artifact cache (`ModelArtifactCache`) reduce cold-start latency and reuse model weights on disk/memory.
- **Compatibility & config** (`src/compat/config-normalizer.ts`, `src/config/*.ts`): Accept mlx-engine style parameters, normalize them, and load YAML runtime config once (`initializeConfig()` call inside the Engine constructor).
- **Telemetry layer** (`src/telemetry/bridge.ts`, `src/telemetry/otel.ts`): Bridges OpenTelemetry from the TS side and reports runtime metrics exposed by the Python process.

### Python Bridge Layer
- **PythonRunner**: Spawns `.kr-mlx-venv` python runtime using `spawn`, enforces startup timeouts, restarts, readiness probes, stdout/stderr handlers, and memory monitoring. Uses `stream-registry` to correlate JSON-RPC responses with TS-side async generators.
- **JsonRpcTransport & Validators**: `src/bridge/jsonrpc-transport.ts` multiplexes requests, wraps them with Zod-validated payloads (`serializers.ts`), and enforces timeouts/backpressure. `fast-validators.ts` provides preflight structural checks before Zod parsing to reduce hot-path overhead.
- **Notification routing and ops multiplexer**: Allow the runtime to push events (`generation:token`, telemetry) and support batch request fan-out with ordering guarantees (`src/bridge/ops-multiplexer.ts`).

### Python Runtime & MLX Layer
- **Runtime server** (`python/runtime.py`): Async JSON-RPC server that keeps state of loaded (text + vision) models, orchestrates generation/tokenization calls, coordinates telemetry, and exposes runtime info/state for reconciliation. It delegates heavy work to modular adapters in `python/models` and `python/adapters`.
- **Model loaders & generator** (`python/models/loader.py`, `generator.py`, `scheduled_generator.py`, `tokenizer.py`): Wrap MLX LM/VLM APIs, handle quantization options, implement streaming, and optionally route generation through the GPU scheduler.
- **Structured output** (`python/adapters/outlines_adapter.py`): Integrates Outlines, validates schema size/type, and plugs into generation calls when `structured` options are set on the TS side.
- **Vision models** (`python/models/vision_loader.py`): Adds handles for LLaVA/Qwen/Phi-3 Vision; TS `Engine.loadVisionModel` proxies to this layer.
- **GPU scheduler** (`python/gpu_scheduler.py`, documented in `GPU_SCHEDULER_GUIDE.md`): Serializes Metal GPU submissions, batches jobs, enforces latency SLAs, and exports Prometheus metrics.

## Core Feature Deep-Dive
### Model Loading, Draft Compatibility, and Caching
- **Flow**: `Engine.loadModel()` → `ModelManager` prepares descriptor, deduplicates inflight loads, enqueues onto `RequestQueue`, and calls `transport.request('load_model', …)` → Python loader creates or reuses handles.
- **Caching**: In-memory cache w/ LRU tracking + optional artifact cache on disk reduce reload penalties (`ModelArtifactCache` + `getCacheConfig`). Warmup lists come from YAML config, executed during `Engine.start()`.
- **Draft model support**: Draft/primary pair tracking lives in `ModelManager` (e.g., `isDraftModelCompatible`, `draftPairs`). Requests are forwarded to Python’s `check_draft` batch endpoints.
- **Modernization considerations**: Parameter validation still manual; migrating to Zod schemas allows direct inference between TS contract and JSON-RPC payloads.

### Streaming Generation & Request Batching
- **Streaming**: `Engine.createGenerator` returns an `AsyncGenerator<GeneratorChunk>` built by `GeneratorFactory`, which ties transport streams to consumer iterators. Python runtime streams chunk notifications back through `stream-registry` before closing the JSON-RPC call.
- **Batching**: Two tiers—TS side has `BatchQueue` + `GenerateBatcher` to coalesce similar requests; Python runtime exposes `batch_generate` and `batch_tokenize` endpoints (Week 1 batching). This defends against IPC overhead and improves GPU utilization.
- **Backpressure**: Stream registry enforces `max_active_streams`; `GeneratorFactory` will pause/resume reading based on consumer demand to avoid buffer bloat.

### Structured Output Guidance
- **TS surface**: `GeneratorParams` supports `structured` option (schema + format). TS validators perform basic presence checks; payload is passed verbatim to Python.
- **Python adapter**: `outlines_adapter.prepare_guidance` validates schema shape/size, lazily loads Outlines, and compiles a guard used by the generator wrappers. Errors map back to JSON-RPC codes (-32004) so TS clients can differentiate guidance failures.
- **Opportunity**: Replace ad-hoc TS validation with Zod schema that mirrors the Python expectations (mode, schema type, size constraints) to catch issues before crossing the bridge.

### Vision Models
- **Loader**: `python/models/vision_loader.py` instantiates model-specific handlers and stores them separately from text handles (`runtime.py` maintains `self.vision_models`).
- **TS API**: `Engine.loadVisionModel` and `createVisionGenerator` tie into this loader and return typed handles (`VisionModelHandle`, `VisionGeneratorChunk`). Normalization lives beside text models (`compat/config-normalizer.ts`).
- **Considerations**: Mixed vision/text workload scheduling currently happens entirely in Python; TS scheduling primitives only enforce high-level concurrency. ReScript could help encode multimodal state machines if we pull more logic to TS.

### GPU Scheduler & Stability Controls
- **Implementation**: Optional layer toggled via env vars; `scheduled_generator.py` decides between direct generator vs. `gpu_scheduler.GPUScheduler`. Scheduler enforces single-commit worker with adaptive batching, latency monitoring, Prometheus export, and auto-degradation.
- **Integration points**: TS layer exposes env toggles and surfaces telemetry (`python/gpu_scheduler.py` metrics → `python/monitoring`). Error codes propagate through JSON-RPC; TS `Engine`’s circuit breaker (`reconcileState` + `CIRCUIT_BREAKER_*`) protects against repeated crashes.
- **Modernization**: Document scheduler contract in TS types so ReScript/TypeScript code can reason about GPU states (enabled, degraded, bypass). ReScript enums + pattern matching would reduce fragile boolean/state flag logic currently split across TS (`state-reconciliation.ts`) and Python env gating.

## Technology Stack Assessment
| Layer | Current Tooling | Notes for mlx-serving |
| --- | --- | --- |
| Build/Bundling | `tsup` (ESM + CJS bundles), `tsconfig.build.json` | Keep for TypeScript build; consider incremental adoption of `tsx` for dev, ensure artifacts publish under new name.
| Testing | `vitest` + `@vitest/coverage-v8`, 380+ tests (docs/TESTING.md) | Solid foundation; expand to cover new Zod schemas/ReScript interop via generated d.ts typings.
| Logging | `pino` (TS) + stdlib logging (Python) | Continue; align log formats for bridge observability.
| IPC/Process | `execa` / `child_process.spawn`, `eventemitter3` for event fan-out | Works well; ensure new package keeps Node >=22 requirement for top-level await + AbortSignals.
| Validation | Manual rule helpers in `src/api/validation-*`, partial Zod coverage (JSON-RPC only) | Biggest gap—need systematic Zod adoption.
| Monitoring | OpenTelemetry SDK in TS, Prometheus exporter in Python GPU scheduler | Already multi-stack; ensure Telemetry config validated via Zod and typed events are exported to ReScript where applicable.

## Zod Adoption Targets
| Component / File | Current State | Why Zod Matters for mlx-serving |
| --- | --- | --- |
| Engine & helper options (`src/types/index.ts`, `src/api/validators.ts`) | Custom helper functions (`validateNumberInRange`, etc.) plus manual error arrays. | Define canonical Zod schemas for `LoadModelOptions`, `GeneratorParams`, `TokenizeRequest`, enabling shared inference between TS API, CLI, and JSON-RPC payload builders. Reduce duplication between `compat/config-normalizer.ts` and validators.
| Runtime configuration (`src/config/loader.ts`, `src/config/validation.ts`) | YAML parsed into plain objects, validated via bespoke checks. | Zod schemas per section (python_runtime, telemetry, cache, stream_registry) give immediate feedback during `initializeConfig()` and unlock typed config reuse when we expose a public `loadConfig()` API.
| CLI/script inputs (`scripts/prepare-env.ts`, `scripts/postinstall.cjs`) | Rely on imperative checks + thrown strings. | Wrap CLI flag/env parsing with Zod to guard installation on unsupported hosts and provide machine-readable errors for future GUI installers.
| Telemetry payloads (`src/telemetry/bridge.ts`, `src/telemetry/otel.ts`) | Accept loosely typed hooks/config, validated at runtime via type guards. | Zod schemas for telemetry configs and emitted metric structures keep OpenTelemetry + Prometheus bridges consistent, especially when ReScript components subscribe to telemetry streams.
| Stream registry + JSON notifications (`src/bridge/stream-registry.ts`, `src/api/events.ts`) | Uses `eventemitter3` with string literals; payload types enforced via TypeScript only. | Zod schemas for each notification (token chunk, stats snapshots, errors) ensure IPC payloads are validated before hitting user callbacks, improving boundary safety for third-party embedding.

## ReScript Opportunity Areas
| Candidate | Rationale | Migration Notes |
| --- | --- | --- |
| State reconciliation & circuit breaker (`src/api/state-reconciliation.ts`, `Engine` circuit-breaker flags) | Logic is a hand-rolled state machine with multiple booleans (`circuitBreakerState`, promises, restart counts). ReScript’s algebraic data types + pattern matching can encode discrete states (Stopped/Starting/Running/HalfOpen) and generate TS bindings, reducing edge-case bugs. | Start by modeling the circuit-breaker module in ReScript, compile to JS, and import into `engine.ts`. Maintain type-safe exhaustiveness and expose functions for transitions.
| Request/batch scheduling primitives (`src/core/request-queue.ts`, `batch-queue.ts`, `generate-batcher.ts`) | These modules coordinate concurrency, timeouts, and priorities with mutable Maps. ReScript can offer deterministic variants, records, and pattern matching for queue actions, making it easier to reason about invariants (e.g., `MaxConcurrentReached`, `TimeoutExpired`). | Implement as ReScript modules exporting JS classes/functions; integrate gradually (e.g., start with `RequestQueue`). Unit-test via Vitest using generated d.ts for interop.
| Stream registry & async generator glue (`src/bridge/stream-registry.ts`, `generator-factory.ts`) | Complex coordination between JSON-RPC stream ids, consumer iterators, timeout timers. ReScript’s ability to model tagged unions for stream lifecycle (`Idle | Awaiting | Streaming | Finished | Error`) can eliminate duplicated bookkeeping logic. | Model the registry in ReScript, expose minimal JS API (`registerStream`, `pushChunk`, `completeStream`). Helps ensure exhaustive handling of notifications before handing chunks to user callbacks.
| Future GPU scheduler control plane (TS side) | If we pull more scheduling policy to TS (e.g., enabling/disabling GPU scheduler per workload), ReScript’s pattern matching can encode scheduler modes and telemetry-derived decisions more safely than ad-hoc conditionals. | Begin with small modules that interpret telemetry events into actions; integrate with existing TypeScript telemetry hooks.

## Native / C++ Module Considerations
- The repository **does not ship bespoke C/C++/Objective-C sources**—`rg` shows no `*.cc`, `*.cpp`, or `*.mm` files. All native execution happens inside upstream MLX / Metal libraries (pulled via Python dependencies in `python/requirements.txt`).
- **Preservation requirement**: Ensure mlx-serving’s packaging continues to include the existing Python runtime (+ GPU scheduler) unchanged so we inherit MLX’s native kernels. Any attempt to replace the Python layer with direct Node → C++ bindings would forfeit Apple’s vetted MLX optimizations and the GPU scheduler that guards Metal command buffers.
- When rebranding, keep distributing the `python/` directory (loader, generator, scheduler) inside the npm tarball, because that is the only bridge to MLX’s native modules.

## Next Steps Toward mlx-serving
1. **Create Zod schemas** for all public API inputs/outputs and wire them into `Engine` methods before invoking compatibility normalizers.
2. **Modularize stateful primitives** (state reconcilers, queues, stream registry) and port the most failure-prone ones to ReScript for stronger invariants.
3. **Document the GPU scheduler contract** in TypeScript types so ReScript/TS layers can reason about scheduler status, telemetry, and fallbacks without parsing raw env vars.
4. **Rebrand packaging** (rename npm module, CLI, docs) while keeping Python directory and build scripts intact to ensure MLX/C++ coverage remains untouched.
