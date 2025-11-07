# MLX-Serving Bug Analysis & Fix Report

**Date:** 2025-11-07
**Agent:** Queenie (Quality)
**Analysis Duration:** 10 minutes, 36 seconds
**Bugs Found:** 7 issues (2 High, 4 Medium, 1 Low)

---

## Executive Summary

Comprehensive bug analysis performed on mlx-serving codebase focusing on race conditions, memory leaks, error handling gaps, type safety issues, and logic bugs. Found 7 critical issues requiring immediate attention, particularly around state management during Python runtime restarts and resource cleanup.

**Critical Areas:**
- State synchronization during transport restarts
- Memory leaks in event listeners
- Silent data loss in queue operations
- Timeout semantic violations in batching
- Resource cleanup gaps

---

## Bug #1: Race Condition - State Desync After Python Restart

**Severity:** 🔴 **HIGH**
**File:** `src/api/engine.ts:1498-1511`
**Category:** Race Condition / State Management

### Problem

When the Python transport restarts (crash/reconnect), the engine clears `batchQueue`, `modelManager`, and `generatorFactory` but **never resets `generateBatcher`**. After restart, `createGenerator` continues using the old batcher whose `transport` and stream listeners still point at the dead Python process. Result: every batched `generate` call fails with "transport closed".

### Impact

- All batched generation requests fail after Python runtime restart
- Users experience cryptic "transport closed" errors
- No automatic recovery - requires manual engine restart
- Affects production reliability

### Root Cause

```typescript
// src/api/engine.ts:1498-1511
private handleTransportChange(transport: JsonRpcTransport | null): void {
  // Clears these components ✅
  this.batchQueue = null;
  this.modelManager = new ModelManager(...);
  this.generatorFactory = new GeneratorFactory(...);

  // ❌ NEVER CLEARS THIS - holds stale transport reference
  // this.generateBatcher = ???
}
```

### Fix

Add cleanup for `generateBatcher` before recreating components:

```typescript
private handleTransportChange(transport: JsonRpcTransport | null): void {
  // Clean up old batcher before transport change
  if (this.generateBatcher) {
    this.generateBatcher.cleanup();
    this.generateBatcher = null;
  }

  this.batchQueue = null;
  this.modelManager = new ModelManager(...);
  this.generatorFactory = new GeneratorFactory(...);

  // Next ensureRuntime() will reinitialize generateBatcher
}
```

### Verification

- Test scenario: Restart Python runtime mid-generation
- Expected: New batched requests succeed after reconnection
- Run: `tests/integration/batch-generate.test.ts`

---

## Bug #2: Memory Leak - AbortController Listener Not Removed

**Severity:** 🟡 **MEDIUM**
**File:** `src/bridge/jsonrpc-transport.ts:215-227`
**Category:** Memory Leak

### Problem

The transport adds an `abort` listener per request but **never removes it when the signal actually aborts**. Timeouts, success, and rejection all clean up the handler, but the abort path leaves the closure registered forever. This leaks listeners on long-lived AbortSignal instances.

### Impact

- Memory leak grows with each aborted request
- Long-running applications accumulate thousands of dead listeners
- Performance degrades over time
- Node.js emits "MaxListenersExceededWarning"

### Root Cause

```typescript
// src/bridge/jsonrpc-transport.ts:215-227
const abortHandler = () => {
  // ❌ Listener never removed before rejection
  reject(createTransportError('Request aborted by caller'));
};

if (signal) {
  signal.addEventListener('abort', abortHandler);
}

// Other paths clean up:
// timeout: signal.removeEventListener('abort', abortHandler) ✅
// success: signal.removeEventListener('abort', abortHandler) ✅
// rejection: signal.removeEventListener('abort', abortHandler) ✅
// abort path: ❌ NO CLEANUP
```

### Fix

Remove listener inside `abortHandler` before rejecting:

```typescript
const abortHandler = () => {
  if (signal) {
    signal.removeEventListener('abort', abortHandler);
  }
  reject(createTransportError('Request aborted by caller'));
};
```

### Verification

