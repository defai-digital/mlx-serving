# MLX Engine Refactoring Strategy

> Author: Avery (Architecture)  
> Date: 2025-11-06  
> Scope: `src/api/engine.ts`, `src/bridge/*`, `src/core/*`

---

## 1. Objectives & Constraints

- **Primary goals**
  1. Break up the 1,738-line `Engine` god class (`src/api/engine.ts:84`) into composable modules.
  2. Reassert clear boundaries between the `bridge/` (Python process + JSON-RPC plumbing) and `core/` (domain logic) directories.
  3. Introduce an explicit service layer that orchestrates lifecycle, model, generation, and telemetry concerns.
  4. Publish coding standards/patterns that keep the new architecture coherent.
- **Constraints**
  - Maintain all **331 existing tests** green at every checkpoint (no flag days).
  - Preserve API compatibility for `Engine`, `MLXEngine`, and CLI entry points.
  - Avoid breaking the Python bridge contracts (JSON-RPC schemas in `src/bridge/serializers.ts`).
  - Keep refactor increments ≤ 2 weeks to fit within release cadence.

---

## 2. Current State Assessment

### 2.1 Engine God-Class

- `Engine` mixes lifecycle, transport, queueing, telemetry, feature flags, caching, and streaming concerns in a single file.
- Hidden coupling: cross-cutting state (e.g., `batchQueue`, `generateBatcher`, `circuitBreakerState`) is mutated in-line, increasing the blast radius of every change.
- Error pathways (e.g., `toEngineError`, `createTransportError`) are applied inconsistently, making it hard to guarantee deterministic failure modes.

### 2.2 Bridge/Core Coupling

- `src/api/engine.ts` reaches directly into bridge constructs (`PythonRunner`, `JsonRpcTransport`) **and** core primitives (`ModelManager`, `GeneratorFactory`) without an abstraction barrier.
- Bridge emits events (`streamRegistry`, `fast validators`) that the engine interprets directly, forcing any runtime tweak to ripple across the entire file.
- Core classes (`ModelManager`, `GenerateBatcher`, etc.) are instantiated ad hoc, so their lifecycle cannot be unit-tested independently of the Python process.

### 2.3 Missing Service Layer

- No orchestration tier coordinates `core/` components; everything is glued inside `Engine`.
- Telemetry hooks, cache management, and batching all share the same logger instance without scoped contexts, making observability noisy.
- Because there is only one surface, parallel workstreams (e.g., improving batching vs. adding new generator types) trip over each other.

---

## 3. Target Architecture

### 3.1 Engine Module Decomposition

| Module | Responsibility | Notes |
| --- | --- | --- |
| `RuntimeLifecycleService` | Start/stop Python runner, manage transport hand-offs, expose runtime/health info | Wraps `PythonRunner` + `JsonRpcTransport`; owns circuit-breaker logic |
| `ModelLifecycleService` | Validate options, normalize configs, call `ModelManager`, track handles & compatibility | Publishes domain events consumed by telemetry |
| `GenerationService` | Own `GeneratorFactory`, `BatchQueue`, `GenerateBatcher`; encapsulate stream dispatch | Provides both text and vision generator APIs |
| `TelemetryService` | Fan-in events (`model:*`, `generation:*`, runtime) and invoke registered hooks/loggers | Responsible for standardized event payloads |
| `EngineFacade` | Thin API adapter that matches current `Engine` contract (`createEngine`, `MLXEngine`) | Delegates to above services; maintains EventEmitter surface |

Each service is constructed with explicit dependencies, enabling isolated tests and future dependency injection.

### 3.2 Service Layer Boundaries

```
┌────────────────────┐     ┌────────────────────┐
│  API Facades       │◄───►│ Service Layer      │
│ (Engine, MLXEngine)│     │ (Runtime/Model/Gen)│
└────────┬───────────┘     └────────┬───────────┘
         │                           │
         │ ports/interfaces          │ adapters
┌────────▼───────────┐     ┌─────────▼──────────┐
│      core/         │     │      bridge/       │
│ (ModelManager, etc)│     │ (PythonRunner, RPC)│
└────────────────────┘     └────────────────────┘
```

- **Service contracts** expose `Ports` (TypeScript interfaces) that core and bridge implementations satisfy, allowing mocks in tests.
- `EngineFacade` never instantiates bridge/core classes directly; it requests them from a `ServiceFactory`.

### 3.3 Bridge/Core Responsibilities

