# mlx-serving Implementation Action Plan

_References_: `automatosx/PRD/mlx-serving-architecture-analysis.md`, `automatosx/PRD/mlx-serving-prd.md`, `kr-serve-mlx` source tree.

## Phase 0 – Baseline replication & validation
**Goal:** Create a 1:1 baseline of `kr-serve-mlx` inside `mlx-serving` so future refactors start from a known-good state.

- **Deliverables**
  - Copy `kr-serve-mlx` repo (source, python runtime, tests, docs) into the new `mlx-serving` repo, preserving directory structure and build scripts.
  - Align workspace metadata (`package.json`, `tsconfig*.json`, `vitest.config.ts`, `python/requirements.txt`) and update branding strings to "mlx-serving" only where it does **not** change APIs.
  - Baseline CI workflow that runs `pnpm lint`, `pnpm test`, and Python runtime smoke tests.
- **Files/modules to touch (from `/Users/akiralam/code/kr-serve-mlx`)**
  - `package.json`, `tsconfig.json`, `tsup.config.ts`, `.github/workflows/*.yml`, `scripts/postinstall.ts`.
  - Entire `src/`, `python/`, `tests/`, `docs/`, `examples/`, `benchmarks/` trees (mechanical copy).
- **Success criteria**
  - `pnpm test` (all Vitest suites) and existing Python integration tests pass with zero regressions.
  - CLI entry points (`dist/index.js`, `src/cli/*` if present) still launch models on Apple Silicon per architecture analysis.
  - Build artifacts and configs reference mlx-serving branding without breaking API identifiers (per PRD §2 parity requirement).
- **Estimated effort:** 0.5 sprint (2–3 engineer-days) for copy, diff review, and CI bring-up.
- **Dependencies:** Access to `kr-serve-mlx` repo, Apple Silicon runner for GPU smoke tests.
- **Risks & mitigation**
  - _Risk:_ Hidden build-time assumptions (hard-coded paths). _Mitigation:_ Run `rg -n "kr-serve-mlx"` to catalog remaining references and gate merges on clean grep.
  - _Risk:_ Python virtualenv drift. _Mitigation:_ Capture `python/requirements.txt` hash and add verification step in CI.

## Phase 1 – Zod integration for validation completeness
**Goal:** Enforce schema-driven validation on every TS boundary (public API, config, JSON-RPC payloads, telemetry) to meet PRD objective #3.

- **Deliverables**
  - Central `src/types/schemas.ts` (or similar) exporting shared Zod objects plus module-specific schema files (`src/api/schemas.ts`, `src/config/schema.ts`, etc.).
  - Refactored API surface (`src/api/engine.ts`, `src/api/index.ts`) using Zod parsing for method inputs/outputs and emitting typed errors.
  - JSON-RPC serializers (`src/bridge/serializers.ts`) fully described with Zod, including nested payloads for `load_model`, `generate`, `telemetry:report`.
  - Config loader + compat layer (`src/config/*.ts`, `src/compat/config-normalizer.ts`) rewritten to parse via Zod and produce typed config objects.
  - Telemetry bridge (`src/telemetry/bridge.ts`, `src/telemetry/otel.ts`) validating payloads before export.
  - Test coverage expanded in `tests/unit/api/*`, `tests/unit/config/*`, `tests/integration/bridge/*` to cover success + failure cases.
- **Files/modules to modify**
  - `src/api/engine.ts`, `src/api/types.ts`.
  - `src/config/index.ts`, `src/config/load-config.ts`, `src/compat/config-normalizer.ts`.
  - `src/bridge/serializers.ts`, `src/bridge/fast-validators.ts`, `src/bridge/jsonrpc-transport.ts`.
  - `src/telemetry/bridge.ts`, `src/telemetry/events.ts`.
  - New schema files under `src/types/` (e.g., `src/types/zod.ts`).
  - Matching tests in `tests/unit/**`, `tests/integration/bridge/**`.
