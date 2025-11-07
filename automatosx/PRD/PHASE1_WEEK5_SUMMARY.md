# Phase 1 Week 5: Integration & Error Handling - Executive Summary

**Date:** 2025-11-07
**Phase:** Phase 1 - Zod Integration (Week 5 of 18)
**Status:** READY TO START
**Timeline:** 5 days (26 hours total)
**Effort:** MEDIUM complexity

---

## Overview

Week 5 is the **integration week** that brings together all schemas from Weeks 1-4, completing the Zod validation infrastructure across the entire Engine API surface.

### What This Week Delivers

**Complete Integration:**
- 7 Engine methods with Zod validation
- Config loader with RuntimeConfigSchema validation
- Telemetry/event validation (from Week 4)
- Migration from manual validators to Zod

**Comprehensive Testing:**
- ~700 lines of integration tests
- ~350 lines of performance tests
- ~250 lines of contract tests
- Total: ~1100 lines of test coverage

**Validation:**
- Performance benchmarks (< 5% overhead)
- Contract tests (100% kr-serve-mlx v1.4.2 compatibility)
- Error message quality validation

---

## Scope Breakdown

### Engine API Integration (7 methods)

**Core Methods (Week 2 continuation):**
1. `loadModel()` - LoadModelOptionsSchema
2. `loadDraftModel()` - LoadModelOptionsSchema
3. `createGenerator()` - GeneratorParamsWithStructuredSchema
4. `tokenize()` - TokenizeRequestSchema

**Vision Methods (new schemas):**
5. `loadVisionModel()` - VisionModelOptionsSchema (create ~30 lines)
6. `createVisionGenerator()` - VisionGeneratorParamsSchema (create ~30 lines)

**Extended Methods:**
7. `warmupModel()` - LoadModelOptionsSchema

**Integration Pattern:**
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // Zod validation (Phase 1 Week 5)
  const opts = typeof options === 'string' ? { model: options } : options;
  const parseResult = LoadModelOptionsSchema.safeParse(opts);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // Existing implementation (unchanged)
  const normalizedOptions = normalizeLoadModelOptions(options);
  // ... rest
}
```

**Total Changes:** ~80 lines added to engine.ts

---

### Config Validation Integration

**Current State (Manual):**
```typescript
// src/config/loader.ts:298-358 (100+ lines of if statements)
export function validateConfig(config: Config): void {
  if (!config.batch_queue) throw new Error('batch_queue required');
  if (!config.python_runtime) throw new Error('python_runtime required');
  // ... 100+ more lines
}
```

**Target State (Zod):**
```typescript
import { RuntimeConfigSchema, zodErrorToEngineError } from '../types/schemas/index.js';

