# mlx-serving Product Requirements Document

## Document Metadata
| Field | Value |
| --- | --- |
| Version | 0.1 (Draft) |
| Owner | Paris (Product) |
| Stakeholders | Backend (Bob), Fullstack (Felix), DevOps (Oliver), Quality (Queenie), Design/Docs (Wendy) |
| Status | Draft – review with Engineering & Product |
| Last Updated | 2025-11-07 |
| Reference Docs | `automatosx/PRD/mlx-serving-architecture-analysis.md`, `docs/TESTING.md`, `python/GPU_SCHEDULER_GUIDE.md` |

---

## 1. Background & Problem
`kr-serve-mlx` proved we can host production-grade LLMs on Apple Silicon by pairing a TypeScript control plane with a Python MLX runtime. Adoption plateaued because the control plane lags modern TypeScript practices, validation is inconsistent, and stateful primitives (queues, circuit breaker, stream registry) are difficult to reason about. The project also ships under the KR brand even though we now treat mlx-serving as a first-class offering. We must revamp the product while guaranteeing existing customers can upgrade without rewriting integrations.

**Problem statement:** Deliver a production-ready, Apple Silicon focused serving engine that keeps the proven Python/MLX runtime but modernizes the TypeScript layer with comprehensive Zod schemas and ReScript-backed critical state handling, all while preserving 100% API compatibility and feature parity (model loading, streaming, structured output, vision models, GPU scheduler).

## 2. Source Code Foundation
mlx-serving is a revamp of the proven `kr-serve-mlx` production codebase, not a greenfield build. We are copying the existing repository and then layering incremental improvements on top to keep customer risk near zero.

1. **Source location:** `/Users/akiralam/code/kr-serve-mlx` is the canonical repo; all work begins by cloning and mirroring that structure.
2. **Mature baseline:** We are migrating/refactoring `kr-serve-mlx` v1.4.2 (npm published, 375+ automated tests passing today) rather than authoring new modules.
3. **Incremental transformation:** Every change must be an additive refactor (Zod schemas, ReScript state machines, telemetry polish) that keeps the runtime shippable after each commit—no rewrite phases.
4. **Parity-first migration:** Existing functionality, Python runtime behavior, and every current test (TypeScript + Python) move over intact before enhancements land.
5. **Structured enhancements:** We copy the current project layout verbatim, then enhance the cloned modules with Zod validation and ReScript orchestration in-place.

## 3. Objectives & Success Criteria
### Primary goals
1. **Production-grade LLM serving on Apple Silicon** with model loading, streaming generation, structured output (Outlines), multimodal/vision support, and GPU scheduler intact.
2. **Zero-regression API compatibility** with `kr-serve-mlx` (runtime behavior, config surface, error codes).
3. **Type-safe interfaces** by adopting Zod for every API boundary (public API, JSON-RPC payloads, config, telemetry).
4. **Deterministic state orchestration** via ReScript modules for reconciliation, circuit breakers, request/stream queues, and stream registry.
5. **Preserved Python runtime + MLX integration**, no rewrites or new native bindings.
6. **Comprehensive testing strategy** that covers TS ↔ ReScript ↔ Python boundaries.
7. **Clear migration story** so existing users can upgrade within one sprint.

### Non-goals
- Replacing the Python runtime, MLX kernels, or GPU scheduler.
- Changing the JSON-RPC protocol version or message framing.
- Expanding to non-Apple GPU backends in this release.

### Success metrics (first 90 days GA)
| Metric | Target |
| --- | --- |
| Existing `kr-serve-mlx` customers upgraded | 80%+ |
| Production incidents attributable to mlx-serving | 0 Sev-1, ≤2 Sev-2 |
| P50 / P95 token latency delta vs. current release | ±5% |
| Test coverage for new Zod/ReScript modules | ≥90% statement |
| Support tickets about validation or state sync | -50% vs. baseline |

## 4. Users & Use Cases
### Personas
- **Applied ML Infra Teams** embedding mlx-serving into internal developer platforms for Apple Silicon fleets.
- **Indie ML builders** running models locally for evaluation, fine-tuning, or demos.
- **QA/Benchmark pipelines** that need deterministic streaming and structured outputs (Outlines) for golden tests.

### Jobs-to-be-done
1. Load and hot-swap multiple MLX models (text + vision) on Apple Silicon hardware without manual process management.
2. Stream tokens/vision responses over async APIs with backpressure and reliability guarantees.
3. Enforce structured outputs for evaluation harnesses.
4. Schedule GPU workloads safely across workloads without starving latency-sensitive jobs.
5. Upgrade from `kr-serve-mlx` to mlx-serving without touching client code.

## 5. Functional & Technical Requirements

### 5.1 API & Compatibility
- **FR-API-1:** Maintain identical public TypeScript API signatures, events, and error codes as `kr-serve-mlx` (incl. snake/camel aliases).
- **FR-API-2:** Ship shims so `require('kr-serve-mlx')` emits deprecation warnings but resolves to mlx-serving during migration window.
- **FR-API-3:** Document any newly exposed helpers (e.g., `loadConfig()`) while marking them optional.
- **FR-API-4:** Ensure JSON-RPC method names, params, and notification payloads remain unchanged; add version negotiation guardrails for future evolutions.