- **Success criteria**
  - 100% of public API entry points and JSON-RPC message types referenced in the architecture analysis have declarative Zod schemas.
  - Vitest coverage for new schema modules ≥90% statement (PRD metric).
  - Runtime errors for invalid configs/requests surface as Zod issues with consistent codes/messages.
- **Estimated effort:** 1.5 sprints (6–7 engineer-weeks) including schema design and test expansions.
- **Dependencies:** Phase 0 baseline; alignment with product on error messaging; coordination with Python runtime for schema expectations.
- **Risks & mitigation**
  - _Risk:_ Performance hit on hot paths (token streaming). _Mitigation:_ Keep `fast-validators.ts` lightweight guards and only Zod-parse at boundaries, caching compiled schemas.
  - _Risk:_ Schema drift vs. Python expectations. _Mitigation:_ Derive JSON schema snapshots and share with Python tests (`python/tests/test_contract.py`).

## Phase 2 – ReScript migration for state management
**Goal:** Gradually move complex state machines (queues, circuit breakers, stream registry) into ReScript modules that compile to deterministic JS while keeping TS interfaces intact (PRD objective #4).

- **Deliverables**
  - ReScript toolchain integrated (`rescript.config.js`, `bsconfig.json` or modern equivalent) with build step wired into `pnpm build`.
  - New `rescript/` (or `src/rescript/`) modules implementing state logic for:
    - Request queue + backpressure (`src/core/request-queue.ts`).
    - Stream registry (`src/bridge/stream-registry.ts`).
    - Generate batcher and async queue pool (`src/core/generate-batcher.ts`, `src/core/async-queue-pool.ts`).
    - Circuit breaker helpers (`src/utils/circuit-breaker*.ts`).
  - Type-safe interop wrappers (TS thin adapters) that call emitted `.res.js` modules and expose existing APIs.
  - Dual-test strategy: ReScript unit tests (res jest) + existing Vitest suites hitting the TS adapters.
- **Files/modules to modify**
  - Add `rescript/` directory with `.res` files: `rescript/RequestQueue.res`, `rescript/StreamRegistry.res`, `rescript/CircuitBreakerState.res`, etc.
  - Update `package.json` scripts, `tsconfig.json`, `tsup.config.ts` to include generated artifacts.
  - Wrapper files: `src/core/request-queue.ts`, `src/bridge/stream-registry.ts`, `src/utils/circuit-breaker-state.ts`, `src/core/generate-batcher.ts`.
  - Tests: `tests/unit/core/request-queue.test.ts`, `tests/unit/bridge/stream-registry.test.ts`, new ReScript tests under `rescript/__tests__`.
- **Success criteria**
  - All targeted state modules compiled from ReScript without changing TypeScript public signatures.
  - Deterministic behavior verified via snapshot/state-transition tests (no nondeterministic flake >1%).
  - Build pipeline produces `.res.js` artifacts with type declarations so TypeScript consumers remain strict-mode clean.
- **Estimated effort:** 2 sprints (8–9 engineer-weeks) due to tooling integration + incremental migration.
- **Dependencies:** Phase 1 schemas (so adapters know validated shapes); Node 20+ toolchain; decision on directory layout agreed with DevOps.
- **Risks & mitigation**
  - _Risk:_ Tooling friction (ESM + ReScript interop). _Mitigation:_ Spike in `automatosx/tmp/` to prove `rescript build` + `tsup` pipeline before touching core modules; store learnings in ADR.
  - _Risk:_ Mixed-source debugging complexity. _Mitigation:_ Generate source maps and document debug workflow in `docs/DEV_WORKFLOW.md`.

## Phase 3 – Integration & end-to-end verification
**Goal:** Ensure Zod-enhanced TS layers and ReScript state machines interoperate correctly with the existing Python/MLX runtime.

- **Deliverables**
  - Contract test suite covering TS ↔ Python JSON-RPC exchanges (`tests/integration/bridge/*`, `tests/integration/runtime/*`).
  - Cross-language structured output tests (TS `structured` flag → Python `python/adapters/outlines_adapter.py`).
  - Vision + GPU scheduler smoke tests (per architecture doc) triggered via CI matrix on Apple Silicon.
  - Updated benchmarking harness (`benchmarks/*`, `scripts/perf-runner.ts`) to ensure latency deltas stay within ±5% (PRD metric).
- **Files/modules to modify**
  - Integration fixtures under `tests/integration/bridge/` and `tests/integration/runtime/`.
  - `python/runtime.py`, `python/models/*.py` only if contract changes require clarifications (ideally zero functional diffs).
  - CI scripts (`.github/workflows/test.yml`, `scripts/run-ci.ts`) for combined TS/ReScript/Python jobs.
  - Benchmarks + telemetry exporters.
- **Success criteria**
  - All CI jobs (lint, unit, integration, python, ReScript) green; no flaky tests over 3 consecutive runs.
  - Benchmark delta vs. Phase 0 baseline ≤±5% at P50/P95 for `generate` and `stream` flows.
  - Structured output + vision regression suites pass, demonstrating parity with `kr-serve-mlx`.
- **Estimated effort:** 1 sprint (4 engineer-weeks) shared between QA + backend.
- **Dependencies:** Completion of Phases 1–2; Apple Silicon CI runners; Outlines + MLX versions pinned from Phase 0.
- **Risks & mitigation**
  - _Risk:_ Cross-language schema mismatch detected late. _Mitigation:_ Auto-generate JSON schema artifacts from Zod and load them in Python tests during this phase.
  - _Risk:_ Performance regression from added validation. _Mitigation:_ Use lazy parsing (Phase 1) and profile event loop during benchmark runs.

## Phase 4 – Release readiness, migration UX, and governance
**Goal:** Prep mlx-serving for GA with clear migration assets, updated ADRs, and operational guardrails, satisfying PRD §3 success metrics.

- **Deliverables**
  - ADR updates in `.automatosx/abilities/our-architecture-decisions.md` capturing Zod enforcement and ReScript adoption.
  - Migration guide (`docs/MIGRATING_FROM_KR_SERVE_MLX.md`) detailing upgrade path, config diffs, and rollback steps.
  - Updated product docs & PRD appendices referencing new validation/state architecture.
  - Versioned release artifacts (npm package, Python wheels if applicable) plus checksum automation.
  - Operational runbooks for telemetry dashboards, log formats, and GPU scheduler monitoring.
- **Files/modules to modify**
  - Documentation: `README.md`, `docs/`, new migration doc, ADR file.
  - Release pipeline configs (`.github/workflows/release.yml`, `scripts/publish.ts`).
  - Telemetry dashboards definitions (`automatosx/PRD/` or `docs/observability.md`).
- **Success criteria**
  - Stakeholder sign-off (Tony + Paris) on migration readiness; customers can upgrade without code changes.
  - Release pipeline produces signed artifacts and updates npm dist-tags.
  - Architecture governance artifacts (ADRs, PRD updates) reflect final implementation.
- **Estimated effort:** 0.5–1 sprint (2–3 engineer-weeks) overlapping with Phase 3 exit criteria.
- **Dependencies:** All prior phases; product/marketing alignment; QA sign-off.
- **Risks & mitigation**
  - _Risk:_ Docs lag behind implementation. _Mitigation:_ Treat migration doc as DoD item for Phase 3 stories.
  - _Risk:_ Release automation drift. _Mitigation:_ Dry-run publish to private npm tag before GA.

---

**Overall sequencing:** Phase 0 establishes the refactoring baseline; Phase 1 increases type safety; Phase 2 upgrades state orchestration; Phase 3 validates end-to-end behavior; Phase 4 packages and governs the release. Each phase builds on previous outputs and keeps the Python/MLX runtime unchanged, honoring the architecture analysis and PRD parity requirements.