- Test: Create 1000 requests with same AbortSignal, abort all
- Monitor: `process.listenerCount(signal, 'abort')` should return 0
- Run: `tests/unit/bridge/jsonrpc-transport.test.ts` (add leak test)

---

## Bug #3: Silent Data Loss in Queue Operations

**Severity:** 🔴 **HIGH**
**File:** `src/core/async-queue-pool.ts:33-51`
**Category:** Data Loss / Error Handling

### Problem

`AsyncQueuePool.push()` simply **returns silently** when called after `close()`/`fail()`. Late stats/error chunks are dropped without alerting callers. `GeneratorFactory` assumes `queue.push` rejects when consumer is gone, but instead it swallows the last tokens.

### Impact

- Last generation tokens lost during cleanup
- Stats chunks disappear silently
- Callers unaware of data loss
- Difficult to debug incomplete responses

### Root Cause

```typescript
// src/core/async-queue-pool.ts:33-51
async push(item: T): Promise<void> {
  if (this.closed || this.failure) {
    return; // ❌ Silent return drops data!
  }
  // ... enqueue logic
}
```

### Fix

Throw error when queue is closed:

```typescript
async push(item: T): Promise<void> {
  if (this.failure) {
    throw this.failure;
  }
  if (this.closed) {
    throw new Error('Queue closed - cannot push more items');
  }
  // ... enqueue logic
}
```

### Verification

- Test: Push items after calling `close()`
- Expected: `push()` throws Error
- Run: `tests/unit/core/async-queue-pool.test.ts` (add closed-queue test)

---

## Bug #4: Timeout Semantics Broken Under Batching

**Severity:** 🟡 **MEDIUM**
**File:** `src/core/generate-batcher.ts:669-675`
**Category:** Logic Bug / Timeout Violation

### Problem

Batcher combines per-request `timeoutMs` values with `Math.max()`, so **any short timeout is stretched** to match the slowest request in the batch. This violates caller expectations - a 2s timeout can hang for 30s.

### Impact

- User-specified timeouts ignored
- Short-timeout requests stuck waiting for slow batch mates
- Unpredictable response times
- Violates API contract

### Root Cause

```typescript
// src/core/generate-batcher.ts:669-675
const batchTimeout = Math.max(
  ...requests.map(r => r.options?.timeoutMs || DEFAULT_TIMEOUT)
); // ❌ Uses slowest timeout for entire batch
```

### Fix

Use `Math.min()` for batch timeout AND track individual timers:

```typescript
// Option 1: Conservative - use shortest timeout
const batchTimeout = Math.min(
  ...requests.map(r => r.options?.timeoutMs || DEFAULT_TIMEOUT)
);

// Option 2: Better - track individual timeouts
requests.forEach(req => {
  if (req.options?.timeoutMs) {
    setTimeout(() => {
      if (!req.resolved) {
        req.reject(new TimeoutError(`Request timeout: ${req.options.timeoutMs}ms`));
      }
    }, req.options.timeoutMs);
  }
});
```

### Verification

- Test: Batch request with 2s timeout + request with 30s timeout
- Expected: 2s request times out after 2s
- Run: `tests/unit/core/generate-batcher.test.ts` (add timeout test)

---

## Bug #5: Timeout Ignored When Batching Disabled

**Severity:** 🟡 **MEDIUM**
**File:** `src/core/generator-factory.ts:200-210`
**Category:** Error Handling Gap

### Problem

`GeneratorFactory` ignores `options.timeoutMs` whenever `GenerateBatcher` isn't available. Only the abort signal is forwarded. Result: direct `generate` RPCs can **hang indefinitely** even when caller requested timeout.

### Impact

- Timeouts work inconsistently (batching on vs off)
- Non-batched requests can hang forever
- API behavior varies based on internal state
- Difficult to debug timeout issues

### Root Cause

```typescript
// src/core/generator-factory.ts:200-210
if (this.generateBatcher) {
  return this.generateBatcher.generate(params, options);
} else {
  // ❌ Only signal passed, timeoutMs ignored!
  return this.transport.request('generate', params, {
    signal: options?.signal
  });
}
```

### Fix

Pass timeout to transport request:

```typescript
return this.transport.request('generate', params, {
  signal: options?.signal,
  timeout: options?.timeoutMs // ✅ Add timeout
});
```

