# MLX Engine Refactor – Phase 0 Guardrails

> Last updated: 2025-11-06

This note captures the baseline artifacts created to support Phase 0 of the MLX Engine refactor (API snapshots, test tags, and lint guardrails).

## 1. API Snapshot

- **Contract export:** `src/api/contracts/engine-public-api.ts` exports the `EnginePublicAPI` interface plus `ENGINE_API_SNAPSHOT_VERSION`.
- **Root export:** `src/index.ts` re-exports the snapshot so downstream packages can pin against the public surface.
- **Type regression test:** `tests/contracts/engine-api.snapshot.test.ts` uses Vitest's `expectTypeOf` to enforce:
  - `Engine` public keys exactly match the snapshot keys.
  - `createEngine()` resolves to the snapshot type.
  - Snapshot version string is anchored (`phase-0`).

Update the snapshot interface (and bump the version) whenever the public API changes intentionally during later phases.

## 2. Engine Top-20 Integration Tests

- **Tag helper:** `tests/helpers/tags.ts` centralizes the `[engine-top20]` label.
- **Tagged suites:** The following tests now include the tag in their titles:
  1. `tests/integration/engine-batching.test.ts` – three batching capability tests.
  2. `tests/integration/batch-queue.test.ts` – tokenize/check_draft batching coverage.
  3. `tests/integration/timeout-management.test.ts` – timeout option + runtime health.
  4. `tests/integration/batch-generate.test.ts` – concurrent generation, error isolation, aborts.
  5. `tests/integration/telemetry/engine-integration.test.ts` – telemetry hook behavior.
  6. `tests/integration/vision/vision-generation.test.ts` – vision file-path + snake_case flows.
  7. `tests/integration/model-caching.test.ts` – warmup + cache alias.
  8. `tests/integration/draft-model-compatibility.test.ts` – compatibility report + perf estimate.

The tag surfaces directly in Vitest output, making it easy to monitor these critical scenarios throughout the refactor.

## 3. Engine Import Guard

- `.eslintrc.cjs` now enforces `import/max-dependencies` for `src/api/engine.ts` with the current ceiling (18 imports). Any new import will fail lint unless the ceiling is intentionally raised alongside the service extraction work.

## 4. Test Baseline

- `npm run test` (Vitest) must continue to pass (331 specs). This run was executed after introducing the guardrails to verify the baseline stays green.

These artifacts provide the required guardrails before service extraction begins.