export function validateConfig(config: Config): void {
  const parseResult = RuntimeConfigSchema.safeParse(config);
  if (!parseResult.success) {
    const engineError = zodErrorToEngineError(parseResult.error);
    throw new Error(`Config validation failed: ${engineError.message}`, {
      cause: engineError,
    });
  }
}
```

**Benefits:**
- Single source of truth (schema defines validation)
- Better error messages (field-level details)
- Maintainability (add fields to schema, not validator)
- Type safety (z.infer ensures types match)

**Total Changes:** ~10 lines to loader.ts

---

## Testing Strategy

### Integration Tests (~700 lines)

**File 1: zod-validation.test.ts** (~300 lines)
- Test all 7 Engine methods with valid/invalid inputs
- Validate error message quality (field names, actionable messages)
- Test passthrough mode (.passthrough() allows extra fields)
- Validate structured output refinements

**Example Test:**
```typescript
describe('createGenerator() validation', () => {
  it('should reject maxTokens > 100000', async () => {
    expect(() =>
      engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello',
        maxTokens: 200000,
      })
    ).toThrow(/Validation error on field 'maxTokens'/);
  });

  it('should reject structured without schema', async () => {
    expect(() =>
      engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello',
        structured: { format: 'json' } as any,
      })
    ).toThrow(/structured\.schema.*required/);
  });
});
```

**File 2: config-validation.test.ts** (~200 lines)
- Test RuntimeConfigSchema with valid/invalid configs
- Validate YAML loading with schema validation
- Test environment overrides with validation

**File 3: event-validation.test.ts** (~200 lines)
- Test all 8 event payload schemas
- Validate EngineEventEmitter.emit*() methods
- Test event emission with invalid payloads

---

### Performance Tests (~350 lines)

**File 1: validation-overhead.test.ts** (~200 lines)

**Benchmarks:**
1. Zod validation speed (< 0.1ms per call)
2. Manual validation speed (baseline)
3. Overhead comparison (Zod vs Manual, < 50% acceptable)
4. Error generation speed (< 0.5ms per call)

**Example Benchmark:**
```typescript
it('should compare Zod vs Manual validation overhead', () => {
  const iterations = 10000;

  // Zod validation
  const zodStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    LoadModelOptionsSchema.safeParse(validOptions);
  }
  const zodTime = performance.now() - zodStart;

  // Manual validation
  const manualStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    validateLoadModelOptions(validOptions);
  }
  const manualTime = performance.now() - manualStart;

  const overhead = ((zodTime - manualTime) / manualTime) * 100;
  console.log(`Zod overhead: ${overhead.toFixed(2)}%`);

  expect(overhead).toBeLessThan(50); // < 50% overhead acceptable
});
```

**File 2: e2e-validation.test.ts** (~150 lines)

**End-to-End Tests:**
1. loadModel() with validation (measure total time)
2. createGenerator() with validation (measure total time)
3. Validate overhead is negligible (< 1ms for API calls)

**Expected Results:**
- Validation overhead: < 0.1ms per call
- E2E overhead: < 1% of total operation time
- Model loading: 100-1000ms (validation is 0.01-0.1%)

---

### Contract Tests (~250 lines)

**File: kr-serve-mlx-compat.test.ts**

**Goal:** Ensure 100% API compatibility with kr-serve-mlx v1.4.2

**Test Categories:**

**1. loadModel() compatibility:**
- String model identifier (kr-serve-mlx v1.4.2 API)
- ModelDescriptor object (kr-serve-mlx v1.4.2 API)
- Extra kwargs (passthrough mode)

**2. createGenerator() compatibility:**
- Generator params (kr-serve-mlx v1.4.2 API)
- Structured output (kr-serve-mlx v1.4.2 API)
- Extra sampling params (passthrough mode)

**3. Error compatibility:**
- Error shape (code, message, details)
- Error codes (InvalidParams for validation errors)

**Example Test:**
```typescript
it('should accept kr-serve-mlx extra kwargs (passthrough)', async () => {
  // kr-serve-mlx v1.4.2 API call with custom mlx-engine kwargs
  const handle = await engine.loadModel({
    model: 'llama-3-8b',
    custom_mlx_param: 'value', // Not in TypeScript types, allowed by .passthrough()
  } as any);

  expect(handle.id).toBe('llama-3-8b');
});
```

---

## Timeline

| Day | Focus | Hours | Deliverables |
|-----|-------|-------|--------------|
| **Day 1** | Engine integration | 6 | Zod in 7 core methods (+80 lines) |
| **Day 2** | Config & vision | 5 | Config validation, vision schemas (+70 lines) |
| **Day 3** | Integration tests | 6 | 700 lines of integration tests |
| **Day 4** | Performance tests | 5 | Benchmarks, E2E tests (350 lines) |
| **Day 5** | Contract tests + docs | 4 | Contract tests (250 lines), completion report |

**Total:** 26 hours over 5 days

---

## Code Statistics

### Modified Files (150 lines)

| File | Change | Description |
|------|--------|-------------|
| src/api/engine.ts | +80 lines | Zod validation in 7 methods |
| src/config/loader.ts | +10 lines | RuntimeConfigSchema integration |
| src/types/schemas/model.ts | +30 lines | VisionModelOptionsSchema |
| src/types/schemas/generator.ts | +30 lines | VisionGeneratorParamsSchema |

### New Test Files (1100 lines)

| File | Lines | Description |
|------|-------|-------------|
| tests/integration/zod-validation.test.ts | 300 | Engine method validation tests |
| tests/integration/config-validation.test.ts | 200 | Config validation tests |
| tests/integration/event-validation.test.ts | 200 | Event validation tests |
| tests/performance/validation-overhead.test.ts | 200 | Performance benchmarks |
| tests/performance/e2e-validation.test.ts | 150 | E2E performance tests |
| tests/contract/kr-serve-mlx-compat.test.ts | 250 | Contract tests |

---

## Success Criteria

### Must Have ✅

- [ ] 7 Engine methods use Zod validation
- [ ] RuntimeConfigSchema integrated into config loader
- [ ] TelemetryConfig and event validation integrated (Week 4)
- [ ] ≥300 integration tests (Engine methods)
- [ ] Performance validation (< 5% overhead vs manual)
- [ ] Contract tests (100% kr-serve-mlx v1.4.2 compatibility)
- [ ] 473+ tests passing (373 baseline + 100 new)
- [ ] npm run build succeeds
- [ ] npm run typecheck passes

### Nice to Have

- [ ] Manual validators marked @deprecated
- [ ] Performance comparison table
- [ ] Coverage report (≥95%)

---

## Risk Assessment

### LOW Risk ✅

1. **Schemas Already Exist**
   - Weeks 1-4 created all necessary schemas
   - Just need to integrate (call .safeParse())
   - Integration pattern proven in Week 2

2. **Clear Integration Points**
   - 7 methods with complex params
   - All in engine.ts (single file)
   - No refactoring required

3. **Backward Compatibility**
   - .passthrough() ensures extra fields allowed
   - Contract tests verify no breaking changes
   - Manual validators kept (deprecated)

### MEDIUM Risk ⚠️

1. **Performance Overhead**
   - **Concern:** Zod validation may add latency
   - **Mitigation:** Benchmark to ensure < 5% overhead
   - **Expected:** < 0.1ms per validation (negligible)

2. **Week 2 Dependency**
   - **Concern:** Week 5 assumes Week 2 completed (TS errors fixed)
   - **Mitigation:** If Week 2 not done, fix TS errors first (2-3 hours)
   - **Impact:** May delay start by 1 day

3. **Vision Schema Gaps**
   - **Concern:** VisionModelOptions not in Weeks 1-4
   - **Mitigation:** Create minimal schemas on Day 2 (~60 lines)
   - **Impact:** LOW - similar to existing schemas

---

## Dependencies

### Completed ✅

- Zod v3.22.4 installed
- zodErrorToEngineError converter
- All core schemas (LoadModelOptions, GeneratorParams, TokenizeRequest)
- RuntimeConfigSchema (Week 3)
- TelemetryConfig and event schemas (Week 4)

### Required

- **Week 2 completion** - TypeScript errors fixed
- **Week 3 completion** - RuntimeConfigSchema created
- **Week 4 completion** - Telemetry/event schemas created

### Blocked By

- If Week 2-4 not done, must create missing schemas first

---

## What Comes After Week 5

### Week 6: Documentation & Testing (Final Week)

**Focus:** Complete Phase 1 with comprehensive documentation

**Deliverables:**
1. `docs/ZOD_SCHEMAS.md` - Guide to using Zod schemas
2. API Reference - Update with schema exports
3. Migration Guide - Manual validators → Zod
4. README Updates - Add Zod validation examples
5. Final Validation - Full test suite, coverage report

**Timeline:** 3 days (15 hours)

**Outcome:** Phase 1 complete, ready for Phase 2 (Caching & Optimization)

---

## Migration Strategy

### Current: Manual Validators (323 lines)

```typescript
// src/api/validators.ts
export function validateLoadModelOptions(options: LoadModelOptions): ValidationResult {
  const errors: string[] = [];
  if (!options.model) errors.push('model is required');
  if (typeof options.model === 'string' && options.model.trim().length === 0) {
    errors.push('model identifier cannot be empty');
  }
  // ... 50+ more lines
  return { valid: errors.length === 0, errors };
}
```

**Issues:**
- Maintenance burden (323 lines)
- String-based errors (not structured)
- Duplication (validation logic repeated)
- Incomplete (some edge cases not covered)

### Target: Zod Validators (30 lines)

```typescript
// src/types/schemas/model.ts
export const LoadModelOptionsSchema = z.object({
  model: z.union([NonEmptyString, ModelDescriptorSchema]),
  draft: z.boolean().optional(),
  revision: z.string().optional(),
  quantization: QuantizationMode.optional(),
  parameters: z.record(z.unknown()).optional(),
  trustRemoteCode: z.boolean().optional(),
}).passthrough();
```

**Benefits:**
- Single source of truth (schema = type + validation)
- Structured errors (field paths, issue details)
- Better error messages (custom messages per constraint)
- Comprehensive (all edge cases validated)

### Migration Path

**Week 5:** Add Zod alongside manual validators
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // NEW: Zod validation
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // OLD: Manual validation (keep for now)
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid model options');
  }

  // ... implementation
}
```

