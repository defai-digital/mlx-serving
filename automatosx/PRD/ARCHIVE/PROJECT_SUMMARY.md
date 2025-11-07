# mlx-serving Project Summary

**Date:** 2025-11-07
**Project Type:** Production Codebase Revamp/Refactor
**Source Code:** `/Users/akiralam/code/kr-serve-mlx` (v1.4.2)

---

## Executive Summary

mlx-serving is a **refactor and modernization** of the proven kr-serve-mlx production codebase, not a greenfield project. We are taking the existing v1.4.2 codebase (375+ passing tests, npm published) and incrementally enhancing it with:

1. **Systematic Zod adoption** for type-safe validation across all API boundaries
2. **ReScript migration** for critical state management components (circuit breakers, queues, stream registry)
3. **100% API compatibility** preservation with existing kr-serve-mlx
4. **Zero changes** to the proven Python runtime and MLX integration

## Source Foundation

- **Location:** `/Users/akiralam/code/kr-serve-mlx`
- **Version:** v1.4.2 (Production Ready)
- **Status:** 375/382 tests passing (98.2%), npm published
- **Architecture:** TypeScript API Layer → JSON-RPC Bridge → Python Runtime → MLX/Metal

## Key Documents

All planning documents are in `automatosx/PRD/`:

1. **mlx-serving-architecture-analysis.md** - Deep dive into current architecture
2. **mlx-serving-prd.md** - Complete Product Requirements Document
3. **mlx-serving-implementation-plan.md** - 5-phase implementation roadmap
4. **PROJECT_SUMMARY.md** - This summary document

## Technology Stack

### Current (kr-serve-mlx)
- TypeScript 5.4+ with tsup bundler
- Node.js 22+
- Python 3.11-3.12 runtime
- MLX framework for Apple Silicon
- Vitest testing framework
- Pino logger
- Partial Zod usage (JSON-RPC only)

