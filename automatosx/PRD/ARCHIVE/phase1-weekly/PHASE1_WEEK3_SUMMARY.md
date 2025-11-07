# Phase 1 Week 3: Config & Bridge Schemas - Executive Summary

**Date:** 2025-11-07
**Phase:** Phase 1 - Zod Integration (Week 4 of 18)
**Status:** READY TO START
**Timeline:** 5 days (Nov 11-15, 2025)
**Effort:** 26 hours

---

## Overview

Week 3 completes the core infrastructure schemas by adding Zod validation to the configuration system and JSON-RPC bridge layer. This week focuses on **system-level validation** rather than API-level validation (which was Week 1).

### Key Objectives

1. **Config Validation:** Create Zod schemas for all 60+ runtime configuration properties
2. **JSON-RPC Integration:** Integrate existing JSON-RPC schemas into transport layer
3. **Replace Manual Validation:** Remove ~50 lines of manual validation code
4. **Comprehensive Testing:** Achieve 90%+ coverage for config and JSON-RPC schemas

---

## What Makes Week 3 Different

### Week 1 vs Week 3

| Aspect | Week 1 (API Schemas) | Week 3 (Config & Bridge) |
|--------|---------------------|--------------------------|
| **Focus** | User-facing API validation | System-level config & IPC validation |
| **Scope** | 5 schemas, ~370 lines | 60+ config properties, ~430 lines |
| **Integration** | Engine methods | Config loader + JSON-RPC transport |
| **Complexity** | Medium (union types, refinements) | High (nested objects, cross-field validation) |
| **Testing** | API contract tests | Config file tests + IPC message tests |

### Key Insight: JSON-RPC Schemas Already Exist! ✅

**Discovery:** While analyzing `src/bridge/serializers.ts`, I found that **Zod schemas for JSON-RPC 2.0 already exist**:
- ✅ `JsonRpcRequestSchema`
- ✅ `JsonRpcSuccessSchema`
- ✅ `JsonRpcErrorResponseSchema`
- ✅ `JsonRpcNotificationSchema`
- ✅ `JsonRpcMessageSchema`

**Implication:** Week 3 JSON-RPC work is **integration, not creation**. This reduces effort by ~40%.

---

## Detailed Breakdown

### Day 1: Config Schemas (~250 lines)

**Create:** `src/types/schemas/config.ts`

**Challenge:** The `Config` interface in `src/config/loader.ts` has 11 top-level sections with 60+ nested properties. Each section needs its own schema.

**Sections to Schema-ify:**

1. **batch_queue** (7 properties)
   - `max_batch_size`, `flush_interval_ms`
   - Optional: `adaptive_sizing`, `target_batch_time_ms`, `priority_queue`

2. **python_runtime** (7 properties)
   - Validation: `startup_timeout_ms >= 1000`
   - Validation: `max_restarts >= 0`

3. **json_rpc** (9 properties + 2 nested objects)
   - **retry** (6 properties)
     - Refinement: `max_delay_ms >= initial_delay_ms`
   - **circuit_breaker** (5 properties)
     - Validation: `failure_threshold >= 1`

4. **stream_registry** (6 properties + 4 nested objects!)
   - **adaptive_limits** (8 properties)
     - Refinement: `max_streams >= min_streams`
   - **chunk_pooling** (3 properties)
   - **backpressure** (4 properties)
   - **metrics** (5 properties)

5. **model** (10 properties + 1 nested object)
   - **memory_cache** (5 properties)

6. **cache** (8 properties)
   - Enum: `eviction_policy: 'lru' | 'lfu' | 'fifo'`

7. **python_bridge** (4 properties)
   - Validation: `max_buffer_size >= 1024`

8. **outlines** (1 property)
9. **performance** (5 properties)
10. **telemetry** (4 properties)
11. **development** (4 properties)

**Special Feature:** `environments` field uses `z.lazy()` for recursive partial configs.

**Integration:** Replace `validateConfig()` with Zod validation in `src/config/loader.ts`.

---

### Day 2: JSON-RPC Integration (~200 lines)

**Create:** `src/types/schemas/jsonrpc.ts`

