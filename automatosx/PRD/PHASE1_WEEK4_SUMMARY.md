# Phase 1 Week 4: Telemetry & Event Schemas - Executive Summary

**Date:** 2025-11-07
**Phase:** Phase 1 - Zod Integration (Week 4 of 18)
**Status:** READY TO START
**Timeline:** 4 days (20 hours total)
**Effort:** LOW complexity

---

## Overview

Week 4 completes the core validation infrastructure by adding Zod schemas for **telemetry configuration** and **Engine event payloads**. This is the final week of schema creation in Phase 1.

### What This Week Delivers

**2 New Schema Files:**
1. `src/types/schemas/telemetry.ts` - TelemetryConfig validation
2. `src/types/schemas/events.ts` - 8 event payload schemas

**2 Integration Points:**
1. `src/telemetry/bridge.ts` - Validate configs on construction
2. `src/api/events.ts` - Validate payloads on emission

**Comprehensive Tests:**
- ~200 lines for telemetry schema tests
- ~250 lines for event schema tests
- Total: ~450 lines of test coverage

---

## Scope Breakdown

### Telemetry Schemas (~120 lines)

**TelemetryConfigSchema:**
- `enabled` (boolean, required)
- `serviceName` (string, optional, alphanumeric+hyphens, max 100 chars)
- `prometheusPort` (number, optional, 1024-65535)
- `exportIntervalMs` (number, optional, 1000-600000)

**MetricLabelsSchema (Optional):**
- Validates metric labels/attributes
- Ensures OpenTelemetry compatibility (string values)

**Design Notes:**
- Uses `.strict()` mode (no extra fields allowed)
- Logger field intentionally omitted (Pino instance not validatable)
- Port range restricted to non-privileged ports
- Service name follows Prometheus naming conventions

### Event Schemas (~200 lines)

**8 Event Payload Schemas:**

1. **ModelLoadedEvent**
   - model, modelPath (required)
   - quantization, parameters, metadata (optional)

2. **ModelUnloadedEvent**
   - model (required)
   - reason (optional)

3. **ModelInvalidatedEvent**
   - model, reason (both required)

4. **GenerationStartedEvent**
   - model, prompt (required)
   - maxTokens, metadata (optional)
   - Prompt can be string or object (templates/multimodal)

5. **TokenGeneratedEvent**
   - model, token (required)
   - logprob, metadata (optional)
   - Allows empty token (EOS marker)

6. **GenerationCompletedEvent**
   - model, tokensGenerated, durationMs (required)
   - throughput, metadata (optional)

7. **ErrorEvent**
   - error (required)
   - code, model, metadata (optional)

8. **RuntimeStatusEvent**
   - status (enum: ready|busy|error|shutdown), modelsLoaded (required)
   - activeTasks, metadata (optional)

**Design Notes:**
- All schemas use `.strict()` mode
- Clear error messages for all constraints
- Metadata fields use `z.record(z.unknown())` for flexibility

---

## Integration Strategy

### TelemetryBridge Integration (5 lines)

**Current:** Constructor accepts TelemetryConfig directly
**Change:** Add Zod validation before creating TelemetryManager

```typescript
constructor(config: TelemetryConfig, hooks: TelemetryHooks = {}) {
  // Validate config with Zod
  const parseResult = TelemetryConfigSchema.safeParse(config);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }
  // ... rest of constructor
}
```

**Impact:** Catches invalid configs at construction time (fail-fast)

### EngineEventEmitter Integration (60 lines)

**Current:** 8 emit methods with no validation
**Change:** Add validation helper + validate in each emit method

```typescript
private validateEvent<T>(
  schema: z.ZodSchema<T>,
  event: unknown,
  eventName: string
): T {
  const parseResult = schema.safeParse(event);
  if (!parseResult.success) {
    this.logger?.error({ error: parseResult.error, eventName }, 'Invalid event payload');
    throw zodErrorToEngineError(parseResult.error);
  }
  return parseResult.data;
}

public emitModelLoaded(event: ModelLoadedEvent): void {
  const validated = this.validateEvent(ModelLoadedEventSchema, event, 'modelLoaded');
  this.logger?.debug({ event: validated }, 'Model loaded');
  this.emit('modelLoaded', validated);
}
```

**Impact:** Prevents invalid events from being emitted (data integrity)

---

## Testing Strategy

### Telemetry Schema Tests (~200 lines)

**Valid Configurations:**
- Minimal config (enabled only)
- Full config (all fields)
- Disabled config
- Service name variations (hyphens, underscores)
- Minimum/maximum port values
- Minimum/maximum export intervals

**Invalid Configurations:**
- Missing enabled field
- Invalid enabled type (string instead of boolean)
- Empty/too-long service name
- Invalid service name characters
- Port out of range (< 1024 or > 65535)
- Export interval out of range (< 1s or > 10m)
- Extra fields (strict mode)

**Error Messages:**
- Clear field identification
- Actionable validation messages

### Event Schema Tests (~250 lines)

**For Each Event Type:**
- Valid minimal payload
- Valid full payload (with optional fields)
- Invalid required fields (missing, empty, wrong type)
- Invalid optional fields (negative numbers, wrong enums)
- Edge cases (zero tokens, empty EOS token, etc.)

**Special Focus:**
- ModelInvalidatedEvent: reason is required (not optional)
- TokenGeneratedEvent: allow empty token (EOS marker)
- GenerationCompletedEvent: allow zero tokens (edge case)
- RuntimeStatusEvent: enum validation for status field

---

## Timeline