### Target (mlx-serving)
- **Enhanced:** Comprehensive Zod schemas for all boundaries
- **New:** ReScript for state machines and critical orchestration
- **Preserved:** Python runtime, MLX integration, testing infrastructure
- **Maintained:** All existing tooling (tsup, vitest, pino, etc.)

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  TypeScript API Layer (Enhanced with Zod)           │
│  - Engine facade (src/api/engine.ts)                │
│  - Core services (src/core/*)                       │
│  - Config loader (src/config/*)                     │
│  ↓                                                   │
├─────────────────────────────────────────────────────┤
│  State Management (Migrated to ReScript)            │
│  - Circuit breaker state machine                    │
│  - Request queues & batch scheduler                 │
│  - Stream registry                                  │
│  - State reconciliation                             │
│  ↓                                                   │
├─────────────────────────────────────────────────────┤
│  Python Bridge Layer (JSON-RPC)                     │
│  - PythonRunner (src/bridge/python-runner.ts)       │
│  - Transport & validators                           │
│  ↓                                                   │
├─────────────────────────────────────────────────────┤
│  Python Runtime (UNCHANGED)                         │
│  - MLX model loaders (python/models/)               │
│  - GPU scheduler (python/gpu_scheduler.py)          │
│  - Outlines adapter (python/adapters/)              │
│  ↓                                                   │
└─────────────────────────────────────────────────────┘
│  MLX / Metal Runtime (Apple Silicon)                │
└─────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 0: Baseline Replication (Week 0-1)
**Goal:** Create 1:1 copy of kr-serve-mlx with all tests passing

- Copy entire codebase structure
- Update branding to mlx-serving (without breaking APIs)
- Verify 100% test pass rate
- Establish CI/CD baseline

**Effort:** 0.5 sprint (2-3 engineer-days)

### Phase 1: Zod Integration (Week 2-6)
**Goal:** Add comprehensive validation across all boundaries

**Key Deliverables:**
- Central schema library (`src/types/schemas.ts`)
- Zod-validated API surface (Engine, helpers)
- JSON-RPC message schemas
- Config loader with Zod
- Telemetry payload validation

**Files to Modify:**
- `src/api/engine.ts`, `src/api/types.ts`
- `src/config/*.ts`, `src/compat/config-normalizer.ts`
- `src/bridge/serializers.ts`, `src/bridge/jsonrpc-transport.ts`
- `src/telemetry/bridge.ts`, `src/telemetry/events.ts`

**Success Criteria:**
- 100% API boundaries have Zod schemas
- 90%+ test coverage for new schemas
- Consistent error messaging

**Effort:** 1.5 sprints (6-7 engineer-weeks)

### Phase 2: ReScript Migration (Week 7-12)
**Goal:** Move state machines to ReScript for deterministic behavior

**Key Deliverables:**
- ReScript toolchain integration
- ReScript modules for:
  - Circuit breaker state machine
  - Request queue & backpressure
  - Stream registry
  - Batch scheduler
- TypeScript adapters maintaining existing APIs
- Dual-test strategy (ReScript + Vitest)

**New Files:**
- `rescript/RequestQueue.res`
- `rescript/StreamRegistry.res`
- `rescript/CircuitBreakerState.res`
- `rescript/GenerateBatcher.res`

**Modified Files:**
- `src/core/request-queue.ts` (wrapper)
- `src/bridge/stream-registry.ts` (wrapper)
- `src/utils/circuit-breaker-state.ts` (wrapper)

**Success Criteria:**
- All state modules compile from ReScript
- No TypeScript signature changes
- Deterministic state transitions verified

**Effort:** 2 sprints (8-9 engineer-weeks)

### Phase 3: Integration & Verification (Week 13-16)
**Goal:** Ensure end-to-end system correctness

**Key Deliverables:**
- Contract tests for TS ↔ Python
- Cross-language structured output tests
- Vision + GPU scheduler smoke tests
- Performance benchmarks (±5% target)

**Success Criteria:**
- All CI jobs green (TS, ReScript, Python)
- Performance within ±5% of baseline
- Zero regression in existing features

**Effort:** 1 sprint (4 engineer-weeks)

### Phase 4: Release Readiness (Week 17-18)
**Goal:** Prepare for GA release

**Key Deliverables:**
- Migration guide
- Updated ADRs
- Release automation
- Operational runbooks
- Documentation updates

**Success Criteria:**
- Stakeholder sign-off
- Drop-in replacement verified
- Documentation complete

**Effort:** 0.5-1 sprint (2-3 engineer-weeks)

## Critical Constraints

### MUST PRESERVE
1. **Python Runtime:** All files in `python/` remain functionally unchanged
2. **MLX Integration:** No modifications to MLX kernel interactions
3. **API Compatibility:** 100% backward compatible with kr-serve-mlx v1.4.2
4. **Test Suite:** All 375+ existing tests must pass throughout
5. **Feature Parity:** Model loading, streaming, structured output, vision models, GPU scheduler

### MUST ADD
1. **Zod Schemas:** Every API boundary, config option, JSON-RPC message
2. **ReScript Modules:** Circuit breaker, queues, stream registry, state reconciliation
3. **Type Safety:** Zero `any` types, strict TypeScript throughout
4. **Test Coverage:** 90%+ coverage for new Zod/ReScript code

### MUST NOT DO
- Rewrite from scratch (this is a refactor)
- Change JSON-RPC protocol
- Modify Python runtime behavior
- Break existing customer code
- Add new GPU backend support (out of scope)

## Success Metrics (First 90 Days Post-GA)

| Metric | Target |
|--------|--------|
| Customer Upgrade Rate | 80%+ |
| Production Incidents (Sev-1) | 0 |
| Production Incidents (Sev-2) | ≤2 |
| Token Latency Delta | ±5% |
| Test Coverage (New Code) | ≥90% |
| Support Tickets | -50% vs baseline |

## Risk Management

### Top Risks & Mitigations

1. **Schema Over-Strictness**
   - Risk: Breaking changes from validation
   - Mitigation: Warning mode, opt-out config, automated fixers

2. **ReScript Integration Delays**
   - Risk: Tooling friction
   - Mitigation: Staged rollout, TypeScript fallbacks, spike in temp directory

3. **Performance Regression**
   - Risk: Validation overhead
   - Mitigation: Benchmark hot paths, lazy parsing, fast pre-validators

4. **Migration Confusion**
   - Risk: Customer adoption blockers
   - Mitigation: Docs, CLI doctor tool, 120-day support overlap

5. **GPU Scheduler Contract Drift**
   - Risk: Python/TS interface mismatch
   - Mitigation: Contract tests, Python owner in review loop

## Migration Path for Existing Users

1. **Dual-Publish Phase (Beta)**
   - Publish `mlx-serving@beta`
   - `kr-serve-mlx@latest` depends on mlx-serving
   - Feature flags for validation strictness

2. **Documentation**
   - "Upgrade in 30 minutes" guide
   - npm alias instructions
   - Config validation updates

3. **Tooling Support**
   - `npx mlx-serving doctor` command
   - Environment validation
   - Pre-upgrade checks

4. **Deprecation Timeline**
   - Day 0: GA release
   - Day 60: kr-serve-mlx deprecated
   - Day 120: Security fixes only

## Team Collaboration

### AutomatosX Agents Utilized
- **Architecture Agent (Avery):** System design analysis
- **Product Agent (Paris):** PRD creation and requirements
- **Backend Agent (Bob):** Implementation guidance (planned)
- **Quality Agent (Queenie):** Testing strategy (planned)

### Stakeholders
- **Owner:** Tony (CTO)
- **Product:** Paris
- **Engineering:** Backend (Bob), Fullstack (Felix)
- **DevOps:** Oliver
- **Quality:** Queenie
- **Documentation:** Wendy (Writer)

## Next Steps

1. **Review Documents**
   - Validate PRD with stakeholders
   - Confirm implementation plan timeline
   - Get sign-off on Phase 0 start

2. **Phase 0 Kickoff**
   - Clone kr-serve-mlx codebase
   - Set up mlx-serving repository
   - Establish CI/CD baseline
   - Verify all tests pass

3. **Team Assignment**
   - Assign Phase 1 (Zod) to backend team
   - Schedule ReScript training for Phase 2
   - Reserve Apple Silicon CI runners

4. **Risk Mitigation Preparation**
   - Create ReScript spike in `automatosx/tmp/`
   - Document benchmark baseline
   - Set up telemetry dashboards

## File Organization

```
mlx-serving/
├── automatosx/
│   ├── PRD/
│   │   ├── mlx-serving-architecture-analysis.md
│   │   ├── mlx-serving-prd.md
│   │   ├── mlx-serving-implementation-plan.md
│   │   └── PROJECT_SUMMARY.md (this file)
│   └── tmp/                          # Temporary work files
├── src/                               # TypeScript source (from kr-serve-mlx)
│   ├── api/                          # Public API (will add Zod)
│   ├── core/                         # Core services (will wrap ReScript)
│   ├── bridge/                       # Python IPC (will enhance)
│   ├── config/                       # Config loader (will add Zod)
│   ├── telemetry/                    # Observability (will add Zod)
│   └── types/                        # Type definitions (will add schemas)
├── rescript/                          # NEW: ReScript state machines
│   ├── CircuitBreakerState.res
│   ├── RequestQueue.res
│   ├── StreamRegistry.res
│   └── GenerateBatcher.res
├── python/                            # Python runtime (UNCHANGED)
│   ├── runtime.py
│   ├── models/
│   ├── adapters/
│   └── gpu_scheduler.py
├── tests/                             # Test suites (will expand)
└── docs/                              # Documentation (will update)
```

## References

- **Source Codebase:** `/Users/akiralam/code/kr-serve-mlx`
- **npm Package:** `@defai.digital/kr-serve-mlx`
- **License:** Elastic-2.0
- **Target Platforms:** macOS 26.0+, Apple Silicon M3+
- **Node.js:** 22.0.0+
- **Python:** 3.11-3.12

---

**Document Version:** 1.0
**Last Updated:** 2025-11-07
**Status:** Ready for Stakeholder Review