### 5.2 Model Lifecycle & Serving
- **FR-MODEL-1:** Support loading/unloading, warmups, artifact cache reuse, and metadata reconciliation (per architecture analysis §Model Loading).
- **FR-MODEL-2:** Preserve streaming generation pipeline (async generators, token/vision chunk events, backpressure).
- **FR-MODEL-3:** Continue Outlines-based structured output path; expose validation errors via Zod error objects.
- **FR-MODEL-4:** Maintain first-class vision model support (`loadVisionModel`, LLaVA/Qwen/Phi-3 Vision) with consistent telemetry.
- **FR-MODEL-5:** GPU scheduler remains on Python side; TS layer only configures and surfaces telemetry.

### 5.3 State Management & Reliability
- **FR-STATE-1:** ReScript modules own circuit breaker state machine, request queue arbitration, stream registry, and queue management primitives (see §6.3).
- **FR-STATE-2:** Provide TypeScript-friendly bindings/d.ts files so existing code continues to compile.
- **FR-STATE-3:** Circuit breaker decisions exposed via typed events/metrics for observability dashboards.

### 5.4 Validation & Config
- **FR-VALID-1:** All external inputs (public API options, CLI flags, JSON-RPC payloads, telemetry config, env overrides) pass through Zod schemas before usage.
- **FR-VALID-2:** Provide shared schema exports for SDK consumers needing ahead-of-time validation.
- **FR-VALID-3:** Validation failures must include machine-readable codes plus human-friendly summaries.

### 5.5 Observability & Ops
- **FR-OBS-1:** Preserve OpenTelemetry hooks and Prometheus metrics surfaced by GPU scheduler.
- **FR-OBS-2:** Add health endpoints/CLI checks grounded in Zod-validated telemetry payloads.
- **FR-OBS-3:** Provide structured logging for bridge restarts, circuit breaker transitions, and queue saturation events.

### 5.6 Testing & Quality
- **FR-TEST-1:** Expand Vitest suites to cover Zod schemas, ReScript bindings, and TypeScript ↔ Python integration contracts.
- **FR-TEST-2:** Add contract tests to ensure API compatibility (snapshot route).
- **FR-TEST-3:** Maintain Python-side regression suites for model loaders, structured output, and GPU scheduler.

## 6. Architecture & Technical Direction
### 6.1 High-level view
The architecture remains a three-tier system described in `mlx-serving-architecture-analysis.md`: TypeScript API/control plane → JSON-RPC bridge → Python runtime (MLX). mlx-serving focuses changes on the TypeScript tier while leaving the Python runtime and MLX integrations untouched.

### 6.2 Zod adoption plan
| Layer | Deliverable | Notes |
| --- | --- | --- |
| Public API (`Engine`, helpers) | Canonical schemas for load/generate/tokenize, exported for reuse. | Replace ad-hoc validators; reuse for docs/CLI. |
| Config loader (`src/config/*`) | Schema-per-section with defaulting + safe coercions. | Fail fast during `initializeConfig`. |
| Telemetry & events | Schemas for telemetry config and emitted payloads. | Enables typed subscriptions from ReScript modules. |
| JSON-RPC messages | Extend existing serializer schemas to cover notifications. | Validates inbound runtime payloads before hitting user code. |

### 6.3 ReScript adoption plan
| Module | Scope | Rationale |
| --- | --- | --- |
| Circuit breaker | Encode states (`Stopped | Starting | Running | HalfOpen | Tripped`). | Prevents boolean soup and ensures exhaustive transitions. |
| Request queue / batch scheduler | Queue operations, priority rules, timeout handling. | Safer pattern matching for saturation and retry cases. |
| Stream registry | Lifecycle of token streams & backpressure. | Guarantees consistent handling of `generation:token` events. |
| State reconciliation | Canonical view of runtime/python health vs. TS state. | Reduces drift between telemetry and engine decisions. |

Each module ships compiled JS + `.d.ts`. Vitest + ReScript tests ensure deterministic transitions before integration.

### 6.4 Python runtime preservation
- No edits to MLX integration, Outlines adapters, or GPU scheduler aside from config toggles.
- Packaging keeps `python/` directory in npm tarball; installer scripts continue to materialize `.kr-mlx-venv`.
- Any telemetry/schema changes must be inward-compatible so Python JSON-RPC handlers keep working.

## 7. Implementation Approach
mlx-serving implementation equals a staged refactor of the existing TypeScript and Python modules; no file starts from a blank slate.