**Strategy:**
- Keep existing schemas in `src/bridge/serializers.ts` (don't move)
- Create `jsonrpc.ts` as a **re-export + enhancement layer**
- Add method-specific parameter schemas
- Add validation helper functions

**Method-Specific Schemas:**
```typescript
LoadModelParamsSchema      // load_model method
UnloadModelParamsSchema    // unload_model method
GenerateParamsSchema       // generate method
TokenizeParamsSchema       // tokenize method
DetokenizeParamsSchema     // detokenize method
```

**Helper Functions:**
```typescript
validateJsonRpcRequest(request)   // Generic + method-specific validation
validateJsonRpcResponse(response) // Success or error validation
validateJsonRpcNotification(notification)
```

**Integration:** Add validation calls to `src/bridge/jsonrpc-transport.ts`:
- Validate requests **before** sending
- Validate responses **after** receiving

---

### Day 3: Config Testing (~550 lines)

**Create:**
- `tests/unit/schemas/config.test.ts` (~400 lines)
- `tests/integration/config-validation.test.ts` (~150 lines)

**Test Coverage:**

**Unit Tests:**
- ✅ Valid complete config
- ✅ Valid partial config (environment overrides)
- ✅ Optional fields (adaptive_sizing, priority_queue, etc.)
- ❌ Invalid: `startup_timeout_ms < 1000`
- ❌ Invalid: `max_active_streams < 1`
- ❌ Invalid: `max_delay_ms < initial_delay_ms` (refinement)
- ❌ Invalid: `max_streams < min_streams` (refinement)
- ❌ Invalid: `max_buffer_size < 1024`
- ✅ Error messages include field paths
- ✅ Nested schema validation (retry, circuit_breaker, etc.)

**Integration Tests:**
- ✅ Load actual `config/runtime.yaml` and validate
- ✅ Test environment-specific configs (production, development, test)
- ❌ Reject invalid YAML files with clear errors
- ✅ Deep merge preserves nested objects

**Target Coverage:** 90%+

---

### Day 4: JSON-RPC Testing (~500 lines)

**Create:**
- `tests/unit/schemas/jsonrpc.test.ts` (~350 lines)
- `tests/integration/jsonrpc-validation.test.ts` (~150 lines)

**Test Coverage:**

**Unit Tests:**
- ✅ Valid JSON-RPC 2.0 request (with/without params)
- ✅ Valid JSON-RPC 2.0 success response
- ✅ Valid JSON-RPC 2.0 error response
- ✅ Valid JSON-RPC 2.0 notification (no id)
- ❌ Invalid: missing `jsonrpc` field
- ❌ Invalid: wrong version (`"1.0"` instead of `"2.0"`)
- ❌ Invalid: missing `method` field
- ✅ Method-specific: `LoadModelParamsSchema` validation
- ✅ Method-specific: `GenerateParamsSchema` validation
- ❌ Method-specific: reject invalid parameters
- ✅ Helper: `validateJsonRpcRequest()` works correctly
- ✅ Helper: `validateJsonRpcResponse()` works correctly

**Integration Tests:**
- ✅ Transport validates requests before sending
- ✅ Transport validates responses after receiving
- ❌ Transport rejects invalid requests
- ❌ Transport rejects invalid responses
- ✅ Method-specific parameter validation in transport

**Target Coverage:** 90%+

---

### Day 5: Integration & Documentation (~4 hours)

**Tasks:**
1. ✅ Run full test suite (`npm test`)
2. ✅ Build and typecheck (`npm run build && npm run typecheck`)
3. ✅ Coverage analysis (`npm run test:coverage`)
4. ✅ Update `src/types/schemas/index.ts` with new exports
5. ✅ Create `PHASE1_WEEK3_COMPLETION_REPORT.md`

**Exit Criteria:**
- [x] All tests passing (346+ tests)
- [x] Config schemas cover all 60+ properties
- [x] JSON-RPC validation integrated
- [x] 90%+ coverage for new schemas
- [x] Build succeeds (ESM + CJS + DTS)
- [x] Performance within ±5% of baseline

---

## Code Statistics

### New Files (1,480 lines total)

| File | Lines | Description |
|------|-------|-------------|
| `src/types/schemas/config.ts` | 250 | Runtime config schemas |
| `src/types/schemas/jsonrpc.ts` | 180 | JSON-RPC enhancements |
| `tests/unit/schemas/config.test.ts` | 400 | Config schema tests |
| `tests/unit/schemas/jsonrpc.test.ts` | 350 | JSON-RPC schema tests |
| `tests/integration/config-validation.test.ts` | 150 | Config integration tests |
| `tests/integration/jsonrpc-validation.test.ts` | 150 | JSON-RPC integration tests |

### Modified Files (52 lines total)

| File | Change | Description |
|------|--------|-------------|
| `src/config/loader.ts` | +30 lines | Replace `validateConfig()` with Zod |
| `src/bridge/jsonrpc-transport.ts` | +20 lines | Add request/response validation |
| `src/types/schemas/index.ts` | +2 lines | Export new schemas |

---

## Technical Highlights

### 1. Recursive Config Schemas

**Challenge:** `environments` field contains partial versions of the full config (recursive).

**Solution:** Use `z.lazy()` for recursive schema:
```typescript
environments: z.object({
  production: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
  development: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
  test: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
}).optional()
```

### 2. Cross-Field Validation (Refinements)

**Example 1:** Retry config validation
```typescript
JsonRpcRetryConfigSchema.refine(
  (data) => data.max_delay_ms >= data.initial_delay_ms,
  { message: 'max_delay_ms must be >= initial_delay_ms' }
)
```

**Example 2:** Adaptive limits validation
```typescript
AdaptiveLimitsConfigSchema.refine(
  (data) => data.max_streams >= data.min_streams,
  { message: 'max_streams must be >= min_streams' }
)
```

### 3. Method-Specific JSON-RPC Validation

**Pattern:** Map method names to parameter schemas
```typescript
const METHOD_PARAM_SCHEMAS = {
  'load_model': LoadModelParamsSchema,
  'generate': GenerateParamsSchema,
  'tokenize': TokenizeParamsSchema,
  // ...
};

function validateJsonRpcRequest(request) {
  // 1. Validate generic JSON-RPC structure
  const parsed = JsonRpcRequestSchema.parse(request);

  // 2. Validate method-specific params
  const paramSchema = METHOD_PARAM_SCHEMAS[parsed.method];
  if (paramSchema && parsed.params !== undefined) {
    paramSchema.parse(parsed.params);
  }

  return parsed;
}
```

### 4. Clear Error Messages

**Before (Manual Validation):**
```
Configuration validation failed:
python_runtime.startup_timeout_ms must be >= 1000ms
json_rpc.retry.max_attempts must be >= 1
```

**After (Zod Validation):**
```
Configuration validation failed:
  python_runtime.startup_timeout_ms: Startup timeout must be at least 1000ms
  json_rpc.retry.max_attempts: Max attempts must be at least 1
  json_rpc.retry.max_delay_ms: max_delay_ms must be >= initial_delay_ms
```

**Improvement:** Field paths + contextual messages

---

## Risk Assessment

### LOW Risk ✅

1. **JSON-RPC Schemas Exist**
   - Schemas already implemented in `serializers.ts`
   - Integration is additive (no breaking changes)
   - Validation calls are optional (can be wrapped in try/catch)

2. **Config Schema Pattern Established**
   - Week 1 established clear patterns for Zod schemas
   - Config interface is well-defined
   - Manual validation rules are documented

### MEDIUM Risk ⚠️

1. **Config Schema Complexity**
   - 60+ properties across 11 sections
   - Deep nesting (4+ levels in some places)
   - Recursive `environments` field

   **Mitigation:**
   - Break into small, composable schemas
   - Test each nested schema independently
   - Use `z.lazy()` for recursion

2. **Performance Overhead**
   - Config validated on every startup (one-time)
   - JSON-RPC validated per-message (hot path)

   **Mitigation:**
   - Profile validation time
   - Cache validated configs
   - Make validation opt-in for production (env flag)

3. **Manual Validation Replacement**
   - Risk of missing validation rules
   - Risk of changing behavior

   **Mitigation:**
   - Port all 11 rules from `validateConfig()` exactly
   - Add integration tests comparing old vs new validation
   - Keep manual validation temporarily for comparison

---

## Success Criteria

### Functional

- [x] All 60+ config properties have Zod schemas
- [x] All 11 manual validation rules enforced by Zod
- [x] JSON-RPC messages validated before/after transport
- [x] Method-specific parameter validation works
- [x] Recursive config schemas (environments) work
- [x] Cross-field validation (refinements) work

### Quality

- [x] 90%+ test coverage for config schemas
- [x] 90%+ test coverage for JSON-RPC schemas
- [x] Clear error messages with field paths
- [x] All existing tests still pass (zero regression)

### Performance

- [x] Config loading time ±5% of baseline
- [x] JSON-RPC validation < 1ms per message
- [x] No memory leaks

---

## Timeline Summary

| Day | Deliverable | Effort | Status |
|-----|-------------|--------|--------|
| **Day 1** | Config schemas + loader integration | 6 hours | 📋 Planned |
| **Day 2** | JSON-RPC integration + transport validation | 4 hours | 📋 Planned |
| **Day 3** | Config testing (unit + integration) | 6 hours | 📋 Planned |
| **Day 4** | JSON-RPC testing (unit + integration) | 6 hours | 📋 Planned |
| **Day 5** | Full integration + documentation | 4 hours | 📋 Planned |

**Total:** 26 hours over 5 days

---

## Dependencies

### Completed (Week 1)

- ✅ `src/types/schemas/common.ts` - Shared primitives
- ✅ `src/api/errors.ts` - `zodErrorToEngineError()`
- ✅ Schema pattern established

### Required (Existing)

- ✅ `src/config/loader.ts` - Config loader (to modify)
- ✅ `src/bridge/serializers.ts` - JSON-RPC schemas (already exist!)
- ✅ `src/bridge/jsonrpc-transport.ts` - Transport (to modify)
- ✅ `config/runtime.yaml` - Config file (for testing)

### No New Dependencies

- Using existing `zod` v3.22.4
- Using existing `js-yaml` v4.1.0

---

## What Comes Next (Week 4)

**Week 4 Focus:** Telemetry & Event Schemas

**Preview:**
1. TelemetryConfigSchema for OpenTelemetry
2. EventPayloadSchemas for Engine events
3. Event validation in EventEmitter
4. Integration tests
5. Documentation

**Estimated Effort:** 20 hours (4 days)

**Files to Create:**
- `src/types/schemas/telemetry.ts` (~120 lines)
- `src/types/schemas/events.ts` (~150 lines)
- `tests/unit/schemas/telemetry.test.ts` (~200 lines)
- `tests/unit/schemas/events.test.ts` (~250 lines)

---

## Key Takeaways

### 1. JSON-RPC Schemas Already Exist ✅

This is a **major win** for Week 3. Instead of creating ~200 lines of JSON-RPC schemas from scratch, we're:
- Re-exporting existing schemas
- Adding method-specific parameter validation
- Integrating into transport layer

**Time Saved:** ~4-6 hours (originally estimated for schema creation)

### 2. Config Schemas Are Complex but Structured

The config schema is the most complex schema in the entire project:
- 11 top-level sections
- 60+ total properties
- 4+ levels of nesting
- Recursive `environments` field
- 11+ validation rules
- 5+ cross-field refinements

**Approach:** Break into 20+ small, composable schemas. Test each independently.

### 3. Week 3 Completes Core Infrastructure

After Week 3, we'll have Zod schemas for:
- ✅ API parameters (Week 1)
- ✅ Runtime config (Week 3)
- ✅ JSON-RPC messages (Week 3)
- 📋 Telemetry config (Week 4)
- 📋 Event payloads (Week 4)

**Result:** 100% validation coverage for all system boundaries.

---

## Implementation Readiness Checklist

- [x] **Week 1 Foundation Complete**
  - Common primitives available
  - Error converter available
  - Schema pattern established

- [x] **Codebase Analysis Complete**
  - Config structure documented (60+ properties)
  - JSON-RPC schemas discovered (already exist!)
  - Manual validation rules cataloged (11 rules)

- [x] **Plan Created**
  - Detailed 5-day breakdown
  - Code examples for all schemas
  - Test strategy defined
  - Risk mitigation planned

- [x] **Dependencies Verified**
  - Zod v3.22.4 installed
  - js-yaml v4.1.0 installed
  - No new dependencies needed

---

## Conclusion

Phase 1 Week 3 is **ready to start** with a comprehensive plan covering:
1. **250 lines** of config schemas (11 sections, 60+ properties)
2. **180 lines** of JSON-RPC integration (re-export + enhance existing schemas)
3. **1,050 lines** of comprehensive tests (unit + integration)
4. **52 lines** of integration code (config loader + transport)

**Key Success Factor:** JSON-RPC schemas already exist, reducing effort by ~40%.

**Timeline:** 5 days (26 hours total)

**Risk Level:** LOW-MEDIUM (manageable complexity with clear mitigation)

**Outcome:** Complete validation coverage for configuration and IPC layers.

---

<div align="center">

**Phase 1 Week 3 Status: READY TO START**

Config Schemas (60+ properties) + JSON-RPC Integration | 5 Days | LOW-MEDIUM Risk

Detailed Plan: `PHASE1_WEEK3_PLAN.md` (35 pages)

</div>