| Day | Focus | Hours | Deliverables |
|-----|-------|-------|--------------|
| **Day 1** | Telemetry | 5 | telemetry.ts (120 lines) + integration (5 lines) |
| **Day 2** | Events | 5 | events.ts (200 lines) + integration (60 lines) |
| **Day 3** | Testing | 8 | telemetry.test.ts (200 lines) + events.test.ts (250 lines) |
| **Day 4** | Validation | 2 | Test suite, build, coverage, completion report |

**Total:** 20 hours over 4 days

---

## Code Statistics

### New Files (470 lines)

| File | Lines | Purpose |
|------|-------|---------|
| src/types/schemas/telemetry.ts | 120 | Telemetry config schemas |
| src/types/schemas/events.ts | 200 | 8 event payload schemas |
| tests/unit/schemas/telemetry.test.ts | 200 | Telemetry schema tests |
| tests/unit/schemas/events.test.ts | 250 | Event schema tests |

### Modified Files (70 lines)

| File | Change | Description |
|------|--------|-------------|
| src/telemetry/bridge.ts | +5 lines | TelemetryConfig validation |
| src/api/events.ts | +60 lines | Event payload validation (8 methods) |
| src/types/schemas/index.ts | +5 lines | Export new schemas |

---

## Success Criteria

### Must Have ✅

- [ ] TelemetryConfigSchema validates all config properties
- [ ] 8 event payload schemas created (ModelLoaded, ModelUnloaded, etc.)
- [ ] Validation integrated into TelemetryBridge constructor
- [ ] Validation integrated into EngineEventEmitter.emit*() methods
- [ ] ≥90% test coverage for telemetry.ts and events.ts
- [ ] 423+ tests passing (373 baseline + 50 new)
- [ ] npm run build succeeds (ESM + CJS + DTS)
- [ ] npm run typecheck passes

### Nice to Have

- [ ] MetricLabelsSchema for validating metric attributes
- [ ] Performance benchmarks for event validation overhead
- [ ] Manual validation with real Python runtime

---

## Risk Assessment

### LOW Risk ✅

1. **Established Patterns**
   - Weeks 1-3 created clear schema patterns
   - Event interfaces already well-defined
   - Integration points are simple (constructor + emit methods)

2. **Simple Schema Design**
   - TelemetryConfig has only 4 properties
   - Event payloads are straightforward (2-6 fields each)
   - No complex cross-field validation

3. **Clear Test Strategy**
   - Test patterns from Weeks 1-2 are proven
   - Event payloads easy to test (no external dependencies)

### MEDIUM Risk ⚠️

1. **Event Validation Performance**
   - **Concern:** Validating every TokenGeneratedEvent could add overhead
   - **Mitigation:** Use .safeParse() to avoid exceptions, measure performance
   - **Fallback:** Make event validation optional via config flag

2. **Logger Field Handling**
   - **Concern:** TelemetryConfig.logger is Pino instance (not validatable)
   - **Mitigation:** Omit from schema, document in JSDoc
   - **Impact:** Minimal - logger is optional field

---

## Dependencies

### Completed ✅

- Zod v3.22.4 installed (Week 1)
- zodErrorToEngineError converter (Week 1)
- Schema patterns (common.ts, model.ts, generator.ts)
- Test infrastructure (Vitest)

### Required for Week 4

- Week 2 completion (TypeScript errors fixed)
- Test suite passing (373+ tests)
- Build pipeline working (DTS generation)

### No New Dependencies

All packages already installed.

---

## What Comes After Week 4

### Week 5: Integration & Error Handling

**Focus:** Complete Zod integration across all API methods

**Tasks:**
1. Integrate Zod validation into all Engine methods
2. Write integration tests (Engine + Zod)
3. Performance validation (no regression)
4. Contract tests vs kr-serve-mlx

**Timeline:** 5 days (26 hours)

### Week 6: Documentation & Testing

**Focus:** Final documentation and validation

**Tasks:**
1. API documentation (schemas, validation)
2. Migration guide (manual validators → Zod)
3. Performance benchmarks
4. Final validation and signoff

**Timeline:** 3 days (15 hours)

---

## Key Insights

### Why This Week is Simple ✅

1. **Well-Defined Interfaces**
   - TelemetryConfig and all event interfaces already exist
   - No ambiguity in field types or validation rules
   - Just need to mirror interfaces in Zod

2. **Minimal Integration Complexity**
   - TelemetryBridge: 1 validation call in constructor
   - EngineEventEmitter: 8 validation calls (same pattern repeated)
   - No refactoring required

3. **Established Test Patterns**
   - Weeks 1-2 created comprehensive test examples
   - Copy-paste-modify approach works well
   - High confidence in test coverage

### What Makes This Week Important 🎯

1. **Data Integrity**
   - Prevents invalid events from propagating through system
   - Catches config errors at startup (fail-fast)
   - Clear error messages for debugging

2. **Telemetry Reliability**
   - Ensures Prometheus metrics are always valid
   - Port conflicts detected early
   - Service names follow conventions

3. **Event System Robustness**
   - Validates all 8 event types consistently
   - Prevents downstream consumers from receiving malformed data
   - Enables confident event-driven architecture

---

## Bottom Line

Phase 1 Week 4 is a **straightforward completion week**:

- ✅ Simple schema design (8 events + 1 config)
- ✅ Minimal integration (2 files, 65 lines total)
- ✅ Clear test strategy (~450 lines)
- ✅ Timeline: 4 days (20 hours)
- ✅ Risk: LOW (proven patterns)
- ✅ Outcome: Complete validation for telemetry and events

**After Week 4:** All schema creation complete. Weeks 5-6 focus on integration, testing, and documentation.

---

<div align="center">

**Phase 1 Week 4 Status: READY TO START**

Telemetry & Event Schemas | 4 Days | 20 Hours | LOW Risk

Detailed Plan: `PHASE1_WEEK4_PLAN.md` (25 pages)

</div>