1. **Clone + lock baseline:** Copy the `kr-serve-mlx` repo (v1.4.2) into this project, preserving folder hierarchy, tsconfig, and python packaging so diffs stay reviewable.
2. **Module-by-module refactor:** For each control-plane module (engine, config, telemetry, CLI, queue primitives) we refactor in place—introducing Zod schemas or ReScript bindings while retaining exported signatures and behavior.
3. **Progressive ReScript adoption:** ReScript files are added adjacent to their TypeScript counterparts, and we swap the import targets only after parity tests confirm behavior matches the original implementations.
4. **Test-first gates:** Existing 375+ unit/integration tests (TS + Python) must pass before merging any refactor, and new coverage is layered on to prove the modernized paths.
5. **Python runtime parity:** All bridge contracts, venv installers, and GPU scheduler entry points stay intact; changes focus on orchestration/validation around them.
6. **Incremental releases:** Each milestone ships as a drop-in replacement for `kr-serve-mlx`, enabling customers to adopt improvements gradually without waiting for a massive rewrite.

## 8. Experience & Content Deliverables
- Update README/docs to explain mlx-serving positioning, quick start, and AutomatosX integration.
- Publish migration guide (see §11) plus API reference diff highlighting zero-breaking changes.
- Coordinate with Writer (Wendy) to refresh tutorials, referencing new validation errors and ReScript-backed stability.

## 9. Testing & Quality Strategy (Req. #7)
1. **Schema tests:** Vitest snapshots for every Zod schema, ensuring error surfaces stay stable.
2. **Interop tests:** Harness that spins the Python runtime via `PythonRunner`, executes sample load/generate/tokenize flows, and asserts parity with `kr-serve-mlx` fixtures.
3. **ReScript unit tests:** ReScript test runner + generated JS tests executed via Vitest to validate state machines.
4. **Performance regression tests:** Token latency benchmarks (P50/P95) covering text + vision paths with GPU scheduler on/off.
5. **Failure-injection:** Simulate runtime crashes, queue saturation, and JSON-RPC backpressure to verify circuit breaker and ReScript queues recover gracefully.

## 10. Metrics & Telemetry
- **Product metrics:** Adoption %, upgrade completion, support ticket volume, net promoter feedback from pilot teams.
- **Platform metrics:** Circuit breaker trip frequency, queue saturation %, GPU scheduler utilization, validation failure counts (tagged by schema).
- **Quality gates:** Release blocked if regression tests fail or if telemetry shows >5% latency regression.

## 11. Migration Plan (Req. #8)
1. **Dual-publish phase (beta):** Publish `mlx-serving@beta` and `kr-serve-mlx@latest` that internally depends on mlx-serving. Provide feature flag to switch validation strictness.
2. **Documentation:** Ship “Upgrade in 30 minutes” guide covering npm aliases, config validation updates, and new telemetry events.
3. **Tooling support:** CLI command `npx mlx-serving doctor` to validate environments using Zod schemas pre-upgrade.
4. **Telemetry guardrails:** Surface warnings when legacy clients call deprecated methods; send opt-in usage ping for owners.
5. **Deprecation timeline:** 60 days after GA, mark `kr-serve-mlx` as deprecated but still functional; 120 days after GA, security fixes only.

## 12. Release Plan & Milestones
| Phase | Timeline | Exit criteria |
| --- | --- | --- |
| Architecture freeze | Week 0-1 | Zod/ReScript scopes agreed, API compatibility plan signed off. |
| Implementation alpha | Week 2-6 | Existing `kr-serve-mlx` modules refactored with Zod + ReScript (no net-new modules); parity + regression tests green. |
| Beta w/ pilot teams | Week 7-9 | Dual-publish packages, migration guide draft, telemetry dashboards ready. |
| GA | Week 10-11 | ≥3 pilot teams in prod, metrics stable, docs complete. |
| Post-GA hardening | Week 12+ | Track adoption, close telemetry or migration gaps. |

Dependencies: coordinated release with Docs, DevRel, and AutomatosX guide updates; QA sign-off before GA.

## 13. Risks & Mitigations
- **Schema over-strictness causes breaking changes.** → Start in warning mode, allow opt-out via config, provide automated fixer hints.
- **ReScript integration delays.** → Stage rollout (circuit breaker first, queues second), keep TypeScript fallback modules until parity proven.
- **Performance regressions from additional validation.** → Benchmark hot paths, use `fast-validators` for structural checks before Zod where needed.
- **Migration confusion.** → Invest in docs, CLI doctor, and alias packages; maintain support overlap for ≥120 days.
- **GPU scheduler contract drift.** → Keep Python owner in review loop; add contract tests to ensure config + telemetry names unchanged.

## 14. Open Questions
1. Do we expose Zod schemas as part of the public package (e.g., `import { LoadModelOptionsSchema }`) or keep them internal?
2. Should we provide an opt-in TypeScript-only mode (no ReScript) for downstream bundlers that cannot compile ReScript artifacts?
3. What telemetry backend(s) should we support out-of-the-box beyond OpenTelemetry (e.g., Datadog exporters)?
4. Are there enterprise customers relying on undocumented APIs/events that we must catalog before GA?

## 15. Appendices
- **Reference architecture:** `automatosx/PRD/mlx-serving-architecture-analysis.md`
- **Testing guide:** `docs/TESTING.md`
- **GPU scheduler details:** `python/GPU_SCHEDULER_GUIDE.md`
- **AutomatosX workflows:** `AX-GUIDE.md`