### Verification

- Test: Generate without batcher, with 2s timeout
- Expected: Request times out after 2s
- Run: `tests/unit/core/generator-factory.test.ts` (add non-batched timeout test)

---

## Bug #6: Resource Leak When Consumers Throw

**Severity:** 🟡 **MEDIUM**
**File:** `src/core/generator-factory.ts:283-307`
**Category:** Resource Leak

### Problem

`iterator.throw()` implementation detaches listeners and fails local queue, but **never notifies StreamRegistry/Python** to cancel the stream. If user code aborts generator via `.throw()` (common in pipeline teardowns), Python runtime keeps generating tokens until completion, **wasting GPU time and bandwidth**.

### Impact

- GPU continues processing after client aborts
- Wasted compute resources
- Network bandwidth wasted on unwanted tokens
- Slow graceful shutdown

### Root Cause

```typescript
// src/core/generator-factory.ts:283-307
async throw(error?: unknown): Promise<IteratorResult<GeneratorChunk>> {
  this.detachListeners();
  this.queue.fail(error instanceof Error ? error : new Error(String(error)));

  // ❌ Never calls streamRegistry.cancel(streamId)

  return { done: true, value: undefined };
}
```

### Fix

Cancel remote stream before local cleanup:

```typescript
async throw(error?: unknown): Promise<IteratorResult<GeneratorChunk>> {
  // Cancel remote stream (guarded like .return())
  if (this.streamId) {
    try {
      await this.streamRegistry.cancel(this.streamId);
    } catch (err) {
      // Log but don't throw - already in error state
      this.logger.warn('Failed to cancel stream during throw', { streamId: this.streamId, err });
    }
  }

  this.detachListeners();
  this.queue.fail(error instanceof Error ? error : new Error(String(error)));
  return { done: true, value: undefined };
}
```

### Verification

- Test: Call `generator.throw(new Error())` mid-generation
- Monitor: Python runtime should stop generating immediately
- Run: `tests/integration/stream-cancellation.test.ts` (create new test)

---

## Bug #7: Type Safety Gap - Vision Preprocessing Validation

**Severity:** 🟢 **LOW**
**File:** `src/api/engine.ts:409-424`
**Category:** Type Safety / Input Validation

### Problem

Engine blindly casts `options.preprocessing` (declared as loose `Partial`) to `VisionModelDescriptor['imagePreprocessing']` without validation. JavaScript/untyped consumers can pass arbitrary objects, causing **downstream crashes** when preprocessing expects numeric `[mean, std]` tuples.

### Impact

- Runtime crashes with invalid preprocessing config
- Poor error messages ("Cannot read property '0' of undefined")
- JavaScript consumers vulnerable
- Debugging difficult

### Root Cause

```typescript
// src/api/engine.ts:409-424
descriptor.imagePreprocessing = {
  ...descriptor.imagePreprocessing,
  ...options.preprocessing // ❌ No validation!
};
```

### Fix

Validate structure before assignment:

```typescript
if (options.preprocessing) {
  // Validate shape
  if (options.preprocessing.mean && !Array.isArray(options.preprocessing.mean)) {
    throw new EngineClientError('ValidationError',
      'preprocessing.mean must be an array of 3 numbers');
  }
  if (options.preprocessing.std && !Array.isArray(options.preprocessing.std)) {
    throw new EngineClientError('ValidationError',
      'preprocessing.std must be an array of 3 numbers');
  }

  // Validate numeric values
  const validateNumericArray = (arr: unknown[], name: string) => {
    if (arr.length !== 3 || !arr.every(v => typeof v === 'number')) {
      throw new EngineClientError('ValidationError',
        `preprocessing.${name} must contain exactly 3 numbers`);
    }
  };

  if (options.preprocessing.mean) {
    validateNumericArray(options.preprocessing.mean, 'mean');
  }
  if (options.preprocessing.std) {
    validateNumericArray(options.preprocessing.std, 'std');
  }

  // Validate positive integers
  if (options.preprocessing.resolution && (
    !Number.isInteger(options.preprocessing.resolution) ||
    options.preprocessing.resolution <= 0
  )) {
    throw new EngineClientError('ValidationError',
      'preprocessing.resolution must be a positive integer');
  }

  descriptor.imagePreprocessing = {
    ...descriptor.imagePreprocessing,
    ...options.preprocessing
  };
}
```