**v1.0.0:** Remove manual validators
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // Only Zod validation
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... implementation (no manual validation)
}
```

---

## Key Insights

### Why This Week is Critical 🎯

1. **Completes Phase 1**
   - All schemas from Weeks 1-4 integrated
   - Full API surface validated with Zod
   - Foundation for Phase 2 (Caching & Optimization)

2. **Proves the Architecture**
   - Performance validated (< 5% overhead)
   - Contract tests prove backward compatibility
   - Integration tests prove end-to-end correctness

3. **Enables Future Work**
   - Schema-first development for new features
   - Type-safe API evolution
   - Automatic validation for all inputs

### What Makes This Week Manageable ✅

1. **Clear Scope**
   - 7 methods to integrate (known list)
   - Integration pattern established (Week 2)
   - All schemas already exist (Weeks 1-4)

2. **Low Risk**
   - No refactoring required
   - Backward compatible (.passthrough())
   - Manual validators kept as fallback

3. **High Confidence**
   - Contract tests prove compatibility
   - Performance tests prove no regression
   - Integration tests prove correctness

---

## Bottom Line

Phase 1 Week 5 is the **integration week** that completes Zod validation:

- ✅ 7 Engine methods with Zod validation
- ✅ Config loader with RuntimeConfigSchema
- ✅ Comprehensive testing (~1100 lines)
- ✅ Performance validation (< 5% overhead)
- ✅ Contract tests (100% compatibility)
- ✅ Timeline: 5 days (26 hours)
- ✅ Risk: LOW-MEDIUM (manageable)

**After Week 5:** All Zod integration complete. Week 6 adds documentation and finalizes Phase 1.

---

<div align="center">

**Phase 1 Week 5 Status: READY TO START**

Integration & Error Handling | 5 Days | 26 Hours | MEDIUM Risk

Detailed Plan: `PHASE1_WEEK5_PLAN.md` (30 pages)

</div>