- `bridge/`: Process orchestration (`python-runner.ts`), transport/state streaming (`jsonrpc-transport.ts`, `stream-registry.ts`), serialization/validation. No domain knowledge.
- `core/`: Domain state machines (model lifecycle, batching, artifact cache). No process or IPC knowledge.
- Shared DTOs live under `types/` and `compat/` to avoid circular dependencies.
- Introduce an explicit anti-corruption layer: `bridge` outputs transport DTOs, services convert them to domain entities before reaching `core`.

### 3.4 Cross-Cutting Concerns

- **Configuration**: Centralize in a `RuntimeConfigProvider` that services consume.
- **Error taxonomy**: All services throw/return `EngineError` variants; formatting for clients stays in the facade.
- **Observability**: Structured log keys (`component`, `operation`, `modelId`) with scoped child loggers per service; telemetry hooks receive normalized payloads.

---

## 4. Coding Standards & Patterns

1. **Service Contracts**
   - Every service exposes an interface in `src/services/contracts.ts`.
   - Dependencies injected via constructor; no singletons besides config providers.
2. **Command/Query Separation**
   - Methods that mutate state return `Promise<Result>`; reads return immutable snapshots.
   - Streaming APIs use AsyncGenerator wrappers that emit typed chunks.
3. **Error Handling**
   - Internal errors extend `EngineClientError`; include `code`, `retryable`, and `context`.
   - Transport errors are wrapped at the bridge boundary only once.
4. **Eventing & Telemetry**
   - Emit domain events via a shared `DomainEventBus`.
   - Event names follow `area.action` (e.g., `model.loaded`).
   - Telemetry hooks must be idempotent and receive correlation IDs from the facade.
5. **Testing Discipline**
   - Each service gains dedicated Vitest suites with mocks for bridge/core ports.
   - Add contract tests to assert that facade methods still satisfy current API snapshots.
6. **Documentation**
   - Update `docs/architecture/` diagrams alongside code.
   - All new modules require a short `README.md` describing invariants.

---

## 5. Incremental Implementation Roadmap

| Phase | Duration | Scope | Key Tasks | Quality Gates |
| --- | --- | --- | --- | --- |
| **0. Baseline & Guardrails** | 0.5 wk | Establish safety nets | Snapshot public API using `ts-interface-checker`; tag top 20 Engine integration tests; add lint rule preventing new imports into `src/api/engine.ts` | 331 tests + new snapshot tests |
| **1. Runtime Service Extraction** | 1 wk | Pull lifecycle/circuit breaker out of `Engine` | Create `RuntimeLifecycleService`; move runner/transport init & health APIs; facade delegates `start`, `shutdown`, `getRuntimeInfo`, `health_check`; add service tests mocking `PythonRunner` | No regression in startup/teardown tests; bench cold-start |
| **2. Model Service & Bridge/Core Boundary** | 1.5 wks | Isolate model operations | Move normalization + ModelManager usage into `ModelLifecycleService`; introduce `BridgeModelPort` for RPC calls; ensure only service touches bridge; document boundary | API contract tests for `loadModel`, `listModels`; targeted perf benchmark |
| **3. Generation & Batching Service** | 1.5 wks | Encapsulate stream generation + batching | Wrap `GenerateBatcher`, `BatchQueue`, `GeneratorFactory` inside `GenerationService`; expose streaming APIs; integrate telemetry events | Stream E2E tests + soak test |
| **4. Facade Slimming & Coding Standards Enforcement** | 1 wk | Finalize EngineFacade + docs | Rename legacy `Engine` to `EngineFacade`; route methods to services; add lint checks (import boundaries, event names); publish coding standards doc | Full regression suite + lint |

Risk mitigation:
- Only merge when phase tests + 331 baseline pass.
- Feature flags (e.g., `ENABLE_SERVICE_LAYER`) allow runtime fallback while services stabilize.

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Hidden coupling surfaced mid-refactor | Medium | High | Add telemetry + feature flags before swapping implementations |
| Transport/service contract mismatch | Low | High | Introduce TypeScript interfaces + JSON-RPC schema tests in Phase 1 |
| Regression in stream performance | Medium | Medium | Benchmark per phase; keep batching knobs unchanged until Phase 3 |
| Team learning curve on new standards | Medium | Medium | Run brown-bag session; pair with Stan for lint rules |

---

## 7. Deliverables

- `src/services/` directory with runtime, model, generation, telemetry services + contracts.
- Updated `EngineFacade` exposing current public API while delegating to services.
- Documentation updates (this PRD, ADR-011, diagrams).
- Tooling: lint rules, contract tests, telemetry normalizers.

Great architecture is invisible: once the refactor lands, teams should perceive a stable API surface while enjoying faster iteration inside well-defined service modules.