### Verification

- Test: Pass invalid preprocessing objects
- Expected: Throw ValidationError with clear message
- Run: `tests/unit/api/engine.test.ts` (add vision preprocessing validation tests)

---

## Fix Priority & Implementation Order

### Phase 1: Critical Fixes (Immediate)
1. **Bug #1** - Race condition in transport restart (HIGH)
2. **Bug #3** - Silent data loss in queues (HIGH)

### Phase 2: Resource Leaks (This Week)
3. **Bug #2** - AbortController memory leak (MEDIUM)
4. **Bug #6** - Stream cancellation leak (MEDIUM)

### Phase 3: Semantic Fixes (Next Sprint)
5. **Bug #4** - Batch timeout semantics (MEDIUM)
6. **Bug #5** - Non-batched timeout gap (MEDIUM)

### Phase 4: Hardening (Future)
7. **Bug #7** - Vision preprocessing validation (LOW)

---

## Testing Strategy

### Unit Tests Required
- `tests/unit/api/engine.test.ts` - Transport restart handling
- `tests/unit/bridge/jsonrpc-transport.test.ts` - AbortController cleanup
- `tests/unit/core/async-queue-pool.test.ts` - Closed queue behavior
- `tests/unit/core/generate-batcher.test.ts` - Timeout semantics
- `tests/unit/core/generator-factory.test.ts` - Non-batched timeouts, stream cancellation

### Integration Tests Required
- `tests/integration/batch-generate.test.ts` - Python restart recovery
- `tests/integration/stream-cancellation.test.ts` - NEW - Generator.throw() behavior
- `tests/integration/vision/vision-generation.test.ts` - Preprocessing validation

### Smoke Tests
- End-to-end generation with Python restart
- Memory leak test (1000 aborted requests)
- Batch timeout enforcement

---

## Estimated Effort

| Bug | Effort | Risk |
|-----|--------|------|
| #1 - Transport restart | 2 hours | Low |
| #2 - AbortController leak | 1 hour | Low |
| #3 - Queue data loss | 2 hours | Medium |
| #4 - Batch timeout | 4 hours | High (behavior change) |
| #5 - Non-batch timeout | 1 hour | Low |
| #6 - Stream cancellation | 2 hours | Medium |
| #7 - Vision validation | 3 hours | Low |

**Total:** 15 hours (~2 engineer-days)

---

## Success Metrics

### Pre-Fix Baseline
- ❌ 0/7 bugs fixed
- ❌ Race conditions on Python restart
- ❌ Memory leaks accumulate over time
- ❌ Data loss on queue closure
- ❌ Timeout semantics violated

### Post-Fix Target
- ✅ 7/7 bugs fixed
- ✅ Clean Python restart with no stale state
- ✅ Zero memory leaks after 10,000 requests
- ✅ Zero data loss - all errors surface properly
- ✅ Timeouts honored within ±100ms

---

## Quality Agent Recommendation

> "Quality is not an act, it's a habit. Test early, test often, test everything. After addressing these, rerun the streaming/batching suites (or at least the unit tests under `tests/unit/core/*` plus an end-to-end generation smoke test) to confirm the fixes."

**- Queenie (Quality Agent)**

---

## Next Steps

1. **Review this report** with Tony (CTO) and Stan (Standards)
2. **Prioritize fixes** - Start with Bug #1 and #3 (HIGH severity)
3. **Create test cases** for each bug before implementing fixes
4. **Implement fixes** incrementally, one bug at a time
5. **Run full test suite** after each fix (384 tests must pass)
6. **Document fixes** in git commit messages with bug # references

---

**Report Generated:** 2025-11-07
**Analysis Tool:** AutomatosX Quality Agent (Queenie)
**Codebase Version:** mlx-serving v0.1.0-alpha.0
**Test Coverage:** 38 test files, 384 tests

---

**Status:** 7 bugs identified, 0 fixed, ready for implementation
